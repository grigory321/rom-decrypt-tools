import type {
  Archive,
  ArchiveEntry,
  ByteSource,
  ProgressReporter,
} from './contracts.js';
import { align, Bin, bounds, check, sliceSource } from './binary.js';
import { readAudio } from './audio-codecs.js';
import { identifyGameAudioHeader } from './audio-formats.js';

function tableReader(
  source: ByteSource,
  start: number,
  count: number,
  width: number,
) {
  bounds(source.size, start, count * width);
  let cachedPage = -1,
    cached = new Bin(new Uint8Array());
  return async (index: number) => {
    check(index >= 0 && index < count, 'BOUNDS');
    const offset = index * width;
    const page = Math.floor(offset / 65536) * 65536;
    if (page !== cachedPage) {
      cached = new Bin(
        await readAudio(
          source,
          start + page,
          Math.min(65536, count * width - page),
        ),
      );
      cachedPage = page;
    }
    return width === 2 ? cached.u16(offset - page) : cached.u32(offset - page);
  };
}

export async function openAudioArchive(
  source: ByteSource,
  report: ProgressReporter = () => {},
): Promise<Archive> {
  const header = new Bin(await readAudio(source, 0, 16));
  check(header.str(0, 4) === 'AFS2', 'FORMAT');
  const offsetWidth = header.u8(5),
    idWidth = header.u16(6),
    count = header.u32(8),
    alignment = header.u16(12),
    subkey = header.u16(14);
  check(
    [1, 2].includes(header.u8(4)) &&
      [2, 4].includes(offsetWidth) &&
      [2, 4].includes(idWidth) &&
      alignment > 0,
    'FORMAT',
    'AWB table layout',
  );
  check(count > 0 && count <= 20000, 'TOO_MANY');
  const offsetTable = 16 + count * idWidth;
  const tableEnd = offsetTable + (count + 1) * offsetWidth;
  bounds(source.size, 0, tableEnd);
  const readId = tableReader(source, 16, count, idWidth);
  const readOffset = tableReader(source, offsetTable, count + 1, offsetWidth);
  const entries: ArchiveEntry[] = [];
  let previous = await readOffset(0);
  for (let index = 0; index < count; index++) {
    const next = await readOffset(index + 1);
    check(
      previous >= tableEnd && next >= previous && next <= source.size,
      'BOUNDS',
    );
    const start = align(previous, alignment);
    const end = next < source.size ? align(next, alignment) : next;
    check(start <= end, 'BOUNDS');
    bounds(source.size, start, end - start);
    const content = sliceSource(source, start, end - start);
    const bytes = await readAudio(content, 0, Math.min(128, content.size));
    const format = identifyGameAudioHeader(bytes, '', content.size);
    const id = await readId(index);
    entries.push({
      path:
        String(index).padStart(5, '0') +
        '-' +
        id +
        '.' +
        (format || 'bin').toLowerCase(),
      kind: 'file',
      format,
      size: content.size,
      source: content,
      subkey,
    });
    previous = next;
    if ((index & 127) === 0) {
      report({ phase: 'scan', value: (index + 1) / count });
      await new Promise((resolve) => setTimeout(resolve, 0));
    }
  }
  return { format: 'AWB', entries };
}
