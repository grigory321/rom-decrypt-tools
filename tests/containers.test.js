import test from 'node:test';

import assert from 'node:assert/strict';

import { createCipheriv, createHash } from 'node:crypto';

import { readSource } from '../dist/containers.js';

import { blobSource } from '../dist/binary.js';

import { cwav, ncch, fixtureKey as key } from './helpers.js';

const put = (b, o, n) =>
  new DataView(b.buffer, b.byteOffset, b.byteLength).setUint32(o, n, true);

test('plain NCCH indexes RomFS audio by actual filename', async () => {
  const result = await readSource(new Blob([ncch()]), 'game.cxi', {});
  assert.equal(result.assets.length, 1);
  assert.match(result.assets[0].name, /bgm.cwav/);
  assert.equal(new Blob([await result.assets[0].source.read(0, 4)]).size, 4);
});

test('encrypted NCCH: valid normal key decrypts RomFS; wrong key is rejected', async () => {
  const result = await readSource(new Blob([ncch(true)]), 'game.cxi', {
    ncchkey: key,
  });
  assert.equal(result.assets.length, 1);
  await assert.rejects(
    readSource(new Blob([ncch(true)]), 'game.cxi', {}),
    (e) => e.code === 'MISSING_KEY',
  );
  await assert.rejects(
    readSource(new Blob([ncch(true)]), 'game.cxi', {
      ncchkey: new Uint8Array(16),
    }),
    (e) => e.code === 'WRONG_KEY',
  );
});

test('CIA decrypts outer CBC independently of inner NCCH', async () => {
  const content = ncch();
  const tmdSize = 2868;
  const ticketOff = 8256,
    tmdOff = 9152,
    contentOff = 12032;
  const b = new Uint8Array(contentOff + content.length);
  const d = new DataView(b.buffer);
  put(b, 0, 8224);
  put(b, 12, 848);
  put(b, 16, tmdSize);
  put(b, 24, content.length);
  b[32] = 128;
  d.setUint32(ticketOff, 65540);
  d.setUint32(tmdOff, 65540);
  d.setUint16(tmdOff + 320 + 158, 1);
  const rec = tmdOff + 2820;
  d.setUint16(rec + 6, 1);
  d.setBigUint64(rec + 8, BigInt(content.length));
  b.set(createHash('sha256').update(content).digest(), rec + 16);
  const c = createCipheriv('aes-128-cbc', key, Buffer.alloc(16));
  c.setAutoPadding(false);
  b.set(Buffer.concat([c.update(content), c.final()]), contentOff);
  const result = await readSource(new Blob([b]), 'game.cia', {
    titlekey: key,
  });
  assert.equal(result.assets.length, 1);
});

test('bounded readers reject truncated and out-of-range inputs', async () => {
  await assert.rejects(
    blobSource(new Blob([new Uint8Array(4)])).read(3, 4),
    (e) => e.code === 'BOUNDS',
  );
  await assert.rejects(
    readSource(new Blob([new Uint8Array(7)]), 'bad.cia', {}),
  );
  const broken = ncch();
  put(broken, 436, 4294967295);
  await assert.rejects(readSource(new Blob([broken]), 'bad.cxi', {}));
});

test('CIA rejects a modified content with mismatching TMD SHA-256', async () => {
  const content = ncch(),
    originalHash = createHash('sha256').update(content).digest();
  content[5521] = 96;
  const b = new Uint8Array(12032 + content.length),
    d = new DataView(b.buffer);
  put(b, 0, 8224);
  put(b, 12, 848);
  put(b, 16, 2868);
  put(b, 24, content.length);
  b[32] = 128;
  d.setUint32(8256, 65540);
  d.setUint32(9152, 65540);
  d.setUint16(9152 + 478, 1);
  const r = 9152 + 2820;
  d.setUint16(r + 6, 1);
  d.setBigUint64(r + 8, BigInt(content.length));
  b.set(originalHash, r + 16);
  const c = createCipheriv('aes-128-cbc', key, Buffer.alloc(16));
  c.setAutoPadding(false);
  b.set(Buffer.concat([c.update(content), c.final()]), 12032);
  await assert.rejects(
    readSource(new Blob([b]), 'modified.cia', {
      titlekey: key,
    }),
    (e) => e.code === 'CONTENT_HASH',
  );
});
