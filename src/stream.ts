import type { AudioDecoder, PcmData } from './contracts.js';
import type { InitialChannelState } from './audio-types.js';
import { Bin, check, align } from './binary.js';
import { decodeSwav, decodeNitro, ima } from './nitro.js';

interface StreamState extends InitialChannelState {
  hist?: number;
}
interface StreamChannelDefinition {
  stateOff: number;
  offset?: number;
  raw?: Uint8Array;
}
interface SampleReader {
  next(): number;
  reset(): void;
}

export function dsp(
  data: Uint8Array,
  coefs: number[],
  samples: number,
  h1 = 0,
  h2 = 0,
) {
  const out = new Float32Array(samples);
  let at = 0;
  for (let off = 0; off < data.length && at < samples; off += 8) {
    const header = data[off],
      scale = 2 ** (header & 15),
      predictor = header >> 4;
    check(predictor <= 7, 'INVALID_AUDIO');
    for (let i = 0; i < 14 && at < samples; i++) {
      check(off + 1 + (i >> 1) < data.length, 'BOUNDS');
      let nib = (data[off + 1 + (i >> 1)] >> (i & 1 ? 0 : 4)) & 15;
      if (nib >= 8) {
        nib -= 16;
      }
      const v = Math.max(
        -32768,
        Math.min(
          32767,
          Math.floor(
            (nib * scale * 2048 +
              1024 +
              coefs[predictor * 2] * h1 +
              coefs[predictor * 2 + 1] * h2) /
              2048,
          ),
        ),
      );
      out[at++] = v / 32768;
      h2 = h1;
      h1 = v;
    }
  }
  check(at === samples, 'INVALID_AUDIO');
  return out;
}

const join = (parts: Uint8Array[]) => {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let o = 0;
  for (const p of parts) {
    out.set(p, o);
    o += p.length;
  }
  return out;
};

function pcm(
  data: Uint8Array,
  codec: number,
  samples: number,
  le = true,
  state: StreamState | null = null,
) {
  const b = new Bin(data);
  if (codec === 0) {
    check(data.length >= samples, 'BOUNDS');
    return Float32Array.from(
      data.subarray(0, samples),
      (x) => (x >= 128 ? x - 256 : x) / 128,
    );
  }
  if (codec === 1) {
    check(data.length >= samples * 2, 'BOUNDS');
    return Float32Array.from(
      {
        length: samples,
      },
      (_, i) => b.i16(i * 2, le) / 32768,
    );
  }
  if (codec === 2) {
    check(state?.coefs, 'INVALID_AUDIO');
    return dsp(data, state.coefs, samples, state.h1 || 0, state.h2 || 0);
  }
  if (codec === 3) {
    const out = ima(data, state?.hist || 0, state?.index || 0);
    check(out.length >= samples, 'BOUNDS');
    return out.subarray(0, samples);
  }
  check(false, 'CODEC', String(codec));
}

