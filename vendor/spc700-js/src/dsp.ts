/**
 * Sony S-DSP (SPC700 audio DSP) core.
 *
 * Sample-level model: each call to {@link runSample} advances the whole DSP by
 * one 32000 Hz output sample rather than replicating the 32-step-per-sample
 * hardware pipeline. The per-voice behaviour that music depends on — the
 * 5-sample key-on delay, the BRR decoder with its end/loop flags, ADSR/GAIN
 * with the hardware rate counter, gaussian interpolation with its mid-sum
 * 16-bit wrap, pitch modulation, noise and the echo FIR — is all modelled
 * exactly. What is *not* modelled is the intra-sample ordering of register
 * reads (a driver that polls ENDX/ENVX at a precise cycle within a sample can
 * observe a one-sample difference from hardware).
 */

import { GAUSS_TABLE } from "./gaussian.js";

export const DSP_SAMPLE_RATE = 32000;

/** Voice register offsets within a voice's 16-byte block. */
const VOL_L = 0x00;
const VOL_R = 0x01;
const PITCH_L = 0x02;
const PITCH_H = 0x03;
const SRCN = 0x04;
const ADSR1 = 0x05;
const ADSR2 = 0x06;
const GAIN = 0x07;
const ENVX = 0x08;
const OUTX = 0x09;

/** Global register addresses. */
const R_MVOL_L = 0x0c;
const R_MVOL_R = 0x1c;
const R_EVOL_L = 0x2c;
const R_EVOL_R = 0x3c;
const R_KON = 0x4c;
const R_KOF = 0x5c;
const R_FLG = 0x6c;
const R_ENDX = 0x7c;
const R_EFB = 0x0d;
const R_PMON = 0x2d;
const R_NON = 0x3d;
const R_EON = 0x4d;
const R_DIR = 0x5d;
const R_ESA = 0x6d;
const R_EDL = 0x7d;

/** Envelope rate -> global counter period. Index 0 means "never fires". */
// prettier-ignore
const COUNTER_RATE = new Uint16Array([
     0, 2048, 1536, 1280, 1024,  768,  640,  512,
   384,  320,  256,  192,  160,  128,   96,   80,
    64,   48,   40,   32,   24,   20,   16,   12,
    10,    8,    6,    5,    4,    3,    2,    1,
]);

/** Phase offset that staggers rates sharing a period. */
// prettier-ignore
const COUNTER_OFFSET = new Uint16Array([
     0,    0, 1040,  536,    0, 1040,  536,    0,
  1040,  536,    0, 1040,  536,    0, 1040,  536,
     0, 1040,  536,    0, 1040,  536,    0, 1040,
   536,    0, 1040,  536,    0, 1040,    0,    0,
]);

const COUNTER_RANGE = 30720;

/**
 * Pitch counter units per BRR sample. The fractional position is 12 bits wide,
 * which is why the interpolation phase is extracted as `offset >> 4 & 0xff`,
 * and why a PITCH of $1000 plays the sample back at exactly 32000 Hz. The
 * 14-bit pitch register therefore tops out at just under 4x speed.
 */
const PITCH_ONE = 0x1000;

export enum EnvMode {
  Release = 0,
  Attack = 1,
  Decay = 2,
  Sustain = 3,
}

function clamp16(v: number): number {
  return v < -32768 ? -32768 : v > 32767 ? 32767 : v;
}

function sext16(v: number): number {
  return (v << 16) >> 16;
}

export class Voice {
  /** Decoded BRR ring. Values are stored at 2x the true sample amplitude, the
   *  same convention the hardware's BRR pipeline uses. */
  readonly buffer = new Int32Array(12);
  /** Index in {@link buffer} of the oldest of the four interpolation taps. */
  bufferPos = 0;
  /** Number of decoded samples available at and after {@link bufferPos}. */
  decoded = 0;

  brrAddress = 0;
  brrOffset = 1;
  brrHeader = 0;

  envelope = 0;
  hiddenEnvelope = 0;
  envelopeMode: EnvMode = EnvMode.Release;

  keyonDelay = 0;
  gaussianOffset = 0;

  /** Last sample this voice produced, used for the next voice's pitch mod. */
  outx = 0;

  /** Absolute DSP sample index of the most recent key-on (for visualisers). */
  keyOnAt = 0;
  /** How many key-ons this voice has seen since reset. */
  keyOnCount = 0;

