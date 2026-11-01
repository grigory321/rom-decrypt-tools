/**
 * High-level .spc player: owns the machine, resolves track length from the
 * tags, resamples to whatever rate the host audio graph runs at, and exposes
 * the per-voice state a visualiser needs.
 */

import { SPCAPU, type APUState } from "./apu.js";
import { DSP_SAMPLE_RATE, EnvMode } from "./dsp.js";
import { Resampler } from "./resampler.js";
import { parseSPC, type SPCFile, type SPCTags } from "./spc-file.js";
import { Tuning } from "./tuning.js";

export interface SPCPlayerOptions {
  /** Output sample rate. Defaults to the DSP's native 32000 Hz. */
  sampleRate?: number;
  /**
   * Trust the envelope level left in ENVX to restore voices that were mid-note.
   *
   * Off by default, because ENVX is a read-only register and a dump holds
   * whatever the dumping tool left in it rather than the real envelope — one
   * writes zeroes, another fills every voice with $7F. Acting on the latter
   * revives voices that were not sounding, which is heard as a drone over the
   * opening bar. Enable it only for dumps known to preserve the register.
   */
  resumeVoices?: boolean;
  /**
   * Recover voices that were sounding but whose captured envelope level is
   * zero, using the KON latch left in the dump. Many dumpers leave the
   * read-only registers (ENVX/OUTX/ENDX) zeroed, and without this those tracks
   * lose their opening notes. Voices restored from ENVX are never re-keyed, so
   * the two paths do not double-trigger.
   */
  retriggerKeyOn?: boolean;
  /**
   * Zero the echo buffer region before playback.
   *
   * A dump's echo buffer usually holds whatever was in that part of ARAM when
   * the dumper ran, not an echo tail — the dumping stub has to live somewhere.
   * Played back as 16-bit samples that is broadband noise, and with the echo
   * feedback the driver has configured it recirculates for seconds. Only the
   * region the DSP is actively writing to is cleared, so a track whose echo is
   * switched off keeps its memory intact.
   */
  clearEchoBuffer?: boolean;
  /** Loop repeats to use when the xid6 loop length is known. Defaults to 2. */
  loopCount?: number;
  /** Track length in seconds when the tags say nothing. Defaults to 180. */
  defaultPlaySeconds?: number;
  /** Fade length in seconds when the tags say nothing. Defaults to 5. */
  defaultFadeSeconds?: number;
}

export interface VoiceStatus {
  index: number;
  /** True while the voice is starting up or its envelope is non-zero. */
  active: boolean;
  /** Envelope level, 0..0x7ff. */
  envelope: number;
  /** Signed per-voice volumes, -128..127. */
  volumeLeft: number;
  volumeRight: number;
  /** 14-bit pitch step. 0x1000 plays the BRR at 32000 Hz. */
  pitch: number;
  /**
   * The note being played, as a MIDI number (69 = A4), or null when the voice
   * is silent or its sample has no recoverable pitch. Derived from the base
   * pitch recovered from the sample's own waveform — see {@link Tuning}.
   */
  note: number | null;
  /** Semitones relative to a pitch of 0x1000. Always available. */
  semitone: number | null;
  /** Confidence in this sample's recovered base pitch, 0..1. */
  tuningConfidence: number;
  /** Sample directory index currently selected. */
  source: number;
  noise: boolean;
  echo: boolean;
  pitchModulated: boolean;
  envelopeMode: EnvMode;
  /** Absolute 32 kHz sample index of the most recent key-on. */
  keyOnAt: number;
  /** How many times this voice has been keyed on since load. */
  keyOnCount: number;
}

/** A complete, transferable player snapshot. */
export interface SPCPlayerState {
  apu: APUState;
  outputSample: number;
  dspSample: number;
  /** Resampler history and phase; null when running at the DSP's native rate. */
  resampler: Float64Array | null;
}

const DEFAULT_PLAY_SECONDS = 180;
const DEFAULT_FADE_SECONDS = 5;

export class SPCPlayer {
  readonly apu = new SPCAPU();
  readonly sampleRate: number;

