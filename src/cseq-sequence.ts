import { bounds, check } from './binary.js';
import type { ByteSource } from './contracts.js';
import type { CseqPlayback } from './cseq-types.js';
import { cseqSigned8, cseqSigned16 } from './cseq-tables.js';

interface CseqStack {
  kind: 'call' | 'loop';
  position: number;
  count: number;
}
interface CseqRamp {
  command: number;
  start: number;
  target: number;
  length: number;
  elapsed: number;
}
export interface CseqTrack {
  number: number;
  position: number;
  wait: number;
  waitVoice: boolean;
  ended: boolean;
  stack: CseqStack[];
  bank: number;
  program: number;
  priority: number;
  volume: number;
  expression: number;
  pan: number;
  initialPan: number;
  transpose: number;
  bend: number;
  bendRange: number;
  noteWait: boolean;
  tie: boolean;
  monophonic: boolean;
  muted: boolean;
  damper: boolean;
  velocityRange: number;
  porta: boolean;
  portaKey: number;
  portaTime: number;
  sweepPitch: number;
  attack: number;
  decay: number;
  sustain: number;
  hold: number;
  release: number;
  modType: number;
  modDepth: number;
  modSpeed: number;
  modRange: number;
  modDelay: number;
  modPhase: number;
  modPeriod: number;
  mainSend: number;
  comparison: boolean;
  ramps: CseqRamp[];
}
export interface CseqSink {
  note(
    track: CseqTrack,
    key: number,
    velocity: number,
    length: number,
  ): Promise<boolean>;
  release(track: CseqTrack): void;
  tick(track: CseqTrack): void;
  active(track: CseqTrack): boolean;
  warn(command: number, detail?: string): void;
}
interface CseqCommand {
  op: number;
  value: number;
  extra: number;
  sub: number;
  inner?: CseqCommand;
  duration?: number;
}

export class CseqReader {
  private pages = new Map<number, Uint8Array>();
  constructor(
    readonly source: ByteSource,
    readonly checkCurrent: () => void,
  ) {}
  async byte(position: number) {
    this.checkCurrent();
    bounds(this.source.size, position, 1);
    const page = Math.floor(position / 4096) * 4096;
    let bytes = this.pages.get(page);
    if (!bytes) {
      const length = Math.min(4096, this.source.size - page);
      bytes = await this.source.read(page, length);
      this.checkCurrent();
      check(bytes.length === length, 'CSEQ_TRUNCATED');
      if (this.pages.size >= 16) {
        const oldest = this.pages.keys().next().value;
        if (oldest !== undefined) this.pages.delete(oldest);
      }
      this.pages.set(page, bytes);
    }
    return bytes[position - page];
  }
}

export class CseqSequence {
  readonly tracks: CseqTrack[] = [];
  readonly variables = Array<number>(32).fill(-1);
  tempo = 120;
  timebase = 48;
  masterVolume = 127;
  allocated: number;
  loop = false;
  loopStart = 0;
  loopEnd = 0;
  private rng = 0x12345678;
  private states = new Map<string, number>();
  private checkpoint = '';
  private checkpointFrame = 0;
  private checkpointPower = 1;
  private checkpointDistance = 0;
  private instructions = 0;

