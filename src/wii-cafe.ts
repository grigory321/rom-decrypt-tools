import type {
  ByteSource,
  SourceInput,
  CompanionFile,
  ProgressReporter,
  ArchiveEntry,
} from './contracts.js';
import { BlockCache } from './wii-sources.js';
import {
  Bin,
  bounds,
  check,
  sliceSource,
  align,
  FormatError,
} from './binary.js';
import { hex, unhex, signatureBody } from './crypto.js';
import { sha256 } from './vendor/noble/sha256.js';
import { Unzlib } from './vendor/fflate.mjs';
import { hash160, Sha1, equalBytes } from './wii-hash.js';
import {
  MAX_ENTRIES,
  MAX_METADATA,
  readBytes,
  cbcDecrypt,
  ticketInfo,
  memorySource,
  blockSource,
  indexedCbcSource,
  companionSet,
  resolveCompanion,
  boundedName,
  zeroIV,
} from './wii-sources.js';
import { walkTree } from './wii-tree.js';

interface CafeContent {
  id: string;
  index: number;
  type: number;
  size: number;
  hash: Uint8Array;
}

const empty = () => memorySource(new Uint8Array());

function metadataInfo(bytes: Uint8Array) {
  const view = new Bin(bytes),
    body = signatureBody(bytes),
    count = view.u16(body + 0x9e, false),
    records = body + 0x9c4;
  check(
    view.u8(body + 0x40) === 1 && count > 0 && count <= 4096,
    'INVALID_WIIU_TMD',
  );
  view.range(records, count * 48);
  const infoTable = view.slice(body + 0xc4, 64 * 36);
  check(
    equalBytes(sha256(infoTable), view.slice(body + 0xa4, 32)),
    'WIIU_TMD_HASH',
    'TMD content-info table hash mismatch',
  );
  const covered = new Uint8Array(count);
  for (let index = 0; index < 64; index++) {
    const offset = body + 0xc4 + index * 36,
      first = view.u16(offset, false),
      length = view.u16(offset + 2, false);
    if (!length) continue;
    check(first + length <= count, 'INVALID_WIIU_TMD');
    for (let record = first; record < first + length; record++) {
      check(!covered[record], 'INVALID_WIIU_TMD');
      covered[record] = 1;
    }
    check(
      equalBytes(
        sha256(view.slice(records + first * 48, length * 48)),
        view.slice(offset + 4, 32),
      ),
      'WIIU_TMD_HASH',
      'TMD content record hash mismatch',
    );
  }
  check(covered.every(Boolean), 'INVALID_WIIU_TMD');
  const contents: CafeContent[] = [],
    indices = new Set<number>(),
    ids = new Set<string>();
  for (let index = 0; index < count; index++) {
    const offset = records + index * 48,
      contentIndex = view.u16(offset + 4, false),
      id = view.u32(offset, false).toString(16).padStart(8, '0');
    check(!indices.has(contentIndex) && !ids.has(id), 'INVALID_WIIU_TMD');
    indices.add(contentIndex);
    ids.add(id);
    contents.push({
      id,
      index: contentIndex,
      type: view.u16(offset + 6, false),
      size: view.u64(offset + 8, false),
      hash: view.slice(offset + 16, 32).slice(),
    });
  }
  return { titleId: view.slice(body + 0x4c, 8).slice(), contents };
}

async function verifyContent(
  source: ByteSource,
  content: CafeContent,
  report: ProgressReporter,
) {
  const hash = content.type & 0x2000 ? new Sha1() : sha256.create();
  for (let offset = 0; offset < source.size; offset += 1024 * 1024) {
    const amount = Math.min(1024 * 1024, source.size - offset);
    hash.update(await readBytes(source, offset, amount));
    report({
      phase: 'verify',
      value: (offset + amount) / Math.max(source.size, 1),
    });
  }
  check(
    equalBytes(
      hash.digest(),
      content.hash.subarray(0, content.type & 0x2000 ? 20 : 32),
    ),
    'WIIU_HASH',
    content.id,
  );
}

