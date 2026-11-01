import type {
  AudioDecoder,
  AudioMetadata,
  ByteSource,
  MaybePromise,
} from './contracts.js';
import type {
  ChannelReader,
  ChannelState,
  EncodedCodec,
  ImaState,
  InitialChannelState,
} from './audio-types.js';
import { bounds, check } from './binary.js';

export const clamp16 = (value: number) =>
  Math.max(-32768, Math.min(32767, value));
export const signedNibble = (value: number) =>
  value >= 8 ? value - 16 : value;
export const imaSteps = [
  7, 8, 9, 10, 11, 12, 13, 14, 16, 17, 19, 21, 23, 25, 28, 31, 34, 37, 41, 45,
  50, 55, 60, 66, 73, 80, 88, 97, 107, 118, 130, 143, 157, 173, 190, 209, 230,
  253, 279, 307, 337, 371, 408, 449, 494, 544, 598, 658, 724, 796, 876, 963,
  1060, 1166, 1282, 1411, 1552, 1707, 1878, 2066, 2272, 2499, 2749, 3024, 3327,
  3660, 4026, 4428, 4871, 5358, 5894, 6484, 7132, 7845, 8630, 9493, 10442,
  11487, 12635, 13899, 15289, 16818, 18500, 20350, 22385, 24623, 27086, 29794,
  32767,
];
const imaIndices = [-1, -1, -1, -1, 2, 4, 6, 8];
const psxCoefficients = [
  [0, 0],
  [60, 0],
  [115, -52],
  [98, -55],
  [122, -60],
];

export function imaSample(
  nibble: number,
  state: ImaState,
  combinedRounding = false,
) {
  const step = imaSteps[state.index];
  let delta = combinedRounding
    ? ((2 * (nibble & 7) + 1) * step) >> 3
    : step >> 3;
  if (!combinedRounding) {
    if (nibble & 1) delta += step >> 2;
    if (nibble & 2) delta += step >> 1;
    if (nibble & 4) delta += step;
  }
  state.h1 = clamp16(state.h1 + (nibble & 8 ? -delta : delta));
  state.index = Math.max(0, Math.min(88, state.index + imaIndices[nibble & 7]));
  return state.h1;
}

export async function readAudio(
  source: ByteSource,
  offset: number,
  length: number,
) {
  bounds(source.size, offset, length);
  check(length <= 65536, 'TOO_LARGE');
  const bytes = await source.read(offset, length);
  check(bytes instanceof Uint8Array && bytes.length === length, 'BOUNDS');
  return bytes;
}

export function contiguousAudio(
  source: ByteSource,
  offset: number,
  size: number,
): ByteSource {
  bounds(source.size, offset, size);
  return {
    size,
    read: (position: number, length: number) => {
      bounds(size, position, length);
      return readAudio(source, offset + position, length);
    },
  };
}

export function interleavedAudio(
  source: ByteSource,
  start: number,
  channel: number,
  channels: number,
  blockSize: number,
  size: number,
  lastStride: number | null = null,
): ByteSource {
  check(
    Number.isSafeInteger(blockSize) &&
      blockSize > 0 &&
      Number.isSafeInteger(size) &&
      size >= 0,
    'INVALID_AUDIO',
  );
  const regularBytes =
    lastStride === null
      ? Math.floor(size / blockSize) * blockSize
      : Math.max(0, Math.ceil(size / blockSize) - 1) * blockSize;
  const tailBytes = size - regularBytes;
  const tailStride = lastStride ?? tailBytes;
  const locate = (position: number) => {
    if (position < regularBytes)
      return {
        offset:
          start +
          Math.floor(position / blockSize) * blockSize * channels +
          channel * blockSize +
          (position % blockSize),
        available: blockSize - (position % blockSize),
      };
    return {
      offset:
        start +
        regularBytes * channels +
        channel * tailStride +
        position -
        regularBytes,
      available: size - position,
    };
  };
  if (size) {
    const last = locate(size - 1);
    bounds(source.size, last.offset, 1);
  }
  return {
    size,
    async read(position: number, length: number) {
      bounds(size, position, length);
      check(length <= 65536, 'TOO_LARGE');
      const output = new Uint8Array(length);
      let written = 0;
      while (written < length) {
        const segment = locate(position + written),
          count = Math.min(length - written, segment.available);
        check(count > 0, 'INVALID_AUDIO');
        output.set(await readAudio(source, segment.offset, count), written);
        written += count;
      }
      return output;
    },
  };
}

export function encodedSize(codec: EncodedCodec, samples: number) {
  if (codec === 'pcm8') return samples;
  if (codec === 'pcm16') return samples * 2;
  if (codec === 'ima') return Math.ceil(samples / 2);
  if (codec === 'dsp') return Math.ceil(samples / 14) * 8;
  if (codec === 'psx') return Math.ceil(samples / 28) * 16;
  check(false, 'CODEC', codec);
}

