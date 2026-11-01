import type {
  ByteSource,
  SourceInput,
  ProgressReporter,
  KeySet,
} from './contracts.js';
import { asSource } from './source-input.js';
import { Bin, sliceSource, bounds, check, align } from './binary.js';
import {
  hex,
  sha256,
  sourceHash,
  signatureBody,
  ciaTitleKey,
  ncchKey,
  ncchCounter,
  ctrSource,
  cbcSource,
} from './crypto.js';
import { certificates, ticketTemplate, tmdPrefix } from './ctr-templates.js';
import { automaticKeys } from './defaults.js';
import { sha256 as blockHash } from './vendor/noble/sha256.js';

interface ContentBase {
  source: ByteSource;
  index: number;
  id: number;
  type: number;
  size: number;
  encrypted: boolean;
  executable: boolean;
  offset?: number;
  outerEncrypted?: boolean;
  expectedHash?: Uint8Array;
}
export interface NcchContent extends ContentBase {
  header: Uint8Array;
  titleId: string;
  nonNcch?: false;
}
interface BinaryContent extends ContentBase {
  nonNcch: true;
  header?: undefined;
  titleId?: undefined;
}
export type RomContent = NcchContent | BinaryContent;
interface RomBase {
  name: string;
  source: ByteSource;
  header: Uint8Array;
  contents: RomContent[];
  titleId: string;
}
export type RomInfo = RomBase &
  (
    | {
        format: 'CIA';
        ticket: Uint8Array;
        tmd: Uint8Array;
        certs: Uint8Array;
        meta: Uint8Array;
      }
    | {
        format: 'NCSD' | 'NCCH';
        ticket?: undefined;
        tmd?: undefined;
        certs?: undefined;
        meta?: undefined;
      }
  );
interface Patch {
  offset: number;
  source: ByteSource;
}
interface IvfcLevel {
  logical: number;
  size: number;
  block: number;
  offset: number;
}

const fromBytes = (bytes: Uint8Array) => asSource(new Uint8Array(bytes));

const copy = (b: Uint8Array) => new Uint8Array(b);

const put = (b: Uint8Array, o: number, n: number, le = true) =>
  new DataView(b.buffer, b.byteOffset, b.byteLength).setUint32(o, n, le);

const put16 = (b: Uint8Array, o: number, n: number, le = true) =>
  new DataView(b.buffer, b.byteOffset, b.byteLength).setUint16(o, n, le);

const put64 = (b: Uint8Array, o: number, n: number, le = true) =>
  new DataView(b.buffer, b.byteOffset, b.byteLength).setBigUint64(
    o,
    BigInt(n),
    le,
  );

const zero = (n: number) => fromBytes(new Uint8Array(n));

const equal = (a: Uint8Array, b: Uint8Array) =>
  a.length === b.length && a.every((v, i) => v === b[i]);

async function verifyTmd(tmd: Uint8Array, base: number, count: number) {
  const t = new Bin(tmd),
    info = base + 196,
    chunks = base + 2500;
  t.range(chunks, count * 48);
  check(
    equal(await sha256(t.slice(info, 2304)), t.slice(base + 164, 32)),
    'TMD_INFO_HASH',
  );
  const covered = new Uint8Array(count);
  let total = 0;
  for (let i = 0; i < 64; i++) {
    const p = info + i * 36,
      first = t.u16(p, false),
      length = t.u16(p + 2, false);
    if (!length) {
      continue;
    }
    check(first < count && length <= count - first, 'TMD_COVERAGE');
    for (let j = first; j < first + length; j++) {
      check(!covered[j], 'TMD_COVERAGE');
      covered[j] = 1;
      total++;
    }
    check(
      equal(
        await sha256(t.slice(chunks + first * 48, length * 48)),
        t.slice(p + 4, 32),
      ),
      'TMD_CONTENT_HASH',
    );
  }
  check(total === count, 'TMD_COVERAGE');
}

