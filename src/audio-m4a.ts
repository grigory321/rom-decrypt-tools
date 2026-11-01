import { check } from './binary.js';
import type {
  AudioDecoder,
  ByteSource,
  DecoderOptions,
  PcmBlock,
} from './contracts.js';
import { readM4aCatalog } from './gba-audio.js';
import { M4aMixer } from './m4a-mixer.js';
import { M4aRom } from './m4a-rom.js';
import type { M4aPlayback } from './m4a-types.js';

class M4aDecoder implements AudioDecoder {
  readonly channels = 2;
  readonly tags;
  length: number | null = null;
  loop = false;
  loopStart = 0;
  loopEnd: number | null = null;
  frame = 0;
  private mixer: M4aMixer;
  private block: Float32Array[] = [new Float32Array(0), new Float32Array(0)];
  private blockPosition = 0;
  private first: [number, number] = [0, 0];
  private second: [number, number] = [0, 0];
  private cursor = -1;
  private nativeCount = 0;
  private finished = false;
  get loopIsInfinite() {
    return this.loop;
  }

  constructor(
    readonly rom: M4aRom,
    readonly playback: M4aPlayback,
    readonly sampleRate: number,
  ) {
    this.mixer = new M4aMixer(rom, playback);
    this.tags = { title: 'M4A song ' + playback.song.index };
  }

  reset() {
    this.rom.checkCurrent();
    this.mixer = new M4aMixer(this.rom, this.playback);
    this.block = [new Float32Array(0), new Float32Array(0)];
    this.blockPosition = 0;
    this.first = [0, 0];
    this.second = [0, 0];
    this.cursor = -1;
    this.nativeCount = 0;
    this.finished = false;
    this.frame = 0;
    this.length = null;
    this.loop = false;
    this.loopStart = 0;
    this.loopEnd = null;
  }

  private async next(): Promise<[number, number]> {
    if (this.blockPosition >= this.block[0].length && !this.finished) {
      const block = await this.mixer.render();
      if (block === null) {
        this.finished = true;
        this.length = Math.ceil(
          (this.nativeCount * this.sampleRate) / this.mixer.sampleRate,
        );
      } else {
        this.block = block;
        this.blockPosition = 0;
        this.nativeCount += block[0].length;
      }
      if (this.mixer.sequence.loop) {
        const scale =
          (this.mixer.frameSamples * this.sampleRate) / this.mixer.sampleRate;
        this.loop = true;
        this.loopStart = Math.round(this.mixer.sequence.loopStart * scale);
        this.loopEnd = Math.round(this.mixer.sequence.loopEnd * scale);
      }
    }
    if (this.finished) return [0, 0];
    const result: [number, number] = [
      this.block[0][this.blockPosition],
      this.block[1][this.blockPosition],
    ];
    this.blockPosition++;
    return result;
  }

  async read(frames: number): Promise<PcmBlock> {
    this.rom.checkCurrent();
    check(
      Number.isSafeInteger(frames) && frames >= 0 && frames <= 1048576,
      'GBA_M4A_READ',
    );
    const left = new Float32Array(frames);
    const right = new Float32Array(frames);
    let written = 0;
    while (written < frames) {
      this.rom.checkCurrent();
      const position =
        ((this.frame + written) * this.mixer.sampleRate) / this.sampleRate;
      const index = Math.floor(position);
      if (this.cursor < 0) {
        this.first = await this.next();
        this.second = await this.next();
        this.cursor = 0;
      }
      while (this.cursor < index) {
        this.first = this.second;
        this.second = await this.next();
        this.cursor++;
      }
      if (this.length !== null && this.frame + written >= this.length) break;
      const fraction = position - index;
      left[written] =
        this.first[0] + (this.second[0] - this.first[0]) * fraction;
      right[written] =
        this.first[1] + (this.second[1] - this.first[1]) * fraction;
      written++;
    }
    const frame = this.frame;
    this.frame += written;
    return {
      channels: [left.subarray(0, written), right.subarray(0, written)],
      sampleRate: this.sampleRate,
      frame,
      length: this.length,
      done: this.length !== null && this.frame >= this.length,
      loop: this.loop,
      loopStart: this.loopStart,
      loopEnd: this.loopEnd,
      engine: 'Original GBA M4A PCM/PSG',
    };
  }
}

export async function createM4aDecoder(
  source: ByteSource,
  options: DecoderOptions = {},
  playback?: M4aPlayback,
): Promise<AudioDecoder> {
  const checkCurrent = () =>
    check(
      !options.signal?.aborted &&
        !options.cancelled?.() &&
        !options.isCancelled?.(),
      'CANCELLED',
    );
  checkCurrent();
  const sampleRate = options.sampleRate ?? 32768;
  check(
    Number.isInteger(sampleRate) && sampleRate >= 8000 && sampleRate <= 96000,
    'INVALID_AUDIO',
  );
  if (!playback) {
    const checkedSource: ByteSource = {
      size: source.size,
      async read(offset, length) {
        checkCurrent();
        check(length <= 65536, 'GBA_M4A_READ');
        const bytes = await source.read(offset, length);
        checkCurrent();
        return bytes;
      },
    };
    const catalog = await readM4aCatalog(checkedSource);
    const song =
      options.song === undefined
        ? catalog.songs[0]
        : catalog.songs.find((entry) => entry.index === options.song);
    check(song !== undefined, 'GBA_M4A_SONG');
    playback = { mode: catalog.mode, song };
  }
  checkCurrent();
  return new M4aDecoder(new M4aRom(source, checkCurrent), playback, sampleRate);
}