  constructor(
    readonly reader: CseqReader,
    readonly playback: CseqPlayback,
    readonly sink: CseqSink,
  ) {
    this.allocated = playback.allocatedTracks | 1;
    this.open(0, playback.startOffset);
  }
  get ended() {
    return this.tracks.every((track) => track.ended);
  }
  private open(number: number, position: number) {
    check(Number.isInteger(number) && number >= 0 && number < 16, 'CSEQ_TRACK');
    check(
      (this.allocated & (1 << number)) !== 0,
      'CSEQ_TRACK',
      'Track is not allocated',
    );
    bounds(this.reader.source.size, position, 1);
    if (this.tracks.some((track) => track.number === number && !track.ended))
      return;
    const old = this.tracks.findIndex((track) => track.number === number);
    const track: CseqTrack = {
      number,
      position,
      wait: 0,
      waitVoice: false,
      ended: false,
      stack: [],
      bank: 0,
      program: 0,
      priority: (this.playback.channelPriority + 64) & 255,
      volume: 127,
      expression: 127,
      pan: 0,
      initialPan: 0,
      transpose: 0,
      bend: 0,
      bendRange: 2,
      noteWait: true,
      tie: false,
      monophonic: false,
      muted: false,
      damper: false,
      velocityRange: 127,
      porta: false,
      portaKey: 60,
      portaTime: 0,
      sweepPitch: 0,
      attack: 255,
      decay: 255,
      sustain: 255,
      hold: 255,
      release: 255,
      modType: 0,
      modDepth: 0,
      modSpeed: 16,
      modRange: 1,
      modDelay: 0,
      modPhase: 0,
      modPeriod: 0,
      mainSend: 127,
      comparison: true,
      ramps: [],
    };
    if (old < 0) this.tracks.push(track);
    else this.tracks[old] = track;
  }
  private random() {
    this.rng = (Math.imul(this.rng, 0x19660d) + 0x3c6ef35f) >>> 0;
    return this.rng >>> 16;
  }
  private async u8(track: CseqTrack) {
    return this.reader.byte(track.position++);
  }
  private async uint(track: CseqTrack, count: number) {
    let value = 0;
    for (let index = 0; index < count; index++)
      value = value * 256 + (await this.u8(track));
    return value;
  }
  private async variable(track: CseqTrack) {
    let value = 0;
    for (let index = 0; index < 5; index++) {
      const byte = await this.u8(track);
      value = value * 128 + (byte & 127);
      check(value <= 0x7fffffff, 'CSEQ_VALUE');
      if (!(byte & 128)) return value;
    }
    check(false, 'CSEQ_VALUE', 'Oversized variable length operand');
  }
  private async parse(
    track: CseqTrack,
    depth = 0,
    omitted = false,
    evaluate = true,
  ): Promise<CseqCommand> {
    check(depth < 8, 'CSEQ_COMMAND', 'Prefix nesting');
    const op = await this.u8(track);
    const result: CseqCommand = { op, value: 0, extra: 0, sub: 0 };
    if (op === 0xa0 || op === 0xa1) {
      const inner = await this.parse(track, depth + 1, true, evaluate);
      if (op === 0xa0) {
        const low = cseqSigned16(await this.uint(track, 2));
        const high = cseqSigned16(await this.uint(track, 2));
        const span = high - low + 1;
        check(span > 0, 'CSEQ_VALUE', 'Empty random range');
        inner.value = low + (evaluate ? this.random() % span : 0);
      } else inner.value = this.variables[(await this.u8(track)) & 31];
      return inner;
    }
    if (op >= 0xa2 && op <= 0xa5) {
      result.inner = await this.parse(
        track,
        depth + 1,
        false,
        evaluate && (op !== 0xa2 || track.comparison),
      );
      if (op === 0xa3)
        result.duration = cseqSigned16(await this.uint(track, 2));
      if (op === 0xa4) {
        const low = cseqSigned16(await this.uint(track, 2));
        const high = cseqSigned16(await this.uint(track, 2));
        check(high >= low, 'CSEQ_VALUE');
        result.duration =
          low + (evaluate ? this.random() % (high - low + 1) : 0);
      }
      if (op === 0xa5)
        result.duration = this.variables[(await this.u8(track)) & 31];
      return result;
    }
    if (op < 0x80 || op === 0x88) result.extra = await this.u8(track);
    if (op === 0xf0) {
      result.sub = await this.u8(track);
      if (result.sub >= 0x80 && result.sub <= 0x95)
        result.extra = await this.u8(track);
      else
        check(
          (result.sub >= 0xa0 && result.sub <= 0xb1) ||
            (result.sub >= 0xe0 && result.sub <= 0xe6),
          'CSEQ_COMMAND',
          'Extended ' + result.sub.toString(16),
        );
    }
    const variableOperand = op < 0x80 || op === 0x80 || op === 0x81;
    const addressOperand = op === 0x88 || op === 0x89 || op === 0x8a;
    const byteOperand =
      (op >= 0xb0 && op <= 0xb6) || (op >= 0xbd && op <= 0xdf);
    const wordOperand = [0xe0, 0xe1, 0xe3, 0xe4, 0xfe].includes(op);
    check(
      variableOperand ||
        addressOperand ||
        byteOperand ||
        wordOperand ||
        op === 0xf0 ||
        [0xfb, 0xfc, 0xfd, 0xff].includes(op),
      'CSEQ_COMMAND',
      op.toString(16),
    );
    if (omitted) return result;
    if (variableOperand) result.value = await this.variable(track);
    else if (addressOperand) result.value = await this.uint(track, 3);
    else if (byteOperand) result.value = await this.u8(track);
    else if (wordOperand) result.value = await this.uint(track, 2);
    else if (op === 0xf0)
      result.value = await this.uint(
        track,
        result.sub >= 0xa0 && result.sub <= 0xb1 ? 1 : 2,
      );
    return result;
  }
  private rampValue(track: CseqTrack, op: number): number | null {
    if (op === 0xc0) return track.pan + 64;
    if (op === 0xc1) return track.volume;
    if (op === 0xc2) return this.masterVolume;
    if (op === 0xc4) return track.bend;
    if (op === 0xd5) return track.expression;
    if (op === 0xca) return track.modDepth;
    if (op === 0xe1) return this.tempo;
    return null;
  }
  private control(track: CseqTrack, op: number, value: number) {
    if (op === 0xc0) track.pan = value - 64;
    if (op === 0xc1) track.volume = value;
    if (op === 0xc2) this.masterVolume = value;
    if (op === 0xc4) track.bend = cseqSigned8(value);
    if (op === 0xd5) track.expression = value;
    if (op === 0xca) track.modDepth = value;
    if (op === 0xe1) {
      check(
        value > 0 && value <= 32767,
        'CSEQ_TEMPO',
        'Frozen or invalid tempo',
      );
      this.tempo = value;
    }
  }
  private async execute(track: CseqTrack, command: CseqCommand): Promise<void> {
    const { op, value, extra, sub } = command;
    if (command.inner) {
      if (op === 0xa2) {
        if (track.comparison) await this.execute(track, command.inner);
        return;
      }
      const start = this.rampValue(track, command.inner.op);
      const duration = command.duration ?? 0;
      if (start !== null && duration > 0) {
        track.ramps = track.ramps.filter(
          (ramp) => ramp.command !== command.inner?.op,
        );
        track.ramps.push({
          command: command.inner.op,
          start,
          target: command.inner.value,
          length: duration,
          elapsed: 0,
        });
      } else {
        if (start === null && duration > 0)
          this.sink.warn(
            op,
            'Time wrapper for command ' + command.inner.op.toString(16),
          );
        await this.execute(track, command.inner);
      }
      return;
    }
    if (op < 0x80) {
      check(value >= 0, 'CSEQ_VALUE', 'Uninitialized note length');
      const key = (op + track.transpose) & 255;
      const started =
        !track.muted && (await this.sink.note(track, key, extra, value));
      if (track.noteWait) {
        track.wait = value;
        track.waitVoice = value === 0 && started;
      }
      return;
    }
    if (this.rampValue(track, op) !== null) {
      this.control(track, op, value);
      return;
    }
    switch (op) {
      case 0x80:
        check(value >= 0, 'CSEQ_VALUE');
        track.wait = value;
        return;
      case 0x81:
        track.program = value & 127;
        if (value >>> 8) track.bank = (value >>> 8) & 3;
        return;
      case 0x88:
        this.open(extra, value);
        return;
      case 0x89:
        bounds(this.reader.source.size, value, 1);
        track.position = value;
        return;
      case 0x8a:
        check(track.stack.length < 16, 'CSEQ_STACK');
        bounds(this.reader.source.size, value, 1);
        track.stack.push({ kind: 'call', position: track.position, count: 0 });
        track.position = value;
        return;
      case 0xfd: {
        const entry = track.stack.pop();
        check(entry?.kind === 'call', 'CSEQ_STACK');
        track.position = entry.position;
        return;
      }
      case 0xff:
        track.ended = true;
        this.sink.release(track);
        return;
      case 0xfe:
        this.allocated = value | 1;
        return;
      case 0xb0:
        this.timebase = value || 48;
        return;
      case 0xb1:
        track.hold = value;
        return;
      case 0xb2:
        track.monophonic = !!value;
        return;
      case 0xb3:
        track.velocityRange = value;
        return;
      case 0xb6:
        check(value < this.playback.banks.length, 'CSEQ_BANK_MISSING');
        track.bank = value;
        return;
      case 0xbd:
        track.modPhase = value;
        return;
      case 0xc3:
        track.transpose = cseqSigned8(value);
        return;
      case 0xc5:
        track.bendRange = value;
        return;
      case 0xc6:
        track.priority = (this.playback.channelPriority + value) & 255;
        return;
      case 0xc7:
        track.noteWait = !!value;
        return;
      case 0xc8:
        track.tie = !!value;
        this.sink.release(track);
        return;
      case 0xc9:
        track.portaKey = (value + track.transpose) & 255;
        track.porta = true;
        return;
      case 0xcb:
        track.modSpeed = value;
        return;
      case 0xcc:
        track.modType = value;
        if (value > 2) this.sink.warn(op, 'Modulation type ' + value);
        return;
      case 0xcd:
        track.modRange = value;
        return;
      case 0xce:
        track.porta = !!value;
        return;
      case 0xcf:
        track.portaTime = value;
        return;
      case 0xd0:
        track.attack = value;
        return;
      case 0xd1:
        track.decay = value;
        return;
      case 0xd2:
        track.sustain = value;
        return;
      case 0xd3:
        track.release = value;
        return;
      case 0xd4:
        check(track.stack.length < 16, 'CSEQ_STACK');
        track.stack.push({
          kind: 'loop',
          position: track.position,
          count: value,
        });
        return;
      case 0xfc: {
        const entry = track.stack[track.stack.length - 1];
        check(entry?.kind === 'loop', 'CSEQ_STACK');
        if (entry.count === 0 || --entry.count > 0)
          track.position = entry.position;
        else track.stack.pop();
        return;
      }
      case 0xd6:
        return;
      case 0xdb:
        track.mainSend = value;
        return;
      case 0xdc:
        track.initialPan = value - 64;
        return;
      case 0xdd:
        track.muted = !!value;
        if (value) this.sink.release(track);
        return;
      case 0xdf:
        track.damper = !!value;
        return;
      case 0xe0:
        track.modDelay = value;
        return;
      case 0xe3:
        track.sweepPitch = cseqSigned16(value);
        track.porta = true;
        return;
      case 0xe4:
        track.modPeriod = value;
        return;
      case 0xfb:
        track.attack =
          track.decay =
          track.sustain =
          track.hold =
          track.release =
            255;
        return;
      case 0xf0:
        this.extended(track, sub, extra & 31, cseqSigned16(value));
        return;
      default:
        this.sink.warn(op);
        return;
    }
  }
  private extended(
    track: CseqTrack,
    sub: number,
    index: number,
    value: number,
  ) {
    let variable = this.variables[index];
    if (sub === 0x80) variable = value;
    else if (sub === 0x81) variable += value;
    else if (sub === 0x82) variable -= value;
    else if (sub === 0x83) variable *= value;
    else if (sub === 0x84) {
      if (value) variable = Math.trunc(variable / value);
    } else if (sub === 0x85)
      variable =
        value < 0
          ? variable >> Math.min(31, -value)
          : variable << Math.min(31, value);
    else if (sub === 0x86)
      variable =
        value < 0
          ? -(this.random() % (1 - value))
          : this.random() % (value + 1);
    else if (sub === 0x87) variable &= value;
    else if (sub === 0x88) variable |= value;
    else if (sub === 0x89) variable ^= value;
    else if (sub === 0x8a) variable = ~value;
    else if (sub === 0x8b) {
      if (value) variable %= value;
    } else if (sub >= 0x90 && sub <= 0x95) {
      track.comparison =
        sub === 0x90
          ? variable === value
          : sub === 0x91
            ? variable >= value
            : sub === 0x92
              ? variable > value
              : sub === 0x93
                ? variable <= value
                : sub === 0x94
                  ? variable < value
                  : variable !== value;
      return;
    } else {
      this.sink.warn(0xf0, 'Extended command ' + sub.toString(16));
      return;
    }
    this.variables[index] = cseqSigned16(variable);
  }
  private state() {
    return JSON.stringify([
      this.tempo,
      this.timebase,
      this.masterVolume,
      this.allocated,
      this.variables,
      this.rng,
      this.tracks,
    ]);
  }
  private remember(frame: number) {
    if (this.loop || this.ended || this.tracks.some((track) => track.waitVoice))
      return;
    const state = this.state();
    const first = this.states.get(state);
    if (first !== undefined && frame > first) {
      this.loop = true;
      this.loopStart = first;
      this.loopEnd = frame;
      return;
    }
    if (this.states.size < 2048) this.states.set(state, frame);
    if (state === this.checkpoint && frame > this.checkpointFrame) {
      this.loop = true;
      this.loopStart = this.checkpointFrame;
      this.loopEnd = frame;
      return;
    }
    if (++this.checkpointDistance >= this.checkpointPower) {
      this.checkpoint = state;
      this.checkpointFrame = frame;
      this.checkpointDistance = 0;
      this.checkpointPower *= 2;
    }
  }
  async tick(frame: number) {
    this.reader.checkCurrent();
    this.instructions = 0;
    for (let index = 0; index < this.tracks.length; index++) {
      const track = this.tracks[index];
      this.sink.tick(track);
      for (const ramp of track.ramps) {
        ramp.elapsed++;
        this.control(
          track,
          ramp.command,
          Math.round(
            ramp.start +
              (ramp.target - ramp.start) *
                Math.min(1, ramp.elapsed / ramp.length),
          ),
        );
      }
      track.ramps = track.ramps.filter((ramp) => ramp.elapsed < ramp.length);
      if (track.ended) continue;
      if (track.waitVoice && this.sink.active(track)) continue;
      track.waitVoice = false;
      if (track.wait > 0 && --track.wait > 0) continue;
      while (!track.wait && !track.waitVoice && !track.ended) {
        this.reader.checkCurrent();
        check(++this.instructions <= 32768, 'CSEQ_ZERO_TIME_LOOP');
        await this.execute(track, await this.parse(track));
      }
    }
    this.remember(frame);
  }
}
