import type {
  ByteSource,
  ProgressReporter,
  Archive,
  ArchiveEntry,
} from './contracts.js';
import { Bin, bounds, check, sliceSource } from './binary.js';
import type { RawSectorSize } from './disc-sources.js';
import { extentSource, rawSectorSource } from './disc-sources.js';

interface PhysicalDisc {
  source: ByteSource;
  sectorSize: RawSectorSize;
  expectedMode: number;
}

const sectorSize = 2048;
const empty: ByteSource = {
  size: 0,
  async read(offset, length) {
    bounds(0, offset, length);
    return new Uint8Array();
  },
};

function both16(bytes: Bin, offset: number) {
  const value = bytes.u16(offset);
  check(
    value === bytes.u16(offset + 2, false),
    'INVALID_ISO',
    'The ISO little-endian and big-endian values disagree.',
  );
  return value;
}

function both32(bytes: Bin, offset: number) {
  const value = bytes.u32(offset);
  check(
    value === bytes.u32(offset + 4, false),
    'INVALID_ISO',
    'The ISO little-endian and big-endian values disagree.',
  );
  return value;
}

function record(bytes: Uint8Array, volumeSize: number, joliet: number) {
  const data = new Bin(bytes);
  check(
    bytes.length >= 34 && data.u8(0) === bytes.length && bytes.length % 2 === 0,
    'INVALID_ISO',
  );
  const nameSize = data.u8(32);
  check(
    nameSize > 0 &&
      33 + nameSize + (nameSize % 2 === 0 ? 1 : 0) <= bytes.length,
    'INVALID_ISO',
  );
  if (nameSize % 2 === 0) {
    check(data.u8(33 + nameSize) === 0, 'INVALID_ISO');
  }
  const flags = data.u8(25);
  check(!(flags & 0x60), 'INVALID_ISO');
  check(!(flags & 4), 'UNSUPPORTED_ISO_ASSOCIATED_FILE');
  check(
    data.u8(26) === 0 && data.u8(27) === 0,
    'UNSUPPORTED_ISO_INTERLEAVE',
    'Interleaved ISO extents are not supported.',
  );
  check(both16(data, 28) === 1, 'UNSUPPORTED_ISO_VOLUME_SET');
  const block = both32(data, 2);
  const offset = (block + data.u8(1)) * sectorSize;
  const size = both32(data, 10);
  bounds(volumeSize, block * sectorSize, data.u8(1) * sectorSize + size);
  const directory = !!(flags & 2);
  check(
    !directory ||
      (!(flags & 0x88) && size >= sectorSize && size % sectorSize === 0),
    'INVALID_ISO',
  );
  const rawName = bytes.subarray(33, 33 + nameSize);
  let identifier: string | number;
  if (nameSize === 1 && rawName[0] <= 1) {
    check(directory, 'INVALID_ISO');
    identifier = rawName[0];
  } else if (joliet) {
    check(nameSize % 2 === 0, 'INVALID_ISO');
    identifier = '';
    for (let index = 0; index < nameSize; index += 2) {
      const code = rawName[index] * 256 + rawName[index + 1];
      check(code < 0xd800 || code > 0xdfff, 'UNSAFE_NAME');
      identifier += String.fromCharCode(code);
    }
  } else {
    check(
      rawName.every((value) => value >= 32 && value <= 126),
      'UNSAFE_NAME',
    );
    identifier = String.fromCharCode(...rawName);
  }
  let name = identifier;
  if (typeof name === 'string') {
    if (!directory) {
      name = name.replace(/;1$/, '').replace(/\.$/, '');
    }
    check(
      name.length > 0 &&
        name !== '.' &&
        name !== '..' &&
        !/[\/\\\x00-\x1f\x7f:]/.test(name),
      'UNSAFE_NAME',
    );
  }
  return { offset, size, directory, flags, identifier, name };
}

function volume(bytes: Uint8Array) {
  const data = new Bin(bytes);
  check(both16(data, 128) === sectorSize, 'UNSUPPORTED_ISO_BLOCK_SIZE');
  check(
    both16(data, 120) === 1 && both16(data, 124) === 1,
    'UNSUPPORTED_ISO_VOLUME_SET',
  );
  const size = both32(data, 80) * sectorSize;
  check(size >= 18 * sectorSize, 'INVALID_ISO');
  return size;
}

