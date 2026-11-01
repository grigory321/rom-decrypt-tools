import type {
  AudioDecoder,
  AudioTags,
  ByteSource,
  DecoderOptions,
} from './contracts.js';
import type { GbsHeader } from './gameboy-files.js';
import { check } from './binary.js';
import { readAudio, audioDecoder } from './audio-codecs.js';
import { readGbsHeader } from './gameboy-files.js';
import { GameBoyCpu } from './gameboy-cpu.js';
import { GameBoyApu } from './gameboy-apu.js';
import { GameBoyTimer } from './gameboy-timer.js';

class GbsPlayer {
  readonly rom: Uint8Array;
  readonly header: GbsHeader;
  readonly ram: Uint8Array;
  bank = 1;
  readonly apu: GameBoyApu;
  readonly cpu: GameBoyCpu;
  readonly doubleSpeed: number;
  readonly timer: GameBoyTimer | null;
  readonly checkCancelled: () => void;
  hardwareTicks = 0;
  nextVblank = 65664;
  ticks = 0;
  dividerOffset = 0;
  pending = 0;
  busyTicks = 0;
  nextPlay: number;
  constructor(
    rom: Uint8Array,
    header: GbsHeader,
    song: number,
    checkCancelled: () => void,
  ) {
    checkCancelled();
    this.rom = rom;
    this.header = header;
    this.ram = new Uint8Array(0x8000);
    this.bank = 1;
    this.apu = new GameBoyApu();
    this.apu.write(0xff26, 0x80);
    this.apu.write(0xff24, 0x77);
    this.apu.write(0xff25, 0xf3);
    this.cpu = new GameBoyCpu(
      (address) => this.read(address),
      (address, value) => this.write(address, value),
      !!(header.timer & 0x40),
    );
    this.doubleSpeed = header.timer & 128 ? 2 : 1;
    this.checkCancelled = checkCancelled;
    this.timer =
      header.timer & 0x40
        ? new GameBoyTimer(
            header.modulo,
            header.timer,
            this.doubleSpeed === 2,
            () => {
              this.ram[0x7f0f] |= 4;
            },
          )
        : null;
    this.ticks = 0;
    this.dividerOffset = 0;
    this.pending = 0;
    this.busyTicks = 0;
    this.ram[0x7f06] = header.modulo;
    this.ram[0x7f07] = header.timer & 7;
    if (this.timer) this.ram[0x7fff] = 5;
    this.cpu.sp = header.stack;
    this.cpu.r[7] = song;
    this.call(header.init);
    let cycles = 0;
    let cancellationCycles = 0;
    while (this.cpu.pc !== 0xffff) {
      check(cycles < 4194304 && (!this.cpu.halted || this.timer), 'GBS_DRIVER');
      const elapsed = this.cpu.step();
      cycles += elapsed;
      if (cycles >= cancellationCycles) {
        checkCancelled();
        cancellationCycles = cycles + 16384;
      }
      this.advanceHardware(elapsed);
      this.ticks += elapsed / this.doubleSpeed;
      this.apu.advance(elapsed / this.doubleSpeed);
    }
    this.apu.sample();
    this.nextPlay = this.ticks + this.interval();
    if (this.timer) {
      this.cpu.pc = 0x100;
      this.cpu.ime = true;
      this.cpu.imeDelay = 0;
      this.cpu.halted = false;
      this.cpu.haltBug = false;
    }
  }

  read(address: number) {
    if (address < 0x4000) return this.rom[address] ?? 255;
    if (address < 0x8000)
      return this.rom[this.bank * 0x4000 + address - 0x4000] ?? 255;
    if (address >= 0xff10 && address <= 0xff3f) return this.apu.read(address);
    if (this.timer && address >= 0xff04 && address <= 0xff07)
      return this.timer.read(address);
    if (this.timer && address === 0xff0f) return this.ram[0x7f0f] | 0xe0;
    if (address === 0xff04)
      return ((this.ticks * this.doubleSpeed + this.dividerOffset) >> 8) & 255;
    if (address === 0xff44)
      return (
        Math.floor((this.timer ? this.hardwareTicks : this.ticks) / 456) % 154
      );
    if (address === 0xff00) return 255;
    const mapped =
      address >= 0xe000 && address < 0xfe00 ? address - 0x2000 : address;
    return this.ram[mapped - 0x8000];
  }

  write(address: number, value: number) {
    value &= 255;
    if (address < 0x8000) {
      if (address >= 0x2000 && address < 0x4000) this.bank = value || 1;
      return;
    }
    if (address >= 0xff10 && address <= 0xff3f) this.apu.write(address, value);
    else if (address === 0xff04) {
      const divider =
        this.timer?.divider ??
        this.ticks * this.doubleSpeed + this.dividerOffset;
      if (divider & (this.doubleSpeed === 2 ? 0x2000 : 0x1000))
        this.apu.clockFrame();
      this.apu.frameTimer = 8192;
      this.dividerOffset = -this.ticks * this.doubleSpeed;
      this.timer?.write(address, value);
    } else if (this.timer && address >= 0xff05 && address <= 0xff07) {
      this.timer.write(address, value);
    } else {
      const mapped =
        address >= 0xe000 && address < 0xfe00 ? address - 0x2000 : address;
      this.ram[mapped - 0x8000] = value;
    }
  }

  interval() {
    const control = this.ram[0x7f07];
    return control & 4
      ? ((256 - this.ram[0x7f06]) * [1024, 16, 64, 256][control & 3]) /
          this.doubleSpeed
      : 70224;
  }

