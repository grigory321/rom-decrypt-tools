export type InputSource = (dst: Int32Array) => void;
export declare class Resampler {
  private readonly kernel;
  private readonly ringL;
  private readonly ringR;
  private readonly pulled;
  private written;
  private position;
  readonly ratio: number;
  constructor(inputRate: number, outputRate: number);
  reset(): void;
  process(
    outL: Int16Array,
    outR: Int16Array,
    offset: number,
    count: number,
    source: InputSource,
  ): void;
  skip(count: number, source: InputSource): void;
  get inputConsumed(): number;
  saveState(): Float64Array;
  loadState(state: Float64Array): void;
}
