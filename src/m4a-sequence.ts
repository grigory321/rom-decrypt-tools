import { check } from './binary.js';
import { M4aRom } from './m4a-rom.js';
import type { M4aEvent, M4aSong, M4aTrack } from './m4a-types.js';

export const m4aClock = [
  0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16, 17, 18, 19, 20, 21,
  22, 23, 24, 28, 30, 32, 36, 40, 42, 44, 48, 52, 54, 56, 60, 64, 66, 68, 72,
  76, 78, 80, 84, 88, 90, 92, 96,
];
const signed = (value: number) => (value << 24) >> 24;

function trackAt(pc: number): M4aTrack {
  const instrument = new Uint8Array(12);
  instrument[0] = 1;
  return {
    pc,
    ended: false,
    wait: 0,
    running: 0,
    key: 0,
    velocity: 0,
    instrument,
    volume: 0,
    pan: 0,
    bend: 0,
    bendRange: 2,
    keyShift: 0,
    tune: 0,
    priority: 0,
    lfoSpeed: 22,
    lfoDepth: 0,
    lfoType: 0,
    lfoPhase: 0,
    lfoDelay: 0,
    lfoRemaining: 0,
    modulation: 0,
    echoVolume: 0,
    echoLength: 0,
    sampleStart: 0,
    repeat: 0,
    extendedWait: 0,
    stack: [],
    looped: false,
  };
}

export class M4aSequence {
  readonly tracks: M4aTrack[];
  readonly memory = new Uint8Array(16);
  readonly events: M4aEvent[] = [];
  private tempo = 150;
  private accumulator = 0;
  private readonly states = new Map<
    string,
    { frame: number; jumps: number[] }
  >();
  private readonly jumps: number[];
  loop = false;
  loopStart = 0;
  loopEnd = 0;

  constructor(
    readonly rom: M4aRom,
    readonly song: M4aSong,
  ) {
    check(
      song.blocks === 0 && song.tracks.length > 0 && song.tracks.length <= 16,
      'GBA_M4A_SEQUENCE',
    );
    this.tracks = song.tracks.map(trackAt);
    this.jumps = song.tracks.map(() => 0);
  }

  get ended(): boolean {
    return this.tracks.every((track) => track.ended);
  }

  async frame(
    nativeFrame: number,
    dispatch?: (events: readonly M4aEvent[]) => Promise<void>,
  ): Promise<readonly M4aEvent[]> {
    this.events.length = 0;
    this.accumulator += this.tempo;
    let ticks = 0;
    while (this.accumulator >= 150) {
      check(++ticks <= 4, 'GBA_M4A_SEQUENCE', 'Sequence tick budget exceeded.');
      this.accumulator -= 150;
      this.events.push({ type: 'tick' });
      if (dispatch) await dispatch([{ type: 'tick' }]);
      for (let index = 0; index < this.tracks.length; index++) {
        const track = this.tracks[index];
        if (track.ended) continue;
        const start = this.events.length;
        await this.advance(track, index);
        if (dispatch) await dispatch(this.events.slice(start));
        this.lfo(track);
      }
    }
    if (!this.loop && !this.ended) {
      const state = JSON.stringify([
        this.tempo,
        this.accumulator,
        [...this.memory],
        this.tracks.map((track) => [
          track.pc,
          track.ended,
          track.wait,
          track.running,
          track.key,
          track.velocity,
          [...track.instrument],
          track.volume,
          track.pan,
          track.bend,
          track.bendRange,
          track.keyShift,
          track.tune,
          track.priority,
          track.lfoSpeed,
          track.lfoDepth,
          track.lfoType,
          track.lfoPhase,
          track.lfoDelay,
          track.lfoRemaining,
          track.modulation,
          track.echoVolume,
          track.echoLength,
          track.sampleStart,
          track.repeat,
          track.extendedWait,
          track.stack,
        ]),
      ]);
      const prior = this.states.get(state);
      if (
        prior &&
        this.tracks.every(
          (track, index) =>
            track.ended || this.jumps[index] > prior.jumps[index],
        )
      ) {
        this.loop = true;
        this.loopStart = prior.frame;
        this.loopEnd = nativeFrame + 1;
      } else if (!prior) {
        this.states.set(state, {
          frame: nativeFrame + 1,
          jumps: [...this.jumps],
        });
        if (this.states.size > 8192) {
          const first = this.states.keys().next();
          if (!first.done) this.states.delete(first.value);
        }
      }
    }
    return this.events;
  }

