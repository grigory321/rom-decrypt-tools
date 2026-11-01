const SIGNATURE = 'SNES-SPC700 Sound File Data';

const XID6_TICKS_PER_SECOND = 64e3;

function makeDecoder() {
  for (const label of ['shift_jis', 'windows-1252']) {
    try {
      const dec = new TextDecoder(label);
      return (bytes) => dec.decode(bytes);
    } catch {}
  }
  return (bytes) => String.fromCharCode(...bytes);
}

const decode = makeDecoder();

function readText(data, offset, length) {
  let end = offset;
  const limit = Math.min(offset + length, data.length);
  while (end < limit && data[end] !== 0) end++;
  return decode(data.subarray(offset, end)).replace(/\0+$/, '').trim();
}

function isTextField(data, offset, length) {
  for (let i = offset; i < offset + length && i < data.length; i++) {
    const c = data[i];
    if (c === 0 || c === 32) continue;
    if (c >= 48 && c <= 57) continue;
    return false;
  }
  return true;
}

function parseId666(data, tags) {
  tags.title = readText(data, 46, 32) || undefined;
  tags.game = readText(data, 78, 32) || undefined;
  tags.dumper = readText(data, 110, 16) || undefined;
  tags.comment = readText(data, 126, 32) || undefined;
  const binary = !isTextField(data, 169, 7);
  if (binary) {
    const y = data[158] | (data[159] << 8);
    const m = data[160];
    const d = data[161];
    if (y || m || d)
      tags.date = `${y}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
    const seconds = data[169] | (data[170] << 8) | (data[171] << 16);
    const fade =
      data[172] | (data[173] << 8) | (data[174] << 16) | (data[175] << 24);
    if (seconds > 0) tags.playSeconds = seconds;
    if (fade > 0) tags.fadeMilliseconds = fade >>> 0;
    tags.artist = readText(data, 176, 32) || undefined;
    if (data[208]) tags.mutedVoices = data[208];
  } else {
    tags.date = readText(data, 158, 11) || undefined;
    const seconds = parseInt(readText(data, 169, 3), 10);
    const fade = parseInt(readText(data, 172, 5), 10);
    if (Number.isFinite(seconds) && seconds > 0) tags.playSeconds = seconds;
    if (Number.isFinite(fade) && fade > 0) tags.fadeMilliseconds = fade;
    tags.artist = readText(data, 177, 32) || undefined;
    if (data[209]) tags.mutedVoices = data[209];
  }
}

function parseXid6(data, tags) {
  const base = 66048;
  if (data.length < base + 8) return;
  if (
    String.fromCharCode(
      data[base],
      data[base + 1],
      data[base + 2],
      data[base + 3],
    ) !== 'xid6'
  ) {
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
    let strValue;
    if (type === 1) {
      strValue = readText(data, p, value);
      p += (value + 3) & ~3;
    } else if (type === 4) {
      if (p + 4 > end) break;
      intValue = view.getUint32(p, true);
      p += (value + 3) & ~3 || 4;
    }
    switch (id) {
      case 1:
        if (strValue) tags.title = strValue;
        break;

      case 2:
        if (strValue) tags.game = strValue;
        break;

      case 3:
        if (strValue) tags.artist = strValue;
        break;

      case 4:
        if (strValue) tags.dumper = strValue;
        break;

      case 7:
        if (strValue) tags.comment = strValue;
        break;

      case 16:
        if (strValue) tags.ostTitle = strValue;
        break;

      case 17:
        tags.ostDisc = intValue;
        break;

      case 18:
        tags.ostTrack = intValue >> 8 || intValue;
        break;

      case 19:
        if (strValue) tags.publisher = strValue;
        break;

      case 20:
        tags.copyrightYear = intValue;
        break;

      case 48:
        tags.introSeconds = intValue / XID6_TICKS_PER_SECOND;
        break;

      case 49:
        tags.loopSeconds = intValue / XID6_TICKS_PER_SECOND;
        break;

      case 50:
        tags.endSeconds = intValue / XID6_TICKS_PER_SECOND;
        break;

      case 51:
        tags.fadeMilliseconds = intValue / (XID6_TICKS_PER_SECOND / 1e3);
        break;

      case 52:
        tags.mutedVoices = intValue;
        break;

      case 53:
        tags.loopCount = intValue;
        break;

      case 54:
        tags.amplification = intValue;
        break;
    }
  }
}

export function isSPCFile(data) {
  if (data.length < 65920) return false;
  return readText(data, 0, SIGNATURE.length).startsWith(SIGNATURE);
}

export function parseSPC(input) {
  const data = input instanceof Uint8Array ? input : new Uint8Array(input);
  if (!isSPCFile(data)) {
    throw new Error('not an SPC file (bad signature or truncated)');
  }
  const view = new DataView(data.buffer, data.byteOffset, data.byteLength);
  const registers = {
    pc: view.getUint16(37, true),
    a: data[39],
    x: data[40],
    y: data[41],
    psw: data[42],
    sp: data[43],
  };
  const ram = data.slice(256, 256 + 65536);
  const dspRegs = data.slice(65792, 65920);
  const iplRom = new Uint8Array(64);
  if (data.length >= 66048) iplRom.set(data.subarray(65984, 66048));
  const tags = {};
  if (data[35] !== 27) parseId666(data, tags);
  parseXid6(data, tags);
  return {
    registers: registers,
    ram: ram,
    dspRegs: dspRegs,
    iplRom: iplRom,
    tags: tags,
  };
}
