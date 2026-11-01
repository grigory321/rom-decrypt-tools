/**
 * Sony SPC700 CPU core.
 *
 * Instruction-level (not sub-cycle) accurate: every opcode consumes its full
 * documented cycle count at once, and the bus sees reads/writes in program
 * order. That is enough for .spc playback, where the driver's tempo comes from
 * the SPC700 timers rather than from bus timing against the S-CPU (which is
 * absent from a dump in the first place).
 */

export interface SPCBus {
  read(addr: number): number;
  write(addr: number, value: number): void;
}

/** Base cycle count per opcode. Taken branches add 2 (see BRANCH_PENALTY). */
// prettier-ignore
const CYCLES = new Uint8Array([
  2, 8, 4, 5, 3, 4, 3, 6, 2, 6, 5, 4, 5, 4, 6, 8,
  2, 8, 4, 5, 4, 5, 5, 6, 5, 5, 6, 5, 2, 2, 4, 6,
  2, 8, 4, 5, 3, 4, 3, 6, 2, 6, 5, 4, 5, 4, 5, 4,
  2, 8, 4, 5, 4, 5, 5, 6, 5, 5, 6, 5, 2, 2, 3, 8,
  2, 8, 4, 5, 3, 4, 3, 6, 2, 6, 4, 4, 5, 4, 6, 6,
  2, 8, 4, 5, 4, 5, 5, 6, 5, 5, 4, 5, 2, 2, 4, 3,
  2, 8, 4, 5, 3, 4, 3, 6, 2, 6, 4, 4, 5, 4, 5, 5,
  2, 8, 4, 5, 4, 5, 5, 6, 5, 5, 5, 5, 2, 2, 3, 6,
  2, 8, 4, 5, 3, 4, 3, 6, 2, 6, 5, 4, 5, 2, 4, 5,
  2, 8, 4, 5, 4, 5, 5, 6, 5, 5, 5, 5, 2, 2, 12, 5,
  3, 8, 4, 5, 3, 4, 3, 6, 2, 6, 4, 4, 5, 2, 4, 4,
  2, 8, 4, 5, 4, 5, 5, 6, 5, 5, 5, 5, 2, 2, 3, 4,
  3, 8, 4, 5, 4, 5, 4, 7, 2, 5, 6, 4, 5, 2, 4, 9,
  2, 8, 4, 5, 5, 6, 6, 7, 4, 5, 5, 5, 2, 2, 6, 3,
  2, 8, 4, 5, 3, 4, 3, 6, 2, 4, 5, 3, 4, 3, 4, 3,
  2, 8, 4, 5, 4, 5, 5, 6, 3, 4, 5, 4, 2, 2, 4, 3,
]);

const BRANCH_PENALTY = 2;

export class SPC700 {
  A = 0;
  X = 0;
  Y = 0;
  SP = 0;
  PC = 0;

  // PSW split into individual flags (0 or 1) for speed.
  fN = 0;
  fV = 0;
  fP = 0;
  fB = 0;
  fH = 0;
  fI = 0;
  fZ = 0;
  fC = 0;

  /** Set by SLEEP / STOP. The core stops fetching but time keeps passing. */
  halted = false;

  /** Cycles consumed by the most recent {@link step}. */
  lastCycles = 0;

  constructor(private bus: SPCBus) {}

  get PSW(): number {
    return (
      (this.fN << 7) |
      (this.fV << 6) |
      (this.fP << 5) |
      (this.fB << 4) |
      (this.fH << 3) |
      (this.fI << 2) |
      (this.fZ << 1) |
      this.fC
    );
  }

  set PSW(v: number) {
    this.fN = (v >> 7) & 1;
    this.fV = (v >> 6) & 1;
    this.fP = (v >> 5) & 1;
    this.fB = (v >> 4) & 1;
    this.fH = (v >> 3) & 1;
    this.fI = (v >> 2) & 1;
    this.fZ = (v >> 1) & 1;
    this.fC = v & 1;
  }

  get YA(): number {
    return (this.Y << 8) | this.A;
  }

  set YA(v: number) {
    this.A = v & 0xff;
    this.Y = (v >> 8) & 0xff;
  }

