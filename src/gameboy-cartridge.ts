import type { ByteSource } from './contracts.js';
import { Bin, bounds, check } from './binary.js';
import { readAudio } from './audio-codecs.js';
import { GameBoyCpu } from './gameboy-cpu.js';
import { GameBoyApu } from './gameboy-apu.js';
import { GameBoyTimer } from './gameboy-timer.js';

export interface GameBoyCartridgeHeader {
  title: string;
  mapper: 'ROM' | 'MBC1' | 'MBC3' | 'MBC5';
  cartridgeType: number;
  colorCompatible: boolean;
  romSize: number;
  ramSize: number;
  checksum: number;
}

export async function readGameBoyCartridgeHeader(
  source: ByteSource,
): Promise<GameBoyCartridgeHeader> {
  bounds(source.size, 0, 0x150);
  check(source.size <= 8 * 1024 ** 2, 'TOO_LARGE');
  const bytes = new Bin(await readAudio(source, 0x100, 0x50));
  let checksum = 0;
  for (let offset = 0x34; offset <= 0x4c; offset++)
    checksum = (checksum - bytes.u8(offset) - 1) & 255;
  check(checksum === bytes.u8(0x4d), 'INVALID_CARTRIDGE');
  const sizeCode = bytes.u8(0x48);
  check(sizeCode <= 8, 'UNSUPPORTED_CODEC', 'Unusual Game Boy ROM size');
  const romSize = 32768 * 2 ** sizeCode;
  check(source.size >= romSize, 'INVALID_CARTRIDGE');
  const colorFlag = bytes.u8(0x43);
  check(
    (colorFlag & 0xc0) !== 0xc0,
    'UNSUPPORTED_CODEC',
    'CGB-only cartridge audio',
  );
  const cartridgeType = bytes.u8(0x47);
  let mapper: GameBoyCartridgeHeader['mapper'];
  if ([0, 8, 9].includes(cartridgeType)) mapper = 'ROM';
  else if ([1, 2, 3].includes(cartridgeType)) mapper = 'MBC1';
  else if ([0x11, 0x12, 0x13].includes(cartridgeType)) mapper = 'MBC3';
  else {
    check(
      cartridgeType >= 0x19 && cartridgeType <= 0x1e,
      'UNSUPPORTED_CODEC',
      'Game Boy cartridge mapper ' + cartridgeType.toString(16),
    );
    mapper = 'MBC5';
  }
  const ramCode = bytes.u8(0x49);
  const sizes = [0, 2048, 8192, 32768, 131072, 65536];
  check(ramCode < sizes.length, 'INVALID_CARTRIDGE');
  const ramSize = [0, 1, 0x11, 0x19, 0x1c].includes(cartridgeType)
    ? 0
    : sizes[ramCode];
  check(
    (mapper !== 'ROM' || (romSize === 32768 && ramSize <= 8192)) &&
      (!['MBC1', 'MBC3'].includes(mapper) ||
        (romSize <= 2 * 1024 ** 2 && ramSize <= 32768)),
    'UNSUPPORTED_CODEC',
    'Game Boy cartridge banking limits',
  );
  const titleLength = colorFlag & 0x80 ? 11 : 16;
  const title = new TextDecoder('windows-1252')
    .decode(bytes.b.subarray(0x34, 0x34 + titleLength))
    .replace(/\0.*$/, '')
    .trim();
  return {
    title,
    mapper,
    cartridgeType,
    colorCompatible: !!(colorFlag & 0x80),
    romSize,
    ramSize,
    checksum,
  };
}

export class GameBoyCartridge {
  readonly rom: Uint8Array;
  readonly header: GameBoyCartridgeHeader;
  readonly vram = new Uint8Array(8192);
  readonly wram = new Uint8Array(8192);
  readonly sram: Uint8Array;
  readonly oam = new Uint8Array(160);
  readonly io = new Uint8Array(128);
  readonly hram = new Uint8Array(127);
  readonly apu = new GameBoyApu();
  readonly timer: GameBoyTimer;
  readonly cpu: GameBoyCpu;
  ramEnabled = false;
  romBank = 1;
  highBank = 0;
  bankMode = 0;
  ie = 0;
  buttons = 0;
  line = 0;
  dot = 0;
  statLine = false;
  dmaSource = 0;
  dmaIndex = 160;
  dmaTicks = 0;
  serialTicks = 0;