function hashedContent(
  source: ByteSource,
  key: Uint8Array,
  cache: BlockCache,
  identity: string,
  h3: Uint8Array | null = null,
) {
  check(source.size % 0x10000 === 0, 'INVALID_WIIU_CONTENT');
  return blockSource((source.size / 0x10000) * 0xfc00, 0xfc00, (index) =>
    cache.get(`${identity}:hashed:${index}`, 0x10000, async () => {
      const raw = await readBytes(source, index * 0x10000, 0x10000),
        hashes = cbcDecrypt(raw.subarray(0, 0x400), key),
        h0Offset = (index % 16) * 20;
      const h0 = hashes.subarray(h0Offset, h0Offset + 20),
        payload = cbcDecrypt(raw.subarray(0x400), key, h0.subarray(0, 16));
      check(
        equalBytes(hash160(payload), h0),
        'WIIU_HASH',
        'Wii U content H0 mismatch',
      );
      const h1Offset = 0x140 + (Math.floor(index / 16) % 16) * 20,
        h2Offset = 0x280 + (Math.floor(index / 256) % 16) * 20;
      check(
        equalBytes(
          hash160(hashes.subarray(0, 0x140)),
          hashes.subarray(h1Offset, h1Offset + 20),
        ),
        'WIIU_HASH',
        'Wii U content H1 mismatch',
      );
      check(
        equalBytes(
          hash160(hashes.subarray(0x140, 0x280)),
          hashes.subarray(h2Offset, h2Offset + 20),
        ),
        'WIIU_HASH',
        'Wii U content H2 mismatch',
      );
      if (h3) {
        const offset = Math.floor(index / 4096) * 20;
        check(
          offset + 20 <= h3.length &&
            equalBytes(
              hash160(hashes.subarray(0x280, 0x3c0)),
              h3.subarray(offset, offset + 20),
            ),
          'WIIU_HASH',
          'Wii U content H3 mismatch',
        );
      }
      return payload;
    }),
  );
}

function fstInfo(bytes: Uint8Array) {
  const view = new Bin(bytes),
    factor = view.u32(4, false),
    count = view.u32(8, false);
  check(
    view.u32(0, false) === 0x46535400 &&
      count > 0 &&
      count <= 4096 &&
      factor > 0 &&
      factor <= 0x10000,
    'INVALID_WIIU_FST',
  );
  view.range(32, count * 32);
  const clusters: { offset: number; size: number; mode: number }[] = [];
  for (let index = 0; index < count; index++) {
    const offset = 32 + index * 32,
      mode = view.u8(offset + 0x14);
    check(mode <= 2, 'WIIU_HASH_MODE', String(mode));
    clusters.push({
      offset: view.u32(offset, false) * 0x8000,
      size: view.u32(offset + 4, false) * 0x8000,
      mode,
    });
  }
  return { view, factor, count, table: 32 + count * 32, clusters };
}

function fstEntries(bytes: Uint8Array, sources: ByteSource[], prefix = '') {
  const fst = fstInfo(bytes),
    entries: ArchiveEntry[] = [];
  check(sources.length === fst.count, 'INVALID_WIIU_FST');
  walkTree(
    bytes,
    fst.table,
    16,
    (entry, record) => {
      check(
        !(record.type & 0x80),
        'WIIU_FST_LINK',
        'Linked Wii U FST entries are unsupported',
      );
      if (entry.kind === 'file') {
        const content = fst.view.u16(record.offset + 14, false);
        check(content < sources.length && sources[content], 'INVALID_WIIU_FST');
        const flags = fst.view.u16(record.offset + 12, false),
          offset =
            fst.view.u32(record.offset + 4, false) *
            (flags & 4 ? 1 : fst.factor);
        entry.source = sliceSource(sources[content], offset, entry.size);
      }
      check(entry.source, 'INVALID_FST');
      entries.push({ ...entry, source: entry.source });
    },
    { prefix, cafe: true },
  );
  return entries;
}

