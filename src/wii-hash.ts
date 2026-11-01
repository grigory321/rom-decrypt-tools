import { check } from './binary.js';

const rotate = (value: number, bits: number) =>
  (value << bits) | (value >>> (32 - bits));

export class Sha1 {
  state: Uint32Array;
  pending: Uint8Array;
  words: Uint32Array;
  length: number;
  used: number;
  finished: boolean;
  constructor() {
    this.state = Uint32Array.of(
      0x67452301,
      0xefcdab89,
      0x98badcfe,
      0x10325476,
      0xc3d2e1f0,
    );
    this.pending = new Uint8Array(64);
    this.words = new Uint32Array(80);
    this.length = 0;
    this.used = 0;
    this.finished = false;
  }
  block(bytes: Uint8Array, offset: number) {
    const view = new DataView(bytes.buffer, bytes.byteOffset + offset, 64),
      words = this.words;
    for (let i = 0; i < 16; i++) words[i] = view.getUint32(i * 4, false);
    for (let i = 16; i < 80; i++)
      words[i] = rotate(
        words[i - 3] ^ words[i - 8] ^ words[i - 14] ^ words[i - 16],
        1,
      );
    let [a, b, c, d, e] = this.state;
    for (let i = 0; i < 80; i++) {
      const functionValue =
        i < 20
          ? (b & c) | (~b & d)
          : i < 40
            ? b ^ c ^ d
            : i < 60
              ? (b & c) | (b & d) | (c & d)
              : b ^ c ^ d;
      const constant =
        i < 20
          ? 0x5a827999
          : i < 40
            ? 0x6ed9eba1
            : i < 60
              ? 0x8f1bbcdc
              : 0xca62c1d6;
      const next =
        (rotate(a, 5) + functionValue + e + constant + words[i]) >>> 0;
      e = d;
      d = c;
      c = rotate(b, 30);
      b = a;
      a = next;
    }
    this.state[0] += a;
    this.state[1] += b;
    this.state[2] += c;
    this.state[3] += d;
    this.state[4] += e;
  }
  update(bytes: Uint8Array) {
    check(!this.finished && bytes instanceof Uint8Array, 'HASH_STATE');
    this.length += bytes.length;
    check(Number.isSafeInteger(this.length), 'TOO_LARGE');
    let offset = 0;
    if (this.used) {
      const amount = Math.min(64 - this.used, bytes.length);
      this.pending.set(bytes.subarray(0, amount), this.used);
      this.used += amount;
      offset += amount;
      if (this.used === 64) {
        this.block(this.pending, 0);
        this.used = 0;
      }
    }
    while (offset + 64 <= bytes.length) {
      this.block(bytes, offset);
      offset += 64;
    }
    if (offset < bytes.length) {
      this.pending.set(bytes.subarray(offset));
      this.used = bytes.length - offset;
    }
    return this;
  }
  digest() {
    check(!this.finished, 'HASH_STATE');
    const suffix = new Uint8Array(this.used < 56 ? 64 : 128);
    suffix.set(this.pending.subarray(0, this.used));
    suffix[this.used] = 0x80;
    new DataView(suffix.buffer).setBigUint64(
      suffix.length - 8,
      BigInt(this.length) * 8n,
      false,
    );
    for (let offset = 0; offset < suffix.length; offset += 64)
      this.block(suffix, offset);
    this.finished = true;
    const output = new Uint8Array(20),
      view = new DataView(output.buffer);
    for (let i = 0; i < 5; i++) view.setUint32(i * 4, this.state[i], false);
    return output;
  }
}

export const hash160 = (bytes: Uint8Array) => new Sha1().update(bytes).digest();

export function equalBytes(left: Uint8Array, right: Uint8Array) {
  if (left.length !== right.length) return false;
  let different = 0;
  for (let i = 0; i < left.length; i++) different |= left[i] ^ right[i];
  return different === 0;
}
