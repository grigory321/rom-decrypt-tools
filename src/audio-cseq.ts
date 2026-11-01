import { check } from './binary.js';
import type {
  AudioDecoder,
  ByteSource,
  DecoderOptions,
  PcmBlock,
} from './contracts.js';
import { readCseqFile } from './cseq-files.js';
import { CseqBudget, CseqMixer } from './cseq-mixer.js';
import { CseqReader, CseqSequence } from './cseq-sequence.js';
import { cseqDriverRate } from './cseq-tables.js';
import type { CseqPlayback } from './cseq-types.js';

class CseqDecoder implements AudioDecoder {
  readonly channels = 2;
  readonly tags;
  length: number | null = null;
  frame = 0;
  private mixer: CseqMixer;
  private sequence: CseqSequence;
  private clocks = 0;
  private nextClock = 0;
  private tickAccumulator = 0;
  private started = false;
  get loop() {
    return this.sequence.loop;
  }
  get loopIsInfinite() {
    return this.sequence.loop;
  }
  get loopStart() {
    return this.sequence.loopStart;
  }
  get loopEnd() {
    return this.sequence.loop ? this.sequence.loopEnd : null;
  }
  constructor(
    readonly data: ByteSource,
    readonly playback: CseqPlayback,
    readonly sampleRate: number,
    readonly budget: CseqBudget,
    name?: string,
  ) {
    this.mixer = new CseqMixer(playback, sampleRate, budget);
    this.sequence = new CseqSequence(
      new CseqReader(data, budget.checkCurrent),
      playback,
      this.mixer,
    );
    this.tags = { title: name ?? 'Nintendo 3DS CSEQ' };
  }
  reset() {
    this.budget.checkCurrent();
    this.mixer = new CseqMixer(this.playback, this.sampleRate, this.budget);
    this.sequence = new CseqSequence(
      new CseqReader(this.data, this.budget.checkCurrent),
      this.playback,
      this.mixer,
    );
    this.frame = 0;
    this.length = null;
    this.clocks = this.nextClock = this.tickAccumulator = 0;
    this.started = false;
  }
  private async clock(frame: number) {
    if (!this.started) {
      this.started = true;
      await this.sequence.tick(frame);
    } else {
      this.mixer.clock();
      this.tickAccumulator += this.sequence.tempo * this.sequence.timebase;
      let ticks = 0;
      while (this.tickAccumulator >= 11520 && !this.sequence.ended) {
        this.tickAccumulator -= 11520;
        check(++ticks <= 1024, 'CSEQ_RESOURCE_LIMIT', 'Tempo work budget');
        await this.sequence.tick(frame);
      }
    }
    this.mixer.masterVolume = this.sequence.masterVolume;
    this.mixer.refresh();
    this.nextClock = Math.ceil(
      (++this.clocks * this.sampleRate) / cseqDriverRate,
    );
  }
  async read(frames: number): Promise<PcmBlock> {
    this.budget.begin();
    check(
      Number.isSafeInteger(frames) && frames >= 0 && frames <= 65536,
      'CSEQ_READ',
    );
    const left = new Float32Array(frames);
    const right = new Float32Array(frames);
    let written = 0;
    while (written < frames && this.length === null) {
      this.budget.checkCurrent();
      const frame = this.frame + written;
      if (frame >= this.nextClock) await this.clock(frame);
      if (this.sequence.ended && !this.mixer.activeVoices) {
        this.length = frame;
        break;
      }
      const count = Math.min(frames - written, this.nextClock - frame);
      await this.mixer.render(left, right, written, count);
      written += count;
    }
    const frame = this.frame;
    this.frame += written;
    return {
      channels: [left.subarray(0, written), right.subarray(0, written)],
      sampleRate: this.sampleRate,
      frame,
      length: this.length,
      done: this.length !== null,
      loop: this.loop,
      loopStart: this.loopStart,
      loopEnd: this.loopEnd,
      warnings: this.mixer.warnings.slice(),
      engine: 'Original Nintendo 3DS CSEQ / CWAV',
    };
  }
}

export async function createCseqDecoder(
  source: ByteSource,
  playback: CseqPlayback,
  options: DecoderOptions = {},
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
  check(
    playback.banks.length > 0 && playback.banks.some((bank) => bank !== null),
    'CSEQ_BANK_MISSING',
  );
  const budget = new CseqBudget(checkCurrent);
  budget.begin();
  const file = await readCseqFile(budget.source(source), checkCurrent);
  return new CseqDecoder(file.data, playback, sampleRate, budget, options.name);
}