export function encodedChannel(
  source: ByteSource,
  codec: EncodedCodec,
  length: number,
  initial: InitialChannelState = {},
  littleEndian = false,
  onFlag: (flag: number, frame: number) => void = () => {},
): ChannelReader {
  const unitBytes =
    codec === 'pcm16' ? 2 : codec === 'dsp' ? 8 : codec === 'psx' ? 16 : 1;
  const unitSamples =
    codec === 'dsp' ? 14 : codec === 'psx' ? 28 : codec === 'ima' ? 2 : 1;
  let state: ChannelState = { h1: 0, h2: 0, index: 0 };
  let encodedPosition = 0,
    decodedPosition = 0,
    pending: Float32Array = new Float32Array(0),
    pendingPosition = 0;
  function reset() {
    state = {
      h1: initial.h1 || 0,
      h2: initial.h2 || 0,
      index: initial.index || 0,
    };
    check(state.index >= 0 && state.index <= 88, 'INVALID_AUDIO');
    encodedPosition = 0;
    decodedPosition = 0;
    pending = new Float32Array(0);
    pendingPosition = 0;
  }
  async function read(frames: number) {
    const output = new Float32Array(frames);
    let written = 0;
    while (written < frames) {
      if (pendingPosition === pending.length) {
        const units = Math.ceil((frames - written) / unitSamples),
          byteCount = Math.min(
            units * unitBytes,
            source.size - encodedPosition,
          );
        check(byteCount > 0, 'BOUNDS');
        const raw = await source.read(encodedPosition, byteCount),
          view = new DataView(raw.buffer, raw.byteOffset, raw.byteLength);
        const count = Math.min(units * unitSamples, length - decodedPosition);
        pending = new Float32Array(count);
        pendingPosition = 0;
        let target = 0;
        for (let offset = 0; target < count; offset += unitBytes) {
          const unitCount = Math.min(unitSamples, count - target);
          let scale = 1,
            predictor = 0,
            flag = 0;
          if (codec === 'dsp') {
            predictor = raw[offset] >> 4;
            scale = 2 ** (raw[offset] & 15);
            check(
              predictor <= 7 && initial.coefs?.length === 16,
              'INVALID_AUDIO',
            );
          }
          if (codec === 'psx') {
            predictor = raw[offset] >> 4;
            scale = raw[offset] & 15;
            flag = raw[offset + 1];
            check(predictor <= 4 && scale <= 12 && flag <= 7, 'INVALID_AUDIO');
            onFlag(flag, decodedPosition + target);
          }
          for (let index = 0; index < unitCount; index++) {
            let sample: number;
            if (codec === 'pcm8') sample = ((raw[offset] << 24) >> 24) * 256;
            else if (codec === 'pcm16')
              sample = view.getInt16(offset, littleEndian);
            else if (codec === 'ima')
              sample = imaSample((raw[offset] >> (index * 4)) & 15, state);
            else if (codec === 'dsp') {
              const coefs = initial.coefs;
              check(coefs?.length === 16, 'INVALID_AUDIO');
              check(offset + 1 + (index >> 1) < raw.length, 'BOUNDS');
              const nibble = signedNibble(
                (raw[offset + 1 + (index >> 1)] >> (index & 1 ? 0 : 4)) & 15,
              );
              sample = clamp16(
                Math.floor(
                  (nibble * scale * 2048 +
                    1024 +
                    coefs[predictor * 2] * state.h1 +
                    coefs[predictor * 2 + 1] * state.h2) /
                    2048,
                ),
              );
            } else {
              const nibble = signedNibble(
                  (raw[offset + 2 + (index >> 1)] >> (index & 1 ? 4 : 0)) & 15,
                ),
                coefficients = psxCoefficients[predictor];
              sample =
                flag === 7
                  ? 0
                  : Math.trunc(
                      ((nibble * 4096) >> scale) +
                        (coefficients[0] * state.h1 +
                          coefficients[1] * state.h2) /
                          64,
                    );
            }
            if (codec === 'dsp' || codec === 'psx') {
              state.h2 = state.h1;
              state.h1 = sample;
            }
            pending[target++] = clamp16(sample) / 32768;
          }
        }
        encodedPosition += byteCount;
        decodedPosition += count;
      }
      const count = Math.min(
        frames - written,
        pending.length - pendingPosition,
      );
      output.set(
        pending.subarray(pendingPosition, pendingPosition + count),
        written,
      );
      pendingPosition += count;
      written += count;
    }
    return output;
  }
  reset();
  return {
    read,
    reset,
    checkpoint() {
      const savedState = { ...state };
      const savedEncodedPosition = encodedPosition;
      const savedDecodedPosition = decodedPosition;
      const unread = pending.slice(pendingPosition);
      return () => {
        state = { ...savedState };
        encodedPosition = savedEncodedPosition;
        decodedPosition = savedDecodedPosition;
        pending = unread;
        pendingPosition = 0;
      };
    },
    ...(unitSamples === 1
      ? {
          seek(frame: number) {
            check(
              Number.isSafeInteger(frame) && frame >= 0 && frame <= length,
              'INVALID_AUDIO',
            );
            reset();
            encodedPosition = frame * unitBytes;
            decodedPosition = frame;
          },
        }
      : {}),
  };
}

