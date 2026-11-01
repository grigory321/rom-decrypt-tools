import type { AudioDecoder, ByteSource } from './contracts.js';
import { Bin, bounds, check } from './binary.js';
import { audioDecoder, readAudio } from './audio-codecs.js';
import { ima4Decoder } from './audio-ima4.js';

type PcmCodec = 's8' | 's16' | 's24' | 's32' | 'f32' | 'f64' | 'mulaw' | 'alaw';
interface PcmLayout {
  channels: number;
  sampleRate: number;
  length: number;
  start: number;
  size: number;
  codec: PcmCodec;
  littleEndian?: boolean;
  loop?: { start: number; end: number };
}

const widths = {
  s8: 1,
  s16: 2,
  s24: 3,
  s32: 4,
  f32: 4,
  f64: 8,
  mulaw: 1,
  alaw: 1,
};

function sampleValue(
  bytes: Uint8Array,
  view: DataView,
  offset: number,
  codec: PcmCodec,
  littleEndian: boolean,
) {
  if (codec === 's8') return view.getInt8(offset) / 128;
  if (codec === 's16') return view.getInt16(offset, littleEndian) / 32768;
  if (codec === 's24') {
    const value = littleEndian
      ? bytes[offset] | (bytes[offset + 1] << 8) | (bytes[offset + 2] << 16)
      : (bytes[offset] << 16) | (bytes[offset + 1] << 8) | bytes[offset + 2];
    return ((value << 8) >> 8) / 8388608;
  }
  if (codec === 's32') return view.getInt32(offset, littleEndian) / 2147483648;
  if (codec === 'f32' || codec === 'f64') {
    const value =
      codec === 'f32'
        ? view.getFloat32(offset, littleEndian)
        : view.getFloat64(offset, littleEndian);
    check(Number.isFinite(value), 'INVALID_AUDIO');
    return Math.max(-1, Math.min(1, value));
  }
  if (codec === 'mulaw') {
    const value = bytes[offset] ^ 255;
    const magnitude =
      (((value & 15) << 3) + 132) * 2 ** ((value >> 4) & 7) - 132;
    return magnitude === 0 ? 0 : (value & 128 ? -magnitude : magnitude) / 32768;
  }
  const value = bytes[offset] ^ 85;
  const exponent = (value >> 4) & 7;
  const magnitude =
    exponent === 0
      ? ((value & 15) << 4) + 8
      : (((value & 15) << 4) + 264) * 2 ** (exponent - 1);
  return (value & 128 ? magnitude : -magnitude) / 32768;
}

function pcmDecoder(
  source: ByteSource,
  {
    channels,
    sampleRate,
    length,
    start,
    size,
    codec,
    littleEndian = false,
    loop,
  }: PcmLayout,
) {
  check(
    Number.isInteger(channels) && channels >= 1 && channels <= 8,
    'INVALID_AUDIO',
  );
  const width = widths[codec];
  check(width, 'CODEC', codec);
  const stride = channels * width;
  bounds(source.size, start, size);
  check(
    Number.isSafeInteger(length) &&
      length > 0 &&
      length <= Math.floor(size / stride),
    'INVALID_AUDIO',
  );
  return audioDecoder(
    {
      channels,
      sampleRate,
      length,
      loop: !!loop,
      loopStart: loop?.start,
      loopEnd: loop?.end,
    },
    async (frames, position) => {
      const output = Array.from(
        { length: channels },
        () => new Float32Array(frames),
      );
      let written = 0;
      while (written < frames) {
        const count = Math.min(frames - written, Math.floor(65536 / stride));
        const bytes = await readAudio(
          source,
          start + (position + written) * stride,
          count * stride,
        );
        const view = new DataView(
          bytes.buffer,
          bytes.byteOffset,
          bytes.byteLength,
        );
        for (let frame = 0; frame < count; frame++)
          for (let channel = 0; channel < channels; channel++)
            output[channel][written + frame] = sampleValue(
              bytes,
              view,
              frame * stride + channel * width,
              codec,
              littleEndian,
            );
        written += count;
      }
      return output;
    },
    () => {},
    () => {},
  );
}

function extendedRate(header: Bin, offset: number) {
  const exponent = header.u16(offset, false);
  check(!(exponent & 0x8000) && exponent !== 0x7fff, 'INVALID_AUDIO');
  return (
    (header.u32(offset + 2, false) +
      header.u32(offset + 6, false) / 4294967296) *
    2 ** (exponent - 16383 - 31)
  );
}

async function aiffMarkers(source: ByteSource, start: number, size: number) {
  check(size >= 2, 'INVALID_AUDIO');
  const count = new Bin(await readAudio(source, start, 2)).u16(0, false);
  check(count <= 4096, 'TOO_MANY');
  const markers = new Map<number, number>();
  let offset = 2;
  for (let index = 0; index < count; index++) {
    bounds(size, offset, 7);
    const marker = new Bin(await readAudio(source, start + offset, 7));
    const id = marker.i16(0, false);
    check(id > 0 && !markers.has(id), 'INVALID_AUDIO');
    markers.set(id, marker.u32(2, false));
    const name = marker.u8(6) + 1;
    offset += 6 + name + (name & 1);
    bounds(size, offset, 0);
  }
  check(offset === size, 'INVALID_AUDIO');
  return markers;
}

