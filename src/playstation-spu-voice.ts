import {
  createSpuEnvelope,
  type SpuEnvelope,
} from './playstation-spu-envelope.js';

export interface SpuVoiceHost {
  memory: Uint8Array;
  addressShift: number;
  ENDX: number;
  checkIrq(voice?: SpuVoice): void;
}

export interface SpuVoice {
  reverb: boolean;
  capture: number;
  lastVolume: number;
  setId(voiceId: number): SpuVoice;
  advance(
    ram: Uint8Array,
    audio: number[],
    previousVoiceOutput?: number,
    noiseSample?: number,
  ): number;
  volx(right: number): number;
  checkIrq(offset: number): boolean;
  keyOn(): void;
  keyOff(): void;
  echoOn(enabled: boolean): void;
  modOn(enabled: boolean): void;
  noiseOn(enabled?: boolean): void;
  setStartAddress(address: number): void;
  setRepeatAddress(address: number): void;
  getRepeatAddress(): number;
  getCurrentAddress(): number;
  rd16(addr: number): number;
  wr16(addr: number, data: number): void;
}

export function createSpuVoice(spu: SpuVoiceHost): SpuVoice {
  let id = 0;

  let adsrLevel = 0;
  let adsrState = 0;
  let pitchModulationEnabled = false;

  let pitchStep = 0;

  let pitchCounter = 0;
  let repeatAddress = 0;
  let blockAddress = 0;
  let startAddress = 0;
  let noiseEnabled = false;
  const addressMask = spu.memory.length - 1;
  const addressShift = spu.addressShift;
  let currentBlock = -1;
  let started = false;
  let startup = 0;
  let ignoreLoop = false;

  const samples = new Int16Array(3 + 28);
  let blockFlags = 0;
  let hasSamples = false;
  let s0 = 0;
  let s1 = 0;

  let volumeLeft = 0;
  let volumeRight = 0;

  let regs = new Uint16Array(16);

  const gauss = [
    -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, 0x0000,
    0x0000, 0x0000, 0x0000, 0x0000, 0x0000, 0x0000, 0x0001, 0x0001, 0x0001,
    0x0001, 0x0002, 0x0002, 0x0002, 0x0003, 0x0003, 0x0003, 0x0004, 0x0004,
    0x0005, 0x0005, 0x0006, 0x0007, 0x0007, 0x0008, 0x0009, 0x0009, 0x000a,
    0x000b, 0x000c, 0x000d, 0x000e, 0x000f, 0x0010, 0x0011, 0x0012, 0x0013,
    0x0015, 0x0016, 0x0018, 0x0019, 0x001b, 0x001c, 0x001e, 0x0020, 0x0021,
    0x0023, 0x0025, 0x0027, 0x0029, 0x002c, 0x002e, 0x0030, 0x0033, 0x0035,
    0x0038, 0x003a, 0x003d, 0x0040, 0x0043, 0x0046, 0x0049, 0x004d, 0x0050,
    0x0054, 0x0057, 0x005b, 0x005f, 0x0063, 0x0067, 0x006b, 0x006f, 0x0074,
    0x0078, 0x007d, 0x0082, 0x0087, 0x008c, 0x0091, 0x0096, 0x009c, 0x00a1,
    0x00a7, 0x00ad, 0x00b3, 0x00ba, 0x00c0, 0x00c7, 0x00cd, 0x00d4, 0x00db,
    0x00e3, 0x00ea, 0x00f2, 0x00fa, 0x0101, 0x010a, 0x0112, 0x011b, 0x0123,
    0x012c, 0x0135, 0x013f, 0x0148, 0x0152, 0x015c, 0x0166, 0x0171, 0x017b,
    0x0186, 0x0191, 0x019c, 0x01a8, 0x01b4, 0x01c0, 0x01cc, 0x01d9, 0x01e5,
    0x01f2, 0x0200, 0x020d, 0x021b, 0x0229, 0x0237, 0x0246, 0x0255, 0x0264,
    0x0273, 0x0283, 0x0293, 0x02a3, 0x02b4, 0x02c4, 0x02d6, 0x02e7, 0x02f9,
    0x030b, 0x031d, 0x0330, 0x0343, 0x0356, 0x036a, 0x037e, 0x0392, 0x03a7,
    0x03bc, 0x03d1, 0x03e7, 0x03fc, 0x0413, 0x042a, 0x0441, 0x0458, 0x0470,
    0x0488, 0x04a0, 0x04b9, 0x04d2, 0x04ec, 0x0506, 0x0520, 0x053b, 0x0556,
    0x0572, 0x058e, 0x05aa, 0x05c7, 0x05e4, 0x0601, 0x061f, 0x063e, 0x065c,
    0x067c, 0x069b, 0x06bb, 0x06dc, 0x06fd, 0x071e, 0x0740, 0x0762, 0x0784,
    0x07a7, 0x07cb, 0x07ef, 0x0813, 0x0838, 0x085d, 0x0883, 0x08a9, 0x08d0,
    0x08f7, 0x091e, 0x0946, 0x096f, 0x0998, 0x09c1, 0x09eb, 0x0a16, 0x0a40,
    0x0a6c, 0x0a98, 0x0ac4, 0x0af1, 0x0b1e, 0x0b4c, 0x0b7a, 0x0ba9, 0x0bd8,
    0x0c07, 0x0c38, 0x0c68, 0x0c99, 0x0ccb, 0x0cfd, 0x0d30, 0x0d63, 0x0d97,
    0x0dcb, 0x0e00, 0x0e35, 0x0e6b, 0x0ea1, 0x0ed7, 0x0f0f, 0x0f46, 0x0f7f,
    0x0fb7, 0x0ff1, 0x102a, 0x1065, 0x109f, 0x10db, 0x1116, 0x1153, 0x118f,
    0x11cd, 0x120b, 0x1249, 0x1288, 0x12c7, 0x1307, 0x1347, 0x1388, 0x13c9,
    0x140b, 0x144d, 0x1490, 0x14d4, 0x1517, 0x155c, 0x15a0, 0x15e6, 0x162c,
    0x1672, 0x16b9, 0x1700, 0x1747, 0x1790, 0x17d8, 0x1821, 0x186b, 0x18b5,
    0x1900, 0x194b, 0x1996, 0x19e2, 0x1a2e, 0x1a7b, 0x1ac8, 0x1b16, 0x1b64,
    0x1bb3, 0x1c02, 0x1c51, 0x1ca1, 0x1cf1, 0x1d42, 0x1d93, 0x1de5, 0x1e37,
    0x1e89, 0x1edc, 0x1f2f, 0x1f82, 0x1fd6, 0x202a, 0x207f, 0x20d4, 0x2129,
    0x217f, 0x21d5, 0x222c, 0x2282, 0x22da, 0x2331, 0x2389, 0x23e1, 0x2439,
    0x2492, 0x24eb, 0x2545, 0x259e, 0x25f8, 0x2653, 0x26ad, 0x2708, 0x2763,
    0x27be, 0x281a, 0x2876, 0x28d2, 0x292e, 0x298b, 0x29e7, 0x2a44, 0x2aa1,
    0x2aff, 0x2b5c, 0x2bba, 0x2c18, 0x2c76, 0x2cd4, 0x2d33, 0x2d91, 0x2df0,
    0x2e4f, 0x2eae, 0x2f0d, 0x2f6c, 0x2fcc, 0x302b, 0x308b, 0x30ea, 0x314a,
    0x31aa, 0x3209, 0x3269, 0x32c9, 0x3329, 0x3389, 0x33e9, 0x3449, 0x34a9,
    0x3509, 0x3569, 0x35c9, 0x3629, 0x3689, 0x36e8, 0x3748, 0x37a8, 0x3807,
    0x3867, 0x38c6, 0x3926, 0x3985, 0x39e4, 0x3a43, 0x3aa2, 0x3b00, 0x3b5f,
    0x3bbd, 0x3c1b, 0x3c79, 0x3cd7, 0x3d35, 0x3d92, 0x3def, 0x3e4c, 0x3ea9,
    0x3f05, 0x3f62, 0x3fbd, 0x4019, 0x4074, 0x40d0, 0x412a, 0x4185, 0x41df,
    0x4239, 0x4292, 0x42eb, 0x4344, 0x439c, 0x43f4, 0x444c, 0x44a3, 0x44fa,
    0x4550, 0x45a6, 0x45fc, 0x4651, 0x46a6, 0x46fa, 0x474e, 0x47a1, 0x47f4,
    0x4846, 0x4898, 0x48e9, 0x493a, 0x498a, 0x49d9, 0x4a29, 0x4a77, 0x4ac5,
    0x4b13, 0x4b5f, 0x4bac, 0x4bf7, 0x4c42, 0x4c8d, 0x4cd7, 0x4d20, 0x4d68,
    0x4db0, 0x4df7, 0x4e3e, 0x4e84, 0x4ec9, 0x4f0e, 0x4f52, 0x4f95, 0x4fd7,
    0x5019, 0x505a, 0x509a, 0x50da, 0x5118, 0x5156, 0x5194, 0x51d0, 0x520c,
    0x5247, 0x5281, 0x52ba, 0x52f3, 0x532a, 0x5361, 0x5397, 0x53cc, 0x5401,
    0x5434, 0x5467, 0x5499, 0x54ca, 0x54fa, 0x5529, 0x5558, 0x5585, 0x55b2,
    0x55de, 0x5609, 0x5632, 0x565b, 0x5684, 0x56ab, 0x56d1, 0x56f6, 0x571b,
    0x573e, 0x5761, 0x5782, 0x57a3, 0x57c3, 0x57e2, 0x57ff, 0x581c, 0x5838,
    0x5853, 0x586d, 0x5886, 0x589e, 0x58b5, 0x58cb, 0x58e0, 0x58f4, 0x5907,
    0x5919, 0x592a, 0x593a, 0x5949, 0x5958, 0x5965, 0x5971, 0x597c, 0x5986,
    0x598f, 0x5997, 0x599e, 0x59a4, 0x59a9, 0x59ad, 0x59b0, 0x59b2, 0x59b3,
  ];

  const adsr = createSpuEnvelope();
  const sweepLeft = createSpuEnvelope(),
    sweepRight = createSpuEnvelope();
  let sweepingLeft = false,
    sweepingRight = false;

  const adsrRegister = () => (regs[0x8] | (regs[0xa] << 16)) >>> 0;

  const adsrPhase = (phase: number) => {
    const r = adsrRegister();
    adsrState = phase;
    switch (phase) {
      case 1:
        adsr.reset((r >>> 8) & 0x7f, 0x7f, false, (r & 0x8000) !== 0);
        break;
      case 2:
        adsr.reset(((r >>> 4) & 0xf) << 2, 0x1f << 2, true, true);
        break;
      case 3:
        adsr.reset(
          (r >>> 22) & 0x7f,
          0x7f,
          (r & 0x40000000) !== 0,
          (r & 0x80000000) !== 0,
        );
        break;
      case 4:
        adsr.reset(
          ((r >>> 16) & 0x1f) << 2,
          0x1f << 2,
          true,
          (r & 0x200000) !== 0,
        );
        break;
    }
  };

  const mixADSR = () => {
    adsrLevel = adsr.tick(adsrLevel);
    if (adsr.stepped) {
      switch (adsrState) {
        case 1:
          if (adsrLevel >= 0x7fff) adsrPhase(2);
          break;
        case 2:
          if (adsrLevel >> 11 <= (regs[0x8] & 0xf)) adsrPhase(3);
          break;
        case 4:
          if (adsrLevel <= 0) adsrState = 0;
          break;
      }
    }
    regs[0x0c] = adsrLevel;
    return adsrLevel / 0x8000;
  };

  const startAdsrAttack = () => {
    adsrLevel = 0;
    adsrPhase(1);
  };
  const startAdsrRelease = () => {
    adsrPhase(4);
  };

  const setVolume = (data: number, current: number, sweep: SpuEnvelope) => {
    if (!(data & 0x8000))
      return { level: ((data & 0x7fff) << 17) >> 16, sweeping: false };
    sweep.reset(
      data & 0x7f,
      0x7f,
      (data & 0x2000) !== 0,
      (data & 0x4000) !== 0,
      (data & 0x1000) !== 0,
    );
    return { level: current, sweeping: sweep.increment > 0 };
  };

  const FILTER_POS = [0, 60, 115, 98, 122];
  const FILTER_NEG = [0, 0, -52, -55, -60];

  const decodeBlock = (ram: Uint8Array) => {
    currentBlock = blockAddress;
    const shiftFilter = ram[blockAddress & addressMask];
    blockFlags = ram[(blockAddress + 1) & addressMask];

    const shiftValue = shiftFilter & 0x0f;
    const shift = shiftValue > 12 ? 9 : shiftValue;

    const filter = shiftFilter >>> 4 > 4 ? 0 : shiftFilter >>> 4;
    const k0 = FILTER_POS[filter],
      k1 = FILTER_NEG[filter];

    samples[0] = samples[28];
    samples[1] = samples[29];
    samples[2] = samples[30];
    for (let i = 0; i < 28; ++i) {
      const data = ram[(blockAddress + 2 + (i >> 1)) & addressMask];
      const nibble = ((data >> ((i & 1) << 2)) & 0xf) << 12;
      let value =
        (((nibble << 16) >> 16) >> shift) + ((s0 * k0) >> 6) + ((s1 * k1) >> 6);
      value = Math.max(-0x8000, Math.min(0x7fff, value));
      s1 = s0;
      s0 = value;
      samples[3 + i] = value;
    }

    if ((blockFlags & 4) === 4 && !ignoreLoop) {
      repeatAddress = blockAddress;
    }
    hasSamples = true;
  };

  const nextBlock = () => {
    hasSamples = false;
    blockAddress = (blockAddress + 16) & addressMask;
    if (blockFlags & 1) {
      blockAddress = repeatAddress;
      spu.ENDX |= 1 << id;
      if (!(blockFlags & 2)) {
        adsrState = 0;
        adsrLevel = 0;
        regs[0x0c] = 0;
      }
    }
  };

  const interpolate = () => {
    const i = (pitchCounter >>> 4) & 0xff;
    const n = 3 + (pitchCounter >>> 12);
    return (
      (gauss[0x0ff - i] * samples[n - 3] +
        gauss[0x1ff - i] * samples[n - 2] +
        gauss[0x100 + i] * samples[n - 1] +
        gauss[i] * samples[n]) >>
      15
    );
  };

  const voice: SpuVoice = {
    reverb: false,
    capture: 0,

    lastVolume: 0,

    setId(voiceId) {
      id = voiceId;
      if (voiceId === 1) voice.capture = 0x0800;
      if (voiceId === 3) voice.capture = 0x0c00;
      return voice;
    },

    advance(ram, audio, previousVoiceOutput = 0, noiseSample = 0) {
      voice.lastVolume = 0;

      if (!started) return 0;

      if (startup) {
        --startup;
        if (startup < 3 && ram[(blockAddress + 1) & addressMask] & 4)
          repeatAddress = blockAddress;
        return 0;
      }

      let step = pitchStep;
      if (pitchModulationEnabled && id > 0) {
        const factor =
          Math.max(-0x8000, Math.min(0x7fff, previousVoiceOutput)) + 0x8000;
        step = ((step * factor) >> 15) & 0xffff;
      }
      if (!hasSamples) decodeBlock(ram);
      pitchCounter += Math.min(step, 0x4000);
      if (pitchCounter >>> 12 >= 28) {
        pitchCounter -= 28 << 12;
        nextBlock();
        decodeBlock(ram);
      }

      spu.checkIrq(voice);

      const sample = noiseEnabled ? noiseSample : interpolate();
      if (adsrState) mixADSR();
      const enveloped = (sample * adsrLevel) >> 15;
      voice.lastVolume = enveloped;

      audio[0] = ((enveloped * volumeLeft) >> 15) / 0x8000;
      audio[1] = ((enveloped * volumeRight) >> 15) / 0x8000;
      if (sweepingLeft) volumeLeft = sweepLeft.tick(volumeLeft);
      if (sweepingRight) volumeRight = sweepRight.tick(volumeRight);

      return adsrState;
    },

    volx(right) {
      return (right ? volumeRight : volumeLeft) & 0xffff;
    },

    checkIrq(offset) {
      return currentBlock <= offset && offset < currentBlock + 16;
    },

    keyOn() {
      startup = 4;
      ignoreLoop = false;
      adsrLevel = 0;
      regs[0x0c] = 0;
      s0 = 0;
      s1 = 0;
      samples.fill(0);
      hasSamples = false;

      pitchCounter = 3 << 12;
      blockAddress = startAddress;
      currentBlock = -1;
      started = true;
      startAdsrAttack();
    },

    echoOn(enabled) {
      voice.reverb = enabled;
    },

    modOn(enabled) {
      pitchModulationEnabled = enabled;
    },

    noiseOn(enabled = true) {
      noiseEnabled = enabled;
    },
    setStartAddress(address) {
      startAddress = address & addressMask;
    },
    setRepeatAddress(address) {
      repeatAddress = address & addressMask;
      if (started && adsrState) ignoreLoop = true;
    },
    getRepeatAddress() {
      return repeatAddress;
    },
    getCurrentAddress() {
      return blockAddress;
    },

    keyOff() {
      startAdsrRelease();
    },

    rd16(addr) {
      if ((addr & 15) === 0xe) return (repeatAddress >>> addressShift) & 0xffff;
      return regs[addr & 15];
    },

    wr16(addr, data) {
      regs[addr & 15] = data;
      switch (addr % 16) {
        case 0x0: {
          const v = setVolume(data, volumeLeft, sweepLeft);
          volumeLeft = v.level;
          sweepingLeft = v.sweeping;
          break;
        }
        case 0x2: {
          const v = setVolume(data, volumeRight, sweepRight);
          volumeRight = v.level;
          sweepingRight = v.sweeping;
          break;
        }
        case 0x4:
          pitchStep = Math.min(data, 0x4000);
          break;

        case 0x6:
          startAddress = (data << addressShift) & addressMask;
          break;
        case 0x8:
        case 0xa:
          if (adsrState) adsrPhase(adsrState);
          break;

        case 0xe:
          repeatAddress = (data << addressShift) & addressMask;
          if (started && adsrState) ignoreLoop = true;
          break;
      }
    },
  };

  return voice;
}
