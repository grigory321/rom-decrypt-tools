import type {
  AudioDecoder,
  ParsedTrack,
  PcmBlock,
  ProgressReporter,
} from './contracts.js';
import { Bin, check } from './binary.js';
import { instrumentAt, waveAt, decodeNitro } from './nitro.js';
import {
  getpitchtbl,
  getvoltbl,
  attackTable,
  sustainTable,
  sineTable,
} from './engine-tables.js';

interface SequenceOverride {
  cmd: number;
  extra: number;
  value: number;
}
type SequenceStackEntry =
  { type: 'call'; pos: number } | { type: 'loop'; pos: number; count: number };
interface NitroWave {
  pcm: Float32Array;
  timer: number;
  loop: boolean;
  loopStart: number;
  loopLength: number;
}
interface SequenceReader extends AudioDecoder {
  read(frames: number): PcmBlock;
  reset(): void;
}

const CLOCK = 33513982,
  CLOCK_PERIOD = (64 * 2728) / CLOCK,
  K = 723,
  THRESHOLD = -K * 128;

const MAX_BLOCK = 16384,
  PCM_LIMIT = 128 * 1024 * 1024,
  BLOCK_BYTES = MAX_BLOCK * 8;

const NONE = 0,
  START = 1,
  ATTACK = 2,
  DECAY = 3,
  SUSTAIN = 4,
  RELEASE = 5;

const VOL = 1,
  PAN = 2,
  TUNE = 4,
  MOD = 8,
  LENGTH = 16;

const clamp = (v: number, a: number, b: number) => Math.max(a, Math.min(b, v));

const signed8 = (v: number) => (v << 24) >> 24,
  signed16 = (v: number) => (v << 16) >> 16;

function attack(v: number) {
  v &= 255;
  if (v & 128) {
    v = 0;
  }
  return v >= 109 ? attackTable[127 - v] : 255 - v;
}

function fall(v: number) {
  v &= 255;
  if (v & 128) {
    v = 0;
  }
  return v === 127
    ? 65535
    : v === 126
      ? 15360
      : v < 50
        ? 2 * v + 1
        : Math.trunc(7680 / (126 - v));
}

function sustain(v: number) {
  v &= 255;
  return sustainTable[v & 128 ? 127 : v];
}

function sine(v: number) {
  v &= 127;
  return v < 32
    ? sineTable[v]
    : v < 64
      ? sineTable[64 - v]
      : v < 96
        ? -sineTable[v - 64]
        : -sineTable[128 - v];
}

function timer(base: number, pitch: number) {
  let p = -pitch,
    shift = Math.floor(p / 768);
  p -= shift * 768;
  return clamp(
    Math.floor(base * (getpitchtbl[p] + 65536) * 2 ** (shift - 16)),
    16,
    65535,
  );
}

function attackStep(ampl: number, rate: number) {
  const old = ampl >> 7;
  do {
    ampl = Math.trunc((ampl * rate) / 256);
  } while (ampl >> 7 === old);
  return ampl;
}

const randomState = (state: number) =>
  (Math.imul(state, 214013) + 2531011) >>> 0;

export const nitroRules = Object.freeze({
  attack,
  fall,
  sustain,
  sine,
  timer,
  attackStep,
  randomState,
});

const ALLOCATION = [
  [4, 5, 6, 7, 2, 0, 3, 1, 8, 9, 10, 11, 14, 12, 15, 13],
  [8, 9, 10, 11, 12, 13],
  [14, 15],
];

const mul7 = (v: number, m: number) => (m === 127 ? v : (v * m) >> 7);

const isExtra = (cmd: number) => cmd < 128 || (cmd >= 176 && cmd <= 189);

const oneByte = new Set([
  192, 193, 194, 195, 196, 197, 198, 199, 200, 201, 202, 203, 204, 205, 206,
  207, 208, 209, 210, 211, 212, 213, 214, 215,
]);

