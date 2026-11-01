import type { PcmData } from './contracts.js';
import { check } from './binary.js';

export function wav(pcm: PcmData) {
  const channels = pcm.channels.length,
    n = pcm.channels[0].length;
  check(
    channels >= 1 && channels <= 8 && n * channels * 2 < 4294967295 - 44,
    'TOO_LARGE',
  );
  const out = new Uint8Array(44 + n * channels * 2),
    d = new DataView(out.buffer);
  const text = (o: number, s: string) =>
    out.set(new TextEncoder().encode(s), o);
  text(0, 'RIFF');
  d.setUint32(4, out.length - 8, true);
  text(8, 'WAVEfmt ');
  d.setUint32(16, 16, true);
  d.setUint16(20, 1, true);
  d.setUint16(22, channels, true);
  d.setUint32(24, pcm.sampleRate, true);
  d.setUint32(28, pcm.sampleRate * channels * 2, true);
  d.setUint16(32, channels * 2, true);
  d.setUint16(34, 16, true);
  text(36, 'data');
  d.setUint32(40, n * channels * 2, true);
  for (let i = 0; i < n; i++) {
    for (let c = 0; c < channels; c++) {
      d.setInt16(
        44 + (i * channels + c) * 2,
        Math.round(Math.max(-1, Math.min(1, pcm.channels[c][i])) * 32767),
        true,
      );
    }
  }
  return out;
}

export function applyFade<T extends PcmData>(pcm: T, seconds: number): T {
  if (!seconds) {
    return pcm;
  }
  const n = pcm.channels[0].length,
    fade = Math.min(n, Math.floor(seconds * pcm.sampleRate));
  for (const c of pcm.channels) {
    for (let i = 0; i < fade; i++) {
      c[n - fade + i] *= 1 - i / fade;
    }
  }
  return pcm;
}
