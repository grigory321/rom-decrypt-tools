import type { SpuVoice } from './playstation-spu-voice.js';
import { check, FormatError } from './binary.js';
import { PlaystationSpu, type SpuTransferBus } from './playstation-spu.js';

export class Spu2 {
  memory: Uint8Array;
  cores: PlaystationSpu[];
  registers = new Uint16Array(0x400);
  samples = 0;
  constructor(readonly onIrq: (index: number) => void = () => {}) {
    this.memory = new Uint8Array(0x200000);
    this.cores = [0, 1].map(
      (index) =>
        new PlaystationSpu({
          memory: this.memory,
          addressShift: 1,
          onIrq: () => onIrq(index),
        }),
    );
    this.reset();
  }

  reset() {
    this.memory.fill(0);
    this.registers = new Uint16Array(0x400);
    for (const core of this.cores) core.reset(false);
    this.samples = 0;
  }

  address(core: number, offset: number) {
    const base = core * 0x200 + (offset >>> 1);
    return (
      (((this.registers[base] & 15) << 17) | (this.registers[base + 1] << 1)) &
      0x1fffff
    );
  }

  read16(address: number) {
    const offset = address & 0x7fe;
    const id = offset >= 0x400 && offset < 0x760 ? 1 : 0;
    const local = offset - id * 0x400;
    const core = this.cores[id];
    if (offset === 0x7c2)
      return (
        (this.cores[0].status & 64 ? 4 : 0) |
        (this.cores[1].status & 64 ? 8 : 0)
      );
    if (local === 0x344)
      return (core.control & 0x30 ? 0x80 : 0) | (core.status & 0x40);
    if (local === 0x340) return core.ENDX & 65535;
    if (local === 0x342) return core.ENDX >>> 16;
    if (local < 0x180) {
      const voice = core.voices[local >>> 4];
      if ((local & 15) === 10) return voice.rd16(12);
      if ((local & 15) >= 12) return voice.volx(local & 2);
    }
    if (local >= 0x1c0 && local < 0x2e0) {
      const voice = core.voices[Math.floor((local - 0x1c0) / 12)];
      const field = (local - 0x1c0) % 12;
      if (field === 4 || field === 6)
        return field === 4
          ? voice.getRepeatAddress() >>> 17
          : (voice.getRepeatAddress() >>> 1) & 65535;
      if (field === 8 || field === 10)
        return field === 8
          ? voice.getCurrentAddress() >>> 17
          : (voice.getCurrentAddress() >>> 1) & 65535;
    }
    if (local === 0x1ac) {
      const value = core.view.getUint16(core.ramOffset, true);
      core.ramOffset = (core.ramOffset + 2) & 0x1fffff;
      core.checkIrq();
      return value;
    }
    return this.registers[offset >>> 1];
  }

  write16(address: number, value: number) {
    const offset = address & 0x7fe;
    value &= 65535;
    this.registers[offset >>> 1] = value;
    if (
      offset === 0x760 ||
      offset === 0x762 ||
      offset === 0x788 ||
      offset === 0x78a
    ) {
      this.cores[offset >= 0x788 ? 1 : 0].write16(0x1d80 | (offset & 2), value);
      return;
    }
    const id = offset >= 0x400 && offset < 0x760 ? 1 : 0;
    const local = offset - id * 0x400;
    const core = this.cores[id];
    if (local < 0x180) {
      const field = local & 15;
      const mapped = [0, 0, 2, 0, 4, 0, 8, 0, 10, 0, 12][field];
      if (mapped !== undefined) core.voices[local >>> 4].wr16(mapped, value);
      return;
    }
    if (local >= 0x1c0 && local < 0x2e0) {
      const index = Math.floor((local - 0x1c0) / 12);
      const field = (local - 0x1c0) % 12;
      const base = 0x1c0 + index * 12 + (field >= 4 ? 4 : 0);
      if (field < 4) core.voices[index].setStartAddress(this.address(id, base));
      else if (field < 8)
        core.voices[index].setRepeatAddress(this.address(id, base));
      else
        throw new FormatError(
          'PSF2_UNSUPPORTED',
          'SPU2 voice next-address writes',
        );
      return;
    }
    const mask = (
      callback: (voice: SpuVoice, enabled: boolean, index: number) => void,
    ) => {
      const shift = local & 2 ? 16 : 0;
      for (let voice = shift; voice < Math.min(24, shift + 16); voice++)
        callback(core.voices[voice], !!(value & (1 << (voice - shift))), voice);
    };
    if (local === 0x180 || local === 0x182)
      mask((voice, enabled) => voice.modOn(enabled));
    else if (local === 0x184 || local === 0x186)
      mask((voice, enabled) => voice.noiseOn(enabled));
    else if (local === 0x1a0 || local === 0x1a2) {
      const shift = local & 2 ? 16 : 0;
      core.keyOnPending |= value << shift;
      core.keyOnWrittenAt = this.samples;
    } else if (local === 0x1a4 || local === 0x1a6)
      mask((voice, enabled) => {
        if (enabled) voice.keyOff();
      });
    else if (local === 0x19a) {
      core.control = value;
      if (!(value & 64)) core.status &= ~64;
    } else if (local === 0x19c || local === 0x19e)
      core.irqOffset = this.address(id, 0x19c);
    else if (local === 0x1a8 || local === 0x1aa)
      core.ramOffset = this.address(id, 0x1a8);
    else if (local === 0x1ac) {
      core.view.setUint16(core.ramOffset, value, true);
      core.checkIrq();
      core.ramOffset = (core.ramOffset + 2) & 0x1fffff;
    } else if (local === 0x1b0 && value)
      throw new FormatError('PSF2_UNSUPPORTED', 'SPU2 AutoDMA streaming');
    else if (local === 0x340 || local === 0x342)
      core.ENDX &= ~(value << (local & 2 ? 16 : 0));
  }

