import type {
  ByteSource,
  SourceInput,
  CompanionFile,
  ProgressReporter,
  ArchiveEntry,
} from './contracts.js';
import { Bin, bounds, check, sliceSource, align } from './binary.js';
import { signatureBody } from './crypto.js';
import { equalBytes, hash160, Sha1 } from './wii-hash.js';
import {
  MAX_ENTRIES,
  MAX_METADATA,
  asSource,
  readBytes,
  cbcDecrypt,
  ticketInfo,
  BlockCache,
  blockSource,
  indexedCbcSource,
  companionSet,
  resolveCompanion,
  concatenateSources,
} from './wii-sources.js';
import { walkTree } from './wii-tree.js';
import { openCafePackage, openCafeDisc, openRpx } from './wii-cafe.js';

const WII_MAX_SIZE = 143432 * 2 * 0x8000;

export async function detectWiiImage(file: SourceInput, name = '') {
  const source = asSource(file),
    bytes = await readBytes(source, 0, Math.min(0x100, source.size));
  const view = new Bin(bytes),
    extension = name.toLowerCase().split('.').at(-1) || '';
  if (bytes.length >= 4 && view.str(0, 4) === 'WBFS') return 'WBFS';
  if (bytes.length >= 4 && view.str(0, 4) === 'WUX0') return 'Wii U WUX';
  if (bytes.length >= 4 && view.u32(0, false) === 0x55aa382d) return 'U8';
  if (bytes.length >= 0x20 && view.u32(0x18, false) === 0x5d1c9ea3)
    return 'Wii ISO';
  if (
    bytes.length >= 20 &&
    view.str(0, 4) === '\x7fELF' &&
    (['rpx', 'rpl'].includes(extension) || view.u16(16, false) === 0xfe01)
  )
    return extension === 'rpl' ? 'Wii U RPL' : 'Wii U RPX';
  if (
    bytes.length >= 0x20 &&
    view.u32(0, false) >= 0x20 &&
    view.u32(0, false) <= 0x100 &&
    [0x4973, 0x6962, 0x426b].includes(view.u16(4, false))
  )
    return 'WAD';
  if (
    ['app', 'tmd', 'tik', 'wup'].includes(extension) ||
    /^tmd\.\d+$/i.test(name.split('/').at(-1) || '')
  )
    return 'Wii U WUP';
  if (extension === 'wud') return 'Wii U WUD';
  if (
    source.size >= 0x10004 &&
    view.str(0, Math.min(6, bytes.length)) === 'WUP-P-'
  ) {
    if (
      new Bin(await readBytes(source, 0x10000, 4)).u32(0, false) === 0xcc549eb9
    )
      return 'Wii U WUD';
  }
  if (extension === 'wad') return 'WAD';
  if (extension === 'wbfs') return 'WBFS';
  if (extension === 'wux') return 'Wii U WUX';
  return null;
}

