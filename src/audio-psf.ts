import type { PsfBundle, DecoderOptions } from './contracts.js';
import { check } from './binary.js';
import { audioDecoder } from './audio-codecs.js';
import { PsxMachine } from './psf-machine.js';
import { cooperativeYield } from './cooperative.js';

export function psfTagSeconds(value: string | undefined | null) {
  if (
    typeof value !== 'string' ||
    !/^\s*\d+(?::\d{1,2}){0,2}(?:\.\d+)?\s*$/.test(value)
  )
    return null;
  const parts = value.trim().split(':').map(Number);
  if (parts.slice(1).some((part) => part >= 60)) return null;
  const seconds = parts.reduce((result, part) => result * 60 + part, 0);
  return Number.isFinite(seconds) && seconds >= 0 && seconds <= 86400
    ? seconds
    : null;
}

export async function createPsfDecoder(
  bundle: PsfBundle,
  options: DecoderOptions = {},
) {
  const abort = () =>
    check(
      !options.signal?.aborted &&
        !options.cancelled?.() &&
        !options.isCancelled?.(),
      'CANCELLED',
    );
  abort();
  check(
    bundle?.format === 'PSF',
    'PSF_SERVICE',
    'PSF2 IOP decoder is required',
  );
  const tags = bundle.tags || {};
  const duration = psfTagSeconds(tags.length);
  const fade = duration === null ? 0 : psfTagSeconds(tags.fade) || 0;
  const fadeStart = duration === null ? null : Math.round(duration * 44100);
  const length =
    fadeStart === null ? null : fadeStart + Math.round(fade * 44100);
  let machine = new PsxMachine(bundle);
  const checkpoint = cooperativeYield(abort);
  const decoder = audioDecoder(
    { channels: 2, sampleRate: 44100, length, tags },
    async (frames: number, frame: number) => {
      const channels = [new Float32Array(frames), new Float32Array(frames)];
      for (let offset = 0; offset < frames; offset += 512) {
        abort();
        const count = Math.min(512, frames - offset);
        const block = machine.render(count);
        channels[0].set(block[0], offset);
        channels[1].set(block[1], offset);
        await checkpoint();
      }
      abort();
      if (
        fade &&
        fadeStart !== null &&
        length !== null &&
        frame + frames > fadeStart
      )
        for (let index = 0; index < frames; index++) {
          const gain = Math.min(
            1,
            Math.max(0, (length - frame - index) / (length - fadeStart)),
          );
          channels[0][index] *= gain;
          channels[1][index] *= gain;
        }
      return channels;
    },
    () => {
      abort();
      machine = new PsxMachine(bundle);
    },
  );
  return decoder;
}
