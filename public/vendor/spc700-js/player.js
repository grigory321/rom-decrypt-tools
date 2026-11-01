import { SPCAPU } from './apu.js';

import { DSP_SAMPLE_RATE, EnvMode } from './dsp.js';

import { Resampler } from './resampler.js';

import { parseSPC } from './spc-file.js';

import { Tuning } from './tuning.js';

const DEFAULT_PLAY_SECONDS = 180;

const DEFAULT_FADE_SECONDS = 5;

export class SPCPlayer {
  apu = new SPCAPU();
  sampleRate;
  resampler;
  file = null;
  options;
  outputSample = 0;
  dspSample = 0;
  frame = new Int32Array(2);
  source = (dst) => {
    this.apu.renderSample(dst);
    this.dspSample++;
    if (this.voiceCaptureEnabled) this.appendVoiceCapture();
  };
  voiceCaptureEnabled = false;
  voiceCaptureBuffer = new Int16Array(0);
  voiceCaptureCount = 0;
  get voiceCapture() {
    return this.voiceCaptureBuffer;
  }
  get voiceCaptureLength() {
    return this.voiceCaptureCount;
  }
  appendVoiceCapture() {
    const need = (this.voiceCaptureCount + 1) * 8;
    if (need > this.voiceCaptureBuffer.length) {
      const grown = new Int16Array(
        Math.max(need, this.voiceCaptureBuffer.length * 2, 4096),
      );
      grown.set(this.voiceCaptureBuffer);
      this.voiceCaptureBuffer = grown;
    }
    this.voiceCaptureBuffer.set(
      this.apu.dsp.voiceOut,
      this.voiceCaptureCount * 8,
    );
    this.voiceCaptureCount++;
  }
  tuning = null;
  drainNoteOns() {
    const events = this.apu.dsp.noteOnEvents;
    if (events.length === 0) return;
    const t = this.tuning;
    if (t != null) {
      for (let i = 0; i < events.length; i += 2)
        t.observe(events[i], events[i + 1]);
    }
    events.length = 0;
  }
  constructor(options = {}) {
    this.sampleRate = options.sampleRate ?? DSP_SAMPLE_RATE;
    this.options = {
      sampleRate: this.sampleRate,
      resumeVoices: options.resumeVoices ?? false,
      retriggerKeyOn: options.retriggerKeyOn ?? true,
      clearEchoBuffer: options.clearEchoBuffer ?? true,
      loopCount: options.loopCount ?? 2,
      defaultPlaySeconds: options.defaultPlaySeconds ?? DEFAULT_PLAY_SECONDS,
      defaultFadeSeconds: options.defaultFadeSeconds ?? DEFAULT_FADE_SECONDS,
    };
    this.resampler =
      this.sampleRate === DSP_SAMPLE_RATE
        ? null
        : new Resampler(DSP_SAMPLE_RATE, this.sampleRate);
  }
  get tags() {
    return this.file?.tags ?? {};
  }
  get playSeconds() {
    const t = this.tags;
    if (t.introSeconds != null && t.loopSeconds != null) {
      const loops = t.loopCount ?? this.options.loopCount;
      return t.introSeconds + t.loopSeconds * loops + (t.endSeconds ?? 0);
    }
    return t.playSeconds ?? this.options.defaultPlaySeconds;
  }
  get fadeSeconds() {
    const ms = this.tags.fadeMilliseconds;
    return ms != null ? ms / 1e3 : this.options.defaultFadeSeconds;
  }
  get totalSeconds() {
    return this.playSeconds + this.fadeSeconds;
  }
  get currentTime() {
    return this.outputSample / this.sampleRate;
  }
  load(input) {
    const file =
      input instanceof Uint8Array || input instanceof ArrayBuffer
        ? parseSPC(input)
        : input;
    this.file = file;
    const apu = this.apu;
    apu.reset();
    apu.ram.set(file.ram);
    apu.iplRom.set(file.iplRom);
    apu.dsp.regs.set(file.dspRegs);
    apu.cpu.PC = file.registers.pc;
    apu.cpu.A = file.registers.a;
    apu.cpu.X = file.registers.x;
    apu.cpu.Y = file.registers.y;
    apu.cpu.SP = file.registers.sp;
    apu.cpu.PSW = file.registers.psw;
    apu.cpu.halted = false;
    apu.applyRegisterBlock();
    if (this.options.clearEchoBuffer) this.clearEchoRegion();
    this.tuning = new Tuning(apu.ram, apu.dsp.regs[93]);
    apu.dsp.noteOnEvents.length = 0;
    const candidates = apu.dsp.restoreFromSnapshot(this.options.resumeVoices);
    if (this.options.retriggerKeyOn && candidates !== 0) {
      apu.dsp.applyKeyOnRecovery(candidates);
    }
    this.outputSample = 0;
    this.dspSample = 0;
    this.resampler?.reset();
  }
  clearEchoRegion() {
    const dsp = this.apu.dsp;
    if (dsp.regs[108] & 32) return;
    const start = dsp.regs[109] << 8;
    const length = Math.max(4, (dsp.regs[125] & 15) * 2048);
    for (let i = 0; i < length; i++) this.apu.ram[(start + i) & 65535] = 0;
  }
  renderInto(left, right, offset, count) {
    const apu = this.apu;
    const frame = this.frame;
    this.voiceCaptureCount = 0;
    if (this.resampler == null) {
      for (let i = 0; i < count; i++) {
        apu.renderSample(frame);
        if (this.voiceCaptureEnabled) this.appendVoiceCapture();
        left[offset + i] = frame[0];
        right[offset + i] = frame[1];
      }
      this.dspSample += count;
    } else {
      this.resampler.process(left, right, offset, count, this.source);
    }
    this.drainNoteOns();
    this.applyFade(left, right, offset, count);
    this.outputSample += count;
    return count;
  }
  render(count) {
    const left = new Int16Array(count);
    const right = new Int16Array(count);
    this.renderInto(left, right, 0, count);
    return {
      left: left,
      right: right,
    };
  }
  skip(count) {
    const apu = this.apu;
    const frame = this.frame;
    if (this.resampler == null) {
      for (let i = 0; i < count; i++) apu.renderSample(frame);
      this.dspSample += count;
    } else {
      this.resampler.skip(count, this.source);
    }
    this.drainNoteOns();
    this.outputSample += count;
  }
  applyFade(left, right, offset, count) {
    const fade = this.fadeSeconds;
    if (fade <= 0) return;
    const fadeStart = this.playSeconds * this.sampleRate;
    const fadeLength = fade * this.sampleRate;
    const end = this.outputSample + count;
    if (end <= fadeStart) return;
    for (let i = 0; i < count; i++) {
      const pos = this.outputSample + i - fadeStart;
      if (pos < 0) continue;
      const gain = pos >= fadeLength ? 0 : 1 - pos / fadeLength;
      left[offset + i] = (left[offset + i] * gain) | 0;
      right[offset + i] = (right[offset + i] * gain) | 0;
    }
  }
  saveState() {
    return {
      apu: this.apu.saveState(),
      outputSample: this.outputSample,
      dspSample: this.dspSample,
      resampler: this.resampler?.saveState() ?? null,
    };
  }
  restoreState(state) {
    this.apu.loadState(state.apu);
    this.outputSample = state.outputSample;
    this.dspSample = state.dspSample;
    if (this.resampler != null) {
      if (state.resampler != null) this.resampler.loadState(state.resampler);
      else this.resampler.reset();
    }
  }
  setVoiceMask(mask) {
    this.apu.dsp.voiceMask = mask & 255;
  }
  getVoiceMask() {
    return this.apu.dsp.voiceMask;
  }
  getVoiceStatus(index) {
    const dsp = this.apu.dsp;
    const v = dsp.voices[index];
    const base = index << 4;
    const bit = 1 << index;
    const source = dsp.regs[base + 4];
    const pitch = dsp.pitchOf(index);
    const active = dsp.isActive(index);
    return {
      index: index,
      active: active,
      envelope: v.envelope,
      volumeLeft: (dsp.regs[base + 0] << 24) >> 24,
      volumeRight: (dsp.regs[base + 1] << 24) >> 24,
      pitch: pitch,
      note:
        active && pitch > 0
          ? (this.tuning?.noteOf(source, pitch) ?? null)
          : null,
      semitone: active && pitch > 0 ? 12 * Math.log2(pitch / 4096) : null,
      tuningConfidence: this.tuning?.baseOf(source).confidence ?? 0,
      source: source,
      noise: (dsp.regs[61] & bit) !== 0,
      echo: (dsp.regs[77] & bit) !== 0,
      pitchModulated: (dsp.regs[45] & bit) !== 0,
      envelopeMode: v.envelopeMode,
      keyOnAt: v.keyOnAt,
      keyOnCount: v.keyOnCount,
    };
  }
  getVoiceStatusArray() {
    const out = [];
    for (let i = 0; i < 8; i++) out.push(this.getVoiceStatus(i));
    return out;
  }
  get dspSampleCount() {
    return this.dspSample;
  }
}
