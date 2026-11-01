import type { BlobInput } from './contracts.js';
import { FormatError } from './errors.js';

const sliceLimit = 1024 * 1024;
const readTimeout = 30_000;

function checkSignal(signal?: AbortSignal) {
  if (signal?.aborted) throw new FormatError('CANCELLED');
}

function withDeadline(
  operation: () => Promise<unknown>,
  abort: () => void,
  signal?: AbortSignal,
): Promise<unknown> {
  checkSignal(signal);
  return new Promise((resolve, reject: (error: unknown) => void) => {
    let settled = false;
    const clear = () => {
      clearTimeout(timer);
      signal?.removeEventListener('abort', cancelled);
    };
    const fail = (error: unknown) => {
      if (settled) return;
      settled = true;
      clear();
      reject(error);
    };
    const cancelled = () => {
      fail(new FormatError('CANCELLED'));
      abort();
    };
    const timer = setTimeout(() => {
      fail(new FormatError('FILE_READ_TIMEOUT'));
      abort();
    }, readTimeout);
    signal?.addEventListener('abort', cancelled, { once: true });
    Promise.resolve()
      .then(() => {
        if (!settled) return operation();
      })
      .then((result) => {
        if (settled) return;
        settled = true;
        clear();
        resolve(result);
      }, fail);
  });
}

async function nativeRead(blob: Blob, signal?: AbortSignal): Promise<unknown> {
  const reader = new FileReader();
  try {
    return await withDeadline(
      () =>
        new Promise((resolve, reject: (error: unknown) => void) => {
          reader.onload = () => resolve(reader.result);
          reader.onerror = () => reject(reader.error);
          reader.onabort = () => reject(new FormatError('FILE_READ'));
          reader.readAsArrayBuffer(blob);
        }),
      () => reader.abort(),
      signal,
    );
  } finally {
    reader.onload = null;
    reader.onerror = null;
    reader.onabort = null;
  }
}

function exactBuffer(value: unknown, length: number): Uint8Array {
  if (!(value instanceof ArrayBuffer) || value.byteLength !== length)
    throw new FormatError(
      'FILE_READ',
      'The file provider returned incomplete data.',
    );
  return new Uint8Array(value);
}

async function readSlice(
  blob: BlobInput,
  offset: number,
  length: number,
  signal?: AbortSignal,
): Promise<Uint8Array> {
  checkSignal(signal);
  try {
    const part = blob.slice(offset, offset + length);
    if (
      typeof Blob !== 'undefined' &&
      part instanceof Blob &&
      typeof FileReader === 'function'
    ) {
      try {
        return exactBuffer(await nativeRead(part, signal), length);
      } catch (error) {
        checkSignal(signal);
        if (error instanceof FormatError && error.code === 'CANCELLED')
          throw error;
      }
    }
    checkSignal(signal);
    const fresh = blob.slice(offset, offset + length);
    return exactBuffer(
      await withDeadline(
        () => fresh.arrayBuffer(),
        () => {},
        signal,
      ),
      length,
    );
  } catch (error) {
    checkSignal(signal);
    if (error instanceof FormatError) throw error;
    const reason = error instanceof Error ? error.name : 'File read failed';
    throw new FormatError(
      'FILE_READ',
      `${reason}; offset=${offset}; bytes=${length}`,
    );
  }
}

export async function readBlobRange(
  blob: BlobInput,
  offset: number,
  length: number,
  signal?: AbortSignal,
): Promise<Uint8Array> {
  checkSignal(signal);
  if (length <= sliceLimit) return readSlice(blob, offset, length, signal);
  let bytes: Uint8Array;
  try {
    bytes = new Uint8Array(length);
  } catch {
    throw new FormatError('FILE_MEMORY');
  }
  for (let copied = 0; copied < length;) {
    checkSignal(signal);
    const count = Math.min(sliceLimit, length - copied);
    bytes.set(await readSlice(blob, offset + copied, count, signal), copied);
    copied += count;
  }
  return bytes;
}
