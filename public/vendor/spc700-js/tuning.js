import { analyzeSample } from './brr-analyzer.js';

const MIN_OBSERVATIONS = 8;

const MAX_OBSERVATIONS = 64;

const A4_HZ = 440;

const A4_MIDI = 69;

const PITCH_ONE = 4096;

export class Tuning {
  ram;
  dirPage;
  base = new Map();
  deviations = new Map();
  correction = new Map();
  constructor(ram, dirPage) {
    this.ram = ram;
    this.dirPage = dirPage;
  }
  setDirectoryPage(page) {
    if (page === this.dirPage) return;
    this.dirPage = page;
    this.base.clear();
    this.deviations.clear();
    this.correction.clear();
  }
  baseOf(srcn) {
    let b = this.base.get(srcn);
    if (b == null) {
      b = analyzeSample(this.ram, this.dirPage, srcn);
      this.base.set(srcn, b);
    }
    return b;
  }
  noteOf(srcn, pitch) {
    if (pitch <= 0) return null;
    const b = this.baseOf(srcn);
    if (b.hz <= 0) return null;
    const hz = b.hz * (pitch / PITCH_ONE);
    const midi = A4_MIDI + 12 * Math.log2(hz / A4_HZ);
    return midi - (this.correction.get(srcn) ?? 0);
  }
  observe(srcn, pitch) {
    if (pitch <= 0) return;
    const b = this.baseOf(srcn);
    if (b.hz <= 0) return;
    let list = this.deviations.get(srcn);
    if (list == null) {
      list = [];
      this.deviations.set(srcn, list);
    }
    if (list.length >= MAX_OBSERVATIONS) return;
    const hz = b.hz * (pitch / PITCH_ONE);
    const midi = A4_MIDI + 12 * Math.log2(hz / A4_HZ);
    list.push(midi - Math.round(midi));
    if (list.length >= MIN_OBSERVATIONS) {
      const sorted = [...list].sort((x, y) => x - y);
      this.correction.set(srcn, sorted[sorted.length >> 1]);
    }
  }
  isRefined(srcn) {
    return this.correction.has(srcn);
  }
}