export async function createAiffDecoder(
  source: ByteSource,
): Promise<AudioDecoder> {
  const header = new Bin(await readAudio(source, 0, 12));
  check(
    header.str(0, 4) === 'FORM' && ['AIFF', 'AIFC'].includes(header.str(8, 4)),
    'INVALID_AUDIO',
  );
  const end = header.u32(4, false) + 8;
  bounds(source.size, 0, end);
  const compressed = header.str(8, 4) === 'AIFC';
  let common: Bin | undefined,
    sound: { start: number; size: number } | undefined,
    markers: Map<number, number> | undefined,
    instrument: Bin | undefined,
    visited = 0;
  for (let offset = 12; offset < end;) {
    check(++visited <= 4096, 'TOO_MANY');
    bounds(end, offset, 8);
    const chunk = new Bin(await readAudio(source, offset, 8));
    const size = chunk.u32(4, false);
    const start = offset + 8;
    bounds(end, start, size);
    if (chunk.str(0, 4) === 'COMM') {
      check(!common && size >= (compressed ? 22 : 18), 'INVALID_AUDIO');
      common = new Bin(await readAudio(source, start, compressed ? 22 : 18));
    } else if (chunk.str(0, 4) === 'SSND') {
      check(!sound && size >= 8, 'INVALID_AUDIO');
      const info = new Bin(await readAudio(source, start, 8));
      check(info.u32(0, false) <= size - 8, 'INVALID_AUDIO');
      sound = {
        start: start + 8 + info.u32(0, false),
        size: size - 8 - info.u32(0, false),
      };
    } else if (chunk.str(0, 4) === 'MARK') {
      check(!markers, 'INVALID_AUDIO');
      markers = await aiffMarkers(source, start, size);
    } else if (chunk.str(0, 4) === 'INST') {
      check(!instrument && size === 20, 'INVALID_AUDIO');
      instrument = new Bin(await readAudio(source, start, 20));
    }
    offset = start + size + (size & 1);
    check(offset <= end, 'INVALID_AUDIO');
  }
  check(common && sound, 'INVALID_AUDIO');
  const bits = common.u16(6, false);
  const compression = compressed ? common.str(18, 4) : 'NONE';
  const length = common.u32(2, false) * (compression === 'ima4' ? 64 : 1);
  let loop: { start: number; end: number } | undefined;
  if (instrument) {
    const mode = instrument.u16(8, false);
    check(mode <= 2, 'INVALID_AUDIO');
    if (mode === 1) {
      const start = markers?.get(instrument.i16(10, false));
      const end = markers?.get(instrument.i16(12, false));
      if (start !== undefined && end !== undefined && start < end) {
        check(end <= length, 'INVALID_AUDIO');
        loop = { start, end };
      }
    }
  }
  if (compression === 'ima4') {
    check(bits === 4 || bits === 16, 'CODEC');
    return ima4Decoder(source, sound.start, sound.size, {
      channels: common.u16(0, false),
      length,
      sampleRate: extendedRate(common, 8),
      loop: !!loop,
      loopStart: loop?.start,
      loopEnd: loop?.end,
    });
  }
  const companded = ['alaw', 'ALAW', 'ulaw', 'ULAW'].includes(compression);
  check(
    [
      'NONE',
      'twos',
      'sowt',
      'fl32',
      'FL32',
      'fl64',
      'FL64',
      'alaw',
      'ALAW',
      'ulaw',
      'ULAW',
    ].includes(compression),
    'CODEC',
    compression,
  );
  const float = /^fl/i.test(compression);
  check(
    (companded ? [8, 16] : float ? [32, 64] : [8, 16, 24, 32]).includes(bits) &&
      (!float || Number(compression.slice(2)) === bits),
    'CODEC',
  );
  return pcmDecoder(source, {
    ...sound,
    channels: common.u16(0, false),
    length,
    sampleRate: extendedRate(common, 8),
    codec: companded
      ? compression.toLowerCase() === 'alaw'
        ? 'alaw'
        : 'mulaw'
      : float
        ? bits === 32
          ? 'f32'
          : 'f64'
        : bits === 8
          ? 's8'
          : bits === 16
            ? 's16'
            : bits === 24
              ? 's24'
              : 's32',
    littleEndian: compression === 'sowt',
    loop,
  });
}

export async function createAuDecoder(
  source: ByteSource,
): Promise<AudioDecoder> {
  const header = new Bin(await readAudio(source, 0, 24));
  check(header.str(0, 4) === '.snd', 'INVALID_AUDIO');
  const start = header.u32(4, false);
  const declared = header.u32(8, false);
  const size = declared === 0xffffffff ? source.size - start : declared;
  const auCodecs: Partial<Record<number, PcmCodec>> = {
    1: 'mulaw',
    2: 's8',
    3: 's16',
    4: 's24',
    5: 's32',
    6: 'f32',
    7: 'f64',
    27: 'alaw',
  };
  const codec = auCodecs[header.u32(12, false)];
  check(codec, 'CODEC');
  const channels = header.u32(20, false);
  check(
    start >= 24 &&
      channels >= 1 &&
      channels <= 8 &&
      size % (channels * widths[codec]) === 0,
    'INVALID_AUDIO',
  );
  return pcmDecoder(source, {
    start,
    size,
    codec,
    channels,
    length: size / (channels * widths[codec]),
    sampleRate: header.u32(16, false),
  });
}
