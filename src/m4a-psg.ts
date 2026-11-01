import { check } from './binary.js';
import { GameBoyApu } from './gameboy-apu.js';
import { M4aRom } from './m4a-rom.js';
import { m4aPitch, m4aVolume, type M4aVoice } from './m4a-voices.js';
import type { M4aTrack } from './m4a-types.js';

const periods = [
  -2004, -1891, -1785, -1685, -1591, -1501, -1417, -1337, -1262, -1192, -1125,
  -1062,
];
const waveVolumes = [
  0, 0, 0x60, 0x60, 0x60, 0x60, 0x40, 0x40, 0x40, 0x40, 0x80, 0x80, 0x80, 0x80,
  0x20, 0x20,
];
const bases = [0xff10, 0xff15, 0xff1a, 0xff1f];
const registers = new Map([
  [0, 0xff10],
  [2, 0xff11],
  [3, 0xff12],
  [4, 0xff13],
  [5, 0xff14],
  [8, 0xff16],
  [9, 0xff17],
  [12, 0xff18],
  [13, 0xff19],
  [16, 0xff1a],
  [18, 0xff1b],
  [19, 0xff1c],
  [20, 0xff1d],
  [21, 0xff1e],
  [24, 0xff20],
  [25, 0xff21],
  [28, 0xff22],
  [29, 0xff23],
  [32, 0xff24],
  [33, 0xff25],
]);

export function m4aPsgFrequency(
  kind: number,
  key: number,
  fine: number,
  quantization: number,
): number {
  if (kind === 4) {
    const index = Math.max(0, Math.min(59, key - 21));
    return index < 56
      ? (13 - Math.floor(index / 4)) * 16 + 7 - (index % 4)
      : 59 - index;
  }
  let index = key <= 35 ? 0 : key - 36;
  if (key <= 35) fine = 0;
  if (index > 130) {
    index = 130;
    fine = 255;
  }
  const period = (note: number) => periods[note % 12] >> Math.floor(note / 12);
  const first = period(index);
  let value = 2048 + first + ((fine * (period(index + 1) - first)) >> 8);
  if (quantization < 64) value = (value + 2) & 0x7fc;
  else if (quantization < 128) value = (value + 1) & 0x7fe;
  return value;
}

export class M4aPsg {
  readonly apu = new GameBoyApu({ gbaWaveVolume: true });
  private cycles = 0;
  private frame = 0;

  constructor(private readonly pwm = 1) {
    this.apu.write(0xff26, 128);
    this.apu.write(0xff24, 0x77);
    this.apu.write(0xff25, 0);
  }

  async start(voice: M4aVoice, rom: M4aRom) {
    const kind = voice.tone[0] & 7;
    voice.hardware = kind - 1;
    const base = bases[voice.hardware];
    const word = new DataView(
      voice.tone.buffer,
      voice.tone.byteOffset,
      12,
    ).getUint32(4, true);
    if (kind === 3) {
      const wave = await rom.bytes(rom.offset(word, 16), 16);
      this.apu.write(base, 0);
      for (let index = 0; index < 16; index++)
        this.apu.write(0xff30 + index, wave[index]);
      this.apu.write(base, 128);
      this.apu.write(base + 1, voice.tone[2]);
    } else if (kind < 3) {
      if (kind === 1)
        this.apu.write(
          base,
          voice.tone[3] & 128 || !(voice.tone[3] & 0x70) ? 8 : voice.tone[3],
        );
      this.apu.write(base + 1, ((word & 3) << 6) | (voice.tone[2] & 63));
    } else this.apu.write(base + 1, voice.tone[2] & 63);
    voice.state = voice.tone[8]
      ? 'attack'
      : voice.tone[9]
        ? 'decay'
        : 'sustain';
    voice.counter = voice.tone[8] || voice.tone[9] || 7;
    voice.envelope = voice.tone[8]
      ? 0
      : voice.tone[9]
        ? voice.goal
        : (voice.goal * voice.tone[10] + 15) >> 4;
    if (voice.state === 'sustain' && !voice.tone[10]) this.tail(voice);
    voice.dirty = true;
  }

  private tail(voice: M4aVoice) {
    voice.echoVolume = (voice.goal * voice.echoRatio + 255) >> 8;
    voice.envelope = voice.echoVolume;
    voice.state = voice.echoVolume ? 'echo' : 'off';
    voice.dirty = true;
  }

