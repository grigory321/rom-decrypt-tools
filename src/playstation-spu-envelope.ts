export interface SpuEnvelope {
  rate: number;
  decreasing: boolean;
  exponential: boolean;
  invert: boolean;
  step: number;
  increment: number;
  counter: number;
  stepped: boolean;
  reset(
    rate: number,
    mask: number,
    decreasing: boolean,
    exponential: boolean,
    invert?: boolean,
  ): void;
  tick(level: number): number;
}

export function createSpuEnvelope(): SpuEnvelope {
  const e: SpuEnvelope = {
    rate: 0,
    decreasing: false,
    exponential: false,
    invert: false,
    step: 0,
    increment: 0,
    counter: 0,
    stepped: false,
    reset(rate, mask, decreasing, exponential, invert = false) {
      e.rate = rate;
      e.decreasing = decreasing;
      e.exponential = exponential;
      e.invert = invert;
      e.counter = 0;
      e.increment = 0x8000;
      const base = 7 - (rate & 3);
      e.step = decreasing !== invert || (invert && exponential) ? ~base : base;
      if (rate < 44) {
        e.step <<= 11 - (rate >> 2);
      } else if (rate >= 48) {
        e.increment >>= (rate >> 2) - 11;
        if ((rate & mask) !== mask) e.increment = Math.max(e.increment, 1);
      }
    },

    tick(level) {
      let increment = e.increment;
      let step = e.step;
      if (e.exponential) {
        if (e.decreasing) {
          step = (step * level) >> 15;
        } else if (level >= 0x6000) {
          if (e.rate < 40) {
            step >>= 2;
          } else if (e.rate >= 44) {
            increment >>= 2;
          } else {
            step >>= 1;
            increment >>= 1;
          }
        }
      }
      e.counter += increment;
      e.stepped = (e.counter & 0x8000) !== 0;
      if (!e.stepped) return level;
      e.counter = 0;
      const next = level + step;
      if (!e.decreasing) return Math.max(-0x8000, Math.min(0x7fff, next));
      if (e.invert) return Math.max(-0x7fff, Math.min(0, next));
      return Math.max(0, next);
    },
  };
  return e;
}