  reset(): void {
    this.A = this.X = this.Y = 0;
    this.SP = 0xef;
    this.PSW = 0;
    this.halted = false;
    this.PC = this.read16(0xfffe);
  }

  // ---------------------------------------------------------------- memory

  private read(addr: number): number {
    return this.bus.read(addr & 0xffff);
  }

  private write(addr: number, value: number): void {
    this.bus.write(addr & 0xffff, value & 0xff);
  }

  private read16(addr: number): number {
    return this.read(addr) | (this.read(addr + 1) << 8);
  }

  /** Direct-page read; the page wraps within $00xx/$01xx, it does not carry. */
  private readDP(offset: number): number {
    return this.read((this.fP << 8) | (offset & 0xff));
  }

  private writeDP(offset: number, value: number): void {
    this.write((this.fP << 8) | (offset & 0xff), value);
  }

  private readDP16(offset: number): number {
    return this.readDP(offset) | (this.readDP(offset + 1) << 8);
  }

  private writeDP16(offset: number, value: number): void {
    this.writeDP(offset, value & 0xff);
    this.writeDP(offset + 1, (value >> 8) & 0xff);
  }

  private fetch(): number {
    const v = this.read(this.PC);
    this.PC = (this.PC + 1) & 0xffff;
    return v;
  }

  private fetch16(): number {
    return this.fetch() | (this.fetch() << 8);
  }

  private push(value: number): void {
    this.write(0x0100 | this.SP, value);
    this.SP = (this.SP - 1) & 0xff;
  }

  private pop(): number {
    this.SP = (this.SP + 1) & 0xff;
    return this.read(0x0100 | this.SP);
  }

  private push16(value: number): void {
    this.push((value >> 8) & 0xff);
    this.push(value & 0xff);
  }

  private pop16(): number {
    return this.pop() | (this.pop() << 8);
  }

  // ------------------------------------------------------------ ALU helpers

  private setNZ(v: number): number {
    this.fN = (v >> 7) & 1;
    this.fZ = (v & 0xff) === 0 ? 1 : 0;
    return v & 0xff;
  }

  private setNZ16(v: number): number {
    this.fN = (v >> 15) & 1;
    this.fZ = (v & 0xffff) === 0 ? 1 : 0;
    return v & 0xffff;
  }

  private adc(a: number, b: number): number {
    const r = a + b + this.fC;
    this.fC = r > 0xff ? 1 : 0;
    this.fH = ((a ^ b ^ r) & 0x10) !== 0 ? 1 : 0;
    this.fV = ((a ^ r) & (b ^ r) & 0x80) !== 0 ? 1 : 0;
    return this.setNZ(r);
  }

  private sbc(a: number, b: number): number {
    return this.adc(a, b ^ 0xff);
  }

  private cmp(a: number, b: number): number {
    const r = a - b;
    this.fC = r >= 0 ? 1 : 0;
    this.setNZ(r & 0xff);
    return a;
  }

  private asl(v: number): number {
    this.fC = (v >> 7) & 1;
    return this.setNZ(v << 1);
  }

  private lsr(v: number): number {
    this.fC = v & 1;
    return this.setNZ(v >> 1);
  }

  private rol(v: number): number {
    const c = this.fC;
    this.fC = (v >> 7) & 1;
    return this.setNZ((v << 1) | c);
  }

  private ror(v: number): number {
    const c = this.fC;
    this.fC = v & 1;
    return this.setNZ((v >> 1) | (c << 7));
  }

  private addw(a: number, b: number): number {
    const r = a + b + this.fC;
    this.fC = r > 0xffff ? 1 : 0;
    this.fH = ((a ^ b ^ r) & 0x1000) !== 0 ? 1 : 0;
    this.fV = ((a ^ r) & (b ^ r) & 0x8000) !== 0 ? 1 : 0;
    return this.setNZ16(r);
  }

  // --------------------------------------------------------- addressing aid

  /** Resolve the `m.b` operand shared by the bit instructions. */
  private bitOperand(): { addr: number; bit: number } {
    const v = this.fetch16();
    return { addr: v & 0x1fff, bit: (v >> 13) & 7 };
  }

