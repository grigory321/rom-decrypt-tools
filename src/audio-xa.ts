import type { AudioDecoder, ByteSource, DecoderOptions } from './contracts.js';
import { Bin, check } from './binary.js';
import { readAudio, signedNibble, clamp16 } from './audio-codecs.js';
import type { RawSectorSize } from './disc-sources.js';
import { rawSectorPayload } from './disc-sources.js';
import { cooperativeYield } from './cooperative.js';

interface XaSelection {
  file: number;
  channel: number;
  coding: number;
  start: number;
}

const coefficients = [
  [0, 0],
  [60, 0],
  [115, -52],
  [98, -55],
];

export function isXaSector(
  bytes: Uint8Array,
  sectorSize: RawSectorSize = 2352,
) {
  const header = sectorSize === 2352 ? 16 : 0;
  return (
    bytes.length >= header + 8 &&
    (!header ||
      (bytes[0] === 0 &&
        bytes[11] === 0 &&
        bytes.subarray(1, 11).every((value) => value === 255) &&
        bytes[15] === 2)) &&
    bytes
      .subarray(header, header + 4)
      .every((value, index) => value === bytes[index + header + 4])
  );
}

function audioSector(bytes: Uint8Array, sectorSize: RawSectorSize) {
  const header = sectorSize === 2352 ? 16 : 0;
  return (
    isXaSector(bytes, sectorSize) &&
    (bytes[header + 2] & 0x0e) === 4 &&
    bytes[header + 1] !== 255
  );
}

export function inspectXaAudioSector(
  bytes: Uint8Array,
  sectorSize: RawSectorSize = 2352,
) {
  if (!audioSector(bytes, sectorSize)) return null;
  rawSectorPayload(bytes, 2, sectorSize, true);
  const header = sectorSize === 2352 ? 16 : 0;
  const coding = bytes[header + 3];
  check(
    (coding & 3) <= 1 &&
      ((coding >> 2) & 3) <= 1 &&
      ((coding >> 4) & 3) <= 1 &&
      (coding & 0xc0) === 0,
    'CODEC',
    'XA supports 4-bit or 8-bit audio without emphasis',
  );
  const units = coding & 16 ? 4 : 8;
  const groups = bytes[header + 2] & 32 ? 18 : 16;
  for (let group = 0; group < groups; group++) {
    const offset = header + 8 + group * 128;
    for (let index = 0; index < 4; index++)
      check(
        bytes[offset + index] === bytes[offset + index + 4] &&
          (units === 4 ||
            bytes[offset + index + 8] === bytes[offset + index + 12]),
        'INVALID_AUDIO',
        'XA duplicated sound parameters',
      );
    for (let unit = 0; unit < units; unit++) {
      const parameter = bytes[offset + 4 + unit];
      check(
        parameter >> 4 < 4 && (parameter & 15) <= 12,
        'INVALID_AUDIO',
        'XA sound parameter',
      );
    }
  }
  return {
    file: bytes[header],
    channel: bytes[header + 1],
    coding,
    end: !!(bytes[header + 2] & 128),
    frames: (groups * units * 28) / ((coding & 1) + 1),
  };
}

function decodeSector(
  bytes: Uint8Array,
  channels: number,
  states: { h1: number; h2: number }[],
  header: number,
) {
  const bits = bytes[header + 3] & 0x10 ? 8 : 4;
  const units = bits === 8 ? 4 : 8;
  const groups = bytes[header + 2] & 0x20 ? 18 : 16,
    count = (groups * units * 28) / channels,
    output = Array.from({ length: channels }, () => new Float32Array(count));
  for (let group = 0; group < groups; group++) {
    const offset = header + 8 + group * 128;
    for (let index = 0; index < 4; index++)
      check(
        bytes[offset + index] === bytes[offset + index + 4] &&
          (bits === 8 ||
            bytes[offset + index + 8] === bytes[offset + index + 12]),
        'INVALID_AUDIO',
      );
    for (let channel = 0; channel < channels; channel++) {
      const state = states[channel];
      for (let unit = 0; unit < units / channels; unit++) {
        const parameter = bytes[offset + 4 + unit * channels + channel],
          predictor = parameter >> 4,
          shift = parameter & 15;
        check(predictor < 4 && shift <= 12, 'INVALID_AUDIO');
        const [first, second] = coefficients[predictor];
        for (let index = 0; index < 28; index++) {
          const column =
            bits === 8
              ? unit * channels + channel
              : channels === 2
                ? unit
                : unit >> 1;
          const value = bytes[offset + 16 + index * 4 + column];
          const high = channels === 2 ? channel : unit & 1;
          const encoded =
            bits === 8
              ? value < 128
                ? value
                : value - 256
              : signedNibble((value >> (high ? 4 : 0)) & 15);
          const sample = clamp16(
            ((encoded * (bits === 8 ? 256 : 4096)) >> shift) +
              ((first * state.h1 + second * state.h2 + 32) >> 6),
          );
          state.h2 = state.h1;
          state.h1 = sample;
          output[channel][(group * units * 28) / channels + unit * 28 + index] =
            sample / 32768;
        }
      }
    }
  }
  return output;
}

