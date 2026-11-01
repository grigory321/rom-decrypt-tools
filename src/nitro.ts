import type { ParsedTrack, PcmData } from './contracts.js';
import { Bin, check } from './binary.js';

interface SdatSymbolGroup {
  name: string | null;
  children: (string | null)[];
}

const steps = [
  7, 8, 9, 10, 11, 12, 13, 14, 16, 17, 19, 21, 23, 25, 28, 31, 34, 37, 41, 45,
  50, 55, 60, 66, 73, 80, 88, 97, 107, 118, 130, 143, 157, 173, 190, 209, 230,
  253, 279, 307, 337, 371, 408, 449, 494, 544, 598, 658, 724, 796, 876, 963,
  1060, 1166, 1282, 1411, 1552, 1707, 1878, 2066, 2272, 2499, 2749, 3024, 3327,
  3660, 4026, 4428, 4871, 5358, 5894, 6484, 7132, 7845, 8630, 9493, 10442,
  11487, 12635, 13899, 15289, 16818, 18500, 20350, 22385, 24623, 27086, 29794,
  32767,
];

export function ima(
  data: Uint8Array,
  predictor = 0,
  index = 0,
  lowFirst = true,
) {
  check(index <= 88, 'INVALID_AUDIO');
  const out = new Float32Array(data.length * 2);
  let at = 0;
  for (const byte of data) {
    for (let n = 0; n < 2; n++) {
      const v = (byte >> ((lowFirst ? n : 1 - n) * 4)) & 15,
        s = steps[index];
      let diff = s >> 3;
      if (v & 1) {
        diff += s >> 2;
      }
      if (v & 2) {
        diff += s >> 1;
      }
      if (v & 4) {
        diff += s;
      }
      predictor = Math.max(
        -32768,
        Math.min(32767, predictor + (v & 8 ? -diff : diff)),
      );
      index = Math.max(
        0,
        Math.min(88, index + [-1, -1, -1, -1, 2, 4, 6, 8][v & 7]),
      );
      out[at++] = predictor / 32768;
    }
  }
  return out;
}

export function decodeNitro(data: Uint8Array, type: number) {
  const b = new Bin(data);
  if (type === 0) {
    return Float32Array.from(data, (x) => (x >= 128 ? x - 256 : x) / 128);
  }
  if (type === 1) {
    const out = new Float32Array(Math.floor(data.length / 2));
    for (let i = 0; i < out.length; i++) {
      out[i] = b.i16(i * 2) / 32768;
    }
    return out;
  }
  if (type === 2) {
    return ima(b.slice(4, data.length - 4), b.i16(0), b.u8(2));
  }
  check(false, 'CODEC', String(type));
}

export function decodeSwav(data: Uint8Array, raw = false): PcmData {
  const b = new Bin(data),
    o = raw ? 0 : 24;
  check(raw || b.str(0, 4) === 'SWAV', 'INVALID_AUDIO');
  const type = b.u8(o),
    loop = !!b.u8(o + 1),
    rate = b.u16(o + 2),
    words = b.u16(o + 6) + b.u32(o + 8);
  check(
    rate >= 1e3 && rate <= 192e3 && words * 4 <= data.length - o - 12,
    'INVALID_AUDIO',
  );
  const pcm = decodeNitro(b.slice(o + 12, words * 4), type);
  const start =
    b.u16(o + 6) * (type === 0 ? 4 : type === 1 ? 2 : 8) - (type === 2 ? 8 : 0);
  return {
    channels: [pcm],
    sampleRate: rate,
    loop,
    loopStart: Math.max(0, start),
    loopEnd: pcm.length,
  };
}

function swavFile(raw: Uint8Array) {
  const out = new Uint8Array(24 + raw.length),
    b = new DataView(out.buffer);
  out.set([83, 87, 65, 86, 255, 254, 0, 1]);
  b.setUint32(8, out.length, true);
  b.setUint16(12, 16, true);
  b.setUint16(14, 1, true);
  out.set([68, 65, 84, 65], 16);
  b.setUint32(20, out.length - 16, true);
  out.set(raw, 24);
  return out;
}

export function waveAt(archive: Uint8Array, id: number) {
  const b = new Bin(archive);
  check(b.str(0, 4) === 'SWAR' && id < b.u32(56), 'MISSING_WAVE', String(id));
  const o = b.u32(60 + id * 4),
    n = new Bin(archive.subarray(o));
  const len = (n.u16(6) + n.u32(8)) * 4 + 12;
  return b.slice(o, len);
}

export function instrumentAt(data: Uint8Array, program: number, note: number) {
  const b = new Bin(data);
  check(
    b.str(0, 4) === 'SBNK' && program < b.u32(56),
    'MISSING_BANK',
    String(program),
  );
  let type = b.u8(60 + program * 4),
    off = b.u16(61 + program * 4);
  if (type === 16) {
    const lo = b.u8(off),
      hi = b.u8(off + 1);
    if (note < lo || note > hi) {
      return null;
    }
    off += 2 + (note - lo) * 12;
    type = b.u16(off);
    off += 2;
  } else if (type === 17) {
    let found = -1;
    for (let i = 0; i < 8; i++) {
      const hi = b.u8(off + i);
      if (note <= hi) {
        found = i;
        break;
      }
      if (!hi && i) {
        break;
      }
    }
    if (found < 0) {
      return null;
    }
    off += 8 + found * 12;
    type = b.u16(off);
    off += 2;
  }
  if (!type) {
    return null;
  }
  check([1, 2, 3].includes(type), 'INSTRUMENT', String(type));
  return {
    type,
    wave: b.u16(off),
    archive: b.u16(off + 2),
    base: b.u8(off + 4),
    attack: b.u8(off + 5),
    decay: b.u8(off + 6),
    sustain: b.u8(off + 7),
    release: b.u8(off + 8),
    pan: b.u8(off + 9),
  };
}