export function audioDecoder(
  metadata: AudioMetadata,
  readChannels: (count: number, frame: number) => MaybePromise<Float32Array[]>,
  resetChannels: () => MaybePromise<void>,
  seekChannels: ((frame: number) => MaybePromise<void>) | null = null,
  checkpointChannels: (() => () => void) | null = null,
): AudioDecoder {
  check(
    Number.isInteger(metadata.channels) &&
      metadata.channels > 0 &&
      metadata.channels <= 8,
    'INVALID_AUDIO',
  );
  check(
    Number.isFinite(metadata.sampleRate) &&
      metadata.sampleRate >= 1000 &&
      metadata.sampleRate <= 192000,
    'INVALID_AUDIO',
  );
  check(
    metadata.length === null ||
      (Number.isSafeInteger(metadata.length) && metadata.length >= 0),
    'INVALID_AUDIO',
  );
  if (metadata.loop)
    check(
      typeof metadata.loopStart === 'number' &&
        typeof metadata.loopEnd === 'number' &&
        Number.isSafeInteger(metadata.loopStart) &&
        metadata.loopStart >= 0 &&
        metadata.loopStart < metadata.loopEnd &&
        (metadata.length === null || metadata.loopEnd <= metadata.length),
      'INVALID_AUDIO',
    );
  let frame = 0;
  return {
    sampleRate: metadata.sampleRate,
    channels: metadata.channels,
    length: metadata.length,
    continuous: metadata.length === null,
    get loop() {
      return !!metadata.loop;
    },
    get loopStart() {
      return metadata.loopStart || 0;
    },
    get loopEnd() {
      return metadata.loopEnd ?? metadata.length;
    },
    get frame() {
      return frame;
    },
    tags: metadata.tags,
    ...(checkpointChannels
      ? {
          checkpoint() {
            const savedFrame = frame;
            const restoreChannels = checkpointChannels();
            return () => {
              restoreChannels();
              frame = savedFrame;
            };
          },
        }
      : {}),
    ...(seekChannels
      ? {
          async seek(target: number) {
            check(
              Number.isSafeInteger(target) &&
                target >= 0 &&
                (metadata.length === null || target <= metadata.length),
              'INVALID_AUDIO',
            );
            await seekChannels(target);
            frame = target;
          },
        }
      : {}),
    async reset() {
      await resetChannels();
      frame = 0;
    },
    async read(frames = 8192) {
      check(Number.isSafeInteger(frames) && frames > 0, 'INVALID_AUDIO');
      const count = Math.min(
        frames,
        16384,
        metadata.length === null ? Infinity : metadata.length - frame,
      );
      const channels = count
        ? await readChannels(count, frame)
        : Array.from({ length: metadata.channels }, () => new Float32Array(0));
      check(
        channels.length === metadata.channels &&
          channels.every((channel) => channel.length === count),
        'INVALID_AUDIO',
      );
      frame += count;
      return {
        channels,
        sampleRate: metadata.sampleRate,
        done: metadata.length !== null && frame >= metadata.length,
        frame,
      };
    },
  };
}

export function channelDecoder(
  metadata: AudioMetadata,
  readers: ChannelReader[],
): AudioDecoder {
  return audioDecoder(
    metadata,
    async (count) => {
      const channels: Float32Array[] = [];
      for (const reader of readers) channels.push(await reader.read(count));
      return channels;
    },
    () => {
      for (const reader of readers) reader.reset();
    },
    readers.every((reader) => typeof reader.seek === 'function')
      ? (target) => {
          for (const reader of readers) {
            check(reader.seek, 'INVALID_AUDIO');
            reader.seek(target);
          }
        }
      : null,
    readers.every((reader) => typeof reader.checkpoint === 'function')
      ? () => {
          const restores = readers.map((reader) => {
            check(reader.checkpoint, 'INVALID_AUDIO');
            return reader.checkpoint();
          });
          return () => {
            for (const restore of restores) restore();
          };
        }
      : null,
  );
}
