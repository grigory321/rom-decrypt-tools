export type BasePitchMethod = 'loop' | 'spectrum' | 'one-shot' | 'unknown';
export interface BasePitch {
  hz: number;
  confidence: number;
  method: BasePitchMethod;
  loopLength: number;
}
export declare function analyzeSample(
  ram: Uint8Array,
  dirPage: number,
  srcn: number,
): BasePitch;
