import type {
  AudioDecoder,
  OutputSource,
  ProgressReporter,
} from './contracts.js';
import { bounds, check } from './binary.js';
import { cooperativeYield } from './cooperative.js';

export interface AudioOutputOptions {
  format: string;
  bitrate?: number;
  seconds?: number;
  wholeSong?: boolean;
  report?: ProgressReporter;
  fade?: number;
  checkCurrent?: () => void;
}

const outputRate = 44100;
const blockFrames = 8192;
const readLimit = 4 * 1024 ** 2;

function wavHeader(length: number, sampleRate: number, channels: number) {
  const dataSize = length * channels * 2;
  const large = dataSize > 0xffffffff - 36;
  const bytes = new Uint8Array(large ? 80 : 44);
  const view = new DataView(bytes.buffer);
  const text = (offset: number, value: string) =>
    bytes.set(new TextEncoder().encode(value), offset);
  text(0, large ? 'RF64' : 'RIFF');
  view.setUint32(4, large ? 0xffffffff : dataSize + 36, true);
  text(8, 'WAVE');
  let offset = 12;
  if (large) {
    text(offset, 'ds64');
    view.setUint32(offset + 4, 28, true);
    view.setBigUint64(offset + 8, BigInt(dataSize + 72), true);
    view.setBigUint64(offset + 16, BigInt(dataSize), true);
    view.setBigUint64(offset + 24, BigInt(length), true);
    offset += 36;
  }
  text(offset, 'fmt ');
  view.setUint32(offset + 4, 16, true);
  view.setUint16(offset + 8, 1, true);
  view.setUint16(offset + 10, channels, true);
  view.setUint32(offset + 12, sampleRate, true);
  view.setUint32(offset + 16, sampleRate * channels * 2, true);
  view.setUint16(offset + 20, channels * 2, true);
  view.setUint16(offset + 22, 16, true);
  text(offset + 24, 'data');
  view.setUint32(offset + 28, large ? 0xffffffff : dataSize, true);
  return bytes;
}

function sequentialSource(
  size: number | null,
  generate: () => AsyncGenerator<Uint8Array, void, void>,
  checkCurrent: () => void,
  progress: () => number,
  delivery: Pick<OutputSource, 'chunkSize' | 'progressPhase'>,
): OutputSource {
  const iterator = generate();
  let position = 0;
  let pending: Uint8Array = new Uint8Array();
  let pendingOffset = 0;
  let reading = false;
  return {
    size,
    ...delivery,
    get progress() {
      return progress();
    },
    async read(offset: number, length: number) {
      checkCurrent();
      check(offset === position && !reading, 'STREAM_SEQUENCE');
      check(
        Number.isSafeInteger(length) && length > 0 && length <= readLimit,
        'BOUNDS',
      );
      if (size !== null) bounds(size, offset, length);
      reading = true;
      try {
        const bytes = new Uint8Array(length);
        let written = 0;
        while (written < length) {
          checkCurrent();
          if (pendingOffset === pending.length) {
            const next = await iterator.next();
            checkCurrent();
            if (next.done) break;
            pending = next.value;
            pendingOffset = 0;
          }
          const count = Math.min(
            length - written,
            pending.length - pendingOffset,
          );
          bytes.set(
            pending.subarray(pendingOffset, pendingOffset + count),
            written,
          );
          pendingOffset += count;
          written += count;
        }
        check(size === null || written === length, 'BOUNDS');
        position += written;
        return written === length ? bytes : bytes.slice(0, written);
      } finally {
        reading = false;
      }
    },
  };
}

function exportLength(decoder: AudioDecoder, seconds: number) {
  if (decoder.length !== null) return decoder.length;
  check(
    Number.isFinite(seconds) && seconds >= 1 && seconds <= 86400,
    'EXPORT_DURATION',
  );
  return Math.floor(seconds * decoder.sampleRate);
}

