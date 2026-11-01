import type { ByteSource, ProgressReporter, KeySet } from './contracts.js';
import './vendor/aes.js';

import { sha256 as streamingSha256 } from './vendor/noble/sha256.js';
import { Bin, bounds, bufferBytes, check } from './binary.js';
import { cacheSource } from './source-cache.js';

export const hex = (b: Uint8Array) =>
  Array.from(b, (x) => x.toString(16).padStart(2, '0')).join('');

export function unhex(s: string) {
  check(
    typeof s === 'string' && /^[0-9a-f]+$/i.test(s) && s.length % 2 === 0,
    'BAD_KEY',
  );
  return Uint8Array.from(s.match(/../g) || [], (x) => parseInt(x, 16));
}

const big = (b: Uint8Array) => BigInt('0x' + hex(b));

const bytes = (n: bigint) => unhex(n.toString(16).padStart(32, '0'));

const mask = (1n << 128n) - 1n;

const rol = (n: bigint, r: number) =>
  ((n << BigInt(r)) | (n >> BigInt(128 - r))) & mask;

export function scramble(x: Uint8Array, y: Uint8Array) {
  return bytes(
    rol(
      ((rol(big(x), 2) ^ big(y)) + 0x1ff9e9aac5fe0408024591dc5d52768an) & mask,
      87,
    ),
  );
}

export async function sha256(b: Uint8Array) {
  return new Uint8Array(await crypto.subtle.digest('SHA-256', bufferBytes(b)));
}

export async function sourceHash(
  src: ByteSource,
  report: ProgressReporter = () => {},
) {
  const hash = streamingSha256.create();
  for (let off = 0; off < src.size; off += 4 * 1024 * 1024) {
    const n = Math.min(4 * 1024 * 1024, src.size - off);
    hash.update(await src.read(off, n));
    report({
      phase: 'verify',
      value: (off + n) / src.size,
    });
  }
  return hash.digest();
}

