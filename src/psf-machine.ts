import type { PsfBundle, PsfEntry } from './contracts.js';
import { check, FormatError } from './binary.js';
import { MipsCpu } from './mips-cpu.js';
import { PlaystationSpu } from './playstation-spu.js';
import { PsxBios } from './psf-bios.js';

interface PsxTimer {
  value: number;
  mode: number;
  target: number;
  cycle: number;
  remainder: number;
  fired: boolean;
}

export class PsxMachine {
  ram: Uint8Array;
  ramView: DataView;
  scratch: Uint8Array;
  scratchView: DataView;
  io: DataView;
  cycles: number;
  sampleCycle: number;
  interruptStatus: number;
  interruptMask: number;
  dmaInterrupt: number;
  vblankCycle: number;
  timers: PsxTimer[];
  spu: PlaystationSpu;
  cpu: MipsCpu;
  bios: PsxBios;
  constructor(bundle: PsfBundle) {
    check(
      bundle?.format === 'PSF' &&
        Array.isArray(bundle.programs) &&
        bundle.programs.length > 0,
      'PSF_EXECUTABLE',
    );
    this.ram = new Uint8Array(0x200000);
    this.ramView = new DataView(this.ram.buffer);
    this.scratch = new Uint8Array(1024);
    this.scratchView = new DataView(this.scratch.buffer);
    this.io = new DataView(new ArrayBuffer(8192));
    this.cycles = 0;
    this.sampleCycle = 0;
    this.interruptStatus = 0;
    this.interruptMask = 0;
    this.dmaInterrupt = 0;
    this.vblankCycle = 0;
    this.timers = Array.from({ length: 3 }, () => ({
      value: 0,
      mode: 0,
      target: 0,
      cycle: 0,
      remainder: 0,
      fired: false,
    }));
    this.spu = new PlaystationSpu({ onIrq: () => this.raiseIrq(9) });
    this.cpu = new MipsCpu(this);
    this.bios = new PsxBios(this);
    let entry: PsfEntry | null = null;
    for (const program of bundle.programs) {
      const bytes = program.bytes;
      check(
        bytes instanceof Uint8Array &&
          bytes.length >= 0x800 &&
          new TextDecoder().decode(bytes.subarray(0, 8)) === 'PS-X EXE',
        'PSF_EXECUTABLE',
        program.name || 'PS-X EXE header',
      );
      const header = new DataView(
        bytes.buffer,
        bytes.byteOffset,
        bytes.byteLength,
      );
      const address = header.getUint32(0x18, true) & 0x1fffffff;
      const size = bytes.length - 0x800;
      check(
        address < this.ram.length && size <= this.ram.length - address,
        'PSF_EXECUTABLE',
        'PS-X EXE load range',
      );
      this.ram.set(bytes.subarray(0x800, 0x800 + size), address);
      if (!entry)
        entry = {
          pc: header.getUint32(0x10, true),
          gp: header.getUint32(0x14, true),
          sp:
            (header.getUint32(0x30, true) + header.getUint32(0x34, true)) >>> 0,
        };
    }
    entry = bundle.entry || entry;
    check(
      entry !== null &&
        Number.isInteger(entry.pc) &&
        !(entry.pc & 3) &&
        (entry.pc & 0x1fffffff) !== 0 &&
        (entry.pc & 0x1fffffff) < this.ram.length,
      'PSF_EXECUTABLE',
      'PS-X EXE entry',
    );
    this.cpu.resetPC(entry.pc);
    this.cpu.registers[28] = entry.gp || 0;
    this.cpu.registers[29] = entry.sp || 0x801fff00;
    this.cpu.registers[30] = this.cpu.registers[29];
    this.cpu.cop0[12] = 0x401;
  }

  memoryError(address: number): never {
    throw new FormatError(
      'PSF_DRIVER',
      `Unmapped PlayStation address ${(address >>> 0).toString(16)}`,
    );
  }

  supportedIo(address: number) {
    const offset = address & 0xffff;
    if (
      (offset >= 0x1000 && offset < 0x1024) ||
      (offset >= 0x1040 && offset < 0x1068) ||
      (offset >= 0x1070 && offset < 0x1100) ||
      (offset >= 0x1810 && offset < 0x1818) ||
      (offset >= 0x2000 && offset < 0x2080)
    )
      return;
    throw new FormatError(
      'PSF_SERVICE',
      `PlayStation hardware register ${(address >>> 0).toString(16)}`,
    );
  }