  private branch(taken: boolean): void {
    const offset = (this.fetch() << 24) >> 24; // sign extend
    if (taken) {
      this.PC = (this.PC + offset) & 0xffff;
      this.lastCycles += BRANCH_PENALTY;
    }
  }

  /** BBS/BBC: `d.b, r` — the direct-page byte is fetched before the offset. */
  private branchBit(set: boolean): void {
    const d = this.fetch();
    const v = this.readDP(d);
    const bit = (this.opcode >> 5) & 7;
    this.branch(((v >> bit) & 1) === (set ? 1 : 0));
  }

  private opcode = 0;

  // ------------------------------------------------------------------ step

  /** Execute one instruction. Returns the number of cycles it took. */
  step(): number {
    if (this.halted) {
      this.lastCycles = 2;
      return 2;
    }

    const op = this.fetch();
    this.opcode = op;
    this.lastCycles = CYCLES[op];

    switch (op) {
      // ---- 8-bit arithmetic/logic on A -----------------------------------
      // OR
      case 0x04: this.A = this.setNZ(this.A | this.readDP(this.fetch())); break;
      case 0x05: this.A = this.setNZ(this.A | this.read(this.fetch16())); break;
      case 0x06: this.A = this.setNZ(this.A | this.readDP(this.X)); break;
      case 0x07: this.A = this.setNZ(this.A | this.read(this.readDP16(this.fetch() + this.X))); break;
      case 0x08: this.A = this.setNZ(this.A | this.fetch()); break;
      case 0x09: this.dpDP((a, b) => this.setNZ(b | a)); break;
      case 0x14: this.A = this.setNZ(this.A | this.readDP(this.fetch() + this.X)); break;
      case 0x15: this.A = this.setNZ(this.A | this.read(this.fetch16() + this.X)); break;
      case 0x16: this.A = this.setNZ(this.A | this.read(this.fetch16() + this.Y)); break;
      case 0x17: this.A = this.setNZ(this.A | this.read(this.readDP16(this.fetch()) + this.Y)); break;
      case 0x18: this.dpImm((a, b) => this.setNZ(b | a)); break;
      case 0x19: this.xy((a, b) => this.setNZ(a | b)); break;

      // AND
      case 0x24: this.A = this.setNZ(this.A & this.readDP(this.fetch())); break;
      case 0x25: this.A = this.setNZ(this.A & this.read(this.fetch16())); break;
      case 0x26: this.A = this.setNZ(this.A & this.readDP(this.X)); break;
      case 0x27: this.A = this.setNZ(this.A & this.read(this.readDP16(this.fetch() + this.X))); break;
      case 0x28: this.A = this.setNZ(this.A & this.fetch()); break;
      case 0x29: this.dpDP((a, b) => this.setNZ(b & a)); break;
      case 0x34: this.A = this.setNZ(this.A & this.readDP(this.fetch() + this.X)); break;
      case 0x35: this.A = this.setNZ(this.A & this.read(this.fetch16() + this.X)); break;
      case 0x36: this.A = this.setNZ(this.A & this.read(this.fetch16() + this.Y)); break;
      case 0x37: this.A = this.setNZ(this.A & this.read(this.readDP16(this.fetch()) + this.Y)); break;
      case 0x38: this.dpImm((a, b) => this.setNZ(b & a)); break;
      case 0x39: this.xy((a, b) => this.setNZ(a & b)); break;

      // EOR
      case 0x44: this.A = this.setNZ(this.A ^ this.readDP(this.fetch())); break;
      case 0x45: this.A = this.setNZ(this.A ^ this.read(this.fetch16())); break;
      case 0x46: this.A = this.setNZ(this.A ^ this.readDP(this.X)); break;
      case 0x47: this.A = this.setNZ(this.A ^ this.read(this.readDP16(this.fetch() + this.X))); break;
      case 0x48: this.A = this.setNZ(this.A ^ this.fetch()); break;
      case 0x49: this.dpDP((a, b) => this.setNZ(b ^ a)); break;
      case 0x54: this.A = this.setNZ(this.A ^ this.readDP(this.fetch() + this.X)); break;
      case 0x55: this.A = this.setNZ(this.A ^ this.read(this.fetch16() + this.X)); break;
      case 0x56: this.A = this.setNZ(this.A ^ this.read(this.fetch16() + this.Y)); break;
      case 0x57: this.A = this.setNZ(this.A ^ this.read(this.readDP16(this.fetch()) + this.Y)); break;
      case 0x58: this.dpImm((a, b) => this.setNZ(b ^ a)); break;
      case 0x59: this.xy((a, b) => this.setNZ(a ^ b)); break;

      // CMP
      case 0x64: this.cmp(this.A, this.readDP(this.fetch())); break;
      case 0x65: this.cmp(this.A, this.read(this.fetch16())); break;
      case 0x66: this.cmp(this.A, this.readDP(this.X)); break;
      case 0x67: this.cmp(this.A, this.read(this.readDP16(this.fetch() + this.X))); break;
      case 0x68: this.cmp(this.A, this.fetch()); break;
      case 0x69: this.dpDPCmp(); break;
      case 0x74: this.cmp(this.A, this.readDP(this.fetch() + this.X)); break;
      case 0x75: this.cmp(this.A, this.read(this.fetch16() + this.X)); break;
      case 0x76: this.cmp(this.A, this.read(this.fetch16() + this.Y)); break;
      case 0x77: this.cmp(this.A, this.read(this.readDP16(this.fetch()) + this.Y)); break;
      case 0x78: this.dpImmCmp(); break;
      case 0x79: this.cmp(this.readDP(this.X), this.readDP(this.Y)); break;

      // ADC
      case 0x84: this.A = this.adc(this.A, this.readDP(this.fetch())); break;
      case 0x85: this.A = this.adc(this.A, this.read(this.fetch16())); break;
      case 0x86: this.A = this.adc(this.A, this.readDP(this.X)); break;
      case 0x87: this.A = this.adc(this.A, this.read(this.readDP16(this.fetch() + this.X))); break;
      case 0x88: this.A = this.adc(this.A, this.fetch()); break;
      case 0x89: this.dpDP((a, b) => this.adc(b, a)); break;
      case 0x94: this.A = this.adc(this.A, this.readDP(this.fetch() + this.X)); break;
      case 0x95: this.A = this.adc(this.A, this.read(this.fetch16() + this.X)); break;
      case 0x96: this.A = this.adc(this.A, this.read(this.fetch16() + this.Y)); break;
      case 0x97: this.A = this.adc(this.A, this.read(this.readDP16(this.fetch()) + this.Y)); break;
      case 0x98: this.dpImm((a, b) => this.adc(b, a)); break;
      case 0x99: this.xy((a, b) => this.adc(a, b)); break;

      // SBC
      case 0xa4: this.A = this.sbc(this.A, this.readDP(this.fetch())); break;
      case 0xa5: this.A = this.sbc(this.A, this.read(this.fetch16())); break;
      case 0xa6: this.A = this.sbc(this.A, this.readDP(this.X)); break;
      case 0xa7: this.A = this.sbc(this.A, this.read(this.readDP16(this.fetch() + this.X))); break;
      case 0xa8: this.A = this.sbc(this.A, this.fetch()); break;
      case 0xa9: this.dpDP((a, b) => this.sbc(b, a)); break;
      case 0xb4: this.A = this.sbc(this.A, this.readDP(this.fetch() + this.X)); break;
      case 0xb5: this.A = this.sbc(this.A, this.read(this.fetch16() + this.X)); break;
      case 0xb6: this.A = this.sbc(this.A, this.read(this.fetch16() + this.Y)); break;
      case 0xb7: this.A = this.sbc(this.A, this.read(this.readDP16(this.fetch()) + this.Y)); break;
      case 0xb8: this.dpImm((a, b) => this.sbc(b, a)); break;
      case 0xb9: this.xy((a, b) => this.sbc(a, b)); break;

      // ---- compares against X / Y ----------------------------------------
      case 0x1e: this.cmp(this.X, this.read(this.fetch16())); break;
      case 0x3e: this.cmp(this.X, this.readDP(this.fetch())); break;
      case 0xc8: this.cmp(this.X, this.fetch()); break;
      case 0x5e: this.cmp(this.Y, this.read(this.fetch16())); break;
      case 0x7e: this.cmp(this.Y, this.readDP(this.fetch())); break;
      case 0xad: this.cmp(this.Y, this.fetch()); break;

      // ---- shifts / rotates ----------------------------------------------
      case 0x0b: this.rmwDP((v) => this.asl(v), this.fetch()); break;
      case 0x0c: this.rmw((v) => this.asl(v), this.fetch16()); break;
      case 0x1b: this.rmwDP((v) => this.asl(v), this.fetch() + this.X); break;
      case 0x1c: this.A = this.asl(this.A); break;
      case 0x2b: this.rmwDP((v) => this.rol(v), this.fetch()); break;
      case 0x2c: this.rmw((v) => this.rol(v), this.fetch16()); break;
      case 0x3b: this.rmwDP((v) => this.rol(v), this.fetch() + this.X); break;
      case 0x3c: this.A = this.rol(this.A); break;
      case 0x4b: this.rmwDP((v) => this.lsr(v), this.fetch()); break;
      case 0x4c: this.rmw((v) => this.lsr(v), this.fetch16()); break;
      case 0x5b: this.rmwDP((v) => this.lsr(v), this.fetch() + this.X); break;
      case 0x5c: this.A = this.lsr(this.A); break;
      case 0x6b: this.rmwDP((v) => this.ror(v), this.fetch()); break;
      case 0x6c: this.rmw((v) => this.ror(v), this.fetch16()); break;
      case 0x7b: this.rmwDP((v) => this.ror(v), this.fetch() + this.X); break;
      case 0x7c: this.A = this.ror(this.A); break;

      // ---- increment / decrement -----------------------------------------
      case 0x8b: this.rmwDP((v) => this.setNZ(v - 1), this.fetch()); break;
      case 0x8c: this.rmw((v) => this.setNZ(v - 1), this.fetch16()); break;
      case 0x9b: this.rmwDP((v) => this.setNZ(v - 1), this.fetch() + this.X); break;
      case 0x9c: this.A = this.setNZ(this.A - 1); break;
      case 0xab: this.rmwDP((v) => this.setNZ(v + 1), this.fetch()); break;
      case 0xac: this.rmw((v) => this.setNZ(v + 1), this.fetch16()); break;
      case 0xbb: this.rmwDP((v) => this.setNZ(v + 1), this.fetch() + this.X); break;
      case 0xbc: this.A = this.setNZ(this.A + 1); break;
      case 0x1d: this.X = this.setNZ(this.X - 1); break;
      case 0x3d: this.X = this.setNZ(this.X + 1); break;
      case 0xdc: this.Y = this.setNZ(this.Y - 1); break;
      case 0xfc: this.Y = this.setNZ(this.Y + 1); break;

      // ---- 16-bit ----------------------------------------------------------
      case 0x1a: { const d = this.fetch(); this.writeDP16(d, this.setNZ16(this.readDP16(d) - 1)); break; }
      case 0x3a: { const d = this.fetch(); this.writeDP16(d, this.setNZ16(this.readDP16(d) + 1)); break; }
      case 0x5a: { // CMPW YA,d
        const b = this.readDP16(this.fetch());
        const r = this.YA - b;
        this.fC = r >= 0 ? 1 : 0;
        this.setNZ16(r & 0xffff);
        break;
      }
      case 0x7a: { // ADDW YA,d
        const b = this.readDP16(this.fetch());
        this.fC = 0;
        this.YA = this.addw(this.YA, b);
        break;
      }
      case 0x9a: { // SUBW YA,d
        const b = this.readDP16(this.fetch());
        this.fC = 1;
        this.YA = this.addw(this.YA, b ^ 0xffff);
        break;
      }
      case 0xba: this.YA = this.setNZ16(this.readDP16(this.fetch())); break;
      case 0xda: { const d = this.fetch(); this.readDP(d); this.writeDP16(d, this.YA); break; }

      // ---- MOV -------------------------------------------------------------
      case 0xe8: this.A = this.setNZ(this.fetch()); break;
      case 0xcd: this.X = this.setNZ(this.fetch()); break;
      case 0x8d: this.Y = this.setNZ(this.fetch()); break;

      case 0xe4: this.A = this.setNZ(this.readDP(this.fetch())); break;
      case 0xe5: this.A = this.setNZ(this.read(this.fetch16())); break;
      case 0xe6: this.A = this.setNZ(this.readDP(this.X)); break;
      case 0xe7: this.A = this.setNZ(this.read(this.readDP16(this.fetch() + this.X))); break;
      case 0xf4: this.A = this.setNZ(this.readDP(this.fetch() + this.X)); break;
      case 0xf5: this.A = this.setNZ(this.read(this.fetch16() + this.X)); break;
      case 0xf6: this.A = this.setNZ(this.read(this.fetch16() + this.Y)); break;
      case 0xf7: this.A = this.setNZ(this.read(this.readDP16(this.fetch()) + this.Y)); break;
      case 0xbf: this.A = this.setNZ(this.readDP(this.X)); this.X = (this.X + 1) & 0xff; break;

      case 0xf8: this.X = this.setNZ(this.readDP(this.fetch())); break;
      case 0xf9: this.X = this.setNZ(this.readDP(this.fetch() + this.Y)); break;
      case 0xe9: this.X = this.setNZ(this.read(this.fetch16())); break;
      case 0xeb: this.Y = this.setNZ(this.readDP(this.fetch())); break;
      case 0xfb: this.Y = this.setNZ(this.readDP(this.fetch() + this.X)); break;
      case 0xec: this.Y = this.setNZ(this.read(this.fetch16())); break;

      case 0xc4: this.writeDP(this.fetch(), this.A); break;
      case 0xc5: this.write(this.fetch16(), this.A); break;
      case 0xc6: this.writeDP(this.X, this.A); break;
      case 0xc7: this.write(this.readDP16(this.fetch() + this.X), this.A); break;
      case 0xd4: this.writeDP(this.fetch() + this.X, this.A); break;
      case 0xd5: this.write(this.fetch16() + this.X, this.A); break;
      case 0xd6: this.write(this.fetch16() + this.Y, this.A); break;
      case 0xd7: this.write(this.readDP16(this.fetch()) + this.Y, this.A); break;
      case 0xaf: this.writeDP(this.X, this.A); this.X = (this.X + 1) & 0xff; break;

      case 0xd8: this.writeDP(this.fetch(), this.X); break;
      case 0xd9: this.writeDP(this.fetch() + this.Y, this.X); break;
      case 0xc9: this.write(this.fetch16(), this.X); break;
      case 0xcb: this.writeDP(this.fetch(), this.Y); break;
      case 0xdb: this.writeDP(this.fetch() + this.X, this.Y); break;
      case 0xcc: this.write(this.fetch16(), this.Y); break;

      case 0x8f: { const v = this.fetch(); this.writeDP(this.fetch(), v); break; }
      case 0xfa: { const src = this.fetch(); const v = this.readDP(src); this.writeDP(this.fetch(), v); break; }

      case 0x7d: this.A = this.setNZ(this.X); break;
      case 0xdd: this.A = this.setNZ(this.Y); break;
      case 0x5d: this.X = this.setNZ(this.A); break;
      case 0xfd: this.Y = this.setNZ(this.A); break;
      case 0x9d: this.X = this.setNZ(this.SP); break;
      case 0xbd: this.SP = this.X; break;

      // ---- stack -----------------------------------------------------------
      case 0x2d: this.push(this.A); break;
      case 0x4d: this.push(this.X); break;
      case 0x6d: this.push(this.Y); break;
      case 0x0d: this.push(this.PSW); break;
      case 0xae: this.A = this.pop(); break;
      case 0xce: this.X = this.pop(); break;
      case 0xee: this.Y = this.pop(); break;
      case 0x8e: this.PSW = this.pop(); break;

      // ---- branches ---------------------------------------------------------
      case 0x10: this.branch(this.fN === 0); break;
      case 0x30: this.branch(this.fN === 1); break;
      case 0x50: this.branch(this.fV === 0); break;
      case 0x70: this.branch(this.fV === 1); break;
      case 0x90: this.branch(this.fC === 0); break;
      case 0xb0: this.branch(this.fC === 1); break;
      case 0xd0: this.branch(this.fZ === 0); break;
      case 0xf0: this.branch(this.fZ === 1); break;
      case 0x2f: this.branch(true); break;

      case 0x03: case 0x23: case 0x43: case 0x63:
      case 0x83: case 0xa3: case 0xc3: case 0xe3:
        this.branchBit(true); break;
      case 0x13: case 0x33: case 0x53: case 0x73:
      case 0x93: case 0xb3: case 0xd3: case 0xf3:
        this.branchBit(false); break;

      case 0x2e: { const v = this.readDP(this.fetch()); this.branch(this.A !== v); break; }
      case 0xde: { const v = this.readDP(this.fetch() + this.X); this.branch(this.A !== v); break; }
      case 0x6e: { // DBNZ d,r
        const d = this.fetch();
        const v = (this.readDP(d) - 1) & 0xff;
        this.writeDP(d, v);
        this.branch(v !== 0);
        break;
      }
      case 0xfe: this.Y = (this.Y - 1) & 0xff; this.branch(this.Y !== 0); break;

      // ---- jumps / calls -----------------------------------------------------
      case 0x5f: this.PC = this.fetch16(); break;
      case 0x1f: this.PC = this.read16((this.fetch16() + this.X) & 0xffff); break;
      case 0x3f: { const a = this.fetch16(); this.push16(this.PC); this.PC = a; break; }
      case 0x4f: { const u = this.fetch(); this.push16(this.PC); this.PC = 0xff00 | u; break; }
      case 0x6f: this.PC = this.pop16(); break;
      case 0x7f: this.PSW = this.pop(); this.PC = this.pop16(); break;

      case 0x01: case 0x11: case 0x21: case 0x31:
      case 0x41: case 0x51: case 0x61: case 0x71:
      case 0x81: case 0x91: case 0xa1: case 0xb1:
      case 0xc1: case 0xd1: case 0xe1: case 0xf1: {
        const n = op >> 4;
        this.push16(this.PC);
        this.PC = this.read16(0xffde - n * 2);
        break;
      }

      case 0x0f: // BRK
        this.push16(this.PC);
        this.push(this.PSW);
        this.fB = 1;
        this.fI = 0;
        this.PC = this.read16(0xffde);
        break;

      // ---- bit set/clear on direct page ---------------------------------------
      case 0x02: case 0x22: case 0x42: case 0x62:
      case 0x82: case 0xa2: case 0xc2: case 0xe2: {
        const d = this.fetch();
        this.writeDP(d, this.readDP(d) | (1 << (op >> 5)));
        break;
      }
      case 0x12: case 0x32: case 0x52: case 0x72:
      case 0x92: case 0xb2: case 0xd2: case 0xf2: {
        const d = this.fetch();
        this.writeDP(d, this.readDP(d) & ~(1 << (op >> 5)));
        break;
      }

      // ---- carry / memory bit operations ---------------------------------------
      case 0x0a: { const { addr, bit } = this.bitOperand(); this.fC |= (this.read(addr) >> bit) & 1; break; }
      case 0x2a: { const { addr, bit } = this.bitOperand(); this.fC |= ~(this.read(addr) >> bit) & 1; break; }
      case 0x4a: { const { addr, bit } = this.bitOperand(); this.fC &= (this.read(addr) >> bit) & 1; break; }
      case 0x6a: { const { addr, bit } = this.bitOperand(); this.fC &= ~(this.read(addr) >> bit) & 1; break; }
      case 0x8a: { const { addr, bit } = this.bitOperand(); this.fC ^= (this.read(addr) >> bit) & 1; break; }
      case 0xaa: { const { addr, bit } = this.bitOperand(); this.fC = (this.read(addr) >> bit) & 1; break; }
      case 0xca: {
        const { addr, bit } = this.bitOperand();
        const v = this.read(addr);
        this.write(addr, this.fC ? v | (1 << bit) : v & ~(1 << bit));
        break;
      }
      case 0xea: {
        const { addr, bit } = this.bitOperand();
        this.write(addr, this.read(addr) ^ (1 << bit));
        break;
      }

      // ---- test and set/clear ---------------------------------------------------
      case 0x0e: { const a = this.fetch16(); const v = this.read(a); this.setNZ(this.A - v); this.write(a, v | this.A); break; }
      case 0x4e: { const a = this.fetch16(); const v = this.read(a); this.setNZ(this.A - v); this.write(a, v & ~this.A); break; }

      // ---- flags ------------------------------------------------------------------
      case 0x20: this.fP = 0; break;
      case 0x40: this.fP = 1; break;
      case 0x60: this.fC = 0; break;
      case 0x80: this.fC = 1; break;
      case 0xa0: this.fI = 1; break;
      case 0xc0: this.fI = 0; break;
      case 0xe0: this.fV = 0; this.fH = 0; break;
      case 0xed: this.fC ^= 1; break;

      // ---- misc ---------------------------------------------------------------------
      case 0x00: break; // NOP
      case 0x9f: this.A = this.setNZ((this.A >> 4) | (this.A << 4)); break;
      case 0xcf: { // MUL YA
        const r = this.Y * this.A;
        this.A = r & 0xff;
        this.Y = (r >> 8) & 0xff;
        this.setNZ(this.Y);
        break;
      }
      case 0x9e: this.divide(); break;
      case 0xdf: this.daa(); break;
      case 0xbe: this.das(); break;
      case 0xef: case 0xff: this.halted = true; break;

      default:
        // Every opcode is covered above; this is unreachable.
        throw new Error(`unimplemented SPC700 opcode $${op.toString(16)}`);
    }

    return this.lastCycles;
  }