export async function openWbfsSource(
  file: SourceInput,
  name = '',
  companions: CompanionFile[] = [],
): Promise<ByteSource> {
  let source = asSource(file);
  const first = new Bin(await readBytes(source, 0, 12));
  check(first.str(0, 4) === 'WBFS', 'INVALID_WBFS');
  const hdShift = first.u8(8),
    blockShift = first.u8(9);
  check(
    hdShift >= 9 &&
      hdShift <= 20 &&
      blockShift >= 15 &&
      blockShift <= 30 &&
      blockShift >= hdShift,
    'INVALID_WBFS',
  );
  const hdSize = 2 ** hdShift,
    blockSize = 2 ** blockShift,
    expectedSize = first.u32(4, false) * hdSize;
  check(
    expectedSize > 0 &&
      expectedSize % blockSize === 0 &&
      expectedSize / blockSize <= 65536,
    'INVALID_WBFS',
  );
  if (source.size < expectedSize) {
    const records = companionSet(file, name, companions),
      parts = [source];
    let total = source.size;
    for (let index = 1; total < expectedSize && index < 10; index++) {
      const wanted = (name.split('/').at(-1) || '').replace(
        /\.wbfs$/i,
        `.wbf${index}`,
      );
      const part = resolveCompanion(records, name, wanted);
      check(part.source.size > 0, 'INVALID_WBFS');
      parts.push(part.source);
      total += part.source.size;
    }
    source = concatenateSources(parts);
  }
  check(
    source.size === expectedSize,
    'INVALID_WBFS',
    'WBFS size does not match its volume header',
  );
  const header = await readBytes(source, 0, hdSize),
    slots: number[] = [];
  for (let index = 12; index < header.length; index++)
    if (header[index]) slots.push(index - 12);
  check(
    slots.length === 1,
    slots.length > 1 ? 'WBFS_MULTIPLE_DISCS' : 'INVALID_WBFS',
    'Select a single-disc WBFS image',
  );
  const blocks = Math.ceil(WII_MAX_SIZE / blockSize),
    infoSize = align(256 + blocks * 2, hdSize),
    infoOffset = hdSize + slots[0] * infoSize;
  const table = new Bin(await readBytes(source, infoOffset + 256, blocks * 2));
  for (let index = 0; index < blocks; index++) {
    const physical = table.u16(index * 2, false);
    check(
      physical === 0 || physical * blockSize + blockSize <= source.size,
      'INVALID_WBFS',
    );
  }
  return {
    size: WII_MAX_SIZE,
    async read(offset, length) {
      bounds(WII_MAX_SIZE, offset, length);
      check(length <= MAX_METADATA, 'READ_TOO_LARGE');
      const output = new Uint8Array(length);
      let copied = 0;
      while (copied < length) {
        const absolute = offset + copied,
          index = Math.floor(absolute / blockSize),
          within = absolute % blockSize,
          amount = Math.min(length - copied, blockSize - within),
          physical = table.u16(index * 2, false);
        if (physical)
          output.set(
            await readBytes(source, physical * blockSize + within, amount),
            copied,
          );
        copied += amount;
      }
      return output;
    },
  };
}

export async function openWuxSource(file: SourceInput): Promise<ByteSource> {
  const source = asSource(file),
    header = new Bin(await readBytes(source, 0, 32));
  check(
    header.str(0, 4) === 'WUX0' && header.u32(4) === 0x1099d02e,
    'INVALID_WUX',
  );
  const blockSize = header.u32(8),
    size = header.u64(16);
  check(
    blockSize >= 0x100 &&
      blockSize <= 1024 * 1024 &&
      (blockSize & (blockSize - 1)) === 0 &&
      size > 0 &&
      size <= 128 * 1024 ** 3,
    'INVALID_WUX',
  );
  const blocks = Math.ceil(size / blockSize),
    dataOffset = align(32 + blocks * 4, blockSize),
    cache = new BlockCache<Bin>(256 * 1024);
  bounds(source.size, dataOffset, 0);
  return {
    size,
    async read(offset, length) {
      bounds(size, offset, length);
      check(length <= MAX_METADATA, 'READ_TOO_LARGE');
      const output = new Uint8Array(length);
      let copied = 0;
      while (copied < length) {
        const absolute = offset + copied,
          block = Math.floor(absolute / blockSize),
          page = Math.floor(block / 4096);
        const table = await cache.get(
          page,
          16384,
          async () =>
            new Bin(
              await readBytes(
                source,
                32 + page * 16384,
                Math.min(4096, blocks - page * 4096) * 4,
              ),
            ),
        );
        const physical = table.u32((block % 4096) * 4),
          within = absolute % blockSize,
          amount = Math.min(length - copied, blockSize - within);
        bounds(source.size, dataOffset + physical * blockSize, blockSize);
        output.set(
          await readBytes(
            source,
            dataOffset + physical * blockSize + within,
            amount,
          ),
          copied,
        );
        copied += amount;
      }
      return output;
    },
  };
}