  transfer(
    id: number,
    bus: SpuTransferBus,
    address: number,
    length: number,
    toSpu: boolean,
  ) {
    check(id === 0 || id === 1, 'PSF2_MEMORY');
    this.cores[id].transfer(bus, address, length, toSpu);
  }

  sample() {
    this.samples++;
    let left = 0;
    let right = 0;
    for (let id = 0; id < 2; id++) {
      const core = this.cores[id];
      const registerBase = id * 0x200;
      const mask = (offset: number) =>
        this.registers[registerBase + (offset >>> 1)] |
        (this.registers[registerBase + (offset >>> 1) + 1] << 16);
      if (
        core.keyOnPending &&
        !(this.samples & 1) &&
        this.samples >= core.keyOnWrittenAt + 2
      ) {
        for (let index = 0; index < 24; index++)
          if (core.keyOnPending & (1 << index)) {
            core.voices[index].keyOn();
            core.ENDX &= ~(1 << index);
          }
        core.keyOnPending = 0;
      }
      const volumeBase = (0x760 + id * 40) >>> 1;
      if (
        core.control & 0x80 &&
        (mask(0x18c) || mask(0x194)) &&
        (this.registers[volumeBase + 2] || this.registers[volumeBase + 3])
      )
        throw new FormatError('PSF2_UNSUPPORTED', 'SPU2 effects processor');
      core.noiseCounter += 4 + ((core.control >>> 8) & 3);
      const period = Math.max(1, 0x8000 >>> ((core.control >>> 10) & 15));
      if (core.noiseCounter >= period) {
        core.noiseCounter %= period;
        const bit =
          ((core.noiseLevel >>> 15) ^
            (core.noiseLevel >>> 12) ^
            (core.noiseLevel >>> 11) ^
            (core.noiseLevel >>> 10) ^
            1) &
          1;
        core.noiseLevel = ((core.noiseLevel << 1) | bit) & 65535;
      }
      let coreLeft = 0;
      let coreRight = 0;
      let previous = 0;
      const audio = [0, 0];
      const leftMask = mask(0x188);
      const rightMask = mask(0x190);
      for (let index = 0; index < 24; index++) {
        const voice = core.voices[index];
        const active = voice.advance(
          this.memory,
          audio,
          previous,
          (core.noiseLevel << 16) >> 16,
        );
        previous = voice.lastVolume;
        if (!active) continue;
        if (leftMask & (1 << index)) coreLeft += audio[0];
        if (rightMask & (1 << index)) coreRight += audio[1];
      }
      if (!(core.control & 0x8000)) continue;
      left += (coreLeft * core.masterVolume[0]) / 0x8000;
      right += (coreRight * core.masterVolume[1]) / 0x8000;
      for (let channel = 0; channel < 2; channel++)
        if (core.masterSweeping[channel])
          core.masterVolume[channel] = core.masterSweeps[channel].tick(
            core.masterVolume[channel],
          );
    }
    return [Math.max(-1, Math.min(1, left)), Math.max(-1, Math.min(1, right))];
  }
}
