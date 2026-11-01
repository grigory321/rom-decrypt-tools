import { DSP_SAMPLE_RATE } from './dsp.js';

const UNKNOWN = {
  hz: 0,
  confidence: 0,
  method: 'unknown',
  loopLength: 0,
};

const FFT_SIZE = 8192;

const HPS_HARMONICS = 5;

const MIN_F0_HZ = 20;

const SHORT_LOOP_SAMPLES = 512;

function fft(re, im) {
  const n = re.length;
  for (let i = 1, j = 0; i < n; i++) {
    let bit = n >> 1;
    for (; j & bit; bit >>= 1) j ^= bit;
    j ^= bit;
    if (i < j) {
      const tr = re[i];
      re[i] = re[j];
      re[j] = tr;
      const ti = im[i];
      im[i] = im[j];
      im[j] = ti;
    }
  }
  for (let len = 2; len <= n; len <<= 1) {
    const ang = (-2 * Math.PI) / len;
    const half = len >> 1;
    for (let i = 0; i < n; i += len) {
      for (let k = 0; k < half; k++) {
        const wr = Math.cos(ang * k);
        const wi = Math.sin(ang * k);
        const ur = re[i + k];
        const ui = im[i + k];
        const vr = re[i + k + half] * wr - im[i + k + half] * wi;
        const vi = re[i + k + half] * wi + im[i + k + half] * wr;
        re[i + k] = ur + vr;
        im[i + k] = ui + vi;
        re[i + k + half] = ur - vr;
        im[i + k + half] = ui - vi;
      }
    }
  }
}

function spectralF0(samples, offset = 0) {
  const re = new Float64Array(FFT_SIZE);
  const im = new Float64Array(FFT_SIZE);
  const n = Math.min(samples.length - offset, FFT_SIZE);
  if (n < 64)
    return {
      hz: 0,
      confidence: 0,
    };
  for (let i = 0; i < n; i++) {
    const w = 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / n);
    re[i] = samples[offset + i] * w;
  }
  fft(re, im);
  const half = FFT_SIZE >> 1;
  const mag = new Float64Array(half);
  for (let i = 0; i < half; i++) mag[i] = Math.hypot(re[i], im[i]);
  const maxBin = Math.floor(half / HPS_HARMONICS);
  const minBin = Math.max(
    2,
    Math.ceil((MIN_F0_HZ * FFT_SIZE) / DSP_SAMPLE_RATE),
  );
  let bestBin = 0;
  let bestVal = 0;
  let total = 0;
  for (let b = minBin; b < maxBin; b++) {
    let p = 1;
    for (let h = 1; h <= HPS_HARMONICS; h++) p *= mag[b * h];
    total += p;
    if (p > bestVal) {
      bestVal = p;
      bestBin = b;
    }
  }
  if (bestBin <= 0 || total <= 0)
    return {
      hz: 0,
      confidence: 0,
    };
  const y0 = mag[bestBin - 1];
  const y1 = mag[bestBin];
  const y2 = mag[bestBin + 1];
  const denom = y0 - 2 * y1 + y2;
  const delta = denom !== 0 ? (0.5 * (y0 - y2)) / denom : 0;
  return {
    hz:
      ((bestBin + Math.max(-1, Math.min(1, delta))) * DSP_SAMPLE_RATE) /
      FFT_SIZE,
    confidence: bestVal / total,
  };
}

function autocorrelation(samples, lag) {
  const n = samples.length - lag;
  if (n <= 0) return 0;
  let dot = 0;
  let e1 = 0;
  let e2 = 0;
  for (let i = 0; i < n; i++) {
    dot += samples[i] * samples[i + lag];
    e1 += samples[i] * samples[i];
    e2 += samples[i + lag] * samples[i + lag];
  }
  return dot / Math.sqrt(e1 * e2 || 1);
}

function decodeChain(ram, startAddr, maxBlocks) {
  const samples = [];
  const blocks = [];
  let addr = startAddr & 65535;
  for (let b = 0; b < maxBlocks; b++) {
    blocks.push(addr);
    const header = ram[addr];
    const shift = header >> 4;
    const filter = (header >> 2) & 3;
    for (let k = 0; k < 8; k++) {
      const byte = ram[(addr + 1 + k) & 65535];
      for (let half = 0; half < 2; half++) {
        const nibble = half === 0 ? byte >> 4 : byte & 15;
        let s = (nibble << 28) >> 28;
        s = shift <= 12 ? (s << shift) >> 1 : (s >> 3) << 11;
        const p1 = samples.length >= 1 ? samples[samples.length - 1] : 0;
        const p2 = samples.length >= 2 ? samples[samples.length - 2] >> 1 : 0;
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
        const c = s < -32768 ? -32768 : s > 32767 ? 32767 : s;
        samples.push(((c * 2) << 16) >> 16);
      }
    }
    addr = (addr + 9) & 65535;
    if (header & 1)
      return {
        samples: samples,
        blocks: blocks,
        loops: (header & 2) !== 0,
      };
  }
  return {
    samples: samples,
    blocks: blocks,
    loops: false,
  };
}

export function analyzeSample(ram, dirPage, srcn) {
  const base = ((dirPage << 8) + srcn * 4) & 65535;
  const start = ram[base] | (ram[(base + 1) & 65535] << 8);
  const loop = ram[(base + 2) & 65535] | (ram[(base + 3) & 65535] << 8);
  const chain = decodeChain(ram, start, 4096);
  if (chain.samples.length === 0) return UNKNOWN;
  if (!chain.loops) {
    const skip = Math.min(Math.floor(chain.samples.length * 0.15), 320);
    const { hz: hz, confidence: confidence } = spectralF0(chain.samples, skip);
    return {
      hz: hz,
      confidence: confidence,
      method: 'one-shot',
      loopLength: 0,
    };
  }
  const loopIndex = chain.blocks.indexOf(loop & 65535);
  if (loopIndex < 0) {
    const { hz: hz, confidence: confidence } = spectralF0(chain.samples);
    return {
      hz: hz,
      confidence: confidence,
      method: 'spectrum',
      loopLength: 0,
    };
  }
  const loopLength = (chain.blocks.length - loopIndex) * 16;
  const body = chain.samples.slice(loopIndex * 16);
  const reps = Math.max(2, Math.ceil((FFT_SIZE * 2) / Math.max(1, loopLength)));
  const tiled = [];
  for (let r = 0; r < reps; r++)
    for (let i = 0; i < body.length; i++) tiled.push(body[i]);
  const region = tiled.slice(loopLength);
  if (loopLength <= SHORT_LOOP_SAMPLES) {
    for (let cycles = 1; cycles <= 8; cycles++) {
      if (loopLength % cycles !== 0) continue;
      const period = loopLength / cycles;
      if (period < 8) break;
      const r = autocorrelation(region, period);
      if (r > 0.9) {
        return {
          hz: DSP_SAMPLE_RATE / period,
          confidence: r,
          method: 'loop',
          loopLength: loopLength,
        };
      }
    }
  }
  const { hz: hz, confidence: confidence } = spectralF0(region);
  return {
    hz: hz,
    confidence: confidence,
    method: 'spectrum',
    loopLength: loopLength,
  };
}
