/**
 * .spc container parsing: the machine snapshot plus the ID666 and xid6 tags.
 */

export interface SPCRegisters {
  pc: number;
  a: number;
  x: number;
  y: number;
  psw: number;
  sp: number;
}

export interface SPCTags {
  title?: string;
  game?: string;
  dumper?: string;
  comment?: string;
  artist?: string;
  publisher?: string;
  ostTitle?: string;
  ostDisc?: number;
  ostTrack?: number;
  copyrightYear?: number;
  date?: string;
  /** Seconds of playback before the fade starts (ID666). */
  playSeconds?: number;
  /** Fade length in milliseconds (ID666). */
  fadeMilliseconds?: number;
  /** Bit per voice: 1 = the dumper marked this channel as muted. */
  mutedVoices?: number;
  /** Intro length in seconds (xid6, converted from 64 kHz ticks). */
  introSeconds?: number;
  /** Loop length in seconds (xid6). */
  loopSeconds?: number;
  /** Length after the last loop, in seconds (xid6). */
  endSeconds?: number;
  /** Number of times the loop should repeat (xid6). */
  loopCount?: number;
  /** Playback amplification, 0x10000 = unity (xid6). */
  amplification?: number;
}

export interface SPCFile {
  registers: SPCRegisters;
  /** 64 KB APU RAM image. */
  ram: Uint8Array;
  /** 128 S-DSP registers. */
  dspRegs: Uint8Array;
  /** 64-byte boot ROM as captured by the dumper. */
  iplRom: Uint8Array;
  tags: SPCTags;
}

const SIGNATURE = "SNES-SPC700 Sound File Data";

/** xid6 timing fields are counted in 1/64000 s ticks. */
const XID6_TICKS_PER_SECOND = 64000;

function makeDecoder(): (bytes: Uint8Array) => string {
  for (const label of ["shift_jis", "windows-1252"]) {
    try {
      const dec = new TextDecoder(label);
      return (bytes) => dec.decode(bytes);
    } catch {
      /* not supported here, try the next one */
    }
  }
  return (bytes) => String.fromCharCode(...bytes);
}

const decode = makeDecoder();

function readText(data: Uint8Array, offset: number, length: number): string {
  let end = offset;
  const limit = Math.min(offset + length, data.length);
  while (end < limit && data[end] !== 0) end++;
  return decode(data.subarray(offset, end)).replace(/\0+$/, "").trim();
}

function isTextField(data: Uint8Array, offset: number, length: number): boolean {
  for (let i = offset; i < offset + length && i < data.length; i++) {
    const c = data[i];
    if (c === 0 || c === 0x20) continue;
    if (c >= 0x30 && c <= 0x39) continue;
    return false;
  }
  return true;
}

function parseId666(data: Uint8Array, tags: SPCTags): void {
  tags.title = readText(data, 0x2e, 32) || undefined;
  tags.game = readText(data, 0x4e, 32) || undefined;
  tags.dumper = readText(data, 0x6e, 16) || undefined;
  tags.comment = readText(data, 0x7e, 32) || undefined;

  // The ID666 block exists in two mutually incompatible layouts that the
  // format gives no flag for. The numeric fields are the only reliable tell:
  // in the text layout they are ASCII digits, in the binary layout they are
  // little-endian integers whose bytes are almost never all digit codepoints.
  const binary = !isTextField(data, 0xa9, 7);

  if (binary) {
    const y = data[0x9e] | (data[0x9f] << 8);
    const m = data[0xa0];
    const d = data[0xa1];
    if (y || m || d) tags.date = `${y}-${String(m).padStart(2, "0")}-${String(d).padStart(2, "0")}`;
    const seconds = data[0xa9] | (data[0xaa] << 8) | (data[0xab] << 16);
    const fade = data[0xac] | (data[0xad] << 8) | (data[0xae] << 16) | (data[0xaf] << 24);
    if (seconds > 0) tags.playSeconds = seconds;
    if (fade > 0) tags.fadeMilliseconds = fade >>> 0;
    tags.artist = readText(data, 0xb0, 32) || undefined;
    if (data[0xd0]) tags.mutedVoices = data[0xd0];
  } else {
    tags.date = readText(data, 0x9e, 11) || undefined;
    const seconds = parseInt(readText(data, 0xa9, 3), 10);
    const fade = parseInt(readText(data, 0xac, 5), 10);
    if (Number.isFinite(seconds) && seconds > 0) tags.playSeconds = seconds;
    if (Number.isFinite(fade) && fade > 0) tags.fadeMilliseconds = fade;
    tags.artist = readText(data, 0xb1, 32) || undefined;
    if (data[0xd1]) tags.mutedVoices = data[0xd1];
  }
}

