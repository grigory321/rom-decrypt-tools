import type { ByteSource, ProgressReporter } from './contracts.js';
import { Bin, bounds, check, sliceSource } from './binary.js';
import { hasAdxPrefix, inspectAdx } from './audio-adx.js';
import { inspectHca } from './audio-hca.js';
import { errorCode } from './container-errors.js';
import { isFileReadError } from './errors.js';
import { readSonySequenceExtent } from './audio-sony-sequence.js';

export interface EmbeddedAudio {
  source: ByteSource;
  offset: number;
  size: number;
  format: string;
}

const windowSize = 65536;
const windowStep = windowSize - 128;
const candidateLimit = 100000;
const nintendo = new Map([
  [0x53444154, 'SDAT'],
  [0x53574156, 'SWAV'],
  [0x5354524d, 'STRM'],
  [0x43574156, 'CWAV'],
  [0x4353544d, 'CSTM'],
  [0x46574156, 'FWAV'],
  [0x4653544d, 'FSTM'],
  [0x5253544d, 'RSTM'],
  [0x52574156, 'RWAV'],
  [0x53534551, 'SSEQ'],
  [0x43534551, 'CSEQ'],
  [0x46534551, 'FSEQ'],
  [0x43534152, 'CSAR'],
]);
const signatures = new Set([
  ...nintendo.keys(),
  0x52494646,
  0x52463634,
  0x42573634,
  0x464f524d,
  0x2e736e64,
  0x56414770,
  0x56414769,
  0x56414732,
  0x53536864,
  0x52585753,
  0x70424156,
  0x70514553,
  0x41465332,
  0x534e4553,
]);
const fatalErrors = new Set(['CANCELLED', 'TOO_MANY', 'TOO_LARGE', 'DEPTH']);
const firstBytes = new Set([
  0x2e, 0x41, 0x42, 0x43, 0x46, 0x48, 0x52, 0x53, 0x56, 0x70, 0x80, 0xc8,
]);

function boundedSource(source: ByteSource, checkpoint: () => void): ByteSource {
  return {
    size: source.size,
    async read(offset, length) {
      checkpoint();
      bounds(source.size, offset, length);
      if (length <= windowSize) {
        const bytes = await source.read(offset, length);
        checkpoint();
        check(bytes.length === length, 'BOUNDS');
        return bytes;
      }
      const bytes = new Uint8Array(length);
      for (let copied = 0; copied < length;) {
        checkpoint();
        const count = Math.min(windowSize, length - copied);
        const part = await source.read(offset + copied, count);
        checkpoint();
        check(part.length === count, 'BOUNDS');
        bytes.set(part, copied);
        copied += count;
      }
      return bytes;
    },
  };
}

async function extent(
  source: ByteSource,
  header: Bin,
  magic: number,
  checkpoint: () => void,
): Promise<{ size: number; format: string } | null> {
  const format = nintendo.get(magic);
  if (magic === 0x70514553) {
    const info = await readSonySequenceExtent(source, checkpoint);
    return { size: info.size, format: info.format };
  }
  if (format) {
    const bom = header.u16(4);
    if (bom !== 0xfeff && bom !== 0xfffe) return null;
    const modern = format[0] === 'C' || format[0] === 'F';
    const size = header.u32(modern ? 12 : 8, bom === 0xfeff);
    return size >= 32 ? { size, format } : null;
  }
  if ([0x52494646, 0x52463634, 0x42573634].includes(magic)) {
    if (header.u32(8, false) !== 0x57415645) return null;
    let size = header.u32(4) + 8;
    if (magic !== 0x52494646) {
      if (header.u32(12, false) !== 0x64733634 || header.u32(16) < 28)
        return null;
      if (header.u32(4) === 0xffffffff) {
        const declared = header.d.getBigUint64(20, true);
        if (declared > BigInt(Number.MAX_SAFE_INTEGER - 8)) return null;
        size = Number(declared) + 8;
      }
      const ds64Size = header.u32(16);
      if (20 + ds64Size + (ds64Size & 1) > size) return null;
    }
    return size >= 12 ? { size, format: 'WAV' } : null;
  }
  if (magic === 0x464f524d) {
    const type = header.u32(8, false);
    const size = header.u32(4, false) + 8;
    return size >= 12 && [0x41494646, 0x41494643].includes(type)
      ? { size, format: type === 0x41494643 ? 'AIFC' : 'AIFF' }
      : null;
  }
  if (magic === 0x2e736e64) {
    const start = header.u32(4, false),
      length = header.u32(8, false);
    return start >= 24 && length !== 0xffffffff && length > 0
      ? { size: start + length, format: 'AU' }
      : null;
  }
  if ([0x56414770, 0x56414769, 0x56414732].includes(magic)) {
    const length = header.u32(12, false);
    if (length === 0 || length % 16 !== 0) return null;
    const start = magic === 0x56414769 ? 2048 : magic === 0x56414732 ? 64 : 48;
    return {
      size: start + length * (magic === 0x56414770 ? 1 : 2),
      format: 'VAG',
    };
  }
  if (magic === 0x53536864) {
    const declared = header.u32(4);
    if (
      declared === 0x18 ||
      declared === 0x20 ||
      header.u32(32, false) !== 0x53536264
    )
      return null;
    const size = declared + 8;
    const body = header.u32(36);
    const start = size - body >= 2048 ? 2048 : 40;
    return body > 0 && size >= start + body ? { size, format: 'SS2' } : null;
  }
  if (magic === 0x52585753) {
    const size = header.u32(4) + 16;
    return size >= 32 ? { size, format: 'RXWS' } : null;
  }
  if (magic === 0x70424156) {
    const size = header.u32(12);
    return size >= 0xa20 ? { size, format: 'VAB' } : null;
  }
  if (magic === 0x41465332) {
    const width = header.u8(5),
      idWidth = header.u16(6),
      count = header.u32(8);
    if (
      ![1, 2].includes(header.u8(4)) ||
      ![2, 4].includes(width) ||
      ![2, 4].includes(idWidth) ||
      count === 0 ||
      count > 20000 ||
      header.u16(12) === 0
    )
      return null;
    const table = 16 + count * idWidth;
    const tableEnd = table + (count + 1) * width;
    bounds(source.size, table, (count + 1) * width);
    const last = new Bin(await source.read(table + count * width, width));
    const size = width === 2 ? last.u16(0) : last.u32(0);
    return size >= tableEnd ? { size, format: 'AFS2' } : null;
  }
  if (magic === 0x534e4553) {
    return header.str(0, 33) === 'SNES-SPC700 Sound File Data v0.30'
      ? { size: 0x10200, format: 'SPC' }
      : null;
  }
  if ((magic & 0x7f7f7f7f) === 0x48434100) {
    const metadata = await inspectHca(source);
    return { size: metadata.dataEnd, format: 'HCA' };
  }
  if (magic >>> 16 === 0x8000) {
    const metadata = await inspectAdx(source);
    return {
      size: metadata.dataOffset + metadata.blockCount * 18,
      format: 'ADX',
    };
  }
  return null;
}