export async function openU8(source: ByteSource, prefix = '') {
  const header = new Bin(await readBytes(source, 0, 32));
  check(header.u32(0, false) === 0x55aa382d, 'INVALID_U8');
  const offset = header.u32(4, false),
    size = header.u32(8, false),
    dataOffset = header.u32(12, false);
  check(
    offset >= 32 &&
      size >= 12 &&
      size <= MAX_METADATA &&
      dataOffset >= offset + size,
    'INVALID_U8',
  );
  bounds(source.size, dataOffset, 0);
  const bytes = await readBytes(source, offset, size),
    view = new Bin(bytes),
    entries: ArchiveEntry[] = [];
  walkTree(
    bytes,
    0,
    12,
    (entry, record) => {
      if (entry.kind === 'file') {
        const fileOffset = view.u32(record.offset + 4, false);
        check(fileOffset >= dataOffset, 'INVALID_U8');
        entry.source = sliceSource(source, fileOffset, entry.size);
      }
      check(entry.source, 'INVALID_FST');
      entries.push({ ...entry, source: entry.source });
    },
    { prefix },
  );
  return entries;
}

function add(
  entries: ArchiveEntry[],
  path: string,
  source: ByteSource,
  kind = 'file',
) {
  check(entries.length < MAX_ENTRIES && path.length <= 4096, 'TOO_MANY');
  entries.push({ path, kind, size: source.size, source });
}

async function wiiPartitionSource(
  source: ByteSource,
  base: number,
  header: Bin,
  discHeader: Bin,
  cache: BlockCache,
) {
  const dataOffset = header.u32(0x2b8, false) * 4,
    dataSize = header.u32(0x2bc, false) * 4;
  check(dataOffset >= 0x2c0 && dataSize > 0, 'INVALID_WII_PARTITION');
  bounds(source.size, base + dataOffset, dataSize);
  const raw = sliceSource(source, base + dataOffset, dataSize),
    hashed = discHeader.u8(0x60) === 0,
    encrypted = discHeader.u8(0x61) === 0;
  check(
    hashed || !encrypted,
    'WII_ENCRYPTION_LAYOUT',
    'Encrypted Wii partitions without hash headers are unsupported',
  );
  if (!hashed) return raw;
  check(dataSize % 0x8000 === 0, 'INVALID_WII_PARTITION');
  const key = encrypted ? ticketInfo(header.b.subarray(0, 0x2a4)).key : null;
  const h3Offset = header.u32(0x2b4, false) * 4;
  check(
    h3Offset >= 0x2c0 && h3Offset + 0x18000 <= dataOffset,
    'INVALID_WII_PARTITION',
  );
  const h3 = await readBytes(source, base + h3Offset, 0x18000),
    tmdSize = header.u32(0x2a4, false);
  if (tmdSize) {
    check(tmdSize <= MAX_METADATA, 'INVALID_TMD');
    const metadata = await readBytes(
        source,
        base + header.u32(0x2a8, false) * 4,
        tmdSize,
      ),
      view = new Bin(metadata),
      body = signatureBody(metadata);
    check(
      view.u16(body + 0x9e, false) === 1 &&
        equalBytes(hash160(h3), view.slice(body + 0xb4, 20)),
      'WII_HASH',
      'Partition H3 table hash mismatch',
    );
  }
  return blockSource((dataSize / 0x8000) * 0x7c00, 0x7c00, (index) =>
    cache.get(`wii:${base}:${index}`, 0x8000, async () => {
      const bytes = await readBytes(raw, index * 0x8000, 0x8000);
      const hashes = encrypted
        ? cbcDecrypt(bytes.subarray(0, 0x400), requiredPartitionKey(key))
        : bytes.subarray(0, 0x400);
      const payload = encrypted
        ? cbcDecrypt(
            bytes.subarray(0x400),
            requiredPartitionKey(key),
            bytes.subarray(0x3d0, 0x3e0),
          )
        : bytes.subarray(0x400);
      for (let sector = 0; sector < 31; sector++)
        check(
          equalBytes(
            hash160(payload.subarray(sector * 0x400, (sector + 1) * 0x400)),
            hashes.subarray(sector * 20, sector * 20 + 20),
          ),
          'WII_HASH',
          'Wii partition data hash mismatch',
        );
      check(
        equalBytes(
          hash160(hashes.subarray(0, 620)),
          hashes.subarray(
            0x280 + (index % 8) * 20,
            0x280 + (index % 8) * 20 + 20,
          ),
        ),
        'WII_HASH',
        'Wii H1 hash mismatch',
      );
      check(
        equalBytes(
          hash160(hashes.subarray(0x280, 0x320)),
          hashes.subarray(
            0x340 + (Math.floor(index / 8) % 8) * 20,
            0x340 + (Math.floor(index / 8) % 8) * 20 + 20,
          ),
        ),
        'WII_HASH',
        'Wii H2 hash mismatch',
      );
      const h3Index = Math.floor(index / 64) * 20;
      check(
        h3Index + 20 <= h3.length &&
          equalBytes(
            hash160(hashes.subarray(0x340, 0x3e0)),
            h3.subarray(h3Index, h3Index + 20),
          ),
        'WII_HASH',
        'Wii H3 hash mismatch',
      );
      return payload;
    }),
  );
}

