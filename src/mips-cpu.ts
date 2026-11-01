import { FormatError } from './binary.js';

export interface MipsBus {
  read8(address: number): number;
  read16(address: number): number;
  read32(address: number): number;
  write8(address: number, value: number): void;
  write16(address: number, value: number): void;
  write32(address: number, value: number): void;
  intercept?(cpu: MipsCpu): boolean;
  exception?(cpu: MipsCpu, code: number): boolean;
}

export class MipsCpu {
  registers: Int32Array;
  cop0: Int32Array;
  hi: number;
  lo: number;
  loadRegister: number;
  loadValue: number;
  pc = 0;
  nextPC = 4;
  delaySlot = false;
  instructionPC = 0;
  instructionDelay = false;
  constructor(readonly bus: MipsBus) {
    this.registers = new Int32Array(32);
    this.cop0 = new Int32Array(32);
    this.hi = 0;
    this.lo = 0;
    this.loadRegister = 0;
    this.loadValue = 0;
    this.cop0[15] = 2;
    this.resetPC(0);
  }

  resetPC(address: number) {
    this.pc = address >>> 0;
    this.nextPC = (this.pc + 4) >>> 0;
    this.delaySlot = false;
    this.loadRegister = 0;
  }

  branch(condition: boolean, address: number, immediate: number) {
    this.delaySlot = true;
    if (condition) this.nextPC = (address + 4 + immediate * 4) >>> 0;
  }

  queueLoad(register: number, value: number) {
    this.loadRegister = register;
    this.loadValue = value | 0;
  }

  exception(
    code: number,
    address = this.instructionPC,
    delay = this.instructionDelay,
  ) {
    if (this.bus.exception?.(this, code)) return;
    this.cop0[13] =
      (this.cop0[13] & 0x300) | (code << 2) | (delay ? 0x80000000 : 0);
    this.cop0[14] = (address - (delay ? 4 : 0)) | 0;
    this.cop0[12] = (this.cop0[12] & ~63) | ((this.cop0[12] << 2) & 63);
    this.resetPC(this.cop0[12] & 0x400000 ? 0xbfc00180 : 0x80000080);
  }

  interrupt(pending: boolean) {
    this.cop0[13] = (this.cop0[13] & ~0x400) | (pending ? 0x400 : 0);
    if (pending && (this.cop0[12] & 0x401) === 0x401) {
      if (this.loadRegister) this.registers[this.loadRegister] = this.loadValue;
      this.exception(0, this.pc, this.delaySlot);
      return true;
    }
    return false;
  }

