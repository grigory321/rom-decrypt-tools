import type { AudioImport, ByteSource, ProgressReporter } from './contracts.js';
import type { RawSectorSize } from './disc-sources.js';
import { Bin, bounds, check } from './binary.js';
import { readAudio } from './audio-codecs.js';
import { inspectXaAudioSector } from './audio-xa.js';
import { cooperativeYield } from './cooperative.js';
import { errorCode } from './container-errors.js';
import { isFileReadError } from './errors.js';

interface XaRange {
  offset: number;
  size: number;
  logical: number;
}

interface XaStream {
  file: number;
  channel: number;
  coding: number;
  part: number;
  size: number;
  frames: number;
  ranges: XaRange[];
}

function filteredSource(source: ByteSource, stream: XaStream): ByteSource {
  return {
    size: stream.size,
    async read(offset, length) {
      bounds(stream.size, offset, length);
      check(length <= 4 * 1024 ** 2, 'TOO_LARGE');
      const output = new Uint8Array(length);
      let low = 0;
      let high = stream.ranges.length;
      while (low < high) {
        const middle = (low + high) >>> 1;
        const range = stream.ranges[middle];
        if (range.logical + range.size <= offset) low = middle + 1;
        else high = middle;
      }
      for (let index = low; index < stream.ranges.length; index++) {
        const range = stream.ranges[index];
        if (range.logical >= offset + length) break;
        const first = Math.max(offset, range.logical);
        const last = Math.min(offset + length, range.logical + range.size);
        for (let at = first; at < last; at += 65536)
          output.set(
            await readAudio(
              source,
              range.offset + at - range.logical,
              Math.min(65536, last - at),
            ),
            at - offset,
          );
      }
      return output;
    },
  };
}

export async function readXaAudio(
  source: ByteSource,
  name: string,
  report: ProgressReporter = () => {},
  sectorSize: RawSectorSize = 2352,
): Promise<AudioImport> {
  check(
    Number.isSafeInteger(source.size) &&
      source.size >= 0 &&
      source.size <= 16 * 1024 ** 3,
    'TOO_LARGE',
  );
  if (source.size < sectorSize) return { assets: [], warnings: [] };
  const head = new Bin(await readAudio(source, 0, Math.min(44, source.size)));
  const start =
    sectorSize === 2352 &&
    head.str(0, 4) === 'RIFF' &&
    head.str(8, 4) === 'CDXA'
      ? 44
      : 0;
  check(
    (source.size - start) % sectorSize === 0,
    'INVALID_AUDIO',
    'Truncated XA sector',
  );
  const checkpoint = cooperativeYield(() =>
    report({ phase: 'scan', value: null, detail: name }),
  );
  const streams: XaStream[] = [];
  const active = new Map<string, XaStream>();
  const parts = new Map<string, number>();
  const warnings: AudioImport['warnings'] = [];
  const unsupported = new Set<string>();
  let ranges = 0;
  let invalid = 0;
  for (let offset = start; offset < source.size; offset += sectorSize * 27) {
    report({
      phase: 'scan',
      value: (offset - start) / (source.size - start),
      detail: name,
    });
    const bytes = await readAudio(
      source,
      offset,
      Math.min(sectorSize * 27, source.size - offset),
    );
    for (let at = 0; at < bytes.length; at += sectorSize) {
      const sector = bytes.subarray(at, at + sectorSize);
      let info: ReturnType<typeof inspectXaAudioSector>;
      try {
        info = inspectXaAudioSector(sector, sectorSize);
      } catch (error) {
        if (
          isFileReadError(error) ||
          !['CODEC', 'INVALID_AUDIO', 'INVALID_RAW_SECTOR'].includes(
            errorCode(error),
          )
        )
          throw error;
        if (errorCode(error) === 'CODEC') {
          const header = sectorSize === 2352 ? 16 : 0;
          const key =
            sector[header] +
            ':' +
            sector[header + 1] +
            ':' +
            sector[header + 3];
          if (!unsupported.has(key)) {
            check(unsupported.size < 256, 'TOO_MANY', 'XA coding warnings');
            unsupported.add(key);
            warnings.push({
              code: 'CODEC',
              detail: name + ': XA file/channel/coding ' + key,
            });
          }
        } else invalid++;
        continue;
      }
      if (!info) continue;
      const key = info.file + ':' + info.channel + ':' + info.coding;
      let stream = active.get(key);
      if (!stream) {
        check(streams.length < 4096, 'TOO_MANY', 'XA streams');
        const part = (parts.get(key) || 0) + 1;
        parts.set(key, part);
        stream = {
          file: info.file,
          channel: info.channel,
          coding: info.coding,
          part,
          size: 0,
          frames: 0,
          ranges: [],
        };
        active.set(key, stream);
        streams.push(stream);
      }
      const previous = stream.ranges[stream.ranges.length - 1];
      if (previous && previous.offset + previous.size === offset + at)
        previous.size += sectorSize;
      else {
        check(++ranges <= 200000, 'TOO_MANY', 'XA sector ranges');
        stream.ranges.push({
          offset: offset + at,
          size: sectorSize,
          logical: stream.size,
        });
      }
      stream.size += sectorSize;
      stream.frames += info.frames;
      if (info.end) active.delete(key);
    }
    await checkpoint();
  }
  if (invalid)
    warnings.push({
      code: 'INVALID_AUDIO',
      detail: name + ': ' + invalid + ' invalid XA audio sectors',
    });
  return {
    assets: streams.map((stream) => ({
      source: filteredSource(source, stream),
      size: stream.size,
      name:
        name +
        '/file_' +
        stream.file +
        '_channel_' +
        stream.channel +
        '_coding_' +
        stream.coding.toString(16) +
        '_part_' +
        stream.part +
        '.xa',
      format: sectorSize === 2352 ? 'XA' : 'XA2336',
      kind: 'audio',
      gameAudio: true,
      playable: true,
      xaFile: stream.file,
      xaChannel: stream.channel,
      xaCoding: stream.coding,
      xaFrames: stream.frames,
    })),
    warnings,
  };
}