async function openWiiDisc(
  source: ByteSource,
  report: ProgressReporter,
  cache: BlockCache,
) {
  const discHeader = new Bin(await readBytes(source, 0, 0x100));
  check(discHeader.u32(0x18, false) === 0x5d1c9ea3, 'INVALID_WII_ISO');
  const groups = new Bin(await readBytes(source, 0x40000, 32)),
    entries: ArchiveEntry[] = [],
    partitions = new Set<number>();
  add(entries, 'disc/header.bin', sliceSource(source, 0, 0x100));
  for (let group = 0; group < 4; group++) {
    const count = groups.u32(group * 8, false),
      offset = groups.u32(group * 8 + 4, false) * 4;
    check(
      count <= 256 && partitions.size + count <= 256,
      'INVALID_WII_PARTITIONS',
    );
    if (!count) continue;
    const table = new Bin(await readBytes(source, offset, count * 8));
    for (let index = 0; index < count; index++) {
      const base = table.u32(index * 8, false) * 4,
        type = table.u32(index * 8 + 4, false);
      check(base >= 0x40020 && !partitions.has(base), 'INVALID_WII_PARTITIONS');
      partitions.add(base);
      const labels: Record<number, string> = {
        0: 'data',
        1: 'update',
        2: 'channel',
      };
      const prefix = `partitions/${labels[type] || `type${type}`}_${group}_${index}/`;
      const header = new Bin(await readBytes(source, base, 0x2c0)),
        partition = await wiiPartitionSource(
          source,
          base,
          header,
          discHeader,
          cache,
        );
      add(entries, prefix + 'ticket.bin', sliceSource(source, base, 0x2a4));
      for (const [label, sizeField, offsetField] of [
        ['tmd.bin', 0x2a4, 0x2a8],
        ['cert.bin', 0x2ac, 0x2b0],
      ] as const) {
        const length = header.u32(sizeField, false);
        check(length <= MAX_METADATA, 'INVALID_WII_PARTITION');
        if (length)
          add(
            entries,
            prefix + label,
            sliceSource(
              source,
              base + header.u32(offsetField, false) * 4,
              length,
            ),
          );
      }
      const boot = new Bin(await readBytes(partition, 0, 0x440));
      check(
        boot.u32(0x18, false) === 0x5d1c9ea3,
        'WII_PARTITION_HEADER',
        'Decrypted partition header is invalid',
      );
      add(entries, prefix + 'sys/boot.bin', sliceSource(partition, 0, 0x440));
      add(
        entries,
        prefix + 'sys/bi2.bin',
        sliceSource(partition, 0x440, 0x2000),
      );
      const app = new Bin(await readBytes(partition, 0x2440, 32)),
        appSize = 32 + app.u32(20, false) + app.u32(24, false);
      add(
        entries,
        prefix + 'sys/apploader.img',
        sliceSource(partition, 0x2440, appSize),
      );
      const dolOffset = boot.u32(0x420, false) * 4;
      if (dolOffset) {
        const dol = new Bin(await readBytes(partition, dolOffset, 0x100));
        let dolSize = 0x100;
        for (let section = 0; section < 18; section++) {
          const offset = dol.u32(section * 4, false),
            length = dol.u32(0x90 + section * 4, false);
          if (length) {
            check(offset >= 0x100, 'INVALID_DOL');
            dolSize = Math.max(dolSize, offset + length);
          }
        }
        add(
          entries,
          prefix + 'sys/main.dol',
          sliceSource(partition, dolOffset, dolSize),
        );
      }
      const fstOffset = boot.u32(0x424, false) * 4,
        fstSize = boot.u32(0x428, false) * 4;
      check(fstSize >= 12 && fstSize <= MAX_METADATA, 'INVALID_FST');
      const fstBytes = await readBytes(partition, fstOffset, fstSize),
        fst = new Bin(fstBytes);
      add(
        entries,
        prefix + 'sys/fst.bin',
        sliceSource(partition, fstOffset, fstSize),
      );
      walkTree(
        fstBytes,
        0,
        12,
        (entry, record) => {
          if (entry.kind === 'file')
            entry.source = sliceSource(
              partition,
              fst.u32(record.offset + 4, false) * 4,
              entry.size,
            );
          check(entries.length < MAX_ENTRIES, 'TOO_MANY');
          check(entry.source, 'INVALID_FST');
          entries.push({ ...entry, source: entry.source });
        },
        { prefix: prefix + 'files/' },
      );
      report({ phase: 'index', value: (index + 1) / count });
    }
  }
  check(
    partitions.size > 0,
    'WII_NO_PARTITIONS',
    'No Wii partitions were found',
  );
  return entries;
}