class SequenceTrack {
  readonly player: Player;
  pos: number;
  readonly num: number;
  wait = 0;
  patch = 0;
  portaKey = 60;
  portaTime = 0;
  sweepPitch = 0;
  vol = 127;
  expr = 127;
  pan = 0;
  pitchBendRange = 2;
  pitchBend = 0;
  transpose = 0;
  a = 255;
  d = 255;
  s = 255;
  r = 255;
  modType = 0;
  modRange = 1;
  modSpeed = 16;
  modDelay = 0;
  modDepth = 0;
  flags = 0;
  prio = 64;
  noteWait = true;
  tie = false;
  porta = false;
  end = false;
  comparison = true;
  override: SequenceOverride | null = null;
  readonly stack: SequenceStackEntry[] = [];
  readonly visited = new Map<number, number>();
  constructor(player: Player, pos: number, num: number) {
    this.player = player;
    this.pos = pos;
    this.num = num;
  }
  read(n = 1) {
    check(
      Number.isSafeInteger(this.pos) &&
        this.pos >= 0 &&
        this.pos + n <= this.player.data.length,
      'BOUNDS',
    );
    let v = 0;
    for (let i = 0; i < n; i++) {
      v += this.player.data[this.pos++] * 2 ** (8 * i);
    }
    return v;
  }
  vl() {
    let v = 0;
    for (let i = 0; i < 4; i++) {
      const b = this.read();
      v = v * 128 + (b & 127);
      if (!(b & 128)) {
        return v;
      }
    }
    check(false, 'SEQUENCE_LIMIT', 'Overlong variable integer');
  }
  value(n: number | 'vl' = 1, extra = false) {
    return this.override
      ? extra
        ? this.override.extra
        : this.override.value
      : n === 'vl'
        ? this.vl()
        : this.read(n);
  }
  jump(pos: number, loop = false) {
    check(
      Number.isSafeInteger(pos) && pos >= 0 && pos < this.player.data.length,
      'BOUNDS',
    );
    if (loop) {
      this.player.markLoop(this.visited.get(pos) ?? this.player.frame);
    }
    this.pos = pos;
  }
  releaseAll() {
    for (const c of this.player.channels) {
      if (c.state && c.track === this && c.state !== RELEASE) {
        c.release();
      }
    }
  }
  skip() {
    const cmd = this.read();
    if (cmd < 128) {
      this.read();
      this.vl();
    } else if (cmd === 128 || cmd === 129) {
      this.vl();
    } else if (oneByte.has(cmd)) {
      this.read();
    } else if ([224, 225, 227, 254].includes(cmd)) {
      this.read(2);
    } else if (
      [148, 149].includes(cmd) ||
      (cmd >= 176 && cmd <= 189 && cmd !== 183)
    ) {
      this.read(3);
    } else if (cmd === 147) {
      this.read(4);
    } else if (cmd === 160 || cmd === 161) {
      const c = this.read();
      if (isExtra(c)) {
        this.read();
      }
      this.read(cmd === 160 ? 4 : 1);
    } else {
      check(
        [252, 253, 255, 162].includes(cmd),
        'UNSUPPORTED_SEQUENCE',
        cmd.toString(16),
      );
    }
  }
  run() {
    this.flags |= LENGTH;
    if (this.end) {
      return;
    }
    if (this.wait && --this.wait) {
      return;
    }
    let budget = 65536;
    while (!this.wait && !this.end) {
      check(budget-- > 0 && this.player.instructions++ < 2e7, 'SEQUENCE_LIMIT');
      const at = this.pos;
      if (this.visited.size < 65536 && !this.visited.has(at)) {
        this.visited.set(at, this.player.frame);
      }
      const cmd = this.override ? this.override.cmd : this.read();
      let v: number;
      if (cmd < 128) {
        const key = (cmd + this.transpose) & 255,
          vel = this.value(1, true),
          len = this.value('vl');
        if (this.noteWait) {
          this.wait = len;
        }
        this.note(key, vel, len);
      } else {
        switch (cmd) {
          case 128:
            this.wait = this.value('vl');
            break;

          case 129:
            this.patch = this.value('vl') & 65535;
            break;

          case 147: {
            const n = this.read(),
              pos = this.read(3);
            check(n < 16, 'INVALID_SEQUENCE');
            check(this.player.tracks.length < 32, 'SEQUENCE_LIMIT');
            this.player.tracks.push(new SequenceTrack(this.player, pos, n));
            break;
          }

          case 148: {
            const dest = this.read(3);
            this.jump(dest, dest <= at);
            break;
          }

          case 149: {
            const dest = this.read(3);
            if (this.stack.length < 3) {
              this.stack.push({
                type: 'call',
                pos: this.pos,
              });
              this.jump(dest);
            }
            break;
          }

          case 253:
            if (this.stack.at(-1)?.type === 'call') {
              const entry = this.stack.pop();
              check(entry, 'INVALID_SEQUENCE');
              this.jump(entry.pos);
            }
            break;

          case 212:
            v = this.value();
            if (this.stack.length < 3) {
              this.stack.push({
                type: 'loop',
                pos: this.pos,
                count: v & 255,
              });
            }
            break;

          case 252: {
            const s = this.stack.at(-1);
            if (s?.type === 'loop') {
              if (!s.count) {
                this.jump(s.pos, true);
              } else if (--s.count) {
                this.jump(s.pos);
              } else {
                this.stack.pop();
              }
            }
            break;
          }

          case 255:
            this.end = true;
            break;

          case 192:
            this.pan = signed8(this.value() - 64);
            this.flags |= PAN;
            break;

          case 193:
            this.vol = this.value() & 255;
            this.flags |= VOL;
            break;

          case 194:
            this.player.master = sustain(this.value());
            for (const t of this.player.tracks) {
              t.flags |= VOL;
            }
            break;

          case 198:
            this.prio = this.read();
            break;

          case 199:
            this.noteWait = !!this.read();
            break;

          case 200:
            this.tie = !!this.read();
            this.releaseAll();
            break;

          case 213:
            this.expr = this.value() & 255;
            this.flags |= VOL;
            break;

          case 225:
            this.player.tempo = this.read(2);
            break;

          case 195:
            this.transpose = signed8(this.value());
            break;

          case 196:
            this.pitchBend = signed8(this.value());
            this.flags |= TUNE;
            break;

          case 197:
            this.pitchBendRange = this.read();
            this.flags |= TUNE;
            break;

          case 208:
            this.a = this.value() & 255;
            break;

          case 209:
            this.d = this.value() & 255;
            break;

          case 210:
            this.s = this.value() & 255;
            break;

          case 211:
            this.r = this.value() & 255;
            break;

          case 201:
            this.portaKey = (this.read() + this.transpose) & 255;
            this.porta = true;
            break;

          case 206:
            this.porta = !!this.read();
            break;

          case 207:
            this.portaTime = this.value() & 255;
            break;

          case 227:
            this.sweepPitch = signed16(this.value(2));
            break;

          case 202:
            this.modDepth = this.value() & 255;
            this.flags |= MOD;
            break;

          case 203:
            this.modSpeed = this.value() & 255;
            this.flags |= MOD;
            break;

          case 204:
            this.modType = this.read();
            check(this.modType <= 2, 'INVALID_SEQUENCE');
            this.flags |= MOD;
            break;

          case 205:
            this.modRange = this.read();
            this.flags |= MOD;
            break;

          case 224:
            this.modDelay = this.value(2) & 65535;
            this.flags |= MOD;
            break;

          case 160:
          case 161: {
            check(!this.override, 'INVALID_SEQUENCE');
            const c = this.read(),
              extra = isExtra(c) ? this.read() : 0;
            let value: number;
            if (cmd === 160) {
              const lo = signed16(this.read(2)),
                hi = signed16(this.read(2));
              check(hi >= lo, 'INVALID_SEQUENCE');
              value = lo + this.player.random(hi - lo + 1);
            } else {
              value = this.player.variable(this.read());
            }
            this.override = {
              cmd: c,
              extra,
              value,
            };
            break;
          }

          case 176:
          case 177:
          case 178:
          case 179:
          case 180:
          case 181:
          case 182:
          case 184:
          case 185:
          case 186:
          case 187:
          case 188:
          case 189: {
            const n = this.value(1, true);
            v = signed16(this.value(2));
            const a = this.player.variable(n);
            if (cmd >= 184) {
              this.comparison = [
                a === v,
                a >= v,
                a > v,
                a <= v,
                a < v,
                a !== v,
              ][cmd - 184];
              break;
            }
            if (cmd === 180 && !v) {
              break;
            }
            let result: number | undefined;
            switch (cmd) {
              case 176:
                result = v;
                break;

              case 177:
                result = a + v;
                break;

              case 178:
                result = a - v;
                break;

              case 179:
                result = a * v;
                break;

              case 180:
                result = Math.trunc(a / v);
                break;

              case 181:
                check(Math.abs(v) < 32, 'INVALID_SEQUENCE');
                result = v < 0 ? a >> -v : a << v;
                break;

              case 182:
                result = (v < 0 ? -1 : 1) * this.player.random(Math.abs(v) + 1);
            }
            check(result !== undefined, 'INVALID_SEQUENCE');
            this.player.variables[n] = signed16(result);
            break;
          }

          case 162:
            if (!this.comparison) {
              this.skip();
            }
            break;

          case 214:
            this.read();
            break;

          case 254:
            this.read(2);
            break;

          default:
            check(
              false,
              'UNSUPPORTED_SEQUENCE',
              `Command 0x${cmd.toString(16)}`,
            );
        }
      }
      if (cmd !== 160 && cmd !== 161) {
        this.override = null;
      }
    }
  }
  note(key: number, vel: number, len: number) {
    let c = this.tie
      ? this.player.channels.find(
          (c) => c.state && c.track === this && c.state !== RELEASE,
        )
      : null;
    if (c) {
      c.flags = 0;
      c.prio = this.prio;
      c.key = key;
      c.velocity = sustain(vel);
      c.modDelayCnt = c.modCounter = 0;
      c.updateVol();
      c.updateTune();
      c.updateMod();
      c.updatePorta();
      this.portaKey = key;
      c.flags |= TUNE;
      return;
    }
    const i = instrumentAt(this.player.bank, this.patch, key);
    if (!i) {
      return;
    }
    c = this.player.allocate(i.type - 1, this.prio);
    if (!c) {
      return;
    }
    const wave = i.type === 1 ? this.player.wave(i.archive, i.wave) : null;
    Object.assign(c, {
      state: START,
      track: this,
      flags: 0,
      prio: this.prio,
      key,
      orgKey: i.base,
      velocity: sustain(vel),
      pan: i.pan - 64,
      modDelayCnt: 0,
      modCounter: 0,
      noteLength: this.tie ? -1 : len,
      position: i.type === 1 ? -3 : -1,
      increase: 0,
      baseTimer: wave ? wave.timer : Math.trunc(16777216 / (262 * 8)),
      wave,
      type: i.type,
      duty: i.wave & 7,
      psgX: 32767,
      attackLvl: attack(this.a === 255 ? i.attack : this.a),
      decayRate: fall(this.d === 255 ? i.decay : this.d),
      sustainLvl: this.s === 255 ? i.sustain : this.s,
      releaseRate: fall(this.r === 255 ? i.release : this.r),
    });
    c.updateVol();
    c.updatePan();
    c.updateTune();
    c.updateMod();
    c.updatePorta();
    this.portaKey = key;
  }
}