export async function createXaDecoder(
  source: ByteSource,
  options: DecoderOptions = {},
  sectorSize: RawSectorSize = 2352,
): Promise<AudioDecoder> {
  const abort = () =>
    check(
      !options.signal?.aborted &&
        !options.cancelled?.() &&
        !options.isCancelled?.(),
      'CANCELLED',
    );
  abort();
  const checkpoint = cooperativeYield(abort);
  check(
    options.xaFrames === undefined ||
      (Number.isSafeInteger(options.xaFrames) && options.xaFrames >= 0),
    'INVALID_AUDIO',
    'Invalid XA frame count',
  );
  check(
    Number.isSafeInteger(source.size) && source.size >= sectorSize,
    'INVALID_AUDIO',
  );
  const subheader = sectorSize === 2352 ? 16 : 0;
  const header = new Bin(await readAudio(source, 0, Math.min(source.size, 44)));
  const start =
    sectorSize === 2352 &&
    header.str(0, 4) === 'RIFF' &&
    header.str(8, 4) === 'CDXA'
      ? 44
      : 0;
  abort();
  check((source.size - start) % sectorSize === 0, 'INVALID_AUDIO');
  let selected: XaSelection | null = null;
  let cache: Uint8Array = new Uint8Array(0);
  let cacheOffset = start;
  for (
    let offset = start;
    offset + sectorSize <= source.size;
    offset += sectorSize
  ) {
    abort();
    if (
      offset < cacheOffset ||
      offset + sectorSize > cacheOffset + cache.length
    ) {
      await checkpoint();
      cacheOffset = offset;
      cache = await readAudio(
        source,
        offset,
        Math.min(sectorSize * 27, source.size - offset),
      );
    }
    const sector = cache.subarray(
      offset - cacheOffset,
      offset - cacheOffset + sectorSize,
    );
    abort();
    if (
      audioSector(sector, sectorSize) &&
      (options.xaFile === undefined || sector[subheader] === options.xaFile) &&
      (options.xaChannel === undefined ||
        sector[subheader + 1] === options.xaChannel) &&
      (options.xaCoding === undefined ||
        sector[subheader + 3] === options.xaCoding)
    ) {
      inspectXaAudioSector(sector, sectorSize);
      selected = {
        file: sector[subheader],
        channel: sector[subheader + 1],
        coding: sector[subheader + 3],
        start: offset,
      };
      break;
    }
  }
  check(selected, 'INVALID_AUDIO', 'No matching XA audio channel');
  check(
    (selected.coding & 3) <= 1 &&
      ((selected.coding >> 2) & 3) <= 1 &&
      ((selected.coding >> 4) & 3) <= 1 &&
      (selected.coding & 0xc0) === 0,
    'CODEC',
    'XA supports 4-bit or 8-bit audio without emphasis',
  );
  const channels = (selected.coding & 1) + 1,
    sampleRate = selected.coding & 4 ? 18900 : 37800;
  const selection = selected;
  let traversed = 0;
  let cursor = selection.start,
    states: { h1: number; h2: number }[] = [],
    pending: Float32Array[] = [],
    pendingPosition = 0,
    ended = false,
    frame = 0;
  function reset() {
    cursor = selection.start;
    states = Array.from({ length: channels }, () => ({ h1: 0, h2: 0 }));
    pending = [];
    pendingPosition = 0;
    ended = false;
    frame = 0;
  }
  reset();
  const decoder: AudioDecoder = {
    sampleRate,
    channels,
    length: options.xaFrames ?? null,
    loop: false,
    loopStart: 0,
    loopEnd: options.xaFrames ?? null,
    get frame() {
      return frame;
    },
    reset,
    async seek(target) {
      abort();
      check(Number.isSafeInteger(target) && target >= 0, 'INVALID_AUDIO');
      reset();
      while (frame < target) {
        const block = await decoder.read(Math.min(16384, target - frame));
        if (!block.channels[0].length) break;
      }
    },
    async read(frames = 8192) {
      abort();
      check(Number.isSafeInteger(frames) && frames > 0, 'INVALID_AUDIO');
      const count = Math.min(frames, 16384),
        output = Array.from(
          { length: channels },
          () => new Float32Array(count),
        );
      let written = 0;
      while (written < count) {
        if (!pending.length || pendingPosition === pending[0].length) {
          pending = [];
          if (ended) break;
          while (cursor + sectorSize <= source.size) {
            abort();
            const sector = await readAudio(source, cursor, sectorSize);
            abort();
            cursor += sectorSize;
            if ((++traversed & 15) === 0) await checkpoint();
            rawSectorPayload(sector, 0, sectorSize, true);
            if (
              !audioSector(sector, sectorSize) ||
              sector[subheader] !== selection.file ||
              sector[subheader + 1] !== selection.channel
            )
              continue;
            if (
              options.xaCoding !== undefined &&
              sector[subheader + 3] !== options.xaCoding
            )
              continue;
            check(
              sector[subheader + 3] === selection.coding,
              'CODEC',
              'XA coding changed',
            );
            pending = decodeSector(sector, channels, states, subheader);
            pendingPosition = 0;
            if (sector[subheader + 2] & 0x80) ended = true;
            break;
          }
          if (!pending.length) {
            ended = true;
            break;
          }
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
      frame += written;
      return {
        channels:
          written === count
            ? output
            : output.map((channel) => channel.subarray(0, written)),
        sampleRate,
        length: options.xaFrames ?? null,
        done:
          ended && (!pending.length || pendingPosition === pending[0].length),
        frame,
      };
    },
  };
  return decoder;
}