  reset(): void {
    this.buffer.fill(0);
    this.bufferPos = 0;
    this.decoded = 0;
    this.brrAddress = 0;
    this.brrOffset = 1;
    this.brrHeader = 0;
    this.envelope = 0;
    this.hiddenEnvelope = 0;
    this.envelopeMode = EnvMode.Release;
    this.keyonDelay = 0;
    this.gaussianOffset = 0;
    this.outx = 0;
    this.keyOnAt = 0;
    this.keyOnCount = 0;
  }
}

export class DSP {
  readonly regs = new Uint8Array(128);
  readonly voices: Voice[] = [];

  /** Bit per voice: 1 = excluded from the output mix (emulation unaffected). */
  voiceMask = 0;
  /** Bit per voice: 1 = excluded from the echo send. */
  echoMask = 0;

  /** Absolute count of samples produced since reset. */
  sampleCount = 0;

  /**
   * (srcn, pitch) pairs from voices that have just finished their key-on delay,
   * appended as they happen and drained by the player. Sampling at the end of
   * the delay rather than at the KON write means the driver has finished
   * writing the pitch registers for the note.
   */
  readonly noteOnEvents: number[] = [];

  /**
   * Each voice's output for the sample just rendered, post-envelope and before
   * the per-voice volume is applied.
   *
   * Unlike a chip whose channels only exist in the mix, the S-DSP computes
   * every voice separately and then sums them, so keeping these costs eight
   * stores per sample — no second synthesis pass is needed to show per-voice
   * waveforms.
   */
  readonly voiceOut = new Int16Array(8);

  private counter = 0;
  private noise = 0x4000;

  private konLatch = 0;
  private konPending = 0;

  private echoOffset = 0;
  private echoLength = 0;

  private readonly firL = new Int32Array(8);
  private readonly firR = new Int32Array(8);
  private firIndex = 0;

  constructor(private ram: Uint8Array) {
    for (let i = 0; i < 8; i++) this.voices.push(new Voice());
    this.reset();
  }

  reset(): void {
    this.regs.fill(0);
    this.regs[R_FLG] = 0xe0;
    for (const v of this.voices) v.reset();
    this.sampleCount = 0;
    this.counter = 0;
    this.noise = 0x4000;
    this.konLatch = 0;
    this.konPending = 0;
    this.echoOffset = 0;
    this.echoLength = 0;
    this.firL.fill(0);
    this.firR.fill(0);
    this.firIndex = 0;
  }

  read(addr: number): number {
    return this.regs[addr & 0x7f];
  }

  write(addr: number, value: number): void {
    addr &= 0x7f;
    value &= 0xff;
    this.regs[addr] = value;
    if (addr === R_KON) {
      this.konLatch = value;
    } else if (addr === R_ENDX) {
      // Any write clears ENDX entirely.
      this.regs[R_ENDX] = 0;
    }
  }

  // -------------------------------------------------------------- rate counter

  private counterTick(): void {
    if (--this.counter < 0) this.counter = COUNTER_RANGE - 1;
  }

  private counterPoll(rate: number): boolean {
    if (rate === 0) return false;
    return (this.counter + COUNTER_OFFSET[rate]) % COUNTER_RATE[rate] === 0;
  }

  // ---------------------------------------------------------------- BRR decode

  private dirEntry(srcn: number, which: 0 | 1): number {
    const a = ((this.regs[R_DIR] << 8) + srcn * 4 + which * 2) & 0xffff;
    return this.ram[a] | (this.ram[(a + 1) & 0xffff] << 8);
  }