class Channel {
  readonly player: Player;
  readonly id: number;
  state = NONE;
  track: SequenceTrack | null = null;
  prio = 0;
  vol = 0;
  flags = 0;
  ampl = 0;
  volumeMul = 0;
  volumeShift = 0;
  panning = 0;
  psgLast = 0;
  psgCount = 0;
  noteLength = -1;
  extAmpl = 0;
  extPan = 0;
  extTune = 0;
  modType = 0;
  modSpeed = 0;
  modDepth = 0;
  modRange = 0;
  modDelay = 0;
  sweepPitch = 0;
  sweepCnt = 0;
  sweepLen = 0;
  attackLvl = 0;
  decayRate = 0;
  sustainLvl = 0;
  releaseRate = 0;
  modDelayCnt = 0;
  modCounter = 0;
  velocity = 0;
  baseTimer = 0;
  increase = 0;
  pan = 0;
  key = 0;
  orgKey = 0;
  type = 0;
  duty = 0;
  psgX = 0;
  position = -1;
  manualSweep = false;
  wave: NitroWave | null = null;
  constructor(player: Player, id: number) {
    this.player = player;
    this.id = id;
  }
  activeTrack(): SequenceTrack {
    check(this.track, 'INVALID_SEQUENCE');
    return this.track;
  }
  kill() {
    this.state = NONE;
    this.track = null;
    this.prio = 0;
    this.vol = 0;
    this.volumeMul = 0;
    this.panning = 0;
    this.noteLength = -1;
  }
  release() {
    this.noteLength = -1;
    this.prio = 1;
    this.state = RELEASE;
  }
  updateVol() {
    const t = this.activeTrack();
    this.extAmpl = Math.max(
      -K,
      this.player.master +
        this.player.sseqVol +
        sustain(t.vol) +
        sustain(t.expr),
    );
  }
  updatePan() {
    this.extPan = this.activeTrack().pan;
  }
  updateTune() {
    const t = this.activeTrack();
    this.extTune =
      (this.key - this.orgKey) * 64 + ((t.pitchBend * t.pitchBendRange) >> 1);
  }
  updateMod() {
    const t = this.activeTrack();
    for (const p of [
      'modType',
      'modSpeed',
      'modDepth',
      'modRange',
      'modDelay',
    ] as const) {
      this[p] = t[p];
    }
  }
  updatePorta() {
    const t = this.activeTrack();
    this.manualSweep = false;
    this.sweepPitch = t.sweepPitch;
    this.sweepCnt = 0;
    if (!t.porta) {
      this.sweepLen = 0;
      return;
    }
    this.sweepPitch = signed16(
      this.sweepPitch + (((t.portaKey - this.key) << 22) >> 16),
    );
    if (!t.portaTime) {
      this.sweepLen = this.noteLength >>> 0;
      this.manualSweep = true;
    } else {
      this.sweepLen =
        (Math.imul(Math.abs(this.sweepPitch), t.portaTime * t.portaTime) >>
          11) >>>
        0;
    }
  }
  updateTrack() {
    if (!this.track) {
      return;
    }
    const f = this.track.flags;
    if (f & LENGTH && this.state > START) {
      if (this.state < RELEASE && !--this.noteLength) {
        this.release();
      }
      if (this.manualSweep && this.sweepCnt < this.sweepLen) {
        ++this.sweepCnt;
      }
    }
    if (f & VOL) {
      this.updateVol();
      this.flags |= VOL;
    }
    if (f & PAN) {
      this.updatePan();
      this.flags |= PAN;
    }
    if (f & TUNE) {
      this.updateTune();
      this.flags |= TUNE;
    }
    if (f & MOD) {
      const old = this.modType;
      this.updateMod();
      if (old !== this.modType) {
        this.flags |=
          ([TUNE, VOL, PAN][old] || 0) | ([TUNE, VOL, PAN][this.modType] || 0);
      }
    }
  }
  update() {
    if (!this.state) {
      return;
    }
    const start = this.state === START,
      sweep =
        this.sweepPitch && this.sweepLen && this.sweepCnt <= this.sweepLen;
    let volume = this.flags & VOL || this.state !== SUSTAIN,
      pan = this.flags & PAN || start,
      tune = this.flags & TUNE || start || sweep,
      mod = !!this.modDepth,
      param = 0;
    if (start) {
      this.ampl = THRESHOLD;
      this.state = ATTACK;
    }
    switch (this.state) {
      case ATTACK:
        this.ampl = attackStep(this.ampl, this.attackLvl);
        if (!this.ampl) {
          this.state = DECAY;
        }
        break;

      case DECAY:
        this.ampl -= this.decayRate;
        {
          const level = sustain(this.sustainLvl) << 7;
          if (this.ampl <= level) {
            this.ampl = level;
            this.state = SUSTAIN;
          }
        }
        break;

      case RELEASE:
        this.ampl -= this.releaseRate;
        if (this.ampl <= THRESHOLD) {
          this.kill();
          return;
        }
        break;
    }
    if (mod && this.modDelayCnt < this.modDelay) {
      ++this.modDelayCnt;
      mod = false;
    }
    if (mod) {
      if (this.modType === 0) {
        tune = true;
      } else if (this.modType === 1) {
        volume = true;
      } else if (this.modType === 2) {
        pan = true;
      }
      param = sine(this.modCounter >> 8) * this.modRange * this.modDepth;
      param =
        this.modType === 1 ? Math.floor((param * 60) / 16384) : param >> 8;
      this.modCounter = (this.modCounter + (this.modSpeed << 6)) % 32768;
    }
    if (tune) {
      let adj = this.extTune;
      if (mod && this.modType === 0) {
        adj += param;
      }
      if (sweep) {
        adj += Math.trunc(
          (this.sweepPitch * (this.sweepLen - this.sweepCnt)) / this.sweepLen,
        );
        if (!this.manualSweep) {
          ++this.sweepCnt;
        }
      }
      const t = adj ? timer(this.baseTimer, adj) : this.baseTimer;
      check(t >= 0 && t <= 65535, 'INVALID_AUDIO', 'Invalid sample timer');
      this.increase = CLOCK / (this.player.rate * 2 * (t || 65536));
      this.flags &= ~TUNE;
    }
    if (volume) {
      const v = clamp(
        (this.ampl >> 7) +
          this.extAmpl +
          this.velocity +
          (mod && this.modType === 1 ? param : 0) +
          K,
        0,
        K,
      );
      this.volumeMul = getvoltbl[v];
      this.volumeShift = v < K - 240 ? 4 : v < K - 120 ? 2 : v < K - 60 ? 1 : 0;
      this.vol = (this.volumeMul << 4) >> this.volumeShift;
      this.flags &= ~VOL;
    }
    if (pan) {
      this.panning = clamp(
        this.pan + this.extPan + (mod && this.modType === 2 ? param : 0) + 64,
        0,
        127,
      );
      this.flags &= ~PAN;
    }
  }
  sample() {
    let sample = 0;
    if (this.position >= 0) {
      const pos = Math.floor(this.position);
      if (this.type === 1) {
        check(this.wave, 'MISSING_WAVE');
        sample = this.wave.pcm[pos] * 32768;
      } else if (this.type === 2) {
        sample = (pos & 7) >= 7 - this.duty && this.duty !== 7 ? 32767 : -32767;
      } else {
        for (let i = this.psgCount; i < pos; i++) {
          if (this.psgX & 1) {
            this.psgX = (this.psgX >> 1) ^ 24576;
            this.psgLast = -32767;
          } else {
            this.psgX >>= 1;
            this.psgLast = 32767;
          }
        }
        this.psgCount = pos;
        sample = this.psgLast;
      }
    }
    this.position += this.increase;
    if (this.type === 1) {
      check(this.wave, 'MISSING_WAVE');
      if (this.position >= this.wave.pcm.length) {
        if (this.wave.loop) {
          this.position =
            this.wave.loopStart +
            ((this.position - this.wave.pcm.length) % this.wave.loopLength);
        } else {
          this.kill();
        }
      }
    }
    return mul7(sample, this.volumeMul) >> this.volumeShift;
  }
}

