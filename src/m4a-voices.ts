import { Bin, check } from './binary.js';
import { M4aRom } from './m4a-rom.js';
import type { M4aTrack } from './m4a-types.js';

const pitchScale = [
  2147483648, 2275179671, 2410468894, 2553802834, 2705659852, 2866546760,
  3037000500, 3217589947, 3408917802, 3611622603, 3826380858, 4053909305,
];

export interface M4aInstrument {
  bytes: Uint8Array;
  key: number;
  pan: number;
}

export interface M4aVoice {
  track: number;
  key: number;
  velocity: number;
  gate: number;
  priority: number;
  tone: Uint8Array;
  pitchKey: number;
  pan: number;
  state: 'attack' | 'decay' | 'sustain' | 'release' | 'echo' | 'off';
  envelope: number;
  echoVolume: number;
  echoLength: number;
  counter: number;
  goal: number;
  phase: number;
  position: number;
  compressed: boolean;
  wave: {
    offset: number;
    size: number;
    frequency: number;
    loop: boolean;
    loopStart: number;
  } | null;
  data: Uint8Array;
  dataOffset: number;
  fixed: boolean;
  reverse: boolean;
  hardware: number;
  slot: number;
  started: boolean;
  psgFrequency: number;
  psgLeft: number;
  psgRight: number;
  echoRatio: number;
  dirty: boolean;
}

export async function resolveM4aInstrument(
  rom: M4aRom,
  bytes: Uint8Array,
  key: number,
): Promise<M4aInstrument> {
  let selected = bytes;
  let pitchKey = key;
  let pan = 0;
  if (bytes[0] & 0xc0) {
    check((bytes[0] & 0xc0) !== 0xc0, 'GBA_M4A_INSTRUMENT');
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    const bank = rom.offset(view.getUint32(4, true), 12);
    const program =
      bytes[0] & 0x40
        ? await rom.byte(rom.offset(view.getUint32(8, true), 128) + key)
        : key;
    selected = await rom.bytes(bank + program * 12, 12);
    check(
      !(selected[0] & 0xc0),
      'GBA_M4A_INSTRUMENT',
      'Nested instrument map.',
    );
    if (bytes[0] & 0x80) {
      pitchKey = selected[1];
      if (selected[3] & 128) pan = (((selected[3] - 0xc0) * 2) << 24) >> 24;
    }
  }
  check((selected[0] & 7) <= 4, 'GBA_M4A_INSTRUMENT');
  return { bytes: selected, key: pitchKey, pan };
}

export async function readM4aWave(
  rom: M4aRom,
  pointer: number,
  special = false,
) {
  const offset = rom.offset(pointer, 16);
  const header = new Bin(await rom.bytes(offset, 16));
  const flags = header.u32(0);
  const encoding = flags & 65535;
  check(
    encoding === 0 || (special && encoding === 1),
    'GBA_M4A_SAMPLE',
    'Unsupported original wave encoding.',
  );
  const compressed = encoding === 1;
  const size = header.u32(12);
  const loopStart = header.u32(8);
  const extent = compressed ? Math.ceil(size / 64) * 33 : size;
  check(
    (flags & 0x3fff0000) === 0 &&
      size > 0 &&
      extent <= rom.source.size - offset - 16,
    'GBA_M4A_SAMPLE',
  );
  const loop = !!(flags & 0xc0000000);
  check(!loop || loopStart < size, 'GBA_M4A_SAMPLE');
  const frequency = header.u32(4);
  check(frequency > 0, 'GBA_M4A_SAMPLE');
  return { offset: offset + 16, size, frequency, loop, loopStart, compressed };
}

export function m4aPitch(track: M4aTrack, key: number) {
  let pitch =
    4 * (track.tune + track.bend * track.bendRange) + 256 * track.keyShift;
  if (track.lfoType === 0) pitch += 16 * track.modulation;
  const shift = ((pitch >> 8) << 24) >> 24;
  return { key: Math.max(0, key + shift) & 255, fine: pitch & 255 };
}

export function m4aFrequency(
  frequency: number,
  key: number,
  fine: number,
): number {
  if (key > 178) fine = 255;
  const bounded = Math.min(178, Math.max(0, key));
  const scale = (note: number) =>
    pitchScale[note % 12] >>> (14 - Math.floor(note / 12));
  const first = scale(bounded);
  const factor =
    first + Math.floor(((scale(bounded + 1) - first) * fine) / 256);
  return Number((BigInt(frequency) * BigInt(factor)) >> 32n) >>> 0;
}

export function m4aVolume(
  track: M4aTrack,
  velocity: number,
  rhythmPan: number,
): [number, number] {
  let volume = (track.volume * 64) >> 5;
  if (track.lfoType === 1) volume = (volume * (track.modulation + 128)) >>> 7;
  const pan = Math.max(
    -128,
    Math.min(127, 2 * track.pan + (track.lfoType === 2 ? track.modulation : 0)),
  );
  const right = (((pan + 128) * volume) >>> 8) & 255;
  const left = (((127 - pan) * volume) >>> 8) & 255;
  return [
    Math.min(255, (velocity * (127 - rhythmPan) * left) >> 14),
    Math.min(255, (velocity * (rhythmPan + 128) * right) >> 14),
  ];
}

export function releaseM4aVoice(voice: M4aVoice) {
  if (
    voice.state === 'off' ||
    voice.state === 'release' ||
    voice.state === 'echo'
  )
    return;
  if (voice.started === false) {
    voice.state = 'off';
    voice.envelope = 0;
    return;
  }
  voice.state = 'release';
  voice.counter = voice.tone[11];
  voice.dirty = true;
}

export function pcmEnvelope(voice: M4aVoice) {
  if (voice.state === 'off') return;
  voice.started = true;
  if (voice.state === 'attack') {
    voice.envelope = Math.min(255, voice.envelope + voice.tone[8]);
    if (voice.envelope === 255) voice.state = 'decay';
  } else if (voice.state === 'decay') {
    voice.envelope = (voice.envelope * voice.tone[9]) >> 8;
    if (voice.envelope <= voice.tone[10]) {
      voice.envelope = voice.tone[10];
      voice.state = 'sustain';
    }
  } else if (voice.state === 'release')
    voice.envelope = (voice.envelope * voice.tone[11]) >> 8;
  else if (voice.state === 'echo') {
    if (voice.echoLength > 0) voice.echoLength--;
    if (!voice.echoLength) voice.state = 'off';
    return;
  }
  if (
    (voice.state === 'release' && voice.envelope <= voice.echoVolume) ||
    (voice.state === 'sustain' && !voice.envelope)
  ) {
    if (voice.echoVolume) {
      voice.envelope = voice.echoVolume;
      voice.state = 'echo';
    } else {
      voice.envelope = 0;
      voice.state = 'off';
    }
  }
}
