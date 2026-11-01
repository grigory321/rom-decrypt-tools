import type {
  ByteSource,
  ProgressReporter,
  Archive,
  ArchiveEntry,
} from './contracts.js';
import { Bin, bounds, check, sliceSource, blobSource } from './binary.js';
import { inspectDsiModcrypt } from './dsi-modcrypt.js';

const empty = blobSource(new Blob());

function filename(bytes: Uint8Array) {
  const name = String.fromCharCode(...bytes);
  check(
    name.length > 0 &&
      name !== '.' &&
      name !== '..' &&
      !/[<>:"/\\|?*\x00-\x1f\x7f]/.test(name) &&
      !/[. ]$/.test(name),
    'UNSAFE_NAME',
  );
  return name;
}

export async function openNdsContents(
  source: ByteSource,
  report: ProgressReporter = () => {},
): Promise<Archive> {
  bounds(source.size, 0, 512);
  const initialHeader = await source.read(0, 512);
  const dsi =
    initialHeader[0x12] & 2
      ? await inspectDsiModcrypt(source, () =>
          report({ phase: 'decrypt', value: null }),
        )
      : null;
  if (dsi) source = dsi.source;
  const header = new Bin(dsi ? await source.read(0, 512) : initialHeader),
    headerSize = header.u32(0x84) || (dsi ? 4096 : 512),
    fntOffset = header.u32(0x40),
    fntSize = header.u32(0x44),
    fatOffset = header.u32(0x48),
    fatSize = header.u32(0x4c),
    entries: ArchiveEntry[] = [],
    paths = new Set<string>();
  check(headerSize >= 512 && headerSize <= 1024 * 1024, 'INVALID_NDS');
  check(fatSize % 8 === 0 && fatSize <= 65536 * 8, 'INVALID_NDS');
  check(fntSize <= 16 * 1024 * 1024, 'INVALID_NDS');
  bounds(source.size, 0, headerSize);
  bounds(source.size, fntOffset, fntSize);
  bounds(source.size, fatOffset, fatSize);
  let pathCharacters = 0;
  function add(path: string, kind: string, file: ByteSource) {
    check(entries.length < 200000, 'TOO_MANY');
    pathCharacters += path.length;
    check(
      path.length <= 4096 && pathCharacters <= 16 * 1024 * 1024,
      'TOO_LARGE',
    );
    check(!paths.has(path), 'DUPLICATE_PATH');
    paths.add(path);
    entries.push({ path, kind, size: file.size, source: file });
  }
  let examined = 0;
  async function progress() {
    if ((++examined & 255) === 0) {
      report({ phase: 'index', value: null, count: entries.length });
      await new Promise((resolve) => setTimeout(resolve, 0));
    }
  }
  add('nds/header.bin', 'metadata', sliceSource(source, 0, headerSize));
  for (const [name, offset] of [
    ['arm9', 0x20],
    ['arm7', 0x30],
  ] as const) {
    add(
      'nds/' + name + '.bin',
      'code',
      sliceSource(source, header.u32(offset), header.u32(offset + 12)),
    );
  }
  if (dsi) {
    for (const [name, offset] of [
      ['arm9i', 0x1c0],
      ['arm7i', 0x1d0],
    ] as const) {
      const size = header.u32(offset + 12);
      if (size)
        add(
          'nds/' + name + '.bin',
          'code',
          sliceSource(source, header.u32(offset), size),
        );
    }
  }
  add('nds/fnt.bin', 'metadata', sliceSource(source, fntOffset, fntSize));
  add('nds/fat.bin', 'metadata', sliceSource(source, fatOffset, fatSize));
  const fat = new Bin(await source.read(fatOffset, fatSize)),
    files: ByteSource[] = [];
  for (let id = 0; id < fatSize / 8; id++) {
    const start = fat.u32(id * 8),
      end = fat.u32(id * 8 + 4);
    check(end >= start, 'INVALID_NDS');
    files.push(sliceSource(source, start, end - start));
    await progress();
  }
  for (const [name, offset] of [
    ['arm9', 0x50],
    ['arm7', 0x58],
  ] as const) {
    const tableOffset = header.u32(offset),
      tableSize = header.u32(offset + 4);
    check(tableSize % 32 === 0 && tableSize <= 65536 * 32, 'INVALID_NDS');
    const tableSource = sliceSource(source, tableOffset, tableSize);
    add('nds/' + name + '-overlay-table.bin', 'metadata', tableSource);
    const table = new Bin(await tableSource.read(0, tableSize)),
      ids = new Set<number>();
    for (let row = 0; row < tableSize; row += 32) {
      const id = table.u32(row),
        file = table.u32(row + 24);
      check(file < files.length && !ids.has(id), 'INVALID_NDS');
      ids.add(id);
      add(
        'nds/overlays/' +
          name +
          '/overlay_' +
          id.toString(16).padStart(8, '0') +
          '.bin',
        'code',
        files[file],
      );
      await progress();
    }
  }
  const bannerOffset = header.u32(0x68);
  if (bannerOffset) {
    const version = new Bin(await source.read(bannerOffset, 2)).u16(0),
      bannerSize = new Map<number, number>([
        [1, 0x840],
        [2, 0x940],
        [3, 0xa40],
        [0x103, 0x23c0],
      ]).get(version);
    check(bannerSize, 'INVALID_NDS');
    add(
      'nds/banner.bin',
      'metadata',
      sliceSource(source, bannerOffset, bannerSize),
    );
  }
  const names = new Set<number>();
  if (fntSize) {
    check(fntSize >= 8, 'INVALID_NDS');
    const fnt = new Bin(await source.read(fntOffset, fntSize)),
      directoryCount = fnt.u16(6),
      seen = new Set<number>(),
      ranges: [number, number][] = [];
    check(directoryCount > 0 && directoryCount <= 4096, 'INVALID_NDS');
    fnt.range(0, directoryCount * 8);
    async function walk(
      id: number,
      parent: number,
      path: string,
      depth: number,
    ): Promise<void> {
      check(
        id >= 0xf000 &&
          id < 0xf000 + directoryCount &&
          !seen.has(id) &&
          depth <= 64,
        'INVALID_NDS',
      );
      seen.add(id);
      const row = (id - 0xf000) * 8;
      check(id === 0xf000 || fnt.u16(row + 6) === parent, 'INVALID_NDS');
      let position = fnt.u32(row),
        file = fnt.u16(row + 4);
      const start = position,
        ownNames = new Set<string>();
      check(
        position >= directoryCount * 8 && file <= files.length,
        'INVALID_NDS',
      );
      add(path, 'directory', empty);
      while (true) {
        const type = fnt.u8(position++);
        if (!type) break;
        const length = type & 127,
          name = filename(fnt.slice(position, length));
        position += length;
        check(!ownNames.has(name), 'DUPLICATE_PATH');
        ownNames.add(name);
        if (type & 128) {
          const child = fnt.u16(position);
          position += 2;
          await walk(child, id, path + name + '/', depth + 1);
        } else {
          check(file < files.length && !names.has(file), 'INVALID_NDS');
          add(path + name, 'nitrofs', files[file]);
          names.add(file++);
        }
        await progress();
      }
      ranges.push([start, position]);
    }
    await walk(0xf000, 0xf000, 'nds/nitrofs/', 0);
    check(seen.size === directoryCount, 'INVALID_NDS');
    ranges.sort((a, b) => a[0] - b[0]);
    for (let i = 1; i < ranges.length; i++) {
      check(ranges[i][0] >= ranges[i - 1][1], 'INVALID_NDS');
    }
  }
  for (let id = 0; id < files.length; id++) {
    if (!names.has(id)) {
      add(
        'nds/unnamed/file_' + id.toString(16).padStart(4, '0') + '.bin',
        'nitrofs',
        files[id],
      );
    }
    await progress();
  }
  report({ phase: 'index', value: 1, count: entries.length });
  return { format: dsi ? 'DSi' : 'NDS', entries };
}