async function verifyIvfc(
  rom: ByteSource,
  hashSize: number,
  report: ProgressReporter,
) {
  const h = new Bin(await rom.read(0, 96));
  check(h.str(0, 4) === 'IVFC' && h.u32(4) === 65536, 'IVFC_LAYOUT');
  const master = h.u32(8),
    levels: IvfcLevel[] = [];
  for (let i = 0; i < 3; i++) {
    const p = 12 + i * 24,
      log = h.u32(p + 16);
    check(log >= 9 && log <= 20, 'IVFC_LAYOUT');
    const size = h.u64(p + 8);
    check(size > 0, 'IVFC_LAYOUT');
    levels.push({
      logical: h.u64(p),
      offset: 0,
      size,
      block: 2 ** log,
    });
  }
  const [one, two, three] = levels;
  check(
    one.logical === 0 &&
      two.logical === align(one.size, two.block) &&
      three.logical === align(two.logical + two.size, three.block),
    'IVFC_LAYOUT',
  );
  check(
    master === Math.ceil(one.size / one.block) * 32 &&
      one.size === Math.ceil(two.size / two.block) * 32 &&
      two.size === Math.ceil(three.size / three.block) * 32,
    'IVFC_LAYOUT',
  );
  check(96 + master <= hashSize, 'IVFC_LAYOUT');
  three.offset = align(96 + master, three.block);
  one.offset = align(three.offset + three.size, one.block);
  two.offset = align(one.offset + one.size, two.block);
  for (const l of levels) {
    bounds(rom.size, l.offset, align(l.size, l.block));
  }
  const total = levels.reduce((n, l) => n + Math.ceil(l.size / l.block), 0);
  let done = 0;
  for (let i = 0; i < 3; i++) {
    const level = levels[i],
      blocks = Math.ceil(level.size / level.block),
      perBatch = Math.max(1, Math.floor((4 * 1024 * 1024) / level.block));
    const parent = i ? levels[i - 1].offset : 96;
    for (let first = 0; first < blocks; first += perBatch) {
      const count = Math.min(perBatch, blocks - first);
      const data = await rom.read(
        level.offset + first * level.block,
        count * level.block,
      );
      const hashes = await rom.read(parent + first * 32, count * 32);
      for (let j = 0; j < count; j++) {
        check(
          equal(
            blockHash(data.subarray(j * level.block, (j + 1) * level.block)),
            hashes.subarray(j * 32, j * 32 + 32),
          ),
          'IVFC_HASH',
        );
      }
      done += count;
      report({
        phase: 'verify',
        value: done / total,
      });
      await new Promise((resolve) => setTimeout(resolve, 0));
    }
  }
}

export function concatenate(parts: ByteSource[]): ByteSource {
  let size = 0;
  const entries = parts.map((source) => {
    const e = {
      source,
      offset: size,
    };
    size += source.size;
    return e;
  });
  return {
    size,
    async read(o, n) {
      bounds(size, o, n);
      const result = new Uint8Array(n);
      for (const e of entries) {
        const start = Math.max(o, e.offset),
          end = Math.min(o + n, e.offset + e.source.size);
        if (end > start) {
          result.set(
            await e.source.read(start - e.offset, end - start),
            start - o,
          );
        }
      }
      return result;
    },
  };
}

function overlay(src: ByteSource, patches: Patch[]): ByteSource {
  patches.sort((a, b) => a.offset - b.offset);
  let end = 0;
  for (const p of patches) {
    bounds(src.size, p.offset, p.source.size);
    check(p.offset >= end, 'OVERLAP');
    end = p.offset + p.source.size;
  }
  return {
    size: src.size,
    async read(o, n) {
      bounds(src.size, o, n);
      const covering = patches.find(
        (p) => o >= p.offset && o + n <= p.offset + p.source.size,
      );
      if (covering) {
        return covering.source.read(o - covering.offset, n);
      }
      const out = await src.read(o, n);
      for (const p of patches) {
        const start = Math.max(o, p.offset),
          end = Math.min(o + n, p.offset + p.source.size);
        if (end > start) {
          out.set(
            await p.source.read(start - p.offset, end - start),
            start - o,
          );
        }
      }
      return out;
    },
  };
}

