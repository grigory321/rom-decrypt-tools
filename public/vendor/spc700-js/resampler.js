const TAPS = 32;

const PHASES = 256;

const HALF = TAPS / 2;

function blackman(x) {
  const t = (x + 1) / 2;
  return (
    0.42 - 0.5 * Math.cos(2 * Math.PI * t) + 0.08 * Math.cos(4 * Math.PI * t)
  );
}

function sinc(x) {
  if (x === 0) return 1;
  const px = Math.PI * x;
  return Math.sin(px) / px;
}

function buildKernel(cutoff) {
  const kernel = new Float32Array(PHASES * TAPS);
  for (let p = 0; p < PHASES; p++) {
    const frac = p / PHASES;
    let sum = 0;
    for (let j = 0; j < TAPS; j++) {
      const x = j - HALF + 1 - frac;
      const v = 2 * cutoff * sinc(2 * cutoff * x) * blackman(x / HALF);
      kernel[p * TAPS + j] = v;
      sum += v;
    }
    const scale = 1 / sum;
    for (let j = 0; j < TAPS; j++) kernel[p * TAPS + j] *= scale;
  }
  return kernel;
}

const RING = 64;

const RING_MASK = RING - 1;

export class Resampler {
  kernel;
  ringL = new Float32Array(RING);
  ringR = new Float32Array(RING);
  pulled = new Int32Array(2);
  written = 0;
  position = 0;
  ratio;
  constructor(inputRate, outputRate) {
    this.ratio = inputRate / outputRate;
    const cutoff = 0.5 * Math.min(1, outputRate / inputRate);
    this.kernel = buildKernel(cutoff);
    this.reset();
  }
  reset() {
    this.ringL.fill(0);
    this.ringR.fill(0);
    this.written = HALF - 1;
    this.position = HALF - 1;
  }
  process(outL, outR, offset, count, source) {
    const { kernel: kernel, ringL: ringL, ringR: ringR, pulled: pulled } = this;
    for (let n = 0; n < count; n++) {
      const base = Math.floor(this.position);
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
    if (this.position > 1 << 28) {
      const shift = Math.floor(this.position / RING) * RING;
      this.position -= shift;
      this.written -= shift;
    }
  }
  skip(count, source) {
    const { pulled: pulled } = this;
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
  get inputConsumed() {
    return this.written - (HALF - 1);
  }
  saveState() {
    const out = new Float64Array(2 + RING * 2);
    out[0] = this.written;
    out[1] = this.position;
    out.set(this.ringL, 2);
    out.set(this.ringR, 2 + RING);
    return out;
  }
  loadState(state) {
    this.written = state[0];
    this.position = state[1];
    for (let i = 0; i < RING; i++) {
      this.ringL[i] = state[2 + i];
      this.ringR[i] = state[2 + RING + i];
    }
  }
}
