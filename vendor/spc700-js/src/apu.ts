/**
 * The SPC700 audio subsystem as a whole: 64 KB of RAM, the CPU, the three
 * timers and the S-DSP.
 *
 * An .spc file is a snapshot of exactly this, taken with the S-CPU already out
 * of the picture, so the four CPU I/O ports are read-only latches holding
 * whatever the S-CPU last wrote. That is what makes a dump self-contained: the
 * driver keeps running off its timers and never gets new commands.
 */

import { DSP } from "./dsp.js";
import { SPC700, type SPCBus } from "./spc700.js";

export const CPU_CLOCK = 1024000;
/** CPU cycles per 32 kHz DSP sample. */
export const CYCLES_PER_SAMPLE = 32;

/** Number of Int32 slots {@link SPCAPU.saveState} uses per voice. */
const VOICE_FIELDS = 13;

class Timer {
  enabled = false;
  /** Divider; 0 means 256. */
  target = 0;
  /** Cycle accumulator against {@link period}. */
  divider = 0;
  /** Internal 8-bit stage counter. */
  stage = 0;
  /** 4-bit counter visible to the CPU. */
  out = 0;

  constructor(readonly period: number) {}

  setEnabled(on: boolean): void {
    if (on && !this.enabled) {
      this.stage = 0;
      this.out = 0;
    }
    this.enabled = on;
  }

  step(cycles: number): void {
    this.divider += cycles;
    while (this.divider >= this.period) {
      this.divider -= this.period;
      if (!this.enabled) continue;
      if (++this.stage >= (this.target === 0 ? 256 : this.target)) {
        this.stage = 0;
        this.out = (this.out + 1) & 0x0f;
      }
    }
  }
}

export interface APUState {
  ram: Uint8Array;
  dspRegs: Uint8Array;
  cpu: Int32Array;
  dsp: Int32Array;
  voices: Int32Array;
  voiceBuffers: Int32Array;
  timers: Int32Array;
  io: Int32Array;
}

export class SPCAPU implements SPCBus {
  readonly ram = new Uint8Array(0x10000);
  readonly dsp = new DSP(this.ram);
  readonly cpu = new SPC700(this);

  /** 64-byte boot ROM, supplied by the .spc dump. */
  readonly iplRom = new Uint8Array(64);

  private control = 0;
  private dspAddr = 0;
  /** Values the S-CPU last wrote; a dump freezes these forever. */
  private readonly inputPorts = new Uint8Array(4);
  private readonly outputPorts = new Uint8Array(4);

  private readonly timers = [new Timer(128), new Timer(128), new Timer(16)];

  /** CPU cycles already run against the DSP sample in progress. */
  private cycleDebt = 0;

  private readonly sampleOut = new Int32Array(2);

  reset(): void {
    this.ram.fill(0);
    this.dsp.reset();
    this.control = 0;
    this.dspAddr = 0;
    this.inputPorts.fill(0);
    this.outputPorts.fill(0);
    for (const t of this.timers) {
      t.enabled = false;
      t.target = 0;
      t.divider = 0;
      t.stage = 0;
      t.out = 0;
    }
    this.cycleDebt = 0;
    this.cpu.reset();
  }

  // ---------------------------------------------------------------------- bus

  read(addr: number): number {
    if ((addr & 0xfff0) === 0x00f0) {
      switch (addr & 0x0f) {
        case 0x00:
          return 0;
        case 0x01:
          return this.control;
        case 0x02:
          return this.dspAddr;
        case 0x03:
          return this.dsp.read(this.dspAddr & 0x7f);
        case 0x04:
        case 0x05:
        case 0x06:
        case 0x07:
          return this.inputPorts[(addr & 0x0f) - 4];
        case 0x08:
        case 0x09:
          return this.ram[addr];
        case 0x0a:
        case 0x0b:
        case 0x0c:
          return 0; // timer targets are write-only
        case 0x0d:
        case 0x0e:
        case 0x0f: {
          const t = this.timers[(addr & 0x0f) - 0x0d];
          const v = t.out;
          t.out = 0;
          return v;
        }
      }
    }
    if (addr >= 0xffc0 && this.control & 0x80) {
      return this.iplRom[addr - 0xffc0];
    }
    return this.ram[addr];
  }

