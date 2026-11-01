import { bounds, check } from './binary.js';
import type { AudioDecoder, ByteSource, Diagnostic } from './contracts.js';
import { createNintendoDecoder } from './audio-nintendo.js';
import type { CseqPlayback, CseqRegion } from './cseq-types.js';
import type { CseqSink, CseqTrack } from './cseq-sequence.js';
import {
  cseqAttack,
  cseqDriverRate,
  cseqFall,
  cseqSilence,
  cseqSine,
  cseqSustain,
} from './cseq-tables.js';

export class CseqBudget {
  private reads = 0;
  private decoded = 0;
  private headers = new Map<ByteSource, Uint8Array>();
  private waves = new Map<ByteSource, CseqWave>();
  private pages = new Map<CseqSamplePage, CseqWave>();
  private cachedBytes = 0;
  constructor(readonly checkCurrent: () => void) {}
  begin() {
    this.reads = 0;
    this.decoded = 0;
    this.checkCurrent();
  }
  decode(frames: number) {
    this.checkCurrent();
    this.decoded += frames;
    check(this.decoded <= 4194304, 'CSEQ_RESOURCE_LIMIT', 'Sample seek budget');
  }
  async wave(source: ByteSource) {
    let wave = this.waves.get(source);
    if (wave) this.waves.delete(source);
    else wave = await CseqWave.create(source, this);
    if (this.waves.size >= 128) {
      const first = this.waves.keys().next().value;
      if (first !== undefined) this.waves.delete(first);
    }
    this.waves.set(source, wave);
    return wave;
  }
  cache(wave: CseqWave, page: CseqSamplePage) {
    if (this.pages.has(page)) this.pages.delete(page);
    else
      for (const channel of page.channels)
        this.cachedBytes += channel.byteLength;
    this.pages.set(page, wave);
    while (this.cachedBytes > 4194304 || this.pages.size > 256) {
      const first = this.pages.entries().next().value;
      if (first === undefined) break;
      const [oldPage, oldWave] = first;
      this.pages.delete(oldPage);
      for (const channel of oldPage.channels)
        this.cachedBytes -= channel.byteLength;
      oldWave.forget(oldPage);
    }
  }
  source(source: ByteSource): ByteSource {
    return {
      size: source.size,
      read: async (offset, length) => {
        this.checkCurrent();
        bounds(source.size, offset, length);
        const header = offset + length <= 4096;
        const cached = header ? this.headers.get(source) : undefined;
        if (cached) return cached.slice(offset, offset + length);
        const readOffset = header ? 0 : offset;
        const readLength = header ? Math.min(4096, source.size) : length;
        this.reads += readLength;
        check(
          length <= 65536 && this.reads <= 33554432,
          'CSEQ_RESOURCE_LIMIT',
          'Source read budget',
        );
        const bytes = await source.read(readOffset, readLength);
        this.checkCurrent();
        check(bytes.length === readLength, 'CSEQ_TRUNCATED');
        if (header) {
          if (this.headers.size >= 128) {
            const first = this.headers.keys().next().value;
            if (first !== undefined) this.headers.delete(first);
          }
          this.headers.set(source, bytes);
        }
        return header ? bytes.slice(offset, offset + length) : bytes;
      },
    };
  }
}
interface CseqSamplePage {
  start: number;
  channels: Float32Array[];
  before: CseqWaveCheckpoint | undefined;
  after: CseqWaveCheckpoint | undefined;
}
interface CseqWaveCheckpoint {
  frame: number;
  decoder: AudioDecoder;
  restore: () => void;
}
interface CseqWaveReader {
  decoder: AudioDecoder | undefined;
  before: CseqWaveCheckpoint | undefined;
  after: CseqWaveCheckpoint | undefined;
}
class CseqWave {
  private pages = new Map<number, CseqSamplePage>();
  private initialDecoder: AudioDecoder | undefined;
  private initialCheckpoint: CseqWaveCheckpoint | undefined;
  private loopCheckpoint: CseqWaveCheckpoint | undefined;
  readonly sampleRate: number;
  readonly length: number;
  readonly loopStart: number;
  readonly loopEnd: number;
  readonly loop: boolean;
  private constructor(
    readonly source: ByteSource,
    decoder: AudioDecoder,
    readonly budget: CseqBudget,
  ) {
    check(decoder.length !== null && decoder.length > 0, 'CSEQ_WAVE');
    this.initialDecoder = decoder;
    this.initialCheckpoint = this.checkpoint(decoder);
    this.sampleRate = decoder.sampleRate;
    this.length = decoder.length;
    this.loop = !!decoder.loop;
    this.loopStart = decoder.loopStart ?? 0;
    this.loopEnd = decoder.loopEnd ?? decoder.length;
    check(
      !this.loop ||
        (this.loopStart >= 0 &&
          this.loopStart < this.loopEnd &&
          this.loopEnd <= this.length),
      'CSEQ_WAVE',
    );
  }
  static async create(source: ByteSource, budget: CseqBudget) {
    return new CseqWave(
      source,
      await createNintendoDecoder(budget.source(source)),
      budget,
    );
  }
  reader(): CseqWaveReader {
    const reader = {
      decoder: this.initialDecoder,
      before: this.initialCheckpoint,
      after: this.initialCheckpoint,
    };
    this.initialDecoder = undefined;
    return reader;
  }
  private checkpoint(decoder: AudioDecoder): CseqWaveCheckpoint | undefined {
    return decoder.checkpoint
      ? { frame: decoder.frame, decoder, restore: decoder.checkpoint() }
      : undefined;
  }
  page(index: number, reader?: CseqWaveReader) {
    const page = this.pages.get(Math.floor(index / 2048) * 2048);
    if (page) {
      this.budget.cache(this, page);
      if (reader) {
        reader.before = page.before;
        reader.after = page.after;
      }
    }
    return page;
  }
  forget(page: CseqSamplePage) {
    this.pages.delete(page.start);
  }
  async ensure(index: number, reader: CseqWaveReader, adopt = true) {
    const cached = this.page(index, adopt ? reader : undefined);
    if (cached) return cached;
    this.budget.checkCurrent();
    const target = Math.floor(index / 2048) * 2048;
    let resume = this.initialCheckpoint;
    for (const checkpoint of [
      reader.before,
      reader.after,
      this.loopCheckpoint,
      this.pages.get(target - 2048)?.after,
    ])
      if (
        checkpoint &&
        checkpoint.frame <= target &&
        (!resume || checkpoint.frame > resume.frame)
      )
        resume = checkpoint;
    if (resume) {
      resume.restore();
      reader.decoder = resume.decoder;
    }
    const decoder =
      reader.decoder ??
      (reader.decoder = await createNintendoDecoder(
        this.budget.source(this.source),
      ));
    const loopPage = Math.floor(this.loopStart / 2048) * 2048;
    if (decoder.frame !== target) {
      if (decoder.seek) await decoder.seek(target);
      else {
        if (target < decoder.frame) await decoder.reset();
        while (decoder.frame < target) {
          const count = Math.min(
            4096,
            target - decoder.frame,
            this.loop && decoder.frame < loopPage
              ? loopPage - decoder.frame
              : Infinity,
          );
          this.budget.decode(count);
          await decoder.read(count);
          if (this.loop && decoder.frame === loopPage)
            this.loopCheckpoint = this.checkpoint(decoder);
        }
      }
    }
    const count = Math.min(2048, this.length - target);
    const before = this.checkpoint(decoder);
    if (this.loop && target === loopPage) this.loopCheckpoint = before;
    this.budget.decode(count);
    const block = await decoder.read(count);
    check(block.channels[0].length === count, 'CSEQ_WAVE');
    const page = {
      start: target,
      channels: block.channels,
      before,
      after: this.checkpoint(decoder),
    };
    this.pages.set(target, page);
    this.budget.cache(this, page);
    if (adopt) {
      reader.before = page.before;
      reader.after = page.after;
    }
    return page;
  }
}
type EnvelopeState = 'attack' | 'hold' | 'decay' | 'sustain' | 'release';
interface CseqVoice {
  track: CseqTrack;
  region: CseqRegion;
  wave: CseqWave;
  reader: CseqWaveReader;
  priority: number;
  key: number;
  velocity: number;
  length: number;
  position: number;
  state: EnvelopeState;
  amplitude: number;
  attack: number;
  decay: number;
  sustain: number;
  release: number;
  hold: number;
  modulation: number;
  modulationDelay: number;
  sweepPitch: number;
  sweepLength: number;
  sweepCount: number;
  manualSweep: boolean;
  increment: number;
  left: number;
  right: number;
  volume: number;
  dead: boolean;
  damped: boolean;
}