async function packageEntries(
  metadataBytes: Uint8Array,
  ticketBytes: Uint8Array,
  getContent: (content: CafeContent) => Promise<ByteSource>,
  getH3: (content: CafeContent) => Promise<Uint8Array | null>,
  report: ProgressReporter,
  cache: BlockCache,
  identity = 'wup',
) {
  const metadata = metadataInfo(metadataBytes),
    ticket = ticketInfo(ticketBytes, true);
  check(equalBytes(metadata.titleId, ticket.titleId), 'WIIU_TITLE_ID');
  const sources: ByteSource[] = [],
    entries: ArchiveEntry[] = [];
  for (const content of metadata.contents) {
    check(content.size > 0, 'INVALID_WIIU_CONTENT');
    const cipher = await getContent(content);
    check(
      cipher.size >= align(content.size, 16),
      'INVALID_WIIU_CONTENT',
      content.id,
    );
    if (content.type & 2) {
      const h3 = await getH3(content);
      if (h3) {
        const expected = content.hash.subarray(
            0,
            content.type & 0x2000 ? 20 : 32,
          ),
          actual = content.type & 0x2000 ? hash160(h3) : sha256(h3);
        check(
          equalBytes(actual, expected),
          'WIIU_HASH',
          'Wii U H3 table hash mismatch',
        );
      }
      sources[content.index] = hashedContent(
        sliceSource(cipher, 0, content.size),
        ticket.key,
        cache,
        `${identity}:${content.id}`,
        h3,
      );
    } else {
      const decoded = indexedCbcSource(
        sliceSource(cipher, 0, align(content.size, 16)),
        ticket.key,
        content.index,
        cache,
        `${identity}:${content.id}`,
      );
      sources[content.index] = sliceSource(decoded, 0, content.size);
      if (content.size <= MAX_METADATA || content.index === 0)
        await verifyContent(sources[content.index], content, report);
    }
  }
  const fstSource = sources[0];
  check(fstSource && fstSource.size <= MAX_METADATA, 'INVALID_WIIU_FST');
  const fstBytes = await readBytes(fstSource, 0, fstSource.size),
    fst = fstInfo(fstBytes);
  check(
    fst.count === metadata.contents.length &&
      sources.length === fst.count &&
      sources.every(Boolean),
    'INVALID_WIIU_FST',
  );
  for (const entry of fstEntries(fstBytes, sources)) {
    check(entries.length < MAX_ENTRIES, 'TOO_MANY');
    entries.push(entry);
  }
  return entries;
}

export async function openCafePackage(
  file: SourceInput,
  name: string,
  companions: CompanionFile[],
  report: ProgressReporter,
  cache: BlockCache,
) {
  const records = companionSet(file, name, companions);
  let metadata = resolveCompanion(records, name, 'title.tmd', true);
  if (!metadata && /(?:\.tmd|(?:^|\/)tmd\.\d+)$/i.test(name))
    metadata = records[0];
  if (!metadata) {
    const matches = records.filter((record) =>
      /(?:\.tmd|(?:^|\/)tmd\.\d+)$/i.test(record.name),
    );
    check(matches.length <= 1, 'AMBIGUOUS_COMPANION', 'title.tmd');
    metadata = matches[0];
  }
  check(metadata, 'MISSING_COMPANION', 'title.tmd');
  const ticket = resolveCompanion(records, metadata.name, 'title.tik');
  check(
    metadata.source.size <= MAX_METADATA && ticket.source.size <= MAX_METADATA,
    'TOO_LARGE',
  );
  return packageEntries(
    await readBytes(metadata.source, 0, metadata.source.size),
    await readBytes(ticket.source, 0, ticket.source.size),
    async (content) => {
      const companion =
        resolveCompanion(records, metadata.name, content.id + '.app', true) ||
        resolveCompanion(records, metadata.name, content.id);
      return companion.source;
    },
    async (content) => {
      const companion = resolveCompanion(
        records,
        metadata.name,
        content.id + '.h3',
      );
      check(companion.source.size <= MAX_METADATA, 'TOO_LARGE');
      return readBytes(companion.source, 0, companion.source.size);
    },
    report,
    cache,
  );
}

