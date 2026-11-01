import { createCipheriv, createHash } from 'node:crypto';

const str = (b, o, s) => b.set(Buffer.from(s), o);

const put = (b, o, n) =>
  new DataView(b.buffer, b.byteOffset, b.byteLength).setUint32(o, n, true);

export const fixtureKey = Buffer.from(
  '000102030405060708090a0b0c0d0e0f',
  'hex',
);

export function cwav() {
  const b = new Uint8Array(160);
  str(b, 0, 'CWAV');
  b.set([255, 254], 4);
  b[6] = 64;
  put(b, 8, 33619968);
  put(b, 12, 160);
  b[16] = 2;
  b[20] = 0;
  b[21] = 112;
  put(b, 24, 64);
  put(b, 28, 72);
  b[32] = 1;
  b[33] = 112;
  put(b, 36, 136);
  put(b, 40, 24);
  str(b, 64, 'INFO');
  put(b, 68, 72);
  b[72] = 1;
  put(b, 76, 8e3);
  put(b, 84, 4);
  put(b, 92, 1);
  b[96] = 0;
  b[97] = 113;
  put(b, 100, 16);
  b[108] = 0;
  b[109] = 31;
  put(b, 112, 0);
  str(b, 136, 'DATA');
  put(b, 140, 24);
  new DataView(b.buffer).setInt16(144, 8192, true);
  new DataView(b.buffer).setInt16(146, -8192, true);
  return b;
}

export function ncch(encrypted = false) {
  const b = new Uint8Array(5632);
  str(b, 256, 'NCCH');
  put(b, 260, 11);
  b[274] = 2;
  b[399] = encrypted ? 0 : 4;
  put(b, 432, 2);
  put(b, 436, 9);
  put(b, 440, 1);
  b[264] = 1;
  b[286] = 4;
  const r = b.subarray(1024);
  str(r, 0, 'IVFC');
  put(r, 4, 65536);
  put(r, 8, 32);
  put(r, 76, 12);
  put(r, 60, 1024);
  put(r, 44, 12);
  const l = r.subarray(4096);
  put(l, 0, 40);
  put(l, 4, 40);
  put(l, 8, 4);
  put(l, 12, 44);
  put(l, 16, 24);
  put(l, 20, 68);
  put(l, 24, 4);
  put(l, 28, 72);
  put(l, 32, 64);
  put(l, 36, 256);
  put(l, 48, 4294967295);
  put(l, 52, 4294967295);
  put(l, 56, 0);
  put(l, 72, 0);
  put(l, 76, 4294967295);
  put(l, 88, 160);
  put(l, 100, 16);
  l.set(Buffer.from('bgm.cwav', 'utf16le'), 104);
  l.set(cwav(), 256);
  b.set(createHash('sha256').update(r.subarray(0, 512)).digest(), 480);
  if (encrypted) {
    const ctr = Buffer.alloc(16);
    ctr[7] = 1;
    ctr[8] = 3;
    const c = createCipheriv('aes-128-ctr', fixtureKey, ctr);
    b.set(Buffer.concat([c.update(r), c.final()]), 1024);
  }
  return b;
}
