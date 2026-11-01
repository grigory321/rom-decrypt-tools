import type { ImaState } from './audio-types.js';
import type { AudioDecoder, ByteSource } from './contracts.js';
import { Bin, bounds, check } from './binary.js';
import {
  audioDecoder,
  readAudio,
  imaSample,
  clamp16,
  signedNibble,
} from './audio-codecs.js';

interface MsAdpcmState {
  h1: number;
  h2: number;
  delta: number;
  coefficients: number[];
}

function safeSize(value: bigint) {
  check(value <= BigInt(Number.MAX_SAFE_INTEGER), 'TOO_LARGE');
  return Number(value);
}

async function waveSizes(source: ByteSource, header: Bin) {
  if (header.str(0, 4) === 'RIFF')
    return {
      end: header.u32(4) + 8,
      start: 12,
      dataSize: null,
      samples: 0n,
      table: new Map<string, bigint[]>(),
    };
  const chunk = new Bin(await readAudio(source, 12, 8));
  const size = chunk.u32(4);
  check(chunk.str(0, 4) === 'ds64' && size >= 28, 'INVALID_AUDIO');
  bounds(source.size, 20, size + (size & 1));
  const info = new Bin(await readAudio(source, 20, 28));
  const declaredSize = header.u32(4);
  const end =
    (declaredSize === 0xffffffff
      ? safeSize(info.d.getBigUint64(0, true))
      : declaredSize) + 8;
  bounds(source.size, 0, end);
  const dataSize = info.d.getBigUint64(8, true);
  const count = info.u32(24);
  check(
    count <= 4096 && count <= Math.floor((size - 28) / 12),
    'INVALID_AUDIO',
  );
  bounds(end, 20, size + (size & 1));
  const table = new Map<string, bigint[]>();
  for (let index = 0; index < count; index++) {
    const entry = new Bin(await readAudio(source, 48 + index * 12, 12));
    const tag = entry.str(0, 4);
    const lengths = table.get(tag) ?? [];
    lengths.push(entry.d.getBigUint64(4, true));
    table.set(tag, lengths);
  }
  return {
    end,
    start: 20 + size + (size & 1),
    dataSize,
    samples: header.str(0, 4) === 'RF64' ? info.d.getBigUint64(16, true) : 0n,
    table,
  };
}

function decodeImaBlock(
  raw: Uint8Array,
  channels: number,
  sampleCount: number,
) {
  const header = new Bin(raw),
    output = Array.from(
      { length: channels },
      () => new Float32Array(sampleCount),
    ),
    states: ImaState[] = [];
  for (let channel = 0; channel < channels; channel++) {
    const h1 = header.i16(channel * 4),
      index = header.u8(channel * 4 + 2);
    check(index <= 88 && header.u8(channel * 4 + 3) === 0, 'INVALID_AUDIO');
    states.push({ h1, index });
    output[channel][0] = h1 / 32768;
  }
  let sample = 1;
  for (
    let offset = channels * 4;
    sample < sampleCount;
    offset += channels * 4
  ) {
    for (let channel = 0; channel < channels; channel++) {
      for (
        let nibble = 0;
        nibble < 8 && sample + nibble < sampleCount;
        nibble++
      ) {
        const index = offset + channel * 4 + (nibble >> 1);
        check(index < raw.length, 'BOUNDS');
        output[channel][sample + nibble] =
          imaSample(
            (raw[index] >> (nibble & 1 ? 4 : 0)) & 15,
            states[channel],
            true,
          ) / 32768;
      }
    }
    sample += 8;
  }
  return output;
}

function decodeMsBlock(
  raw: Uint8Array,
  channels: number,
  sampleCount: number,
  coefficients: number[][],
) {
  const header = new Bin(raw),
    output = Array.from(
      { length: channels },
      () => new Float32Array(sampleCount),
    ),
    states: MsAdpcmState[] = [];
  const adaptation = [
    230, 230, 230, 230, 307, 409, 512, 614, 768, 614, 512, 409, 307, 230, 230,
    230,
  ];
  check(channels <= 2 && sampleCount >= 2, 'INVALID_AUDIO');
  for (let channel = 0; channel < channels; channel++) {
    const predictor = header.u8(channel),
      delta = header.u16(channels + channel * 2),
      h1 = header.i16(channels * 3 + channel * 2),
      h2 = header.i16(channels * 5 + channel * 2);
    check(predictor < coefficients.length && delta >= 16, 'INVALID_AUDIO');
    states.push({ h1, h2, delta, coefficients: coefficients[predictor] });
    output[channel][0] = h2 / 32768;
    output[channel][1] = h1 / 32768;
  }
  let frame = 2;
  for (let offset = channels * 7; frame < sampleCount; offset++) {
    check(offset < raw.length, 'BOUNDS');
    for (let part = 0; part < 2; part++) {
      const channel = channels === 2 ? part : 0,
        state = states[channel],
        nibble = (raw[offset] >> (part ? 0 : 4)) & 15;
      const sample = clamp16(
        Math.trunc(
          (state.h1 * state.coefficients[0] +
            state.h2 * state.coefficients[1]) /
            256,
        ) +
          signedNibble(nibble) * state.delta,
      );
      state.h2 = state.h1;
      state.h1 = sample;
      state.delta = Math.max(16, (adaptation[nibble] * state.delta) >> 8);
      output[channel][frame] = sample / 32768;
      if (channels === 1 || part === 1) frame++;
      if (frame >= sampleCount) break;
    }
  }
  return output;
}