async function wholeSongLength(
  decoder: AudioDecoder,
  checkCurrent: () => void,
  report: ProgressReporter,
): Promise<number> {
  const limit = Math.floor(decoder.sampleRate * 3600);
  check(Number.isSafeInteger(limit) && limit > 0, 'INVALID_AUDIO');
  checkCurrent();
  if (decoder.frame !== 0) {
    await decoder.reset();
    checkCurrent();
  }
  let counted = 0;
  const checkpoint = cooperativeYield(checkCurrent);
  report({ phase: 'prepare', value: null, count: counted });
  while (counted < limit) {
    checkCurrent();
    const request = Math.min(blockFrames, limit - counted);
    const pcm = await decoder.read(request);
    checkCurrent();
    const frames = pcm.channels[0]?.length || 0;
    check(frames <= request && (frames > 0 || pcm.done), 'INVALID_AUDIO');
    counted += frames;
    report({ phase: 'prepare', value: null, count: counted });
    await checkpoint();
    if (pcm.done) return counted;
    const start = decoder.loopStart;
    const end = decoder.loopEnd;
    if (
      decoder.loop &&
      decoder.loopIsInfinite &&
      typeof start === 'number' &&
      Number.isSafeInteger(start) &&
      start >= 0 &&
      typeof end === 'number' &&
      Number.isSafeInteger(end) &&
      end > start &&
      end <= counted
    ) {
      const length = start + 2 * (end - start);
      check(Number.isSafeInteger(length) && length <= limit, 'EXPORT_DURATION');
      return length;
    }
  }
  check(
    false,
    'EXPORT_DURATION',
    'No natural ending or completed song loop was found within one hour.',
  );
}

function faded(
  value: number,
  frame: number,
  length: number,
  rate: number,
  fade: number,
) {
  const remaining = (length - frame) / rate;
  return value * (fade > 0 ? Math.min(1, remaining / fade) : 1);
}