  write(addr: number, value: number): void {
    if ((addr & 0xfff0) === 0x00f0) {
      switch (addr & 0x0f) {
        case 0x00:
          return; // TEST
        case 0x01:
          this.control = value;
          this.timers[0].setEnabled((value & 0x01) !== 0);
          this.timers[1].setEnabled((value & 0x02) !== 0);
          this.timers[2].setEnabled((value & 0x04) !== 0);
          if (value & 0x10) {
            this.inputPorts[0] = 0;
            this.inputPorts[1] = 0;
          }
          if (value & 0x20) {
            this.inputPorts[2] = 0;
            this.inputPorts[3] = 0;
          }
          return;
        case 0x02:
          this.dspAddr = value;
          return;
        case 0x03:
          if (!(this.dspAddr & 0x80)) this.dsp.write(this.dspAddr & 0x7f, value);
          return;
        case 0x04:
        case 0x05:
        case 0x06:
        case 0x07:
          this.outputPorts[(addr & 0x0f) - 4] = value;
          return;
        case 0x08:
        case 0x09:
          this.ram[addr] = value;
          return;
        case 0x0a:
        case 0x0b:
        case 0x0c:
          this.timers[(addr & 0x0f) - 0x0a].target = value;
          return;
        default:
          return; // timer counters are read-only
      }
    }
    this.ram[addr] = value;
  }

  // ------------------------------------------------------------------- render

  /** Run the machine forward by one 32 kHz sample; writes signed 16-bit L/R. */
  renderSample(out: Int32Array): void {
    while (this.cycleDebt < CYCLES_PER_SAMPLE) {
      const c = this.cpu.step();
      this.cycleDebt += c;
      this.timers[0].step(c);
      this.timers[1].step(c);
      this.timers[2].step(c);
    }
    this.cycleDebt -= CYCLES_PER_SAMPLE;
    this.dsp.runSample(out);
  }

  /** Run `count` samples, discarding the output (fast-forward for seeking). */
  skipSamples(count: number): void {
    for (let i = 0; i < count; i++) this.renderSample(this.sampleOut);
  }

  // -------------------------------------------------------------------- state

  /**
   * Capture the complete machine state. Everything is in transferable typed
   * arrays so a snapshot can be posted between workers cheaply — this is what
   * a player uses for instant seeking.
   */
  saveState(): APUState {
    const cpu = Int32Array.of(
      this.cpu.A,
      this.cpu.X,
      this.cpu.Y,
      this.cpu.SP,
      this.cpu.PC,
      this.cpu.PSW,
      this.cpu.halted ? 1 : 0,
      this.cycleDebt
    );

    const d = this.dsp as unknown as Record<string, number>;
    const dspState = Int32Array.of(
      d.counter,
      d.noise,
      d.konLatch,
      d.konPending,
      d.echoOffset,
      d.echoLength,
      d.firIndex,
      this.dsp.voiceMask,
      this.dsp.echoMask,
      this.dsp.sampleCount
    );
    const fir = this.dsp as unknown as { firL: Int32Array; firR: Int32Array };
    const firBase = dspState.length;
    const dspFull = new Int32Array(firBase + 16);
    dspFull.set(dspState);
    dspFull.set(fir.firL, firBase);
    dspFull.set(fir.firR, firBase + 8);

    const voices = new Int32Array(8 * VOICE_FIELDS);
    const voiceBuffers = new Int32Array(8 * 12);
    for (let i = 0; i < 8; i++) {
      const v = this.dsp.voices[i];
      voices.set(
        [
          v.bufferPos,
          v.decoded,
          v.brrAddress,
          v.brrOffset,
          v.brrHeader,
          v.envelope,
          v.hiddenEnvelope,
          v.envelopeMode,
          v.keyonDelay,
          v.gaussianOffset,
          v.outx,
          v.keyOnAt,
          v.keyOnCount,
        ],
        i * VOICE_FIELDS
      );
      voiceBuffers.set(v.buffer, i * 12);
    }

    const timers = new Int32Array(3 * 5);
    for (let i = 0; i < 3; i++) {
      const t = this.timers[i];
      timers.set([t.enabled ? 1 : 0, t.target, t.divider, t.stage, t.out], i * 5);
    }

    const io = Int32Array.of(
      this.control,
      this.dspAddr,
      this.inputPorts[0],
      this.inputPorts[1],
      this.inputPorts[2],
      this.inputPorts[3],
      this.outputPorts[0],
      this.outputPorts[1],
      this.outputPorts[2],
      this.outputPorts[3]
    );

    return {
      ram: this.ram.slice(),
      dspRegs: this.dsp.regs.slice(),
      cpu,
      dsp: dspFull,
      voices,
      voiceBuffers,
      timers,
      io,
    };
  }

