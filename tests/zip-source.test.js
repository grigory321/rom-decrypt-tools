import test from 'node:test';
import assert from 'node:assert/strict';
import { unzipSync } from '../dist/vendor/fflate.mjs';
import { blobSource } from '../dist/binary.js';
import { createZipSource } from '../dist/zip-source.js';

function entry(path, bytes = new Uint8Array()) {
  const source = blobSource(new Blob([bytes]));
  return {
    path,
    size: source.size,
    kind: path.endsWith('/') ? 'directory' : 'nitrofs',
    source,
  };
}

async function collect(source, chunk = 73) {
  const bytes = new Uint8Array(source.size);
  for (let offset = 0; offset < source.size;) {
    const part = await source.read(
      offset,
      Math.min(chunk, source.size - offset),
    );
    assert.ok(part.length > 0);
    bytes.set(part, offset);
    offset += part.length;
  }
  return bytes;
}

const errorCode =
  (...codes) =>
  (error) =>
    codes.includes(error.code);

test('streamed ZIP64 independently extracts exact UTF-8 files and zero-size directories', async () => {
  const source = createZipSource([
    entry('data/'),
    entry('data/empty.bin'),
    entry('data/音楽.bin', new Uint8Array([0, 1, 2, 255])),
    entry('crc.txt', new TextEncoder().encode('123456789')),
  ]);
  const bytes = await collect(source),
    files = unzipSync(bytes);
  assert.deepEqual(Object.keys(files), [
    'data/',
    'data/empty.bin',
    'data/音楽.bin',
    'crc.txt',
  ]);
  assert.deepEqual(files['data/音楽.bin'], new Uint8Array([0, 1, 2, 255]));
  const central = Buffer.from(bytes).lastIndexOf(
    Buffer.from([0x50, 0x4b, 0x01, 0x02]),
  );
  assert.ok(central > 0);
  assert.equal(
    new DataView(bytes.buffer).getUint32(central + 16, true),
    0xcbf43926,
  );
  assert.equal(
    new DataView(bytes.buffer).getUint32(bytes.length - 22, true),
    0x06054b50,
  );
});

test('zero-file ZIP64 is a valid deterministic independent archive', async () => {
  const source = createZipSource([]),
    bytes = await collect(source, 1);
  assert.equal(source.size, 98);
  assert.deepEqual(Object.keys(unzipSync(bytes)), []);
  assert.deepEqual(bytes, await collect(createZipSource([]), 30));
});

test('ZIP creation reads no file bytes and a multi-megabyte read stays bounded and lazy', async () => {
  const reads = [],
    source = {
      size: 5 * 1024 * 1024,
      async read(offset, length) {
        assert.ok(length <= 1024 * 1024);
        reads.push([offset, length]);
        return new Uint8Array(length).fill(0x65);
      },
    },
    zip = createZipSource([
      { path: 'large.bin', size: source.size, kind: 'nitrofs', source },
    ]);
  assert.equal(reads.length, 0);
  const header = await zip.read(0, 59);
  assert.equal(header.length, 59);
  assert.equal(reads.length, 0);
  const data = await zip.read(59, 4 * 1024 * 1024);
  assert.equal(data.length, 4 * 1024 * 1024);
  assert.ok(reads.length >= 4);
  assert.ok(
    reads.reduce((total, [, length]) => total + length, 0) <=
      data.length + 1024 * 1024,
  );
  assert.ok(data.every((value) => value === 0x65));
  await assert.rejects(zip.read(0, 1), errorCode('ZIP_SEQUENCE'));
  await assert.rejects(
    zip.read(59 + data.length, 4 * 1024 * 1024 + 1),
    errorCode('TOO_LARGE', 'BOUNDS'),
  );
});

test('ZIP64 stores sizes above four GiB without reading the virtual file', async () => {
  const size = 0x100000011,
    source = {
      size,
      async read() {
        assert.fail('file data was requested');
      },
    },
    zip = createZipSource([{ path: 'big.bin', size, kind: 'nitrofs', source }]),
    header = await zip.read(0, 57),
    view = new DataView(header.buffer);
  assert.equal(zip.size, size + 260);
  assert.equal(view.getUint32(18, true), 0xffffffff);
  assert.equal(view.getUint16(37, true), 1);
  assert.equal(view.getBigUint64(41, true), BigInt(size));
  assert.equal(view.getBigUint64(49, true), BigInt(size));
});

test('ZIP source validates unsafe paths, duplicates, file ancestors and unsafe numeric sizes', () => {
  for (const path of [
    '/absolute',
    '../escape',
    'a/../b',
    'C:/drive',
    'a\\b',
    'a//b',
    'a\0b',
    'a/.',
    'a/..',
    'a:stream',
    'tail.',
  ]) {
    assert.throws(
      () => createZipSource([entry(path)]),
      errorCode('UNSAFE_NAME'),
    );
  }
  assert.throws(
    () => createZipSource([entry('same'), entry('same')]),
    errorCode('DUPLICATE_PATH'),
  );
  assert.throws(
    () => createZipSource([entry('a'), entry('a/file')]),
    errorCode('DUPLICATE_PATH', 'UNSAFE_NAME'),
  );
  assert.throws(
    () => createZipSource([entry('a/'), entry('a')]),
    errorCode('DUPLICATE_PATH'),
  );
  for (const size of [-1, 0.5, Number.MAX_SAFE_INTEGER, Infinity]) {
    assert.throws(
      () =>
        createZipSource([
          { path: 'size.bin', size, source: { size, read() {} } },
        ]),
      errorCode('TOO_LARGE', 'INVALID'),
    );
  }
});

test('ZIP cancellation rejects a held data read before returning its bytes', async () => {
  let resume,
    cancelled = false;
  const source = {
    size: 4,
    read() {
      return new Promise((resolve) => {
        resume = resolve;
      });
    },
  };
  const zip = createZipSource([{ path: 'a', size: 4, source }], {
    checkCurrent() {
      if (cancelled) {
        const error = new Error('cancelled');
        error.code = 'CANCELLED';
        throw error;
      }
    },
  });
  const reading = zip.read(0, 55);
  for (let i = 0; i < 10 && !resume; i++) await Promise.resolve();
  assert.equal(typeof resume, 'function');
  cancelled = true;
  resume(new Uint8Array([1, 2, 3, 4]));
  await assert.rejects(reading, errorCode('CANCELLED'));
  await assert.rejects(zip.read(0, 1), errorCode('CANCELLED'));
});

test('ZIP rejects short source data and overlapping concurrent reads', async () => {
  const zip = createZipSource([
    {
      path: 'a',
      size: 4,
      source: {
        size: 4,
        async read() {
          return new Uint8Array(3);
        },
      },
    },
  ]);
  await assert.rejects(zip.read(0, 55), errorCode('BOUNDS'));
  let resume;
  const waiting = createZipSource([
    {
      path: 'a',
      size: 4,
      source: {
        size: 4,
        read() {
          return new Promise((resolve) => {
            resume = resolve;
          });
        },
      },
    },
  ]);
  const first = waiting.read(0, 55);
  for (let i = 0; i < 10 && !resume; i++) await Promise.resolve();
  await assert.rejects(waiting.read(0, 1), errorCode('ZIP_SEQUENCE'));
  resume(new Uint8Array(4));
  assert.equal((await first).length, 55);
});
