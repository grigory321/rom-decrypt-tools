import { createHash } from 'node:crypto';

import { ncch as audioNcch } from './helpers.js';

const put = (b, o, n) =>
  new DataView(b.buffer, b.byteOffset, b.byteLength).setUint32(o, n, true);

const hash = (b) => createHash('sha256').update(b).digest();

export function validNcch() {
  const old = audioNcch(),
    b = new Uint8Array(17408),
    r = b.subarray(1024);
  b.set(old.subarray(0, 512));
  put(b, 260, b.length / 512);
  put(b, 436, r.length / 512);
  r.set(Buffer.from('IVFC'));
  put(r, 4, 65536);
  put(r, 8, 32);
  for (const [i, logical, size] of [
    [0, 0, 32],
    [1, 4096, 32],
    [2, 8192, 512],
  ]) {
    put(r, 12 + i * 24, logical);
    put(r, 20 + i * 24, size);
    put(r, 28 + i * 24, 12);
  }
  put(r, 84, 92);
  r.set(old.subarray(5120, 5632), 4096);
  r.set(hash(r.subarray(4096, 8192)), 12288);
  r.set(hash(r.subarray(12288, 16384)), 8192);
  r.set(hash(r.subarray(8192, 12288)), 96);
  b.set(hash(r.subarray(0, 512)), 480);
  return b;
}

export function application() {
  const old = validNcch(),
    b = new Uint8Array(old.length + 2048);
  b.set(old.subarray(0, 512));
  b.set(old.subarray(1024), 3072);
  put(b, 260, b.length / 512);
  put(b, 432, 6);
  put(b, 384, 1024);
  b[397] = 2;
  b.set([1, 0, 0, 0, 0, 0, 4, 0], 264);
  b.set([1, 0, 0, 0, 0, 0, 4, 0], 280);
  b.set(Buffer.from('TESTAPP'), 512);
  put(b, 960, 512 * 1024);
  b[526] = 3;
  b.set(hash(b.subarray(512, 1536)), 352);
  return b;
}

export function cartridge() {
  const a = application(),
    manual = validNcch(),
    head = new Uint8Array(16384);
  manual[397] = 1;
  head.set(Buffer.from('NCSD'), 256);
  put(head, 260, (128 * 1024 * 1024) / 512);
  head.set(a.subarray(264, 272), 264);
  put(head, 288, 32);
  put(head, 292, a.length / 512);
  put(head, 304, (16384 + a.length) / 512);
  put(head, 308, manual.length / 512);
  return new Blob([head, a, manual]);
}