  // ------------------------------------------------------- operand patterns

  /** `op dd, ds` — the source direct-page address is encoded first. */
  private dpDP(fn: (src: number, dst: number) => number): void {
    const src = this.readDP(this.fetch());
    const d = this.fetch();
    this.writeDP(d, fn(src, this.readDP(d)));
  }

  /** `op d, #i` — the immediate is encoded first. */
  private dpImm(fn: (imm: number, dst: number) => number): void {
    const imm = this.fetch();
    const d = this.fetch();
    this.writeDP(d, fn(imm, this.readDP(d)));
  }

  /** `op (X), (Y)` */
  private xy(fn: (x: number, y: number) => number): void {
    const y = this.readDP(this.Y);
    const x = this.readDP(this.X);
    this.writeDP(this.X, fn(x, y));
  }

  /** CMP dd, ds — like {@link dpDP} but without the write-back. */
  private dpDPCmp(): void {
    const src = this.readDP(this.fetch());
    const dst = this.readDP(this.fetch());
    this.cmp(dst, src);
  }

  /** CMP d, #i — like {@link dpImm} but without the write-back. */
  private dpImmCmp(): void {
    const imm = this.fetch();
    const dst = this.readDP(this.fetch());
    this.cmp(dst, imm);
  }

  private rmw(fn: (v: number) => number, addr: number): void {
    this.write(addr, fn(this.read(addr)));
  }