  /** Decode the next four BRR samples into the voice's ring buffer. */
  private decodeGroup(v: Voice, index: number): void {
    const header = this.ram[v.brrAddress];
    v.brrHeader = header;
    const shift = header >> 4;
    const filter = (header >> 2) & 3;

    const b0 = this.ram[(v.brrAddress + v.brrOffset) & 0xffff];
    const b1 = this.ram[(v.brrAddress + v.brrOffset + 1) & 0xffff];
    const nibbles = [b0 >> 4, b0 & 0x0f, b1 >> 4, b1 & 0x0f];

    for (let n = 0; n < 4; n++) {
      let s = (nibbles[n] << 28) >> 28; // sign-extend 4 bits
      if (shift <= 12) {
        s = (s << shift) >> 1;
      } else {
        // Shifts 13-15 collapse to +0 / -2048 on hardware.
        s = (s >> 3) << 11;
      }

      const wp = (v.bufferPos + v.decoded) % 12;
      const p1 = v.buffer[(wp + 11) % 12]; // 2x previous sample
      const p2 = v.buffer[(wp + 10) % 12] >> 1; // 1x sample before that

      switch (filter) {
        case 1:
          s += p1 >> 1;
          s += -p1 >> 5;
          break;
        case 2:
          s += p1;
          s += -(p1 + (p1 >> 1)) >> 5;
          s -= p2;
          s += p2 >> 4;
          break;
        case 3:
          s += p1;
          s += -(p1 + (p1 << 2) + (p1 << 3)) >> 7;
          s -= p2;
          s += (p2 + (p2 << 1)) >> 4;
          break;
      }

      // Clamp to 16 bits, then keep only 15 bits of magnitude by doubling and
      // letting the result wrap — this overflow is audible on real hardware.
      v.buffer[wp] = sext16(clamp16(s) * 2);
      v.decoded++;
    }

    v.brrOffset += 2;
    if (v.brrOffset >= 9) {
      v.brrOffset = 1;
      v.brrAddress = (v.brrAddress + 9) & 0xffff;
      if (header & 1) {
        this.regs[R_ENDX] |= 1 << index;
        if (header & 2) {
          v.brrAddress = this.dirEntry(this.regs[(index << 4) | SRCN], 1);
        } else {
          v.envelope = 0;
          v.envelopeMode = EnvMode.Release;
        }
      }
    }
  }

  private gaussianInterpolate(v: Voice): number {
    const off = (v.gaussianOffset >> 4) & 0xff;
    let i = v.bufferPos;
    let out = (GAUSS_TABLE[255 - off] * v.buffer[i]) >> 11;
    i = i === 11 ? 0 : i + 1;
    out += (GAUSS_TABLE[511 - off] * v.buffer[i]) >> 11;
    i = i === 11 ? 0 : i + 1;
    out += (GAUSS_TABLE[256 + off] * v.buffer[i]) >> 11;
    i = i === 11 ? 0 : i + 1;
    // The hardware accumulator is only 16 bits wide at this point.
    out = sext16(out);
    out += (GAUSS_TABLE[off] * v.buffer[i]) >> 11;
    return clamp16(out) & ~1;
  }

  // ------------------------------------------------------------------ envelope

  private envelopeRun(v: Voice, base: number): void {
    let env = v.envelope;

    if (v.envelopeMode === EnvMode.Release) {
      env -= 8;
      v.envelope = env < 0 ? 0 : env;
      return;
    }

    let rate: number;
    let envData = this.regs[base + ADSR2];
    const adsr1 = this.regs[base + ADSR1];

    if (adsr1 & 0x80) {
      if (v.envelopeMode === EnvMode.Decay) {
        env--;
        env -= env >> 8;
        rate = ((adsr1 >> 3) & 0x0e) + 0x10;
      } else if (v.envelopeMode === EnvMode.Sustain) {
        env--;
        env -= env >> 8;
        rate = envData & 0x1f;
      } else {
        rate = (adsr1 & 0x0f) * 2 + 1;
        env += rate < 31 ? 0x20 : 0x400;
      }
    } else {
      envData = this.regs[base + GAIN];
      const mode = envData >> 5;
      if (mode < 4) {
        // Direct gain: the level is taken verbatim every sample.
        env = (envData & 0x7f) * 0x10;
        rate = 31;
      } else {
        rate = envData & 0x1f;
        if (mode === 4) {
          env -= 0x20;
        } else if (mode === 5) {
          env--;
          env -= env >> 8;
        } else if (mode === 6) {
          env += 0x20;
        } else {
          env += v.hiddenEnvelope < 0x600 ? 0x20 : 0x08;
        }
      }
    }

    // Sustain level check. In GAIN mode this compares against the gain mode
    // bits instead of a sustain level — a hardware quirk, reproduced as-is.
    if (env >> 8 === envData >> 5 && v.envelopeMode === EnvMode.Decay) {
      v.envelopeMode = EnvMode.Sustain;
    }
    v.hiddenEnvelope = env;

    if (env < 0 || env > 0x7ff) {
      env = env < 0 ? 0 : 0x7ff;
      if (v.envelopeMode === EnvMode.Attack) v.envelopeMode = EnvMode.Decay;
    }

    if (this.counterPoll(rate)) v.envelope = env;
  }