class Player {
  readonly data: Uint8Array;
  readonly bank: Uint8Array;
  readonly waves: (Uint8Array | null | undefined)[];
  readonly rate: number;
  master = 0;
  readonly sseqVol: number;
  tempo = 120;
  tempoCount = 0;
  frame = 0;
  nextClock = CLOCK_PERIOD;
  instructions = 0;
  rng = 1;
  readonly variables: Int16Array;
  loop = false;
  loopStart = 0;
  loopEnd = 0;
  readonly waveCache = new Map<string, NitroWave>();
  decodedBytes = 0;
  readonly outputBytes: number;
  readonly channels: Channel[];
  readonly tracks: SequenceTrack[];
  constructor(track: ParsedTrack, rate: number, outputBytes: number) {
    check(
      track.sequence instanceof Uint8Array && track.bank instanceof Uint8Array,
      'INVALID_SEQUENCE',
    );
    this.data = track.sequence;
    this.bank = track.bank;
    this.waves = track.waves || [];
    this.rate = rate;
    this.master = 0;
    this.sseqVol = sustain(track.volume ?? 127);
    this.tempo = 120;
    this.tempoCount = 0;
    this.frame = 0;
    this.nextClock = CLOCK_PERIOD;
    this.instructions = 0;
    this.rng = 1;
    this.variables = new Int16Array(32).fill(-1);
    this.loop = false;
    this.loopStart = 0;
    this.loopEnd = 0;
    this.decodedBytes = 0;
    this.outputBytes = outputBytes;
    this.channels = Array.from(
      {
        length: 16,
      },
      (_, i) => new Channel(this, i),
    );
    this.tracks = [new SequenceTrack(this, track.start ?? 0, 0)];
  }
  variable(n: number) {
    check(
      Number.isInteger(n) && n >= 0 && n < 32,
      'INVALID_SEQUENCE',
      'Variable index',
    );
    return this.variables[n];
  }
  random(n: number) {
    check(n > 0 && Number.isSafeInteger(n), 'INVALID_SEQUENCE');
    this.rng = randomState(this.rng);
    return ((this.rng >>> 16) & 32767) % n;
  }
  markLoop(frame: number) {
    if (!this.loop) {
      this.loop = true;
      this.loopStart = frame;
      this.loopEnd = this.frame;
    }
  }
  allocate(type: number, priority: number) {
    let c: Channel | null = null;
    for (const id of ALLOCATION[type]) {
      const next = this.channels[id];
      if (
        c &&
        next.prio >= c.prio &&
        (next.prio !== c.prio || c.vol <= next.vol)
      ) {
        continue;
      }
      c = next;
    }
    if (!c || priority < c.prio) {
      return null;
    }
    c.noteLength = -1;
    c.vol = 2047;
    return c;
  }
  wave(archive: number, id: number): NitroWave {
    const key = archive + ':' + id;
    const cached = this.waveCache.get(key);
    if (cached) return cached;
    const archiveBytes = this.waves[archive];
    check(archiveBytes, 'MISSING_WAVE', key);
    const raw = waveAt(archiveBytes, id),
      b = new Bin(raw),
      type = b.u8(0),
      words = b.u16(6) + b.u32(8),
      bytes = words * 4;
    check(type <= 2 && bytes > 0, 'INVALID_AUDIO');
    check(bytes <= raw.length - 12, 'BOUNDS');
    const samples =
      type === 0 ? bytes : type === 1 ? bytes / 2 : (bytes - 4) * 2;
    check(
      Number.isInteger(samples) &&
        samples > 0 &&
        this.decodedBytes + samples * 4 + this.outputBytes <= PCM_LIMIT,
      'TOO_LARGE',
    );
    const pcm = decodeNitro(raw.subarray(12, 12 + bytes), type);
    const loopStart =
        b.u16(6) * (type === 0 ? 4 : type === 1 ? 2 : 8) -
        (type === 2 && b.u16(6) ? 8 : 0),
      loopLength = b.u32(8) * (type === 0 ? 4 : type === 1 ? 2 : 8);
    check(
      !b.u8(1) ||
        (loopLength > 0 &&
          loopStart >= 0 &&
          loopStart < pcm.length &&
          loopStart + loopLength === pcm.length),
      'INVALID_AUDIO',
    );
    const value = {
      pcm,
      timer: b.u16(4),
      loop: !!b.u8(1),
      loopStart,
      loopLength,
    };
    this.decodedBytes += samples * 4;
    this.waveCache.set(key, value);
    return value;
  }
  clock() {
    for (const c of this.channels) {
      c.updateTrack();
    }
    for (const t of this.tracks) {
      t.flags = 0;
    }
    for (const c of this.channels) {
      c.update();
    }
    while (this.tempoCount >= 240) {
      this.tempoCount -= 240;
      for (let i = 0; i < this.tracks.length; i++) {
        this.tracks[i].run();
      }
    }
    this.tempoCount += this.tempo;
  }
}