export function decodeStream(data: Uint8Array): PcmData {
  const b = new Bin(data),
    magic = b.str(0, 4);
  if (magic === 'SWAV') {
    return decodeSwav(data);
  }
  if (magic === 'STRM') {
    const codec = b.u8(24),
      channels = b.u8(26),
      rate = b.u16(28),
      samples = b.u32(36),
      blocks = b.u32(44),
      blockSize = b.u32(48),
      blockSamples = b.u32(52),
      lastSize = b.u32(56),
      lastSamples = b.u32(60);
    check(
      channels >= 1 &&
        channels <= 8 &&
        samples > 0 &&
        samples * channels * 4 <= 128 * 1024 * 1024 &&
        blocks > 0 &&
        blocks <= 1e5,
      'TOO_LARGE',
    );
    check(
      codec <= 2 &&
        rate >= 1e3 &&
        rate <= 192e3 &&
        (blocks - 1) * blockSamples + lastSamples === samples,
      'INVALID_AUDIO',
    );
    const needed = (n: number) =>
      codec === 0 ? n : codec === 1 ? n * 2 : 4 + Math.ceil(n / 2);
    for (let i = 0; i < blocks; i++) {
      const count = i === blocks - 1 ? lastSamples : blockSamples,
        n =
          (i === blocks - 1 ? lastSize : blockSize) +
          (blocks === 1 && codec === 2 ? 4 : 0);
      check(
        n >= needed(count) && n <= needed(count) + 3 && n <= 4 * 1024 * 1024,
        'INVALID_AUDIO',
      );
    }
    const out = Array.from(
      {
        length: channels,
      },
      () => new Float32Array(samples),
    );
    let off = b.u32(40),
      written = 0;
    for (let i = 0; i < blocks; i++) {
      const count = i === blocks - 1 ? lastSamples : blockSamples,
        n =
          (i === blocks - 1 ? lastSize : blockSize) +
          (blocks === 1 && codec === 2 ? 4 : 0);
      for (let c = 0; c < channels; c++) {
        const decoded = decodeNitro(b.slice(off, n), codec);
        check(decoded.length >= count, 'INVALID_AUDIO');
        out[c].set(decoded.subarray(0, count), written);
        off += n;
      }
      written += count;
      off = align(off, 4);
    }
    return {
      channels: out,
      sampleRate: rate,
      loop: !!b.u8(25),
      loopStart: b.u32(32),
      loopEnd: samples,
    };
  }
  check(['CWAV', 'FWAV', 'CSTM', 'FSTM'].includes(magic), 'FORMAT', magic);
  const le = b.u16(4) === 65279,
    u32 = (o: number) => b.u32(o, le),
    u16 = (o: number) => b.u16(o, le);
  const sectionCount = u16(16);
  check(sectionCount <= 16, 'INVALID_AUDIO');
  const sections: Partial<Record<string, number>> = {};
  for (let i = 0; i < sectionCount; i++) {
    const o = u32(24 + i * 12);
    sections[b.str(o, 4)] = o;
  }
  const info = sections.INFO,
    dataOff = sections.DATA;
  check(info && dataOff, 'INVALID_AUDIO');
  let codec: number,
    rate: number,
    samples: number,
    loop: boolean,
    loopStart: number,
    channels: number,
    table: number,
    channelDefs: StreamChannelDefinition[] = [];
  if (magic.endsWith('WAV')) {
    codec = b.u8(info + 8);
    loop = !!b.u8(info + 9);
    rate = u32(info + 12);
    loopStart = u32(info + 16);
    samples = u32(info + 20);
    table = info + 28;
    channels = u32(table);
    check(
      channels >= 1 &&
        channels <= 8 &&
        samples > 0 &&
        samples * channels * 4 <= 128 * 1024 * 1024,
      'TOO_LARGE',
    );
    for (let c = 0; c < channels; c++) {
      const def = table + u32(table + 8 + c * 8),
        offset = dataOff + 8 + u32(def + 4),
        stateOff = def + u32(def + 12);
      channelDefs.push({
        offset,
        stateOff,
      });
    }
  } else {
    const p = info + 8 + u32(info + 12);
    codec = b.u8(p);
    loop = !!b.u8(p + 1);
    channels = b.u8(p + 2);
    rate = u32(p + 4);
    loopStart = u32(p + 8);
    samples = u32(p + 12);
    table = info + 8 + u32(info + 28);
    check(
      channels >= 1 &&
        channels <= 8 &&
        samples > 0 &&
        samples * channels * 4 <= 128 * 1024 * 1024,
      'TOO_LARGE',
    );
    const blocks = u32(p + 16),
      blockSize = u32(p + 20),
      lastBytes = u32(p + 28),
      lastStride = u32(p + 36);
    check(
      blocks > 0 && blocks <= 1e5 && blockSize <= 16 * 1024 * 1024,
      'INVALID_AUDIO',
    );
    const chunks = Array.from(
      {
        length: channels,
      },
      (): Uint8Array[] => [],
    );
    let offset = dataOff + 8 + u32(p + 52);
    for (let i = 0; i < blocks; i++) {
      const size = i === blocks - 1 ? lastBytes : blockSize,
        stride = i === blocks - 1 ? lastStride : blockSize;
      check(stride >= size, 'INVALID_AUDIO');
      for (let c = 0; c < channels; c++) {
        chunks[c].push(b.slice(offset, size));
        offset += stride;
      }
    }
    for (let c = 0; c < channels; c++) {
      const def = table + u32(table + 8 + c * 8),
        stateOff = def + u32(def + 4);
      channelDefs.push({
        raw: join(chunks[c]),
        stateOff,
      });
    }
  }
  check(rate >= 1e3 && rate <= 192e3, 'INVALID_AUDIO');
  const out: Float32Array[] = [];
  for (const def of channelDefs) {
    const state: StreamState = {};
    if (codec === 2) {
      state.coefs = Array.from(
        {
          length: 16,
        },
        (_, i) => b.i16(def.stateOff + i * 2, le),
      );
      state.h1 = b.i16(def.stateOff + 34, le);
      state.h2 = b.i16(def.stateOff + 36, le);
    }
    if (codec === 3) {
      state.hist = b.i16(def.stateOff, le);
      state.index = u16(def.stateOff + 2);
    }
    const size =
      codec === 0
        ? samples
        : codec === 1
          ? samples * 2
          : codec === 2
            ? Math.ceil(samples / 14) * 8
            : Math.ceil(samples / 2);
    let raw: Uint8Array;
    if (def.raw) raw = def.raw;
    else {
      check(def.offset !== undefined, 'INVALID_AUDIO');
      raw = b.slice(def.offset, size);
    }
    out.push(pcm(raw, codec, samples, le, state));
  }
  return {
    channels: out,
    sampleRate: rate,
    loop,
    loopStart,
    loopEnd: samples,
  };
}

