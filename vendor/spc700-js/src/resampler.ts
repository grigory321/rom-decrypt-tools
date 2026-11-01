/**
 * Streaming polyphase windowed-sinc resampler.
 *
 * The S-DSP only ever produces 32000 Hz, so anything that wants to feed a
 * WebAudio graph has to resample. Linear interpolation is cheap but leaves
 * audible imaging around 11-16 kHz at 32k -> 44.1k, which is exactly the range
 * SNES percussion lives in, so this uses a proper bandlimited kernel instead.
 *
 * Input is *pulled*, one sample at a time, exactly when the filter window needs
 * it. That keeps the history ring down to the kernel width no matter how large
 * a block the caller asks for.
 */

const TAPS = 32;
const PHASES = 256;
const HALF = TAPS / 2;

function blackman(x: number): number {
  // x in [-1, 1]
  const t = (x + 1) / 2;
  return 0.42 - 0.5 * Math.cos(2 * Math.PI * t) + 0.08 * Math.cos(4 * Math.PI * t);
}

function sinc(x: number): number {
  if (x === 0) return 1;
  const px = Math.PI * x;
  return Math.sin(px) / px;
}

function buildKernel(cutoff: number): Float32Array {
  const kernel = new Float32Array(PHASES * TAPS);
  for (let p = 0; p < PHASES; p++) {
    const frac = p / PHASES;
    let sum = 0;
    for (let j = 0; j < TAPS; j++) {
      // Tap j covers input offset (j - HALF + 1) relative to floor(position).
      const x = j - HALF + 1 - frac;
      const v = 2 * cutoff * sinc(2 * cutoff * x) * blackman(x / HALF);
      kernel[p * TAPS + j] = v;
      sum += v;
    }
    // Normalise each phase so the filter has exactly unity DC gain; without
    // this the truncated kernel produces a slow amplitude ripple.
    const scale = 1 / sum;
    for (let j = 0; j < TAPS; j++) kernel[p * TAPS + j] *= scale;
  }
  return kernel;
}

const RING = 64; // power of two, must exceed TAPS
const RING_MASK = RING - 1;

/** Fills `dst[0]`/`dst[1]` with the next stereo input sample. */
export type InputSource = (dst: Int32Array) => void;

export class Resampler {
  private readonly kernel: Float32Array;
  private readonly ringL = new Float32Array(RING);
  private readonly ringR = new Float32Array(RING);
  private readonly pulled = new Int32Array(2);
  /** Absolute count of input samples pushed so far. */
  private written = 0;
  /** Absolute input position (in samples) of the next output sample. */
  private position = 0;
  /** Input samples consumed per output sample. */
  readonly ratio: number;

  constructor(inputRate: number, outputRate: number) {
    this.ratio = inputRate / outputRate;
    // When downsampling, pull the cutoff down to the output Nyquist.
    const cutoff = 0.5 * Math.min(1, outputRate / inputRate);
    this.kernel = buildKernel(cutoff);
    this.reset();
  }

  reset(): void {
    this.ringL.fill(0);
    this.ringR.fill(0);
    // Start with the left wing of the kernel sitting on primed zeroes.
    this.written = HALF - 1;
    this.position = HALF - 1;
  }

  /**
   * Emit `count` output samples, pulling input from `source` as the filter
   * window advances into it.
   */
  process(
    outL: Int16Array,
    outR: Int16Array,
    offset: number,
    count: number,
    source: InputSource
  ): void {
    const { kernel, ringL, ringR, pulled } = this;

    for (let n = 0; n < count; n++) {
      const base = Math.floor(this.position);
      // The rightmost tap this output sample reads.
      const highest = base + HALF;
      while (this.written <= highest) {
        source(pulled);
        const i = this.written & RING_MASK;
        ringL[i] = pulled[0];
        ringR[i] = pulled[1];
        this.written++;
      }

      const phase = ((this.position - base) * PHASES) | 0;
      const k = phase * TAPS;
      const start = base - HALF + 1;
      let l = 0;
      let r = 0;
      for (let j = 0; j < TAPS; j++) {
        const idx = (start + j) & RING_MASK;
        const c = kernel[k + j];
        l += ringL[idx] * c;
        r += ringR[idx] * c;
      }
      outL[offset + n] = l < -32768 ? -32768 : l > 32767 ? 32767 : l | 0;
      outR[offset + n] = r < -32768 ? -32768 : r > 32767 ? 32767 : r | 0;
      this.position += this.ratio;
    }

    // Keep the absolute counters from drifting into precision loss on long
    // playback. Rebasing by a whole number of ring periods preserves the
    // mapping from absolute index to ring slot.
    if (this.position > 1 << 28) {
      const shift = Math.floor(this.position / RING) * RING;
      this.position -= shift;
      this.written -= shift;
    }
  }

  /** Advance `count` output samples without producing output. */
  skip(count: number, source: InputSource): void {
    const { pulled } = this;
    for (let n = 0; n < count; n++) {
      const highest = Math.floor(this.position) + HALF;
      while (this.written <= highest) {
        source(pulled);
        const i = this.written & RING_MASK;
        this.ringL[i] = pulled[0];
        this.ringR[i] = pulled[1];
        this.written++;
      }
      this.position += this.ratio;
    }
    if (this.position > 1 << 28) {
      const shift = Math.floor(this.position / RING) * RING;
      this.position -= shift;
      this.written -= shift;
    }
  }

  /** Input samples pulled so far, net of the priming offset. */
  get inputConsumed(): number {
    return this.written - (HALF - 1);
  }

  /**
   * Capture the filter's history and fractional phase.
   *
   * Without this a restored snapshot would resume on a fresh filter, and the
   * sub-sample phase would no longer line up with continuous playback — audibly
   * harmless, but it costs the exact reproducibility that makes SPC seeking
   * worth having.
   */
  saveState(): Float64Array {
    const out = new Float64Array(2 + RING * 2);
    out[0] = this.written;
    out[1] = this.position;
    out.set(this.ringL, 2);
    out.set(this.ringR, 2 + RING);
    return out;
  }

  loadState(state: Float64Array): void {
    this.written = state[0];
    this.position = state[1];
    for (let i = 0; i < RING; i++) {
      this.ringL[i] = state[2 + i];
      this.ringR[i] = state[2 + RING + i];
    }
  }
}