  lfo(track: M4aTrack) {
    if (!track.lfoSpeed || !track.lfoDepth) return;
    if (track.lfoRemaining) {
      track.lfoRemaining--;
      return;
    }
    track.lfoPhase = (track.lfoPhase + track.lfoSpeed) & 255;
    const point =
      signed(track.lfoPhase - 64) >= 0
        ? 128 - track.lfoPhase
        : signed(track.lfoPhase);
    track.modulation = signed((point * track.lfoDepth) >> 6);
  }

  private async next(track: M4aTrack): Promise<number> {
    return this.rom.byte(track.pc++);
  }

  private async pointer(track: M4aTrack): Promise<number> {
    const pointer = await this.rom.word(track.pc);
    track.pc += 4;
    return this.rom.offset(pointer);
  }

  private end(track: M4aTrack, index: number) {
    track.ended = true;
    this.events.push({ type: 'end', track: index });
  }

  private jump(track: M4aTrack, target: number, loop: boolean) {
    if (loop && target <= track.pc) {
      track.looped = true;
      const index = this.tracks.indexOf(track);
      this.jumps[index]++;
    }
    track.pc = target;
  }

  private async memoryCommand(track: M4aTrack) {
    const op = await this.next(track),
      address = await this.next(track),
      data = await this.next(track);
    check(
      op <= 17 &&
        address < 16 &&
        (op < 3 || (op >= 6 && op <= 11) || data < 16),
      'GBA_M4A_SEQUENCE',
      'Invalid shared memory command.',
    );
    if (op < 6) {
      const value = op < 3 ? data : this.memory[data];
      this.memory[address] =
        op % 3 === 0
          ? value
          : op % 3 === 1
            ? this.memory[address] + value
            : this.memory[address] - value;
      return;
    }
    const value = op < 12 ? data : this.memory[data];
    const left = this.memory[address];
    const compare = (op - 6) % 6;
    const match =
      compare === 0
        ? left === value
        : compare === 1
          ? left !== value
          : compare === 2
            ? left > value
            : compare === 3
              ? left >= value
              : compare === 4
                ? left <= value
                : left < value;
    const target = await this.pointer(track);
    if (match) this.jump(track, target, false);
  }

  private async extended(track: M4aTrack, index: number) {
    const op = await this.next(track);
    if (op === 0 || op === 3) {
      this.end(track, index);
      return;
    }
    if (op === 1 || op === 13) {
      const value = await this.rom.word(track.pc);
      track.pc += 4;
      if (op === 13) track.sampleStart = value;
      else new DataView(track.instrument.buffer).setUint32(4, value, true);
      return;
    }
    if (op === 12) {
      const operandOffset = track.pc;
      const low = await this.next(track),
        high = await this.next(track);
      const length = low | (high << 8);
      if (track.extendedWait < length) {
        track.extendedWait++;
        track.pc = operandOffset - 2;
        track.wait = 1;
      } else track.extendedWait = 0;
      return;
    }
    check(op <= 11, 'GBA_M4A_COMMAND', 'XCMD ' + op);
    const value = await this.next(track);
    if (op === 2) track.instrument[0] = value;
    else if (op >= 4 && op <= 7) track.instrument[op + 4] = value;
    else if (op === 8) track.echoVolume = value;
    else if (op === 9) track.echoLength = value;
    else if (op === 10) track.instrument[2] = value;
    else if (op === 11) track.instrument[3] = value;
  }

