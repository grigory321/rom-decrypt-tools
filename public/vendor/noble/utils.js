import { crypto } from './crypto.js';

export function isBytes(a) {
  return (
    a instanceof Uint8Array ||
    (ArrayBuffer.isView(a) && a.constructor.name === 'Uint8Array')
  );
}

export function anumber(n) {
  if (!Number.isSafeInteger(n) || n < 0) {
    throw new Error('positive integer expected, got ' + n);
  }
}

export function abytes(b, ...lengths) {
  if (!isBytes(b)) {
    throw new Error('Uint8Array expected');
  }
  if (lengths.length > 0 && !lengths.includes(b.length)) {
    throw new Error(
      'Uint8Array expected of length ' + lengths + ', got length=' + b.length,
    );
  }
}

export function ahash(h) {
  if (typeof h !== 'function' || typeof h.create !== 'function') {
    throw new Error('Hash should be wrapped by utils.createHasher');
  }
  anumber(h.outputLen);
  anumber(h.blockLen);
}

export function aexists(instance, checkFinished = true) {
  if (instance.destroyed) {
    throw new Error('Hash instance has been destroyed');
  }
  if (checkFinished && instance.finished) {
    throw new Error('Hash#digest() has already been called');
  }
}

export function aoutput(out, instance) {
  abytes(out);
  const min = instance.outputLen;
  if (out.length < min) {
    throw new Error(
      'digestInto() expects output buffer of length at least ' + min,
    );
  }
}

export function u8(arr) {
  return new Uint8Array(arr.buffer, arr.byteOffset, arr.byteLength);
}

export function u32(arr) {
  return new Uint32Array(
    arr.buffer,
    arr.byteOffset,
    Math.floor(arr.byteLength / 4),
  );
}

export function clean(...arrays) {
  for (let i = 0; i < arrays.length; i++) {
    arrays[i].fill(0);
  }
}

export function createView(arr) {
  return new DataView(arr.buffer, arr.byteOffset, arr.byteLength);
}

export function rotr(word, shift) {
  return (word << (32 - shift)) | (word >>> shift);
}

export function rotl(word, shift) {
  return (word << shift) | ((word >>> (32 - shift)) >>> 0);
}

export const isLE = (() =>
  new Uint8Array(new Uint32Array([287454020]).buffer)[0] === 68)();

export function byteSwap(word) {
  return (
    ((word << 24) & 4278190080) |
    ((word << 8) & 16711680) |
    ((word >>> 8) & 65280) |
    ((word >>> 24) & 255)
  );
}

export const swap8IfBE = isLE ? (n) => n : (n) => byteSwap(n);

export const byteSwapIfBE = swap8IfBE;

export function byteSwap32(arr) {
  for (let i = 0; i < arr.length; i++) {
    arr[i] = byteSwap(arr[i]);
  }
  return arr;
}

export const swap32IfBE = isLE ? (u) => u : byteSwap32;

const hasHexBuiltin = (() =>
  typeof Uint8Array.from([]).toHex === 'function' &&
  typeof Uint8Array.fromHex === 'function')();

const hexes = Array.from(
  {
    length: 256,
  },
  (_, i) => i.toString(16).padStart(2, '0'),
);

export function bytesToHex(bytes) {
  abytes(bytes);
  if (hasHexBuiltin) {
    return bytes.toHex();
  }
  let hex = '';
  for (let i = 0; i < bytes.length; i++) {
    hex += hexes[bytes[i]];
  }
  return hex;
}

const asciis = {
  _0: 48,
  _9: 57,
  A: 65,
  F: 70,
  a: 97,
  f: 102,
};

function asciiToBase16(ch) {
  if (ch >= asciis._0 && ch <= asciis._9) {
    return ch - asciis._0;
  }
  if (ch >= asciis.A && ch <= asciis.F) {
    return ch - (asciis.A - 10);
  }
  if (ch >= asciis.a && ch <= asciis.f) {
    return ch - (asciis.a - 10);
  }
  return;
}

