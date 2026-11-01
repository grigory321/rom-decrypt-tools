import { GAUSS_TABLE } from './gaussian.js';

export const DSP_SAMPLE_RATE = 32e3;

const VOL_L = 0;

const VOL_R = 1;

const PITCH_L = 2;

const PITCH_H = 3;

const SRCN = 4;

const ADSR1 = 5;

const ADSR2 = 6;

const GAIN = 7;

const ENVX = 8;

const OUTX = 9;

const R_MVOL_L = 12;

const R_MVOL_R = 28;

const R_EVOL_L = 44;

const R_EVOL_R = 60;

const R_KON = 76;

const R_KOF = 92;

const R_FLG = 108;

const R_ENDX = 124;

const R_EFB = 13;

const R_PMON = 45;

const R_NON = 61;

const R_EON = 77;

const R_DIR = 93;

const R_ESA = 109;

const R_EDL = 125;

const COUNTER_RATE = new Uint16Array([
  0, 2048, 1536, 1280, 1024, 768, 640, 512, 384, 320, 256, 192, 160, 128, 96,
  80, 64, 48, 40, 32, 24, 20, 16, 12, 10, 8, 6, 5, 4, 3, 2, 1,
]);

const COUNTER_OFFSET = new Uint16Array([
  0, 0, 1040, 536, 0, 1040, 536, 0, 1040, 536, 0, 1040, 536, 0, 1040, 536, 0,
  1040, 536, 0, 1040, 536, 0, 1040, 536, 0, 1040, 536, 0, 1040, 0, 0,
]);

const COUNTER_RANGE = 30720;

const PITCH_ONE = 4096;

export var EnvMode = (function (EnvMode) {
  EnvMode[(EnvMode['Release'] = 0)] = 'Release';
  EnvMode[(EnvMode['Attack'] = 1)] = 'Attack';
  EnvMode[(EnvMode['Decay'] = 2)] = 'Decay';
  EnvMode[(EnvMode['Sustain'] = 3)] = 'Sustain';
  return EnvMode;
})({});

function clamp16(v) {
  return v < -32768 ? -32768 : v > 32767 ? 32767 : v;
}

function sext16(v) {
  return (v << 16) >> 16;
}

export class Voice {
  buffer = new Int32Array(12);
  bufferPos = 0;
  decoded = 0;
  brrAddress = 0;
  brrOffset = 1;
  brrHeader = 0;
  envelope = 0;
  hiddenEnvelope = 0;
  envelopeMode = 0;
  keyonDelay = 0;
  gaussianOffset = 0;
  outx = 0;
  keyOnAt = 0;
  keyOnCount = 0;
  reset() {
    this.buffer.fill(0);
    this.bufferPos = 0;
    this.decoded = 0;
    this.brrAddress = 0;
    this.brrOffset = 1;
    this.brrHeader = 0;
    this.envelope = 0;
    this.hiddenEnvelope = 0;
    this.envelopeMode = 0;
    this.keyonDelay = 0;
    this.gaussianOffset = 0;
    this.outx = 0;
    this.keyOnAt = 0;
    this.keyOnCount = 0;
  }
}

