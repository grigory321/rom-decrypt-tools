import { check } from './binary.js';

export class GameBoyCpu {
  readonly read: (address: number) => number;
  readonly write: (address: number, value: number) => void;
  readonly interruptRead: (address: number) => number;
  readonly interruptWrite: (address: number, value: number) => void;
  readonly r: Uint8Array;
  f = 0;
  pc = 0;
  sp = 0xfffe;
  halted = false;
  readonly interrupts: boolean;
  ime = false;
  imeDelay = 0;
  haltBug = false;
  interruptReturned = false;
  constructor(
    read: (address: number) => number,
    write: (address: number, value: number) => void,
    interrupts = false,
    options: {
      interruptRead?: (address: number) => number;
      interruptWrite?: (address: number, value: number) => void;
    } = {},
  ) {
    this.read = read;
    this.write = write;
    this.interruptRead = options.interruptRead ?? read;
    this.interruptWrite = options.interruptWrite ?? write;
    this.r = new Uint8Array(8);
    this.f = 0;
    this.pc = 0;
    this.sp = 0xfffe;
    this.halted = false;
    this.interrupts = interrupts;
  }

  pair(index: number) {
    if (index === 3) return this.sp;
    return (this.r[index * 2] << 8) | this.r[index * 2 + 1];
  }

  setPair(index: number, value: number) {
    if (index === 3) this.sp = value & 65535;
    else {
      this.r[index * 2] = value >> 8;
      this.r[index * 2 + 1] = value;
    }
  }

  get(index: number) {
    return index === 6 ? this.read(this.pair(2)) : this.r[index];
  }

  set(index: number, value: number) {
    if (index === 6) this.write(this.pair(2), value & 255);
    else this.r[index] = value;
  }

  byte() {
    const value = this.read(this.pc);
    if (this.haltBug) this.haltBug = false;
    else this.pc = (this.pc + 1) & 65535;
    return value;
  }

  word() {
    const low = this.byte();
    return low | (this.byte() << 8);
  }

  push(value: number) {
    this.sp = (this.sp - 1) & 65535;
    this.write(this.sp, value >> 8);
    this.sp = (this.sp - 1) & 65535;
    this.write(this.sp, value & 255);
  }

  pop() {
    const low = this.read(this.sp);
    this.sp = (this.sp + 1) & 65535;
    const high = this.read(this.sp);
    this.sp = (this.sp + 1) & 65535;
    return low | (high << 8);
  }

  condition(index: number) {
    return index < 2
      ? !!(this.f & 128) === !!(index & 1)
      : !!(this.f & 16) === !!(index & 1);
  }

  arithmetic(operation: number, value: number) {
    const a = this.r[7];
    const carry = operation === 1 || operation === 3 ? (this.f >> 4) & 1 : 0;
    let result: number;
    if (operation < 2) {
      result = a + value + carry;
      this.f =
        (Number((a & 15) + (value & 15) + carry > 15) << 5) |
        (Number(result > 255) << 4);
    } else if (operation < 4 || operation === 7) {
      result = a - value - carry;
      this.f =
        64 |
        (Number((a & 15) < (value & 15) + carry) << 5) |
        (Number(result < 0) << 4);
    } else {
      result =
        operation === 4 ? a & value : operation === 5 ? a ^ value : a | value;
      this.f = operation === 4 ? 32 : 0;
    }
    if ((result & 255) === 0) this.f |= 128;
    if (operation !== 7) this.r[7] = result;
  }

  rotate(operation: number, value: number) {
    let carry = 0;
    let result = value;
    if (operation === 0 || operation === 2 || operation === 4) {
      carry = value >> 7;
      result =
        (value << 1) |
        (operation === 0 ? carry : operation === 2 ? (this.f >> 4) & 1 : 0);
    } else if ([1, 3, 5, 7].includes(operation)) {
      carry = value & 1;
      result =
        (value >> 1) |
        (operation === 1
          ? carry << 7
          : operation === 3
            ? (this.f & 16) << 3
            : operation === 5
              ? value & 128
              : 0);
    } else result = (value << 4) | (value >> 4);
    result &= 255;
    this.f = (result === 0 ? 128 : 0) | (carry << 4);
    return result;
  }