  constructor(rom: Uint8Array, header: GameBoyCartridgeHeader) {
    this.rom = rom;
    this.header = header;
    this.sram = new Uint8Array(header.ramSize);
    this.ramEnabled = header.mapper === 'ROM';
    this.io[0] = 0;
    this.io[2] = 0x7e;
    this.io[0x0f] = 1;
    this.io[0x40] = 0x91;
    this.io[0x47] = 0xfc;
    this.io[0x48] = 0xff;
    this.io[0x49] = 0xff;
    this.timer = new GameBoyTimer(0, 0, false, () => {
      this.io[0x0f] |= 4;
    });
    this.timer.divider = 0xabcc;
    this.apu.write(0xff26, 0x80);
    this.apu.write(0xff10, 0x80);
    this.apu.write(0xff11, 0xbf);
    this.apu.write(0xff12, 0xf3);
    this.apu.write(0xff24, 0x77);
    this.apu.write(0xff25, 0xf3);
    this.apu.frameTimer = 8192 - (this.timer.divider & 8191);
    this.cpu = new GameBoyCpu(
      (address) => this.read(address),
      (address, value) => this.write(address, value),
      true,
      {
        interruptRead: (address) => this.readMapped(address),
        interruptWrite: (_address, value) => {
          this.io[15] = value & 31;
        },
      },
    );
    this.cpu.pc = 0x100;
    this.cpu.sp = 0xfffe;
    this.cpu.r.set([0, 0x13, 0, 0xd8, 1, 0x4d, 0, 1]);
    this.cpu.f = header.checksum ? 0xb0 : 0x80;
  }

  joypad() {
    const select = this.io[0] & 0x30;
    let value = 15;
    if (!(select & 0x10)) value &= ~this.buttons;
    if (!(select & 0x20)) value &= ~(this.buttons >> 4);
    return 0xc0 | select | (value & 15);
  }

  setButtons(mask: number) {
    check(Number.isInteger(mask) && mask >= 0 && mask <= 255, 'INVALID_AUDIO');
    const previous = this.joypad();
    this.buttons = mask;
    if (previous & ~this.joypad() & 15) this.io[0x0f] |= 16;
  }

  mode() {
    if (!(this.io[0x40] & 128)) return 0;
    return this.line >= 144 ? 1 : this.dot < 80 ? 2 : this.dot < 252 ? 3 : 0;
  }

  updateStat() {
    const mode = this.mode();
    const enabled = !!(
      this.io[0x40] & 128 &&
      ((this.line === this.io[0x45] && this.io[0x41] & 0x40) ||
        (mode === 0 && this.io[0x41] & 8) ||
        (mode === 1 && this.io[0x41] & 16) ||
        (mode === 2 && this.io[0x41] & 32))
    );
    if (enabled && !this.statLine) this.io[0x0f] |= 2;
    this.statLine = enabled;
  }

  romOffset(address: number) {
    const banks = this.header.romSize / 16384;
    let bank = address < 0x4000 ? 0 : this.romBank;
    if (this.header.mapper === 'MBC1') {
      if (address < 0x4000) bank = this.bankMode ? this.highBank << 5 : 0;
      else bank = (this.highBank << 5) | (this.romBank || 1);
    }
    return (bank & (banks - 1)) * 16384 + (address & 0x3fff);
  }

  ramOffset(address: number) {
    const bank =
      this.header.mapper === 'MBC1'
        ? this.bankMode
          ? this.highBank
          : 0
        : this.header.mapper === 'MBC3' || this.header.mapper === 'MBC5'
          ? this.highBank
          : 0;
    return (bank * 8192 + (address & 8191)) % this.sram.length;
  }

  ramAccessible() {
    return (
      this.ramEnabled &&
      this.sram.length > 0 &&
      (this.header.mapper !== 'MBC3' || this.highBank <= 3)
    );
  }

  read(address: number) {
    if (this.dmaIndex < 160 && (address < 0xff80 || address === 0xffff))
      return 255;
    if (address >= 0x8000 && address < 0xa000 && this.mode() === 3) return 255;
    if (address >= 0xfe00 && address < 0xfea0 && this.mode() >= 2) return 255;
    return this.readMapped(address);
  }

  readMapped(address: number): number {
    if (address < 0x8000) return this.rom[this.romOffset(address)];
    if (address < 0xa000) return this.vram[address - 0x8000];
    if (address < 0xc000)
      return this.ramAccessible() ? this.sram[this.ramOffset(address)] : 255;
    if (address < 0xfe00) return this.wram[(address - 0xc000) & 8191];
    if (address < 0xfea0) return this.oam[address - 0xfe00];
    if (address < 0xff00) return 255;
    if (address >= 0xff80)
      return address === 0xffff ? this.ie : this.hram[address - 0xff80];
    if (address === 0xff00) return this.joypad();
    if (address >= 0xff04 && address <= 0xff07) return this.timer.read(address);
    if (address === 0xff0f) return this.io[15] | 0xe0;
    if (
      (address >= 0xff10 && address <= 0xff26) ||
      (address >= 0xff30 && address <= 0xff3f)
    )
      return this.apu.read(address);
    if (address === 0xff41)
      return (
        128 |
        this.io[0x41] |
        (this.line === this.io[0x45] ? 4 : 0) |
        this.mode()
      );
    if (address === 0xff44) return this.line;
    if (
      address === 0xff01 ||
      address === 0xff02 ||
      (address >= 0xff40 && address <= 0xff4b)
    )
      return this.io[address & 127];
    return 255;
  }