export async function scanEmbeddedAudio(
  source: ByteSource,
  accept: (candidate: EmbeddedAudio) => Promise<boolean>,
  report: ProgressReporter = () => {},
): Promise<void> {
  check(Number.isSafeInteger(source.size) && source.size >= 0, 'BOUNDS');
  let value = 0,
    active = true;
  const checkpoint = () => {
    if (active) report({ phase: 'scan', value });
  };
  const input = boundedSource(source, checkpoint);
  let skipUntil = 0,
    candidates = 0,
    scannedSinceYield = 0,
    lastYield = Date.now();
  const yieldIfNeeded = async () => {
    if (scannedSinceYield < 1024 ** 2 && Date.now() - lastYield < 16) return;
    await new Promise<void>((resolve) => setTimeout(resolve, 0));
    scannedSinceYield = 0;
    lastYield = Date.now();
    checkpoint();
  };
  try {
    checkpoint();
    for (let offset = 0; offset < input.size; offset += windowStep) {
      const bytes = await input.read(
        offset,
        Math.min(windowSize, input.size - offset),
      );
      const view = new Bin(bytes);
      const limit = Math.min(windowStep, bytes.length - 3);
      for (let index = 0; index < limit; index++) {
        const start = offset + index;
        if (start < skipUntil) continue;
        const first = bytes[index];
        if (!firstBytes.has(first)) continue;
        const magic = view.u32(index, false);
        if (
          !signatures.has(magic) &&
          (magic & 0x7f7f7f7f) !== 0x48434100 &&
          magic >>> 16 !== 0x8000
        )
          continue;
        if (magic >>> 16 === 0x8000 && !hasAdxPrefix(bytes, index)) continue;
        check(
          ++candidates <= candidateLimit,
          'TOO_MANY',
          'Embedded audio candidate limit',
        );
        if ((candidates & 63) === 0) await yieldIfNeeded();
        value = Math.max(value, start / input.size);
        checkpoint();
        try {
          const tail = sliceSource(input, start, input.size - start);
          const count = Math.min(64, tail.size);
          const header = new Bin(
            index + count <= bytes.length
              ? bytes.subarray(index, index + count)
              : await tail.read(0, count),
          );
          const candidate = await extent(tail, header, magic, checkpoint);
          if (
            !candidate ||
            !Number.isSafeInteger(candidate.size) ||
            candidate.size <= 0 ||
            candidate.size > tail.size
          )
            continue;
          const accepted = await accept({
            source: sliceSource(input, start, candidate.size),
            offset: start,
            size: candidate.size,
            format: candidate.format,
          });
          checkpoint();
          if (accepted) skipUntil = start + candidate.size;
        } catch (error) {
          if (isFileReadError(error) || fatalErrors.has(errorCode(error)))
            throw error;
        }
      }
      value = Math.max(value, Math.min(1, (offset + windowStep) / input.size));
      checkpoint();
      scannedSinceYield += bytes.length;
      await yieldIfNeeded();
    }
    value = 1;
    checkpoint();
  } finally {
    active = false;
  }
}