  private async advance(track: M4aTrack, index: number) {
    let commands = 0;
    while (!track.wait && !track.ended) {
      check(
        ++commands <= 8192,
        'GBA_M4A_SEQUENCE',
        'A control cycle has no wait.',
      );
      let command = await this.rom.byte(track.pc);
      if (command >= 128) {
        track.pc++;
        if (command >= 0xbd) track.running = command;
      } else {
        check(
          track.running >= 0xbd,
          'GBA_M4A_SEQUENCE',
          'Uninitialized running status.',
        );
        command = track.running;
      }
      if (command <= 0xb0) track.wait = m4aClock[command - 0x80];
      else if (
        command === 0xb1 ||
        [0xb6, 0xb7, 0xb8, 0xc6, 0xc7, 0xc9, 0xca, 0xcb].includes(command)
      )
        this.end(track, index);
      else if (command === 0xb2)
        this.jump(track, await this.pointer(track), true);
      else if (command === 0xb3) {
        const target = await this.pointer(track);
        check(
          track.stack.length < 3,
          'GBA_M4A_SEQUENCE',
          'Pattern stack overflow.',
        );
        track.stack.push(track.pc);
        this.jump(track, target, false);
      } else if (command === 0xb4) {
        const target = track.stack.pop();
        if (target !== undefined) track.pc = target;
      } else if (command === 0xb5) {
        const count = await this.next(track),
          target = await this.pointer(track);
        track.repeat = (track.repeat + 1) & 255;
        if (!count || track.repeat < count)
          this.jump(track, target, count === 0);
        else track.repeat = 0;
      } else if (command === 0xb9) await this.memoryCommand(track);
      else if (command === 0xcd) await this.extended(track, index);
      else if (command === 0xce) {
        if ((await this.rom.byte(track.pc)) < 128)
          track.key = await this.next(track);
        this.events.push({ type: 'release', track: index, key: track.key });
      } else if (command >= 0xcf) {
        let gate = m4aClock[command - 0xcf];
        if ((await this.rom.byte(track.pc)) < 128) {
          track.key = await this.next(track);
          if ((await this.rom.byte(track.pc)) < 128) {
            track.velocity = await this.next(track);
            if ((await this.rom.byte(track.pc)) < 128)
              gate = (gate + (await this.next(track))) & 255;
          }
        }
        this.events.push({
          type: 'note',
          priority: track.priority,
          lfoDelay: track.lfoDelay,
          track: index,
          key: track.key,
          velocity: track.velocity,
          gate,
          instrument: track.instrument.slice(),
          sampleStart: track.sampleStart,
          echoVolume: track.echoVolume,
          echoLength: track.echoLength,
        });
      } else if (command === 0xcc)
        this.events.push({
          type: 'port',
          offset: await this.next(track),
          value: await this.next(track),
        });
      else {
        const value = await this.next(track);
        if (command === 0xba) track.priority = value;
        else if (command === 0xbb) this.tempo = value * 2;
        else if (command === 0xbc) track.keyShift = signed(value);
        else if (command === 0xbd) {
          check(value < 128, 'GBA_M4A_INSTRUMENT');
          track.instrument = await this.rom.bytes(
            this.song.bank + value * 12,
            12,
          );
        } else if (command === 0xbe) track.volume = value;
        else if (command === 0xbf) track.pan = value - 64;
        else if (command === 0xc0) track.bend = value - 64;
        else if (command === 0xc1) track.bendRange = value;
        else if (command === 0xc2) track.lfoSpeed = value;
        else if (command === 0xc3) track.lfoDelay = value;
        else if (command === 0xc4) track.lfoDepth = value;
        else if (command === 0xc5) {
          check(value <= 2, 'GBA_M4A_COMMAND');
          track.lfoType = value;
        } else if (command === 0xc8) track.tune = value - 64;
        else check(false, 'GBA_M4A_COMMAND', command.toString(16));
        if ((command === 0xc2 && !value) || (command === 0xc4 && !value)) {
          track.modulation = 0;
          track.lfoPhase = 0;
        }
      }
    }
    if (track.wait) track.wait--;
  }
}