async function discKey(
  records: { name: string; source: ByteSource }[],
  name: string,
) {
  const basename = (name.split('/').at(-1) || '').replace(
    /\.(?:wud|wux)$/i,
    '.key',
  );
  const matches: { name: string; source: ByteSource }[] = [];
  for (const wanted of [basename, 'disc.key', 'game.key']) {
    const found = resolveCompanion(records, name, wanted, true);
    if (found && !matches.includes(found)) matches.push(found);
  }
  check(
    matches.length > 0,
    'MISSING_DISC_KEY',
    'Include the matching per-disc .key, disc.key or game.key file',
  );
  check(matches.length === 1, 'AMBIGUOUS_COMPANION', 'per-disc key');
  const source = matches[0].source;
  check(
    source.size === 16 || (source.size >= 32 && source.size <= 128),
    'INVALID_DISC_KEY',
  );
  const bytes = await readBytes(source, 0, source.size);
  if (bytes.length === 16) return bytes;
  let value: string;
  try {
    value = new TextDecoder('utf-8', { fatal: true }).decode(bytes).trim();
  } catch {
    check(false, 'INVALID_DISC_KEY');
  }
  check(/^[0-9a-f]{32}$/i.test(value), 'INVALID_DISC_KEY');
  return unhex(value);
}

async function discPartition(
  source: ByteSource,
  offset: number,
  key: Uint8Array,
  cache: BlockCache,
  identity: string,
) {
  const header = new Bin(await readBytes(source, offset, 0x40));
  check(
    header.u32(0, false) === 0xcc93a4f5 && header.u32(4, false) === 0x8000,
    'INVALID_WUD_PARTITION',
  );
  const size = header.u32(0x14, false),
    fstOffset = header.u32(0x18, false) * 0x8000;
  check(
    size >= 32 && size <= MAX_METADATA && fstOffset >= 0x8000,
    'INVALID_WIIU_FST',
  );
  const bytes = cbcDecrypt(
      await readBytes(source, offset + fstOffset, align(size, 16)),
      key,
    ).subarray(0, size),
    fst = fstInfo(bytes),
    sources: ByteSource[] = [];
  for (let index = 0; index < fst.clusters.length; index++) {
    const cluster = fst.clusters[index];
    check(
      cluster.size > 0 && cluster.offset >= 0x8000,
      'INVALID_WUD_PARTITION',
    );
    const cipher = sliceSource(source, offset + cluster.offset, cluster.size);
    sources.push(
      cluster.mode === 2
        ? hashedContent(cipher, key, cache, `${identity}:${index}`)
        : cluster.mode === 1
          ? indexedCbcSource(cipher, key, index, cache, `${identity}:${index}`)
          : discRawSource(cipher, key, cache, `${identity}:${index}`),
    );
  }
  return { bytes, fst, entries: fstEntries(bytes, sources), header };
}

function discRawSource(
  source: ByteSource,
  key: Uint8Array,
  cache: BlockCache,
  identity: string,
) {
  return blockSource(source.size, 0x10000, (block) =>
    cache.get(`${identity}:disc:${block}`, 0x10000, async () => {
      const offset = block * 0x10000,
        length = Math.min(0x10000, source.size - offset),
        iv = zeroIV();
      new DataView(iv.buffer).setBigUint64(8, BigInt(block), false);
      return cbcDecrypt(await readBytes(source, offset, length), key, iv);
    }),
  );
}