function createReader(
  track: ParsedTrack,
  sampleRate: number,
  outputBytes: number,
): SequenceReader {
  check(
    Number.isInteger(sampleRate) && sampleRate >= 8e3 && sampleRate <= 192e3,
    'TOO_LARGE',
  );
  check(
    track?.sequence instanceof Uint8Array && track.bank instanceof Uint8Array,
    'INVALID_SEQUENCE',
  );
  check(
    Number.isSafeInteger(track.start ?? 0) &&
      (track.start ?? 0) >= 0 &&
      (track.start ?? 0) < track.sequence.length,
    'BOUNDS',
  );
  let p = new Player(track, sampleRate, outputBytes),
    done = false;
  return {
    get frame() {
      return p.frame;
    },
    sampleRate,
    channels: 2,
    length: null,
    get loop() {
      return p.loop;
    },
    get loopStart() {
      return p.loopStart;
    },
    get loopEnd() {
      return p.loopEnd || p.frame;
    },
    read(frames: number) {
      check(
        Number.isInteger(frames) && frames >= 1 && frames <= MAX_BLOCK,
        'TOO_LARGE',
        'Read 1–16384 frames',
      );
      const left = new Float32Array(done ? 0 : frames),
        right = new Float32Array(done ? 0 : frames);
      let used = 0;
      while (used < frames && !done) {
        let l = 0,
          r = 0;
        for (const c of p.channels) {
          if (c.state) {
            const v = c.sample();
            l += mul7(v, 127 - c.panning);
            r += mul7(v, c.panning);
          }
        }
        left[used] = clamp(l, -32768, 32767) / 32768;
        right[used] = clamp(r, -32768, 32767) / 32768;
        ++used;
        ++p.frame;
        if (p.frame / sampleRate > p.nextClock) {
          p.clock();
          p.nextClock += CLOCK_PERIOD;
        }
        if (p.tracks.every((t) => t.end) && p.channels.every((c) => !c.state)) {
          done = true;
          p.loop = false;
          p.loopStart = 0;
          p.loopEnd = p.frame;
        }
      }
      return {
        channels:
          used === left.length
            ? [left, right]
            : [left.subarray(0, used), right.subarray(0, used)],
        sampleRate,
        done,
        frame: p.frame,
        loop: p.loop,
        loopStart: p.loopStart,
        loopEnd: p.loopEnd || p.frame,
      };
    },
    reset() {
      p = new Player(track, sampleRate, outputBytes);
      done = false;
    },
  };
}

