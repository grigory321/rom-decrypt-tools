import type {
  ByteSource,
  SourceInput,
  CompanionFile,
  ProgressReporter,
  ArchiveEntry,
  KeySet,
} from './contracts.js';
import { asSource } from './source-input.js';
import type { NcchContent } from './conversion.js';
import type { CodeCache } from './code-compression.js';
import {
  Bin,
  blobSource,
  sliceSource,
  bounds,
  check,
  align,
} from './binary.js';
import { inspectRom, decryptRomContents } from './conversion.js';
import { automaticKeys } from './defaults.js';
import { codeCache, decompressedCode } from './code-compression.js';
import { openNdsContents } from './nds-contents.js';

type AddEntry = (path: string, kind: string, source: ByteSource) => void;

const NONE = 4294967295;

const empty = blobSource(new Blob());

function safeName(name: string) {
  check(
    name.length > 0 && name !== '.' && name !== '..' && !/[\/\\\0]/.test(name),
    'UNSAFE_NAME',
  );
  return name;
}

function metadataName(table: Bin, offset: number, length: number): string {
  check(length <= 2048 && length % 2 === 0, 'INVALID_ROMFS');
  const bytes = table.slice(offset, length);
  try {
    return new TextDecoder('utf-16le', { fatal: true }).decode(bytes);
  } catch {
    check(false, 'INVALID_ROMFS');
  }
}

function disjoint(ranges: [number, number][]) {
  ranges.sort((a, b) => a[0] - b[0]);
  let end = 0;
  for (const [start, size] of ranges) {
    check(start >= end, 'INVALID_ROMFS');
    end = start + size;
  }
}

async function readRomfs(
  source: ByteSource,
  path: string,
  add: AddEntry,
  report: ProgressReporter,
) {
  const ivfc = new Bin(await source.read(0, 96)),
    level = align(96 + ivfc.u32(8), 2 ** ivfc.u32(76)),
    levelSize = ivfc.u64(68),
    h = new Bin(await source.read(level, 40));
  check(h.u32(0) === 40, 'INVALID_ROMFS');
  const dirOffset = h.u32(12),
    dirSize = h.u32(16),
    fileOffset = h.u32(28),
    fileSize = h.u32(32),
    dataOffset = h.u32(36);
  check(
    dirSize <= 16 * 1024 * 1024 && fileSize <= 32 * 1024 * 1024,
    'TOO_LARGE',
  );
  const tables: [number, number][] = [
    [h.u32(4), h.u32(8)],
    [dirOffset, dirSize],
    [h.u32(20), h.u32(24)],
    [fileOffset, fileSize],
  ];
  for (const [offset, size] of tables) {
    check(offset >= 40, 'INVALID_ROMFS');
    bounds(levelSize, offset, size);
    check(offset + size <= dataOffset, 'INVALID_ROMFS');
  }
  disjoint(tables.filter((entry) => entry[1] > 0));
  bounds(levelSize, dataOffset, 0);
  const dirs = new Bin(await source.read(level + dirOffset, dirSize)),
    files = new Bin(await source.read(level + fileOffset, fileSize)),
    seenDirs = new Set<number>(),
    seenFiles = new Set<number>(),
    dirRanges: [number, number][] = [],
    fileRanges: [number, number][] = [];
  let count = 0;
  async function progress() {
    if ((++count & 255) === 0) {
      report({ phase: 'index', value: null, count: count });
      await new Promise((resolve) => setTimeout(resolve, 0));
    }
  }
  async function walk(
    offset: number,
    prefix: string,
    parent: number,
    depth: number,
  ): Promise<void> {
    check(
      depth <= 64 && offset % 4 === 0 && !seenDirs.has(offset),
      'INVALID_ROMFS',
    );
    seenDirs.add(offset);
    check(seenDirs.size <= 100000, 'TOO_MANY');
    dirs.range(offset, 24);
    const nameLength = dirs.u32(offset + 20),
      own = metadataName(dirs, offset + 24, nameLength),
      expectedParent = dirs.u32(offset);
    check(
      offset === 0
        ? !own && [0, NONE].includes(expectedParent) && dirs.u32(4) === NONE
        : expectedParent === parent,
      'INVALID_ROMFS',
    );
    dirRanges.push([offset, align(24 + nameLength, 4)]);
    const current = prefix + (offset === 0 ? '' : safeName(own) + '/');
    add(current, 'directory', empty);
    await progress();
    let file = dirs.u32(offset + 12);
    while (file !== NONE) {
      check(file % 4 === 0 && !seenFiles.has(file), 'INVALID_ROMFS');
      seenFiles.add(file);
      check(seenFiles.size <= 100000, 'TOO_MANY');
      files.range(file, 32);
      check(files.u32(file) === offset, 'INVALID_ROMFS');
      const nameLength = files.u32(file + 28),
        name = safeName(metadataName(files, file + 32, nameLength)),
        data = files.u64(file + 8),
        size = files.u64(file + 16);
      bounds(levelSize - dataOffset, data, size);
      fileRanges.push([file, align(32 + nameLength, 4)]);
      add(
        current + name,
        'romfs',
        sliceSource(source, level + dataOffset + data, size),
      );
      file = files.u32(file + 4);
      await progress();
    }
    let child = dirs.u32(offset + 8);
    while (child !== NONE) {
      await walk(child, current, offset, depth + 1);
      child = dirs.u32(child + 4);
    }
  }
  await walk(0, path + '/', 0, 0);
  disjoint(dirRanges);
  disjoint(fileRanges);
}

