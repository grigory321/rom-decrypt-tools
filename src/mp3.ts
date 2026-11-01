import type { PcmData } from './contracts.js';
import './vendor/lame.min.js';

import { check } from './binary.js';

function createEncoder(
  pcm: PcmData,
  bitrate: number,
  report: (value: number) => void,
) {
  check([128, 192, 320].includes(bitrate), 'BITRATE');
  const rate = 44100,
    length = Math.ceil((pcm.channels[0].length * rate) / pcm.sampleRate),
    count = Math.min(2, pcm.channels.length),
    encoder = new globalThis.lamejs.Mp3Encoder(count, rate, bitrate),
    parts: Int8Array[] = [];
  let position = 0;
  function block(channel: number, start: number, length: number) {
    const source = pcm.channels[channel],
      out = new Int16Array(length);
    for (let i = 0; i < length; i++) {
      const p = ((start + i) * pcm.sampleRate) / rate,
        j = Math.floor(p),
        f = p - j;
      const value =
        (source[j] || 0) * (1 - f) +
        (source[Math.min(j + 1, source.length - 1)] || 0) * f;
      out[i] = Math.round(Math.max(-1, Math.min(1, value)) * 32767);
    }
    return out;
  }
  return {
    step() {
      if (position >= length) {
        return false;
      }
      const size = Math.min(1152, length - position),
        left = block(0, position, size),
        right = count === 2 ? block(1, position, size) : left,
        data = encoder.encodeBuffer(left, right);
      if (data.length) {
        parts.push(data.slice());
      }
      if (position % 115200 === 0) {
        report(position / length);
      }
      position += size;
      return true;
    },
    finish() {
      const tail = encoder.flush();
      if (tail.length) {
        parts.push(tail.slice());
      }
      const output = new Uint8Array(
        parts.reduce((sum, part) => sum + part.length, 0),
      );
      let offset = 0;
      for (const part of parts) {
        output.set(part, offset);
        offset += part.length;
      }
      return output;
    },
  };
}

export function encodeMp3(
  pcm: PcmData,
  bitrate = 192,
  report: (value: number) => void = () => {},
) {
  const encoder = createEncoder(pcm, bitrate, report);
  while (encoder.step()) {}
  return encoder.finish();
}

export async function encodeMp3Async(
  pcm: PcmData,
  bitrate = 192,
  report: (value: number) => void = () => {},
  { checkCancelled = () => {} } = {},
) {
  checkCancelled();
  const encoder = createEncoder(pcm, bitrate, report);
  let blocks = 0,
    started = performance.now();
  while (encoder.step()) {
    checkCancelled();
    blocks++;
    if (blocks >= 20 || performance.now() - started >= 12) {
      await new Promise((resolve) => setTimeout(resolve, 0));
      checkCancelled();
      blocks = 0;
      started = performance.now();
    }
  }
  checkCancelled();
  return encoder.finish();
}