  // ---------------------------------------------------------------- per-sample

  /**
   * Advance the DSP by one 32 kHz sample.
   *
   * @param out two-element array receiving the signed 16-bit L/R output.
   */
  runSample(out: Int32Array): void {
    const flg = this.regs[R_FLG];
    const softReset = (flg & 0x80) !== 0;

    this.counterTick();

    // Noise LFSR.
    if (this.counterPoll(flg & 0x1f)) {
      const feedback = (this.noise << 13) ^ (this.noise << 14);
      this.noise = (feedback & 0x4000) | (this.noise >> 1);
    }

    // Key-on is latched by the register write and takes effect one sample
    // later; key-off is level sensitive and is applied every sample.
    const kon = this.konPending;
    this.konPending = this.konLatch;
    this.konLatch = 0;
    const kof = this.regs[R_KOF];

    let mainL = 0;
    let mainR = 0;
    let echoInL = 0;
    let echoInR = 0;

    for (let i = 0; i < 8; i++) {
      const v = this.voices[i];
      const base = i << 4;
      const bit = 1 << i;

      if (kon & bit) {
        v.keyonDelay = 5;
        v.envelopeMode = EnvMode.Release;
        v.keyOnAt = this.sampleCount;
        v.keyOnCount++;
      }
      if (softReset || kof & bit) {
        v.envelopeMode = EnvMode.Release;
        if (softReset) v.envelope = 0;
      }

      if (v.keyonDelay > 0) {
        if (v.keyonDelay === 5) {
          v.brrAddress = this.dirEntry(this.regs[base + SRCN], 0);
          v.brrOffset = 1;
          v.bufferPos = 0;
          v.decoded = 0;
          v.buffer.fill(0);
          v.brrHeader = 0;
          this.regs[R_ENDX] &= ~bit;
        }
        v.envelope = 0;
        v.hiddenEnvelope = 0;
        v.keyonDelay--;
        // Start the new note on an exact sample boundary.
        v.gaussianOffset = 0;
        if (v.keyonDelay === 0) {
          v.envelopeMode = EnvMode.Attack;
          if (this.noteOnEvents.length < 4096) {
            this.noteOnEvents.push(this.regs[base + SRCN], this.pitchOf(i));
          }
        }
        v.outx = 0;
        this.voiceOut[i] = 0;
        this.regs[base + ENVX] = 0;
        this.regs[base + OUTX] = 0;
        continue;
      }

      // Keep the interpolation window fed.
      while (v.decoded < 4) this.decodeGroup(v, i);

      let sample: number;
      if (this.regs[R_NON] & bit) {
        sample = sext16(this.noise << 1);
      } else {
        sample = this.gaussianInterpolate(v);
      }

      this.envelopeRun(v, base);

      sample = ((sample * v.envelope) >> 11) & ~1;
      v.outx = sample;
      this.voiceOut[i] = sample;

      this.regs[base + ENVX] = v.envelope >> 4;
      this.regs[base + OUTX] = (sample >> 8) & 0xff;

      if (!(this.voiceMask & bit)) {
        mainL = clamp16(mainL + ((sample * ((this.regs[base + VOL_L] << 24) >> 24)) >> 7));
        mainR = clamp16(mainR + ((sample * ((this.regs[base + VOL_R] << 24) >> 24)) >> 7));
      }
      if (this.regs[R_EON] & bit & ~this.echoMask & ~this.voiceMask) {
        echoInL = clamp16(echoInL + ((sample * ((this.regs[base + VOL_L] << 24) >> 24)) >> 7));
        echoInR = clamp16(echoInR + ((sample * ((this.regs[base + VOL_R] << 24) >> 24)) >> 7));
      }

      // Advance the sample position, applying pitch modulation from the
      // previous voice's output where enabled.
      let step = this.regs[base + PITCH_L] | ((this.regs[base + PITCH_H] & 0x3f) << 8);
      if (i > 0 && this.regs[R_PMON] & bit) {
        const prev = this.voices[i - 1].outx;
        step += ((prev >> 5) * step) >> 10;
        if (step < 0) step = 0;
        if (step > 0x3fff) step = 0x3fff;
      }
      v.gaussianOffset += step;
      while (v.gaussianOffset >= PITCH_ONE) {
        v.gaussianOffset -= PITCH_ONE;
        v.bufferPos = v.bufferPos === 11 ? 0 : v.bufferPos + 1;
        v.decoded--;
        while (v.decoded < 4) this.decodeGroup(v, i);
      }
    }

    // ---- echo ----------------------------------------------------------
    // Only EDL is latched, and only when the buffer wraps; ESA is re-read on
    // every sample, exactly as the hardware does. Latching the base address
    // too would keep a driver that writes EDL before ESA pointed at the old
    // buffer for a whole buffer length, long enough for a large EDL to run the
    // write past the end of ARAM and wrap into the driver's own zero page.
    if (this.echoOffset === 0) {
      this.echoLength = (this.regs[R_EDL] & 0x0f) * 0x800;
    }
    const ea = ((this.regs[R_ESA] << 8) + this.echoOffset) & 0xffff;
    // The FIR history holds the echo samples halved. Together with the >> 6
    // below that makes a coefficient set summing to 128 a unity-gain filter,
    // which is what games assume — at full scale the loop would have 2x gain
    // and any sizeable EFB would send the echo into self-oscillation.
    const echoL = sext16(this.ram[ea] | (this.ram[(ea + 1) & 0xffff] << 8)) >> 1;
    const echoR = sext16(this.ram[(ea + 2) & 0xffff] | (this.ram[(ea + 3) & 0xffff] << 8)) >> 1;

    this.firIndex = (this.firIndex + 1) & 7;
    this.firL[this.firIndex] = echoL;
    this.firR[this.firIndex] = echoR;

    let firOutL = 0;
    let firOutR = 0;
    for (let t = 0; t < 7; t++) {
      const c = (this.regs[(t << 4) | 0x0f] << 24) >> 24;
      const h = (this.firIndex + 1 + t) & 7;
      firOutL += (this.firL[h] * c) >> 6;
      firOutR += (this.firR[h] * c) >> 6;
    }
    firOutL = sext16(firOutL);
    firOutR = sext16(firOutR);
    {
      const c = (this.regs[(7 << 4) | 0x0f] << 24) >> 24;
      firOutL = clamp16(firOutL + ((this.firL[this.firIndex] * c) >> 6)) & ~1;
      firOutR = clamp16(firOutR + ((this.firR[this.firIndex] * c) >> 6)) & ~1;
    }

    if (!(flg & 0x20)) {
      const efb = (this.regs[R_EFB] << 24) >> 24;
      const wL = clamp16(echoInL + ((firOutL * efb) >> 7)) & ~1;
      const wR = clamp16(echoInR + ((firOutR * efb) >> 7)) & ~1;
      this.ram[ea] = wL & 0xff;
      this.ram[(ea + 1) & 0xffff] = (wL >> 8) & 0xff;
      this.ram[(ea + 2) & 0xffff] = wR & 0xff;
      this.ram[(ea + 3) & 0xffff] = (wR >> 8) & 0xff;
    }

    this.echoOffset += 4;
    if (this.echoOffset >= this.echoLength) this.echoOffset = 0;

    // ---- master mix ----------------------------------------------------
    let outL = clamp16(
      ((mainL * ((this.regs[R_MVOL_L] << 24) >> 24)) >> 7) +
        ((firOutL * ((this.regs[R_EVOL_L] << 24) >> 24)) >> 7)
    );
    let outR = clamp16(
      ((mainR * ((this.regs[R_MVOL_R] << 24) >> 24)) >> 7) +
        ((firOutR * ((this.regs[R_EVOL_R] << 24) >> 24)) >> 7)
    );

    if (flg & 0x40) {
      outL = 0;
      outR = 0;
    }

    out[0] = outL;
    out[1] = outR;
    this.sampleCount++;
  }

