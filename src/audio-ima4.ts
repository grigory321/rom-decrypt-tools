import type { AudioMetadata, ByteSource } from './contracts.js';
import type { ImaState } from './audio-types.js';
import { Bin, bounds, check } from './binary.js';
import { audioDecoder, imaSample, readAudio } from './audio-codecs.js';

export function ima4Decoder(
  source: ByteSource,
  start: number,
  size: number,
  metadata: AudioMetadata,
) {
  const channels = metadata.channels;
  const stride = channels * 34;
  const length = metadata.length;
  check(
    Number.isInteger(channels) &&
      channels >= 1 &&
      channels <= 8 &&
      length !== null &&
      length > 0 &&
      Number.isSafeInteger(length) &&
      length % 64 === 0 &&
      size % stride === 0 &&
      length / 64 <= size / stride,
    'INVALID_AUDIO',
  );
  bounds(source.size, start, size);
  let nextPacket = 0;
  let pending: Float32Array[] = [];
  let states: ImaState[] = Array.from({ length: channels }, () => ({
    h1: 0,
    index: 0,
  }));
  function reset() {
    nextPacket = 0;
    pending = [];
    states = Array.from({ length: channels }, () => ({ h1: 0, index: 0 }));
  }
  async function packet(target: number) {
    if (target < nextPacket - 1) reset();
    while (nextPacket <= target) {
      const raw = new Bin(
        await readAudio(source, start + nextPacket * stride, stride),
      );
      pending = Array.from({ length: channels }, () => new Float32Array(64));
      for (let channel = 0; channel < channels; channel++) {
        const at = channel * 34;
        const packed = raw.i16(at, false);
        const predictor = packed & ~127;
        const index = packed & 127;
        check(index <= 88, 'INVALID_AUDIO');
        const state = states[channel];
        if (state.index !== index || Math.abs(state.h1 - predictor) > 127) {
          state.h1 = predictor;
          state.index = index;
        }
        for (let sample = 0; sample < 64; sample++)
          pending[channel][sample] =
            imaSample(
              (raw.u8(at + 2 + (sample >> 1)) >> ((sample & 1) * 4)) & 15,
              state,
            ) / 32768;
      }
      nextPacket++;
    }
    return pending;
  }
  return audioDecoder(
    metadata,
    async (count, frame) => {
      const output = Array.from(
        { length: channels },
        () => new Float32Array(count),
      );
      let written = 0;
      while (written < count) {
        const position = frame + written;
        const decoded = await packet(Math.floor(position / 64));
        const first = position % 64;
        const copied = Math.min(count - written, 64 - first);
        for (let channel = 0; channel < channels; channel++)
          output[channel].set(
            decoded[channel].subarray(first, first + copied),
            written,
          );
        written += copied;
      }
      return output;
    },
    reset,
    () => {},
  );
}
