import type {
  AudioDecoder,
  ByteSource,
  DecoderOptions,
  PcmBlock,
} from './contracts.js';
import { check, FormatError, sliceSource } from './binary.js';
import { cooperativeYield } from './cooperative.js';
import { PlaystationSpu } from './playstation-spu.js';

export interface SonySong {
  index: number;
  offset: number;
  end: number;
  ppqn: number;
  tempo: number;
}

export interface SonySequenceInfo {
  format: 'SEQ' | 'SEP';
  songs: SonySong[];
}

type Cancellation = () => void;
type SonyCode = 'SONY_SEQUENCE' | 'SONY_BANK' | 'SONY_COMMAND';

async function readBytes(
  source: ByteSource,
  offset: number,
  length: number,
  code: SonyCode,
  cancel: Cancellation,
) {
  cancel();
  check(
    Number.isSafeInteger(source.size) &&
      source.size >= 0 &&
      Number.isSafeInteger(offset) &&
      offset >= 0 &&
      Number.isSafeInteger(length) &&
      length >= 0 &&
      length <= 65536 &&
      offset + length <= source.size,
    code,
    'Read extent ' + offset + '+' + length + '/' + source.size,
  );
  const bytes = await source.read(offset, length);
  cancel();
  check(
    bytes instanceof Uint8Array && bytes.length === length,
    code,
    'Short source read at ' + offset,
  );
  return bytes;
}

class EventReader {
  position: number;
  status = 0;
  private cache: Uint8Array = new Uint8Array(0);
  private cacheOffset = 0;
  constructor(
    private source: ByteSource,
    start: number,
    readonly end: number,
    private cancel: Cancellation,
  ) {
    this.position = start;
  }
  async byte() {
    check(
      this.position < this.end,
      'SONY_SEQUENCE',
      'Truncated event at ' + this.position,
    );
    if (
      this.position < this.cacheOffset ||
      this.position >= this.cacheOffset + this.cache.length
    ) {
      this.cacheOffset = this.position;
      this.cache = await readBytes(
        this.source,
        this.position,
        Math.min(4096, this.end - this.position),
        'SONY_SEQUENCE',
        this.cancel,
      );
    }
    return this.cache[this.position++ - this.cacheOffset];
  }
  async data() {
    const value = await this.byte();
    check(
      value < 128,
      'SONY_SEQUENCE',
      'Expected data byte at ' + (this.position - 1),
    );
    return value;
  }
  async event(): Promise<SequenceEvent> {
    this.cancel();
    const offset = this.position;
    let delta = 0;
    for (let count = 0; ; count++) {
      check(
        count < 4,
        'SONY_SEQUENCE',
        'Delta VLQ exceeds four bytes at ' + offset,
      );
      const value = await this.byte();
      delta = delta * 128 + (value & 127);
      if (!(value & 128)) break;
    }
    let status = await this.byte();
    let first: number | undefined;
    if (status < 128) {
      first = status;
      status = this.status;
      check(
        status >= 128,
        'SONY_SEQUENCE',
        'Running status without a preceding command at ' + offset,
      );
    } else this.status = status;
    const a = first ?? (status === 255 ? await this.byte() : await this.data());
    if (status === 255) {
      if (a === 0x2f) {
        check(
          (await this.byte()) === 0,
          'SONY_SEQUENCE',
          'EOT must end with zero at ' + offset,
        );
        return { offset, delta, status, a, b: 0 };
      }
      check(
        a === 0x51,
        'SONY_COMMAND',
        'Unsupported meta 0x' + a.toString(16) + ' at ' + offset,
      );
      const tempo =
        (await this.byte()) * 65536 +
        (await this.byte()) * 256 +
        (await this.byte());
      check(tempo > 0, 'SONY_SEQUENCE', 'Zero tempo at ' + offset);
      return { offset, delta, status, a, b: tempo };
    }
    const command = status & 0xf0;
    check(
      [0x80, 0x90, 0xb0, 0xc0, 0xe0].includes(command),
      'SONY_COMMAND',
      'Unsupported status 0x' + status.toString(16) + ' at ' + offset,
    );
    return {
      offset,
      delta,
      status,
      a,
      b: command === 0xc0 ? 0 : await this.data(),
    };
  }
}

