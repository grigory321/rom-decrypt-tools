import type { ByteSource, ArchiveEntry } from './contracts.js';
import { bounds, check } from './binary.js';

interface ZipEntry {
  name: Uint8Array;
  parts?: string[];
  clean?: string;
  size: number;
  source: ByteSource;
  directory: boolean;
  offset: number;
  crc: number;
}

const CHUNK = 256 * 1024;
const MAX_READ = 4 * 1024 * 1024;
const NONE = 0xffffffff;
const encoder = new TextEncoder();
const decoder = new TextDecoder();
const crcTable = Uint32Array.from({ length: 256 }, (_, value) => {
  for (let bit = 0; bit < 8; bit++) {
    value = value & 1 ? 0xedb88320 ^ (value >>> 1) : value >>> 1;
  }
  return value >>> 0;
});

function crc32(crc: number, bytes: Uint8Array) {
  for (let index = 0; index < bytes.length; index++)
    crc = crcTable[(crc ^ bytes[index]) & 255] ^ (crc >>> 8);
  return crc >>> 0;
}

function record(length: number) {
  const bytes = new Uint8Array(length),
    view = new DataView(bytes.buffer);
  return {
    bytes,
    u16: (offset: number, value: number) => view.setUint16(offset, value, true),
    u32: (offset: number, value: number) => view.setUint32(offset, value, true),
    u64: (offset: number, value: number) =>
      view.setBigUint64(offset, BigInt(value), true),
  };
}

function local(entry: ZipEntry) {
  const r = record(50 + entry.name.length),
    extra = 30 + entry.name.length;
  r.u32(0, 0x04034b50);
  r.u16(4, 45);
  r.u16(6, 0x0808);
  r.u16(12, 33);
  r.u32(18, NONE);
  r.u32(22, NONE);
  r.u16(26, entry.name.length);
  r.u16(28, 20);
  r.bytes.set(entry.name, 30);
  r.u16(extra, 1);
  r.u16(extra + 2, 16);
  r.u64(extra + 4, entry.size);
  r.u64(extra + 12, entry.size);
  return r.bytes;
}

function descriptor(entry: ZipEntry) {
  const r = record(24);
  r.u32(0, 0x08074b50);
  r.u32(4, entry.crc);
  r.u64(8, entry.size);
  r.u64(16, entry.size);
  return r.bytes;
}

function central(entry: ZipEntry) {
  const r = record(74 + entry.name.length),
    extra = 46 + entry.name.length;
  r.u32(0, 0x02014b50);
  r.u16(4, 45);
  r.u16(6, 45);
  r.u16(8, 0x0808);
  r.u16(14, 33);
  r.u32(16, entry.crc);
  r.u32(20, NONE);
  r.u32(24, NONE);
  r.u16(28, entry.name.length);
  r.u16(30, 28);
  r.u32(38, entry.directory ? 16 : 0);
  r.u32(42, NONE);
  r.bytes.set(entry.name, 46);
  r.u16(extra, 1);
  r.u16(extra + 2, 24);
  r.u64(extra + 4, entry.size);
  r.u64(extra + 12, entry.size);
  r.u64(extra + 20, entry.offset);
  return r.bytes;
}

function ending(count: number, directoryOffset: number, directorySize: number) {
  const r = record(98);
  r.u32(0, 0x06064b50);
  r.u64(4, 44);
  r.u16(12, 45);
  r.u16(14, 45);
  r.u64(24, count);
  r.u64(32, count);
  r.u64(40, directorySize);
  r.u64(48, directoryOffset);
  r.u32(56, 0x07064b50);
  r.u64(64, directoryOffset + directorySize);
  r.u32(72, 1);
  r.u32(76, 0x06054b50);
  r.u16(84, 0xffff);
  r.u16(86, 0xffff);
  r.u32(88, NONE);
  r.u32(92, NONE);
  return r.bytes;
}

