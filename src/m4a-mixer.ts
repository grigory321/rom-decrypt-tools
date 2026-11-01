import { check } from './binary.js';
import { M4aRom } from './m4a-rom.js';
import { M4aSequence } from './m4a-sequence.js';
import { M4aPsg } from './m4a-psg.js';
import type { M4aEvent, M4aPlayback } from './m4a-types.js';
import {
  m4aFrequency,
  m4aPitch,
  m4aVolume,
  pcmEnvelope,
  readM4aWave,
  releaseM4aVoice,
  resolveM4aInstrument,
  type M4aVoice,
} from './m4a-voices.js';

const samplesPerFrame = [
  0, 96, 132, 176, 224, 264, 304, 352, 448, 528, 608, 672, 704,
];
const deltas = [
  0, 1, 4, 9, 16, 25, 36, 49, -64, -49, -36, -25, -16, -9, -4, -1,
];
const signed = (value: number) => (value << 24) >> 24;

export class M4aMixer {
  readonly sequence: M4aSequence;
  readonly psg: M4aPsg;
  readonly voices: M4aVoice[] = [];
  readonly frameSamples: number;
  readonly timerPeriod: number;
  readonly sampleRate: number;
  readonly ringLeft: Int8Array;
  readonly ringRight: Int8Array;
  private readonly polyphony: number;
  private readonly master: number;
  private readonly reverb: number;
  private readonly divFrequency: number;
  private block = 0;

  constructor(
    readonly rom: M4aRom,
    playback: M4aPlayback,
  ) {
    const mode = playback.mode;
    const frequency = (mode >>> 16) & 15;
    this.polyphony = (mode >>> 8) & 15;
    this.master = (mode >>> 12) & 15;
    check(
      frequency >= 1 &&
        frequency <= 12 &&
        this.polyphony >= 1 &&
        this.polyphony <= 12,
      'GBA_M4A_MODE',
    );
    this.frameSamples = samplesPerFrame[frequency];
    this.timerPeriod = Math.floor(280896 / this.frameSamples);
    this.sampleRate = 16777216 / this.timerPeriod;
    const pcmFrequency = Math.floor(
      (597275 * this.frameSamples + 5000) / 10000,
    );
    this.divFrequency = (Math.floor(16777216 / pcmFrequency) + 1) >>> 1;
    this.reverb =
      playback.song.reverb & 128 ? playback.song.reverb & 127 : mode & 127;
    const ringSize = Math.floor(1584 / this.frameSamples) * this.frameSamples;
    this.ringLeft = new Int8Array(ringSize);
    this.ringRight = new Int8Array(ringSize);
    this.psg = new M4aPsg(((mode >>> 20) & 15) - 8);
    this.sequence = new M4aSequence(rom, playback.song);
  }

  get ended(): boolean {
    return (
      this.sequence.ended &&
      this.voices.every((voice) => voice.state === 'off') &&
      (!this.reverb ||
        (!this.ringLeft.some((value) => value !== 0) &&
          !this.ringRight.some((value) => value !== 0)))
    );
  }

  private choose(voice: M4aVoice): boolean {
    const candidates = this.voices.filter(
      (current) =>
        current.state !== 'off' &&
        (voice.hardware < 0
          ? current.hardware < 0
          : current.hardware === voice.hardware),
    );
    if (candidates.length < (voice.hardware < 0 ? this.polyphony : 1)) {
      voice.slot =
        voice.hardware < 0
          ? (Array.from({ length: this.polyphony }, (_, index) => index).find(
              (slot) => !candidates.some((current) => current.slot === slot),
            ) ?? 0)
          : voice.hardware;
      return true;
    }
    const releasing = candidates.filter(
      (current) => current.state === 'release' || current.state === 'echo',
    );
    const ranked = (releasing.length ? releasing : candidates).sort(
      (left, right) =>
        left.priority - right.priority ||
        right.track - left.track ||
        right.slot - left.slot,
    );
    const victim = ranked[0];
    if (
      !releasing.length &&
      (victim.priority > voice.priority ||
        (victim.priority === voice.priority && victim.track < voice.track))
    )
      return false;
    voice.slot = victim.slot;
    this.voices.splice(this.voices.indexOf(victim), 1);
    return true;
  }

