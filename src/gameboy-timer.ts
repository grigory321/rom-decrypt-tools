export class GameBoyTimer {
  divider = 0;
  counter = 0;
  modulo: number;
  control: number;
  reload = 0;
  loaded = 0;
  readonly color: boolean;
  readonly interrupt: () => void;

  constructor(
    modulo: number,
    control: number,
    color: boolean,
    interrupt: () => void,
  ) {
    this.modulo = modulo;
    this.control = control & 7;
    this.color = color;
    this.interrupt = interrupt;
  }

  input() {
    return !!(
      this.control & 4 && this.divider & [512, 8, 32, 128][this.control & 3]
    );
  }

  increment() {
    if (this.reload) return;
    this.counter = (this.counter + 1) & 255;
    if (this.counter === 0) this.reload = 4;
  }

  read(address: number) {
    if (address === 0xff04) return this.divider >> 8;
    if (address === 0xff05) return this.counter;
    if (address === 0xff06) return this.modulo;
    return this.control | 0xf8;
  }

  write(address: number, value: number) {
    value &= 255;
    if (address === 0xff04) {
      const previous = this.input();
      this.divider = 0;
      if (previous) this.increment();
    } else if (address === 0xff05) {
      if (!this.loaded) {
        this.counter = value;
        this.reload = 0;
      }
    } else if (address === 0xff06) {
      this.modulo = value;
      if (this.loaded) this.counter = value;
    } else {
      const previous = this.input();
      this.control = value & 7;
      if (previous && !this.input() && (!this.color || this.control & 4))
        this.increment();
    }
  }

  advance(cycles: number) {
    while (cycles > 0) {
      const period = [1024, 16, 64, 256][this.control & 3];
      const edge =
        this.control & 4 ? period - (this.divider & (period - 1)) : Infinity;
      const count = Math.min(
        cycles,
        edge,
        this.reload || Infinity,
        this.loaded || Infinity,
      );
      this.divider = (this.divider + count) & 65535;
      cycles -= count;
      this.loaded = Math.max(0, this.loaded - count);
      if (this.reload) {
        this.reload -= count;
        if (this.reload === 0) {
          this.counter = this.modulo;
          this.loaded = 4;
          this.interrupt();
        }
      }
      if (count === edge) this.increment();
    }
  }
}