export async function openCafeDisc(
  source: ByteSource,
  name: string,
  companions: CompanionFile[],
  report: ProgressReporter,
  cache: BlockCache,
) {
  check(
    new Bin(await readBytes(source, 0x10000, 4)).u32(0, false) === 0xcc549eb9,
    'INVALID_WUD',
  );
  const records = companionSet(source, name, companions),
    key = await discKey(records, name);
  const tableBytes = cbcDecrypt(await readBytes(source, 0x18000, 0x8000), key),
    table = new Bin(tableBytes);
  check(
    table.u32(0, false) === 0xcca6e67b,
    'WRONG_DISC_KEY',
    'The supplied per-disc key does not decrypt this disc',
  );
  check(
    table.u32(4, false) === 0x8000 &&
      equalBytes(
        hash160(tableBytes.subarray(0x800)),
        tableBytes.subarray(8, 28),
      ),
    'WUD_TABLE_HASH',
  );
  const count = table.u32(28, false);
  check(count > 0 && count <= 240, 'INVALID_WUD_TABLE');
  const partitions: { label: string; address: number; index: number }[] = [],
    addresses = new Set<number>();
  for (let index = 0; index < count; index++) {
    const offset = 0x800 + index * 0x80,
      nameField = tableBytes.subarray(offset, offset + 31),
      end = nameField.indexOf(0),
      label = new TextDecoder().decode(
        end < 0 ? nameField : nameField.subarray(0, end),
      );
    check(/^[A-Za-z0-9_-]{1,31}$/.test(label), 'INVALID_WUD_TABLE');
    check(
      table.u8(offset + 31) === 1,
      'WUD_MULTIPLE_ADDRESSES',
      'Multi-address Wii U partitions are unsupported',
    );
    const address = table.u32(offset + 32, false) * 0x8000;
    check(address >= 0x20000 && !addresses.has(address), 'INVALID_WUD_TABLE');
    bounds(source.size, address, 0x8000);
    addresses.add(address);
    partitions.push({ label, address, index });
  }
  const system = partitions.filter((partition) => partition.label === 'SI');
  check(system.length === 1, 'WUD_NO_SI', 'A single SI partition is required');
  const si = await discPartition(source, system[0].address, key, cache, 'si'),
    entries: ArchiveEntry[] = [];
  for (const partition of partitions.filter((item) =>
    item.label.startsWith('GM'),
  )) {
    const folder = partition.index.toString(16).padStart(2, '0') + '/';
    const expectedId = partition.label.slice(2, 18).toLowerCase();
    const tickets = si.entries.filter(
      (entry) =>
        entry.kind === 'file' &&
        (entry.path.split('/').at(-1) || '').toLowerCase() === 'title.tik',
    );
    let selected:
      { bytes: Uint8Array; ticket: ReturnType<typeof ticketInfo> } | undefined;
    for (const entry of tickets) {
      if (!entry.path.toLowerCase().startsWith(folder) && tickets.length > 1)
        continue;
      check(entry.size <= MAX_METADATA, 'TOO_LARGE');
      const bytes = await readBytes(entry.source, 0, entry.size),
        ticket = ticketInfo(bytes, true);
      if (
        hex(ticket.titleId) === expectedId ||
        entry.path.toLowerCase().startsWith(folder)
      ) {
        selected = { bytes, ticket };
        break;
      }
    }
    check(selected, 'WUD_MISSING_TICKET', partition.label);
    const volume = await discPartition(
      source,
      partition.address,
      selected.ticket.key,
      cache,
      `gm:${partition.index}`,
    );
    for (const entry of volume.entries) {
      check(entries.length < MAX_ENTRIES, 'TOO_MANY');
      entries.push({
        ...entry,
        path: `partitions/${partition.label}/${entry.path}`,
      });
    }
    report({
      phase: 'index',
      value: (partition.index + 1) / partitions.length,
    });
  }
  check(
    entries.length > 0,
    'WUD_NO_GM',
    'No readable GM partitions were found',
  );
  for (const entry of si.entries) {
    check(entries.length < MAX_ENTRIES, 'TOO_MANY');
    entries.push({ ...entry, path: `partitions/SI/${entry.path}` });
  }
  return entries;
}