  step() {
    this.interruptReturned = false;
    if (this.interrupts) {
      if (this.imeDelay > 0 && --this.imeDelay === 0) this.ime = true;
      const pending =
        this.interruptRead(0xffff) & this.interruptRead(0xff0f) & 31;
      if (pending) {
        this.halted = false;
        if (this.ime) {
          const index = 31 - Math.clz32(pending & -pending);
          this.ime = false;
          this.imeDelay = 0;
          if (this.haltBug) this.pc = (this.pc - 1) & 65535;
          this.haltBug = false;
          this.interruptWrite(
            0xff0f,
            this.interruptRead(0xff0f) & ~(1 << index),
          );
          this.push(this.pc);
          this.pc = 0x40 + index * 8;
          return 20;
        }
      }
    }
    if (this.halted) return 4;
    const opcode = this.byte();
    const x = opcode >> 6;
    const y = (opcode >> 3) & 7;
    const z = opcode & 7;
    const p = y >> 1;
    const q = y & 1;
    if (x === 1) {
      if (opcode === 0x76) {
        if (
          this.interrupts &&
          !this.ime &&
          this.interruptRead(0xffff) & this.interruptRead(0xff0f) & 31
        )
          this.haltBug = true;
        else this.halted = true;
        return 4;
      } else this.set(y, this.get(z));
      return y === 6 || z === 6 ? 8 : 4;
    }
    if (x === 2) {
      this.arithmetic(y, this.get(z));
      return z === 6 ? 8 : 4;
    }
    if (x === 0) {
      if (z === 0) {
        if (y === 0) return 4;
        if (y === 1) {
          const address = this.word();
          this.write(address, this.sp & 255);
          this.write((address + 1) & 65535, this.sp >> 8);
          return 20;
        }
        if (y === 2) {
          this.byte();
          this.halted = true;
          return 4;
        }
        const delta = (this.byte() << 24) >> 24;
        if (y === 3 || this.condition(y - 4)) {
          this.pc = (this.pc + delta) & 65535;
          return 12;
        }
        return 8;
      }
      if (z === 1) {
        if (!q) this.setPair(p, this.word());
        else {
          const left = this.pair(2);
          const right = this.pair(p);
          const result = left + right;
          this.f =
            (this.f & 128) |
            (Number((left & 4095) + (right & 4095) > 4095) << 5) |
            (Number(result > 65535) << 4);
          this.setPair(2, result);
        }
        return q ? 8 : 12;
      }
      if (z === 2) {
        const address = this.pair(Math.min(p, 2));
        if (q) this.r[7] = this.read(address);
        else this.write(address, this.r[7]);
        if (p >= 2) this.setPair(2, address + (p === 2 ? 1 : -1));
        return 8;
      }
      if (z === 3) {
        this.setPair(p, this.pair(p) + (q ? -1 : 1));
        return 8;
      }
      if (z === 4 || z === 5) {
        const value = this.get(y);
        const result = (value + (z === 4 ? 1 : -1)) & 255;
        this.f =
          (this.f & 16) |
          (result === 0 ? 128 : 0) |
          (z === 5 ? 64 : 0) |
          ((z === 4 ? (value & 15) === 15 : (value & 15) === 0) ? 32 : 0);
        this.set(y, result);
        return y === 6 ? 12 : 4;
      }
      if (z === 6) {
        this.set(y, this.byte());
        return y === 6 ? 12 : 8;
      }
      if (y < 4) {
        this.r[7] = this.rotate(y, this.r[7]);
        this.f &= 16;
      } else if (y === 4) {
        let correction = 0;
        let carry = this.f & 16;
        if (this.f & 32 || (!(this.f & 64) && (this.r[7] & 15) > 9))
          correction |= 6;
        if (carry || (!(this.f & 64) && this.r[7] > 0x99)) {
          correction |= 0x60;
          carry = 16;
        }
        this.r[7] += this.f & 64 ? -correction : correction;
        this.f = (this.f & 64) | carry | (this.r[7] === 0 ? 128 : 0);
      } else if (y === 5) {
        this.r[7] ^= 255;
        this.f |= 96;
      } else this.f = (this.f & 128) | (y === 6 ? 16 : (this.f ^ 16) & 16);
      return 4;
    }
    if (z === 0) {
      if (y < 4) {
        if (!this.condition(y)) return 8;
        this.pc = this.pop();
        return 20;
      }
      const value = this.byte();
      if (y === 4) this.write(0xff00 | value, this.r[7]);
      else if (y === 6) this.r[7] = this.read(0xff00 | value);
      else {
        const delta = (value << 24) >> 24;
        const result = (this.sp + delta) & 65535;
        this.f =
          (Number((this.sp & 15) + (value & 15) > 15) << 5) |
          (Number((this.sp & 255) + value > 255) << 4);
        if (y === 5) this.sp = result;
        else this.setPair(2, result);
      }
      return y === 5 ? 16 : 12;
    }
    if (z === 1) {
      if (!q) {
        const value = this.pop();
        if (p === 3) {
          this.r[7] = value >> 8;
          this.f = value & 0xf0;
        } else this.setPair(p, value);
        return 12;
      }
      if (p < 2) {
        this.pc = this.pop();
        if (p === 1) {
          this.ime = true;
          this.imeDelay = 0;
          this.interruptReturned = true;
        }
        return 16;
      }
      if (p === 2) this.pc = this.pair(2);
      else this.sp = this.pair(2);
      return p === 2 ? 4 : 8;
    }
    if (z === 2) {
      if (y < 4) {
        const address = this.word();
        if (!this.condition(y)) return 12;
        this.pc = address;
        return 16;
      }
      const address = y & 1 ? this.word() : 0xff00 | this.r[1];
      if (y < 6) this.write(address, this.r[7]);
      else this.r[7] = this.read(address);
      return y & 1 ? 16 : 8;
    }
    if (z === 3) {
      if (y === 0) {
        this.pc = this.word();
        return 16;
      }
      if (y === 1) {
        const code = this.byte();
        const register = code & 7;
        const group = code >> 6;
        const bit = (code >> 3) & 7;
        const value = this.get(register);
        if (group === 0) this.set(register, this.rotate(bit, value));
        else if (group === 1)
          this.f = (this.f & 16) | 32 | (!(value & (1 << bit)) ? 128 : 0);
        else
          this.set(
            register,
            group === 2 ? value & ~(1 << bit) : value | (1 << bit),
          );
        return register === 6 ? (group === 1 ? 12 : 16) : 8;
      }
      check(y >= 6, 'GBS_DRIVER', 'Opcode ' + opcode.toString(16));
      if (y === 6) {
        this.ime = false;
        this.imeDelay = 0;
      } else if (!this.imeDelay) this.imeDelay = 2;
      return 4;
    }
    if (z === 4) {
      check(y < 4, 'GBS_DRIVER');
      const address = this.word();
      if (!this.condition(y)) return 12;
      this.push(this.pc);
      this.pc = address;
      return 24;
    }
    if (z === 5) {
      if (!q) {
        this.push(p === 3 ? (this.r[7] << 8) | this.f : this.pair(p));
        return 16;
      }
      check(p === 0, 'GBS_DRIVER');
      const address = this.word();
      this.push(this.pc);
      this.pc = address;
      return 24;
    }
    if (z === 6) {
      this.arithmetic(y, this.byte());
      return 8;
    }
    this.push(this.pc);
    this.pc = y * 8;
    return 16;
  }
}