export class CseqMixer implements CseqSink {
  readonly warnings: Diagnostic[] = [];
  private voices: CseqVoice[] = [];
  masterVolume = 127;
  constructor(
    readonly playback: CseqPlayback,
    readonly sampleRate: number,
    readonly budget: CseqBudget,
  ) {}
  get activeVoices() {
    let count = 0;
    for (const voice of this.voices) if (!voice.dead) count++;
    return count;
  }
  warn(command: number, detail = '') {
    const code = [0xb4, 0xb5, 0xbf, 0xd7, 0xd8, 0xd9, 0xda, 0xde].includes(
      command,
    )
      ? 'CSEQ_DSP_UNSUPPORTED'
      : 'CSEQ_CONTROL_UNSUPPORTED';
    const message = '0x' + command.toString(16) + (detail ? ': ' + detail : '');
    if (
      !this.warnings.some(
        (warning) => warning.code === code && warning.detail === message,
      ) &&
      this.warnings.length < 64
    )
      this.warnings.push({ code, detail: message });
  }
  active(track: CseqTrack) {
    return this.voices.some((voice) => voice.track === track && !voice.dead);
  }
  private releaseVoice(voice: CseqVoice) {
    if (voice.state === 'release' || voice.dead) return;
    if (voice.track.damper && !voice.track.ended) {
      voice.damped = true;
      return;
    }
    voice.state = 'release';
    voice.length = -1;
    voice.priority = 1;
  }
  release(track: CseqTrack) {
    for (const voice of this.voices)
      if (voice.track === track) this.releaseVoice(voice);
  }
  tick(track: CseqTrack) {
    for (const voice of this.voices) {
      if (voice.dead || voice.track !== track) continue;
      if (voice.length > 0 && --voice.length === 0) this.releaseVoice(voice);
      if (voice.damped && !track.damper) {
        voice.damped = false;
        this.releaseVoice(voice);
      }
      if (voice.manualSweep && voice.sweepCount < voice.sweepLength)
        voice.sweepCount++;
    }
  }
  private portamento(voice: CseqVoice, length: number) {
    const track = voice.track;
    voice.sweepPitch = track.sweepPitch;
    voice.sweepCount = 0;
    voice.manualSweep = false;
    voice.sweepLength = 0;
    if (track.porta) {
      voice.sweepPitch += (track.portaKey - voice.key) * 64;
      if (!track.portaTime) {
        voice.sweepLength = length;
        voice.manualSweep = true;
      } else
        voice.sweepLength = Math.floor(
          (Math.abs(voice.sweepPitch) * track.portaTime * track.portaTime) /
            2048,
        );
    }
    track.portaKey = voice.key;
  }
  async note(track: CseqTrack, key: number, velocity: number, length: number) {
    this.budget.checkCurrent();
    velocity = Math.max(
      0,
      Math.min(127, Math.trunc((velocity * track.velocityRange) / 127)),
    );
    const tied = track.tie
      ? this.voices.find(
          (voice) =>
            voice.track === track && !voice.dead && voice.state !== 'release',
        )
      : undefined;
    if (tied) {
      tied.key = key;
      tied.velocity = cseqSustain(velocity);
      tied.length = -1;
      tied.priority = track.priority;
      tied.modulation = track.modPhase * 256;
      tied.modulationDelay = 0;
      this.portamento(tied, length);
      return true;
    }
    const bank = this.playback.banks[track.bank];
    check(bank, 'CSEQ_BANK_MISSING', 'Bank ' + track.bank);
    const region = await bank.lookup(track.program, key, velocity);
    this.budget.checkCurrent();
    if (!region) {
      const detail = 'Bank ' + track.bank + ', program ' + track.program;
      if (
        this.warnings.length < 64 &&
        !this.warnings.some(
          (warning) =>
            warning.code === 'CSEQ_UNASSIGNED_REGION' &&
            warning.detail === detail,
        )
      )
        this.warnings.push({ code: 'CSEQ_UNASSIGNED_REGION', detail });
      return false;
    }
    if (track.monophonic) this.release(track);
    if (region.keyGroup)
      for (const voice of this.voices)
        if (
          voice.region.keyGroup === region.keyGroup &&
          voice.track.bank === track.bank
        )
          voice.dead = true;
    this.voices = this.voices.filter((voice) => !voice.dead);
    if (this.voices.length >= 48) {
      let candidate = this.voices[0];
      for (const voice of this.voices)
        if (
          voice.priority < candidate.priority ||
          (voice.priority === candidate.priority &&
            voice.volume < candidate.volume)
        )
          candidate = voice;
      if (candidate.priority > track.priority) return false;
      this.voices.splice(this.voices.indexOf(candidate), 1);
    }
    const wave = await this.budget.wave(region.wave);
    check(Number.isFinite(region.pitch) && region.pitch > 0, 'CSEQ_WAVE');
    const hold = track.hold === 255 ? region.hold : track.hold;
    if (hold) this.warn(0xb1, 'Envelope hold timing uses driver clocks');
    if (region.interpolation !== 1)
      this.warn(
        0xb5,
        region.interpolation === 0
          ? 'Polyphase wave interpolation approximated with linear interpolation'
          : 'Wave interpolation ' + region.interpolation,
      );
    const voice: CseqVoice = {
      track,
      region,
      wave,
      reader: wave.reader(),
      priority: track.priority,
      key,
      velocity: cseqSustain(velocity),
      length: track.tie ? -1 : length,
      position: 0,
      state: 'attack',
      amplitude: cseqSilence,
      attack: cseqAttack(track.attack === 255 ? region.attack : track.attack),
      decay: cseqFall(track.decay === 255 ? region.decay : track.decay),
      sustain:
        cseqSustain(track.sustain === 255 ? region.sustain : track.sustain) *
        128,
      release: cseqFall(track.release === 255 ? region.release : track.release),
      hold,
      modulation: track.modPhase * 256,
      modulationDelay: 0,
      sweepPitch: 0,
      sweepLength: 0,
      sweepCount: 0,
      manualSweep: false,
      increment: 0,
      left: 0,
      right: 0,
      volume: 0,
      dead: false,
      damped: false,
    };
    this.portamento(voice, length);
    this.voices.push(voice);
    this.update(voice, true);
    return true;
  }
  private update(voice: CseqVoice, envelope: boolean) {
    if (voice.dead) return;
    const track = voice.track;
    if (envelope) {
      if (voice.state === 'attack') {
        const old = voice.amplitude >> 7;
        do {
          voice.amplitude = Math.trunc((voice.amplitude * voice.attack) / 256);
        } while (voice.amplitude >> 7 === old && voice.amplitude !== 0);
        if (!voice.amplitude) voice.state = voice.hold ? 'hold' : 'decay';
      } else if (voice.state === 'hold') {
        if (--voice.hold <= 0) voice.state = 'decay';
      } else if (voice.state === 'decay') {
        voice.amplitude -= voice.decay;
        if (voice.amplitude <= voice.sustain) {
          voice.amplitude = voice.sustain;
          voice.state = 'sustain';
        }
      } else if (voice.state === 'release') {
        voice.amplitude -= voice.release;
        if (voice.amplitude <= cseqSilence) {
          voice.dead = true;
          return;
        }
      }
    }
    let modulation = 0;
    if (voice.modulationDelay >= track.modDelay && track.modDepth) {
      modulation =
        cseqSine(voice.modulation >> 8) * track.modRange * track.modDepth;
      modulation =
        track.modType === 1 ? (modulation * 60) >> 14 : modulation >> 8;
      if (envelope) {
        const speed =
          track.modPeriod > 0
            ? (32768 * cseqDriverRate) / (track.modPeriod * 1000)
            : track.modSpeed * 64;
        voice.modulation = (voice.modulation + Math.max(0, speed)) % 32768;
      }
    } else if (envelope) voice.modulationDelay++;
    let tune =
      (voice.key - voice.region.originalKey) * 64 +
      ((track.bend * track.bendRange) >> 1);
    if (track.modType === 0) tune += modulation;
    if (voice.sweepLength && voice.sweepCount <= voice.sweepLength) {
      tune += Math.trunc(
        (voice.sweepPitch * (voice.sweepLength - voice.sweepCount)) /
          voice.sweepLength,
      );
      if (envelope && !voice.manualSweep) voice.sweepCount++;
    }
    voice.increment =
      (voice.wave.sampleRate * voice.region.pitch * 2 ** (tune / 768)) /
      this.sampleRate;
    check(
      Number.isFinite(voice.increment) &&
        voice.increment > 0 &&
        voice.increment <= 65536,
      'CSEQ_PITCH',
    );
    let volume =
      (voice.amplitude >> 7) +
      voice.velocity +
      cseqSustain(voice.region.volume) +
      cseqSustain(this.playback.volume) +
      cseqSustain(this.masterVolume) +
      cseqSustain(track.volume) +
      cseqSustain(track.expression) +
      cseqSustain(track.mainSend);
    if (track.modType === 1) volume += modulation;
    const gain = volume <= -723 ? 0 : 10 ** (Math.min(0, volume) / 160);
    let pan = voice.region.pan + track.pan + track.initialPan;
    if (track.modType === 2) pan += modulation;
    pan = Math.max(0, Math.min(127, pan));
    voice.left = pan <= 64 ? gain : (gain * (127 - pan)) / 63;
    voice.right = pan >= 64 ? gain : (gain * pan) / 64;
    voice.volume = gain;
  }
  clock() {
    this.budget.checkCurrent();
    for (const voice of this.voices) this.update(voice, true);
    this.voices = this.voices.filter((voice) => !voice.dead);
  }
  refresh() {
    for (const voice of this.voices) this.update(voice, false);
  }
  async render(
    left: Float32Array,
    right: Float32Array,
    start: number,
    count: number,
  ) {
    this.budget.checkCurrent();
    for (const voice of this.voices) {
      if (voice.dead) continue;
      const wave = voice.wave;
      const end = wave.loop ? wave.loopEnd : wave.length;
      let page: CseqSamplePage | undefined;
      for (let frame = start; frame < start + count; frame++) {
        if (voice.position >= end) {
          if (wave.loop)
            voice.position =
              wave.loopStart +
              ((voice.position - wave.loopEnd) %
                (wave.loopEnd - wave.loopStart));
          else {
            voice.dead = true;
            break;
          }
        }
        const index = Math.floor(voice.position);
        const fraction = voice.position - index;
        if (
          !page ||
          index < page.start ||
          index >= page.start + page.channels[0].length
        )
          page =
            wave.page(index, voice.reader) ??
            (await wave.ensure(index, voice.reader));
        const local = index - page.start;
        const samplesLeft = page.channels[0];
        const samplesRight =
          page.channels[Math.min(1, page.channels.length - 1)];
        const left0 = samplesLeft[local];
        const right0 = samplesRight[local];
        let left1 = 0;
        let right1 = 0;
        if (index + 1 < end && local + 1 < samplesLeft.length) {
          left1 = samplesLeft[local + 1];
          right1 = samplesRight[local + 1];
        } else if (index + 1 < end || wave.loop) {
          const next = index + 1 < end ? index + 1 : wave.loopStart;
          const nextPage =
            wave.page(next) ?? (await wave.ensure(next, voice.reader, false));
          const nextLocal = next - nextPage.start;
          left1 = nextPage.channels[0][nextLocal];
          right1 =
            nextPage.channels[Math.min(1, nextPage.channels.length - 1)][
              nextLocal
            ];
        }
        left[frame] += (left0 + (left1 - left0) * fraction) * voice.left;
        right[frame] += (right0 + (right1 - right0) * fraction) * voice.right;
        voice.position += voice.increment;
      }
    }
    this.voices = this.voices.filter((voice) => !voice.dead);
    for (let index = start; index < start + count; index++) {
      left[index] = Math.max(-1, Math.min(1, left[index]));
      right[index] = Math.max(-1, Math.min(1, right[index]));
    }
  }
}
