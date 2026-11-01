import {
  Hash,
  abytes,
  aexists,
  aoutput,
  clean,
  createView,
  toBytes,
} from './utils.js';

export function setBigUint64(view, byteOffset, value, isLE) {
  if (typeof view.setBigUint64 === 'function') {
    return view.setBigUint64(byteOffset, value, isLE);
  }
  const _32n = BigInt(32);
  const _u32_max = BigInt(4294967295);
  const wh = Number((value >> _32n) & _u32_max);
  const wl = Number(value & _u32_max);
  const h = isLE ? 4 : 0;
  const l = isLE ? 0 : 4;
  view.setUint32(byteOffset + h, wh, isLE);
  view.setUint32(byteOffset + l, wl, isLE);
}

export function Chi(a, b, c) {
  return (a & b) ^ (~a & c);
}

export function Maj(a, b, c) {
  return (a & b) ^ (a & c) ^ (b & c);
}

export class HashMD extends Hash {
  constructor(blockLen, outputLen, padOffset, isLE) {
    super();
    this.finished = false;
    this.length = 0;
    this.pos = 0;
    this.destroyed = false;
    this.blockLen = blockLen;
    this.outputLen = outputLen;
    this.padOffset = padOffset;
    this.isLE = isLE;
    this.buffer = new Uint8Array(blockLen);
    this.view = createView(this.buffer);
  }
  update(data) {
    aexists(this);
    data = toBytes(data);
    abytes(data);
    const { view: view, buffer: buffer, blockLen: blockLen } = this;
    const len = data.length;
    for (let pos = 0; pos < len;) {
      const take = Math.min(blockLen - this.pos, len - pos);
      if (take === blockLen) {
        const dataView = createView(data);
        for (; blockLen <= len - pos; pos += blockLen) {
          this.process(dataView, pos);
        }
        continue;
      }
      buffer.set(data.subarray(pos, pos + take), this.pos);
      this.pos += take;
      pos += take;
      if (this.pos === blockLen) {
        this.process(view, 0);
        this.pos = 0;
      }
    }
    this.length += data.length;
    this.roundClean();
    return this;
  }
  digestInto(out) {
    aexists(this);
    aoutput(out, this);
    this.finished = true;
    const { buffer: buffer, view: view, blockLen: blockLen, isLE: isLE } = this;
    let { pos: pos } = this;
    buffer[pos++] = 128;
    clean(this.buffer.subarray(pos));
    if (this.padOffset > blockLen - pos) {
      this.process(view, 0);
      pos = 0;
    }
    for (let i = pos; i < blockLen; i++) {
      buffer[i] = 0;
    }
    setBigUint64(view, blockLen - 8, BigInt(this.length * 8), isLE);
    this.process(view, 0);
    const oview = createView(out);
    const len = this.outputLen;
    if (len % 4) {
      throw new Error('_sha2: outputLen should be aligned to 32bit');
    }
    const outLen = len / 4;
    const state = this.get();
    if (outLen > state.length) {
      throw new Error('_sha2: outputLen bigger than state');
    }
    for (let i = 0; i < outLen; i++) {
      oview.setUint32(4 * i, state[i], isLE);
    }
  }
  digest() {
    const { buffer: buffer, outputLen: outputLen } = this;
    this.digestInto(buffer);
    const res = buffer.slice(0, outputLen);
    this.destroy();
    return res;
  }
  _cloneInto(to) {
    to || (to = new this.constructor());
    to.set(...this.get());
    const {
      blockLen: blockLen,
      buffer: buffer,
      length: length,
      finished: finished,
      destroyed: destroyed,
      pos: pos,
    } = this;
    to.destroyed = destroyed;
    to.finished = finished;
    to.length = length;
    to.pos = pos;
    if (length % blockLen) {
      to.buffer.set(buffer);
    }
    return to;
  }
  clone() {
    return this._cloneInto();
  }
}

export const SHA256_IV = Uint32Array.from([
  1779033703, 3144134277, 1013904242, 2773480762, 1359893119, 2600822924,
  528734635, 1541459225,
]);

export const SHA224_IV = Uint32Array.from([
  3238371032, 914150663, 812702999, 4144912697, 4290775857, 1750603025,
  1694076839, 3204075428,
]);

export const SHA384_IV = Uint32Array.from([
  3418070365, 3238371032, 1654270250, 914150663, 2438529370, 812702999,
  355462360, 4144912697, 1731405415, 4290775857, 2394180231, 1750603025,
  3675008525, 1694076839, 1203062813, 3204075428,
]);

export const SHA512_IV = Uint32Array.from([
  1779033703, 4089235720, 3144134277, 2227873595, 1013904242, 4271175723,
  2773480762, 1595750129, 1359893119, 2917565137, 2600822924, 725511199,
  528734635, 4215389547, 1541459225, 327033209,
]);