  step() {
    const r = this.registers;
    if (this.bus.intercept?.(this)) {
      r[0] = 0;
      return 1;
    }
    const address = this.pc;
    this.instructionPC = address;
    this.instructionDelay = this.delaySlot;
    if (address & 3)
      throw new FormatError('PSF_DRIVER', 'Unaligned instruction address');
    const instruction = this.bus.read32(address) >>> 0;
    const op = instruction >>> 26;
    const rs = (instruction >>> 21) & 31;
    const rt = (instruction >>> 16) & 31;
    const rd = (instruction >>> 11) & 31;
    const shift = (instruction >>> 6) & 31;
    const immediate = (instruction << 16) >> 16;
    const a = r[rs];
    const b = r[rt];
    const merged = this.loadRegister === rt ? this.loadValue : b;
    if (this.loadRegister) r[this.loadRegister] = this.loadValue;
    this.loadRegister = 0;
    this.pc = this.nextPC;
    this.nextPC = (this.nextPC + 4) >>> 0;
    this.delaySlot = false;
    const effective = (a + immediate) >>> 0;
    let cycles = 1;
    switch (op) {
      case 0:
        switch (instruction & 63) {
          case 0:
            r[rd] = b << shift;
            break;
          case 2:
            r[rd] = b >>> shift;
            break;
          case 3:
            r[rd] = b >> shift;
            break;
          case 4:
            r[rd] = b << (a & 31);
            break;
          case 6:
            r[rd] = b >>> (a & 31);
            break;
          case 7:
            r[rd] = b >> (a & 31);
            break;
          case 8:
            this.nextPC = a >>> 0;
            this.delaySlot = true;
            break;
          case 9:
            r[rd] = (address + 8) | 0;
            this.nextPC = a >>> 0;
            this.delaySlot = true;
            break;
          case 12:
            this.exception(8);
            break;
          case 13:
            this.exception(9);
            break;
          case 16:
            r[rd] = this.hi;
            break;
          case 17:
            this.hi = a;
            break;
          case 18:
            r[rd] = this.lo;
            break;
          case 19:
            this.lo = a;
            break;
          case 24:
          case 25: {
            const unsigned = (instruction & 63) === 25;
            const au = a >>> 0,
              bu = b >>> 0;
            const al = au & 65535,
              bl = bu & 65535;
            const middle =
              (au >>> 16) * bl + al * (bu >>> 16) + ((al * bl) >>> 16);
            this.lo = Math.imul(a, b);
            this.hi =
              ((au >>> 16) * (bu >>> 16) + Math.floor(middle / 65536)) | 0;
            if (!unsigned)
              this.hi = (this.hi - (a < 0 ? bu : 0) - (b < 0 ? au : 0)) | 0;
            cycles = 8;
            break;
          }
          case 26:
            this.lo = b === 0 ? (a < 0 ? 1 : -1) : (a / b) | 0;
            this.hi = b === 0 ? a : (a % b) | 0;
            cycles = 36;
            break;
          case 27:
            this.lo = b === 0 ? -1 : ((a >>> 0) / (b >>> 0)) | 0;
            this.hi = b === 0 ? a : ((a >>> 0) % (b >>> 0)) | 0;
            cycles = 36;
            break;
          case 32: {
            const sum = (a + b) | 0;
            if (((a ^ sum) & (b ^ sum)) < 0) this.exception(12);
            else r[rd] = sum;
            break;
          }
          case 33:
            r[rd] = a + b;
            break;
          case 34: {
            const difference = (a - b) | 0;
            if (((a ^ b) & (a ^ difference)) < 0) this.exception(12);
            else r[rd] = difference;
            break;
          }
          case 35:
            r[rd] = a - b;
            break;
          case 36:
            r[rd] = a & b;
            break;
          case 37:
            r[rd] = a | b;
            break;
          case 38:
            r[rd] = a ^ b;
            break;
          case 39:
            r[rd] = ~(a | b);
            break;
          case 42:
            r[rd] = a < b ? 1 : 0;
            break;
          case 43:
            r[rd] = a >>> 0 < b >>> 0 ? 1 : 0;
            break;
          default:
            this.unsupported(instruction, address);
        }
        break;
      case 1:
        if ((rt & 30) !== 0 && (rt & 30) !== 16)
          this.unsupported(instruction, address);
        if (rt & 16) r[31] = (address + 8) | 0;
        this.branch(rt & 1 ? a >= 0 : a < 0, address, immediate);
        break;
      case 2:
        this.nextPC =
          (((address + 4) & 0xf0000000) | ((instruction & 0x3ffffff) << 2)) >>>
          0;
        this.delaySlot = true;
        break;
      case 3:
        r[31] = (address + 8) | 0;
        this.nextPC =
          (((address + 4) & 0xf0000000) | ((instruction & 0x3ffffff) << 2)) >>>
          0;
        this.delaySlot = true;
        break;
      case 4:
        this.branch(a === b, address, immediate);
        break;
      case 5:
        this.branch(a !== b, address, immediate);
        break;
      case 6:
        this.branch(a <= 0, address, immediate);
        break;
      case 7:
        this.branch(a > 0, address, immediate);
        break;
      case 8: {
        const sum = (a + immediate) | 0;
        if (((a ^ sum) & (immediate ^ sum)) < 0) this.exception(12);
        else r[rt] = sum;
        break;
      }
      case 9:
        r[rt] = a + immediate;
        break;
      case 10:
        r[rt] = a < immediate ? 1 : 0;
        break;
      case 11:
        r[rt] = a >>> 0 < immediate >>> 0 ? 1 : 0;
        break;
      case 12:
        r[rt] = a & (instruction & 65535);
        break;
      case 13:
        r[rt] = a | (instruction & 65535);
        break;
      case 14:
        r[rt] = a ^ (instruction & 65535);
        break;
      case 15:
        r[rt] = instruction << 16;
        break;
      case 16:
        if (rs === 0 || rs === 2) this.queueLoad(rt, this.cop0[rd]);
        else if (rs === 4 || rs === 6) this.cop0[rd] = b;
        else if (rs === 16 && (instruction & 63) === 16)
          this.cop0[12] = (this.cop0[12] & ~15) | ((this.cop0[12] >>> 2) & 15);
        else this.unsupported(instruction, address);
        break;
      case 32:
        this.queueLoad(rt, (this.bus.read8(effective) << 24) >> 24);
        cycles = 2;
        break;
      case 33:
        if (effective & 1) {
          this.cop0[8] = effective;
          this.exception(4);
          break;
        }
        this.queueLoad(rt, (this.bus.read16(effective) << 16) >> 16);
        cycles = 2;
        break;
      case 34: {
        const value = this.bus.read32(effective & ~3);
        const amount = (3 - (effective & 3)) * 8;
        this.queueLoad(
          rt,
          (merged & (0xffffff >>> (24 - amount))) | (value << amount),
        );
        cycles = 2;
        break;
      }
      case 35:
        if (effective & 3) {
          this.cop0[8] = effective;
          this.exception(4);
          break;
        }
        this.queueLoad(rt, this.bus.read32(effective));
        cycles = 2;
        break;
      case 36:
        this.queueLoad(rt, this.bus.read8(effective));
        cycles = 2;
        break;
      case 37:
        if (effective & 1) {
          this.cop0[8] = effective;
          this.exception(4);
          break;
        }
        this.queueLoad(rt, this.bus.read16(effective));
        cycles = 2;
        break;
      case 38: {
        const value = this.bus.read32(effective & ~3);
        const amount = (effective & 3) * 8;
        this.queueLoad(
          rt,
          (merged & (0xffffff00 << (24 - amount))) | (value >>> amount),
        );
        cycles = 2;
        break;
      }
      case 40:
        if (!(this.cop0[12] & 0x10000)) this.bus.write8(effective, b);
        cycles = 2;
        break;
      case 41:
        if (effective & 1) {
          this.cop0[8] = effective;
          this.exception(5);
          break;
        }
        if (!(this.cop0[12] & 0x10000)) this.bus.write16(effective, b);
        cycles = 2;
        break;
      case 42: {
        const aligned = effective & ~3;
        const amount = (3 - (effective & 3)) * 8;
        if (!(this.cop0[12] & 0x10000))
          this.bus.write32(
            aligned,
            (this.bus.read32(aligned) & (0xffffff00 << (24 - amount))) |
              (b >>> amount),
          );
        cycles = 2;
        break;
      }
      case 43:
        if (effective & 3) {
          this.cop0[8] = effective;
          this.exception(5);
          break;
        }
        if (!(this.cop0[12] & 0x10000)) this.bus.write32(effective, b);
        cycles = 2;
        break;
      case 46: {
        const aligned = effective & ~3;
        const amount = (effective & 3) * 8;
        if (!(this.cop0[12] & 0x10000))
          this.bus.write32(
            aligned,
            (this.bus.read32(aligned) & (0xffffff >>> (24 - amount))) |
              (b << amount),
          );
        cycles = 2;
        break;
      }
      default:
        this.unsupported(instruction, address);
    }
    r[0] = 0;
    return cycles;
  }

  unsupported(instruction: number, address: number) {
    throw new FormatError(
      'PSF_DRIVER',
      `${instruction.toString(16).padStart(8, '0')} at ${address.toString(16)}`,
    );
  }
}
