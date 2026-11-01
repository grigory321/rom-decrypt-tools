interface GameBoyVoice {
  enabled: boolean;
  dac: boolean;
  length: number;
  lengthEnabled: boolean;
  timer: number;
  phase: number;
  frequency: number;
  volume: number;
  envelope: number;
  lfsr: number;
  sweepTimer: number;
  sweepFrequency: number;
  sweepEnabled: boolean;
  sweepNegated: boolean;
}
const duties = [0x01, 0x81, 0x87, 0x7e];
const noiseDivisors = [8, 16, 32, 48, 64, 80, 96, 112];
const registerMasks = [
  0x80, 0x3f, 0, 0xff, 0xbf, 0xff, 0x3f, 0, 0xff, 0xbf, 0x7f, 0xff, 0x9f, 0xff,
  0xbf, 0xff, 0xff, 0, 0, 0xbf, 0, 0, 0x70,
];

function channel(): GameBoyVoice {
  return {
    enabled: false,
    dac: false,
    length: 0,
    lengthEnabled: false,
    timer: 4,
    phase: 0,
    frequency: 0,
    volume: 0,
    envelope: 0,
    lfsr: 0x7fff,
    sweepTimer: 0,
    sweepFrequency: 0,
    sweepEnabled: false,
    sweepNegated: false,
  };
}

export class GameBoyApu {
  registers: Uint8Array;
  channels: GameBoyVoice[];
  power = false;
  frameTimer = 8192;
  frameStep = 0;
  areaLeft = 0;
  areaRight = 0;
  areaCycles = 0;
  capLeft = 0;
  capRight = 0;
  sampleLeft = 0;
  sampleRight = 0;
  constructor(private readonly options: { gbaWaveVolume?: boolean } = {}) {
    this.registers = new Uint8Array(0x30);
    this.channels = Array.from({ length: 4 }, channel);
    this.power = false;
    this.frameTimer = 8192;
    this.frameStep = 0;
    this.areaLeft = 0;
    this.areaRight = 0;
    this.areaCycles = 0;
    this.capLeft = 0;
    this.capRight = 0;
  }

  read(address: number) {
    const index = address - 0xff10;
    if (index === 0x16)
      return (
        0x70 |
        (this.power ? 128 : 0) |
        this.channels.reduce(
          (bits, voice, index) => bits | (voice.enabled ? 1 << index : 0),
          0,
        )
      );
    return (this.registers[index] || 0) | (registerMasks[index] || 0);
  }

  period(index: number) {
    if (index === 3) {
      const value = this.registers[0x12];
      return noiseDivisors[value & 7] * 2 ** (value >> 4);
    }
    return (2048 - this.channels[index].frequency) * (index === 2 ? 2 : 4);
  }

  sweep(apply: boolean) {
    const voice = this.channels[0];
    const control = this.registers[0];
    const delta = voice.sweepFrequency >> (control & 7);
    const frequency = voice.sweepFrequency + (control & 8 ? -delta : delta);
    if (control & 8) voice.sweepNegated = true;
    if (frequency > 2047) voice.enabled = false;
    else if (apply && control & 7) {
      voice.sweepFrequency = frequency;
      voice.frequency = frequency;
      this.registers[3] = frequency & 255;
      this.registers[4] = (this.registers[4] & 0xf8) | (frequency >> 8);
    }
    return frequency;
  }

  write(address: number, value: number) {
    const index = address - 0xff10;
    if (index >= 0x20) {
      this.registers[index] = value;
      return;
    }
    if (index === 0x16) {
      if (!(value & 128)) {
        this.registers.fill(0, 0, 0x16);
        this.channels = Array.from({ length: 4 }, channel);
        this.frameStep = 0;
        this.frameTimer = 8192;
      }
      this.power = !!(value & 128);
      return;
    }
    if (!this.power || index > 0x15) return;
    const previous = this.registers[index];
    this.registers[index] = value;
    if (index >= 0x14) return;
    const channelIndex = Math.floor(index / 5);
    const register = index % 5;
    const voice = this.channels[channelIndex];
    if (index === 0 && voice.sweepNegated && previous & 8 && !(value & 8))
      voice.enabled = false;
    if (register === 1)
      voice.length = channelIndex === 2 ? 256 - value : 64 - (value & 63);
    if (register === 2 && channelIndex !== 2) {
      voice.dac = !!(value & 0xf8);
      if (!voice.dac) voice.enabled = false;
    }
    if (index === 0x0a) {
      voice.dac = !!(value & 128);
      if (!voice.dac) voice.enabled = false;
    }
    if (channelIndex < 3 && (register === 3 || register === 4)) {
      voice.frequency =
        this.registers[channelIndex * 5 + 3] |
        ((this.registers[channelIndex * 5 + 4] & 7) << 8);
    }
    if (register !== 4) return;
    const lengthEnabled = !!(value & 64);
    if (
      lengthEnabled &&
      !voice.lengthEnabled &&
      this.frameStep & 1 &&
      voice.length > 0
    ) {
      if (--voice.length === 0) voice.enabled = false;
    }
    voice.lengthEnabled = lengthEnabled;
    if (!(value & 128)) return;
    voice.enabled = voice.dac;
    if (!voice.length) {
      voice.length = channelIndex === 2 ? 256 : 64;
      if (voice.lengthEnabled && this.frameStep & 1) voice.length--;
    }
    voice.timer = this.period(channelIndex);
    if (channelIndex === 2) voice.phase = 0;
    else {
      const envelope = this.registers[channelIndex * 5 + 2];
      voice.volume = envelope >> 4;
      voice.envelope = envelope & 7 || 8;
    }
    if (channelIndex === 3) voice.lfsr = 0x7fff;
    if (channelIndex === 0) {
      const sweep = this.registers[0];
      voice.sweepFrequency = voice.frequency;
      voice.sweepTimer = (sweep >> 4) & 7 || 8;
      voice.sweepEnabled = !!(sweep & 0x77);
      voice.sweepNegated = false;
      if (sweep & 7) this.sweep(false);
    }
  }