export function createEngine(
  track: ParsedTrack,
  sampleRate = 32768,
): AudioDecoder {
  return createReader(track, sampleRate, BLOCK_BYTES);
}

export async function renderEngine(
  track: ParsedTrack,
  seconds = 60,
  sampleRate = 32768,
  report: ProgressReporter = () => {},
) {
  check(
    Number.isFinite(seconds) &&
      seconds > 0 &&
      seconds <= 300 &&
      Number.isInteger(sampleRate) &&
      sampleRate >= 8e3 &&
      sampleRate <= 192e3,
    'TOO_LARGE',
  );
  const frames = Math.ceil(seconds * sampleRate),
    outputBytes = frames * 8 + Math.min(frames, MAX_BLOCK) * 8;
  check(outputBytes <= PCM_LIMIT, 'TOO_LARGE');
  const reader = createReader(track, sampleRate, outputBytes),
    left = new Float32Array(frames),
    right = new Float32Array(frames);
  let used = 0,
    block: PcmBlock | undefined;
  report({
    phase: 'render',
    value: 0,
  });
  while (used < frames) {
    block = reader.read(Math.min(frames - used, MAX_BLOCK));
    left.set(block.channels[0], used);
    right.set(block.channels[1], used);
    used = block.frame;
    report({
      phase: 'render',
      value: Math.min(1, used / frames),
    });
    if (block.done) {
      break;
    }
    await new Promise((resolve) => setTimeout(resolve, 0));
  }
  report({
    phase: 'render',
    value: 1,
  });
  check(block, 'INVALID_SEQUENCE');
  return {
    channels:
      used === frames
        ? [left, right]
        : [left.subarray(0, used), right.subarray(0, used)],
    sampleRate,
    loop: block.loop,
    loopStart: block.loopStart,
    loopEnd: block.loopEnd,
    warnings: [],
    engine: 'NitroJS',
  };
}