  private async note(event: Extract<M4aEvent, { type: 'note' }>) {
    const track = this.sequence.tracks[event.track];
    const instrument = await resolveM4aInstrument(
      this.rom,
      event.instrument,
      event.key,
    );
    const kind = instrument.bytes[0] & 7;
    check(
      !(instrument.bytes[0] & 0x30) || kind === 0,
      'GBA_M4A_INSTRUMENT',
      'Unsupported PSG instrument flags.',
    );
    const volume = m4aVolume(track, event.velocity, instrument.pan);
    const voice: M4aVoice = {
      track: event.track,
      key: event.key,
      velocity: event.velocity,
      gate: event.gate,
      priority: Math.min(255, this.sequence.song.priority + event.priority),
      tone: instrument.bytes,
      pitchKey: instrument.key,
      pan: instrument.pan,
      state: 'attack',
      envelope: 0,
      echoVolume: event.echoVolume,
      echoLength: event.echoLength,
      counter: 0,
      goal: Math.min(15, (volume[0] + volume[1]) >> 4),
      phase: 0,
      position: event.sampleStart,
      compressed: !!(instrument.bytes[0] & 32),
      wave: null,
      data: new Uint8Array(0),
      dataOffset: -1,
      fixed: !!(instrument.bytes[0] & 8),
      reverse: !!(instrument.bytes[0] & 16),
      hardware: kind - 1,
      slot: -1,
      started: false,
      psgFrequency: -1,
      psgLeft: -1,
      psgRight: -1,
      echoRatio: event.echoVolume,
      dirty: true,
    };
    if (!this.choose(voice)) return;
    if (kind === 0) {
      const pointer = new DataView(
        voice.tone.buffer,
        voice.tone.byteOffset,
        12,
      ).getUint32(4, true);
      const wave = await readM4aWave(
        this.rom,
        pointer,
        !!(voice.tone[0] & 0x30),
      );
      check(
        !(voice.tone[0] & 32) || wave.compressed,
        'GBA_M4A_SAMPLE',
        'Compressed tone has no original encoded wave.',
      );
      voice.wave = wave;
      voice.compressed = wave.compressed;
      check(
        event.sampleStart < voice.wave.size,
        'GBA_M4A_SAMPLE',
        'Sample start is outside original wave.',
      );
      if (voice.reverse)
        voice.position = voice.wave.size - 1 - event.sampleStart;
    } else {
      check(
        voice.tone[8] <= 7 &&
          voice.tone[9] <= 7 &&
          voice.tone[10] <= 15 &&
          voice.tone[11] <= 7,
        'GBA_M4A_INSTRUMENT',
        'Invalid PSG envelope.',
      );
      voice.echoVolume = (voice.goal * voice.echoVolume + 255) >> 8;
      await this.psg.start(voice, this.rom);
    }
    this.voices.unshift(voice);
    track.lfoRemaining = event.lfoDelay;
    if (event.lfoDelay) {
      track.lfoPhase = 0;
      track.modulation = 0;
    }
  }

  private async events(events: readonly M4aEvent[]) {
    for (const event of events) {
      if (event.type === 'tick') {
        for (const voice of this.voices)
          if (voice.state !== 'off' && voice.gate && --voice.gate === 0)
            releaseM4aVoice(voice);
      } else if (event.type === 'note') await this.note(event);
      else if (event.type === 'end') {
        for (const voice of this.voices)
          if (voice.track === event.track) releaseM4aVoice(voice);
      } else if (event.type === 'release') {
        const voice = this.voices.find(
          (current) =>
            current.track === event.track &&
            current.key === event.key &&
            current.state !== 'off' &&
            current.state !== 'release' &&
            current.state !== 'echo',
        );
        if (voice) releaseM4aVoice(voice);
      } else this.psg.port(event.offset, event.value);
    }
  }

  private async value(
    voice: M4aVoice,
    position: number,
    neighbor = false,
  ): Promise<number> {
    const wave = voice.wave;
    check(wave !== null, 'GBA_M4A_SAMPLE');
    if (
      neighbor &&
      !voice.compressed &&
      (position === -1 || position === wave.size)
    )
      return signed(await this.rom.byte(wave.offset + position));
    if (position < 0) return 0;
    if (position >= wave.size && !(neighbor && position === wave.size)) {
      if (!wave.loop || voice.reverse) return 0;
      position =
        wave.loopStart +
        ((position - wave.loopStart) % (wave.size - wave.loopStart));
    }
    if (
      position < voice.dataOffset ||
      position >= voice.dataOffset + voice.data.length
    ) {
      if (voice.compressed) {
        const start = Math.floor(position / 64) * 64;
        const encoded = await this.rom.bytes(
          wave.offset + (start / 64) * 33,
          33,
        );
        const decoded = new Uint8Array(64);
        let accumulator = signed(encoded[0]);
        decoded[0] = accumulator;
        for (let index = 1; index < 64; index++) {
          const nibble =
            index === 1
              ? encoded[1] & 15
              : index & 1
                ? encoded[(index + 1) >> 1] & 15
                : encoded[(index >> 1) + 1] >> 4;
          accumulator = signed(accumulator + deltas[nibble]);
          decoded[index] = accumulator;
        }
        voice.data = decoded;
        voice.dataOffset = start;
      } else {
        voice.dataOffset = Math.floor(position / 4096) * 4096;
        voice.data = await this.rom.bytes(
          wave.offset + voice.dataOffset,
          Math.min(4096, wave.size - voice.dataOffset),
        );
      }
    }
    return signed(voice.data[position - voice.dataOffset]);
  }