  /**
   * Bring the DSP's internal state up after a dump's register block has been
   * written straight into {@link regs}.
   *
   * A dump captures the registers but not the DSP's internal pipeline, so the
   * BRR position of every sounding voice is lost. `resumeVoices` rebuilds
   * those voices from the envelope level left in ENVX, restarting their sample
   * from the beginning — held notes keep sounding, at the cost of a wrong
   * waveform phase for one note. Without it they stay silent until the driver
   * keys them again.
   */
  restoreFromSnapshot(resumeVoices: boolean): number {
    this.counter = 0;
    this.noise = 0x4000;
    this.echoOffset = 0;
    this.echoLength = 0;
    this.firL.fill(0);
    this.firR.fill(0);
    this.firIndex = 0;
    this.sampleCount = 0;

    this.konLatch = 0;
    const kon = this.regs[R_KON];
    const kof = this.regs[R_KOF];
    let pending = 0;

    /**
     * Put a voice back on the air at a known envelope level.
     *
     * The BRR read position is not part of a dump, so it has to be guessed. A
     * note still sounding when the snapshot was taken has, by definition, been
     * held — it is past its attack and somewhere inside its loop. Resuming at
     * the loop point rather than the start of the sample is therefore both more
     * likely to be right and much less conspicuous when it is wrong: starting
     * at the top replays the instrument's attack transient, which is heard as a
     * spurious hit over the opening bar.
     */
    const resumeAt = (i: number, envelope: number) => {
      const v = this.voices[i];
      const base = i << 4;
      const srcn = this.regs[base + SRCN];
      v.envelope = Math.min(0x7ff, envelope);
      v.hiddenEnvelope = v.envelope;
      v.envelopeMode = EnvMode.Sustain;
      v.brrAddress = this.dirEntry(srcn, 1);
      v.brrOffset = 1;
      v.bufferPos = 0;
      v.decoded = 0;
      v.gaussianOffset = 0;
    };

    for (let i = 0; i < 8; i++) {
      const base = i << 4;
      const bit = 1 << i;
      // Read the captured level before clearing the read-only registers.
      const capturedEnv = this.regs[base + ENVX];
      this.voices[i].reset();
      this.regs[base + ENVX] = 0;
      this.regs[base + OUTX] = 0;

      if (kof & bit) continue;

      // ENVX would say exactly how loud each voice was, but it is a read-only
      // register and what a dump holds is whatever the dumper left there: one
      // tool zeroes it, another fills it with $7F. Neither is the envelope. Off
      // by default; only trust it when the caller knows their dumps.
      if (resumeVoices && capturedEnv > 0) {
        resumeAt(i, capturedEnv << 4);
        continue;
      }

      // Many dumpers leave the read-only registers zeroed, so a sounding voice
      // is indistinguishable from a silent one by level alone. KON survives and
      // names the voices the driver last keyed — but not whether their notes
      // had already decayed away. Report them as candidates and let the caller
      // decide; see SPCPlayer's probe.
      if (kon & bit) pending |= bit;
    }

    this.konPending = 0;
    return pending;
  }