export async function createWaveDecoder(
  source: ByteSource,
): Promise<AudioDecoder> {
  const header = new Bin(await readAudio(source, 0, 12));
  check(
    ['RIFF', 'RF64', 'BW64'].includes(header.str(0, 4)) &&
      header.str(8, 4) === 'WAVE',
    'INVALID_AUDIO',
  );
  const sizes = await waveSizes(source, header);
  const end = sizes.end;
  check(end <= source.size && end >= 12, 'BOUNDS');
  let format: Bin | undefined,
    dataOffset: number | undefined,
    dataSize = 0,
    fact: number | null = null,
    loop = false,
    loopStart = 0,
    loopEnd: number | undefined;
  let chunks = 0;
  for (let offset = sizes.start; offset < end;) {
    check(++chunks <= 4096, 'TOO_LARGE');
    bounds(end, offset, 8);
    const chunk = new Bin(await readAudio(source, offset, 8)),
      tag = chunk.str(0, 4),
      start = offset + 8;
    let size = chunk.u32(4);
    if (size === 0xffffffff) {
      const resolved =
        tag === 'data' && dataOffset === undefined
          ? sizes.dataSize
          : sizes.table.get(tag)?.shift();
      check(resolved !== undefined && resolved !== null, 'INVALID_AUDIO');
      size = safeSize(resolved);
    }
    check(tag !== 'ds64' || sizes.dataSize === null, 'INVALID_AUDIO');
    bounds(end, start, size);
    if (tag === 'fmt ') {
      check(size >= 16 && size <= 65536 && !format, 'INVALID_AUDIO');
      format = new Bin(await readAudio(source, start, size));
    } else if (tag === 'data' && dataOffset === undefined) {
      dataOffset = start;
      dataSize = size;
    } else if (tag === 'fact' && size >= 4) {
      fact = new Bin(await readAudio(source, start, 4)).u32(0);
      if (fact === 0xffffffff && header.str(0, 4) === 'RF64') {
        check(sizes.samples > 0n, 'INVALID_AUDIO');
        fact = safeSize(sizes.samples);
      }
    } else if (tag === 'smpl' && size >= 60) {
      const sample = new Bin(await readAudio(source, start, 60));
      if (sample.u32(28) > 0 && sample.u32(40) === 0) {
        loop = true;
        loopStart = sample.u32(44);
        loopEnd = sample.u32(48) + 1;
      }
    }
    offset = start + size + (size & 1);
    check(offset <= end, 'BOUNDS');
  }
  check(format && dataOffset !== undefined, 'INVALID_AUDIO');
  let codec = format.u16(0);
  const channels = format.u16(2),
    sampleRate = format.u32(4),
    blockAlign = format.u16(12),
    bits = format.u16(14);
  check(
    channels >= 1 && channels <= 8 && blockAlign > 0 && blockAlign <= 65536,
    'INVALID_AUDIO',
  );
  if (codec === 0xfffe) {
    check(
      format.b.length >= 40 &&
        format.u16(16) >= 22 &&
        format.u16(18) <= bits &&
        format.u16(26) === 0 &&
        format.u32(28) === 0x00100000 &&
        format.u32(32) === 0xaa000080 &&
        format.u32(36) === 0x719b3800,
      'CODEC',
      'WAVE extensible subtype',
    );
    codec = format.u16(24);
  }
  check([1, 3, 17, 2].includes(codec), 'CODEC', String(codec));
  if (codec === 1 || codec === 3) {
    check(
      codec === 1 ? [8, 16, 24, 32].includes(bits) : [32, 64].includes(bits),
      'CODEC',
      String(bits),
    );
    const bytesPerSample = bits / 8;
    check(
      blockAlign === channels * bytesPerSample && dataSize % blockAlign === 0,
      'INVALID_AUDIO',
    );
    const length = dataSize / blockAlign;
    return audioDecoder(
      {
        channels,
        sampleRate,
        length,
        loop,
        loopStart,
        loopEnd: loopEnd ?? length,
      },
      async (count, frame) => {
        const output = Array.from(
          { length: channels },
          () => new Float32Array(count),
        );
        for (let first = 0; first < count;) {
          const frames = Math.min(
            count - first,
            Math.floor(65536 / blockAlign),
          );
          const raw = await readAudio(
              source,
              dataOffset + (frame + first) * blockAlign,
              frames * blockAlign,
            ),
            view = new DataView(raw.buffer, raw.byteOffset, raw.byteLength);
          for (let channel = 0; channel < channels; channel++)
            for (let index = 0; index < frames; index++) {
              const offset = (index * channels + channel) * bytesPerSample;
              let value: number;
              if (codec === 3)
                value =
                  bits === 32
                    ? view.getFloat32(offset, true)
                    : view.getFloat64(offset, true);
              else if (bits === 8) value = (raw[offset] - 128) / 128;
              else if (bits === 16) value = view.getInt16(offset, true) / 32768;
              else if (bits === 24)
                value =
                  ((raw[offset] << 8) |
                    (raw[offset + 1] << 16) |
                    (raw[offset + 2] << 24)) /
                  2147483648;
              else value = view.getInt32(offset, true) / 2147483648;
              output[channel][first + index] = Number.isFinite(value)
                ? Math.max(-1, Math.min(1, value))
                : 0;
            }
          first += frames;
        }
        return output;
      },
      () => {},
      () => {},
    );
  }
  check(
    bits === 4 && format.b.length >= 20 && format.u16(16) >= 2,
    'INVALID_AUDIO',
  );
  const samplesPerBlock = format.u16(18),
    headerBytes = channels * (codec === 17 ? 4 : 7),
    coefficients: number[][] = [];
  const calculated =
    codec === 17
      ? Math.floor(((blockAlign - headerBytes) * 2) / channels) + 1
      : Math.floor(((blockAlign - headerBytes) * 2) / channels) + 2;
  check(
    blockAlign >= headerBytes &&
      samplesPerBlock === calculated &&
      samplesPerBlock > 0,
    'INVALID_AUDIO',
  );
  if (codec === 17)
    check((blockAlign - headerBytes) % (channels * 4) === 0, 'INVALID_AUDIO');
  else {
    check(channels <= 2 && format.b.length >= 22, 'INVALID_AUDIO');
    const count = format.u16(20);
    check(
      count > 0 && count <= 32 && format.b.length >= 22 + count * 4,
      'INVALID_AUDIO',
    );
    for (let index = 0; index < count; index++)
      coefficients.push([
        format.i16(22 + index * 4),
        format.i16(24 + index * 4),
      ]);
  }
  const blocks = Math.floor(dataSize / blockAlign),
    remainder = dataSize % blockAlign;
  check(remainder === 0 || remainder >= headerBytes, 'INVALID_AUDIO');
  const tailSamples = remainder
    ? (codec === 17 ? 1 : 2) +
      Math.floor(((remainder - headerBytes) * 2) / channels)
    : 0;
  const available = blocks * samplesPerBlock + tailSamples,
    length = fact ?? (sizes.samples ? safeSize(sizes.samples) : available);
  check(fact === null || fact <= available, 'INVALID_AUDIO');
  check(length <= available, 'INVALID_AUDIO');
  let position = 0,
    pending: Float32Array[] = [],
    pendingPosition = 0;
  return audioDecoder(
    {
      channels,
      sampleRate,
      length,
      loop,
      loopStart,
      loopEnd: loopEnd ?? length,
    },
    async (count) => {
      const output = Array.from(
        { length: channels },
        () => new Float32Array(count),
      );
      let written = 0;
      while (written < count) {
        if (!pending.length || pendingPosition === pending[0].length) {
          const size = Math.min(blockAlign, dataSize - position),
            samples = size < blockAlign ? tailSamples : samplesPerBlock;
          const raw = await readAudio(source, dataOffset + position, size);
          pending =
            codec === 17
              ? decodeImaBlock(raw, channels, samples)
              : decodeMsBlock(raw, channels, samples, coefficients);
          pendingPosition = 0;
          position += size;
        }
        const copied = Math.min(
          count - written,
          pending[0].length - pendingPosition,
        );
        for (let channel = 0; channel < channels; channel++)
          output[channel].set(
            pending[channel].subarray(
              pendingPosition,
              pendingPosition + copied,
            ),
            written,
          );
        pendingPosition += copied;
        written += copied;
      }
      return output;
    },
    () => {
      position = 0;
      pending = [];
      pendingPosition = 0;
    },
  );
}