export class DSP {
  ram;
  regs = new Uint8Array(128);
  voices = [];
  voiceMask = 0;
  echoMask = 0;
  sampleCount = 0;
  noteOnEvents = [];
  voiceOut = new Int16Array(8);
  counter = 0;
  noise = 16384;
  konLatch = 0;
  konPending = 0;
  echoOffset = 0;
  echoLength = 0;
  firL = new Int32Array(8);
  firR = new Int32Array(8);
  firIndex = 0;
  constructor(ram) {
    this.ram = ram;
    for (let i = 0; i < 8; i++) this.voices.push(new Voice());
    this.reset();
  }
  reset() {
    this.regs.fill(0);
    this.regs[R_FLG] = 224;
    for (const v of this.voices) v.reset();
    this.sampleCount = 0;
    this.counter = 0;
    this.noise = 16384;
    this.konLatch = 0;
    this.konPending = 0;
    this.echoOffset = 0;
    this.echoLength = 0;
    this.firL.fill(0);
    this.firR.fill(0);
    this.firIndex = 0;
  }
  read(addr) {
    return this.regs[addr & 127];
  }
  write(addr, value) {
    addr &= 127;
    value &= 255;
    this.regs[addr] = value;
    if (addr === R_KON) {
      this.konLatch = value;
    } else if (addr === R_ENDX) {
      this.regs[R_ENDX] = 0;
    }
  }
  counterTick() {
    if (--this.counter < 0) this.counter = COUNTER_RANGE - 1;
  }
  counterPoll(rate) {
    if (rate === 0) return false;
    return (this.counter + COUNTER_OFFSET[rate]) % COUNTER_RATE[rate] === 0;
  }
  dirEntry(srcn, which) {
    const a = ((this.regs[R_DIR] << 8) + srcn * 4 + which * 2) & 65535;
    return this.ram[a] | (this.ram[(a + 1) & 65535] << 8);
  }
  decodeGroup(v, index) {
    const header = this.ram[v.brrAddress];
    v.brrHeader = header;
    const shift = header >> 4;
    const filter = (header >> 2) & 3;
    const b0 = this.ram[(v.brrAddress + v.brrOffset) & 65535];
    const b1 = this.ram[(v.brrAddress + v.brrOffset + 1) & 65535];
    const nibbles = [b0 >> 4, b0 & 15, b1 >> 4, b1 & 15];
    for (let n = 0; n < 4; n++) {
      let s = (nibbles[n] << 28) >> 28;
      if (shift <= 12) {
        s = (s << shift) >> 1;
      } else {
        s = (s >> 3) << 11;
      }
      const wp = (v.bufferPos + v.decoded) % 12;
      const p1 = v.buffer[(wp + 11) % 12];
      const p2 = v.buffer[(wp + 10) % 12] >> 1;
      switch (filter) {
        case 1:
          s += p1 >> 1;
          s += -p1 >> 5;
          break;

        case 2:
          s += p1;
          s += -(p1 + (p1 >> 1)) >> 5;
          s -= p2;
          s += p2 >> 4;
          break;

        case 3:
          s += p1;
          s += -(p1 + (p1 << 2) + (p1 << 3)) >> 7;
          s -= p2;
          s += (p2 + (p2 << 1)) >> 4;
          break;
      }
      v.buffer[wp] = sext16(clamp16(s) * 2);
      v.decoded++;
    }
    v.brrOffset += 2;
    if (v.brrOffset >= 9) {
      v.brrOffset = 1;
      v.brrAddress = (v.brrAddress + 9) & 65535;
      if (header & 1) {
        this.regs[R_ENDX] |= 1 << index;
        if (header & 2) {
          v.brrAddress = this.dirEntry(this.regs[(index << 4) | SRCN], 1);
        } else {
          v.envelope = 0;
          v.envelopeMode = 0;
        }
      }
    }
  }
  gaussianInterpolate(v) {
    const off = (v.gaussianOffset >> 4) & 255;
    let i = v.bufferPos;
    let out = (GAUSS_TABLE[255 - off] * v.buffer[i]) >> 11;
    i = i === 11 ? 0 : i + 1;
    out += (GAUSS_TABLE[511 - off] * v.buffer[i]) >> 11;
    i = i === 11 ? 0 : i + 1;
    out += (GAUSS_TABLE[256 + off] * v.buffer[i]) >> 11;
    i = i === 11 ? 0 : i + 1;
    out = sext16(out);
    out += (GAUSS_TABLE[off] * v.buffer[i]) >> 11;
    return clamp16(out) & ~1;
  }
  envelopeRun(v, base) {
    let env = v.envelope;
    if (v.envelopeMode === 0) {
      env -= 8;
      v.envelope = env < 0 ? 0 : env;
      return;
    }
    let rate;
    let envData = this.regs[base + ADSR2];
    const adsr1 = this.regs[base + ADSR1];
    if (adsr1 & 128) {
      if (v.envelopeMode === 2) {
        env--;
        env -= env >> 8;
        rate = ((adsr1 >> 3) & 14) + 16;
      } else if (v.envelopeMode === 3) {
        env--;
        env -= env >> 8;
        rate = envData & 31;
      } else {
        rate = (adsr1 & 15) * 2 + 1;
        env += rate < 31 ? 32 : 1024;
      }
    } else {
      envData = this.regs[base + GAIN];
      const mode = envData >> 5;
      if (mode < 4) {
        env = (envData & 127) * 16;
        rate = 31;
      } else {
        rate = envData & 31;
        if (mode === 4) {
          env -= 32;
        } else if (mode === 5) {
          env--;
          env -= env >> 8;
        } else if (mode === 6) {
          env += 32;
        } else {
          env += v.hiddenEnvelope < 1536 ? 32 : 8;
        }
      }
    }
    if (env >> 8 === envData >> 5 && v.envelopeMode === 2) {
      v.envelopeMode = 3;
    }
    v.hiddenEnvelope = env;
    if (env < 0 || env > 2047) {
      env = env < 0 ? 0 : 2047;
      if (v.envelopeMode === 1) v.envelopeMode = 2;
    }
    if (this.counterPoll(rate)) v.envelope = env;
  }
  runSample(out) {
    const flg = this.regs[R_FLG];
    const softReset = (flg & 128) !== 0;
    this.counterTick();
    if (this.counterPoll(flg & 31)) {
      const feedback = (this.noise << 13) ^ (this.noise << 14);
      this.noise = (feedback & 16384) | (this.noise >> 1);
    }
    const kon = this.konPending;
    this.konPending = this.konLatch;
    this.konLatch = 0;
    const kof = this.regs[R_KOF];
    let mainL = 0;
    let mainR = 0;
    let echoInL = 0;
    let echoInR = 0;
    for (let i = 0; i < 8; i++) {
      const v = this.voices[i];
      const base = i << 4;
      const bit = 1 << i;
      if (kon & bit) {
        v.keyonDelay = 5;
        v.envelopeMode = 0;
        v.keyOnAt = this.sampleCount;
        v.keyOnCount++;
      }
      if (softReset || kof & bit) {
        v.envelopeMode = 0;
        if (softReset) v.envelope = 0;
      }
      if (v.keyonDelay > 0) {
        if (v.keyonDelay === 5) {
          v.brrAddress = this.dirEntry(this.regs[base + SRCN], 0);
          v.brrOffset = 1;
          v.bufferPos = 0;
          v.decoded = 0;
          v.buffer.fill(0);
          v.brrHeader = 0;
          this.regs[R_ENDX] &= ~bit;
        }
        v.envelope = 0;
        v.hiddenEnvelope = 0;
        v.keyonDelay--;
        v.gaussianOffset = 0;
        if (v.keyonDelay === 0) {
          v.envelopeMode = 1;
          if (this.noteOnEvents.length < 4096) {
            this.noteOnEvents.push(this.regs[base + SRCN], this.pitchOf(i));
          }
        }
        v.outx = 0;
        this.voiceOut[i] = 0;
        this.regs[base + ENVX] = 0;
        this.regs[base + OUTX] = 0;
        continue;
      }
      while (v.decoded < 4) this.decodeGroup(v, i);
      let sample;
      if (this.regs[R_NON] & bit) {
        sample = sext16(this.noise << 1);
      } else {
        sample = this.gaussianInterpolate(v);
      }
      this.envelopeRun(v, base);
      sample = ((sample * v.envelope) >> 11) & ~1;
      v.outx = sample;
      this.voiceOut[i] = sample;
      this.regs[base + ENVX] = v.envelope >> 4;
      this.regs[base + OUTX] = (sample >> 8) & 255;
      if (!(this.voiceMask & bit)) {
        mainL = clamp16(
          mainL + ((sample * ((this.regs[base + VOL_L] << 24) >> 24)) >> 7),
        );
        mainR = clamp16(
          mainR + ((sample * ((this.regs[base + VOL_R] << 24) >> 24)) >> 7),
        );
      }
      if (this.regs[R_EON] & bit & ~this.echoMask & ~this.voiceMask) {
        echoInL = clamp16(
          echoInL + ((sample * ((this.regs[base + VOL_L] << 24) >> 24)) >> 7),
        );
        echoInR = clamp16(
          echoInR + ((sample * ((this.regs[base + VOL_R] << 24) >> 24)) >> 7),
        );
      }
      let step =
        this.regs[base + PITCH_L] | ((this.regs[base + PITCH_H] & 63) << 8);
      if (i > 0 && this.regs[R_PMON] & bit) {
        const prev = this.voices[i - 1].outx;
        step += ((prev >> 5) * step) >> 10;
        if (step < 0) step = 0;
        if (step > 16383) step = 16383;
      }
      v.gaussianOffset += step;
      while (v.gaussianOffset >= PITCH_ONE) {
        v.gaussianOffset -= PITCH_ONE;
        v.bufferPos = v.bufferPos === 11 ? 0 : v.bufferPos + 1;
        v.decoded--;
        while (v.decoded < 4) this.decodeGroup(v, i);
      }
    }
    if (this.echoOffset === 0) {
      this.echoLength = (this.regs[R_EDL] & 15) * 2048;
    }
    const ea = ((this.regs[R_ESA] << 8) + this.echoOffset) & 65535;
    const echoL = sext16(this.ram[ea] | (this.ram[(ea + 1) & 65535] << 8)) >> 1;
    const echoR =
      sext16(this.ram[(ea + 2) & 65535] | (this.ram[(ea + 3) & 65535] << 8)) >>
      1;
    this.firIndex = (this.firIndex + 1) & 7;
    this.firL[this.firIndex] = echoL;
    this.firR[this.firIndex] = echoR;
    let firOutL = 0;
    let firOutR = 0;
    for (let t = 0; t < 7; t++) {
      const c = (this.regs[(t << 4) | 15] << 24) >> 24;
      const h = (this.firIndex + 1 + t) & 7;
      firOutL += (this.firL[h] * c) >> 6;
      firOutR += (this.firR[h] * c) >> 6;
    }
    firOutL = sext16(firOutL);
    firOutR = sext16(firOutR);
    {
      const c = (this.regs[(7 << 4) | 15] << 24) >> 24;
      firOutL = clamp16(firOutL + ((this.firL[this.firIndex] * c) >> 6)) & ~1;
      firOutR = clamp16(firOutR + ((this.firR[this.firIndex] * c) >> 6)) & ~1;
    }
    if (!(flg & 32)) {
      const efb = (this.regs[R_EFB] << 24) >> 24;
      const wL = clamp16(echoInL + ((firOutL * efb) >> 7)) & ~1;
      const wR = clamp16(echoInR + ((firOutR * efb) >> 7)) & ~1;
      this.ram[ea] = wL & 255;
      this.ram[(ea + 1) & 65535] = (wL >> 8) & 255;
      this.ram[(ea + 2) & 65535] = wR & 255;
      this.ram[(ea + 3) & 65535] = (wR >> 8) & 255;
    }
    this.echoOffset += 4;
    if (this.echoOffset >= this.echoLength) this.echoOffset = 0;
    let outL = clamp16(
      ((mainL * ((this.regs[R_MVOL_L] << 24) >> 24)) >> 7) +
        ((firOutL * ((this.regs[R_EVOL_L] << 24) >> 24)) >> 7),
    );
    let outR = clamp16(
      ((mainR * ((this.regs[R_MVOL_R] << 24) >> 24)) >> 7) +
        ((firOutR * ((this.regs[R_EVOL_R] << 24) >> 24)) >> 7),
    );
    if (flg & 64) {
      outL = 0;
      outR = 0;
    }
    out[0] = outL;
    out[1] = outR;
    this.sampleCount++;
  }
  restoreFromSnapshot(resumeVoices) {
    this.counter = 0;
    this.noise = 16384;
    this.echoOffset = 0;
    this.echoLength = 0;
    this.firL.fill(0);
    this.firR.fill(0);
    this.firIndex = 0;
    this.sampleCount = 0;
    this.konLatch = 0;
    const kon = this.regs[R_KON];
    const kof = this.regs[R_KOF];
    let pending = 0;
    const resumeAt = (i, envelope) => {
      const v = this.voices[i];
      const base = i << 4;
      const srcn = this.regs[base + SRCN];
      v.envelope = Math.min(2047, envelope);
      v.hiddenEnvelope = v.envelope;
      v.envelopeMode = 3;
      v.brrAddress = this.dirEntry(srcn, 1);
      v.brrOffset = 1;
      v.bufferPos = 0;
      v.decoded = 0;
      v.gaussianOffset = 0;
    };
    for (let i = 0; i < 8; i++) {
      const base = i << 4;
      const bit = 1 << i;
      const capturedEnv = this.regs[base + ENVX];
      this.voices[i].reset();
      this.regs[base + ENVX] = 0;
      this.regs[base + OUTX] = 0;
      if (kof & bit) continue;
      if (resumeVoices && capturedEnv > 0) {
        resumeAt(i, capturedEnv << 4);
        continue;
      }
      if (kon & bit) pending |= bit;
    }
    this.konPending = 0;
    return pending;
  }
  applyKeyOnRecovery(mask) {
    let pending = 0;
    for (let i = 0; i < 8; i++) {
      const bit = 1 << i;
      if (!(mask & bit)) continue;
      const base = i << 4;
      const adsr1 = this.regs[base + ADSR1];
      const gainMode = this.regs[base + GAIN] >> 5;
      if (!(adsr1 & 128) && (gainMode === 4 || gainMode === 5)) {
        const v = this.voices[i];
        v.envelope = 2047;
        v.hiddenEnvelope = 2047;
        v.envelopeMode = 3;
        v.brrAddress = this.dirEntry(this.regs[base + SRCN], 0);
        v.brrOffset = 1;
        v.bufferPos = 0;
        v.decoded = 0;
        v.gaussianOffset = 0;
      } else {
        pending |= bit;
      }
    }
    this.konPending = pending;
  }
  envelopeOf(index) {
    return this.voices[index].envelope;
  }
  isActive(index) {
    const v = this.voices[index];
    return v.keyonDelay > 0 || v.envelope > 0;
  }
  pitchOf(index) {
    const base = index << 4;
    return this.regs[base + PITCH_L] | ((this.regs[base + PITCH_H] & 63) << 8);
  }
}
