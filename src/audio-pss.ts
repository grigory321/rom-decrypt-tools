import type {
  AudioImport,
  ByteSource,
  Diagnostic,
  ProgressReporter,
} from './contracts.js';
import { Bin, bounds, check } from './binary.js';
import { readAudio } from './audio-codecs.js';
import { createSs2Decoder } from './audio-playstation.js';

interface Segment {
  offset: number;
  size: number;
  logical: number;
}

interface PssStream {
  type: number;
  id: number;
  header: Uint8Array;
  headerBytes: number;
  size: number;
  segments: Segment[];
}

function audioSource(source: ByteSource, stream: PssStream): ByteSource {
  const size = stream.header.length + stream.size;
  return {
    size,
    async read(offset, length) {
      bounds(size, offset, length);
      check(length <= 65536, 'TOO_LARGE');
      const output = new Uint8Array(length);
      if (offset < 40)
        output.set(
          stream.header.subarray(offset, Math.min(40, offset + length)),
        );
      const start = Math.max(40, offset) - 40;
      const stop = offset + length - 40;
      if (stop <= start) return output;
      let low = 0,
        high = stream.segments.length;
      while (low < high) {
        const middle = Math.floor((low + high) / 2),
          segment = stream.segments[middle];
        if (segment.logical + segment.size <= start) low = middle + 1;
        else high = middle;
      }
      for (let index = low; index < stream.segments.length; index++) {
        const segment = stream.segments[index];
        if (segment.logical >= stop) break;
        const first = Math.max(start, segment.logical),
          last = Math.min(stop, segment.logical + segment.size);
        output.set(
          await readAudio(
            source,
            segment.offset + first - segment.logical,
            last - first,
          ),
          first + 40 - offset,
        );
      }
      return output;
    },
  };
}

export async function extractPssAudio(
  source: ByteSource,
  name: string,
  report: ProgressReporter = () => {},
): Promise<AudioImport | null> {
  if (source.size < 4) return null;
  if (new Bin(await readAudio(source, 0, 4)).u32(0, false) !== 0x000001ba)
    return null;
  let cacheOffset = -1;
  let cache: Uint8Array = new Uint8Array();
  let position = 0,
    packets = 0,
    segments = 0,
    ended = false;
  const streams = new Map<string, PssStream>(),
    unsupported = new Set<string>(),
    warnings: Diagnostic[] = [];
  async function read(offset: number, length: number) {
    check(
      offset >= 0 && length >= 0 && offset + length <= source.size,
      'INVALID_AUDIO',
      'Truncated PSS packet',
    );
    if (offset < cacheOffset || offset + length > cacheOffset + cache.length) {
      cacheOffset = offset;
      cache = await readAudio(
        source,
        offset,
        Math.min(65536, source.size - offset),
      );
    }
    return cache.subarray(offset - cacheOffset, offset - cacheOffset + length);
  }
  while (position + 4 <= source.size) {
    const prefix = new Bin(await read(position, 4)),
      tag = prefix.u32(0, false),
      id = tag & 255;
    check(tag >>> 8 === 1, 'INVALID_AUDIO', 'Invalid PSS packet start');
    check(++packets <= 1000000, 'TOO_MANY');
    if (id === 0xb9) {
      position += 4;
      ended = true;
      break;
    }
    if (id === 0xba) {
      const header = await read(position, 14),
        stuffing = header[13] & 7;
      check((header[4] & 0xc0) === 0x40, 'CODEC', 'MPEG-1 PSS pack');
      check(
        (await read(position + 14, stuffing)).every((value) => value === 255),
        'INVALID_AUDIO',
      );
      position += 14 + stuffing;
      continue;
    }
    check(id >= 0xbb, 'INVALID_AUDIO', 'Invalid PSS packet identifier');
    const packet = new Bin(await read(position, 6)),
      length = packet.u16(4, false) + 6,
      end = position + length;
    check(end <= source.size, 'INVALID_AUDIO', 'Truncated PSS packet');
    if (id === 0xbd) {
      check(length >= 9, 'INVALID_AUDIO');
      const header = await read(position + 6, 3);
      check((header[0] & 0xc0) === 0x80, 'INVALID_AUDIO', 'PSS PES header');
      let privateOffset = position + 9 + header[2],
        stuffing = 0;
      check(privateOffset + 3 <= end, 'INVALID_AUDIO', 'PSS PES header size');
      while ((await read(privateOffset, 1))[0] === 255) {
        check(++stuffing <= 32 && privateOffset + 4 <= end, 'INVALID_AUDIO');
        privateOffset++;
      }
      const privateHeader = new Bin(await read(privateOffset, 3)),
        type = privateHeader.u8(0),
        streamId = privateHeader.u16(1, false),
        key = type + ':' + streamId;
      let payload = privateOffset + 3;
      if (![0xa0, 0xa1].includes(type)) {
        if (!unsupported.has(key)) {
          check(unsupported.size < 256, 'TOO_MANY');
          unsupported.add(key);
          warnings.push({
            code: 'CODEC',
            detail: name + ': PSS stream ' + key,
          });
        }
      } else {
        let stream = streams.get(key);
        if (!stream) {
          check(streams.size < 256, 'TOO_MANY');
          stream = {
            type,
            id: streamId,
            header: new Uint8Array(40),
            headerBytes: 0,
            size: 0,
            segments: [],
          };
          streams.set(key, stream);
        }
        if (stream.headerBytes < 40) {
          const count = Math.min(40 - stream.headerBytes, end - payload);
          stream.header.set(await read(payload, count), stream.headerBytes);
          stream.headerBytes += count;
          payload += count;
        }
        if (payload < end) {
          check(++segments <= 200000, 'TOO_MANY');
          stream.segments.push({
            offset: payload,
            size: end - payload,
            logical: stream.size,
          });
          stream.size += end - payload;
        }
      }
    }
    position = end;
    if ((packets & 1023) === 0) {
      report({ phase: 'scan', value: position / source.size });
      await new Promise((resolve) => setTimeout(resolve, 0));
    }
  }
  check(ended && position === source.size, 'INVALID_AUDIO', 'PSS end marker');
  const assets: AudioImport['assets'] = [];
  for (const stream of streams.values()) {
    const header = new Bin(stream.header);
    check(
      stream.headerBytes === 40 &&
        header.str(0, 4) === 'SShd' &&
        header.str(32, 4) === 'SSbd' &&
        header.u32(36) === stream.size,
      'INVALID_AUDIO',
      'PSS audio size or header',
    );
    const extracted = audioSource(source, stream);
    await createSs2Decoder(extracted);
    assets.push({
      source: extracted,
      size: extracted.size,
      name:
        name +
        '/' +
        (name.replaceAll('\\', '/').split('/').at(-1) ?? 'movie').replace(
          /\.pss$/i,
          '',
        ) +
        '_stream_' +
        stream.type.toString(16) +
        '_' +
        stream.id.toString().padStart(5, '0') +
        '.ss2',
      format: 'SS2',
      kind: 'audio',
      gameAudio: true,
      playable: true,
    });
  }
  report({ phase: 'scan', value: 1, count: assets.length });
  return { assets, warnings };
}