async function openWad(
  source: ByteSource,
  report: ProgressReporter,
  cache: BlockCache,
) {
  const header = new Bin(await readBytes(source, 0, 32)),
    headerSize = header.u32(0, false);
  check(
    headerSize >= 32 &&
      headerSize <= 0x100 &&
      [0x4973, 0x6962].includes(header.u16(4, false)),
    'INVALID_WAD',
  );
  let offset = align(headerSize, 64);
  const sections: Record<string, ByteSource> = {};
  for (const [name, field] of [
    ['cert', 8],
    ['crl', 12],
    ['tik', 16],
    ['tmd', 20],
    ['data', 24],
    ['footer', 28],
  ] as const) {
    const size = header.u32(field, false);
    sections[name] = sliceSource(source, offset, size);
    offset = align(offset + size, 64);
  }
  check(
    sections.tik.size >= 0x2a4 &&
      sections.tik.size <= MAX_METADATA &&
      sections.tmd.size <= MAX_METADATA,
    'INVALID_WAD',
  );
  const ticket = ticketInfo(
      await readBytes(sections.tik, 0, sections.tik.size),
    ),
    bytes = await readBytes(sections.tmd, 0, sections.tmd.size),
    metadata = new Bin(bytes),
    body = signatureBody(bytes);
  check(
    equalBytes(ticket.titleId, metadata.slice(body + 0x4c, 8)),
    'WAD_TITLE_ID',
  );
  const count = metadata.u16(body + 0x9e, false),
    entries: ArchiveEntry[] = [],
    ids = new Set<string>();
  check(count > 0 && count <= 65535, 'INVALID_TMD');
  metadata.range(body + 0xa4, count * 36);
  add(entries, 'title.tik', sections.tik);
  add(entries, 'title.tmd', sections.tmd);
  if (sections.cert.size) add(entries, 'title.cert', sections.cert);
  offset = 0;
  for (let index = 0; index < count; index++) {
    const record = body + 0xa4 + index * 36,
      id = metadata.u32(record, false).toString(16).padStart(8, '0'),
      contentIndex = metadata.u16(record + 4, false),
      size = metadata.u64(record + 8, false);
    check(!ids.has(id), 'INVALID_TMD');
    ids.add(id);
    const cipherSize = align(size, 16),
      cipher = sliceSource(sections.data, offset, cipherSize),
      plain = indexedCbcSource(
        cipher,
        ticket.key,
        contentIndex,
        cache,
        `wad:${id}`,
      ),
      content = sliceSource(plain, 0, size),
      hash = new Sha1();
    for (let position = 0; position < size; position += 1024 * 1024) {
      hash.update(
        await readBytes(
          content,
          position,
          Math.min(1024 * 1024, size - position),
        ),
      );
      report({
        phase: 'verify',
        value:
          (index +
            (position + Math.min(1024 * 1024, size - position)) /
              Math.max(size, 1)) /
          count,
      });
    }
    check(
      equalBytes(hash.digest(), metadata.slice(record + 16, 20)),
      'WAD_HASH',
      id,
    );
    add(entries, `${id}.app`, content);
    if (
      size >= 4 &&
      new Bin(await readBytes(content, 0, 4)).u32(0, false) === 0x55aa382d
    ) {
      for (const entry of await openU8(content, `${id}/`)) {
        check(entries.length < MAX_ENTRIES, 'TOO_MANY');
        check(entry.source, 'INVALID_FST');
        entries.push({ ...entry, source: entry.source });
      }
    }
    offset = align(offset + cipherSize, 64);
  }
  check(offset <= sections.data.size, 'INVALID_WAD');
  return entries;
}