export function hexToBytes(hex) {
  if (typeof hex !== 'string') {
    throw new Error('hex string expected, got ' + typeof hex);
  }
  if (hasHexBuiltin) {
    return Uint8Array.fromHex(hex);
  }
  const hl = hex.length;
  const al = hl / 2;
  if (hl % 2) {
    throw new Error('hex string expected, got unpadded hex of length ' + hl);
  }
  const array = new Uint8Array(al);
  for (let ai = 0, hi = 0; ai < al; ai++, hi += 2) {
    const n1 = asciiToBase16(hex.charCodeAt(hi));
    const n2 = asciiToBase16(hex.charCodeAt(hi + 1));
    if (n1 === undefined || n2 === undefined) {
      const char = hex[hi] + hex[hi + 1];
      throw new Error(
        'hex string expected, got non-hex character "' +
          char +
          '" at index ' +
          hi,
      );
    }
    array[ai] = n1 * 16 + n2;
  }
  return array;
}

export const nextTick = async () => {};

export async function asyncLoop(iters, tick, cb) {
  let ts = Date.now();
  for (let i = 0; i < iters; i++) {
    cb(i);
    const diff = Date.now() - ts;
    if (diff >= 0 && diff < tick) {
      continue;
    }
    await nextTick();
    ts += diff;
  }
}

export function utf8ToBytes(str) {
  if (typeof str !== 'string') {
    throw new Error('string expected');
  }
  return new Uint8Array(new TextEncoder().encode(str));
}

export function bytesToUtf8(bytes) {
  return new TextDecoder().decode(bytes);
}

export function toBytes(data) {
  if (typeof data === 'string') {
    data = utf8ToBytes(data);
  }
  abytes(data);
  return data;
}

export function kdfInputToBytes(data) {
  if (typeof data === 'string') {
    data = utf8ToBytes(data);
  }
  abytes(data);
  return data;
}

export function concatBytes(...arrays) {
  let sum = 0;
  for (let i = 0; i < arrays.length; i++) {
    const a = arrays[i];
    abytes(a);
    sum += a.length;
  }
  const res = new Uint8Array(sum);
  for (let i = 0, pad = 0; i < arrays.length; i++) {
    const a = arrays[i];
    res.set(a, pad);
    pad += a.length;
  }
  return res;
}

export function checkOpts(defaults, opts) {
  if (opts !== undefined && {}.toString.call(opts) !== '[object Object]') {
    throw new Error('options should be object or undefined');
  }
  const merged = Object.assign(defaults, opts);
  return merged;
}

export class Hash {}

export function createHasher(hashCons) {
  const hashC = (msg) => hashCons().update(toBytes(msg)).digest();
  const tmp = hashCons();
  hashC.outputLen = tmp.outputLen;
  hashC.blockLen = tmp.blockLen;
  hashC.create = () => hashCons();
  return hashC;
}

export function createOptHasher(hashCons) {
  const hashC = (msg, opts) => hashCons(opts).update(toBytes(msg)).digest();
  const tmp = hashCons({});
  hashC.outputLen = tmp.outputLen;
  hashC.blockLen = tmp.blockLen;
  hashC.create = (opts) => hashCons(opts);
  return hashC;
}

export function createXOFer(hashCons) {
  const hashC = (msg, opts) => hashCons(opts).update(toBytes(msg)).digest();
  const tmp = hashCons({});
  hashC.outputLen = tmp.outputLen;
  hashC.blockLen = tmp.blockLen;
  hashC.create = (opts) => hashCons(opts);
  return hashC;
}

export const wrapConstructor = createHasher;

export const wrapConstructorWithOpts = createOptHasher;

export const wrapXOFConstructorWithOpts = createXOFer;

export function randomBytes(bytesLength = 32) {
  if (crypto && typeof crypto.getRandomValues === 'function') {
    return crypto.getRandomValues(new Uint8Array(bytesLength));
  }
  if (crypto && typeof crypto.randomBytes === 'function') {
    return Uint8Array.from(crypto.randomBytes(bytesLength));
  }
  throw new Error('crypto.getRandomValues must be defined');
}