  private resampler: Resampler | null;
  private file: SPCFile | null = null;
  private options: Required<SPCPlayerOptions>;

  /** Output samples produced since load/seek. */
  private outputSample = 0;
  /** DSP samples produced since load. */
  private dspSample = 0;

  private readonly frame = new Int32Array(2);
  /** Pull callback handed to the resampler; counts what it consumes. */
  private readonly source = (dst: Int32Array): void => {
    this.apu.renderSample(dst);
    this.dspSample++;
    if (this.voiceCaptureEnabled) this.appendVoiceCapture();
  };

  /** Whether {@link voiceCapture} is filled during rendering. */
  voiceCaptureEnabled = false;
  private voiceCaptureBuffer = new Int16Array(0);
  private voiceCaptureCount = 0;

  /**
   * Per-voice output for the DSP samples the last render consumed, eight int16
   * per sample. Runs at the DSP's own 32 kHz regardless of the output rate, so
   * a caller mapping it onto output frames should scale by
   * {@link voiceCaptureLength} over the frames it asked for.
   */
  get voiceCapture(): Int16Array {
    return this.voiceCaptureBuffer;
  }

  /** DSP samples captured by the last render. */
  get voiceCaptureLength(): number {
    return this.voiceCaptureCount;
  }

  private appendVoiceCapture(): void {
    const need = (this.voiceCaptureCount + 1) * 8;
    if (need > this.voiceCaptureBuffer.length) {
      const grown = new Int16Array(Math.max(need, this.voiceCaptureBuffer.length * 2, 4096));
      grown.set(this.voiceCaptureBuffer);
      this.voiceCaptureBuffer = grown;
    }
    this.voiceCaptureBuffer.set(this.apu.dsp.voiceOut, this.voiceCaptureCount * 8);
    this.voiceCaptureCount++;
  }

  /** Per-sample base pitches, refined from the notes the driver plays. */
  private tuning: Tuning | null = null;

  /** Feed any note-ons the DSP has queued into the tuning table. */
  private drainNoteOns(): void {
    const events = this.apu.dsp.noteOnEvents;
    if (events.length === 0) return;
    const t = this.tuning;
    if (t != null) {
      for (let i = 0; i < events.length; i += 2) t.observe(events[i], events[i + 1]);
    }
    events.length = 0;
  }

  constructor(options: SPCPlayerOptions = {}) {
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
      this.sampleRate === DSP_SAMPLE_RATE ? null : new Resampler(DSP_SAMPLE_RATE, this.sampleRate);
  }

  get tags(): SPCTags {
    return this.file?.tags ?? {};
  }

  /** Seconds of music before the fade begins. */
  get playSeconds(): number {
    const t = this.tags;
    if (t.introSeconds != null && t.loopSeconds != null) {
      const loops = t.loopCount ?? this.options.loopCount;
      return t.introSeconds + t.loopSeconds * loops + (t.endSeconds ?? 0);
    }
    return t.playSeconds ?? this.options.defaultPlaySeconds;
  }

  get fadeSeconds(): number {
    const ms = this.tags.fadeMilliseconds;
    return ms != null ? ms / 1000 : this.options.defaultFadeSeconds;
  }

  get totalSeconds(): number {
    return this.playSeconds + this.fadeSeconds;
  }

  /** Output samples currently rendered, as a time in seconds. */
  get currentTime(): number {
    return this.outputSample / this.sampleRate;
  }

  // ----------------------------------------------------------------- loading

  load(input: Uint8Array | ArrayBuffer | SPCFile): void {
    const file =
      input instanceof Uint8Array || input instanceof ArrayBuffer ? parseSPC(input) : input;
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
    // Base pitches come from the sample data itself; the directory page is the
    // DSP register the dump left behind.
    this.tuning = new Tuning(apu.ram, apu.dsp.regs[0x5d]);
    apu.dsp.noteOnEvents.length = 0;
    const candidates = apu.dsp.restoreFromSnapshot(this.options.resumeVoices);
    if (this.options.retriggerKeyOn && candidates !== 0) {
      apu.dsp.applyKeyOnRecovery(candidates);
    }

    this.outputSample = 0;
    this.dspSample = 0;
    this.resampler?.reset();
  }