  writeMapper(address: number, value: number) {
    if (this.header.mapper === 'ROM') return;
    if (address < 0x2000) this.ramEnabled = (value & 15) === 10;
    else if (this.header.mapper === 'MBC1') {
      if (address < 0x4000) this.romBank = value & 31;
      else if (address < 0x6000) this.highBank = value & 3;
      else this.bankMode = value & 1;
    } else if (this.header.mapper === 'MBC3') {
      if (address < 0x4000) this.romBank = value & 127 || 1;
      else if (address < 0x6000) this.highBank = value;
    } else if (address < 0x3000) this.romBank = (this.romBank & 256) | value;
    else if (address < 0x4000)
      this.romBank = (this.romBank & 255) | ((value & 1) << 8);
    else if (address < 0x6000)
      this.highBank = value & (this.header.cartridgeType >= 0x1c ? 7 : 15);
  }

  write(address: number, value: number) {
    value &= 255;
    if (
      this.dmaIndex < 160 &&
      address !== 0xff46 &&
      (address < 0xff80 || address === 0xffff)
    )
      return;
    if (address < 0x8000) return this.writeMapper(address, value);
    if (address < 0xa000) {
      if (this.mode() !== 3) this.vram[address - 0x8000] = value;
    } else if (address < 0xc000) {
      if (this.ramAccessible()) this.sram[this.ramOffset(address)] = value;
    } else if (address < 0xfe00) this.wram[(address - 0xc000) & 8191] = value;
    else if (address < 0xfea0) {
      if (this.mode() < 2) this.oam[address - 0xfe00] = value;
    } else if (address < 0xff00) return;
    else if (address >= 0xff80) {
      if (address === 0xffff) this.ie = value;
      else this.hram[address - 0xff80] = value;
    } else if (address === 0xff00) {
      const previous = this.joypad();
      this.io[0] = value & 0x30;
      if (previous & ~this.joypad() & 15) this.io[15] |= 16;
    } else if (address >= 0xff04 && address <= 0xff07) {
      if (address === 0xff04) {
        if (this.timer.divider & 0x1000) this.apu.clockFrame();
        this.apu.frameTimer = 8192;
      }
      this.timer.write(address, value);
    } else if (address === 0xff0f) this.io[15] = value & 31;
    else if (
      (address >= 0xff10 && address <= 0xff26) ||
      (address >= 0xff30 && address <= 0xff3f)
    )
      this.apu.write(address, value);
    else if (address === 0xff40) {
      const changed = (this.io[0x40] ^ value) & 128;
      this.io[0x40] = value;
      if (changed) {
        this.line = 0;
        this.dot = 0;
        this.statLine = false;
      }
      this.updateStat();
    } else if (address === 0xff41) {
      if (
        this.io[0x40] & 128 &&
        (this.mode() !== 3 || this.line === this.io[0x45])
      )
        this.io[15] |= 2;
      this.io[0x41] = value & 0x78;
      this.updateStat();
    } else if (address === 0xff44) return;
    else if (address === 0xff45) {
      this.io[0x45] = value;
      this.updateStat();
    } else if (address === 0xff46) {
      this.io[0x46] = value;
      this.dmaSource = value << 8;
      this.dmaIndex = 0;
      this.dmaTicks = 0;
    } else if (address === 0xff02) {
      this.io[2] = value | 0x7e;
      this.serialTicks = (value & 0x81) === 0x81 ? 4096 : 0;
    } else if (address === 0xff01 || (address >= 0xff42 && address <= 0xff4b))
      this.io[address & 127] = value;
  }

  advance(cycles: number) {
    this.timer.advance(cycles);
    if (this.serialTicks) {
      this.serialTicks = Math.max(0, this.serialTicks - cycles);
      if (!this.serialTicks) {
        this.io[1] = 255;
        this.io[2] &= 127;
        this.io[15] |= 8;
      }
    }
    if (this.dmaIndex < 160) {
      this.dmaTicks += cycles;
      while (this.dmaTicks >= 4 && this.dmaIndex < 160) {
        const source = this.dmaSource + this.dmaIndex;
        this.oam[this.dmaIndex++] =
          source < 0xe000 ? this.readMapped(source) : 255;
        this.dmaTicks -= 4;
      }
    }
    if (!(this.io[0x40] & 128)) return;
    while (cycles > 0) {
      const edge =
        this.line >= 144
          ? 456
          : this.dot < 80
            ? 80
            : this.dot < 252
              ? 252
              : 456;
      const count = Math.min(cycles, edge - this.dot);
      cycles -= count;
      this.dot += count;
      if (this.dot === 456) {
        this.dot = 0;
        this.line = (this.line + 1) % 154;
        if (this.line === 144) this.io[15] |= 1;
      }
      this.updateStat();
    }
  }
}