class RpxInflater {
  source: ByteSource;
  expectedSize: number;
  position = 0;
  produced = 0;
  firstAdler = 1;
  secondAdler = 0;
  retained: Uint8Array[] = [];
  retainedStart = 0;
  input: Uint8Array = new Uint8Array();
  inputPosition = 0;
  request: { offset: number; end: number; output: Uint8Array } | null = null;
  finished = false;
  stream: Unzlib | null = null;
  constructor(source: ByteSource, expectedSize: number) {
    this.source = source;
    this.expectedSize = expectedSize;
    this.reset();
  }
  reset() {
    this.position = 0;
    this.produced = 0;
    this.firstAdler = 1;
    this.secondAdler = 0;
    this.retained = [];
    this.retainedStart = 0;
    this.input = new Uint8Array();
    this.inputPosition = 0;
    this.request = null;
    this.finished = false;
    this.stream = new Unzlib((chunk) => this.receive(chunk));
  }
  copy(chunk: Uint8Array, position: number) {
    if (!this.request) return;
    const { offset, end, output } = this.request,
      first = Math.max(offset, position),
      last = Math.min(end, position + chunk.length);
    if (first < last)
      output.set(
        chunk.subarray(first - position, last - position),
        first - offset,
      );
  }
  receive(chunk: Uint8Array) {
    check(
      this.produced + chunk.length <= this.expectedSize,
      'RPX_DECOMPRESSION_SIZE',
    );
    this.copy(chunk, this.produced);
    if (this.request && this.produced + chunk.length > this.request.end) {
      this.retained.push(
        chunk.slice(Math.max(0, this.request.end - this.produced)),
      );
      this.retainedStart = this.request.end;
    }
    for (let index = 0; index < chunk.length; index++) {
      this.firstAdler += chunk[index];
      this.secondAdler += this.firstAdler;
      if ((index & 4095) === 4095) {
        this.firstAdler %= 65521;
        this.secondAdler %= 65521;
      }
    }
    this.firstAdler %= 65521;
    this.secondAdler %= 65521;
    this.produced += chunk.length;
  }
  async advance() {
    check(!this.finished, 'RPX_DECOMPRESSION_SIZE');
    if (this.inputPosition === this.input.length) {
      this.input = await readBytes(
        this.source,
        this.position,
        Math.min(65536, this.source.size - this.position),
      );
      this.inputPosition = 0;
    }
    const amount = Math.min(1024, this.input.length - this.inputPosition),
      chunk = this.input.subarray(
        this.inputPosition,
        this.inputPosition + amount,
      );
    this.position += amount;
    this.inputPosition += amount;
    const final = this.position === this.source.size;
    try {
      check(this.stream, 'RPX_ZLIB');
      this.stream.push(chunk, final);
    } catch (error) {
      if (error instanceof FormatError) throw error;
      throw new FormatError('RPX_ZLIB', 'Invalid compressed RPX section');
    }
    if (final) {
      check(this.produced === this.expectedSize, 'RPX_DECOMPRESSION_SIZE');
      const expectedAdler = new Bin(
        await readBytes(this.source, this.source.size - 4, 4),
      ).u32(0, false);
      check(
        ((this.secondAdler << 16) | this.firstAdler) >>> 0 === expectedAdler,
        'RPX_ZLIB_HASH',
      );
      this.finished = true;
    }
  }
  async validate() {
    while (!this.finished) await this.advance();
  }
  async read(offset: number, length: number) {
    if (!length) return new Uint8Array();
    if (offset < this.retainedStart) this.reset();
    const end = offset + length,
      output = new Uint8Array(length);
    this.request = { offset, end, output };
    let position = this.retainedStart;
    const remaining: Uint8Array[] = [];
    for (const chunk of this.retained) {
      this.copy(chunk, position);
      if (position + chunk.length > end)
        remaining.push(chunk.subarray(Math.max(0, end - position)));
      position += chunk.length;
    }
    this.retained = remaining;
    this.retainedStart = Math.min(end, this.produced);
    try {
      while (this.produced < end) await this.advance();
      if (end === this.expectedSize)
        while (!this.finished) await this.advance();
      this.retainedStart = this.retained.length ? end : this.produced;
      return output;
    } finally {
      this.request = null;
    }
  }
}