export function parseSdat(data: Uint8Array): ParsedTrack[] {
  const b = new Bin(data);
  check(b.str(0, 4) === 'SDAT', 'INVALID_AUDIO');
  const sy = b.u32(16),
    info = b.u32(24),
    fat = b.u32(32),
    count = b.u32(fat + 8);
  check(count <= 65536, 'TOO_MANY');
  const files: Uint8Array[] = [];
  for (let i = 0; i < count; i++) {
    const o = b.u32(fat + 12 + i * 16),
      n = b.u32(fat + 16 + i * 16);
    files.push(b.slice(o, n));
  }
  function entries(group: number) {
    const rel = b.u32(info + 8 + group * 4);
    if (!rel) {
      return [];
    }
    const t = info + rel,
      n = b.u32(t);
    check(n <= 65536, 'TOO_MANY');
    return Array.from(
      {
        length: n,
      },
      (_, i) => {
        const v = b.u32(t + 4 + i * 4);
        return v ? info + v : 0;
      },
    );
  }
  function symbols(group: number, sub: true): SdatSymbolGroup[];
  function symbols(group: number, sub?: false): (string | null)[];
  function symbols(
    group: number,
    sub = false,
  ): (string | null)[] | SdatSymbolGroup[] {
    if (!sy) {
      return [];
    }
    const rel = b.u32(sy + 8 + group * 4);
    if (!rel) {
      return [];
    }
    return sub ? symbolTable(sy + rel, true) : symbolTable(sy + rel);
  }
  function symbolTable(t: number, sub: true): SdatSymbolGroup[];
  function symbolTable(t: number, sub?: false): (string | null)[];
  function symbolTable(
    t: number,
    sub = false,
  ): (string | null)[] | SdatSymbolGroup[] {
    const n = b.u32(t);
    check(n <= 65536, 'TOO_MANY');
    if (!sub)
      return Array.from({ length: n }, (_, i) => {
        const offset = b.u32(t + 4 + i * 4);
        return offset ? b.zstr(sy + offset) : null;
      });
    return Array.from(
      {
        length: n,
      },
      (_, i) => {
        const o = b.u32(t + 4 + i * 8);
        const name = o ? b.zstr(sy + o) : null;
        const table = b.u32(t + 8 + i * 8);
        return {
          name,
          children: table ? symbolTable(sy + table) : [],
        };
      },
    );
  }
  const bankInfos = entries(2),
    waveInfos = entries(3),
    banks = bankInfos.map((o) => (o ? files[b.u16(o)] : null)),
    waveArchives = waveInfos.map((o) => (o ? files[b.u16(o)] : null));
  const tracks: ParsedTrack[] = [];
  function sequence(
    name: string,
    raw: Uint8Array,
    start: number,
    bankID: number,
    volume: number,
    format: string,
    events: Uint8Array,
  ) {
    const bank = banks[bankID],
      o = bankInfos[bankID];
    const waves = o
      ? Array.from(
          {
            length: 4,
          },
          (_, i) => waveArchives[b.u16(o + 4 + i * 2)],
        )
      : [];
    tracks.push({
      name,
      format,
      kind: 'sequence',
      raw,
      sequence: events,
      start,
      bank,
      waves,
      volume,
      bankID,
      playable: !!bank,
    });
  }
  const seqNames = symbols(0);
  for (const [i, o] of entries(0).entries()) {
    if (!o) {
      continue;
    }
    const raw = files[b.u16(o)];
    check(raw, 'INVALID_SDAT');
    const q = new Bin(raw),
      base = q.u32(24);
    sequence(
      seqNames[i] || 'sequence_' + i,
      raw,
      0,
      b.u16(o + 4),
      b.u8(o + 6),
      'SSEQ',
      q.slice(base, raw.length - base),
    );
  }
  const arcNames = symbols(1, true);
  for (const [i, o] of entries(1).entries()) {
    if (!o) {
      continue;
    }
    const raw = files[b.u16(o)],
      q = new Bin(raw),
      base = q.u32(24),
      n = q.u32(28);
    check(n <= 65536, 'TOO_MANY');
    for (let j = 0; j < n; j++) {
      const p = 32 + j * 12,
        start = q.u32(p);
      if (start === 4294967295) {
        continue;
      }
      sequence(
        arcNames[i]?.children[j] ||
          `${arcNames[i]?.name || 'effects_' + i}_${j}`,
        raw,
        start,
        q.u16(p + 4),
        q.u8(p + 6),
        'SSAR',
        q.slice(base, raw.length - base),
      );
    }
  }
  const streamNames = symbols(7);
  for (const [i, o] of entries(7).entries()) {
    if (o) {
      tracks.push({
        name: streamNames[i] || 'stream_' + i,
        format: 'STRM',
        kind: 'stream',
        raw: files[b.u16(o)],
        playable: true,
      });
    }
  }
  const waveNames = symbols(3);
  for (const [i, archive] of waveArchives.entries()) {
    if (!archive) {
      continue;
    }
    const n = new Bin(archive).u32(56);
    check(n <= 65536, 'TOO_MANY');
    for (let j = 0; j < n; j++) {
      const raw = swavFile(waveAt(archive, j));
      tracks.push({
        name: `${waveNames[i] || 'wave_' + i} / ${String(j).padStart(3, '0')}`,
        format: 'SWAV',
        kind: 'sample',
        raw,
        playable: true,
      });
    }
  }
  return tracks;
}