export async function readIso9660(
  source: ByteSource,
  prefix = 'iso/',
  report: ProgressReporter = () => {},
  physical?: PhysicalDisc,
): Promise<Archive> {
  let primary: Uint8Array | undefined;
  let supplementary: Uint8Array | undefined;
  let level = 0;
  let terminated = false;
  bounds(source.size, 16 * sectorSize, sectorSize);
  for (let index = 16; index < 144; index++) {
    const bytes = await source.read(index * sectorSize, sectorSize);
    const header = new Bin(bytes);
    check(
      header.str(1, 5) === 'CD001' && header.u8(6) === 1,
      'INVALID_ISO',
      'The ISO volume descriptor sequence is invalid.',
    );
    const type = header.u8(0);
    if (type === 255) {
      terminated = true;
      break;
    }
    check(type <= 3, 'INVALID_ISO');
    if (type === 1) {
      check(!primary, 'INVALID_ISO');
      primary = bytes;
    }
    if (type === 2 && header.u8(88) === 37 && header.u8(89) === 47) {
      const candidate = [64, 67, 69].indexOf(header.u8(90)) + 1;
      if (candidate > level) {
        check(header.u8(7) === 0, 'INVALID_ISO');
        supplementary = bytes;
        level = candidate;
      }
    }
  }
  check(terminated && primary, 'INVALID_ISO');
  const primarySize = volume(primary);
  const descriptor = supplementary || primary;
  const volumeSize = volume(descriptor);
  check(volumeSize === primarySize, 'INVALID_ISO');
  bounds(source.size, 0, volumeSize);
  const logical = sliceSource(source, 0, volumeSize);
  const rootLength = descriptor[156];
  const root = record(
    descriptor.subarray(156, 156 + rootLength),
    volumeSize,
    level,
  );
  check(root.identifier === 0 && root.directory, 'INVALID_ISO');
  const entries: ArchiveEntry[] = [];
  const paths = new Set<string>();
  const directories = new Set<number>();
  let records = 0;
  let metadataSize = 0;
  let pathSize = 0;
  function add(
    path: string,
    kind: string,
    source: ByteSource,
    format?: string,
    cdAudio?: ArchiveEntry['cdAudio'],
  ) {
    const canonical = path.replace(/\/$/, '');
    check(path.length <= 4096 && !paths.has(canonical), 'UNSAFE_NAME');
    check(entries.length < 100000, 'TOO_MANY');
    pathSize += path.length;
    check(
      pathSize <= 16 * 1024 * 1024,
      'TOO_LARGE',
      'The ISO expanded paths exceed the indexing limit.',
    );
    paths.add(canonical);
    entries.push({ path, kind, size: source.size, source, format, cdAudio });
  }
  async function addFile(
    path: string,
    extents: { offset: number; size: number }[],
  ) {
    let cdAudio: ArchiveEntry['cdAudio'];
    if (physical && extents[0].size) {
      const header = physical.sectorSize === 2352 ? 16 : 0;
      const bytes = await physical.source.read(
        (extents[0].offset / sectorSize) * physical.sectorSize,
        header + 8,
      );
      const audio = (bytes[header + 2] & 0x0e) === 4;
      if (!header || bytes[15] === 2) {
        const raw = extentSource(
          physical.source,
          extents.map((extent) => ({
            offset: (extent.offset / sectorSize) * physical.sectorSize,
            size: Math.ceil(extent.size / sectorSize) * physical.sectorSize,
          })),
        );
        cdAudio = { source: raw, sectorSize: physical.sectorSize };
        if (
          audio ||
          (physical.sectorSize === 2336 && bytes[header + 2] & 0x20)
        ) {
          add(
            path,
            'cd-sector',
            rawSectorSource(
              raw,
              physical.expectedMode,
              physical.sectorSize,
              true,
            ),
            audio
              ? physical.sectorSize === 2336
                ? 'XA2336'
                : 'XA'
              : `MODE2/${physical.sectorSize}`,
            cdAudio,
          );
          return;
        }
      }
    }
    add(path, 'iso9660', extentSource(logical, extents), undefined, cdAudio);
  }
  async function walk(
    directory: ReturnType<typeof record>,
    path: string,
    parent: ReturnType<typeof record>,
    depth: number,
  ): Promise<void> {
    check(
      depth <= 64 && !directories.has(directory.offset),
      'INVALID_ISO',
      'The ISO directory hierarchy contains a cycle or repeated directory extent.',
    );
    directories.add(directory.offset);
    metadataSize += directory.size;
    check(
      metadataSize <= 64 * 1024 * 1024,
      'TOO_LARGE',
      'The ISO directory metadata exceeds the indexing limit.',
    );
    add(path, 'directory', empty);
    let special = 0;
    let pending:
      | {
          identifier: string;
          name: string | number;
          flags: number;
          extents: ReturnType<typeof record>[];
        }
      | undefined;
    const children: ReturnType<typeof record>[] = [];
    for (let position = 0; position < directory.size; position += sectorSize) {
      const bytes = await logical.read(directory.offset + position, sectorSize);
      let cursor = 0;
      while (cursor < sectorSize) {
        const length = bytes[cursor];
        if (!length) {
          check(
            bytes.subarray(cursor).every((value) => value === 0),
            'INVALID_ISO',
          );
          break;
        }
        check(length <= sectorSize - cursor, 'INVALID_ISO');
        const item = record(
          bytes.subarray(cursor, cursor + length),
          volumeSize,
          level,
        );
        cursor += length;
        check(++records <= 200000, 'TOO_MANY');
        if (special < 2) {
          const expected = special === 0 ? directory : parent;
          check(
            item.identifier === special &&
              item.offset === expected.offset &&
              item.size === expected.size,
            'INVALID_ISO',
          );
          special++;
          continue;
        }
        check(typeof item.identifier === 'string', 'INVALID_ISO');
        if (pending) {
          check(
            !item.directory &&
              item.identifier === pending.identifier &&
              (item.flags & 0x7f) === pending.flags,
            'INVALID_ISO',
            'The ISO multi-extent file is interrupted by a different directory record.',
          );
        }
        if (item.directory) {
          children.push(item);
        } else {
          if (!pending) {
            pending = {
              identifier: item.identifier,
              name: item.name,
              flags: item.flags & 0x7f,
              extents: [],
            };
          }
          pending.extents.push(item);
          check(pending.extents.length <= 1024, 'TOO_MANY');
          if (item.flags & 0x80) {
            check(item.size > 0 && item.size % sectorSize === 0, 'INVALID_ISO');
          } else {
            await addFile(path + pending.name, pending.extents);
            pending = undefined;
          }
        }
        if ((records & 255) === 0) {
          report({ phase: 'index', value: null, count: entries.length });
          await new Promise((resolve) => setTimeout(resolve, 0));
        }
      }
    }
    check(special === 2 && !pending, 'INVALID_ISO');
    for (const child of children) {
      await walk(child, path + child.name + '/', directory, depth + 1);
    }
  }
  await walk(root, prefix, root, 0);
  return { format: level ? 'ISO9660/Joliet' : 'ISO9660', entries };
}