async function ncchInfo(
  source: ByteSource,
  index: number,
  id = index,
): Promise<NcchContent> {
  const header = await source.read(0, 512),
    h = new Bin(header);
  check(h.str(256, 4) === 'NCCH', 'INVALID_NCCH');
  const size = h.u32(260) * 512;
  check(size >= 512 && size <= source.size, 'INVALID_NCCH');
  check(h.u8(398) === 0 && [0, 1, 2].includes(h.u16(274)), 'NCCH_LAYOUT');
  return {
    source: sliceSource(source, 0, size),
    header,
    index,
    id,
    type: 0,
    size,
    encrypted: !(h.u8(399) & 4),
    titleId: hex(h.slice(280, 8).slice().reverse()),
    executable: !!(h.u8(397) & 2),
  };
}

export async function inspectRom(
  blob: SourceInput,
  name: string,
  keys: KeySet = {},
): Promise<RomInfo> {
  const source = asSource(blob);
  check(source.size >= 512, 'INVALID');
  const raw = await source.read(0, 512),
    h = new Bin(raw),
    contents: RomContent[] = [];
  let format: RomInfo['format'],
    titleId: string,
    ticket: Uint8Array | undefined,
    tmd: Uint8Array | undefined,
    certs: Uint8Array | undefined,
    meta: Uint8Array | undefined,
    header = raw;
  if (h.str(256, 4) === 'NCSD') {
    format = 'NCSD';
    for (let i = 0; i < 8; i++) {
      const off = h.u32(288 + i * 8) * 512,
        size = h.u32(292 + i * 8) * 512;
      if (size) {
        check(off >= 16384, 'INVALID_NCSD');
        const info = await ncchInfo(sliceSource(source, off, size), i);
        info.offset = off;
        contents.push(info);
      }
    }
    check(
      contents.some((c) => c.index === 0),
      'APP_CONTENT',
    );
    const main = contents.find((c) => c.index === 0);
    check(main && !main.nonNcch, 'APP_CONTENT');
    titleId = main.titleId;
  } else if (h.str(256, 4) === 'NCCH') {
    format = 'NCCH';
    contents.push(await ncchInfo(source, 0));
    const main = contents[0];
    check(!main.nonNcch, 'APP_CONTENT');
    titleId = main.titleId;
  } else if (h.u32(0) === 8224) {
    format = 'CIA';
    header = await source.read(0, 8224);
    const bh = new Bin(header),
      certOff = align(8224),
      ticketOff = certOff + align(bh.u32(8)),
      tmdOff = ticketOff + align(bh.u32(12)),
      contentOff = tmdOff + align(bh.u32(16)),
      contentSize = bh.u64(24),
      metaOff = contentOff + align(contentSize);
    check(
      bh.u32(8) <= 2 * 1024 * 1024 &&
        bh.u32(12) <= 2 * 1024 * 1024 &&
        bh.u32(16) <= 8 * 1024 * 1024 &&
        bh.u32(20) <= 8 * 1024 * 1024,
      'TOO_LARGE',
    );
    [certs, ticket, tmd, meta] = await Promise.all([
      source.read(certOff, bh.u32(8)),
      source.read(ticketOff, bh.u32(12)),
      source.read(tmdOff, bh.u32(16)),
      source.read(metaOff, bh.u32(20)),
    ]);
    const t = new Bin(tmd),
      base = signatureBody(tmd),
      count = t.u16(base + 158, false),
      seen = new Set<number>();
    check(count > 0 && count <= 65535, 'INVALID_CIA');
    await verifyTmd(tmd, base, count);
    titleId = hex(t.slice(base + 76, 8));
    let offset = contentOff,
      key: Uint8Array | undefined;
    for (let i = 0; i < count; i++) {
      const p = base + 2500 + i * 48,
        index = t.u16(p + 4, false);
      check(!seen.has(index), 'DUPLICATE_INDEX');
      seen.add(index);
      if (!(bh.u8(32 + (index >> 3)) & (128 >> (index & 7)))) {
        continue;
      }
      const size = t.u64(p + 8, false),
        type = t.u16(p + 6, false);
      let src = sliceSource(source, offset, size);
      offset += size;
      if (type & 1) {
        key ??= ciaTitleKey(ticket, keys);
        const iv = new Uint8Array(16);
        put16(iv, 0, index, false);
        src = cbcSource(src, key, iv);
      }
      const prefix = new Bin(await src.read(0, Math.min(512, size)));
      const c: RomContent =
        prefix.b.length >= 512 && prefix.str(256, 4) === 'NCCH'
          ? await ncchInfo(src, index, t.u32(p, false))
          : {
              source: src,
              index,
              id: t.u32(p, false),
              size,
              executable: false,
              encrypted: false,
              nonNcch: true,
              type,
            };
      c.outerEncrypted = !!(type & 1);
      c.type = type;
      c.expectedHash = t.slice(p + 16, 32);
      contents.push(c);
    }
    check(offset === contentOff + contentSize, 'INVALID_CIA');
    check(contents.length > 0, 'APP_CONTENT');
  } else {
    check(false, 'ROM_FORMAT');
  }
  const base = { name, source, header, contents, titleId };
  if (format === 'CIA') {
    check(ticket && tmd && certs && meta, 'INVALID_CIA');
    return { ...base, format, ticket, tmd, certs, meta };
  }
  return { ...base, format };
}

