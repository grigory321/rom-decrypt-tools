import type { ByteSource, ArchiveEntry } from './contracts.js';
import { Bin, check } from './binary.js';
import {
  MAX_ENTRIES,
  MAX_METADATA,
  boundedName,
  memorySource,
} from './wii-sources.js';

export type TreeEntry = Omit<ArchiveEntry, 'source'> & { source?: ByteSource };

export function walkTree(
  bytes: Uint8Array,
  tableOffset: number,
  recordSize: number,
  emit: (
    entry: TreeEntry,
    record: { index: number; offset: number; type: number },
  ) => void,
  options: { prefix?: string; cafe?: boolean } = {},
) {
  const view = new Bin(bytes),
    count = view.u32(tableOffset + 8, false);
  check(
    count > 0 && count <= MAX_ENTRIES && view.u8(tableOffset) & 1,
    'INVALID_FST',
  );
  view.range(tableOffset, count * recordSize);
  check(view.u32(tableOffset + 4, false) === 0, 'INVALID_FST');
  const strings = tableOffset + count * recordSize;
  const stack = [{ index: 0, end: count, path: options.prefix || '' }],
    names = new Set<string>();
  let nameBytes = 0;
  for (let index = 1; index < count; index++) {
    while (stack.length > 1 && index === stack[stack.length - 1].end)
      stack.pop();
    const parent = stack[stack.length - 1],
      offset = tableOffset + index * recordSize;
    check(index < parent.end && stack.length <= 64, 'INVALID_FST');
    const type = view.u8(offset),
      nameOffset = view.u32(offset, false) & 0xffffff;
    check((type & ~(options.cafe ? 0x83 : 1)) === 0, 'INVALID_FST');
    const name = boundedName(bytes, strings + nameOffset),
      path = parent.path + name;
    nameBytes += path.length;
    check(
      path.length <= 4096 && nameBytes <= MAX_METADATA && !names.has(path),
      'INVALID_FST',
    );
    names.add(path);
    if (type & 1) {
      const end = view.u32(offset + 8, false);
      check(
        view.u32(offset + 4, false) === parent.index &&
          end > index &&
          end <= parent.end,
        'INVALID_FST',
      );
      emit(
        {
          path: path + '/',
          kind: 'directory',
          size: 0,
          source: memorySource(new Uint8Array()),
        },
        { index, offset, type },
      );
      stack.push({ index, end, path: path + '/' });
    } else {
      emit(
        { path, kind: 'file', size: view.u32(offset + 8, false) },
        { index, offset, type },
      );
    }
  }
  return count;
}