  read8(address: number): number {
    const physical = address & 0x1fffffff;
    if (physical < 0x800000) return this.ram[physical & 0x1fffff];
    if (physical >= 0x1f800000 && physical < 0x1f800400)
      return this.scratch[physical & 1023];
    if (physical >= 0x1f801000 && physical < 0x1f803000)
      return (this.read16(physical & ~1) >>> ((physical & 1) * 8)) & 255;
    this.memoryError(address);
  }

  read16(address: number): number {
    const physical = address & 0x1fffffff;
    if (physical < 0x800000)
      return this.ramView.getUint16(physical & 0x1ffffe, true);
    if (physical >= 0x1f800000 && physical < 0x1f800400)
      return this.scratchView.getUint16(physical & 1022, true);
    if (physical >= 0x1f801c00 && physical < 0x1f802000)
      return this.spu.read16(physical);
    if (physical === 0x1f801070) return this.interruptStatus;
    if (physical === 0x1f801074) return this.interruptMask;
    if (physical >= 0x1f801100 && physical < 0x1f801130)
      return this.readTimer(physical);
    if (physical === 0x1f801814) return 0x2000;
    if (physical === 0x1f8010f4) return this.dmaInterrupt & 65535;
    if (physical === 0x1f8010f6) return this.dmaInterrupt >>> 16;
    if (physical === 0x1f801044) return 5;
    if (physical >= 0x1f801000 && physical < 0x1f803000) {
      this.supportedIo(physical);
      return this.io.getUint16(physical & 0x1ffe, true);
    }
    if (physical === 0x1ffe0130) return 0;
    this.memoryError(address);
  }

  read32(address: number): number {
    const physical = address & 0x1fffffff;
    if (physical < 0x800000)
      return this.ramView.getInt32(physical & 0x1ffffc, true);
    if (physical >= 0x1f800000 && physical < 0x1f800400)
      return this.scratchView.getInt32(physical & 1020, true);
    if (physical === 0x1f8010f4) return this.dmaInterrupt;
    if (physical === 0x1f801814) return 0x14802000;
    if (physical === 0x1ffe0130) return 0;
    if (physical >= 0x1f801000 && physical < 0x1f803000)
      return this.read16(physical) | (this.read16(physical + 2) << 16) | 0;
    this.memoryError(address);
  }

  write8(address: number, value: number) {
    const physical = address & 0x1fffffff;
    if (physical < 0x800000) {
      this.ram[physical & 0x1fffff] = value;
      return;
    }
    if (physical >= 0x1f800000 && physical < 0x1f800400) {
      this.scratch[physical & 1023] = value;
      return;
    }
    if (physical >= 0x1f801000 && physical < 0x1f803000) {
      const aligned = physical & ~1;
      const shift = (physical & 1) * 8;
      this.write16(
        aligned,
        (this.read16(aligned) & ~(255 << shift)) | ((value & 255) << shift),
      );
      return;
    }
    this.memoryError(address);
  }

  write16(address: number, value: number) {
    const physical = address & 0x1fffffff;
    if (physical < 0x800000) {
      this.ramView.setUint16(physical & 0x1ffffe, value, true);
      return;
    }
    if (physical >= 0x1f800000 && physical < 0x1f800400) {
      this.scratchView.setUint16(physical & 1022, value, true);
      return;
    }
    if (physical >= 0x1f801c00 && physical < 0x1f802000) {
      this.spu.write16(physical, value);
      return;
    }
    if (physical === 0x1f801070) {
      this.interruptStatus &= value;
      return;
    }
    if (physical === 0x1f801074) {
      this.interruptMask = value & 0x7ff;
      return;
    }
    if (physical >= 0x1f801100 && physical < 0x1f801130) {
      this.writeTimer(physical, value);
      return;
    }
    if (physical >= 0x1f801000 && physical < 0x1f803000) {
      this.supportedIo(physical);
      this.io.setUint16(physical & 0x1ffe, value, true);
      if (
        physical >= 0x1f801080 &&
        physical < 0x1f8010f0 &&
        (physical & 15) === 10 &&
        value & 0x100
      )
        this.dma(
          (physical - 0x1f801080) >>> 4,
          this.io.getUint32((physical - 2) & 0x1ffc, true),
        );
      return;
    }
    if (physical === 0x1ffe0130) return;
    this.memoryError(address);
  }