  /**
   * Put the given voices back on the air, as if the dump had caught them
   * mid-note. Used for the candidates that survive the player's probe.
   */
  applyKeyOnRecovery(mask: number): void {
    let pending = 0;
    for (let i = 0; i < 8; i++) {
      const bit = 1 << i;
      if (!(mask & bit)) continue;
      const base = i << 4;
      const adsr1 = this.regs[base + ADSR1];
      const gainMode = this.regs[base + GAIN] >> 5;
      if (!(adsr1 & 0x80) && (gainMode === 4 || gainMode === 5)) {
        // A GAIN decrease ramp keyed from zero would simply stay at zero, so
        // start the note near its peak and let the ramp bring it down.
        const v = this.voices[i];
        v.envelope = 0x7ff;
        v.hiddenEnvelope = 0x7ff;
        v.envelopeMode = EnvMode.Sustain;
        v.brrAddress = this.dirEntry(this.regs[base + SRCN], 0);
        v.brrOffset = 1;
        v.bufferPos = 0;
        v.decoded = 0;
        v.gaussianOffset = 0;
      } else {
        pending |= bit;
      }
    }
    this.konPending = pending;
  }

  // ------------------------------------------------------------------ queries

  /** Current envelope level (0..0x7ff) of a voice. */
  envelopeOf(index: number): number {
    return this.voices[index].envelope;
  }

  /** Whether a voice is currently producing sound. */
  isActive(index: number): boolean {
    const v = this.voices[index];
    return v.keyonDelay > 0 || v.envelope > 0;
  }

  /** 14-bit pitch step of a voice; 0x1000 means the BRR plays at 32000 Hz. */
  pitchOf(index: number): number {
    const base = index << 4;
    return this.regs[base + PITCH_L] | ((this.regs[base + PITCH_H] & 0x3f) << 8);
  }
}

