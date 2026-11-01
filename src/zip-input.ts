import type {
  Archive,
  ArchiveEntry,
  ByteSource,
  ProgressReporter,
} from './contracts.js';
import { Bin, bounds, check, FormatError, sliceSource } from './binary.js';
import { Inflate } from './vendor/fflate.mjs';
import { createZipStorageFactory } from './zip-storage.js';
import type { ZipStorage } from './zip-storage.js';

interface ZipRecord {
  path: string;
  directory: boolean;
  flags: number;
  method: number;
  crc: number;
  compressed: number;
  size: number;
  local: number;
  data: number;
  end: number;
  name: Uint8Array;
  zip64: boolean;
}

const CHUNK = 65536;
const NONE = 0xffffffff;
const MAX_ENTRIES = 200000;
const MAX_NAMES = 16 * 1024 * 1024;
const cp437 =
  'ÇüéâäàåçêëèïîìÄÅÉæÆôöòûùÿÖÜ¢£¥₧ƒáíóúñÑªº¿⌐¬½¼¡«»░▒▓│┤╡╢╖╕╣║╗╝╜╛┐└┴┬├─┼╞╟╚╔╩╦╠═╬╧╨╤╥╙╘╒╓╫╪┘┌█▄▌▐▀αßΓπΣσµτΦΘΩδ∞φε∩≡±≥≤⌠⌡÷≈°∙·√ⁿ²■ ';
const crcTable = Uint32Array.from({ length: 256 }, (_, value) => {
  for (let bit = 0; bit < 8; bit++)
    value = value & 1 ? 0xedb88320 ^ (value >>> 1) : value >>> 1;
  return value >>> 0;
});

function crc32(crc: number, bytes: Uint8Array) {
  for (let index = 0; index < bytes.length; index++)
    crc = crcTable[(crc ^ bytes[index]) & 255] ^ (crc >>> 8);
  return crc >>> 0;
}

function u64(bin: Bin, offset: number) {
  const value = bin.d.getBigUint64(offset, true);
  check(value <= BigInt(Number.MAX_SAFE_INTEGER), 'ZIP_SIZE');
  return Number(value);
}

function zip64(extra: Uint8Array, wanted: boolean[]) {
  const bin = new Bin(extra);
  let record: Bin | null = null;
  for (let offset = 0; offset < extra.length;) {
    check(offset + 4 <= extra.length, 'ZIP_HEADER');
    const size = bin.u16(offset + 2);
    check(size <= extra.length - offset - 4, 'ZIP_HEADER');
    if (bin.u16(offset) === 1) {
      check(!record, 'ZIP_HEADER');
      record = new Bin(extra.subarray(offset + 4, offset + 4 + size));
    }
    offset += 4 + size;
  }
  const values: number[] = [];
  let offset = 0;
  for (let index = 0; index < wanted.length; index++) {
    if (!wanted[index]) {
      values.push(0);
      continue;
    }
    const length = index === 3 ? 4 : 8;
    check(record && offset + length <= record.b.length, 'ZIP_HEADER');
    values.push(length === 8 ? u64(record, offset) : record.u32(offset));
    offset += length;
  }
  return values;
}

