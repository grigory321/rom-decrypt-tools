import { DSP } from './dsp.js';

import { SPC700 } from './spc700.js';

export const CPU_CLOCK = 1024e3;

export const CYCLES_PER_SAMPLE = 32;

const VOICE_FIELDS = 13;

class Timer {
  period;
  enabled = false;
  target = 0;
  divider = 0;
  stage = 0;
  out = 0;
  constructor(period) {
    this.period = period;
  }
  setEnabled(on) {
    if (on && !this.enabled) {
      this.stage = 0;
      this.out = 0;
    }
    this.enabled = on;
  }
  step(cycles) {
    this.divider += cycles;
    while (this.divider >= this.period) {
      this.divider -= this.period;
      if (!this.enabled) continue;
      if (++this.stage >= (this.target === 0 ? 256 : this.target)) {
        this.stage = 0;
        this.out = (this.out + 1) & 15;
      }
    }
  }
}

export class SPCAPU {
  ram = new Uint8Array(65536);
  dsp = new DSP(this.ram);
  cpu = new SPC700(this);
  iplRom = new Uint8Array(64);
  control = 0;
  dspAddr = 0;
  inputPorts = new Uint8Array(4);
  outputPorts = new Uint8Array(4);
  timers = [new Timer(128), new Timer(128), new Timer(16)];
  cycleDebt = 0;
  sampleOut = new Int32Array(2);
  reset() {
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
  read(addr) {
    if ((addr & 65520) === 240) {
      switch (addr & 15) {
        case 0:
          return 0;

        case 1:
          return this.control;

        case 2:
          return this.dspAddr;

        case 3:
          return this.dsp.read(this.dspAddr & 127);

        case 4:
        case 5:
        case 6:
        case 7:
          return this.inputPorts[(addr & 15) - 4];

        case 8:
        case 9:
          return this.ram[addr];

        case 10:
        case 11:
        case 12:
          return 0;

        case 13:
        case 14:
        case 15: {
          const t = this.timers[(addr & 15) - 13];
          const v = t.out;
          t.out = 0;
          return v;
        }
      }
    }
    if (addr >= 65472 && this.control & 128) {
      return this.iplRom[addr - 65472];
    }
    return this.ram[addr];
  }
  write(addr, value) {
    if ((addr & 65520) === 240) {
      switch (addr & 15) {
        case 0:
          return;

        case 1:
          this.control = value;
          this.timers[0].setEnabled((value & 1) !== 0);
          this.timers[1].setEnabled((value & 2) !== 0);
          this.timers[2].setEnabled((value & 4) !== 0);
          if (value & 16) {
            this.inputPorts[0] = 0;
            this.inputPorts[1] = 0;
          }
          if (value & 32) {
            this.inputPorts[2] = 0;
            this.inputPorts[3] = 0;
          }
          return;

        case 2:
          this.dspAddr = value;
          return;

        case 3:
          if (!(this.dspAddr & 128)) this.dsp.write(this.dspAddr & 127, value);
          return;

        case 4:
        case 5:
        case 6:
        case 7:
          this.outputPorts[(addr & 15) - 4] = value;
          return;

        case 8:
        case 9:
          this.ram[addr] = value;
          return;

        case 10:
        case 11:
        case 12:
          this.timers[(addr & 15) - 10].target = value;
          return;

        default:
          return;
      }
    }
    this.ram[addr] = value;
  }
  renderSample(out) {
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
  skipSamples(count) {
    for (let i = 0; i < count; i++) this.renderSample(this.sampleOut);
  }
  saveState() {
    const cpu = Int32Array.of(
      this.cpu.A,
      this.cpu.X,
      this.cpu.Y,
      this.cpu.SP,
      this.cpu.PC,
      this.cpu.PSW,
      this.cpu.halted ? 1 : 0,
      this.cycleDebt,
    );
    const d = this.dsp;
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
      this.dsp.sampleCount,
    );
    const fir = this.dsp;
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
        i * VOICE_FIELDS,
      );
      voiceBuffers.set(v.buffer, i * 12);
    }
    const timers = new Int32Array(3 * 5);
    for (let i = 0; i < 3; i++) {
      const t = this.timers[i];
      timers.set(
        [t.enabled ? 1 : 0, t.target, t.divider, t.stage, t.out],
        i * 5,
      );
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
      this.outputPorts[3],
    );
    return {
      ram: this.ram.slice(),
      dspRegs: this.dsp.regs.slice(),
      cpu: cpu,
      dsp: dspFull,
      voices: voices,
      voiceBuffers: voiceBuffers,
      timers: timers,
      io: io,
    };
  }
  loadState(s) {
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
    const d = this.dsp;
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
    const fir = this.dsp;
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
  applyRegisterBlock() {
    this.control = this.ram[241];
    this.dspAddr = this.ram[242];
    for (let i = 0; i < 4; i++) this.inputPorts[i] = this.ram[244 + i];
    for (let i = 0; i < 3; i++) {
      const t = this.timers[i];
      t.target = this.ram[250 + i];
      t.enabled = (this.control & (1 << i)) !== 0;
      t.stage = 0;
      t.out = this.ram[253 + i] & 15;
      t.divider = 0;
    }
  }
}