const imaSteps = [
  7, 8, 9, 10, 11, 12, 13, 14, 16, 17, 19, 21, 23, 25, 28, 31, 34, 37, 41, 45,
  50, 55, 60, 66, 73, 80, 88, 97, 107, 118, 130, 143, 157, 173, 190, 209, 230,
  253, 279, 307, 337, 371, 408, 449, 494, 544, 598, 658, 724, 796, 876, 963,
  1060, 1166, 1282, 1411, 1552, 1707, 1878, 2066, 2272, 2499, 2749, 3024, 3327,
  3660, 4026, 4428, 4871, 5358, 5894, 6484, 7132, 7845, 8630, 9493, 10442,
  11487, 12635, 13899, 15289, 16818, 18500, 20350, 22385, 24623, 27086, 29794,
  32767,
];

const imaIndices = [-1, -1, -1, -1, 2, 4, 6, 8];

const clamp16 = (v: number) => Math.max(-32768, Math.min(32767, v));

function channelReader(
  byte: (offset: number) => number,
  codec: number,
  le = true,
  initial: InitialChannelState = {},
) {
  let at = 0,
    h1 = 0,
    h2 = 0,
    index = 0,
    scale = 0,
    predictor = 0;
  function reset() {
    at = 0;
    h1 = initial.h1 || 0;
    h2 = initial.h2 || 0;
    index = initial.index || 0;
    scale = 0;
    predictor = 0;
  }
  function next() {
    let v: number;
    if (codec === 0) {
      v = byte(at++);
      return (v >= 128 ? v - 256 : v) / 128;
    }
    if (codec === 1) {
      const a = byte(at * 2),
        b = byte(at * 2 + 1);
      at++;
      v = le ? a + b * 256 : b + a * 256;
      return (v >= 32768 ? v - 65536 : v) / 32768;
    }
    if (codec === 2) {
      const coefs = initial.coefs;
      check(coefs, 'INVALID_AUDIO');
      const n = at % 14,
        off = Math.floor(at / 14) * 8;
      if (n === 0) {
        const header = byte(off);
        scale = 2 ** (header & 15);
        predictor = header >> 4;
        check(predictor <= 7, 'INVALID_AUDIO');
      }
      let nib = (byte(off + 1 + (n >> 1)) >> (n & 1 ? 0 : 4)) & 15;
      if (nib >= 8) {
        nib -= 16;
      }
      v = clamp16(
        Math.floor(
          (nib * scale * 2048 +
            1024 +
            coefs[predictor * 2] * h1 +
            coefs[predictor * 2 + 1] * h2) /
            2048,
        ),
      );
      h2 = h1;
      h1 = v;
      at++;
      return v / 32768;
    }
    const nib = (byte(Math.floor(at / 2)) >> ((at & 1) * 4)) & 15,
      s = imaSteps[index];
    let diff = s >> 3;
    if (nib & 1) {
      diff += s >> 2;
    }
    if (nib & 2) {
      diff += s >> 1;
    }
    if (nib & 4) {
      diff += s;
    }
    h1 = clamp16(h1 + (nib & 8 ? -diff : diff));
    index = Math.max(0, Math.min(88, index + imaIndices[nib & 7]));
    at++;
    return h1 / 32768;
  }
  reset();
  return {
    next,
    reset,
  };
}

function encodedBytes(codec: number, samples: number, fullDspFrame = false) {
  check(codec >= 0 && codec <= 3, 'CODEC', String(codec));
  if (codec === 0) {
    return samples;
  }
  if (codec === 1) {
    return samples * 2;
  }
  if (codec === 3) {
    return Math.ceil(samples / 2);
  }
  const remainder = samples % 14;
  return (
    Math.floor(samples / 14) * 8 +
    (remainder ? (fullDspFrame ? 8 : 1 + Math.ceil(remainder / 2)) : 0)
  );
}