  write32(address: number, value: number) {
    const physical = address & 0x1fffffff;
    if (physical < 0x800000) {
      this.ramView.setInt32(physical & 0x1ffffc, value, true);
      return;
    }
    if (physical >= 0x1f800000 && physical < 0x1f800400) {
      this.scratchView.setInt32(physical & 1020, value, true);
      return;
    }
    if (physical === 0x1f8010f4) {
      this.dmaInterrupt =
        (this.dmaInterrupt & 0x7f000000 & ~(value & 0x7f000000)) |
        (value & 0xffffff);
      this.updateDmaIrq();
      return;
    }
    if (
      physical >= 0x1f801080 &&
      physical < 0x1f8010f0 &&
      (physical & 15) === 8
    ) {
      this.io.setInt32(physical & 0x1ffc, value, true);
      if (value & 0x01000000) this.dma((physical - 0x1f801080) >>> 4, value);
      return;
    }
    if (physical === 0x1ffe0130) return;
    if (physical >= 0x1f801000 && physical < 0x1f803000) {
      this.write16(physical, value);
      this.write16(physical + 2, value >>> 16);
      return;
    }
    this.memoryError(address);
  }

  dma(channel: number, control: number) {
    const base = 0x1080 + channel * 16;
    const address = this.io.getUint32(base, true) & 0x1ffffc;
    const blocks = this.io.getUint32(base + 4, true);
    const words =
      (blocks & 65535) * (((control >>> 9) & 3) === 1 ? blocks >>> 16 || 1 : 1);
    check(words <= 0x80000, 'PSF_DRIVER', 'PlayStation DMA transfer range');
    if (channel === 4)
      this.spu.transfer(this, address, words * 4, !!(control & 1));
    else if (channel === 6) {
      for (let index = 0; index < words; index++)
        this.write32(
          (address - index * 4) & 0x1ffffc,
          index + 1 === words
            ? 0xffffff
            : (address - (index + 1) * 4) & 0x1ffffc,
        );
    } else
      throw new FormatError(
        'PSF_SERVICE',
        `PlayStation DMA channel ${channel}`,
      );
    this.io.setUint32(base + 8, control & ~0x11000000, true);
    this.io.setUint32(base, (address + words * 4) & 0x1fffff, true);
    this.dmaInterrupt |= 1 << (24 + channel);
    this.updateDmaIrq();
    this.bios.deliverEvent(0xf0000009, 0x1000);
  }

  updateDmaIrq() {
    const enabled = (this.dmaInterrupt >>> 16) & 127;
    const flags = (this.dmaInterrupt >>> 24) & 127;
    if (
      this.dmaInterrupt & 0x8000 ||
      (this.dmaInterrupt & 0x800000 && enabled & flags)
    ) {
      this.dmaInterrupt |= 0x80000000;
      this.raiseIrq(3);
    } else this.dmaInterrupt &= 0x7fffffff;
  }

  raiseIrq(line: number) {
    this.interruptStatus |= 1 << line;
  }

