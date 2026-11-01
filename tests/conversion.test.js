import test from 'node:test';

import assert from 'node:assert/strict';

import { createHash, createCipheriv, createDecipheriv } from 'node:crypto';

import { inspectRom, prepareConversion } from '../dist/conversion.js';

import { Bin } from '../dist/binary.js';

import { fixtureKey } from './helpers.js';

import { application, cartridge, validNcch } from './conversion-helpers.js';

const put = (b, o, n) =>
  new DataView(b.buffer, b.byteOffset, b.byteLength).setUint32(o, n, true);

const bytes = async (result) =>
  new Uint8Array(await result.source.read(0, result.source.size));

const sha = (b) => createHash('sha256').update(b).digest();

const code = (name) => (e) => e.code === name;

const tmdAt = (b) => {
  const h = new Bin(b),
    a = (n) => Math.ceil(n / 64) * 64;
  return a(8224) + a(h.u32(8)) + a(h.u32(12));
};

const repairInfo = (b) => {
  const o = tmdAt(b) + 320;
  b.set(sha(b.subarray(o + 196, o + 2500)), o + 164);
};

test('CIA rejects changed content metadata with stale group hashes', async () => {
  const b = await bytes(
    await prepareConversion(cartridge(), 'original.3ds', 'cia', {}),
  );
  b[tmdAt(b) + 320 + 2500 + 3] ^= 1;
  await assert.rejects(
    prepareConversion(new Blob([b]), 'bad.cia', 'decrypt', {}),
    code('TMD_CONTENT_HASH'),
  );
});

test('CIA rejects changed content-info table with stale top hash', async () => {
  const b = await bytes(
    await prepareConversion(cartridge(), 'original.3ds', 'cia', {}),
  );
  b[tmdAt(b) + 320 + 200] ^= 1;
  await assert.rejects(
    prepareConversion(new Blob([b]), 'bad.cia', 'decrypt', {}),
    code('TMD_INFO_HASH'),
  );
});

test('CIA rejects uncovered and out-of-bounds chunk ordinals even with a valid top hash', async () => {
  for (const count of [0, 3]) {
    const b = await bytes(
      await prepareConversion(cartridge(), 'original.3ds', 'cia', {}),
    );
    new DataView(b.buffer).setUint16(tmdAt(b) + 320 + 198, count, false);
    repairInfo(b);
    await assert.rejects(
      prepareConversion(new Blob([b]), 'bad.cia', 'decrypt', {}),
      code('TMD_COVERAGE'),
    );
  }
});

test('NCCH verifies the unencrypted logo region', async () => {
  const b = new Uint8Array(1024);
  b.set(Buffer.from('NCCH'), 256);
  put(b, 260, 2);
  b[274] = 2;
  b[399] = 4;
  put(b, 408, 1);
  put(b, 412, 1);
  b.fill(7, 512);
  b.set(sha(b.subarray(512)), 304);
  await prepareConversion(new Blob([b]), 'logo.cfa', 'decrypt', {});
  b[513] ^= 1;
  await assert.rejects(
    prepareConversion(new Blob([b]), 'bad.cfa', 'decrypt', {}),
    code('LOGO_HASH'),
  );
});

test('NCCH verifies each RomFS IVFC level below the master hash', async () => {
  await prepareConversion(new Blob([validNcch()]), 'rom.cfa', 'decrypt', {});
  for (const level of [4096, 8192, 12288]) {
    const b = validNcch();
    b[1024 + level + 1] ^= 1;
    await assert.rejects(
      prepareConversion(new Blob([b]), 'bad.cfa', 'decrypt', {}),
      code('IVFC_HASH'),
    );
  }
});

test('NCCH rejects an IVFC tree with insufficient hash coverage', async () => {
  const b = validNcch();
  put(b, 1024 + 44, 0);
  b.set(sha(b.subarray(1024, 1536)), 480);
  await assert.rejects(
    prepareConversion(new Blob([b]), 'bad.cfa', 'decrypt', {}),
    code('IVFC_LAYOUT'),
  );
});