export async function openWiiImage(
  file: SourceInput,
  name = '',
  companions: CompanionFile[] = [],
  report: ProgressReporter = () => {},
) {
  let source = asSource(file);
  const format = await detectWiiImage(source, name),
    cache = new BlockCache();
  check(format, 'UNSUPPORTED_WII_IMAGE');
  let entries: ArchiveEntry[] | undefined;
  if (format === 'WBFS') {
    source = await openWbfsSource(file, name, companions);
    entries = await openWiiDisc(source, report, cache);
  } else if (format === 'Wii ISO')
    entries = await openWiiDisc(source, report, cache);
  else if (format === 'WAD') entries = await openWad(source, report, cache);
  else if (format === 'U8') entries = await openU8(source);
  else if (format === 'Wii U RPX' || format === 'Wii U RPL')
    entries = await openRpx(source);
  else if (format === 'Wii U WUP')
    entries = await openCafePackage(file, name, companions, report, cache);
  else if (format === 'Wii U WUD' || format === 'Wii U WUX') {
    if (format === 'Wii U WUX') source = await openWuxSource(source);
    entries = await openCafeDisc(source, name, companions, report, cache);
  }
  check(
    entries && entries.length > 0 && entries.length <= MAX_ENTRIES,
    'EMPTY_WII_IMAGE',
  );
  const paths = new Set<string>();
  for (const entry of entries) {
    check(
      entry.source &&
        entry.source.size === entry.size &&
        !paths.has(entry.path),
      'DUPLICATE_PATH',
    );
    paths.add(entry.path);
  }
  return { format, entries };
}

function requiredPartitionKey(key: Uint8Array | null): Uint8Array {
  check(key, 'INVALID_WII_PARTITION');
  return key;
}
