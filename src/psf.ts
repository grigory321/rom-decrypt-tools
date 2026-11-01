import type {
  ArchiveEntry,
  BlobInput,
  ByteSource,
  CompanionFile,
  PsfBundle,
  PsfEntry,
  ProgressReporter,
} from './contracts.js';
import {
  Bin,
  arraySource,
  blobSource,
  bounds,
  check,
  FormatError,
  sliceSource,
} from './binary.js';
import { Unzlib } from './vendor/fflate.mjs';

interface PsfBlobCompanion {
  blob: File;
  path?: string;
  name?: string;
  webkitRelativePath?: string;
}
type PsfCompanion = CompanionFile | PsfBlobCompanion;
interface ParsedPsf {
  input: ByteSource;
  name: string;
  version: number;
  program: Uint8Array;
  tags: Record<string, string>;
  reserved: ByteSource;
}
interface LoadedPsf {
  entry: PsfEntry | null;
  tags: Record<string, string>;
}
interface PsfStoredFile {
  path: string;
  source: ByteSource;
  size: number;
  kind: string;
}

function pathName(path: string): string {
  return path.slice(path.lastIndexOf('/') + 1);
}

const readSize = 65536;
const programLimit = 2 * 1024 ** 2 + 0x800;
const blockLimit = 1024 ** 2;
const crcTable = new Uint32Array(256);
for (let index = 0; index < crcTable.length; index++) {
  let value = index;
  for (let bit = 0; bit < 8; bit++)
    value = value & 1 ? 0xedb88320 ^ (value >>> 1) : value >>> 1;
  crcTable[index] = value >>> 0;
}

function safePath(value: string, parent = '') {
  check(
    typeof value === 'string' &&
      value.length > 0 &&
      value.length <= 4096 &&
      !/^[\\/]|[\x00-\x1f:]/.test(value),
    'PSF_PATH',
    value,
  );
  const parts = parent ? parent.split('/').slice(0, -1) : [];
  for (const part of value.replaceAll('\\', '/').split('/')) {
    if (!part || part === '.') continue;
    if (part === '..') {
      check(parts.length > 0, 'PSF_PATH', value);
      parts.pop();
    } else parts.push(part);
  }
  check(parts.length > 0, 'PSF_PATH', value);
  return parts.join('/');
}

function inputSource(input: PsfCompanion): ByteSource {
  if ('source' in input) return input.source;
  const file =
    'file' in input ? input.file : 'blob' in input ? input.blob : input;
  return 'read' in file ? file : blobSource(file);
}

function fileIndex(companions: PsfCompanion[]) {
  const paths = new Map<string, PsfCompanion | null>();
  const names = new Map<string, PsfCompanion | null>();
  let characters = 0;
  check(companions.length <= 200000, 'PSF_LIMIT');
  for (const input of companions) {
    const file =
      'file' in input ? input.file : 'blob' in input ? input.blob : input;
    const raw =
      ('path' in input ? input.path : undefined) ||
      ('webkitRelativePath' in input ? input.webkitRelativePath : undefined) ||
      ('webkitRelativePath' in file ? file.webkitRelativePath : undefined) ||
      input.name ||
      ('name' in file ? file.name : undefined);
    if (!raw) continue;
    const path = safePath(raw).toLowerCase();
    characters += path.length;
    check(characters <= 16 * 1024 ** 2, 'PSF_LIMIT');
    const name = pathName(path);
    paths.set(path, paths.has(path) ? null : input);
    names.set(name, names.has(name) ? null : input);
  }
  return { paths, names };
}

function tagsFrom(bytes: Uint8Array): Record<string, string> {
  if (!bytes.length) return {};
  check(
    new Bin(bytes).str(0, Math.min(bytes.length, 5)) === '[TAG]',
    'INVALID_PSF',
  );
  const ascii = new TextDecoder('windows-1252').decode(bytes.subarray(5));
  const text = /(^|\n)utf8\s*=\s*1\s*(\r?\n|$)/i.test(ascii)
    ? new TextDecoder().decode(bytes.subarray(5))
    : ascii;
  const tags: Record<string, string> = {};
  Object.setPrototypeOf(tags, null);
  for (const line of text.split(/\r?\n/)) {
    const separator = line.indexOf('=');
    if (separator < 1) continue;
    const name = line.slice(0, separator).trim().toLowerCase();
    const value = line.slice(separator + 1).trim();
    check(name.length <= 256 && value.length <= 65536, 'PSF_LIMIT');
    if (name.startsWith('_lib'))
      check(tags[name] === undefined, 'INVALID_PSF', name);
    tags[name] =
      tags[name] && !name.startsWith('_') ? tags[name] + '\n' + value : value;
  }
  return tags;
}