async function verifyHash(
  src: ByteSource,
  expected: Uint8Array,
  code: string,
  report: ProgressReporter,
) {
  check(hex(await sourceHash(src, report)) === hex(expected), code);
}

async function decryptedNcch(
  content: RomContent,
  keys: KeySet,
  installFlag: boolean | null,
  report: ProgressReporter,
) {
  if (content.nonNcch) {
    check(installFlag === null, 'NOT_APPLICATION');
    return content.source;
  }
  const original = content.source,
    header = copy(content.header),
    h = new Bin(header),
    patches: Patch[] = [],
    encrypted = content.encrypted;
  const exLen = h.u32(384),
    exefsOff = h.u32(416) * 512,
    exefsSize = h.u32(420) * 512,
    romOff = h.u32(432) * 512,
    romSize = h.u32(436) * 512;
  const logoSize = h.u32(412) * 512;
  if (logoSize) {
    await verifyHash(
      sliceSource(original, h.u32(408) * 512, logoSize),
      h.slice(304, 32),
      'LOGO_HASH',
      report,
    );
  }
  let primary: Uint8Array | undefined, secondary: Uint8Array | undefined;
  if (encrypted) {
    primary = await ncchKey(header, keys, false);
    secondary = await ncchKey(header, keys, true);
  }
  let exheader: Uint8Array | undefined;
  if (exLen) {
    check(exLen === 1024, 'NCCH_LAYOUT');
    let ex = sliceSource(original, 512, 2048);
    if (encrypted) {
      ex = ctrSource(ex, requiredKey(primary), ncchCounter(header, 1, 512));
    }
    exheader = await ex.read(0, 2048);
    await verifyHash(
      fromBytes(exheader.subarray(0, exLen)),
      h.slice(352, 32),
      'EXHEADER_HASH',
      report,
    );
    if (installFlag !== null) {
      exheader[13] = installFlag ? exheader[13] | 2 : exheader[13] & ~2;
      header.set(await sha256(exheader.subarray(0, exLen)), 352);
    }
    patches.push({
      offset: 512,
      source: fromBytes(exheader),
    });
  }
  if (exefsSize) {
    let ex = sliceSource(original, exefsOff, exefsSize),
      defaultSource = ex;
    if (encrypted) {
      defaultSource = ctrSource(
        ex,
        requiredKey(primary),
        ncchCounter(header, 2, exefsOff),
      );
      const info = new Bin(await defaultSource.read(0, 512)),
        ranges: Patch[] = [];
      for (let i = 0; i < 10; i++) {
        const name = info.str(i * 16, 8).replace(/\0/g, ''),
          off = info.u32(i * 16 + 8) + 512,
          size = info.u32(i * 16 + 12);
        if (!name || !size || ['icon', 'banner'].includes(name)) {
          continue;
        }
        bounds(ex.size, off, size);
        const secondarySource = ctrSource(
          ex,
          requiredKey(secondary),
          ncchCounter(header, 2, exefsOff),
        );
        ranges.push({
          offset: off,
          source: sliceSource(secondarySource, off, size),
        });
      }
      ex = overlay(defaultSource, ranges);
    }
    const hashSize = h.u32(424) * 512;
    check(hashSize <= ex.size && hashSize <= 1024 * 1024, 'INVALID_NCCH');
    if (hashSize) {
      await verifyHash(
        sliceSource(ex, 0, hashSize),
        h.slice(448, 32),
        'EXEFS_HASH',
        report,
      );
    }
    const entries = new Bin(await ex.read(0, 512));
    for (let i = 0; i < 10; i++) {
      const name = entries.str(i * 16, 8).replace(/\0/g, ''),
        size = entries.u32(i * 16 + 12);
      if (name) {
        const file = sliceSource(ex, 512 + entries.u32(i * 16 + 8), size);
        await verifyHash(
          file,
          entries.slice(480 - i * 32, 32),
          'EXEFS_FILE_HASH',
          report,
        );
      }
    }
    patches.push({
      offset: exefsOff,
      source: ex,
    });
  }
  if (romSize) {
    let rom = sliceSource(original, romOff, romSize);
    if (encrypted) {
      rom = ctrSource(
        rom,
        requiredKey(secondary),
        ncchCounter(header, 3, romOff),
      );
    }
    const hashSize = h.u32(440) * 512;
    check(
      hashSize > 0 && hashSize <= rom.size && hashSize <= 1024 * 1024,
      'INVALID_NCCH',
    );
    await verifyHash(
      sliceSource(rom, 0, hashSize),
      h.slice(480, 32),
      'ROMFS_HASH',
      report,
    );
    await verifyIvfc(rom, hashSize, report);
    patches.push({
      offset: romOff,
      source: rom,
    });
  }
  if (installFlag !== null && content.executable) {
    check(exheader, 'APP_METADATA');
  }
  header[395] = 0;
  header[399] = (header[399] & ~33) | 4;
  patches.unshift({
    offset: 0,
    source: fromBytes(header),
  });
  return overlay(original, patches);
}