test('3DS to CIA preserves sparse content indices, payloads and recomputes metadata hashes', async () => {
  const output = await prepareConversion(
      cartridge(),
      'original.3ds',
      'cia',
      {},
    ),
    data = await bytes(output),
    info = await inspectRom(new Blob([data]), 'out.cia', {});
  assert.deepEqual(
    info.contents.map((x) => x.index),
    [0, 2],
  );
  assert.equal(info.titleId, '0004000000000001');
  assert.equal(info.format, 'CIA');
  const main = await info.contents[0].source.read(0, 1536);
  assert.ok(main[525] & 2);
  assert.deepEqual(
    [...main.subarray(352, 384)],
    [...createHash('sha256').update(main.subarray(512, 1536)).digest()],
  );
  const t = new Bin(info.tmd),
    base = 320,
    table = t.slice(base + 196, 2304);
  assert.deepEqual(
    [...t.slice(base + 164, 32)],
    [...createHash('sha256').update(table).digest()],
  );
  assert.deepEqual(
    [...t.slice(base + 196 + 4, 32)],
    [
      ...createHash('sha256')
        .update(t.slice(base + 2500, 96))
        .digest(),
    ],
  );
});

test('CIA to CCI reconstructs slot 2, valid card-info CCM and clears the install flag', async () => {
  const cia = await bytes(
    await prepareConversion(cartridge(), 'in.3ds', 'cia', {}),
  );
  const out = await bytes(
    await prepareConversion(new Blob([cia]), 'in.cia', '3ds', {}),
  );
  const info = await inspectRom(new Blob([out]), 'out.3ds', {});
  assert.deepEqual(
    info.contents.map((x) => x.index),
    [0, 2],
  );
  assert.equal(out[397], 1);
  const h = new Bin(out);
  assert.equal(h.u32(512), 4294967295);
  assert.equal(h.u32(516, false), 192);
  assert.equal(h.u64(768), out.length);
  const main = await info.contents[0].source.read(0, 1536);
  assert.equal(main[525] & 2, 0);
  assert.deepEqual([...out.subarray(4352, 4608)], [...main.subarray(256, 512)]);
  const d = createDecipheriv(
    'aes-128-ccm',
    new Uint8Array(16),
    out.subarray(4144, 4156),
    {
      authTagLength: 16,
    },
  );
  d.setAuthTag(out.subarray(4128, 4144));
  d.setAAD(new Uint8Array(), {
    plaintextLength: 16,
  });
  assert.equal(
    Buffer.concat([d.update(out.subarray(4112, 4128)), d.final()]).length,
    16,
  );
});

test('full NCCH decrypt preserves clear gaps and decrypts exheader and RomFS with distinct keys', async () => {
  const b = application(),
    d = new DataView(b.buffer);
  b[399] = 0;
  b[395] = 1;
  const ky = b.subarray(0, 16),
    keyX = fixtureKey;
  const derive = (x, y) => {
    const mask = (1n << 128n) - 1n,
      r = (v, n) => ((v << BigInt(n)) | (v >> BigInt(128 - n))) & mask,
      toInt = (v) => BigInt('0x' + Buffer.from(v).toString('hex'));
    const n = r(
      ((r(toInt(x), 2) ^ toInt(y)) + 0x1ff9e9aac5fe0408024591dc5d52768an) &
        mask,
      87,
    );
    return Buffer.from(n.toString(16).padStart(32, '0'), 'hex');
  };
  const primary = derive(keyX, ky),
    secondary = derive(new Uint8Array(16).fill(9), ky),
    crypt = (data, key, section, offset = 0) => {
      const iv = Buffer.alloc(16);
      iv[1] = 4;
      iv[7] = 1;
      iv[8] = section;
      iv.writeUInt32BE(offset / 16, 12);
      const c = createCipheriv('aes-128-ctr', key, iv);
      return Buffer.concat([c.update(data), c.final()]);
    };
  const ex = b.subarray(512, 2560).slice();
  b.set(crypt(ex, primary, 1), 512);
  const rom = b.subarray(3072).slice();
  b.set(crypt(rom, secondary, 3), 3072);
  const out = await bytes(
    await prepareConversion(new Blob([b]), 'encrypted.cxi', 'decrypt', {
      slot0x2ckeyx: keyX,
      slot0x25keyx: new Uint8Array(16).fill(9),
    }),
  );
  assert.deepEqual([...out.subarray(512, 2560)], [...ex]);
  assert.deepEqual([...out.subarray(3072)], [...rom]);
  assert.equal(out[399] & 4, 4);
  assert.equal(out[395], 0);
});