export async function createAudioOutput(
  decoder: AudioDecoder,
  {
    format,
    bitrate = 192,
    seconds = 60,
    wholeSong = false,
    report = () => {},
    fade = 0,
    checkCurrent = () => {},
  }: AudioOutputOptions,
) {
  const prepareSong = wholeSong && decoder.length === null;
  let length = prepareSong
    ? await wholeSongLength(decoder, checkCurrent, report)
    : exportLength(decoder, seconds);
  if (wholeSong)
    check(length <= Math.floor(decoder.sampleRate * 3600), 'EXPORT_DURATION');
  if (prepareSong) {
    checkCurrent();
    await decoder.reset();
    checkCurrent();
  }
  let rendered = 0;
  const channelCount = Math.min(2, decoder.channels || 2);
  check(
    channelCount >= 1 && Number.isSafeInteger(length) && length > 0,
    'INVALID_AUDIO',
  );
  const progress = () => Math.min(1, rendered / length);
  const checkpoint = cooperativeYield(checkCurrent);
  if (
    !prepareSong &&
    decoder.length === null &&
    !decoder.continuous &&
    (format === 'wav' || fade > 0)
  ) {
    let counted = 0;
    while (counted < length) {
      checkCurrent();
      const pcm = await decoder.read(Math.min(blockFrames, length - counted));
      counted += pcm.channels[0]?.length || 0;
      report({ phase: 'audio-prepare', value: counted / length });
      checkCurrent();
      if (pcm.done || !pcm.channels[0]?.length) break;
      await checkpoint();
    }
    checkCurrent();
    length = counted;
    await decoder.reset();
  }
  if (format === 'wav') {
    const header = wavHeader(length, decoder.sampleRate, channelCount);
    const size = header.length + length * channelCount * 2;
    check(Number.isSafeInteger(size), 'TOO_LARGE');
    async function* generate() {
      yield header;
      while (rendered < length) {
        checkCurrent();
        const pcm = await decoder.read(
          Math.min(blockFrames, length - rendered),
        );
        const frames = pcm.channels[0]?.length || 0;
        check(
          frames > 0 && pcm.channels.length >= channelCount,
          'INVALID_AUDIO',
        );
        const bytes = new Uint8Array(frames * channelCount * 2);
        const view = new DataView(bytes.buffer);
        for (let frame = 0; frame < frames; frame++) {
          for (let channel = 0; channel < channelCount; channel++) {
            const value = faded(
              pcm.channels[channel][frame],
              rendered + frame,
              length,
              decoder.sampleRate,
              fade,
            );
            view.setInt16(
              (frame * channelCount + channel) * 2,
              Math.round(Math.max(-1, Math.min(1, value)) * 32767),
              true,
            );
          }
        }
        rendered += frames;
        yield bytes;
        await checkpoint();
      }
    }
    return {
      source: sequentialSource(size, generate, checkCurrent, progress, {
        chunkSize: 65536,
        progressPhase: 'render',
      }),
      estimatedSize: size,
      mime: 'audio/wav',
    };
  }

  check(format === 'mp3' && [128, 192, 320].includes(bitrate), 'BITRATE');
  await import('./vendor/lame.min.js');
  const encoder = new globalThis.lamejs.Mp3Encoder(
    channelCount,
    outputRate,
    bitrate,
  );
  const targetFrames = Math.ceil((length * outputRate) / decoder.sampleRate);
  let outputFrame = 0;
  const cacheCapacity = 32768;
  const cache = Array.from(
    { length: channelCount },
    () => new Float32Array(cacheCapacity),
  );
  const encoderPcm = Array.from(
    { length: channelCount },
    () => new Int16Array(1152),
  );
  let ended = false;

  async function fill(until: number) {
    while (!ended && rendered <= until) {
      checkCurrent();
      const pcm = await decoder.read(Math.min(blockFrames, length - rendered));
      const frames = pcm.channels[0]?.length || 0;
      for (let channel = 0; channel < channelCount; channel++) {
        const samples = pcm.channels[channel] || pcm.channels[0];
        for (let frame = 0; frame < frames; frame++)
          cache[channel][(rendered + frame) % cacheCapacity] = faded(
            samples[frame],
            rendered + frame,
            length,
            decoder.sampleRate,
            fade,
          );
      }
      rendered += frames;
      ended = pcm.done || !frames || rendered >= length;
    }
  }

  async function* generate() {
    while (outputFrame < targetFrames) {
      checkCurrent();
      let count = Math.min(1152, targetFrames - outputFrame);
      const lastInput =
        Math.floor(
          ((outputFrame + count - 1) * decoder.sampleRate) / outputRate,
        ) + 1;
      await fill(lastInput);
      if (ended)
        count = Math.min(
          count,
          Math.max(
            0,
            Math.ceil((rendered * outputRate) / decoder.sampleRate) -
              outputFrame,
          ),
        );
      if (!count) break;
      check(
        rendered -
          Math.floor((outputFrame * decoder.sampleRate) / outputRate) <=
          cacheCapacity,
        'TOO_LARGE',
      );
      for (let channel = 0; channel < channelCount; channel++) {
        const samples = cache[channel];
        const output = encoderPcm[channel];
        for (let frame = 0; frame < count; frame++) {
          const position =
            ((outputFrame + frame) * decoder.sampleRate) / outputRate;
          const at = Math.floor(position);
          const fraction = position - Math.floor(position);
          const value =
            (samples[at % cacheCapacity] || 0) * (1 - fraction) +
            (samples[Math.min(at + 1, rendered - 1) % cacheCapacity] || 0) *
              fraction;
          output[frame] = Math.round(Math.max(-1, Math.min(1, value)) * 32767);
        }
      }
      const bytes = encoder.encodeBuffer(
        encoderPcm[0].subarray(0, count),
        (encoderPcm[1] || encoderPcm[0]).subarray(0, count),
      );
      outputFrame += count;
      if (bytes.length)
        yield new Uint8Array(bytes.buffer, bytes.byteOffset, bytes.byteLength);
      await checkpoint();
    }
    checkCurrent();
    const tail = encoder.flush();
    if (tail.length)
      yield new Uint8Array(tail.buffer, tail.byteOffset, tail.byteLength);
  }
  return {
    source: sequentialSource(
      null,
      generate,
      checkCurrent,
      () => Math.min(1, outputFrame / targetFrames),
      { chunkSize: 16384, progressPhase: 'encode' },
    ),
    estimatedSize:
      Math.ceil((length / decoder.sampleRate) * bitrate * 125) + 8192,
    mime: 'audio/mpeg',
  };
}
