import type {
  Archive,
  ArchiveEntry,
  ByteSource,
  CompanionFile,
  ProgressReporter,
} from './contracts.js';
import { Bin, bounds, check, sliceSource } from './binary.js';
import { readAudio } from './audio-codecs.js';
import { asSource, sourceName } from './source-input.js';

function normalizedPath(value: string) {
  return value
    .replaceAll('\\', '/')
    .replace(/^(?:\.\/)+/, '')
    .toLowerCase();
}

function companionBody(name: string, companions: CompanionFile[]): ByteSource {
  const wanted = normalizedPath(name).replace(/\.[^./]+$/, '.vb');
  const candidates = companions.filter((file) =>
    /\.vb$/i.test(sourceName(file)),
  );
  const exact = candidates.filter(
    (file) => normalizedPath(sourceName(file)) === wanted,
  );
  const matches = exact.length
    ? exact
    : candidates.filter(
        (file) =>
          normalizedPath(sourceName(file)).split('/').at(-1) ===
          wanted.split('/').at(-1),
      );
  check(
    matches.length === 1,
    'VAB_COMPANION',
    matches.length ? 'Ambiguous VB body' : 'Matching VB body is missing',
  );
  return asSource(matches[0]);
}

function sampleSource(
  body: ByteSource,
  offset: number,
  length: number,
  id: number,
): ByteSource {
  const header = new Uint8Array(48);
  header.set(new TextEncoder().encode('VAGp'));
  const view = new DataView(header.buffer);
  view.setUint32(4, 0x20, false);
  view.setUint32(12, length, false);
  view.setUint32(16, 44100, false);
  header.set(new TextEncoder().encode('VAB sample ' + id), 32);
  return {
    size: header.length + length,
    async read(start, count) {
      bounds(header.length + length, start, count);
      if (start >= header.length && count <= 65536)
        return readAudio(body, offset + start - header.length, count);
      const output = new Uint8Array(count);
      let copied = 0;
      if (start < header.length) {
        const prefix = header.subarray(
          start,
          Math.min(header.length, start + count),
        );
        output.set(prefix);
        copied = prefix.length;
      }
      while (copied < count) {
        const size = Math.min(65536, count - copied);
        output.set(
          await readAudio(body, offset + start + copied - header.length, size),
          copied,
        );
        copied += size;
      }
      return output;
    },
  };
}

export async function openVabBank(
  source: ByteSource,
  name: string,
  companions: CompanionFile[] = [],
  report: ProgressReporter = () => {},
): Promise<Archive> {
  const header = new Bin(await readAudio(source, 0, 32));
  check(header.str(0, 4) === 'pBAV', 'VAB_FORMAT');
  const programs = header.u16(18);
  const sampleCount = header.u16(22);
  check(
    [5, 6, 7, 0x20].includes(header.u32(4)) &&
      programs <= 128 &&
      header.u16(20) <= 2048 &&
      sampleCount > 0 &&
      sampleCount <= 255,
    'VAB_FORMAT',
  );
  const sizeTable = 0x820 + programs * 0x200;
  const headerSize = sizeTable + 0x200;
  bounds(source.size, 0, headerSize);
  const programTable = new Bin(await readAudio(source, 32, 0x800));
  let activePrograms = 0;
  for (let program = 0; program < 128 && activePrograms < programs; program++) {
    const tones = programTable.u8(program * 16);
    check(tones <= 16, 'VAB_FORMAT');
    if (tones) activePrograms++;
  }
  check(activePrograms === programs, 'VAB_FORMAT');
  const sizes = new Bin(await readAudio(source, sizeTable, 0x200));
  const samples: { id: number; offset: number; size: number }[] = [];
  let bodySize = 0;
  for (let id = 1; id <= sampleCount; id++) {
    const size = sizes.u16(id * 2) * 8;
    check(size % 16 === 0, 'VAB_FORMAT');
    if (size) samples.push({ id, offset: bodySize, size });
    bodySize += size;
  }
  check(
    samples.length > 0 &&
      (header.u32(12) === 0 || header.u32(12) >= headerSize + bodySize),
    'VAB_FORMAT',
  );
  const separate = /\.vh$/i.test(name) || source.size < headerSize + bodySize;
  const body = separate
    ? companionBody(name, companions)
    : sliceSource(source, headerSize, bodySize);
  bounds(body.size, 0, bodySize);
  const entries: ArchiveEntry[] = [
    {
      path: 'header.vh',
      kind: 'metadata',
      format: 'VAB_HEADER',
      size: headerSize,
      source: sliceSource(source, 0, headerSize),
    },
    {
      path: 'body.vb',
      kind: 'file',
      format: 'VAB_BODY',
      size: bodySize,
      source: sliceSource(body, 0, bodySize),
    },
  ];
  for (const sample of samples) {
    const encoded = sampleSource(body, sample.offset, sample.size, sample.id);
    entries.push({
      path: 'samples/' + String(sample.id).padStart(3, '0') + '.vag',
      kind: 'audio',
      format: 'VAG',
      size: encoded.size,
      source: encoded,
    });
  }
  report({ phase: 'scan', value: 1, count: samples.length });
  return { format: 'VAB', entries };
}