interface SequenceEvent {
  offset: number;
  delta: number;
  status: number;
  a: number;
  b: number;
}

async function validateSong(
  source: ByteSource,
  song: SonySong,
  exact: boolean,
  cancel: Cancellation,
  checkpoint = cooperativeYield(cancel),
) {
  const reader = new EventReader(source, song.offset, song.end, cancel);
  let count = 0;
  while (reader.position < song.end) {
    check(
      ++count <= 4000000,
      'SONY_SEQUENCE',
      'Stored event count exceeds validation budget',
    );
    const event = await reader.event();
    if ((count & 255) === 0) await checkpoint();
    if (event.status === 255 && event.a === 0x2f) {
      check(
        !exact || reader.position === song.end,
        'SONY_SEQUENCE',
        'SEP EOT does not match declared extent at ' + reader.position,
      );
      song.end = reader.position;
      return;
    }
  }
  throw new FormatError('SONY_SEQUENCE', 'Missing EOT at ' + song.end);
}

function timing(bytes: Uint8Array, offset: number) {
  const ppqn = bytes[offset] * 256 + bytes[offset + 1];
  const tempo =
    bytes[offset + 2] * 65536 + bytes[offset + 3] * 256 + bytes[offset + 4];
  check(
    ppqn > 0 &&
      ppqn < 0x8000 &&
      tempo > 0 &&
      bytes[offset + 5] > 0 &&
      bytes[offset + 6] <= 7,
    'SONY_SEQUENCE',
    'Invalid PPQN, tempo or time signature',
  );
  return { ppqn, tempo };
}

async function readSep(
  source: ByteSource,
  cancel: Cancellation,
  checkpoint = cooperativeYield(cancel),
): Promise<SonySequenceInfo> {
  const songs: SonySong[] = [];
  let offset = 6;
  const ids = new Set<number>();
  while (offset < source.size) {
    check(
      songs.length < 4096,
      'SONY_SEQUENCE',
      'SEP record count exceeds 4096',
    );
    const header = await readBytes(source, offset, 13, 'SONY_SEQUENCE', cancel);
    const view = new DataView(
      header.buffer,
      header.byteOffset,
      header.byteLength,
    );
    const id = view.getUint16(0);
    check(!ids.has(id), 'SONY_SEQUENCE', 'Duplicate SEP record ID ' + id);
    ids.add(id);
    const size = view.getUint32(9);
    const start = offset + 13;
    check(
      size >= 4 && size <= source.size - start,
      'SONY_SEQUENCE',
      'Invalid SEP extent for record ' + id,
    );
    const song: SonySong = {
      index: songs.length,
      offset: start,
      end: start + size,
      ...timing(header, 2),
    };
    await validateSong(source, song, true, cancel, checkpoint);
    songs.push(song);
    offset = song.end;
    if ((songs.length & 15) === 0) await checkpoint();
  }
  return { format: 'SEP', songs };
}

export async function readSonySequence(
  source: ByteSource,
  name = '',
  checkCancelled: Cancellation = () => {},
): Promise<SonySequenceInfo> {
  const checkpoint = cooperativeYield(checkCancelled);
  const head = await readBytes(
    source,
    0,
    Math.min(15, source.size),
    'SONY_SEQUENCE',
    checkCancelled,
  );
  check(
    head.length >= 6 &&
      head[0] === 0x70 &&
      head[1] === 0x51 &&
      head[2] === 0x45 &&
      head[3] === 0x53 &&
      head[4] === 0 &&
      head[5] === 0,
    'SONY_SEQUENCE',
    'Expected standard pQES header',
  );
  if (/\.sep$/i.test(name) || head.length < 8 || head[6] !== 0 || head[7] !== 1)
    return readSep(source, checkCancelled, checkpoint);
  let sep: SonySequenceInfo | undefined;
  try {
    sep = await readSep(source, checkCancelled, checkpoint);
  } catch (error) {
    if (
      !(error instanceof FormatError) ||
      !['SONY_SEQUENCE', 'SONY_COMMAND'].includes(error.code)
    )
      throw error;
  }
  if (sep) return sep;
  check(head.length === 15, 'SONY_SEQUENCE', 'Truncated SEQ header');
  const song: SonySong = {
    index: 0,
    offset: 15,
    end: source.size,
    ...timing(head, 8),
  };
  await validateSong(source, song, false, checkCancelled, checkpoint);
  return { format: 'SEQ', songs: [song] };
}