function appCheck(info: RomInfo) {
  check(/^00040000[0-9a-f]{8}$/.test(info.titleId), 'NOT_APPLICATION');
  check(info.contents.length <= 8, 'CONTENT_INDEX');
  const main = info.contents.find((c) => c.index === 0);
  check(main && main.executable && !main.nonNcch, 'APP_CONTENT');
  for (const c of info.contents) {
    check(c.index < 8 && !c.nonNcch, 'CONTENT_INDEX');
    if (c.index !== 0) {
      check(!c.executable, 'APP_CONTENT');
    }
  }
}

async function ciaImage(
  info: RomInfo,
  contents: RomContent[],
  report: ProgressReporter,
) {
  const originalTmd = info.tmd,
    base = originalTmd ? signatureBody(originalTmd) : 320,
    tmd = new Uint8Array(base + 2500 + contents.length * 48);
  if (originalTmd) {
    tmd.set(originalTmd.subarray(0, base + 196));
  } else {
    tmd.set(tmdPrefix);
    put(tmd, 0, 65540, false);
    tmd.fill(255, 4, 260);
    tmd[base + 64] = 1;
    put(tmd, base + 84, 64, false);
  }
  const title = info.titleId;
  const titleBytes = Uint8Array.from(title.match(/../g) || [], (x) =>
    parseInt(x, 16),
  );
  tmd.set(titleBytes, base + 76);
  put16(tmd, base + 158, contents.length, false);
  put16(tmd, base + 160, 0, false);
  for (let i = 0; i < contents.length; i++) {
    const c = contents[i],
      p = base + 2500 + i * 48;
    put(tmd, p, c.id, false);
    put16(tmd, p + 4, c.index, false);
    put16(tmd, p + 6, c.type & ~1, false);
    put64(tmd, p + 8, c.source.size, false);
    tmd.set(await sourceHash(c.source, report), p + 16);
  }
  const records = tmd.subarray(base + 2500);
  put16(tmd, base + 196, 0, false);
  put16(tmd, base + 198, contents.length, false);
  tmd.set(await sha256(records), base + 200);
  tmd.set(await sha256(tmd.subarray(base + 196, base + 2500)), base + 164);
  const certs = info.certs || certificates,
    ticket = info.ticket ? copy(info.ticket) : copy(ticketTemplate);
  if (!info.ticket) {
    ticket.fill(255, 4, 260);
    ticket.set(titleBytes, 476);
    ticket.fill(0, 720, 848);
    for (const c of contents) {
      check(c.index < 1024, 'CONTENT_INDEX');
      ticket[720 + (c.index >> 3)] |= 1 << (c.index & 7);
    }
  }
  let meta = info.meta || new Uint8Array();
  const main = contents.find((c) => c.index === 0);
  if (!info.tmd && main) {
    const h = new Bin(await main.source.read(0, 512));
    if (h.u32(384) === 1024) {
      const exh = new Bin(await requiredMain(main).source.read(512, 1024));
      put(tmd, base + 90, exh.u64(448));
      put16(tmd, base + 156, exh.u16(14), false);
      meta = new Uint8Array(15040);
      meta.set(exh.slice(64, 384));
      put(meta, 768, exh.u32(520));
      const off = h.u32(416) * 512;
      if (off) {
        const ex = new Bin(await main.source.read(off, 512));
        for (let i = 0; i < 10; i++) {
          if (ex.str(i * 16, 8).replace(/\0/g, '') === 'icon') {
            const n = ex.u32(i * 16 + 12);
            if (n === 14016) {
              meta.set(
                await main.source.read(off + 512 + ex.u32(i * 16 + 8), n),
                1024,
              );
            }
          }
        }
      }
    }
  }
  const header = new Uint8Array(8224),
    total = contents.reduce((n, c) => n + c.source.size, 0);
  put(header, 0, 8224);
  put(header, 8, certs.length);
  put(header, 12, ticket.length);
  put(header, 16, tmd.length);
  put(header, 20, meta.length);
  put64(header, 24, total);
  for (const c of contents) {
    header[32 + (c.index >> 3)] |= 128 >> (c.index & 7);
  }
  const parts: ByteSource[] = [],
    pushAligned = (bytes: Uint8Array) => {
      parts.push(fromBytes(bytes));
      const padding = align(bytes.length) - bytes.length;
      if (padding) {
        parts.push(zero(padding));
      }
    };
  pushAligned(header);
  pushAligned(certs);
  pushAligned(ticket);
  pushAligned(tmd);
  for (const c of contents) {
    parts.push(c.source);
  }
  if (align(total) > total) {
    parts.push(zero(align(total) - total));
  }
  if (meta.length) {
    parts.push(fromBytes(meta));
  }
  return concatenate(parts);
}