  /** Restore a snapshot produced by {@link saveState}. */
  loadState(s: APUState): void {
    this.ram.set(s.ram);
    this.dsp.regs.set(s.dspRegs);

    this.cpu.A = s.cpu[0];
    this.cpu.X = s.cpu[1];
    this.cpu.Y = s.cpu[2];
    this.cpu.SP = s.cpu[3];
    this.cpu.PC = s.cpu[4];
    this.cpu.PSW = s.cpu[5];
    this.cpu.halted = s.cpu[6] !== 0;
    this.cycleDebt = s.cpu[7];

    const d = this.dsp as unknown as Record<string, number>;
    d.counter = s.dsp[0];
    d.noise = s.dsp[1];
    d.konLatch = s.dsp[2];
    d.konPending = s.dsp[3];
    d.echoOffset = s.dsp[4];
    d.echoLength = s.dsp[5];
    d.firIndex = s.dsp[6];
    this.dsp.voiceMask = s.dsp[7];
    this.dsp.echoMask = s.dsp[8];
    this.dsp.sampleCount = s.dsp[9];
    const fir = this.dsp as unknown as { firL: Int32Array; firR: Int32Array };
    fir.firL.set(s.dsp.subarray(10, 18));
    fir.firR.set(s.dsp.subarray(18, 26));

    for (let i = 0; i < 8; i++) {
      const v = this.dsp.voices[i];
      const o = i * VOICE_FIELDS;
      v.bufferPos = s.voices[o + 0];
      v.decoded = s.voices[o + 1];
      v.brrAddress = s.voices[o + 2];
      v.brrOffset = s.voices[o + 3];
      v.brrHeader = s.voices[o + 4];
      v.envelope = s.voices[o + 5];
      v.hiddenEnvelope = s.voices[o + 6];
      v.envelopeMode = s.voices[o + 7];
      v.keyonDelay = s.voices[o + 8];
      v.gaussianOffset = s.voices[o + 9];
      v.outx = s.voices[o + 10];
      v.keyOnAt = s.voices[o + 11];
      v.keyOnCount = s.voices[o + 12];
      v.buffer.set(s.voiceBuffers.subarray(i * 12, i * 12 + 12));
    }

    for (let i = 0; i < 3; i++) {
      const t = this.timers[i];
      const o = i * 5;
      t.enabled = s.timers[o + 0] !== 0;
      t.target = s.timers[o + 1];
      t.divider = s.timers[o + 2];
      t.stage = s.timers[o + 3];
      t.out = s.timers[o + 4];
    }

    this.control = s.io[0];
    this.dspAddr = s.io[1];
    for (let i = 0; i < 4; i++) {
      this.inputPorts[i] = s.io[2 + i];
      this.outputPorts[i] = s.io[6 + i];
    }
  }

  // --------------------------------------------------------------- dump setup

  /**
   * Install the CPU-visible register block from the values a dump left in
   * $00F0-$00FF. The dumped RAM image holds the last values written to those
   * addresses, which is how the timers and ports come back at the right state.
   */
  applyRegisterBlock(): void {
    this.control = this.ram[0xf1];
    this.dspAddr = this.ram[0xf2];
    for (let i = 0; i < 4; i++) this.inputPorts[i] = this.ram[0xf4 + i];
    for (let i = 0; i < 3; i++) {
      const t = this.timers[i];
      t.target = this.ram[0xfa + i];
      t.enabled = (this.control & (1 << i)) !== 0;
      t.stage = 0;
      t.out = this.ram[0xfd + i] & 0x0f;
      t.divider = 0;
    }
  }
}

