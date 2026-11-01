import { SPCAPU, type APUState } from './apu.js';
import { EnvMode } from './dsp.js';
import { type SPCFile, type SPCTags } from './spc-file.js';
export interface SPCPlayerOptions {
  sampleRate?: number;
  resumeVoices?: boolean;
  retriggerKeyOn?: boolean;
  clearEchoBuffer?: boolean;
  loopCount?: number;
  defaultPlaySeconds?: number;
  defaultFadeSeconds?: number;
}
export interface VoiceStatus {
  index: number;
  active: boolean;
  envelope: number;
  volumeLeft: number;
  volumeRight: number;
  pitch: number;
  note: number | null;
  semitone: number | null;
  tuningConfidence: number;
  source: number;
  noise: boolean;
  echo: boolean;
  pitchModulated: boolean;
  envelopeMode: EnvMode;
  keyOnAt: number;
  keyOnCount: number;
}
export interface SPCPlayerState {
  apu: APUState;
  outputSample: number;
  dspSample: number;
  resampler: Float64Array | null;
}
export declare class SPCPlayer {
  readonly apu: SPCAPU;
  readonly sampleRate: number;
  private resampler;
  private file;
  private options;
  private outputSample;
  private dspSample;
  private readonly frame;
  private readonly source;
  voiceCaptureEnabled: boolean;
  private voiceCaptureBuffer;
  private voiceCaptureCount;
  get voiceCapture(): Int16Array;
  get voiceCaptureLength(): number;
  private appendVoiceCapture;
  private tuning;
  private drainNoteOns;
  constructor(options?: SPCPlayerOptions);
  get tags(): SPCTags;
  get playSeconds(): number;
  get fadeSeconds(): number;
  get totalSeconds(): number;
  get currentTime(): number;
  load(input: Uint8Array | ArrayBuffer | SPCFile): void;
  private clearEchoRegion;
  renderInto(
    left: Int16Array,
    right: Int16Array,
    offset: number,
    count: number,
  ): number;
  render(count: number): {
    left: Int16Array;
    right: Int16Array;
  };
  skip(count: number): void;
  private applyFade;
  saveState(): SPCPlayerState;
  restoreState(state: SPCPlayerState): void;
  setVoiceMask(mask: number): void;
  getVoiceMask(): number;
  getVoiceStatus(index: number): VoiceStatus;
  getVoiceStatusArray(): VoiceStatus[];
  get dspSampleCount(): number;
}