  /** Zero the region the DSP is using as its echo buffer. */
  private clearEchoRegion(): void {
    const dsp = this.apu.dsp;
    // Echo writes disabled means this memory is not an echo buffer right now,
    // and clearing it could destroy something the driver still needs.
    if (dsp.regs[0x6c] & 0x20) return;
    const start = dsp.regs[0x6d] << 8;
    const length = Math.max(4, (dsp.regs[0x7d] & 0x0f) * 0x800);
    for (let i = 0; i < length; i++) this.apu.ram[(start + i) & 0xffff] = 0;
  }

  // --------------------------------------------------------------- rendering

  /**
   * Render `count` output samples into the supplied stereo buffers.
   * Returns the number of samples written (always `count`).
   */
  renderInto(left: Int16Array, right: Int16Array, offset: number, count: number): number {
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

  /** Render `count` output samples into freshly allocated buffers. */
  render(count: number): { left: Int16Array; right: Int16Array } {
    const left = new Int16Array(count);
    const right = new Int16Array(count);
    this.renderInto(left, right, 0, count);
    return { left, right };
  }

  /** Advance without producing output; used to reach a seek target. */
  skip(count: number): void {
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

  private applyFade(left: Int16Array, right: Int16Array, offset: number, count: number): void {
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

  // -------------------------------------------------------------------- state

  /** Snapshot for instant seeking. Pair it with {@link restoreState}. */
  saveState(): SPCPlayerState {
    return {
      apu: this.apu.saveState(),
      outputSample: this.outputSample,
      dspSample: this.dspSample,
      resampler: this.resampler?.saveState() ?? null,
    };
  }

  restoreState(state: SPCPlayerState): void {
    this.apu.loadState(state.apu);
    this.outputSample = state.outputSample;
    this.dspSample = state.dspSample;
    if (this.resampler != null) {
      if (state.resampler != null) this.resampler.loadState(state.resampler);
      else this.resampler.reset();
    }
  }

  // ------------------------------------------------------------ channel mask

  /** Bit per voice: 1 = muted in the output mix. Emulation is unaffected. */
  setVoiceMask(mask: number): void {
    this.apu.dsp.voiceMask = mask & 0xff;
  }

  getVoiceMask(): number {
    return this.apu.dsp.voiceMask;
  }

  // ---------------------------------------------------------------- inspection

  getVoiceStatus(index: number): VoiceStatus {
    const dsp = this.apu.dsp;
    const v = dsp.voices[index];
    const base = index << 4;
    const bit = 1 << index;
    const source = dsp.regs[base + 0x04];
    const pitch = dsp.pitchOf(index);
    const active = dsp.isActive(index);
    return {
      index,
      active,
      envelope: v.envelope,
      volumeLeft: (dsp.regs[base + 0x00] << 24) >> 24,
      volumeRight: (dsp.regs[base + 0x01] << 24) >> 24,
      pitch,
      note: active && pitch > 0 ? this.tuning?.noteOf(source, pitch) ?? null : null,
      semitone: active && pitch > 0 ? 12 * Math.log2(pitch / 0x1000) : null,
      tuningConfidence: this.tuning?.baseOf(source).confidence ?? 0,
      source,
      noise: (dsp.regs[0x3d] & bit) !== 0,
      echo: (dsp.regs[0x4d] & bit) !== 0,
      pitchModulated: (dsp.regs[0x2d] & bit) !== 0,
      envelopeMode: v.envelopeMode,
      keyOnAt: v.keyOnAt,
      keyOnCount: v.keyOnCount,
    };
  }

  getVoiceStatusArray(): VoiceStatus[] {
    const out: VoiceStatus[] = [];
    for (let i = 0; i < 8; i++) out.push(this.getVoiceStatus(i));
    return out;
  }

  /** DSP samples rendered since load; the timebase of {@link VoiceStatus.keyOnAt}. */
  get dspSampleCount(): number {
    return this.dspSample;
  }
}