function ccmInitial(header: Uint8Array, mainHeader: Uint8Array) {
  const aes = new globalThis.aesjs.AES(new Uint8Array(16)),
    nonce = crypto.getRandomValues(new Uint8Array(12)),
    seed = crypto.getRandomValues(new Uint8Array(16)),
    b0 = new Uint8Array(16);
  b0[0] = 58;
  b0.set(nonce, 1);
  b0[15] = 16;
  const mac = aes.encrypt(b0);
  for (let i = 0; i < 16; i++) {
    mac[i] ^= seed[i];
  }
  const tag = aes.encrypt(mac),
    counter = new Uint8Array(16);
  counter[0] = 2;
  counter.set(nonce, 1);
  const s0 = aes.encrypt(counter);
  counter[15] = 1;
  const s1 = aes.encrypt(counter);
  for (let i = 0; i < 16; i++) {
    header[4112 + i] = seed[i] ^ s1[i];
    header[4128 + i] = tag[i] ^ s0[i];
  }
  header.set(nonce, 4144);
  header.set(mainHeader.subarray(264, 272), 4096);
  header.set(mainHeader.subarray(256, 512), 4352);
}

async function cciImage(contents: RomContent[]) {
  const header = new Uint8Array(16384);
  header.fill(255, 0, 256);
  header.set(new TextEncoder().encode('NCSD'), 256);
  const main = contents.find((c) => c.index === 0),
    mainHeader = await requiredMain(main).source.read(0, 512),
    mh = new Bin(mainHeader);
  header.set(mainHeader.subarray(264, 272), 264);
  let save = 0;
  if (mh.u32(384)) {
    save = new Bin(await requiredMain(main).source.read(512, 1024)).u64(448);
  }
  const card2 = save > 512 * 1024;
  if (card2) {
    save = align(save, 1048576);
  }
  const packed: ByteSource[] = [],
    mainId = new DataView(
      mainHeader.buffer,
      mainHeader.byteOffset,
    ).getBigUint64(264, true);
  let offset = 16384;
  for (const c of [...contents].sort((a, b) => a.index - b.index)) {
    let src = c.source;
    if (c.index !== 0) {
      const h = copy(await src.read(0, 512));
      new DataView(h.buffer).setBigUint64(
        264,
        (mainId & 0x0000ffffffffffffn) | (BigInt(c.index + 4) << 48n),
        true,
      );
      h.set(mainHeader.subarray(280, 288), 280);
      src = overlay(src, [
        {
          offset: 0,
          source: fromBytes(h),
        },
      ]);
    }
    put(header, 288 + c.index * 8, offset / 512);
    put(header, 292 + c.index * 8, align(src.size, 512) / 512);
    const ph = await src.read(264, 8);
    header.set(ph, 400 + c.index * 8);
    packed.push(src);
    if (align(src.size, 512) > src.size) {
      packed.push(zero(align(src.size, 512) - src.size));
    }
    offset += align(src.size, 512);
  }
  let capacity = card2 ? 512 * 1024 * 1024 : 128 * 1024 * 1024,
    writable = 4294967295;
  const slack = new Map<number, number>([
    [512 * 1024 * 1024, 37224448],
    [1024 ** 3, 73924608],
    [2 * 1024 ** 3, 147324928],
    [4 * 1024 ** 3, 294649856],
    [8 * 1024 ** 3, 587202560],
  ]);
  while (capacity <= 8 * 1024 ** 3) {
    if (card2) {
      const reserved = slack.get(capacity);
      check(reserved !== undefined, 'CARD_CAPACITY');
      writable = capacity - reserved - save;
      if (
        save <= capacity / 2 &&
        save <= 2047 * 1024 * 1024 &&
        offset <= writable
      ) {
        break;
      }
    } else if (capacity >= offset) {
      break;
    }
    capacity *= 2;
  }
  check(capacity <= 8 * 1024 ** 3, 'MEDIA_SIZE');
  put(header, 260, capacity / 512);
  header[395] = card2 ? 2 : 1;
  header[396] = 1;
  header[397] = card2 ? 2 : 1;
  put(header, 512, card2 ? writable / 512 : 4294967295);
  put(header, 516, 192, false);
  put64(header, 768, offset);
  ccmInitial(header, mainHeader);
  return concatenate([fromBytes(header), ...packed]);
}