function isSequenceError(error: unknown) {
  return (
    error instanceof FormatError &&
    ['SONY_SEQUENCE', 'SONY_COMMAND'].includes(error.code)
  );
}

async function readSepPrefix(
  source: ByteSource,
  cancel: Cancellation,
  checkpoint: () => Promise<void>,
): Promise<SonySequenceInfo> {
  const songs: SonySong[] = [];
  const ids = new Set<number>();
  let offset = 6;
  while (offset + 17 <= source.size && songs.length < 4096) {
    try {
      const header = await readBytes(
        source,
        offset,
        13,
        'SONY_SEQUENCE',
        cancel,
      );
      const view = new DataView(
        header.buffer,
        header.byteOffset,
        header.byteLength,
      );
      const id = view.getUint16(0);
      const size = view.getUint32(9);
      check(
        !ids.has(id) && size >= 4 && size <= source.size - offset - 13,
        'SONY_SEQUENCE',
        'Embedded SEP record extent',
      );
      const song: SonySong = {
        index: songs.length,
        offset: offset + 13,
        end: offset + 13 + size,
        ...timing(header, 2),
      };
      await validateSong(source, song, true, cancel, checkpoint);
      ids.add(id);
      songs.push(song);
      offset = song.end;
      if ((songs.length & 15) === 0) await checkpoint();
    } catch (error) {
      if (!isSequenceError(error) || !songs.length) throw error;
      break;
    }
  }
  check(songs.length > 0, 'SONY_SEQUENCE', 'Missing embedded SEP record');
  return { format: 'SEP', songs };
}

export async function readSonySequenceExtent(
  source: ByteSource,
  cancel: Cancellation = () => {},
) {
  const checkpoint = cooperativeYield(cancel);
  const input = sliceSource(source, 0, Math.min(source.size, 16 * 1024 ** 2));
  const head = await readBytes(
    input,
    0,
    Math.min(input.size, 15),
    'SONY_SEQUENCE',
    cancel,
  );
  check(
    head.length >= 6 &&
      head[0] === 112 &&
      head[1] === 81 &&
      head[2] === 69 &&
      head[3] === 83 &&
      head[4] === 0 &&
      head[5] === 0,
    'SONY_SEQUENCE',
    'Expected standard pQES header',
  );
  let sep: SonySequenceInfo | undefined;
  try {
    sep = await readSepPrefix(input, cancel, checkpoint);
  } catch (error) {
    if (!isSequenceError(error)) throw error;
  }
  let seq: SonySequenceInfo | undefined;
  if (head.length === 15 && head[6] === 0 && head[7] === 1) {
    try {
      const song: SonySong = {
        index: 0,
        offset: 15,
        end: input.size,
        ...timing(head, 8),
      };
      await validateSong(input, song, false, cancel, checkpoint);
      seq = { format: 'SEQ', songs: [song] };
    } catch (error) {
      if (!isSequenceError(error)) throw error;
    }
  }
  check(!(seq && sep), 'SONY_SEQUENCE', 'Ambiguous embedded SEQ/SEP extent');
  const info = seq || sep;
  check(info, 'SONY_SEQUENCE', 'Invalid embedded Sony sequence');
  return { ...info, size: info.songs[info.songs.length - 1].end };
}

interface Tone {
  priority: number;
  volume: number;
  pan: number;
  center: number;
  shift: number;
  min: number;
  max: number;
  bendDown: number;
  bendUp: number;
  adsr1: number;
  adsr2: number;
  address: number;
  sampleLoop: boolean;
  reverb: boolean;
}
interface Program {
  volume: number;
  pan: number;
  tones: Tone[];
}
interface SoundBank {
  programs: Map<number, Program>;
  volume: number;
  pan: number;
  bytes: Uint8Array;
}