function safePath(name: Uint8Array, flags: number) {
  let path = '';
  if (flags & 0x800) {
    try {
      path = new TextDecoder('utf-8', { fatal: true }).decode(name);
    } catch {
      throw new FormatError('UNSAFE_NAME');
    }
  } else {
    for (const byte of name)
      path += byte < 128 ? String.fromCharCode(byte) : cp437[byte - 128];
  }
  check(path.length > 0 && path.length <= 4096, 'UNSAFE_NAME');
  const directory = path.endsWith('/');
  const clean = directory ? path.slice(0, -1) : path;
  for (const part of clean.split('/'))
    check(
      part &&
        part !== '.' &&
        part !== '..' &&
        !/[<>:"\\|?*\x00-\x1f\x7f]/.test(part) &&
        !/[. ]$/.test(part),
      'UNSAFE_NAME',
    );
  return { path, clean, directory };
}

export async function openZipArchive(
  source: ByteSource,
  report: ProgressReporter = () => {},
  options: { createStorage?: () => Promise<ZipStorage> } = {},
): Promise<Archive & { dispose: () => Promise<void> }> {
  check(Number.isSafeInteger(source.size) && source.size >= 22, 'ZIP_HEADER');
  let disposed = false;
  let queue = Promise.resolve();
  let disposal: Promise<void> | null = null;
  const storages = new Set<ZipStorage>();
  const defaultStorage = createZipStorageFactory();
  let progress: { phase: string; value: number | null; detail: string } = {
    phase: 'index',
    value: null,
    detail: '',
  };
  let reported = progress;
  let reportedAt = -Infinity;
  function current(
    phase = progress.phase,
    value: number | null = progress.value,
    detail = progress.detail,
    force = false,
  ) {
    check(!disposed, 'CANCELLED');
    progress = { phase, value, detail };
    const now = performance.now();
    if (
      force ||
      now - reportedAt >= 50 ||
      phase !== reported.phase ||
      detail !== reported.detail ||
      (value === 1 && reported.value !== 1)
    ) {
      report(progress);
      reported = progress;
      reportedAt = now;
    }
    check(!disposed, 'CANCELLED');
  }
  function checkCurrent() {
    current(progress.phase, progress.value, progress.detail, true);
  }
  async function read(offset: number, length: number) {
    bounds(source.size, offset, length);
    if (length <= CHUNK) {
      current();
      const bytes = length
        ? await source.read(offset, length)
        : new Uint8Array();
      current();
      check(
        bytes instanceof Uint8Array && bytes.length === length,
        'TRUNCATED',
      );
      return bytes;
    }
    const output = new Uint8Array(length);
    for (let position = 0; position < length; position += CHUNK) {
      current();
      const amount = Math.min(CHUNK, length - position);
      const bytes = await source.read(offset + position, amount);
      current();
      check(
        bytes instanceof Uint8Array && bytes.length === amount,
        'TRUNCATED',
      );
      output.set(bytes, position);
    }
    return output;
  }
  async function checkpoint(phase: string, value: number, detail: string) {
    current(phase, value, detail);
    await new Promise((resolve) => setTimeout(resolve, 0));
    current(phase, value, detail, true);
  }
  const tailSize = Math.min(source.size, 65557);
  const tail = new Bin(await read(source.size - tailSize, tailSize));
  let end = -1;
  for (let offset = tailSize - 22; offset >= 0; offset--) {
    if (
      tail.u32(offset) === 0x06054b50 &&
      offset + 22 + tail.u16(offset + 20) === tailSize
    ) {
      end = offset;
      break;
    }
  }
  check(end >= 0, 'ZIP_HEADER');
  const endOffset = source.size - tailSize + end;
  check(tail.u16(end + 4) === 0 && tail.u16(end + 6) === 0, 'ZIP_MULTIDISK');
  let count = tail.u16(end + 10);
  let directorySize = tail.u32(end + 12);
  let directoryOffset = tail.u32(end + 16);
  let directoryEnd = endOffset;
  check(tail.u16(end + 8) === count, 'ZIP_MULTIDISK');
  if (count === 0xffff || directorySize === NONE || directoryOffset === NONE) {
    check(endOffset >= 20, 'ZIP_HEADER');
    const locator = new Bin(await read(endOffset - 20, 20));
    check(
      locator.u32(0) === 0x07064b50 &&
        locator.u32(4) === 0 &&
        locator.u32(16) === 1,
      'ZIP_MULTIDISK',
    );
    directoryEnd = u64(locator, 8);
    const record = new Bin(await read(directoryEnd, 56));
    check(
      record.u32(0) === 0x06064b50 &&
        record.u32(16) === 0 &&
        record.u32(20) === 0,
      'ZIP_HEADER',
    );
    const recordSize = u64(record, 4);
    check(
      recordSize >= 44 &&
        recordSize <= 1024 * 1024 &&
        directoryEnd + 12 + recordSize === endOffset - 20,
      'ZIP_HEADER',
    );
    const count64 = u64(record, 32);
    const size64 = u64(record, 40);
    const offset64 = u64(record, 48);
    check(u64(record, 24) === count64, 'ZIP_MULTIDISK');
    check(
      (count === 0xffff || count === count64) &&
        (directorySize === NONE || directorySize === size64) &&
        (directoryOffset === NONE || directoryOffset === offset64),
      'ZIP_HEADER',
    );
    count = count64;
    directorySize = size64;
    directoryOffset = offset64;
  }
  check(count <= MAX_ENTRIES, 'TOO_MANY');
  check(
    directoryOffset <= directoryEnd &&
      directorySize === directoryEnd - directoryOffset,
    'ZIP_HEADER',
  );
  check(count <= Math.floor(directorySize / 46), 'ZIP_HEADER');
  const records: ZipRecord[] = [];
  const paths = new Map<string, boolean>();
  let position = directoryOffset;
  let names = 0;
  for (let index = 0; index < count; index++) {
    check(position + 46 <= directoryEnd, 'ZIP_HEADER');
    const header = new Bin(await read(position, 46));
    check(header.u32(0) === 0x02014b50, 'ZIP_HEADER');
    const flags = header.u16(8);
    const method = header.u16(10);
    check(!(flags & 0x41), 'ZIP_ENCRYPTED');
    check(!(flags & ~0x080e), 'ZIP_FLAGS');
    check(method === 0 || method === 8, 'ZIP_METHOD');
    const nameLength = header.u16(28);
    const extraLength = header.u16(30);
    const total = 46 + nameLength + extraLength + header.u16(32);
    check(nameLength > 0 && nameLength <= 4096, 'UNSAFE_NAME');
    check(total <= directoryEnd - position, 'ZIP_HEADER');
    const metadata = await read(position + 46, nameLength + extraLength);
    const name = metadata.slice(0, nameLength);
    const { path, clean, directory } = safePath(name, flags);
    names += nameLength;
    check(names <= MAX_NAMES, 'TOO_LARGE');
    check(!paths.has(clean), 'DUPLICATE_PATH');
    paths.set(clean, directory);
    const compressed32 = header.u32(20);
    const size32 = header.u32(24);
    const local32 = header.u32(42);
    const disk32 = header.u16(34);
    const sizes = zip64(metadata.subarray(nameLength), [
      size32 === NONE,
      compressed32 === NONE,
      local32 === NONE,
      disk32 === 0xffff,
    ]);
    const size = size32 === NONE ? sizes[0] : size32;
    const compressed = compressed32 === NONE ? sizes[1] : compressed32;
    const local = local32 === NONE ? sizes[2] : local32;
    check((disk32 === 0xffff ? sizes[3] : disk32) === 0, 'ZIP_MULTIDISK');
    check(((header.u32(38) >>> 16) & 0xf000) !== 0xa000, 'ZIP_LINK');
    check(
      (method !== 0 || compressed === size) &&
        (!directory || size === 0) &&
        (size !== 0 || header.u32(16) === 0),
      'ZIP_SIZE',
    );
    check(
      local < directoryOffset &&
        compressed <= directoryOffset &&
        (method !== 8 || compressed > 0),
      'ZIP_HEADER',
    );
    records.push({
      path,
      directory,
      flags,
      method,
      crc: header.u32(16),
      compressed,
      size,
      local,
      data: 0,
      end: 0,
      name,
      zip64: size32 === NONE || compressed32 === NONE,
    });
    position += total;
    if ((index & 255) === 255)
      await checkpoint('index', (index + 1) / count, path);
  }
  check(position === directoryEnd, 'ZIP_HEADER');
  for (let recordIndex = 0; recordIndex < records.length; recordIndex++) {
    const record = records[recordIndex];
    const clean = record.directory ? record.path.slice(0, -1) : record.path;
    const parts = clean.split('/');
    let parent = '';
    for (let index = 0; index < parts.length - 1; index++) {
      parent += (index ? '/' : '') + parts[index];
      check(paths.get(parent) !== false, 'DUPLICATE_PATH');
    }
    const local = new Bin(await read(record.local, 30));
    check(
      local.u32(0) === 0x04034b50 &&
        local.u16(6) === record.flags &&
        local.u16(8) === record.method,
      'ZIP_HEADER',
    );
    const nameLength = local.u16(26);
    const extraLength = local.u16(28);
    check(nameLength === record.name.length, 'ZIP_HEADER');
    const metadata = await read(record.local + 30, nameLength + extraLength);
    check(
      record.name.every((byte, index) => metadata[index] === byte),
      'ZIP_HEADER',
    );
    const compressed32 = local.u32(18);
    const size32 = local.u32(22);
    const sizes = zip64(metadata.subarray(nameLength), [
      size32 === NONE,
      compressed32 === NONE,
    ]);
    const size = size32 === NONE ? sizes[0] : size32;
    const compressed = compressed32 === NONE ? sizes[1] : compressed32;
    const descriptor = !!(record.flags & 8);
    check(
      (local.u32(14) === record.crc || (descriptor && local.u32(14) === 0)) &&
        (size === record.size || (descriptor && size === 0)) &&
        (compressed === record.compressed || (descriptor && compressed === 0)),
      'ZIP_HEADER',
    );
    record.data = record.local + 30 + nameLength + extraLength;
    check(
      record.data <= directoryOffset &&
        record.compressed <= directoryOffset - record.data,
      'ZIP_HEADER',
    );
    record.end = record.data + record.compressed;
    if (descriptor) {
      const wide = record.zip64 || compressed32 === NONE || size32 === NONE;
      const length = wide ? 20 : 12;
      check(record.end + length <= directoryOffset, 'ZIP_HEADER');
      const data = new Bin(
        await read(
          record.end,
          Math.min(length + 4, directoryOffset - record.end),
        ),
      );
      const matches = (offset: number) =>
        offset + length <= data.b.length &&
        data.u32(offset) === record.crc &&
        (wide
          ? data.d.getBigUint64(offset + 4, true) === BigInt(record.compressed)
          : data.u32(offset + 4) === record.compressed) &&
        (wide
          ? data.d.getBigUint64(offset + 12, true) === BigInt(record.size)
          : data.u32(offset + 8) === record.size);
      const unsigned = matches(0);
      const signed = data.u32(0) === 0x08074b50 && matches(4);
      check(unsigned || signed, 'ZIP_HEADER');
      record.end += length + (unsigned ? 0 : 4);
      check(record.end <= directoryOffset, 'ZIP_HEADER');
    }
    record.name = new Uint8Array();
    if ((recordIndex & 255) === 255)
      await checkpoint(
        'index',
        (recordIndex + 1) / records.length,
        record.path,
      );
  }
  const extents = records
    .slice()
    .sort((first, second) => first.local - second.local);
  for (let index = 1; index < extents.length; index++)
    check(extents[index].local >= extents[index - 1].end, 'ZIP_HEADER');
  async function prepare(record: ZipRecord): Promise<ByteSource> {
    current('inflate', 0, record.path);
    let crc = NONE;
    let produced = 0;
    if (record.method === 0) {
      for (let offset = 0; offset < record.size; offset += CHUNK) {
        const bytes = await read(
          record.data + offset,
          Math.min(CHUNK, record.size - offset),
        );
        crc = crc32(crc, bytes);
        produced += bytes.length;
        if ((offset & 0xfffff) === 0)
          await checkpoint('inflate', produced / record.size, record.path);
      }
      check((crc ^ NONE) >>> 0 === record.crc, 'ZIP_CRC');
      current('inflate', 1, record.path);
      return sliceSource(source, record.data, record.size);
    }
    const storage = options.createStorage
      ? await options.createStorage()
      : await defaultStorage(record.size);
    storages.add(storage);
    try {
      current('inflate', 0, record.path);
      let pending: Uint8Array[] = [];
      const stream = new Inflate((bytes) => {
        check(bytes.length <= record.size - produced, 'ZIP_SIZE');
        crc = crc32(crc, bytes);
        produced += bytes.length;
        if (bytes.length) pending.push(bytes);
      });
      const staging = new Uint8Array(CHUNK);
      let staged = 0;
      let sinceYield = 0;
      let producedAtYield = 0;
      for (let offset = 0; offset < record.compressed;) {
        const input = await read(
          record.data + offset,
          Math.min(CHUNK, record.compressed - offset),
        );
        for (let position = 0; position < input.length; position += 1024) {
          current('inflate', produced / Math.max(1, record.size), record.path);
          const length = Math.min(1024, input.length - position);
          try {
            stream.push(
              input.subarray(position, position + length),
              offset + position + length === record.compressed,
            );
          } catch (error) {
            if (error instanceof FormatError) throw error;
            throw new FormatError(
              'ZIP_DEFLATE',
              'Invalid or truncated compressed ZIP entry.',
            );
          }
          for (const bytes of pending) {
            for (let copied = 0; copied < bytes.length;) {
              const amount = Math.min(CHUNK - staged, bytes.length - copied);
              staging.set(bytes.subarray(copied, copied + amount), staged);
              copied += amount;
              staged += amount;
              if (staged === CHUNK) {
                await storage.write(staging);
                staged = 0;
                current(
                  'inflate',
                  produced / Math.max(1, record.size),
                  record.path,
                );
              }
            }
          }
          pending = [];
          sinceYield += length;
          if (
            sinceYield >= 1024 * 1024 ||
            produced - producedAtYield >= 1024 * 1024
          ) {
            sinceYield = 0;
            producedAtYield = produced;
            await checkpoint(
              'inflate',
              produced / Math.max(1, record.size),
              record.path,
            );
          }
        }
        offset += input.length;
      }
      check(produced === record.size, 'ZIP_SIZE');
      check((crc ^ NONE) >>> 0 === record.crc, 'ZIP_CRC');
      if (staged) await storage.write(staging.subarray(0, staged));
      current('inflate', 1, record.path);
      const result = await storage.finish();
      check(result.size === record.size, 'ZIP_SIZE');
      current('inflate', 1, record.path);
      return result;
    } catch (error) {
      try {
        await storage.dispose();
      } finally {
        storages.delete(storage);
      }
      throw error;
    }
  }
  const entries: ArchiveEntry[] = records.map((record) => {
    let prepared: Promise<ByteSource> | null = null;
    return {
      path: record.path,
      kind: record.directory ? 'directory' : 'file',
      size: record.size,
      source: {
        size: record.size,
        async read(offset, length) {
          bounds(record.size, offset, length);
          check(length <= MAX_NAMES, 'READ_TOO_LARGE');
          checkCurrent();
          if (!length) return new Uint8Array();
          if (!prepared) {
            prepared = queue.then(() => prepare(record));
            queue = prepared.then(
              () => {},
              () => {},
            );
          }
          const input = await prepared;
          checkCurrent();
          const output = new Uint8Array(length);
          for (let position = 0; position < length; position += CHUNK) {
            const amount = Math.min(CHUNK, length - position);
            const bytes = await input.read(offset + position, amount);
            current();
            check(bytes.length === amount, 'TRUNCATED');
            output.set(bytes, position);
          }
          checkCurrent();
          return output;
        },
      },
    };
  });
  checkCurrent();
  return {
    format: 'ZIP',
    entries,
    dispose() {
      if (!disposal) {
        disposed = true;
        disposal = (async () => {
          await queue;
          const results = await Promise.allSettled(
            [...storages].map((storage) => storage.dispose()),
          );
          storages.clear();
          for (const result of results)
            if (result.status === 'rejected') throw result.reason;
        })();
      }
      return disposal;
    },
  };
}
