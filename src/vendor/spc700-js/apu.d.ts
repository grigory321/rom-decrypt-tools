import { DSP } from './dsp.js';
import { SPC700, type SPCBus } from './spc700.js';
export declare const CPU_CLOCK = 1024000;
export declare const CYCLES_PER_SAMPLE = 32;
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
export declare class SPCAPU implements SPCBus {
  readonly ram: Uint8Array<ArrayBuffer>;
  readonly dsp: DSP;
  readonly cpu: SPC700;
  readonly iplRom: Uint8Array<ArrayBuffer>;
  control: number;
  dspAddr: number;
  readonly inputPorts: Uint8Array;
  readonly outputPorts: Uint8Array;
  readonly timers: { target: number; out: number }[];
  private cycleDebt;
  readonly sampleOut: Int32Array;
  reset(): void;
  read(addr: number): number;
  write(addr: number, value: number): void;
  renderSample(out: Int32Array): void;
  skipSamples(count: number): void;
  saveState(): APUState;
  loadState(s: APUState): void;
  applyRegisterBlock(): void;
}
