import { check } from './binary.js';
import {
  createSpuEnvelope,
  type SpuEnvelope,
} from './playstation-spu-envelope.js';
import { createSpuVoice, type SpuVoice } from './playstation-spu-voice.js';
import { createSpuReverb, type SpuReverb } from './playstation-spu-reverb.js';

export interface SpuTransferBus {
  read16(address: number): number;
  write16(address: number, value: number): void;
}

export interface PlaystationSpuOptions {
  onIrq?: () => void;
  memory?: Uint8Array;
  addressShift?: number;
}

export class PlaystationSpu {
  onIrq: () => void;
  memory: Uint8Array;
  addressShift: number;
  addressMask: number;
  view: DataView;
  registers = new Uint16Array(512);
  ramOffset = 0;
  irqOffset = 0;
  control = 0;
  status = 0;
  ENDX = 0xffffff;
  samples = 0;
  keyOnPending = 0;
  keyOnWrittenAt = 0;
  voices: SpuVoice[] = [];
  reverb: SpuReverb = createSpuReverb();
  masterVolume = [0, 0];
  masterSweeps: SpuEnvelope[] = [createSpuEnvelope(), createSpuEnvelope()];
  masterSweeping = [false, false];
  noiseLevel = 1;
  noiseCounter = 0;
  constructor(options: PlaystationSpuOptions = {}) {
    this.onIrq = options.onIrq || (() => {});
    this.memory = options.memory || new Uint8Array(512 * 1024);
    check(
      this.memory instanceof Uint8Array &&
        this.memory.length >= 512 * 1024 &&
        (this.memory.length & (this.memory.length - 1)) === 0,
      'PSF_DRIVER',
    );
    this.addressShift = options.addressShift ?? 3;
    this.addressMask = this.memory.length - 1;
    this.view = new DataView(this.memory.buffer);
    this.reset();
  }

  reset(clearMemory = true) {
    if (clearMemory) this.memory.fill(0);
    this.registers = new Uint16Array(512);
    this.ramOffset = 0;
    this.irqOffset = 0;
    this.control = 0;
    this.status = 0;
    this.ENDX = 0xffffff;
    this.samples = 0;
    this.keyOnPending = 0;
    this.keyOnWrittenAt = 0;
    this.voices = [];
    for (let index = 0; index < 24; index++)
      this.voices.push(createSpuVoice(this).setId(index));
    this.reverb = createSpuReverb();
    for (let address = 0x1dc0; address < 0x1e00; address += 2)
      this.reverb.wr16(address, 0);
    this.reverb.wr16(0x1d84, 0);
    this.reverb.wr16(0x1d86, 0);
    this.reverb.wr16(0x1da2, 0);
    this.masterVolume = [0, 0];
    this.masterSweeps = [createSpuEnvelope(), createSpuEnvelope()];
    this.masterSweeping = [false, false];
    this.noiseLevel = 1;
    this.noiseCounter = 0;
  }

  read16(address: number) {
    address = address & 0x1fff;
    if (address >= 0x1c00 && address < 0x1d80)
      return this.voices[(address - 0x1c00) >>> 4].rd16(address & 15);
    if (address >= 0x1dc0 && address < 0x1e00) return this.reverb.rd16(address);
    if (address >= 0x1e00 && address < 0x1e60)
      return this.voices[(address - 0x1e00) >>> 2].volx(address & 2);
    if (address === 0x1d9c) return this.ENDX & 65535;
    if (address === 0x1d9e) return this.ENDX >>> 16;
    if (address === 0x1daa) return this.control;
    if (address === 0x1dae) return (this.status & ~63) | (this.control & 63);
    if (address === 0x1da8) {
      const value = this.view.getUint16(this.ramOffset, true);
      this.ramOffset = (this.ramOffset + 2) & this.addressMask;
      this.checkIrq();
      return value;
    }
    return this.registers[(address & 0x3ff) >>> 1];
  }

  write16(address: number, value: number) {
    address &= 0x1fff;
    value &= 65535;
    this.registers[(address & 0x3ff) >>> 1] = value;
    if (address >= 0x1c00 && address < 0x1d80) {
      this.voices[(address - 0x1c00) >>> 4].wr16(address & 15, value);
      return;
    }
    if (
      (address >= 0x1dc0 && address < 0x1e00) ||
      address === 0x1d84 ||
      address === 0x1d86 ||
      address === 0x1da2
    ) {
      this.reverb.wr16(address, value);
      return;
    }
    switch (address) {
      case 0x1d80:
      case 0x1d82: {
        const channel = (address & 2) >>> 1;
        this.masterSweeping[channel] = !!(value & 0x8000);
        if (value & 0x8000)
          this.masterSweeps[channel].reset(
            value & 127,
            127,
            !!(value & 0x2000),
            !!(value & 0x4000),
            !!(value & 0x1000),
          );
        else this.masterVolume[channel] = ((value & 0x7fff) << 17) >> 16;
        break;
      }
      case 0x1d88:
        this.keyOnPending = (this.keyOnPending & 0xff0000) | value;
        this.keyOnWrittenAt = this.samples;
        break;
      case 0x1d8a:
        this.keyOnPending = (this.keyOnPending & 65535) | ((value & 255) << 16);
        this.keyOnWrittenAt = this.samples;
        break;
      case 0x1d8c:
      case 0x1d8e:
        this.maskVoices(address, value, (voice, enabled) => {
          if (enabled) voice.keyOff();
        });
        break;
      case 0x1d90:
      case 0x1d92:
        this.maskVoices(address, value, (voice, enabled) =>
          voice.modOn(enabled),
        );
        break;
      case 0x1d94:
      case 0x1d96:
        this.maskVoices(address, value, (voice, enabled) =>
          voice.noiseOn(enabled),
        );
        break;
      case 0x1d98:
      case 0x1d9a:
        this.maskVoices(address, value, (voice, enabled) =>
          voice.echoOn(enabled),
        );
        break;
      case 0x1da4:
        this.irqOffset = (value << this.addressShift) & this.addressMask;
        break;
      case 0x1da6:
        this.ramOffset = (value << this.addressShift) & this.addressMask;
        break;
      case 0x1da8:
        this.view.setUint16(this.ramOffset, value, true);
        this.checkIrq();
        this.ramOffset = (this.ramOffset + 2) & this.addressMask;
        break;
      case 0x1daa:
        this.control = value;
        if (!(value & 64)) this.status &= ~64;
        break;
    }
  }