  private rmwDP(fn: (v: number) => number, offset: number): void {
    this.writeDP(offset, fn(this.readDP(offset)));
  }

  // ---------------------------------------------------------------- helpers

  private divide(): void {
    const ya = this.YA;
    this.fH = (this.X & 15) <= (this.Y & 15) ? 1 : 0;
    this.fV = this.Y >= this.X ? 1 : 0;
    if (this.X === 0) {
      // Hardware yields garbage; keep it finite and deterministic.
      this.A = 0xff;
      this.Y = 0xff;
    } else if (this.Y < this.X << 1) {
      this.A = (ya / this.X) | 0;
      this.Y = ya % this.X;
    } else {
      const t = ya - (this.X << 9);
      this.A = 255 - ((t / (256 - this.X)) | 0);
      this.Y = this.X + (t % (256 - this.X));
    }
    this.A &= 0xff;
    this.Y &= 0xff;
    this.setNZ(this.A);
  }

  private daa(): void {
    if (this.fC || this.A > 0x99) {
      this.A += 0x60;
      this.fC = 1;
    }
    if (this.fH || (this.A & 0x0f) > 0x09) {
      this.A += 0x06;
    }
    this.A = this.setNZ(this.A);
  }

  private das(): void {
    if (!this.fC || this.A > 0x99) {
      this.A -= 0x60;
      this.fC = 0;
    }
    if (!this.fH || (this.A & 0x0f) > 0x09) {
      this.A -= 0x06;
    }
    this.A = this.setNZ(this.A & 0xff);
  }
}