export function parseKeys(text: string) {
  let obj: unknown;
  try {
    if (text.trim().startsWith('{')) {
      obj = JSON.parse(text);
    } else {
      const parsed: Record<string, string> = {};
      obj = parsed;
      for (const line of text.split(/\r?\n/)) {
        const s = line.replace(/[#;].*$/, '').trim();
        if (!s) {
          continue;
        }
        const m = s.match(/^([\w.]+)\s*[=:]\s*(\S+)$/);
        check(m, 'BAD_KEY');
        parsed[m[1]] = m[2];
      }
    }
  } catch {
    check(false, 'BAD_KEY');
  }
  check(isKeyObject(obj), 'BAD_KEY');
  const out: KeySet = {};
  for (const [raw, value] of Object.entries(obj)) {
    const name = raw
      .toLowerCase()
      .replace(/^commonkey(\d+)$/, 'common$1')
      .replace(/^keyx(2c|25|18|1b)$/, 'slot0x$1keyx');
    if (
      !/^(slot0x[0-9a-f]{2}key[xy]|common\d+(keyy|normal)?|titlekey(_[0-9a-f]{16})?|ncchkey(_[0-9a-f]{16})?|seed_[0-9a-f]{16}|fixedsystemkey)$/.test(
        name,
      )
    ) {
      continue;
    }
    check(
      typeof value === 'string' && /^[0-9a-f]{32}$/i.test(value),
      'BAD_KEY',
      raw,
    );
    out[name] = unhex(value);
  }
  check(Object.keys(out).length > 0, 'KEY_NAME');
  return out;
}

export async function importKeyFile(name: string, data: Uint8Array) {
  const lower = name.toLowerCase(),
    b = new Bin(data);
  if (lower.endsWith('seeddb.bin')) {
    const count = b.u32(0);
    check(count <= 1e5 && data.length >= 16 + count * 32, 'BAD_SEEDDB');
    const out: KeySet = {};
    for (let i = 0; i < count; i++) {
      const off = 16 + i * 32;
      out['seed_' + hex(b.slice(off, 8).slice().reverse())] = b
        .slice(off + 8, 16)
        .slice();
    }
    return out;
  }
  if (/boot9(_prot)?\.bin$/.test(lower)) {
    check(data.length === 32768 || data.length === 65536, 'BAD_BOOT9');
    const digest = hex(await sha256(data));
    check(
      [
        '2f88744feed717856386400a44bba4b9ca62e76a32c715d4f309c399bf28166f',
        '7331f7edece3dd33f2ab4bd0b3a5d607229fd19212c10b734cedcaf78c1a7b98',
      ].includes(digest),
      'BAD_BOOT9',
    );
    const base = (data.length === 65536 ? 32768 : 0) + 22624;
    return {
      slot0x2ckeyx: b.slice(base + 368, 16).slice(),
      slot0x3dkeyx: b.slice(base + 448, 16).slice(),
    };
  }
  return parseKeys(new TextDecoder().decode(data));
}

export function ctrSource(
  src: ByteSource,
  key: Uint8Array,
  counter: Uint8Array,
): ByteSource {
  let imported: Promise<CryptoKey> | undefined;
  return cacheSource({
    size: src.size,
    async read(o, n) {
      bounds(src.size, o, n);
      if (!n) {
        return new Uint8Array();
      }
      const start = o - (o % 16),
        skip = o % 16,
        data = await src.read(start, n + skip),
        iv = bytes((big(counter) + BigInt(start / 16)) & mask);
      if (globalThis.crypto?.subtle) {
        imported ||= crypto.subtle.importKey(
          'raw',
          bufferBytes(key),
          'AES-CTR',
          false,
          ['decrypt'],
        );
        const k = await imported;
        return new Uint8Array(
          await crypto.subtle.decrypt(
            {
              name: 'AES-CTR',
              counter: bufferBytes(iv),
              length: 128,
            },
            k,
            bufferBytes(data),
          ),
        ).subarray(skip);
      }
      return new globalThis.aesjs.ModeOfOperation.ctr(
        key,
        new globalThis.aesjs.Counter(iv),
      )
        .decrypt(data)
        .subarray(skip);
    },
  });
}

export function cbcSource(
  src: ByteSource,
  key: Uint8Array,
  iv: Uint8Array,
): ByteSource {
  let imported: Promise<CryptoKey> | undefined;
  return cacheSource({
    size: src.size,
    async read(o, n) {
      bounds(src.size, o, n);
      if (!n) {
        return new Uint8Array();
      }
      const start = o - (o % 16),
        end = Math.ceil((o + n) / 16) * 16;
      bounds(src.size, start, end - start);
      const actualIV = start ? await src.read(start - 16, 16) : iv;
      const data = await src.read(start, end - start);
      if (globalThis.crypto?.subtle) {
        const pad = data.slice(-16);
        for (let i = 0; i < 16; i++) {
          pad[i] ^= 16;
        }
        const last = new globalThis.aesjs.AES(key).encrypt(pad),
          extended = new Uint8Array(data.length + 16);
        extended.set(data);
        extended.set(last, data.length);
        imported ||= crypto.subtle.importKey(
          'raw',
          bufferBytes(key),
          'AES-CBC',
          false,
          ['decrypt'],
        );
        const k = await imported;
        return new Uint8Array(
          await crypto.subtle.decrypt(
            {
              name: 'AES-CBC',
              iv: bufferBytes(actualIV),
            },
            k,
            extended,
          ),
        ).subarray(o - start, o - start + n);
      }
      return new globalThis.aesjs.ModeOfOperation.cbc(key, actualIV)
        .decrypt(data)
        .subarray(o - start, o - start + n);
    },
  });
}

export function ncchCounter(h: Uint8Array, section: number, offset: number) {
  const out = new Uint8Array(16),
    b = new Bin(h),
    version = b.u16(274);
  if (version === 1) {
    out.set(h.subarray(264, 272));
    new DataView(out.buffer).setUint32(12, offset, false);
  } else {
    out.set(h.subarray(264, 272).slice().reverse());
    out[8] = section;
  }
  return out;
}

export function signatureBody(b: Uint8Array) {
  const type = new Bin(b).u32(0, false);
  const sizes: Record<number, number> = {
    65536: 576,
    65537: 320,
    65538: 128,
    65539: 576,
    65540: 320,
    65541: 128,
  };
  check(sizes[type], 'SIGNATURE');
  return sizes[type];
}

export function ciaTitleKey(ticket: Uint8Array, keys: KeySet) {
  const t = new Bin(ticket),
    base = signatureBody(ticket),
    id = hex(t.slice(base + 156, 8)),
    index = t.u8(base + 177);
  if (keys['titlekey_' + id] || keys.titlekey) {
    return keys['titlekey_' + id] || keys.titlekey;
  }
  let common = keys['common' + index + 'normal'];
  const y = keys['common' + index + 'keyy'] || keys['common' + index];
  if (!common && y && keys.slot0x3dkeyx) {
    common = scramble(keys.slot0x3dkeyx, y);
  }
  check(
    common,
    'MISSING_KEY',
    y && !keys.slot0x3dkeyx
      ? 'slot0x3dkeyx'
      : 'common' +
          index +
          ' + slot0x3dkeyx / common' +
          index +
          'normal / titlekey_' +
          id,
  );
  const iv = new Uint8Array(16);
  iv.set(t.slice(base + 156, 8));
  return new globalThis.aesjs.ModeOfOperation.cbc(common, iv).decrypt(
    t.slice(base + 127, 16),
  );
}

export async function ncchKey(
  header: Uint8Array,
  keys: KeySet,
  secondary = true,
) {
  const b = new Bin(header),
    flags = b.u8(399),
    id = hex(b.slice(280, 8).slice().reverse());
  if (keys['ncchkey_' + id] || keys.ncchkey) {
    return keys['ncchkey_' + id] || keys.ncchkey;
  }
  if (flags & 1) {
    if (!(b.u8(284) & 16)) {
      return new Uint8Array(16);
    }
    check(keys.fixedsystemkey, 'MISSING_KEY', 'fixedsystemkey');
    return keys.fixedsystemkey;
  }
  const slot = secondary ? cryptoSlots[b.u8(395)] : '2c';
  check(slot, 'CRYPTO_METHOD');
  const x = keys['slot0x' + slot + 'keyx'];
  check(x, 'MISSING_KEY', 'slot0x' + slot + 'keyx');
  let y = b.slice(0, 16);
  if (secondary && flags & 32) {
    const seed = keys['seed_' + id];
    check(seed, 'MISSING_KEY', 'seed_' + id);
    const verify = new Uint8Array(24);
    verify.set(seed);
    verify.set(b.slice(280, 8), 16);
    check(
      hex((await sha256(verify)).subarray(0, 4)) === hex(b.slice(276, 4)),
      'WRONG_SEED',
      id,
    );
    const v = new Uint8Array(32);
    v.set(y);
    v.set(seed, 16);
    y = (await sha256(v)).subarray(0, 16);
  }
  return scramble(x, y);
}

const cryptoSlots: Record<number, string> = {
  0: '2c',
  1: '25',
  10: '18',
  11: '1b',
};

function isKeyObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}