  maskVoices(
    address: number,
    value: number,
    update: (voice: SpuVoice, enabled: boolean) => void,
  ) {
    const start = address & 2 ? 16 : 0;
    for (let index = start; index < Math.min(24, start + 16); index++)
      update(this.voices[index], !!(value & (1 << (index - start))));
  }

  transfer(
    bus: SpuTransferBus,
    address: number,
    byteLength: number,
    toSpu = true,
  ) {
    check(
      Number.isSafeInteger(byteLength) &&
        byteLength >= 0 &&
        byteLength <= 0x200000 &&
        !(byteLength & 1),
      'PSF_DRIVER',
      'SPU DMA length',
    );
    for (let offset = 0; offset < byteLength; offset += 2) {
      if (toSpu)
        this.view.setUint16(
          this.ramOffset,
          bus.read16((address + offset) >>> 0),
          true,
        );
      else
        bus.write16(
          (address + offset) >>> 0,
          this.view.getUint16(this.ramOffset, true),
        );
      this.checkIrq();
      this.ramOffset = (this.ramOffset + 2) & this.addressMask;
    }
  }

  checkIrq(voice?: SpuVoice) {
    if ((this.control & 0x8040) !== 0x8040 || this.status & 64) return;
    const captureOffset = (this.samples & 511) << 1;
    if (
      voice
        ? voice.checkIrq(this.irqOffset)
        : this.ramOffset === this.irqOffset ||
          (this.registers[0x1ac >>> 1] & 12 &&
            this.irqOffset < 4096 &&
            (this.irqOffset & 1023) === captureOffset)
    ) {
      this.status |= 64;
      this.onIrq();
    }
  }

  sample() {
    this.samples++;
    if (
      this.keyOnPending &&
      !(this.samples & 1) &&
      this.samples >= this.keyOnWrittenAt + 2
    ) {
      for (let index = 0; index < 24; index++)
        if (this.keyOnPending & (1 << index)) {
          this.voices[index].keyOn();
          this.ENDX &= ~(1 << index);
        }
      this.keyOnPending = 0;
    }
    const noiseShift = (this.control >>> 10) & 15;
    this.noiseCounter += 4 + ((this.control >>> 8) & 3);
    if (this.noiseCounter >= 0x8000 >>> noiseShift) {
      this.noiseCounter %= Math.max(1, 0x8000 >>> noiseShift);
      const bit =
        ((this.noiseLevel >>> 15) ^
          (this.noiseLevel >>> 12) ^
          (this.noiseLevel >>> 11) ^
          (this.noiseLevel >>> 10) ^
          1) &
        1;
      this.noiseLevel = ((this.noiseLevel << 1) | bit) & 65535;
    }
    const noise = (this.noiseLevel << 16) >> 16;
    let left = 0,
      right = 0,
      reverbLeft = 0,
      reverbRight = 0,
      previous = 0;
    const audio = [0, 0];
    const captureOffset = (this.samples & 511) << 1;
    this.checkIrq();
    this.view.setInt16(captureOffset, 0, true);
    this.view.setInt16(0x400 + captureOffset, 0, true);
    for (const voice of this.voices) {
      const active = voice.advance(this.memory, audio, previous, noise);
      previous = voice.lastVolume;
      if (voice.capture)
        this.view.setInt16(voice.capture + captureOffset, previous, true);
      if (!active) continue;
      left += audio[0];
      right += audio[1];
      if (voice.reverb) {
        reverbLeft += audio[0];
        reverbRight += audio[1];
      }
    }
    if (this.control & 128) {
      const reverb = this.reverb.advance(
        this.samples,
        reverbLeft,
        reverbRight,
        this.view,
      );
      left += reverb[0];
      right += reverb[1];
    }
    this.status = (this.status & ~0x800) | (this.samples & 256 ? 0x800 : 0);
    if ((this.control & 0xc000) !== 0xc000) return [0, 0];
    const output = [left, right].map((value, channel) =>
      Math.max(-1, Math.min(1, (value * this.masterVolume[channel]) / 0x8000)),
    );
    for (let channel = 0; channel < 2; channel++)
      if (this.masterSweeping[channel])
        this.masterVolume[channel] = this.masterSweeps[channel].tick(
          this.masterVolume[channel],
        );
    return output;
  }
}
