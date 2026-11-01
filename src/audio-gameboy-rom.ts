import type { AudioDecoder, ByteSource, DecoderOptions } from './contracts.js';
import { check } from './binary.js';
import { audioDecoder, readAudio } from './audio-codecs.js';
import {
  GameBoyCartridge,
  readGameBoyCartridgeHeader,
} from './gameboy-cartridge.js';

export interface GameBoyRomDecoder extends AudioDecoder {
  setButtons(mask: number, durationFrames?: number): void;
}

export async function createGameBoyRomDecoder(
  source: ByteSource,
  options: DecoderOptions = {},
): Promise<GameBoyRomDecoder> {
  const checkCancelled = () =>
    check(
      !options.signal?.aborted &&
        !options.cancelled?.() &&
        !options.isCancelled?.(),
      'CANCELLED',
    );
  checkCancelled();
  const header = await readGameBoyCartridgeHeader(source);
  const sampleRate = options.sampleRate ?? 32768;
  check(
    Number.isInteger(sampleRate) && sampleRate >= 8000 && sampleRate <= 96000,
    'INVALID_AUDIO',
  );
  check(options.song === undefined || options.song === 0, 'INVALID_AUDIO');
  const rom = new Uint8Array(header.romSize);
  for (let offset = 0; offset < rom.length; offset += 65536) {
    checkCancelled();
    rom.set(
      await readAudio(source, offset, Math.min(65536, rom.length - offset)),
      offset,
    );
  }
  checkCancelled();
  let player = new GameBoyCartridge(rom, header);
  let pending = 0;
  let releaseAfter: number | null = null;
  const decoder = audioDecoder(
    {
      channels: 2,
      sampleRate,
      length: null,
      loop: false,
      tags: { title: header.title || 'Cartridge audio', game: header.title },
    },
    (frames) => {
      const left = new Float32Array(frames);
      const right = new Float32Array(frames);
      const sampleCycles = 4194304 / sampleRate;
      for (let frame = 0; frame < frames; frame++) {
        checkCancelled();
        let remaining = sampleCycles;
        while (remaining > 1e-8) {
          if (pending <= 1e-8) {
            pending = player.cpu.step();
            player.advance(pending);
          }
          const count = Math.min(remaining, pending);
          player.apu.advance(count);
          remaining -= count;
          pending = Math.max(0, pending - count);
        }
        player.apu.sample();
        left[frame] = player.apu.sampleLeft;
        right[frame] = player.apu.sampleRight;
        if (releaseAfter !== null && --releaseAfter <= 0) {
          player.setButtons(0);
          releaseAfter = null;
        }
      }
      return [left, right];
    },
    () => {
      checkCancelled();
      player = new GameBoyCartridge(rom, header);
      pending = 0;
      releaseAfter = null;
    },
  );
  return Object.assign(decoder, {
    setButtons(mask: number, durationFrames?: number) {
      checkCancelled();
      check(
        durationFrames === undefined ||
          (Number.isSafeInteger(durationFrames) && durationFrames >= 0),
        'INVALID_AUDIO',
      );
      player.setButtons(mask);
      releaseAfter = durationFrames ?? null;
      if (durationFrames === 0) {
        player.setButtons(0);
        releaseAfter = null;
      }
    },
  });
}