  updateTimers() {
    for (let index = 0; index < 3; index++) {
      const timer = this.timers[index];
      const elapsed = this.cycles - timer.cycle;
      timer.cycle = this.cycles;
      const syncMode = (timer.mode >>> 1) & 3;
      if (timer.mode & 1 && index === 2 && (syncMode === 0 || syncMode === 3))
        continue;
      const divisor =
        index === 2 && timer.mode & 0x200
          ? 8
          : index === 1 && timer.mode & 0x100
            ? 2146
            : index === 0 && timer.mode & 0x100
              ? 5
              : 1;
      const combined = elapsed + timer.remainder;
      const ticks = Math.floor(combined / divisor);
      timer.remainder = combined % divisor;
      if (!ticks) continue;
      const next = timer.value + ticks;
      const period = timer.target + 1;
      const resetAtTarget = !!(timer.mode & 8);
      const targetEvents = resetAtTarget
        ? Math.floor(next / period)
        : Math.floor((next - timer.target) / 65536) -
          Math.floor((timer.value - timer.target) / 65536);
      const overflowEvents = resetAtTarget
        ? period === 65536
          ? targetEvents
          : 0
        : Math.floor(next / 65536);
      const reachedTarget = targetEvents > 0;
      const overflow = overflowEvents > 0;
      if (reachedTarget) timer.mode |= 0x800;
      if (overflow) timer.mode |= 0x1000;
      if ((reachedTarget && timer.mode & 16) || (overflow && timer.mode & 32)) {
        if (!timer.fired || timer.mode & 64) {
          const events =
            timer.mode & 64
              ? (timer.mode & 16 ? targetEvents : 0) +
                (timer.mode & 32 ? overflowEvents : 0) -
                ((timer.mode & 48) === 48 &&
                (resetAtTarget || timer.target === 0)
                  ? Math.min(targetEvents, overflowEvents)
                  : 0)
              : 1;
          const raise =
            !(timer.mode & 128) || !!(timer.mode & 0x400) || events > 1;
          if (timer.mode & 128) timer.mode ^= (events & 1) * 0x400;
          timer.fired = true;
          if (raise) this.raiseIrq(4 + index);
        }
      }
      timer.value = resetAtTarget ? next % period : next & 65535;
    }
    if (this.cycles - this.vblankCycle >= 564480) {
      this.vblankCycle +=
        Math.floor((this.cycles - this.vblankCycle) / 564480) * 564480;
      this.raiseIrq(0);
    }
  }

  readTimer(address: number) {
    this.updateTimers();
    const index = (address - 0x1f801100) >>> 4;
    const timer = this.timers[index];
    switch (address & 15) {
      case 0:
        return timer.value;
      case 4: {
        const mode = timer.mode;
        timer.mode &= ~0x1800;
        return mode;
      }
      case 8:
        return timer.target;
      default:
        return 0;
    }
  }

  writeTimer(address: number, value: number) {
    this.updateTimers();
    const timer = this.timers[(address - 0x1f801100) >>> 4];
    value &= 65535;
    switch (address & 15) {
      case 0:
        timer.value = value;
        break;
      case 4:
        timer.mode = (value & 0x3ff) | 0x400;
        timer.value = 0;
        timer.remainder = 0;
        timer.fired = false;
        break;
      case 8:
        timer.target = value;
        break;
    }
  }

  intercept(cpu: MipsCpu) {
    return (cpu.pc & 0x1fffffff) < 0x10000 && this.bios.intercept(cpu);
  }
  exception(cpu: MipsCpu, code: number) {
    return this.bios.exception(cpu, code);
  }

  render(frames: number) {
    check(
      Number.isSafeInteger(frames) && frames >= 0 && frames <= 16384,
      'INVALID_AUDIO',
    );
    const left = new Float32Array(frames),
      right = new Float32Array(frames);
    for (let frame = 0; frame < frames; frame++) {
      this.sampleCycle += 768;
      this.updateTimers();
      if (this.interruptStatus & this.interruptMask) this.bios.interrupt();
      while (this.cycles < this.sampleCycle) {
        const cpu = this.cpu;
        const physical = cpu.pc & 0x1fffffff;
        const remaining = this.sampleCycle - this.cycles;
        if (
          remaining >= 2 &&
          !cpu.delaySlot &&
          !cpu.loadRegister &&
          !(cpu.pc & 3) &&
          cpu.nextPC === (cpu.pc + 4) >>> 0 &&
          physical >= 0x10000 &&
          physical < 0x7ffffc &&
          this.ramView.getUint32(physical & 0x1ffffc, true) === 0x1000ffff &&
          this.ramView.getUint32((physical + 4) & 0x1ffffc, true) === 0
        ) {
          this.cycles += remaining - (remaining % 2);
          cpu.instructionPC = (cpu.pc + 4) >>> 0;
          cpu.instructionDelay = true;
          cpu.registers[0] = 0;
        } else this.cycles += cpu.step();
      }
      const sample = this.spu.sample();
      left[frame] = sample[0];
      right[frame] = sample[1];
    }
    return [left, right];
  }
}