export function createStreamDecoder(data: Uint8Array): AudioDecoder {
  check(data instanceof Uint8Array, 'INVALID_AUDIO');
  check(data.length <= 128 * 1024 * 1024, 'TOO_LARGE');
  const b = new Bin(data),
    magic = b.str(0, 4);
  let sampleRate = 0,
    channels = 0,
    length = 0,
    loop = false,
    loopStart = 0,
    readers: SampleReader[] = [];
  const validate = () => {
    check(
      channels >= 1 &&
        channels <= 8 &&
        Number.isSafeInteger(length) &&
        length >= 0,
      'TOO_LARGE',
    );
    check(sampleRate >= 1e3 && sampleRate <= 192e3, 'INVALID_AUDIO');
  };
  const contiguous = (offset: number, size: number) => {
    b.range(offset, size);
    return (i: number) => b.u8(offset + i);
  };
  if (magic === 'SWAV') {
    const type = b.u8(24),
      words = b.u16(30) + b.u32(32),
      size = words * 4,
      offset = 36;
    check(type <= 2, 'CODEC', String(type));
    b.range(offset, size);
    sampleRate = b.u16(26);
    channels = 1;
    loop = !!b.u8(25);
    length = type === 0 ? size : type === 1 ? size / 2 : (size - 4) * 2;
    loopStart = Math.max(
      0,
      b.u16(30) * (type === 0 ? 4 : type === 1 ? 2 : 8) - (type === 2 ? 8 : 0),
    );
    validate();
    if (type === 2) {
      check(size >= 4, 'INVALID_AUDIO');
      const index = b.u8(offset + 2);
      check(index <= 88, 'INVALID_AUDIO');
      readers.push(
        channelReader(contiguous(offset + 4, size - 4), 3, true, {
          h1: b.i16(offset),
          index,
        }),
      );
    } else {
      readers.push(channelReader(contiguous(offset, size), type));
    }
  } else if (magic === 'STRM') {
    const codec = b.u8(24),
      blocks = b.u32(44),
      blockSize = b.u32(48),
      blockSamples = b.u32(52),
      lastSize = b.u32(56) + (blocks === 1 && codec === 2 ? 4 : 0),
      lastSamples = b.u32(60),
      start = b.u32(40);
    sampleRate = b.u16(28);
    channels = b.u8(26);
    length = b.u32(36);
    loop = !!b.u8(25);
    loopStart = b.u32(32);
    validate();
    check(
      codec <= 2 &&
        length > 0 &&
        blocks > 0 &&
        blocks <= 1e5 &&
        lastSamples > 0 &&
        (blocks === 1 || blockSamples > 0) &&
        (blocks - 1) * blockSamples + lastSamples === length,
      'INVALID_AUDIO',
    );
    const needed = (n: number) =>
        codec === 0 ? n : codec === 1 ? n * 2 : 4 + Math.ceil(n / 2),
      regularBytes = needed(blockSamples),
      finalBytes = needed(lastSamples);
    if (blocks > 1) {
      check(
        blockSize >= regularBytes &&
          blockSize <= regularBytes + 3 &&
          blockSize <= 4 * 1024 * 1024,
        'INVALID_AUDIO',
      );
    }
    check(
      lastSize >= finalBytes &&
        lastSize <= finalBytes + 3 &&
        lastSize <= 4 * 1024 * 1024,
      'INVALID_AUDIO',
    );
    const firstEnd = align(start + blockSize * channels, 4),
      stride = align(blockSize * channels, 4),
      blockOffset = (i: number) =>
        i === 0 ? start : firstEnd + (i - 1) * stride;
    b.range(start, blockOffset(blocks - 1) + lastSize * channels - start);
    for (let c = 0; c < channels; c++) {
      let block = -1,
        left = 0,
        offset = 0;
      const initial: InitialChannelState = {},
        current = channelReader(
          (i: number) => b.u8(offset + i),
          codec === 2 ? 3 : codec,
          true,
          initial,
        );
      function begin() {
        const size = block === blocks - 1 ? lastSize : blockSize;
        offset = blockOffset(block) + c * size;
        left = block === blocks - 1 ? lastSamples : blockSamples;
        if (codec === 2) {
          initial.index = b.u8(offset + 2);
          check(initial.index <= 88, 'INVALID_AUDIO');
          initial.h1 = b.i16(offset);
          offset += 4;
        }
        current.reset();
      }
      const reset = () => {
        block = -1;
        left = 0;
        current.reset();
      };
      readers.push({
        reset,
        next() {
          if (!left) {
            block++;
            begin();
          }
          left--;
          return current.next();
        },
      });
      reset();
    }
  } else {
    check(['CWAV', 'FWAV', 'CSTM', 'FSTM'].includes(magic), 'FORMAT', magic);
    const le = b.u16(4) === 65279,
      u32 = (o: number) => b.u32(o, le),
      u16 = (o: number) => b.u16(o, le),
      sectionCount = u16(16),
      sections: Partial<Record<string, number>> = {};
    check(sectionCount <= 16, 'INVALID_AUDIO');
    b.range(20, sectionCount * 12);
    for (let i = 0; i < sectionCount; i++) {
      const offset = u32(24 + i * 12);
      sections[b.str(offset, 4)] = offset;
    }
    const info = sections.INFO,
      dataOff = sections.DATA;
    check(info && dataOff, 'INVALID_AUDIO');
    let codec: number,
      table: number,
      byteAt: ((channel: number, offset: number) => number) | undefined,
      available = 0;
    const isWave = magic.endsWith('WAV');
    if (isWave) {
      codec = b.u8(info + 8);
      loop = !!b.u8(info + 9);
      sampleRate = u32(info + 12);
      loopStart = u32(info + 16);
      length = u32(info + 20);
      table = info + 28;
      channels = u32(table);
      validate();
      check(length > 0, 'INVALID_AUDIO');
    } else {
      const p = info + 8 + u32(info + 12);
      codec = b.u8(p);
      loop = !!b.u8(p + 1);
      channels = b.u8(p + 2);
      sampleRate = u32(p + 4);
      loopStart = u32(p + 8);
      length = u32(p + 12);
      table = info + 8 + u32(info + 28);
      validate();
      check(length > 0, 'INVALID_AUDIO');
      const blocks = u32(p + 16),
        blockSize = u32(p + 20),
        lastBytes = u32(p + 28),
        lastStride = u32(p + 36),
        start = dataOff + 8 + u32(p + 52);
      check(
        blocks > 0 &&
          blocks <= 1e5 &&
          blockSize <= 16 * 1024 * 1024 &&
          (blocks === 1 || blockSize > 0) &&
          lastStride >= lastBytes,
        'INVALID_AUDIO',
      );
      const regular = (blocks - 1) * blockSize;
      available = regular + lastBytes;
      b.range(
        start,
        regular * channels + lastStride * (channels - 1) + lastBytes,
      );
      byteAt = (c: number, i: number) =>
        i < regular
          ? b.u8(
              start +
                Math.floor(i / blockSize) * blockSize * channels +
                c * blockSize +
                (i % blockSize),
            )
          : b.u8(start + regular * channels + c * lastStride + i - regular);
    }
    const needed = encodedBytes(codec, length, isWave);
    b.range(table + 8, channels * 8);
    for (let c = 0; c < channels; c++) {
      const def = table + u32(table + 8 + c * 8),
        stateOff = def + u32(def + (isWave ? 12 : 4)),
        initial: InitialChannelState = {};
      if (codec === 2) {
        initial.coefs = Array.from(
          {
            length: 16,
          },
          (_, i) => b.i16(stateOff + i * 2, le),
        );
        initial.h1 = b.i16(stateOff + 34, le);
        initial.h2 = b.i16(stateOff + 36, le);
      }
      if (codec === 3) {
        initial.h1 = b.i16(stateOff, le);
        initial.index = u16(stateOff + 2);
        check(initial.index <= 88, 'INVALID_AUDIO');
      }
      if (isWave) {
        readers.push(
          channelReader(
            contiguous(dataOff + 8 + u32(def + 4), needed),
            codec,
            le,
            initial,
          ),
        );
      } else {
        check(needed <= available, 'BOUNDS');
        check(byteAt, 'INVALID_AUDIO');
        const at = byteAt;
        readers.push(channelReader((i) => at(c, i), codec, le, initial));
      }
    }
  }
  let frame = 0;
  return {
    sampleRate,
    channels,
    length,
    loop,
    loopStart,
    loopEnd: length,
    get frame() {
      return frame;
    },
    reset() {
      frame = 0;
      for (const reader of readers) {
        reader.reset();
      }
    },
    read(frames = 8192) {
      check(Number.isSafeInteger(frames) && frames > 0, 'INVALID_AUDIO');
      const count = Math.min(frames, 16384, length - frame),
        out = readers.map(() => new Float32Array(count));
      for (let c = 0; c < channels; c++) {
        for (let i = 0; i < count; i++) {
          out[c][i] = readers[c].next();
        }
      }
      frame += count;
      return {
        channels: out,
        sampleRate,
        done: frame === length,
        frame,
      };
    },
  };
}