function parseXid6(data: Uint8Array, tags: SPCTags): void {
  const base = 0x10200;
  if (data.length < base + 8) return;
  if (String.fromCharCode(data[base], data[base + 1], data[base + 2], data[base + 3]) !== "xid6") {
    return;
  }
  const view = new DataView(data.buffer, data.byteOffset, data.byteLength);
  const size = view.getUint32(base + 4, true);
  const end = Math.min(data.length, base + 8 + size);

  let p = base + 8;
  while (p + 4 <= end) {
    const id = data[p];
    const type = data[p + 1];
    const value = view.getUint16(p + 2, true);
    p += 4;

    let intValue = value;
    let strValue: string | undefined;

    if (type === 1) {
      strValue = readText(data, p, value);
      p += (value + 3) & ~3;
    } else if (type === 4) {
      if (p + 4 > end) break;
      intValue = view.getUint32(p, true);
      p += (value + 3) & ~3 || 4;
    }

    switch (id) {
      case 0x01: if (strValue) tags.title = strValue; break;
      case 0x02: if (strValue) tags.game = strValue; break;
      case 0x03: if (strValue) tags.artist = strValue; break;
      case 0x04: if (strValue) tags.dumper = strValue; break;
      case 0x07: if (strValue) tags.comment = strValue; break;
      case 0x10: if (strValue) tags.ostTitle = strValue; break;
      case 0x11: tags.ostDisc = intValue; break;
      case 0x12: tags.ostTrack = intValue >> 8 || intValue; break;
      case 0x13: if (strValue) tags.publisher = strValue; break;
      case 0x14: tags.copyrightYear = intValue; break;
      case 0x30: tags.introSeconds = intValue / XID6_TICKS_PER_SECOND; break;
      case 0x31: tags.loopSeconds = intValue / XID6_TICKS_PER_SECOND; break;
      case 0x32: tags.endSeconds = intValue / XID6_TICKS_PER_SECOND; break;
      case 0x33: tags.fadeMilliseconds = intValue / (XID6_TICKS_PER_SECOND / 1000); break;
      case 0x34: tags.mutedVoices = intValue; break;
      case 0x35: tags.loopCount = intValue; break;
      case 0x36: tags.amplification = intValue; break;
    }
  }
}

/** Recognise a buffer as an .spc dump without fully parsing it. */
export function isSPCFile(data: Uint8Array): boolean {
  if (data.length < 0x10180) return false;
  return readText(data, 0, SIGNATURE.length).startsWith(SIGNATURE);
}

/** Parse an .spc dump. Throws if the buffer is not a valid file. */
export function parseSPC(input: Uint8Array | ArrayBuffer): SPCFile {
  const data = input instanceof Uint8Array ? input : new Uint8Array(input);

  if (!isSPCFile(data)) {
    throw new Error("not an SPC file (bad signature or truncated)");
  }

  const view = new DataView(data.buffer, data.byteOffset, data.byteLength);
  const registers: SPCRegisters = {
    pc: view.getUint16(0x25, true),
    a: data[0x27],
    x: data[0x28],
    y: data[0x29],
    psw: data[0x2a],
    sp: data[0x2b],
  };

  const ram = data.slice(0x100, 0x100 + 0x10000);
  const dspRegs = data.slice(0x10100, 0x10180);
  const iplRom = new Uint8Array(64);
  if (data.length >= 0x10200) iplRom.set(data.subarray(0x101c0, 0x10200));

  const tags: SPCTags = {};
  // $23 holds 26 when the ID666 block is present, 27 when it was left out.
  if (data[0x23] !== 27) parseId666(data, tags);
  parseXid6(data, tags);

  return { registers, ram, dspRegs, iplRom, tags };
}