  private envelope(voice: M4aVoice) {
    if (
      voice.counter === 0 ||
      (voice.state === 'release' && voice.tone[11] === 0)
    ) {
      const sustain = (voice.goal * voice.tone[10] + 15) >> 4;
      if (voice.state === 'attack') {
        voice.envelope++;
        voice.counter = voice.tone[8];
        if (voice.envelope >= voice.goal) {
          voice.envelope = voice.goal;
          voice.state = voice.tone[9] ? 'decay' : 'sustain';
          voice.counter = voice.tone[9] || 7;
          if (!voice.tone[9]) {
            voice.envelope = sustain;
            if (!voice.tone[10]) this.tail(voice);
          }
          voice.dirty = true;
        }
      } else if (voice.state === 'decay') {
        voice.envelope--;
        voice.counter = voice.tone[9];
        if (voice.envelope <= sustain) {
          voice.envelope = sustain;
          voice.state = 'sustain';
          voice.counter = 7;
          voice.dirty = true;
          if (!voice.tone[10]) this.tail(voice);
        }
      } else if (voice.state === 'release') {
        if (voice.tone[11]) voice.envelope--;
        else voice.envelope = 0;
        voice.counter = voice.tone[11];
        if (voice.envelope <= 0) this.tail(voice);
      } else if (voice.state === 'sustain') {
        voice.envelope = sustain;
        voice.counter = 7;
      }
      if (voice.hardware === 2) voice.dirty = true;
    }
    voice.counter = (voice.counter - 1) & 255;
  }

  private envelopeActive(voice: M4aVoice): boolean {
    return voice.state !== 'echo' && voice.state !== 'off';
  }

  update(voices: M4aVoice[], tracks: M4aTrack[]) {
    this.frame++;
    let routing = this.apu.registers[0x15];
    for (const voice of voices) {
      if (voice.hardware < 0) continue;
      const base = bases[voice.hardware];
      const track = tracks[voice.track];
      const volume = m4aVolume(track, voice.velocity, voice.pan);
      const goal = Math.min(15, (volume[0] + volume[1]) >> 4);
      if (volume[0] !== voice.psgLeft || volume[1] !== voice.psgRight) {
        voice.psgLeft = volume[0];
        voice.psgRight = volume[1];
        voice.goal = goal;
        voice.dirty = true;
      }
      if (voice.state === 'echo' && voice.started) {
        voice.echoLength = (voice.echoLength - 1) & 255;
        if ((voice.echoLength << 24) >> 24 <= 0) {
          voice.state = 'off';
          voice.dirty = true;
        }
      } else if (this.envelopeActive(voice)) {
        this.envelope(voice);
        if (this.frame % 15 === 0 && this.envelopeActive(voice))
          this.envelope(voice);
      }
      if (voice.state === 'off') {
        this.apu.channels[voice.hardware].enabled = false;
        continue;
      }
      if (voice.dirty) {
        const mask = 17 << voice.hardware;
        let pan = mask;
        if (volume[1] >= volume[0] && Math.floor(volume[1] / 2) >= volume[0])
          pan = 1 << voice.hardware;
        else if (
          volume[0] > volume[1] &&
          Math.floor(volume[0] / 2) >= volume[1]
        )
          pan = 16 << voice.hardware;
        routing = (routing & ~mask) | pan;
      }
      const pitch = m4aPitch(track, voice.pitchKey);
      const period = m4aPsgFrequency(
        voice.hardware + 1,
        pitch.key,
        pitch.fine,
        voice.tone[0] & 8 ? this.pwm * 64 : 128,
      );
      const wave = voice.hardware === 2;
      const noise = voice.hardware === 3;
      const high = (noise ? 0 : period >> 8) | (voice.tone[2] ? 64 : 0);
      if (period !== voice.psgFrequency) {
        voice.psgFrequency = period;
        this.apu.write(
          base + 3,
          noise ? period | ((voice.tone[4] & 1) << 3) : period & 255,
        );
        this.apu.write(base + 4, high);
      }
      if (voice.dirty) {
        const envelope = wave
          ? waveVolumes[Math.max(0, Math.min(15, voice.envelope))]
          : (Math.max(0, Math.min(15, voice.envelope)) << 4) |
            (voice.state === 'decay' || voice.state === 'release' ? 0 : 8) |
            (voice.state === 'attack'
              ? voice.tone[8] & 7
              : voice.state === 'decay'
                ? voice.tone[9] & 7
                : voice.state === 'release'
                  ? voice.tone[11] & 7
                  : 0);
        this.apu.write(base + 2, envelope);
        if (!wave || !voice.started) this.apu.write(base + 4, high | 128);
        if (voice.hardware === 0 && !(this.apu.registers[0] & 8))
          this.apu.write(base + 4, high | 128);
        voice.started = true;
        voice.dirty = false;
      }
    }
    this.apu.write(0xff25, routing);
  }

  port(offset: number, value: number) {
    const register =
      offset >= 0x30 && offset <= 0x3f
        ? 0xff30 + offset - 0x30
        : registers.get(offset);
    check(
      register !== undefined &&
        !(offset === 16 && value & 96) &&
        !(offset >= 0x30 && offset <= 0x3f && this.apu.channels[2].enabled),
      'GBA_M4A_COMMAND',
      'Unsupported sound PORT ' + offset,
    );
    this.apu.write(register, value);
  }

  sample(rate: number): [number, number] {
    this.cycles += 4194304 / rate;
    const count = Math.floor(this.cycles);
    this.cycles -= count;
    this.apu.advance(count);
    this.apu.sampleRaw();
    return [this.apu.sampleLeft * 0.9375, this.apu.sampleRight * 0.9375];
  }
}
