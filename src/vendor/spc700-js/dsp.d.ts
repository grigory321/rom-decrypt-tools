export declare const DSP_SAMPLE_RATE = 32000;
export declare enum EnvMode {
  Release = 0,
  Attack = 1,
  Decay = 2,
  Sustain = 3,
}
export declare class Voice {
  readonly buffer: Int32Array<ArrayBuffer>;
  bufferPos: number;
  decoded: number;
  brrAddress: number;
  brrOffset: number;
  brrHeader: number;
  envelope: number;
  hiddenEnvelope: number;
  envelopeMode: EnvMode;
  keyonDelay: number;
  gaussianOffset: number;
  outx: number;
  keyOnAt: number;
  keyOnCount: number;
  reset(): void;
}
export declare class DSP {
  private ram;
  readonly regs: Uint8Array<ArrayBuffer>;
  readonly voices: Voice[];
  voiceMask: number;
  echoMask: number;
  sampleCount: number;
  readonly noteOnEvents: number[];
  readonly voiceOut: Int16Array<ArrayBuffer>;
  private counter;
  private noise;
  private konLatch;
  private konPending;
  private echoOffset;
  private echoLength;
  private readonly firL;
  private readonly firR;
  private firIndex;
  constructor(ram: Uint8Array);
  reset(): void;
  read(addr: number): number;
  write(addr: number, value: number): void;
  private counterTick;
  private counterPoll;
  private dirEntry;
  private decodeGroup;
  private gaussianInterpolate;
  private envelopeRun;
  runSample(out: Int32Array): void;
  restoreFromSnapshot(resumeVoices: boolean): number;
  applyKeyOnRecovery(mask: number): void;
  envelopeOf(index: number): number;
  isActive(index: number): boolean;
  pitchOf(index: number): number;
}
