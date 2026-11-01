/**
 * S-DSP 4-tap interpolation table (512 entries, 12-bit unsigned).
 *
 * On real hardware this lives in an internal ROM inside the S-DSP, and it is
 * usually shipped as a blob of 512 published constants. It does not have to be:
 * Near reconstructed the kernel Sony evaluated, and the code below regenerates
 * all 512 entries exactly -- test/gauss.mjs asserts that against the values
 * documented in nocash's fullsnes specs and on the SnesLab S-DSP wiki.
 *
 * Despite the universal name, the curve is not a gaussian. `sin(...)/k` is a
 * sinc; `t + u + 1` is the window over it. It is a 4-tap windowed sinc, and the
 * person who first dumped the table said as much years later.
 *
 * The table is laid out as a single window w(x) sampled over x = 2 -> 0, so
 * that the four taps for a fractional phase p (0..255) are
 *
 *     gauss[255 - p]  gauss[511 - p]  gauss[256 + p]  gauss[p]
 *
 * covering x = 1+t, t, 1-t, 2-t with t = p/256.
 *
 * Adapted from ares (ares/sfc/dsp/gaussian.cpp), Copyright (c) 2004-2025 ares
 * team, Near et al, used under the ISC license:
 *
 *   Permission to use, copy, modify, and/or distribute this software for any
 *   purpose with or without fee is hereby granted, provided that the above
 *   copyright notice and this permission notice appear in all copies.
 *
 *   THE SOFTWARE IS PROVIDED "AS IS" AND THE AUTHOR DISCLAIMS ALL WARRANTIES
 *   WITH REGARD TO THIS SOFTWARE INCLUDING ALL IMPLIED WARRANTIES OF
 *   MERCHANTABILITY AND FITNESS. IN NO EVENT SHALL THE AUTHOR BE LIABLE FOR
 *   ANY SPECIAL, DIRECT, INDIRECT, OR CONSEQUENTIAL DAMAGES OR ANY DAMAGES
 *   WHATSOEVER RESULTING FROM LOSS OF USE, DATA OR PROFITS, WHETHER IN AN
 *   ACTION OF CONTRACT, NEGLIGENCE OR OTHER TORTIOUS ACTION, ARISING OUT OF
 *   OR IN CONNECTION WITH THE USE OR PERFORMANCE OF THIS SOFTWARE.
 */
function constructTable(): Int16Array {
  const table = new Float64Array(512);
  for (let n = 0; n < 512; n++) {
    const k = 0.5 + n;
    const s = Math.sin((Math.PI * k * 1.28) / 1024);
    const t = (Math.cos((Math.PI * k * 2.0) / 1023) - 1) * 0.5;
    const u = (Math.cos((Math.PI * k * 4.0) / 1023) - 1) * 0.08;
    table[511 - n] = (s * (t + u + 1.0)) / k;
  }

  // Each phase group is scaled so its four taps sum to exactly 2048 *before*
  // rounding; rounding them independently afterwards is what leaves the real
  // table summing to 0x7ff..0x801 instead. That off-by-one interpolation gain
  // is a rounding artefact rather than a design, but it is the hardware's, and
  // the 0x801 phases are what let a run of minimum-amplitude BRR samples
  // overflow the interpolator's 16-bit accumulator -- which Dsp's
  // gaussianInterpolate reproduces deliberately. Do not "fix" it.
  //
  // Values are always positive here, so + 0.5 is a correct round-to-nearest.
  // The tightest entry lands 3.2e-5 from a rounding boundary, some seven orders
  // of magnitude clear of any plausible Math.sin/cos discrepancy between JS
  // engines, so this is bit-identical everywhere.
  const out = new Int16Array(512);
  for (let phase = 0; phase < 128; phase++) {
    const idx = [phase, phase + 256, 511 - phase, 255 - phase];
    let sum = 0;
    for (const i of idx) sum += table[i];
    const scale = 2048.0 / sum;
    for (const i of idx) out[i] = Math.floor(table[i] * scale + 0.5);
  }
  return out;
}

export let GAUSS_TABLE: Int16Array = constructTable();

/**
 * Replace the built-in table. Playback is hardware-accurate as shipped, so this
 * exists only for experiments -- installing a different interpolation window,
 * or the variant table from Sony's PS1 SPU. Must be 512 entries in the layout
 * described above.
 */
export function setGaussianTable(table: ArrayLike<number>): void {
  if (table.length !== 512) {
    throw new Error(`gaussian table must have 512 entries, got ${table.length}`);
  }
  GAUSS_TABLE = Int16Array.from(table);
}