test('mixed-key ExeFS decrypts a 37-byte code file while retaining primary-key icon and gaps', async () => {
  const app = application(),
    b = new Uint8Array(app.length + 1536),
    ex = new Uint8Array(1536);
  b.set(app);
  put(b, 260, b.length / 512);
  ex.set(Buffer.from('.code'), 0);
  put(ex, 8, 0);
  put(ex, 12, 37);
  ex.set(Buffer.from('icon'), 16);
  put(ex, 24, 512);
  put(ex, 28, 17);
  ex.fill(107, 512, 549);
  ex.fill(90, 549, 1024);
  ex.fill(76, 1024, 1041);
  ex.fill(61, 1041);
  ex.set(sha(ex.subarray(512, 549)), 480);
  ex.set(sha(ex.subarray(1024, 1041)), 448);
  put(b, 416, app.length / 512);
  put(b, 420, 3);
  put(b, 424, 1);
  b.set(sha(ex.subarray(0, 512)), 448);
  b[399] = 0;
  b[395] = 1;
  const mask = (1n << 128n) - 1n,
    rol = (v, n) => ((v << BigInt(n)) | (v >> BigInt(128 - n))) & mask;
  const derive = (x) => {
    const toInt = (v) => BigInt('0x' + Buffer.from(v).toString('hex'));
    const n = rol(
      ((rol(toInt(x), 2) ^ toInt(b.subarray(0, 16))) +
        0x1ff9e9aac5fe0408024591dc5d52768an) &
        mask,
      87,
    );
    return Buffer.from(n.toString(16).padStart(32, '0'), 'hex');
  };
  const secondX = new Uint8Array(16).fill(9),
    primary = derive(fixtureKey),
    secondary = derive(secondX);
  const crypt = (data, key, section) => {
    const iv = Buffer.alloc(16);
    iv[1] = 4;
    iv[7] = 1;
    iv[8] = section;
    const c = createCipheriv('aes-128-ctr', key, iv);
    return Buffer.concat([c.update(data), c.final()]);
  };
  b.set(crypt(b.subarray(512, 2560), primary, 1), 512);
  b.set(crypt(b.subarray(3072, app.length), secondary, 3), 3072);
  const encrypted = crypt(ex, primary, 2);
  encrypted.set(crypt(ex, secondary, 2).subarray(512, 549), 512);
  b.set(encrypted, app.length);
  const out = await bytes(
    await prepareConversion(new Blob([b]), 'mixed.cxi', 'decrypt', {
      slot0x2ckeyx: fixtureKey,
      slot0x25keyx: secondX,
    }),
  );
  assert.deepEqual(out.subarray(app.length), ex);
});

test('automatic parameter catalog loads without a manual user key', async () => {
  const { automaticKeys: automaticKeys } = await import('../dist/defaults.js');
  const k = await automaticKeys();
  assert.equal(k.slot0x2ckeyx.length, 16);
  assert.equal(k.common0normal.length, 16);
  assert.ok(Object.keys(k).filter((n) => n.startsWith('seed_')).length > 1800);
});
