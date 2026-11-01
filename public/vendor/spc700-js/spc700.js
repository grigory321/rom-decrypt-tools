const CYCLES = new Uint8Array([
  2, 8, 4, 5, 3, 4, 3, 6, 2, 6, 5, 4, 5, 4, 6, 8, 2, 8, 4, 5, 4, 5, 5, 6, 5, 5,
  6, 5, 2, 2, 4, 6, 2, 8, 4, 5, 3, 4, 3, 6, 2, 6, 5, 4, 5, 4, 5, 4, 2, 8, 4, 5,
  4, 5, 5, 6, 5, 5, 6, 5, 2, 2, 3, 8, 2, 8, 4, 5, 3, 4, 3, 6, 2, 6, 4, 4, 5, 4,
  6, 6, 2, 8, 4, 5, 4, 5, 5, 6, 5, 5, 4, 5, 2, 2, 4, 3, 2, 8, 4, 5, 3, 4, 3, 6,
  2, 6, 4, 4, 5, 4, 5, 5, 2, 8, 4, 5, 4, 5, 5, 6, 5, 5, 5, 5, 2, 2, 3, 6, 2, 8,
  4, 5, 3, 4, 3, 6, 2, 6, 5, 4, 5, 2, 4, 5, 2, 8, 4, 5, 4, 5, 5, 6, 5, 5, 5, 5,
  2, 2, 12, 5, 3, 8, 4, 5, 3, 4, 3, 6, 2, 6, 4, 4, 5, 2, 4, 4, 2, 8, 4, 5, 4, 5,
  5, 6, 5, 5, 5, 5, 2, 2, 3, 4, 3, 8, 4, 5, 4, 5, 4, 7, 2, 5, 6, 4, 5, 2, 4, 9,
  2, 8, 4, 5, 5, 6, 6, 7, 4, 5, 5, 5, 2, 2, 6, 3, 2, 8, 4, 5, 3, 4, 3, 6, 2, 4,
  5, 3, 4, 3, 4, 3, 2, 8, 4, 5, 4, 5, 5, 6, 3, 4, 5, 4, 2, 2, 4, 3,
]);

const BRANCH_PENALTY = 2;

