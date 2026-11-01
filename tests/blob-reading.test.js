import test from 'node:test';
import assert from 'node:assert/strict';
import { setImmediate } from 'node:timers/promises';
import { blobSource } from '../dist/binary.js';

function fileReader(t, stalled = false) {
  const original = Object.getOwnPropertyDescriptor(globalThis, 'FileReader');
  const state = { aborted: 0 };
  class Reader {
    result = null;
    error = null;
    onload = null;
    onerror = null;
    onabort = null;
    readAsArrayBuffer(blob) {
      if (stalled) return;
      Blob.prototype.arrayBuffer.call(blob).then((bytes) => {
        this.result = bytes;
        this.onload?.();
      });
    }
    abort() {
      state.aborted++;
      this.onabort?.();
    }
  }
  Object.defineProperty(globalThis, 'FileReader', {
    configurable: true,
    value: Reader,
  });
  t.after(() => {
    if (original) Object.defineProperty(globalThis, 'FileReader', original);
    else delete globalThis.FileReader;
  });
  return state;
}

test('file reads reject silently truncated browser buffers', async () => {
  const source = blobSource({
    size: 8,
    slice() {
      return { arrayBuffer: async () => new ArrayBuffer(2) };
    },
  });
  await assert.rejects(source.read(1, 4), { code: 'FILE_READ' });
});

test('large file reads use bounded slices and preserve the requested byte range', async () => {
  let largestSlice = 0;
  const source = blobSource({
    size: 7 * 1024 ** 2,
    slice(start, end) {
      largestSlice = Math.max(largestSlice, end - start);
      return {
        async arrayBuffer() {
          return Uint8Array.from(
            { length: end - start },
            (_, index) => (start + index) % 251,
          ).buffer;
        },
      };
    },
  });
  const bytes = await source.read(37, 4 * 1024 ** 2 + 19);
  assert.equal(bytes.length, 4 * 1024 ** 2 + 19);
  assert.equal(bytes[0], 37);
  assert.equal(bytes.at(-1), (36 + bytes.length) % 251);
  assert.ok(largestSlice <= 1024 ** 2);
});

test('native FileReader can read a file whose arrayBuffer method fails', async (t) => {
  fileReader(t);
  class RestrictedBlob extends Blob {
    slice(start, end) {
      return new RestrictedBlob([super.slice(start, end)]);
    }
    async arrayBuffer() {
      throw new DOMException(
        'file provider is not readable',
        'NotReadableError',
      );
    }
  }
  const source = blobSource(new RestrictedBlob([new Uint8Array([9, 8, 7, 6])]));
  assert.deepEqual(await source.read(1, 2), new Uint8Array([8, 7]));
});

test('a stalled native reader is aborted before falling back to arrayBuffer', async (t) => {
  const state = fileReader(t, true);
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const reading = blobSource(new Blob([new Uint8Array([1, 2, 3])])).read(0, 3);
  await setImmediate();
  t.mock.timers.tick(30_001);
  assert.deepEqual(await reading, new Uint8Array([1, 2, 3]));
  assert.equal(state.aborted, 1);
});

test(
  'a never-resolving file read stops with a specific error',
  { timeout: 1000 },
  async (t) => {
    t.mock.timers.enable({ apis: ['setTimeout'] });
    const source = blobSource({
      size: 1,
      slice() {
        return { arrayBuffer: () => new Promise(() => {}) };
      },
    });
    const rejected = assert.rejects(source.read(0, 1), {
      code: 'FILE_READ_TIMEOUT',
    });
    await setImmediate();
    t.mock.timers.tick(30_001);
    await rejected;
  },
);

test('aborting an import releases its active file reader without a fallback read', async (t) => {
  const state = fileReader(t, true);
  const controller = new AbortController();
  const reading = blobSource(new Blob(['input']), controller.signal).read(0, 5);
  const rejected = assert.rejects(reading, { code: 'CANCELLED' });
  await setImmediate();
  controller.abort();
  await rejected;
  assert.equal(state.aborted, 1);
});