function validPath(path: string, directory: boolean) {
  check(
    typeof path === 'string' && path.length > 0 && path.length <= 4096,
    'UNSAFE_NAME',
  );
  check(directory === path.endsWith('/'), 'UNSAFE_NAME');
  const clean = directory ? path.slice(0, -1) : path,
    parts = clean.split('/');
  for (const part of parts) {
    check(
      part &&
        part !== '.' &&
        part !== '..' &&
        !/[<>:"\\|?*\x00-\x1f\x7f]/.test(part) &&
        !/[. ]$/.test(part),
      'UNSAFE_NAME',
    );
  }
  const name = encoder.encode(path);
  check(name.length <= 65535 && decoder.decode(name) === path, 'UNSAFE_NAME');
  return { clean, name, parts };
}

export function createZipSource(
  entries: ArchiveEntry[],
  { checkCurrent = () => {} }: { checkCurrent?: () => boolean | void } = {},
): ByteSource {
  check(Array.isArray(entries) && entries.length <= 200000, 'TOO_MANY');
  const files: ZipEntry[] = [],
    paths = new Map<string, boolean>();
  let offset = 0,
    directorySize = 0,
    pathBytes = 0;
  function current() {
    check(checkCurrent() !== false, 'CANCELLED');
  }
  current();
  for (const entry of entries) {
    const directory = entry.kind === 'directory',
      { clean, name, parts } = validPath(entry.path, directory),
      size = entry.size;
    pathBytes += name.length;
    check(pathBytes <= 16 * 1024 * 1024, 'TOO_LARGE');
    check(!paths.has(clean), 'DUPLICATE_PATH');
    check(
      Number.isSafeInteger(size) &&
        size >= 0 &&
        size === entry.source?.size &&
        typeof entry.source?.read === 'function' &&
        (!directory || size === 0),
      'INVALID',
    );
    const file = {
      name,
      parts,
      clean,
      size,
      source: entry.source,
      directory,
      offset,
      crc: 0,
    };
    files.push(file);
    paths.set(clean, directory);
    offset += 50 + name.length + size + 24;
    directorySize += 74 + name.length;
    check(
      Number.isSafeInteger(offset) &&
        Number.isSafeInteger(offset + directorySize + 98),
      'TOO_LARGE',
    );
  }
  for (const file of files) {
    let parent = '';
    const parts = file.parts;
    check(parts, 'UNSAFE_NAME');
    for (let i = 0; i < parts.length - 1; i++) {
      parent += (i ? '/' : '') + parts[i];
      check(paths.get(parent) !== false, 'DUPLICATE_PATH');
    }
    delete file.parts;
    delete file.clean;
  }
  const directoryOffset = offset,
    size = directoryOffset + directorySize + 98;
  async function* generate() {
    let sinceYield = 0,
      completed = 0;
    for (const file of files) {
      current();
      yield local(file);
      let crc = NONE;
      for (let position = 0; position < file.size;) {
        current();
        const length = Math.min(CHUNK, file.size - position),
          bytes = await file.source.read(position, length);
        current();
        check(bytes instanceof Uint8Array && bytes.length === length, 'BOUNDS');
        crc = crc32(crc, bytes);
        position += length;
        sinceYield += length;
        yield bytes;
        if (sinceYield >= 1024 * 1024) {
          sinceYield = 0;
          await new Promise((resolve) => setTimeout(resolve, 0));
          current();
        }
      }
      file.crc = (crc ^ NONE) >>> 0;
      yield descriptor(file);
      if ((++completed & 255) === 0) {
        await new Promise((resolve) => setTimeout(resolve, 0));
        current();
      }
    }
    for (let i = 0; i < files.length; i++) {
      current();
      yield central(files[i]);
      if ((i & 255) === 255)
        await new Promise((resolve) => setTimeout(resolve, 0));
    }
    current();
    yield ending(files.length, directoryOffset, directorySize);
  }
  const iterator = generate();
  let position = 0,
    pending: Uint8Array = new Uint8Array(),
    pendingOffset = 0,
    reading = false,
    failure: unknown;
  return {
    size,
    async read(offset, length) {
      current();
      if (failure) throw failure;
      bounds(size, offset, length);
      check(length <= MAX_READ, 'TOO_LARGE');
      check(!reading && offset === position, 'ZIP_SEQUENCE');
      reading = true;
      try {
        const output = new Uint8Array(length);
        let copied = 0;
        while (copied < length) {
          current();
          if (pendingOffset === pending.length) {
            const next = await iterator.next();
            current();
            check(!next.done, 'BOUNDS');
            pending = next.value;
            pendingOffset = 0;
          }
          const count = Math.min(
            length - copied,
            pending.length - pendingOffset,
          );
          output.set(
            pending.subarray(pendingOffset, pendingOffset + count),
            copied,
          );
          pendingOffset += count;
          copied += count;
        }
        current();
        position += length;
        return output;
      } catch (error) {
        failure = error;
        throw error;
      } finally {
        reading = false;
      }
    },
  };
}