  private async mix(voice: M4aVoice, left: Int8Array, right: Int8Array) {
    const wave = voice.wave;
    check(wave !== null, 'GBA_M4A_SAMPLE');
    const track = this.sequence.tracks[voice.track];
    const pitch = m4aPitch(track, voice.pitchKey);
    const frequency = m4aFrequency(wave.frequency, pitch.key, pitch.fine);
    const step = Number(
      (BigInt(this.divFrequency) * BigInt(frequency)) & 0xffffffffn,
    );
    const envelope = ((this.master + 1) * voice.envelope) >> 4;
    const volume = m4aVolume(track, voice.velocity, voice.pan);
    const leftGain = (volume[0] * envelope) >> 8;
    const rightGain = (volume[1] * envelope) >> 8;
    for (let index = 0; index < this.frameSamples; index++) {
      this.rom.checkCurrent();
      const first = await this.value(voice, voice.position);
      const next = voice.fixed
        ? first
        : await this.value(
            voice,
            voice.position + (voice.reverse ? -1 : 1),
            true,
          );
      const sample = voice.fixed
        ? first
        : first + (Math.imul(voice.phase, next - first) >> 23);
      left[index] += (sample * leftGain) >> 8;
      right[index] += (sample * rightGain) >> 8;
      const phase = (voice.phase + step) >>> 0;
      const advance = voice.fixed ? 1 : phase >>> 23;
      voice.phase = voice.fixed ? 0 : (phase & 0xc07fffff) >>> 0;
      voice.position += voice.reverse ? -advance : advance;
      if (voice.position < 0 || voice.position >= wave.size) {
        if (wave.loop && !voice.reverse)
          voice.position =
            wave.loopStart +
            ((voice.position - wave.loopStart) % (wave.size - wave.loopStart));
        else {
          voice.state = 'off';
          break;
        }
      }
    }
  }

  async render(): Promise<Float32Array[] | null> {
    this.rom.checkCurrent();
    if (this.ended) return null;
    await this.sequence.frame(this.block, (events) => this.events(events));
    for (const voice of this.voices) if (voice.hardware < 0) pcmEnvelope(voice);
    for (let index = this.voices.length - 1; index >= 0; index--) {
      const voice = this.voices[index];
      if (voice.state !== 'off') continue;
      if (
        voice.hardware >= 0 &&
        !this.voices.some(
          (current) =>
            current.hardware === voice.hardware && current.state !== 'off',
        )
      )
        this.psg.apu.channels[voice.hardware].enabled = false;
      this.voices.splice(index, 1);
    }
    this.psg.update(this.voices, this.sequence.tracks);
    if (this.ended) return null;
    const start = (this.block * this.frameSamples) % this.ringLeft.length;
    const next = (start + this.frameSamples) % this.ringLeft.length;
    const left = new Int8Array(this.frameSamples);
    const right = new Int8Array(this.frameSamples);
    for (let index = 0; index < this.frameSamples; index++) {
      const sum =
        this.ringLeft[start + index] +
        this.ringRight[start + index] +
        this.ringLeft[next + index] +
        this.ringRight[next + index];
      const value = (sum * this.reverb) >> 9;
      left[index] = value < 0 ? value + 1 : value;
      right[index] = left[index];
    }
    for (const voice of this.voices)
      if (voice.hardware < 0 && voice.state !== 'off')
        await this.mix(voice, left, right);
    this.ringLeft.set(left, start);
    this.ringRight.set(right, start);
    const outputLeft = new Float32Array(this.frameSamples);
    const outputRight = new Float32Array(this.frameSamples);
    for (let index = 0; index < this.frameSamples; index++) {
      const psg = this.psg.sample(this.sampleRate);
      outputLeft[index] = Math.max(
        -1,
        Math.min(511 / 512, left[index] / 128 + psg[0]),
      );
      outputRight[index] = Math.max(
        -1,
        Math.min(511 / 512, right[index] / 128 + psg[1]),
      );
    }
    for (let index = this.voices.length - 1; index >= 0; index--)
      if (this.voices[index].state === 'off') this.voices.splice(index, 1);
    this.block++;
    return [outputLeft, outputRight];
  }
}