export async function readPsf(
  input: ByteSource | BlobInput,
  filename: string,
  companions: PsfCompanion[] = [],
  report: ProgressReporter = () => {},
): Promise<PsfBundle> {
  const source = 'read' in input ? input : blobSource(input);
  const rootPath = safePath(filename);
  const index = fileIndex(companions);
  const parsed = new Map<string, ParsedPsf>();
  const active = new Set<string>();
  const programs: PsfBundle['programs'] = [];
  const entries: ArchiveEntry[] = [];
  const files = new Map<string, PsfStoredFile>();
  const blockCache = new Map<string, Uint8Array>();
  let rootVersion: number | undefined;
  let calls = 0;
  let layers = 0;
  let pathCharacters = 0;
  let fileCount = 0;
  let blockCount = 0;

  async function read(input: ByteSource, offset: number, length: number) {
    bounds(input.size, offset, length);
    check(length <= readSize, 'PSF_LIMIT');
    report({ phase: 'scan', value: null });
    const bytes = await input.read(offset, length);
    check(bytes instanceof Uint8Array && bytes.length === length, 'BOUNDS');
    if ((++calls & 31) === 0)
      await new Promise<void>((resolve) => setTimeout(resolve, 0));
    return bytes;
  }

  async function region(input: ByteSource, offset: number, length: number) {
    check(length <= 1024 ** 2, 'PSF_LIMIT');
    const bytes = new Uint8Array(length);
    for (let position = 0; position < length; position += readSize)
      bytes.set(
        await read(
          input,
          offset + position,
          Math.min(readSize, length - position),
        ),
        position,
      );
    return bytes;
  }

  async function inflate(
    input: ByteSource,
    maximum: number,
    expected: number | null = null,
  ) {
    check(input.size >= 6 && input.size <= 16 * 1024 ** 2, 'PSF_ZLIB');
    const chunks: Uint8Array[] = [];
    let length = 0;
    let first = 1;
    let second = 0;
    const stream = new Unzlib((chunk) => {
      check(length + chunk.length <= maximum, 'PSF_LIMIT');
      chunks.push(chunk.slice());
      length += chunk.length;
      for (let offset = 0; offset < chunk.length; offset++) {
        first += chunk[offset];
        second += first;
        if ((offset & 4095) === 4095) {
          first %= 65521;
          second %= 65521;
        }
      }
      first %= 65521;
      second %= 65521;
    });
    for (let offset = 0; offset < input.size; offset += 1024) {
      const bytes = await read(
        input,
        offset,
        Math.min(1024, input.size - offset),
      );
      try {
        stream.push(bytes, offset + bytes.length === input.size);
      } catch (error) {
        if (error instanceof FormatError && error.code === 'PSF_LIMIT')
          throw error;
        check(false, 'PSF_ZLIB');
      }
    }
    const checksum = new Bin(await read(input, input.size - 4, 4)).u32(
      0,
      false,
    );
    check(((second << 16) | first) >>> 0 === checksum, 'PSF_ZLIB');
    check(expected === null || length === expected, 'PSF_FILESYSTEM');
    const output = new Uint8Array(length);
    let offset = 0;
    for (const chunk of chunks) {
      output.set(chunk, offset);
      offset += chunk.length;
    }
    return output;
  }

  async function parse(input: ByteSource, path: string): Promise<ParsedPsf> {
    const key = path.toLowerCase();
    const cached = parsed.get(key);
    if (cached) return cached;
    check(input.size >= 16, 'INVALID_PSF', path);
    const header = new Bin(await read(input, 0, 16));
    check(
      header.str(0, 3) === 'PSF' && [1, 2].includes(header.u8(3)),
      'INVALID_PSF',
      path,
    );
    const version = header.u8(3);
    if (rootVersion === undefined) rootVersion = version;
    check(version === rootVersion, 'INVALID_PSF', path);
    const reservedSize = header.u32(4);
    const compressedSize = header.u32(8);
    const compressedOffset = 16 + reservedSize;
    bounds(input.size, 16, reservedSize);
    bounds(input.size, compressedOffset, compressedSize);
    let crc = 0xffffffff;
    for (let offset = 0; offset < compressedSize; offset += readSize) {
      const bytes = await read(
        input,
        compressedOffset + offset,
        Math.min(readSize, compressedSize - offset),
      );
      for (const byte of bytes)
        crc = crcTable[(crc ^ byte) & 255] ^ (crc >>> 8);
    }
    check((crc ^ 0xffffffff) >>> 0 === header.u32(12), 'PSF_CRC', path);
    const program = compressedSize
      ? await inflate(
          sliceSource(input, compressedOffset, compressedSize),
          version === 1 ? programLimit : 8 * 1024 ** 2,
        )
      : new Uint8Array();
    if (version === 1 && program.length)
      check(
        program.length >= 0x800 && new Bin(program).str(0, 8) === 'PS-X EXE',
        'PSF_EXECUTABLE',
        path,
      );
    const tagOffset = compressedOffset + compressedSize;
    const tags = tagsFrom(
      await region(input, tagOffset, input.size - tagOffset),
    );
    check(
      version === 2 || program.length > 0 || tags._lib,
      'PSF_EXECUTABLE',
      path,
    );
    const result = {
      input,
      name: path,
      version,
      program,
      tags,
      reserved: sliceSource(input, 16, reservedSize),
    };
    parsed.set(key, result);
    return result;
  }

  async function filesystem(reserved: ByteSource) {
    if (reserved.size === 0) return;
    check(reserved.size >= 4, 'PSF_FILESYSTEM');
    const directories = new Set<number>();
    const localNames = new Set<string>();
    async function walk(
      offset: number,
      parent: string,
      depth: number,
    ): Promise<void> {
      check(depth <= 32 && !directories.has(offset), 'PSF_FILESYSTEM');
      directories.add(offset);
      const count = new Bin(await read(reserved, offset, 4)).u32(0);
      check(count <= 200000 - fileCount, 'PSF_LIMIT');
      bounds(reserved.size, offset + 4, count * 48);
      for (let first = 0; first < count; first += 1024) {
        const records = new Bin(
          await read(
            reserved,
            offset + 4 + first * 48,
            Math.min(1024, count - first) * 48,
          ),
        );
        for (let index = 0; index < Math.min(1024, count - first); index++) {
          const position = index * 48;
          const rawName = new TextDecoder()
            .decode(records.b.subarray(position, position + 36))
            .replace(/\0.*$/, '');
          check(
            rawName.length > 0 &&
              rawName !== '.' &&
              rawName !== '..' &&
              !/[\\/\x00-\x1f:]/.test(rawName),
            'PSF_FILESYSTEM',
          );
          const path = parent + rawName;
          const key = path.toLowerCase();
          pathCharacters += path.length;
          check(
            ++fileCount <= 200000 &&
              path.length <= 4096 &&
              pathCharacters <= 16 * 1024 ** 2,
            'PSF_LIMIT',
          );
          check(!localNames.has(key), 'PSF_FILESYSTEM', path);
          localNames.add(key);
          const dataOffset = records.u32(position + 36);
          const size = records.u32(position + 40);
          const blockSize = records.u32(position + 44);
          if (size === 0 && blockSize === 0 && dataOffset !== 0) {
            await walk(dataOffset, path + '/', depth + 1);
            continue;
          }
          check(
            size === 0 || (blockSize > 0 && blockSize <= blockLimit),
            'PSF_FILESYSTEM',
          );
          const totalBlocks = size ? Math.ceil(size / blockSize) : 0;
          blockCount += totalBlocks;
          check(blockCount <= 200000, 'PSF_LIMIT');
          bounds(reserved.size, dataOffset, totalBlocks * 4);
          const blocks: { offset: number; size: number }[] = [];
          let cursor = dataOffset + totalBlocks * 4;
          for (
            let firstBlock = 0;
            firstBlock < totalBlocks;
            firstBlock += 16384
          ) {
            const table = new Bin(
              await read(
                reserved,
                dataOffset + firstBlock * 4,
                Math.min(16384, totalBlocks - firstBlock) * 4,
              ),
            );
            for (
              let block = 0;
              block < Math.min(16384, totalBlocks - firstBlock);
              block++
            ) {
              const compressed = table.u32(block * 4);
              check(
                compressed >= 6 && compressed <= 2 * blockLimit,
                'PSF_FILESYSTEM',
              );
              bounds(reserved.size, cursor, compressed);
              blocks.push({ offset: cursor, size: compressed });
              cursor += compressed;
            }
          }
          const identity = fileCount;
          const fileSource: ByteSource = {
            size,
            async read(offset, length) {
              bounds(size, offset, length);
              check(length <= 16 * 1024 ** 2, 'PSF_LIMIT');
              const output = new Uint8Array(length);
              let copied = 0;
              while (copied < length) {
                const blockIndex = Math.floor((offset + copied) / blockSize);
                const cacheKey = identity + ':' + blockIndex;
                let bytes = blockCache.get(cacheKey);
                if (bytes) blockCache.delete(cacheKey);
                else {
                  const block = blocks[blockIndex];
                  bytes = await inflate(
                    sliceSource(reserved, block.offset, block.size),
                    blockLimit,
                    Math.min(blockSize, size - blockIndex * blockSize),
                  );
                }
                blockCache.set(cacheKey, bytes);
                while (blockCache.size > 4) {
                  const oldest = blockCache.keys().next();
                  if (!oldest.done) blockCache.delete(oldest.value);
                }
                const within = (offset + copied) % blockSize;
                const count = Math.min(bytes.length - within, length - copied);
                output.set(bytes.subarray(within, within + count), copied);
                copied += count;
              }
              return output;
            },
          };
          files.set(key, { path, source: fileSource, size, kind: 'file' });
        }
      }
    }
    await walk(0, '', 0);
  }

  async function load(
    input: ByteSource,
    path: string,
    depth: number,
  ): Promise<LoadedPsf> {
    const key = path.toLowerCase();
    check(depth <= 16 && ++layers <= 64, 'PSF_LIMIT');
    check(!active.has(key), 'PSF_LIB_CYCLE', path);
    active.add(key);
    const value = await parse(input, path);
    async function library(reference: string): Promise<LoadedPsf> {
      const requested = safePath(reference, path);
      const requestedKey = requested.toLowerCase();
      let match: PsfCompanion | null | undefined;
      if (index.paths.has(requestedKey)) match = index.paths.get(requestedKey);
      else match = index.names.get(pathName(requestedKey));
      check(match !== null, 'PSF_AMBIGUOUS_LIB', reference);
      check(match, 'PSF_MISSING_LIB', reference);
      return load(inputSource(match), requested, depth + 1);
    }
    const base = value.tags._lib ? await library(value.tags._lib) : null;
    const item =
      String(entries.length).padStart(3, '0') +
      '_' +
      pathName(path).replace(/[<>:"\\|?*]/g, '_');
    entries.push({
      path: 'psf/containers/' + item + '/header.bin',
      kind: 'metadata',
      source: sliceSource(input, 0, 16),
      size: 16,
    });
    if (value.reserved.size && value.version === 1)
      entries.push({
        path: 'psf/containers/' + item + '/reserved.bin',
        kind: 'file',
        source: value.reserved,
        size: value.reserved.size,
      });
    if (value.version === 1 && value.program.length) {
      programs.push({ name: path, bytes: value.program });
      entries.push({
        path: 'psf/programs/' + item + '.exe',
        kind: 'code',
        source: arraySource(value.program),
        size: value.program.length,
      });
    } else if (value.version === 2) await filesystem(value.reserved);
    const header =
      value.version === 1 && value.program.length
        ? new Bin(value.program)
        : null;
    const ownEntry = header
      ? {
          pc: header.u32(0x10),
          gp: header.u32(0x14),
          sp: (header.u32(0x30) + header.u32(0x34)) >>> 0,
        }
      : null;
    const entry =
      rootVersion === 1
        ? {
            pc: base?.entry?.pc || ownEntry?.pc || 0,
            sp: base?.entry?.sp || ownEntry?.sp || 0,
            gp: ownEntry?.gp || base?.entry?.gp || 0,
          }
        : null;
    for (let number = 2; number <= 64; number++) {
      const reference = value.tags['_lib' + number];
      if (!reference) break;
      await library(reference);
    }
    active.delete(key);
    return { entry, tags: { ...base?.tags, ...value.tags } };
  }

  const result = await load(source, rootPath, 0);
  if (rootVersion === 2)
    for (const file of files.values())
      entries.push({ ...file, path: 'psf2/' + file.path });
  const dependencies = [...parsed.values()].map((file) => ({
    name: file.name,
    source: file.input,
    size: file.input.size,
  }));
  return {
    format: rootVersion === 1 ? 'PSF' : 'PSF2',
    name: rootPath,
    tags: result.tags,
    entry: result.entry,
    programs,
    files: [...files.values()],
    entries,
    dependencies,
  };
}