async function readNcch(
  content: NcchContent,
  path: string,
  add: AddEntry,
  cache: CodeCache,
  report: ProgressReporter,
) {
  const source = content.source,
    h = new Bin(await source.read(0, 512));
  add(path + '/ncch-header.bin', 'metadata', sliceSource(source, 0, 512));
  const exheaderSize = h.u32(384);
  if (exheaderSize) {
    add(path + '/exheader.bin', 'metadata', sliceSource(source, 512, 2048));
  }
  for (const [name, offset, size] of [
    ['logo', 408, 412],
    ['plain', 400, 404],
  ] as const) {
    if (h.u32(size)) {
      add(
        path + '/' + name + '.bin',
        'metadata',
        sliceSource(source, h.u32(offset) * 512, h.u32(size) * 512),
      );
    }
  }
  if (h.u32(420)) {
    const exefs = sliceSource(source, h.u32(416) * 512, h.u32(420) * 512),
      ex = new Bin(await exefs.read(0, 512));
    add(path + '/exefs/header.bin', 'metadata', sliceSource(exefs, 0, 512));
    for (let i = 0; i < 10; i++) {
      const raw = ex.slice(i * 16, 8),
        zero = raw.indexOf(0),
        length = zero === -1 ? 8 : zero;
      if (!length) {
        check(
          raw.every((v) => v === 0),
          'UNSAFE_NAME',
        );
        continue;
      }
      check(
        raw.subarray(length).every((v) => v === 0) &&
          raw.subarray(0, length).every((v) => v >= 32 && v <= 126),
        'UNSAFE_NAME',
      );
      const name = safeName(ex.str(i * 16, length)),
        file = sliceSource(
          exefs,
          512 + ex.u32(i * 16 + 8),
          ex.u32(i * 16 + 12),
        );
      add(
        path + '/exefs/' + name,
        name === '.code' ? 'code' : 'metadata',
        file,
      );
      if (
        name === '.code' &&
        exheaderSize &&
        (await source.read(525, 1))[0] & 1
      ) {
        add(
          path + '/exefs/code-decompressed.bin',
          'code',
          await decompressedCode(file, cache, report),
        );
      }
    }
  }
  if (h.u32(436)) {
    await readRomfs(
      sliceSource(source, h.u32(432) * 512, h.u32(436) * 512),
      path + '/romfs',
      add,
      report,
    );
  }
}

export async function openContents(
  blob: SourceInput,
  name: string,
  keys: KeySet | undefined,
  report: ProgressReporter = () => {},
  companions: CompanionFile[] = [],
  directory = false,
) {
  const { openPlatformContents, folderContents } =
    await import('./platform-files.js');
  if (directory) return folderContents([blob, ...companions]);
  const platform = await openPlatformContents(blob, name, companions, report);
  if (platform) return platform;
  if (/\.(nds|srl)$/i.test(name)) {
    return openNdsContents(asSource(blob), report);
  }
  keys ??= await automaticKeys();
  const info = await inspectRom(blob, name, keys),
    contents = await decryptRomContents(info, keys, report),
    entries: ArchiveEntry[] = [],
    paths = new Set<string>(),
    cache = codeCache();
  let pathCharacters = 0;
  const add = (path: string, kind: string, source: ByteSource) => {
    check(entries.length < 200000, 'TOO_MANY');
    pathCharacters += path.length;
    check(
      path.length <= 4096 && pathCharacters <= 16 * 1024 * 1024,
      'TOO_LARGE',
    );
    check(!paths.has(path), 'DUPLICATE_PATH');
    paths.add(path);
    entries.push({ path: path, size: source.size, kind: kind, source: source });
  };
  if (info.format === 'CIA') {
    for (const [name, bytes] of [
      ['header', info.header],
      ['certificates', info.certs],
      ['ticket', info.ticket],
      ['tmd', info.tmd],
      ['meta', info.meta],
    ] as const) {
      add('cia/' + name + '.bin', 'metadata', asSource(bytes));
    }
  } else if (info.format === 'NCSD') {
    add(
      'ncsd/header.bin',
      'metadata',
      sliceSource(info.source, 0, Math.min(16384, info.source.size)),
    );
  }
  for (const content of contents) {
    const path =
      'content_' +
      content.index.toString(16).padStart(4, '0') +
      '_' +
      content.id.toString(16).padStart(8, '0');
    add(
      path + (content.nonNcch ? '.bin' : '.ncch'),
      'container',
      content.source,
    );
    if (!content.nonNcch) {
      await readNcch(content, path, add, cache, report);
    }
  }
  report({ phase: 'index', value: 1, count: entries.length });
  return { format: info.format, titleId: info.titleId, entries: entries };
}