export class SPC700 {
  bus;
  A = 0;
  X = 0;
  Y = 0;
  SP = 0;
  PC = 0;
  fN = 0;
  fV = 0;
  fP = 0;
  fB = 0;
  fH = 0;
  fI = 0;
  fZ = 0;
  fC = 0;
  halted = false;
  lastCycles = 0;
  constructor(bus) {
    this.bus = bus;
  }
  get PSW() {
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
  set PSW(v) {
    this.fN = (v >> 7) & 1;
    this.fV = (v >> 6) & 1;
    this.fP = (v >> 5) & 1;
    this.fB = (v >> 4) & 1;
    this.fH = (v >> 3) & 1;
    this.fI = (v >> 2) & 1;
    this.fZ = (v >> 1) & 1;
    this.fC = v & 1;
  }
  get YA() {
    return (this.Y << 8) | this.A;
  }
  set YA(v) {
    this.A = v & 255;
    this.Y = (v >> 8) & 255;
  }
  reset() {
    this.A = this.X = this.Y = 0;
    this.SP = 239;
    this.PSW = 0;
    this.halted = false;
    this.PC = this.read16(65534);
  }
  read(addr) {
    return this.bus.read(addr & 65535);
  }
  write(addr, value) {
    this.bus.write(addr & 65535, value & 255);
  }
  read16(addr) {
    return this.read(addr) | (this.read(addr + 1) << 8);
  }
  readDP(offset) {
    return this.read((this.fP << 8) | (offset & 255));
  }
  writeDP(offset, value) {
    this.write((this.fP << 8) | (offset & 255), value);
  }
  readDP16(offset) {
    return this.readDP(offset) | (this.readDP(offset + 1) << 8);
  }
  writeDP16(offset, value) {
    this.writeDP(offset, value & 255);
    this.writeDP(offset + 1, (value >> 8) & 255);
  }
  fetch() {
    const v = this.read(this.PC);
    this.PC = (this.PC + 1) & 65535;
    return v;
  }
  fetch16() {
    return this.fetch() | (this.fetch() << 8);
  }
  push(value) {
    this.write(256 | this.SP, value);
    this.SP = (this.SP - 1) & 255;
  }
  pop() {
    this.SP = (this.SP + 1) & 255;
    return this.read(256 | this.SP);
  }
  push16(value) {
    this.push((value >> 8) & 255);
    this.push(value & 255);
  }
  pop16() {
    return this.pop() | (this.pop() << 8);
  }
  setNZ(v) {
    this.fN = (v >> 7) & 1;
    this.fZ = (v & 255) === 0 ? 1 : 0;
    return v & 255;
  }
  setNZ16(v) {
    this.fN = (v >> 15) & 1;
    this.fZ = (v & 65535) === 0 ? 1 : 0;
    return v & 65535;
  }
  adc(a, b) {
    const r = a + b + this.fC;
    this.fC = r > 255 ? 1 : 0;
    this.fH = ((a ^ b ^ r) & 16) !== 0 ? 1 : 0;
    this.fV = ((a ^ r) & (b ^ r) & 128) !== 0 ? 1 : 0;
    return this.setNZ(r);
  }
  sbc(a, b) {
    return this.adc(a, b ^ 255);
  }
  cmp(a, b) {
    const r = a - b;
    this.fC = r >= 0 ? 1 : 0;
    this.setNZ(r & 255);
    return a;
  }
  asl(v) {
    this.fC = (v >> 7) & 1;
    return this.setNZ(v << 1);
  }
  lsr(v) {
    this.fC = v & 1;
    return this.setNZ(v >> 1);
  }
  rol(v) {
    const c = this.fC;
    this.fC = (v >> 7) & 1;
    return this.setNZ((v << 1) | c);
  }
  ror(v) {
    const c = this.fC;
    this.fC = v & 1;
    return this.setNZ((v >> 1) | (c << 7));
  }
  addw(a, b) {
    const r = a + b + this.fC;
    this.fC = r > 65535 ? 1 : 0;
    this.fH = ((a ^ b ^ r) & 4096) !== 0 ? 1 : 0;
    this.fV = ((a ^ r) & (b ^ r) & 32768) !== 0 ? 1 : 0;
    return this.setNZ16(r);
  }
  bitOperand() {
    const v = this.fetch16();
    return {
      addr: v & 8191,
      bit: (v >> 13) & 7,
    };
  }
  branch(taken) {
    const offset = (this.fetch() << 24) >> 24;
    if (taken) {
      this.PC = (this.PC + offset) & 65535;
      this.lastCycles += BRANCH_PENALTY;
    }
  }
  branchBit(set) {
    const d = this.fetch();
    const v = this.readDP(d);
    const bit = (this.opcode >> 5) & 7;
    this.branch(((v >> bit) & 1) === (set ? 1 : 0));
  }
  opcode = 0;
  step() {
    if (this.halted) {
      this.lastCycles = 2;
      return 2;
    }
    const op = this.fetch();
    this.opcode = op;
    this.lastCycles = CYCLES[op];
    switch (op) {
      case 4:
        this.A = this.setNZ(this.A | this.readDP(this.fetch()));
        break;

      case 5:
        this.A = this.setNZ(this.A | this.read(this.fetch16()));
        break;

      case 6:
        this.A = this.setNZ(this.A | this.readDP(this.X));
        break;

      case 7:
        this.A = this.setNZ(
          this.A | this.read(this.readDP16(this.fetch() + this.X)),
        );
        break;

      case 8:
        this.A = this.setNZ(this.A | this.fetch());
        break;

      case 9:
        this.dpDP((a, b) => this.setNZ(b | a));
        break;

      case 20:
        this.A = this.setNZ(this.A | this.readDP(this.fetch() + this.X));
        break;

      case 21:
        this.A = this.setNZ(this.A | this.read(this.fetch16() + this.X));
        break;

      case 22:
        this.A = this.setNZ(this.A | this.read(this.fetch16() + this.Y));
        break;

      case 23:
        this.A = this.setNZ(
          this.A | this.read(this.readDP16(this.fetch()) + this.Y),
        );
        break;

      case 24:
        this.dpImm((a, b) => this.setNZ(b | a));
        break;

      case 25:
        this.xy((a, b) => this.setNZ(a | b));
        break;

      case 36:
        this.A = this.setNZ(this.A & this.readDP(this.fetch()));
        break;

      case 37:
        this.A = this.setNZ(this.A & this.read(this.fetch16()));
        break;

      case 38:
        this.A = this.setNZ(this.A & this.readDP(this.X));
        break;

      case 39:
        this.A = this.setNZ(
          this.A & this.read(this.readDP16(this.fetch() + this.X)),
        );
        break;

      case 40:
        this.A = this.setNZ(this.A & this.fetch());
        break;

      case 41:
        this.dpDP((a, b) => this.setNZ(b & a));
        break;

      case 52:
        this.A = this.setNZ(this.A & this.readDP(this.fetch() + this.X));
        break;

      case 53:
        this.A = this.setNZ(this.A & this.read(this.fetch16() + this.X));
        break;

      case 54:
        this.A = this.setNZ(this.A & this.read(this.fetch16() + this.Y));
        break;

      case 55:
        this.A = this.setNZ(
          this.A & this.read(this.readDP16(this.fetch()) + this.Y),
        );
        break;

      case 56:
        this.dpImm((a, b) => this.setNZ(b & a));
        break;

      case 57:
        this.xy((a, b) => this.setNZ(a & b));
        break;

      case 68:
        this.A = this.setNZ(this.A ^ this.readDP(this.fetch()));
        break;

      case 69:
        this.A = this.setNZ(this.A ^ this.read(this.fetch16()));
        break;

      case 70:
        this.A = this.setNZ(this.A ^ this.readDP(this.X));
        break;

      case 71:
        this.A = this.setNZ(
          this.A ^ this.read(this.readDP16(this.fetch() + this.X)),
        );
        break;

      case 72:
        this.A = this.setNZ(this.A ^ this.fetch());
        break;

      case 73:
        this.dpDP((a, b) => this.setNZ(b ^ a));
        break;

      case 84:
        this.A = this.setNZ(this.A ^ this.readDP(this.fetch() + this.X));
        break;

      case 85:
        this.A = this.setNZ(this.A ^ this.read(this.fetch16() + this.X));
        break;

      case 86:
        this.A = this.setNZ(this.A ^ this.read(this.fetch16() + this.Y));
        break;

      case 87:
        this.A = this.setNZ(
          this.A ^ this.read(this.readDP16(this.fetch()) + this.Y),
        );
        break;

      case 88:
        this.dpImm((a, b) => this.setNZ(b ^ a));
        break;

      case 89:
        this.xy((a, b) => this.setNZ(a ^ b));
        break;

      case 100:
        this.cmp(this.A, this.readDP(this.fetch()));
        break;

      case 101:
        this.cmp(this.A, this.read(this.fetch16()));
        break;

      case 102:
        this.cmp(this.A, this.readDP(this.X));
        break;

      case 103:
        this.cmp(this.A, this.read(this.readDP16(this.fetch() + this.X)));
        break;

      case 104:
        this.cmp(this.A, this.fetch());
        break;

      case 105:
        this.dpDPCmp();
        break;

      case 116:
        this.cmp(this.A, this.readDP(this.fetch() + this.X));
        break;

      case 117:
        this.cmp(this.A, this.read(this.fetch16() + this.X));
        break;

      case 118:
        this.cmp(this.A, this.read(this.fetch16() + this.Y));
        break;

      case 119:
        this.cmp(this.A, this.read(this.readDP16(this.fetch()) + this.Y));
        break;

      case 120:
        this.dpImmCmp();
        break;

      case 121:
        this.cmp(this.readDP(this.X), this.readDP(this.Y));
        break;

      case 132:
        this.A = this.adc(this.A, this.readDP(this.fetch()));
        break;

      case 133:
        this.A = this.adc(this.A, this.read(this.fetch16()));
        break;

      case 134:
        this.A = this.adc(this.A, this.readDP(this.X));
        break;

      case 135:
        this.A = this.adc(
          this.A,
          this.read(this.readDP16(this.fetch() + this.X)),
        );
        break;

      case 136:
        this.A = this.adc(this.A, this.fetch());
        break;

      case 137:
        this.dpDP((a, b) => this.adc(b, a));
        break;

      case 148:
        this.A = this.adc(this.A, this.readDP(this.fetch() + this.X));
        break;

      case 149:
        this.A = this.adc(this.A, this.read(this.fetch16() + this.X));
        break;

      case 150:
        this.A = this.adc(this.A, this.read(this.fetch16() + this.Y));
        break;

      case 151:
        this.A = this.adc(
          this.A,
          this.read(this.readDP16(this.fetch()) + this.Y),
        );
        break;

      case 152:
        this.dpImm((a, b) => this.adc(b, a));
        break;

      case 153:
        this.xy((a, b) => this.adc(a, b));
        break;

      case 164:
        this.A = this.sbc(this.A, this.readDP(this.fetch()));
        break;

      case 165:
        this.A = this.sbc(this.A, this.read(this.fetch16()));
        break;

      case 166:
        this.A = this.sbc(this.A, this.readDP(this.X));
        break;

      case 167:
        this.A = this.sbc(
          this.A,
          this.read(this.readDP16(this.fetch() + this.X)),
        );
        break;

      case 168:
        this.A = this.sbc(this.A, this.fetch());
        break;

      case 169:
        this.dpDP((a, b) => this.sbc(b, a));
        break;

      case 180:
        this.A = this.sbc(this.A, this.readDP(this.fetch() + this.X));
        break;

      case 181:
        this.A = this.sbc(this.A, this.read(this.fetch16() + this.X));
        break;

      case 182:
        this.A = this.sbc(this.A, this.read(this.fetch16() + this.Y));
        break;

      case 183:
        this.A = this.sbc(
          this.A,
          this.read(this.readDP16(this.fetch()) + this.Y),
        );
        break;

      case 184:
        this.dpImm((a, b) => this.sbc(b, a));
        break;

      case 185:
        this.xy((a, b) => this.sbc(a, b));
        break;

      case 30:
        this.cmp(this.X, this.read(this.fetch16()));
        break;

      case 62:
        this.cmp(this.X, this.readDP(this.fetch()));
        break;

      case 200:
        this.cmp(this.X, this.fetch());
        break;

      case 94:
        this.cmp(this.Y, this.read(this.fetch16()));
        break;

      case 126:
        this.cmp(this.Y, this.readDP(this.fetch()));
        break;

      case 173:
        this.cmp(this.Y, this.fetch());
        break;

      case 11:
        this.rmwDP((v) => this.asl(v), this.fetch());
        break;

      case 12:
        this.rmw((v) => this.asl(v), this.fetch16());
        break;

      case 27:
        this.rmwDP((v) => this.asl(v), this.fetch() + this.X);
        break;

      case 28:
        this.A = this.asl(this.A);
        break;

      case 43:
        this.rmwDP((v) => this.rol(v), this.fetch());
        break;

      case 44:
        this.rmw((v) => this.rol(v), this.fetch16());
        break;

      case 59:
        this.rmwDP((v) => this.rol(v), this.fetch() + this.X);
        break;

      case 60:
        this.A = this.rol(this.A);
        break;

      case 75:
        this.rmwDP((v) => this.lsr(v), this.fetch());
        break;

      case 76:
        this.rmw((v) => this.lsr(v), this.fetch16());
        break;

      case 91:
        this.rmwDP((v) => this.lsr(v), this.fetch() + this.X);
        break;

      case 92:
        this.A = this.lsr(this.A);
        break;

      case 107:
        this.rmwDP((v) => this.ror(v), this.fetch());
        break;

      case 108:
        this.rmw((v) => this.ror(v), this.fetch16());
        break;

      case 123:
        this.rmwDP((v) => this.ror(v), this.fetch() + this.X);
        break;

      case 124:
        this.A = this.ror(this.A);
        break;

      case 139:
        this.rmwDP((v) => this.setNZ(v - 1), this.fetch());
        break;

      case 140:
        this.rmw((v) => this.setNZ(v - 1), this.fetch16());
        break;

      case 155:
        this.rmwDP((v) => this.setNZ(v - 1), this.fetch() + this.X);
        break;

      case 156:
        this.A = this.setNZ(this.A - 1);
        break;

      case 171:
        this.rmwDP((v) => this.setNZ(v + 1), this.fetch());
        break;

      case 172:
        this.rmw((v) => this.setNZ(v + 1), this.fetch16());
        break;

      case 187:
        this.rmwDP((v) => this.setNZ(v + 1), this.fetch() + this.X);
        break;

      case 188:
        this.A = this.setNZ(this.A + 1);
        break;

      case 29:
        this.X = this.setNZ(this.X - 1);
        break;

      case 61:
        this.X = this.setNZ(this.X + 1);
        break;

      case 220:
        this.Y = this.setNZ(this.Y - 1);
        break;

      case 252:
        this.Y = this.setNZ(this.Y + 1);
        break;

      case 26: {
        const d = this.fetch();
        this.writeDP16(d, this.setNZ16(this.readDP16(d) - 1));
        break;
      }

      case 58: {
        const d = this.fetch();
        this.writeDP16(d, this.setNZ16(this.readDP16(d) + 1));
        break;
      }

      case 90: {
        const b = this.readDP16(this.fetch());
        const r = this.YA - b;
        this.fC = r >= 0 ? 1 : 0;
        this.setNZ16(r & 65535);
        break;
      }

      case 122: {
        const b = this.readDP16(this.fetch());
        this.fC = 0;
        this.YA = this.addw(this.YA, b);
        break;
      }

      case 154: {
        const b = this.readDP16(this.fetch());
        this.fC = 1;
        this.YA = this.addw(this.YA, b ^ 65535);
        break;
      }

      case 186:
        this.YA = this.setNZ16(this.readDP16(this.fetch()));
        break;

      case 218: {
        const d = this.fetch();
        this.readDP(d);
        this.writeDP16(d, this.YA);
        break;
      }

      case 232:
        this.A = this.setNZ(this.fetch());
        break;

      case 205:
        this.X = this.setNZ(this.fetch());
        break;

      case 141:
        this.Y = this.setNZ(this.fetch());
        break;

      case 228:
        this.A = this.setNZ(this.readDP(this.fetch()));
        break;

      case 229:
        this.A = this.setNZ(this.read(this.fetch16()));
        break;

      case 230:
        this.A = this.setNZ(this.readDP(this.X));
        break;

      case 231:
        this.A = this.setNZ(this.read(this.readDP16(this.fetch() + this.X)));
        break;

      case 244:
        this.A = this.setNZ(this.readDP(this.fetch() + this.X));
        break;

      case 245:
        this.A = this.setNZ(this.read(this.fetch16() + this.X));
        break;

      case 246:
        this.A = this.setNZ(this.read(this.fetch16() + this.Y));
        break;

      case 247:
        this.A = this.setNZ(this.read(this.readDP16(this.fetch()) + this.Y));
        break;

      case 191:
        this.A = this.setNZ(this.readDP(this.X));
        this.X = (this.X + 1) & 255;
        break;

      case 248:
        this.X = this.setNZ(this.readDP(this.fetch()));
        break;

      case 249:
        this.X = this.setNZ(this.readDP(this.fetch() + this.Y));
        break;

      case 233:
        this.X = this.setNZ(this.read(this.fetch16()));
        break;

      case 235:
        this.Y = this.setNZ(this.readDP(this.fetch()));
        break;

      case 251:
        this.Y = this.setNZ(this.readDP(this.fetch() + this.X));
        break;

      case 236:
        this.Y = this.setNZ(this.read(this.fetch16()));
        break;

      case 196:
        this.writeDP(this.fetch(), this.A);
        break;

      case 197:
        this.write(this.fetch16(), this.A);
        break;

      case 198:
        this.writeDP(this.X, this.A);
        break;

      case 199:
        this.write(this.readDP16(this.fetch() + this.X), this.A);
        break;

      case 212:
        this.writeDP(this.fetch() + this.X, this.A);
        break;

      case 213:
        this.write(this.fetch16() + this.X, this.A);
        break;

      case 214:
        this.write(this.fetch16() + this.Y, this.A);
        break;

      case 215:
        this.write(this.readDP16(this.fetch()) + this.Y, this.A);
        break;

      case 175:
        this.writeDP(this.X, this.A);
        this.X = (this.X + 1) & 255;
        break;

      case 216:
        this.writeDP(this.fetch(), this.X);
        break;

      case 217:
        this.writeDP(this.fetch() + this.Y, this.X);
        break;

      case 201:
        this.write(this.fetch16(), this.X);
        break;

      case 203:
        this.writeDP(this.fetch(), this.Y);
        break;

      case 219:
        this.writeDP(this.fetch() + this.X, this.Y);
        break;

      case 204:
        this.write(this.fetch16(), this.Y);
        break;

      case 143: {
        const v = this.fetch();
        this.writeDP(this.fetch(), v);
        break;
      }

      case 250: {
        const src = this.fetch();
        const v = this.readDP(src);
        this.writeDP(this.fetch(), v);
        break;
      }

      case 125:
        this.A = this.setNZ(this.X);
        break;

      case 221:
        this.A = this.setNZ(this.Y);
        break;

      case 93:
        this.X = this.setNZ(this.A);
        break;

      case 253:
        this.Y = this.setNZ(this.A);
        break;

      case 157:
        this.X = this.setNZ(this.SP);
        break;

      case 189:
        this.SP = this.X;
        break;

      case 45:
        this.push(this.A);
        break;

      case 77:
        this.push(this.X);
        break;

      case 109:
        this.push(this.Y);
        break;

      case 13:
        this.push(this.PSW);
        break;

      case 174:
        this.A = this.pop();
        break;

      case 206:
        this.X = this.pop();
        break;

      case 238:
        this.Y = this.pop();
        break;

      case 142:
        this.PSW = this.pop();
        break;

      case 16:
        this.branch(this.fN === 0);
        break;

      case 48:
        this.branch(this.fN === 1);
        break;

      case 80:
        this.branch(this.fV === 0);
        break;

      case 112:
        this.branch(this.fV === 1);
        break;

      case 144:
        this.branch(this.fC === 0);
        break;

      case 176:
        this.branch(this.fC === 1);
        break;

      case 208:
        this.branch(this.fZ === 0);
        break;

      case 240:
        this.branch(this.fZ === 1);
        break;

      case 47:
        this.branch(true);
        break;

      case 3:
      case 35:
      case 67:
      case 99:
      case 131:
      case 163:
      case 195:
      case 227:
        this.branchBit(true);
        break;

      case 19:
      case 51:
      case 83:
      case 115:
      case 147:
      case 179:
      case 211:
      case 243:
        this.branchBit(false);
        break;

      case 46: {
        const v = this.readDP(this.fetch());
        this.branch(this.A !== v);
        break;
      }

      case 222: {
        const v = this.readDP(this.fetch() + this.X);
        this.branch(this.A !== v);
        break;
      }

      case 110: {
        const d = this.fetch();
        const v = (this.readDP(d) - 1) & 255;
        this.writeDP(d, v);
        this.branch(v !== 0);
        break;
      }

      case 254:
        this.Y = (this.Y - 1) & 255;
        this.branch(this.Y !== 0);
        break;

      case 95:
        this.PC = this.fetch16();
        break;

      case 31:
        this.PC = this.read16((this.fetch16() + this.X) & 65535);
        break;

      case 63: {
        const a = this.fetch16();
        this.push16(this.PC);
        this.PC = a;
        break;
      }

      case 79: {
        const u = this.fetch();
        this.push16(this.PC);
        this.PC = 65280 | u;
        break;
      }

      case 111:
        this.PC = this.pop16();
        break;

      case 127:
        this.PSW = this.pop();
        this.PC = this.pop16();
        break;

      case 1:
      case 17:
      case 33:
      case 49:
      case 65:
      case 81:
      case 97:
      case 113:
      case 129:
      case 145:
      case 161:
      case 177:
      case 193:
      case 209:
      case 225:
      case 241: {
        const n = op >> 4;
        this.push16(this.PC);
        this.PC = this.read16(65502 - n * 2);
        break;
      }

      case 15:
        this.push16(this.PC);
        this.push(this.PSW);
        this.fB = 1;
        this.fI = 0;
        this.PC = this.read16(65502);
        break;

      case 2:
      case 34:
      case 66:
      case 98:
      case 130:
      case 162:
      case 194:
      case 226: {
        const d = this.fetch();
        this.writeDP(d, this.readDP(d) | (1 << (op >> 5)));
        break;
      }

      case 18:
      case 50:
      case 82:
      case 114:
      case 146:
      case 178:
      case 210:
      case 242: {
        const d = this.fetch();
        this.writeDP(d, this.readDP(d) & ~(1 << (op >> 5)));
        break;
      }

      case 10: {
        const { addr: addr, bit: bit } = this.bitOperand();
        this.fC |= (this.read(addr) >> bit) & 1;
        break;
      }

      case 42: {
        const { addr: addr, bit: bit } = this.bitOperand();
        this.fC |= ~(this.read(addr) >> bit) & 1;
        break;
      }

      case 74: {
        const { addr: addr, bit: bit } = this.bitOperand();
        this.fC &= (this.read(addr) >> bit) & 1;
        break;
      }

      case 106: {
        const { addr: addr, bit: bit } = this.bitOperand();
        this.fC &= ~(this.read(addr) >> bit) & 1;
        break;
      }

      case 138: {
        const { addr: addr, bit: bit } = this.bitOperand();
        this.fC ^= (this.read(addr) >> bit) & 1;
        break;
      }

      case 170: {
        const { addr: addr, bit: bit } = this.bitOperand();
        this.fC = (this.read(addr) >> bit) & 1;
        break;
      }

      case 202: {
        const { addr: addr, bit: bit } = this.bitOperand();
        const v = this.read(addr);
        this.write(addr, this.fC ? v | (1 << bit) : v & ~(1 << bit));
        break;
      }

      case 234: {
        const { addr: addr, bit: bit } = this.bitOperand();
        this.write(addr, this.read(addr) ^ (1 << bit));
        break;
      }

      case 14: {
        const a = this.fetch16();
        const v = this.read(a);
        this.setNZ(this.A - v);
        this.write(a, v | this.A);
        break;
      }

      case 78: {
        const a = this.fetch16();
        const v = this.read(a);
        this.setNZ(this.A - v);
        this.write(a, v & ~this.A);
        break;
      }

      case 32:
        this.fP = 0;
        break;

      case 64:
        this.fP = 1;
        break;

      case 96:
        this.fC = 0;
        break;

      case 128:
        this.fC = 1;
        break;

      case 160:
        this.fI = 1;
        break;

      case 192:
        this.fI = 0;
        break;

      case 224:
        this.fV = 0;
        this.fH = 0;
        break;

      case 237:
        this.fC ^= 1;
        break;

      case 0:
        break;

      case 159:
        this.A = this.setNZ((this.A >> 4) | (this.A << 4));
        break;

      case 207: {
        const r = this.Y * this.A;
        this.A = r & 255;
        this.Y = (r >> 8) & 255;
        this.setNZ(this.Y);
        break;
      }

      case 158:
        this.divide();
        break;

      case 223:
        this.daa();
        break;

      case 190:
        this.das();
        break;

      case 239:
      case 255:
        this.halted = true;
        break;

      default:
        throw new Error(`unimplemented SPC700 opcode $${op.toString(16)}`);
    }
    return this.lastCycles;
  }
  dpDP(fn) {
    const src = this.readDP(this.fetch());
    const d = this.fetch();
    this.writeDP(d, fn(src, this.readDP(d)));
  }
  dpImm(fn) {
    const imm = this.fetch();
    const d = this.fetch();
    this.writeDP(d, fn(imm, this.readDP(d)));
  }
  xy(fn) {
    const y = this.readDP(this.Y);
    const x = this.readDP(this.X);
    this.writeDP(this.X, fn(x, y));
  }
  dpDPCmp() {
    const src = this.readDP(this.fetch());
    const dst = this.readDP(this.fetch());
    this.cmp(dst, src);
  }
  dpImmCmp() {
    const imm = this.fetch();
    const dst = this.readDP(this.fetch());
    this.cmp(dst, imm);
  }
  rmw(fn, addr) {
    this.write(addr, fn(this.read(addr)));
  }
  rmwDP(fn, offset) {
    this.writeDP(offset, fn(this.readDP(offset)));
  }
  divide() {
    const ya = this.YA;
    this.fH = (this.X & 15) <= (this.Y & 15) ? 1 : 0;
    this.fV = this.Y >= this.X ? 1 : 0;
    if (this.X === 0) {
      this.A = 255;
      this.Y = 255;
    } else if (this.Y < this.X << 1) {
      this.A = (ya / this.X) | 0;
      this.Y = ya % this.X;
    } else {
      const t = ya - (this.X << 9);
      this.A = 255 - ((t / (256 - this.X)) | 0);
      this.Y = this.X + (t % (256 - this.X));
    }
    this.A &= 255;
    this.Y &= 255;
    this.setNZ(this.A);
  }
  daa() {
    if (this.fC || this.A > 153) {
      this.A += 96;
      this.fC = 1;
    }
    if (this.fH || (this.A & 15) > 9) {
      this.A += 6;
    }
    this.A = this.setNZ(this.A);
  }
  das() {
    if (!this.fC || this.A > 153) {
      this.A -= 96;
      this.fC = 0;
    }
    if (!this.fH || (this.A & 15) > 9) {
      this.A -= 6;
    }
    this.A = this.setNZ(this.A & 255);
  }
}