function rpxSectionSource(
  source: ByteSource,
  size: number,
  cache: BlockCache<RpxInflater>,
  identity: string,
) {
  let queue = Promise.resolve();
  return {
    size,
    async read(offset: number, length: number) {
      bounds(size, offset, length);
      check(length <= MAX_METADATA, 'READ_TOO_LARGE');
      const operation = queue.then(async () => {
        const state = await cache.get(
          identity,
          4 * 1024 * 1024,
          () => new RpxInflater(source, size),
        );
        return state.read(offset, length);
      });
      queue = operation.then(
        () => {},
        () => {},
      );
      return operation;
    },
  };
}

export async function openRpx(
  source: ByteSource,
  cache = new BlockCache<RpxInflater>(),
) {
  const header = new Bin(await readBytes(source, 0, 52));
  check(
    header.str(0, 4) === '\x7fELF' &&
      header.u8(4) === 1 &&
      header.u8(5) === 2 &&
      header.u16(18, false) === 20,
    'INVALID_RPX',
  );
  const tableOffset = header.u32(32, false),
    recordSize = header.u16(46, false),
    count = header.u16(48, false),
    stringIndex = header.u16(50, false);
  check(
    recordSize === 40 && count > 0 && count <= 4096 && stringIndex < count,
    'INVALID_RPX',
  );
  const table = new Bin(await readBytes(source, tableOffset, count * 40)),
    sections: { source: ByteSource; type: number; name: number }[] = [];
  for (let index = 0; index < count; index++) {
    const offset = index * 40,
      type = table.u32(offset + 4, false),
      flags = table.u32(offset + 8, false),
      size = table.u32(offset + 20, false),
      dataOffset = table.u32(offset + 16, false);
    if (!type || type === 8 || !size) {
      sections.push({ source: empty(), type, name: table.u32(offset, false) });
      continue;
    }
    const data = sliceSource(source, dataOffset, size);
    let sectionSource = data;
    if (flags & 0x08000000) {
      check(size >= 10, 'INVALID_RPX');
      const unpacked = new Bin(await readBytes(data, 0, 4)).u32(0, false);
      check(unpacked <= 256 * 1024 * 1024, 'RPX_SECTION_TOO_LARGE');
      const packed = sliceSource(data, 4, size - 4);
      await new RpxInflater(packed, unpacked).validate();
      sectionSource = rpxSectionSource(
        packed,
        unpacked,
        cache,
        `rpx:${index}:stream`,
      );
    }
    sections.push({
      source: sectionSource,
      type,
      name: table.u32(offset, false),
    });
  }
  const names = sections[stringIndex].source;
  check(names.size > 0 && names.size <= MAX_METADATA, 'INVALID_RPX');
  const nameBytes = await readBytes(names, 0, names.size),
    entries: ArchiveEntry[] = [];
  for (let index = 0; index < count; index++) {
    const section = sections[index];
    if (!section.source.size) continue;
    const label =
      boundedName(nameBytes, section.name, 1024, false) || 'unnamed';
    check(
      !/[<>:"/\\|?*\x00-\x1f\x7f]/.test(label) &&
        label !== '.' &&
        label !== '..',
      'UNSAFE_NAME',
    );
    entries.push({
      path: `sections/${String(index).padStart(3, '0')}_${label}`,
      kind: 'file',
      size: section.source.size,
      source: section.source,
    });
  }
  return entries;
}