async function loadBank(
  headerSource: ByteSource,
  bodySource: ByteSource | undefined,
  cancel: Cancellation,
): Promise<SoundBank> {
  const header = await readBytes(headerSource, 0, 32, 'SONY_BANK', cancel);
  const view = new DataView(
    header.buffer,
    header.byteOffset,
    header.byteLength,
  );
  check(
    header[0] === 0x70 &&
      header[1] === 0x42 &&
      header[2] === 0x41 &&
      header[3] === 0x56 &&
      [5, 6, 7, 0x20].includes(view.getUint32(4, true)),
    'SONY_BANK',
    'Expected original VAB header',
  );
  const programCount = view.getUint16(18, true),
    toneCount = view.getUint16(20, true),
    sampleCount = view.getUint16(22, true);
  check(
    programCount <= 128 &&
      toneCount <= programCount * 16 &&
      sampleCount <= 255 &&
      header[24] <= 127 &&
      header[25] <= 127,
    'SONY_BANK',
    'Invalid VAB counts or master volume/pan',
  );
  const tableOffset = 0x820 + programCount * 0x200,
    headerSize = tableOffset + 0x200;
  const table = await readBytes(
    headerSource,
    tableOffset,
    512,
    'SONY_BANK',
    cancel,
  );
  const tableView = new DataView(
    table.buffer,
    table.byteOffset,
    table.byteLength,
  );
  let bodySize = 0;
  const samples = new Map<number, { offset: number; size: number }>();
  for (let id = 1; id <= sampleCount; id++) {
    const size = tableView.getUint16(id * 2, true) * 8;
    check(size % 16 === 0, 'SONY_BANK', 'Unaligned ADPCM sample ' + id);
    if (size) samples.set(id, { offset: bodySize, size });
    bodySize += size;
  }
  check(
    bodySize <= 0x80000 - 0x1000,
    'SONY_BANK',
    'VAB body exceeds available SPU RAM after capture area',
  );
  const declared = view.getUint32(12, true);
  check(
    declared === 0 || declared >= headerSize + bodySize,
    'SONY_BANK',
    'VAB declared size is shorter than original data',
  );
  const source = bodySource ?? headerSource,
    bodyOffset = bodySource ? 0 : headerSize;
  check(
    bodyOffset + bodySize <= source.size,
    'SONY_BANK',
    'Missing or truncated VAB body',
  );
  const bytes = new Uint8Array(bodySize);
  for (let offset = 0; offset < bodySize; offset += 65536)
    bytes.set(
      await readBytes(
        source,
        bodyOffset + offset,
        Math.min(65536, bodySize - offset),
        'SONY_BANK',
        cancel,
      ),
      offset,
    );
  const sampleLoops = new Map<number, boolean>();
  for (const [id, sample] of samples) {
    let endFlags = 0;
    for (
      let offset = sample.offset;
      offset < sample.offset + sample.size;
      offset += 16
    ) {
      if (bytes[offset + 1] & 1) {
        endFlags = bytes[offset + 1];
        break;
      }
    }
    check(
      endFlags !== 0,
      'SONY_BANK',
      'ADPCM sample ' + id + ' lacks an end flag within its extent',
    );
    sampleLoops.set(id, !!(endFlags & 2));
  }
  const programTable = await readBytes(
    headerSource,
    32,
    2048,
    'SONY_BANK',
    cancel,
  );
  const programs = new Map<number, Program>();
  let packed = 0,
    totalTones = 0;
  for (let programId = 0; programId < 128; programId++) {
    const p = programId * 16,
      count = programTable[p];
    check(
      count <= 16,
      'SONY_BANK',
      'Invalid tone count in program ' + programId,
    );
    if (!count) continue;
    check(
      packed < programCount &&
        programTable[p + 1] <= 127 &&
        programTable[p + 4] <= 127,
      'SONY_BANK',
      'Invalid program table slot ' + programId,
    );
    const regions = await readBytes(
      headerSource,
      0x820 + packed++ * 0x200,
      512,
      'SONY_BANK',
      cancel,
    );
    const regionsView = new DataView(
      regions.buffer,
      regions.byteOffset,
      regions.byteLength,
    );
    const tones: Tone[] = [];
    for (let index = 0; index < count; index++) {
      const t = index * 32,
        sampleId = regionsView.getUint16(t + 22, true),
        sample = samples.get(sampleId);
      check(
        sample !== undefined,
        'SONY_BANK',
        'Missing sample ' +
          sampleId +
          ' for program ' +
          programId +
          ', tone ' +
          index,
      );
      check(
        regions[t + 2] <= 127 &&
          regions[t + 3] <= 127 &&
          regions[t + 4] <= 127 &&
          regions[t + 6] <= regions[t + 7] &&
          regions[t + 7] <= 127,
        'SONY_BANK',
        'Invalid volume, tuning or key range in program ' + programId,
      );
      check(
        regions[t + 8] === 0 &&
          regions[t + 9] === 0 &&
          regions[t + 10] === 0 &&
          regions[t + 11] === 0 &&
          (regions[t + 1] & ~4) === 0,
        'SONY_BANK',
        'Unsupported tone modulation mode in program ' +
          programId +
          ', tone ' +
          index,
      );
      tones.push({
        priority: regions[t],
        volume: regions[t + 2],
        pan: regions[t + 3],
        center: regions[t + 4],
        shift: Math.min(127, regions[t + 5]),
        min: regions[t + 6],
        max: regions[t + 7],
        bendDown: regions[t + 12],
        bendUp: regions[t + 13],
        adsr1: regionsView.getUint16(t + 16, true),
        adsr2: regionsView.getUint16(t + 18, true),
        address: 0x1000 + sample.offset,
        sampleLoop: sampleLoops.get(sampleId) ?? false,
        reverb: !!(regions[t + 1] & 4),
      });
    }
    programs.set(programId, {
      volume: programTable[p + 1],
      pan: programTable[p + 4],
      tones,
    });
    totalTones += count;
  }
  check(
    packed === programCount && totalTones === toneCount,
    'SONY_BANK',
    'VAB program/tone totals do not match packed table',
  );
  return { programs, volume: header[24], pan: header[25], bytes };
}