  clockFrame() {
    if (!(this.frameStep & 1)) {
      for (const voice of this.channels) {
        if (voice.lengthEnabled && voice.length > 0 && --voice.length === 0)
          voice.enabled = false;
      }
    }
    if (this.frameStep === 2 || this.frameStep === 6) {
      const voice = this.channels[0];
      if (--voice.sweepTimer <= 0) {
        voice.sweepTimer = (this.registers[0] >> 4) & 7 || 8;
        if (voice.sweepEnabled && this.registers[0] & 0x70) {
          if (this.sweep(true) <= 2047 && this.registers[0] & 7)
            this.sweep(false);
        }
      }
    }
    if (this.frameStep === 7) {
      for (const index of [0, 1, 3]) {
        const voice = this.channels[index];
        const control = this.registers[index * 5 + 2];
        if (--voice.envelope <= 0) {
          voice.envelope = control & 7 || 8;
          if (control & 7) {
            const next = voice.volume + (control & 8 ? 1 : -1);
            if (next >= 0 && next <= 15) voice.volume = next;
          }
        }
      }
    }
    this.frameStep = (this.frameStep + 1) & 7;
  }

  output(index: number) {
    const voice = this.channels[index];
    if (!this.power || !voice.enabled || !voice.dac) return 0;
    let sample: number;
    if (index < 2)
      sample =
        duties[this.registers[index * 5 + 1] >> 6] & (1 << voice.phase)
          ? voice.volume
          : 0;
    else if (index === 2) {
      const level = (this.registers[0x0c] >> 5) & 3;
      const value = this.registers[0x20 + (voice.phase >> 1)];
      const nibble = voice.phase & 1 ? value & 15 : value >> 4;
      sample =
        this.options.gbaWaveVolume && this.registers[0x0c] & 128
          ? Math.floor(nibble * 0.75)
          : level
            ? nibble >> (level - 1)
            : 0;
    } else sample = voice.lfsr & 1 ? 0 : voice.volume;
    return (sample * 2 - 15) / 60;
  }

  advance(cycles: number) {
    let remaining = cycles;
    while (remaining > 0) {
      let count = Math.min(remaining, this.frameTimer);
      for (const voice of this.channels)
        if (voice.enabled) count = Math.min(count, voice.timer);
      let left = 0;
      let right = 0;
      for (let index = 0; index < 4; index++) {
        const sample = this.output(index);
        if (this.registers[0x15] & (16 << index)) left += sample;
        if (this.registers[0x15] & (1 << index)) right += sample;
      }
      this.areaLeft +=
        ((left * (((this.registers[0x14] >> 4) & 7) + 1)) / 8) * count;
      this.areaRight +=
        ((right * ((this.registers[0x14] & 7) + 1)) / 8) * count;
      this.areaCycles += count;
      remaining -= count;
      this.frameTimer -= count;
      if (this.frameTimer <= 0) {
        this.frameTimer += 8192;
        this.clockFrame();
      }
      for (let index = 0; index < 4; index++) {
        const voice = this.channels[index];
        if (!voice.enabled) continue;
        voice.timer -= count;
        if (voice.timer > 0) continue;
        voice.timer += this.period(index);
        if (index < 3) voice.phase = (voice.phase + 1) & (index === 2 ? 31 : 7);
        else if (this.registers[0x12] >> 4 < 14) {
          const bit = (voice.lfsr ^ (voice.lfsr >> 1)) & 1;
          voice.lfsr = (voice.lfsr >> 1) | (bit << 14);
          if (this.registers[0x12] & 8)
            voice.lfsr = (voice.lfsr & ~64) | (bit << 6);
        }
      }
    }
  }

  sample() {
    const left = this.areaCycles ? this.areaLeft / this.areaCycles : 0;
    const right = this.areaCycles ? this.areaRight / this.areaCycles : 0;
    const outputLeft = left - this.capLeft;
    const outputRight = right - this.capRight;
    const decay = Math.pow(0.999958, this.areaCycles);
    this.capLeft = left - outputLeft * decay;
    this.capRight = right - outputRight * decay;
    this.areaLeft = 0;
    this.areaRight = 0;
    this.areaCycles = 0;
    this.sampleLeft = outputLeft;
    this.sampleRight = outputRight;
  }

  sampleRaw() {
    this.sampleLeft = this.areaCycles ? this.areaLeft / this.areaCycles : 0;
    this.sampleRight = this.areaCycles ? this.areaRight / this.areaCycles : 0;
    this.areaLeft = 0;
    this.areaRight = 0;
    this.areaCycles = 0;
  }
}