  call(address: number) {
    this.cpu.push(0xffff);
    this.cpu.pc = address;
    this.cpu.halted = false;
    this.busyTicks = 0;
  }

  advanceHardware(cycles: number) {
    if (!this.timer) return;
    this.timer.advance(cycles);
    this.hardwareTicks += cycles / this.doubleSpeed;
    if (this.hardwareTicks >= this.nextVblank) {
      this.ram[0x7f0f] |= 1;
      this.nextVblank += 70224;
    }
  }

  renderInterrupts(frames: number, sampleRate: number) {
    const left = new Float32Array(frames);
    const right = new Float32Array(frames);
    const sampleCycles = 4194304 / sampleRate;
    for (let frame = 0; frame < frames; frame++) {
      this.checkCancelled();
      let remaining = sampleCycles;
      while (remaining > 1e-8) {
        if (this.pending <= 1e-8) {
          const idle = this.cpu.pc === 0x100 || this.cpu.halted;
          const cycles = this.cpu.step();
          this.pending = cycles / this.doubleSpeed;
          this.busyTicks =
            idle || this.cpu.interruptReturned
              ? 0
              : this.busyTicks + this.pending;
          check(this.busyTicks <= 4194304, 'GBS_DRIVER');
          this.advanceHardware(cycles);
        }
        const count = Math.min(remaining, this.pending);
        this.apu.advance(count);
        this.ticks += count;
        remaining -= count;
        this.pending = Math.max(0, this.pending - count);
      }
      this.apu.sample();
      left[frame] = this.apu.sampleLeft;
      right[frame] = this.apu.sampleRight;
    }
    return [left, right];
  }

  render(frames: number, sampleRate: number) {
    this.checkCancelled();
    if (this.timer) return this.renderInterrupts(frames, sampleRate);
    const left = new Float32Array(frames);
    const right = new Float32Array(frames);
    const sampleCycles = 4194304 / sampleRate;
    for (let frame = 0; frame < frames; frame++) {
      this.checkCancelled();
      let remaining = sampleCycles;
      while (remaining > 1e-8) {
        if (this.ticks >= this.nextPlay - 1e-8) {
          if (this.cpu.pc === 0xffff || this.cpu.halted)
            this.call(this.header.play);
          this.nextPlay += this.interval();
        }
        if (this.pending <= 1e-8 && this.cpu.pc !== 0xffff) {
          this.pending = this.cpu.step() / this.doubleSpeed;
          this.busyTicks += this.pending;
          check(this.busyTicks <= 4194304, 'GBS_DRIVER');
        }
        const count = Math.min(
          remaining,
          this.nextPlay - this.ticks,
          this.pending > 1e-8 ? this.pending : Infinity,
        );
        this.apu.advance(count);
        this.ticks += count;
        remaining -= count;
        this.pending = Math.max(0, this.pending - count);
      }
      this.apu.sample();
      left[frame] = this.apu.sampleLeft;
      right[frame] = this.apu.sampleRight;
    }
    return [left, right];
  }
}

export async function createGameBoyDecoder(
  source: ByteSource,
  options: DecoderOptions = {},
): Promise<AudioDecoder> {
  const checkCancelled = () =>
    check(
      !options.signal?.aborted &&
        !options.cancelled?.() &&
        !options.isCancelled?.(),
      'CANCELLED',
    );
  checkCancelled();
  const header = await readGbsHeader(source);
  const song = options.song ?? header.firstSong;
  check(
    Number.isInteger(song) && song >= 0 && song < header.songs,
    'INVALID_AUDIO',
  );
  const sampleRate = options.sampleRate || 32768;
  check(
    Number.isInteger(sampleRate) && sampleRate >= 8000 && sampleRate <= 96000,
    'INVALID_AUDIO',
  );
  const rom = new Uint8Array(
    Math.ceil((header.load + source.size - 0x70) / 0x4000) * 0x4000,
  );
  for (let offset = 0x70; offset < source.size; offset += 65536) {
    checkCancelled();
    rom.set(
      await readAudio(source, offset, Math.min(65536, source.size - offset)),
      header.load + offset - 0x70,
    );
  }
  for (let vector = 0; vector <= 0x38; vector += 8)
    rom.set(
      [0xc3, (header.load + vector) & 255, (header.load + vector) >> 8],
      vector,
    );
  if (header.timer & 0x40) {
    rom.set([0x76, 0x18, 0xfd], 0x100);
    rom.set(
      [
        0xcd,
        (header.load + 0x40) & 255,
        (header.load + 0x40) >> 8,
        0xcd,
        header.play & 255,
        header.play >> 8,
        0xd9,
      ],
      0x40,
    );
    rom.set(
      [0xcd, (header.load + 0x48) & 255, (header.load + 0x48) >> 8, 0xd9],
      0x50,
    );
    for (const vector of [0x48, 0x58, 0x60]) rom[vector] = 0xd9;
  }
  let player = new GbsPlayer(rom, header, song, checkCancelled);
  const reset = () => {
    player = new GbsPlayer(rom, header, song, checkCancelled);
  };
  const tags: AudioTags & GbsHeader & { song: number } = { ...header, song };
  return audioDecoder(
    {
      channels: 2,
      sampleRate,
      length: null,
      loop: false,
      tags,
    },
    (count) => player.render(count, sampleRate),
    reset,
  );
}