interface Channel {
  program: number;
  volume: number;
  expression: number;
  pan: number;
  bend: number;
  sustain: boolean;
  nrpn: number;
  rpnHigh: number;
  rpnLow: number;
}
interface PlayingVoice {
  channel: number;
  key: number;
  velocity: number;
  tone: Tone;
  program: Program;
  started: number;
  released: boolean;
  deferred: boolean;
  age: number;
}
interface ScoreLoop {
  position: number;
  status: number;
  channel: number;
  count: number;
  remaining: number;
  repeated: boolean;
  frame: number;
}

function initialChannels(): Channel[] {
  return Array.from({ length: 16 }, (_, program) => ({
    program,
    volume: 127,
    expression: 127,
    pan: 64,
    bend: 8192,
    sustain: false,
    nrpn: 127,
    rpnHigh: 127,
    rpnLow: 127,
  }));
}

function panGain(pan: number, right: boolean) {
  return right ? Math.min(1, pan / 64) : Math.min(1, (127 - pan) / 63);
}

class SonyDecoder implements AudioDecoder {
  readonly channels = 2;
  readonly sampleRate = 44100;
  length: number | null = null;
  loop = false;
  loopIsInfinite = false;
  loopStart: number | undefined;
  loopEnd: number | null = null;
  frame = 0;
  private spu = new PlaystationSpu();
  private reader: EventReader;
  private state = initialChannels();
  private voices: (PlayingVoice | undefined)[] = Array.from({ length: 24 });
  private pending: SequenceEvent | undefined;
  private scheduled = 0;
  private numerator = 0n;
  private denominator: bigint;
  private tempo: number;
  private ended = false;
  private scoreLoop: ScoreLoop | undefined;
  private age = 0;
  private reverbRequested = false;
  constructor(
    private source: ByteSource,
    private song: SonySong,
    private bank: SoundBank,
    private cancel: Cancellation,
  ) {
    this.reader = new EventReader(source, song.offset, song.end, cancel);
    this.denominator = BigInt(song.ppqn) * 1000000n;
    this.tempo = song.tempo;
    this.initializeSpu();
  }
  private initializeSpu() {
    this.spu.memory.set(this.bank.bytes, 0x1000);
    this.spu.write16(0x1d80, 0x3fff);
    this.spu.write16(0x1d82, 0x3fff);
    this.spu.write16(0x1daa, 0xc000);
  }
  reset() {
    this.cancel();
    this.spu.reset();
    this.initializeSpu();
    this.reader = new EventReader(
      this.source,
      this.song.offset,
      this.song.end,
      this.cancel,
    );
    this.state = initialChannels();
    this.voices = Array.from({ length: 24 });
    this.pending = undefined;
    this.numerator = 0n;
    this.scheduled = 0;
    this.tempo = this.song.tempo;
    this.ended = false;
    this.scoreLoop = undefined;
    this.age = 0;
    this.reverbRequested = false;
    this.frame = 0;
    this.length = null;
    this.loop = false;
    this.loopIsInfinite = false;
    this.loopStart = undefined;
    this.loopEnd = null;
  }
  private updateVoice(index: number, voice: PlayingVoice) {
    const channel = this.state[voice.channel],
      tone = voice.tone;
    const amplitude =
      ((((((((((voice.velocity / 127) * channel.volume) / 127) *
        channel.expression) /
        127) *
        this.bank.volume) /
        127) *
        voice.program.volume) /
        127) *
        tone.volume) /
      127;
    for (let side = 0; side < 2; side++) {
      const gain =
        amplitude *
        panGain(channel.pan, !!side) *
        panGain(voice.program.pan, !!side) *
        panGain(tone.pan, !!side) *
        panGain(this.bank.pan, !!side);
      this.spu.write16(
        0x1c00 + index * 16 + side * 2,
        Math.floor(0x3fff * gain * gain),
      );
    }
    const bend =
      channel.bend < 8192
        ? ((channel.bend - 8192) / 8192) * tone.bendDown
        : ((channel.bend - 8192) / 8191) * tone.bendUp;
    const pitch = Math.max(
      1,
      Math.min(
        0x3fff,
        Math.round(
          4096 *
            2 ** ((voice.key - tone.center + tone.shift / 128 + bend) / 12),
        ),
      ),
    );
    this.spu.write16(0x1c04 + index * 16, pitch);
  }
  private updateChannel(channel: number) {
    this.voices.forEach((voice, index) => {
      if (voice && voice.channel === channel) this.updateVoice(index, voice);
    });
  }
  private release(index: number, voice: PlayingVoice) {
    voice.released = true;
    voice.deferred = false;
    if (this.spu.keyOnPending & (1 << index)) {
      const mask = this.spu.keyOnPending & ~(1 << index);
      this.spu.write16(0x1d88, mask & 65535);
      this.spu.write16(0x1d8a, mask >>> 16);
      this.voices[index] = undefined;
    } else this.spu.write16(index < 16 ? 0x1d8c : 0x1d8e, 1 << (index % 16));
  }
  private noteOff(channel: number, key: number | undefined, force = false) {
    this.voices.forEach((voice, index) => {
      if (
        !voice ||
        voice.channel !== channel ||
        (key !== undefined && voice.key !== key) ||
        voice.released
      )
        return;
      if (!force && this.state[channel].sustain) voice.deferred = true;
      else this.release(index, voice);
    });
  }
  private noteOn(channel: number, key: number, velocity: number) {
    const programId = this.state[channel].program,
      program = this.bank.programs.get(programId);
    check(
      program !== undefined,
      'SONY_BANK',
      'Sequence uses missing program ' + programId + ' on channel ' + channel,
    );
    const tones = program.tones.filter(
      (tone) => key >= tone.min && key <= tone.max,
    );
    check(
      tones.length > 0,
      'SONY_BANK',
      'Program ' + programId + ' has no tone for key ' + key,
    );
    for (const tone of tones) {
      let index = this.voices.findIndex((voice) => voice === undefined);
      if (index < 0) {
        index = 0;
        for (let candidate = 1; candidate < 24; candidate++) {
          const current = this.voices[index],
            next = this.voices[candidate];
          if (
            current &&
            next &&
            (next.tone.priority < current.tone.priority ||
              (next.tone.priority === current.tone.priority &&
                next.age < current.age))
          )
            index = candidate;
        }
      }
      const voice: PlayingVoice = {
        channel,
        key,
        velocity,
        tone,
        program,
        started: this.frame,
        released: false,
        deferred: false,
        age: this.age++,
      };
      this.voices[index] = voice;
      const base = 0x1c00 + index * 16;
      this.spu.write16(base + 6, tone.address / 8);
      this.spu.write16(base + 8, tone.adsr1);
      this.spu.write16(base + 10, tone.adsr2);
      this.spu.write16(base + 14, tone.address / 8);
      this.spu.voices[index].echoOn(tone.reverb);
      this.reverbRequested ||= tone.reverb;
      this.updateVoice(index, voice);
      const mask = this.spu.keyOnPending | (1 << index);
      this.spu.write16(0x1d88, mask & 65535);
      this.spu.write16(0x1d8a, mask >>> 16);
    }
  }
  private controller(
    channelId: number,
    controller: number,
    value: number,
    offset: number,
  ) {
    const channel = this.state[channelId];
    const unsupported = () => {
      throw new FormatError(
        'SONY_COMMAND',
        'Unsupported controller ' +
          controller +
          '=' +
          value +
          ' on channel ' +
          channelId +
          ' at ' +
          offset,
      );
    };
    switch (controller) {
      case 0:
        if (value) unsupported();
        break;
      case 7:
        channel.volume = value;
        this.updateChannel(channelId);
        break;
      case 10:
        channel.pan = value;
        this.updateChannel(channelId);
        break;
      case 11:
        channel.expression = value;
        this.updateChannel(channelId);
        break;
      case 64:
        channel.sustain = value >= 64;
        if (!channel.sustain)
          this.voices.forEach((voice, index) => {
            if (voice && voice.channel === channelId && voice.deferred)
              this.release(index, voice);
          });
        break;
      case 120:
        this.voices.forEach((voice, index) => {
          if (!voice || voice.channel !== channelId) return;
          this.spu.write16(0x1c00 + index * 16, 0);
          this.spu.write16(0x1c02 + index * 16, 0);
          this.release(index, voice);
        });
        break;
      case 123:
        this.noteOff(channelId, undefined);
        break;
      case 121:
        channel.expression = 127;
        channel.pan = 64;
        channel.bend = 8192;
        channel.sustain = false;
        channel.nrpn = 127;
        channel.rpnHigh = 127;
        channel.rpnLow = 127;
        this.voices.forEach((voice, index) => {
          if (voice && voice.channel === channelId && voice.deferred)
            this.release(index, voice);
        });
        this.updateChannel(channelId);
        break;
      case 91:
        if (value) unsupported();
        break;
      case 98:
        if (value !== 0 && value !== 127) unsupported();
        break;
      case 100:
        channel.rpnLow = value;
        if (value !== 127) unsupported();
        break;
      case 101:
        channel.rpnHigh = value;
        if (value !== 127) unsupported();
        break;
      case 99:
        channel.nrpn = value;
        if (value === 20) {
          check(
            !this.scoreLoop,
            'SONY_COMMAND',
            'Nested loop marker at ' + offset,
          );
          this.scoreLoop = {
            position: this.reader.position,
            status: this.reader.status,
            channel: channelId,
            count: 127,
            remaining: 127,
            repeated: false,
            frame: this.frame,
          };
          this.loop = true;
          if (this.loopStart === undefined) this.loopStart = this.frame;
        } else if (value === 30) {
          const loop = this.scoreLoop;
          check(
            loop && loop.channel === channelId,
            'SONY_COMMAND',
            'Loop end without matching start at ' + offset,
          );
          if (this.loopEnd === null) this.loopEnd = this.frame;
          if (loop.count === 127 && !this.loopIsInfinite) {
            this.loopStart = loop.frame;
            this.loopEnd = this.frame;
            this.loopIsInfinite = true;
          }
          const repeat = loop.count === 127 || loop.remaining > 1;
          if (repeat) {
            check(
              this.frame > loop.frame,
              'SONY_COMMAND',
              'Zero-time loop at ' + offset,
            );
            if (loop.count !== 127) loop.remaining--;
            loop.repeated = true;
            loop.frame = this.frame;
            this.reader.position = loop.position;
            this.reader.status = loop.status;
          } else this.scoreLoop = undefined;
        } else if (value !== 127) unsupported();
        break;
      case 6: {
        const loop = this.scoreLoop;
        if (
          !loop ||
          loop.channel !== channelId ||
          (channel.nrpn !== 20 && !loop.repeated)
        )
          unsupported();
        if (loop && !loop.repeated) {
          loop.count = value;
          loop.remaining = value;
        }
        break;
      }
      default:
        unsupported();
    }
  }
  private execute(event: SequenceEvent) {
    if (event.status === 255) {
      if (event.a === 0x51) this.tempo = event.b;
      else {
        check(
          !this.scoreLoop,
          'SONY_COMMAND',
          'Unclosed loop at EOT ' + event.offset,
        );
        this.ended = true;
        for (let channel = 0; channel < 16; channel++)
          this.noteOff(channel, undefined, true);
      }
      return;
    }
    const channel = event.status & 15;
    switch (event.status & 0xf0) {
      case 0x80:
        this.noteOff(channel, event.a);
        break;
      case 0x90:
        if (event.b) this.noteOn(channel, event.a, event.b);
        else this.noteOff(channel, event.a);
        break;
      case 0xb0:
        this.controller(channel, event.a, event.b, event.offset);
        break;
      case 0xc0:
        this.state[channel].program = event.a;
        break;
      case 0xe0:
        this.state[channel].bend = event.a + event.b * 128;
        this.updateChannel(channel);
        break;
    }
  }
  private async events() {
    let budget = 0;
    while (!this.ended) {
      check(
        ++budget <= 65536,
        'SONY_COMMAND',
        'Event budget exceeded without an audio frame at ' +
          this.reader.position,
      );
      if (!this.pending) {
        this.pending = await this.reader.event();
        this.numerator +=
          BigInt(this.pending.delta) * BigInt(this.tempo) * 44100n;
        const scheduled = this.numerator / this.denominator;
        check(
          scheduled <= BigInt(Number.MAX_SAFE_INTEGER),
          'SONY_SEQUENCE',
          'Score timestamp exceeds safe frame range',
        );
        this.scheduled = Number(scheduled);
      }
      if (this.scheduled > this.frame) return;
      const event = this.pending;
      this.pending = undefined;
      this.execute(event);
    }
  }
  async read(frames: number): Promise<PcmBlock> {
    this.cancel();
    check(
      Number.isSafeInteger(frames) && frames >= 0 && frames <= 1048576,
      'SONY_SEQUENCE',
      'Invalid incremental read size ' + frames,
    );
    const start = this.frame,
      output = [new Float32Array(frames), new Float32Array(frames)];
    let written = 0;
    while (written < frames && this.length === null) {
      if (!(written & 255)) this.cancel();
      await this.events();
      if (this.ended && this.voices.every((voice) => voice === undefined)) {
        this.length = this.frame;
        break;
      }
      const audio = this.spu.sample();
      output[0][written] = audio[0];
      output[1][written] = audio[1];
      written++;
      this.frame++;
      this.voices.forEach((voice, index) => {
        if (!voice || this.frame <= voice.started + 6) return;
        if (
          (voice.released && this.spu.read16(0x1c0c + index * 16) === 0) ||
          (!voice.tone.sampleLoop && this.spu.ENDX & (1 << index))
        )
          this.voices[index] = undefined;
      });
      if (this.ended && this.voices.every((voice) => voice === undefined))
        this.length = this.frame;
    }
    this.cancel();
    return {
      channels: output.map((channel) => channel.subarray(0, written)),
      sampleRate: 44100,
      frame: start,
      done: this.length !== null,
      length: this.length,
      loop: this.loop,
      loopStart: this.loopStart,
      loopEnd: this.loopEnd,
      warnings: this.reverbRequested
        ? [
            {
              code: 'SONY_REVERB',
              detail:
                'Original tone reverb routing retained; VAB/SEQ does not supply the game global reverb preset.',
            },
          ]
        : [],
      engine: 'Sony SEQ / original VAB / PlayStation SPU',
    };
  }
}

export async function createSonySequenceDecoder(
  sequence: ByteSource,
  bank: ByteSource,
  body?: ByteSource,
  options: DecoderOptions = {},
): Promise<AudioDecoder> {
  const cancel = () =>
    check(
      !options.signal?.aborted &&
        !options.cancelled?.() &&
        !options.isCancelled?.(),
      'CANCELLED',
    );
  cancel();
  const info = await readSonySequence(sequence, options.name, cancel);
  const index = options.song ?? 0;
  check(
    Number.isSafeInteger(index) && index >= 0 && index < info.songs.length,
    'SONY_SEQUENCE',
    'Song index ' + index + ' outside ' + info.songs.length + ' songs',
  );
  const soundBank = await loadBank(bank, body, cancel);
  cancel();
  return new SonyDecoder(sequence, info.songs[index], soundBank, cancel);
}