export async function prepareConversion(
  blob: SourceInput,
  name: string,
  target = 'decrypt',
  keys: KeySet | undefined,
  report: ProgressReporter = () => {},
) {
  keys ??= await automaticKeys();
  const info = await inspectRom(blob, name, keys),
    warnings = ['REBUILT_SIGNATURES'];
  check(['decrypt', 'cia', '3ds'].includes(target), 'OUTPUT_FORMAT');
  const desired =
    target === 'decrypt' ? info.format : target === 'cia' ? 'CIA' : 'NCSD';
  if (target !== 'decrypt') {
    appCheck(info);
  }
  let selected = info.contents;
  if (info.format === 'NCSD' && desired === 'CIA') {
    check(!selected.some((c) => c.index >= 3 && c.index <= 5), 'CONTENT_INDEX');
    if (selected.some((c) => c.index >= 6)) {
      warnings.push('SKIPPED_UPDATES');
    }
    selected = selected.filter((c) => c.index <= 2);
  }
  const contents = await decryptRomContents(
    info,
    keys,
    report,
    desired,
    selected,
  );
  let source: ByteSource;
  if (desired === 'CIA') {
    source = await ciaImage(info, contents, report);
  } else if (desired === 'NCSD') {
    if (info.format === 'NCSD') {
      source = overlay(
        info.source,
        contents.map((c) => ({
          offset: requiredOffset(c),
          source: c.source,
        })),
      );
    } else {
      source = await cciImage(contents);
    }
  } else {
    check(contents.length === 1, 'OUTPUT_FORMAT');
    source = contents[0].source;
  }
  const ext =
    desired === 'CIA'
      ? 'cia'
      : desired === 'NCSD'
        ? '3ds'
        : contents[0].executable
          ? 'cxi'
          : 'cfa';
  return {
    source,
    filename: name.replace(/\.[^.]+$/, '') + '-decrypted.' + ext,
    format: desired,
    titleId: info.titleId,
    warnings,
    contents: contents.map((c) => ({
      index: c.index,
      id: c.id,
      size: c.size,
    })),
  };
}

export async function decryptRomContents(
  info: RomInfo,
  keys: KeySet | undefined,
  report: ProgressReporter = () => {},
  desired = info.format,
  selected = info.contents,
) {
  keys ??= await automaticKeys();
  const contents: RomContent[] = [];
  for (let i = 0; i < selected.length; i++) {
    const c = selected[i];
    report({
      phase: 'decrypt',
      value: i / selected.length,
    });
    if (info.format === 'CIA') {
      check(c.expectedHash, 'CONTENT_HASH');
      await verifyHash(c.source, c.expectedHash, 'CONTENT_HASH', report);
    }
    const flag =
      desired !== info.format && c.index === 0 ? desired === 'CIA' : null;
    const src = await decryptedNcch(c, keys, flag, report);
    contents.push({
      ...c,
      source: src,
      size: src.size,
    });
  }
  return contents;
}

function requiredKey(key: Uint8Array | undefined): Uint8Array {
  check(key, 'MISSING_KEY');
  return key;
}
function requiredMain(content: RomContent | undefined): RomContent {
  check(content, 'APP_CONTENT');
  return content;
}
function requiredOffset(content: RomContent): number {
  check(content.offset !== undefined, 'INVALID_NCSD');
  return content.offset;
}
