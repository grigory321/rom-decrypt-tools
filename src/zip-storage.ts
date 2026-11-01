import type { ByteSource } from './contracts.js';
import {
  blobSource,
  bounds,
  bufferBytes,
  check,
  FormatError,
} from './binary.js';

export interface ZipStorage {
  write(bytes: Uint8Array): Promise<void>;
  finish(): Promise<ByteSource>;
  dispose(): Promise<void>;
}

interface SyncZipHandle {
  write(bytes: Uint8Array<ArrayBuffer>, options: { at: number }): number;
  read(bytes: Uint8Array<ArrayBuffer>, options: { at: number }): number;
  flush(): void | Promise<void>;
  getSize(): number | Promise<number>;
  close(): void | Promise<void>;
}

interface OpfsAccess {
  write(bytes: Uint8Array, offset: number): Promise<void>;
  finish(): Promise<ByteSource>;
  dispose(): Promise<void>;
}

declare global {
  interface FileSystemDirectoryHandle {
    entries(): AsyncIterableIterator<[string, FileSystemHandle]>;
  }
}

let availableMemory = 8 * 1024 * 1024;
const CHUNK = 65536;
const leasePattern =
  /^rom-studio-leased-zip-[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}\.tmp$/;

async function removeTemporary(
  directory: FileSystemDirectoryHandle,
  name: string,
) {
  try {
    await directory.removeEntry(name);
  } catch (error) {
    if (!(error instanceof DOMException && error.name === 'NotFoundError'))
      throw error;
  }
}

async function sweepOrphans(
  directory: FileSystemDirectoryHandle,
  locks: LockManager,
) {
  if (typeof directory.entries !== 'function') return;
  for await (const [name, handle] of directory.entries()) {
    if (handle.kind !== 'file' || !leasePattern.test(name)) continue;
    await locks.request(
      name,
      { mode: 'exclusive', ifAvailable: true },
      async (lock) => {
        if (lock) await removeTemporary(directory, name);
      },
    );
  }
}

async function acquireLease(
  locks: LockManager,
  name: string,
): Promise<() => Promise<void>> {
  let markAcquired = () => {};
  let release = () => {};
  let entered = false;
  const acquired = new Promise<void>((resolve) => {
    markAcquired = resolve;
  });
  const held = new Promise<void>((resolve) => {
    release = resolve;
  });
  const request = locks.request(name, { mode: 'exclusive' }, async (lock) => {
    check(lock, 'ZIP_STORAGE');
    entered = true;
    markAcquired();
    await held;
  });
  await Promise.race([acquired, request]);
  check(entered, 'ZIP_STORAGE');
  return async () => {
    release();
    await request;
  };
}

export async function cleanupZipStorage(): Promise<void> {
  if (
    typeof navigator === 'undefined' ||
    !navigator.storage?.getDirectory ||
    !navigator.locks?.request
  )
    return;
  await sweepOrphans(await navigator.storage.getDirectory(), navigator.locks);
}

function storageFailure(error: unknown, detail: string): Error {
  if (error instanceof FormatError) return error;
  if (error instanceof DOMException && error.name === 'AbortError')
    return new FormatError('CANCELLED');
  return new FormatError('ZIP_STORAGE', detail);
}

function isSyncZipHandle(value: unknown): value is SyncZipHandle {
  return (
    typeof value === 'object' &&
    value !== null &&
    'write' in value &&
    typeof value.write === 'function' &&
    'read' in value &&
    typeof value.read === 'function' &&
    'flush' in value &&
    typeof value.flush === 'function' &&
    'getSize' in value &&
    typeof value.getSize === 'function' &&
    'close' in value &&
    typeof value.close === 'function'
  );
}

async function openOpfsAccess(
  file: FileSystemFileHandle,
  size: number,
): Promise<OpfsAccess> {
  if (typeof file.createWritable === 'function') {
    try {
      const writer = await file.createWritable();
      let closed = false;
      return {
        async write(bytes) {
          await writer.write(bufferBytes(bytes));
        },
        async finish() {
          await writer.close();
          closed = true;
          const result = await file.getFile();
          check(result.size === size, 'ZIP_SIZE');
          return blobSource(result);
        },
        async dispose() {
          if (!closed) await writer.abort().catch(() => {});
        },
      };
    } catch (error) {
      if (!(
        error instanceof DOMException && error.name === 'NotSupportedError'
      ))
        throw error;
    }
  }
  check(
    'createSyncAccessHandle' in file &&
      typeof file.createSyncAccessHandle === 'function',
    'ZIP_STORAGE',
  );
  const handle: unknown = await file.createSyncAccessHandle();
  check(isSyncZipHandle(handle), 'ZIP_STORAGE');
  return {
    async write(bytes, offset) {
      for (let written = 0; written < bytes.length;) {
        const part = bufferBytes(bytes.subarray(written, written + CHUNK));
        const amount = handle.write(part, { at: offset + written });
        check(
          Number.isSafeInteger(amount) && amount > 0 && amount <= part.length,
          'ZIP_STORAGE',
        );
        written += amount;
      }
    },
    async finish() {
      await handle.flush();
      check((await handle.getSize()) === size, 'ZIP_STORAGE');
      return {
        size,
        async read(offset, length) {
          const output = new Uint8Array(length);
          for (let read = 0; read < length;) {
            const part = output.subarray(read, read + CHUNK);
            const amount = handle.read(part, { at: offset + read });
            check(
              Number.isSafeInteger(amount) &&
                amount > 0 &&
                amount <= part.length,
              'ZIP_STORAGE',
            );
            read += amount;
          }
          return output;
        },
      };
    },
    async dispose() {
      await handle.close();
    },
  };
}

async function opfsStorage(size: number): Promise<ZipStorage | null> {
  if (typeof navigator === 'undefined' || !navigator.storage?.getDirectory)
    return null;
  const directory = await navigator.storage.getDirectory();
  const locks =
    typeof navigator.locks?.request === 'function' ? navigator.locks : null;
  if (locks) await sweepOrphans(directory, locks);
  const name =
    (locks ? 'rom-studio-leased-zip-' : 'rom-studio-unleased-zip-') +
    crypto.randomUUID() +
    '.tmp';
  const releaseLease = locks ? await acquireLease(locks, name) : null;
  let access: OpfsAccess;
  try {
    const file = await directory.getFileHandle(name, { create: true });
    access = await openOpfsAccess(file, size);
  } catch (error) {
    try {
      await removeTemporary(directory, name);
    } finally {
      if (releaseLease) await releaseLease();
    }
    throw error;
  }
  let position = 0;
  let finished = false;
  let disposal: Promise<void> | null = null;
  return {
    async write(bytes) {
      check(!disposal, 'CANCELLED');
      check(!finished && position + bytes.length <= size, 'ZIP_STORAGE');
      try {
        await access.write(bytes, position);
        check(!disposal, 'CANCELLED');
      } catch (error) {
        check(!disposal, 'CANCELLED');
        throw storageFailure(
          error,
          'Unable to write temporary browser storage. Check available disk space.',
        );
      }
      position += bytes.length;
    },
    async finish() {
      check(!disposal, 'CANCELLED');
      check(!finished && position === size, 'ZIP_SIZE');
      try {
        const result = await access.finish();
        check(!disposal, 'CANCELLED');
        finished = true;
        return {
          size,
          async read(offset, length) {
            bounds(size, offset, length);
            check(!disposal, 'CANCELLED');
            try {
              const bytes = await result.read(offset, length);
              check(!disposal, 'CANCELLED');
              check(bytes.length === length, 'ZIP_STORAGE');
              return bytes;
            } catch (error) {
              check(!disposal, 'CANCELLED');
              throw storageFailure(
                error,
                'Unable to read temporary browser storage.',
              );
            }
          },
        };
      } catch (error) {
        check(!disposal, 'CANCELLED');
        throw storageFailure(
          error,
          'Unable to finish temporary browser storage. Check available disk space.',
        );
      }
    },
    dispose() {
      if (!disposal)
        disposal = (async () => {
          try {
            try {
              await access.dispose();
            } finally {
              try {
                await removeTemporary(directory, name);
              } finally {
                if (releaseLease) await releaseLease();
              }
            }
          } catch (error) {
            throw storageFailure(
              error,
              'Unable to release temporary browser storage.',
            );
          }
        })();
      return disposal;
    },
  };
}

export function createZipStorageFactory(): (
  size: number,
) => Promise<ZipStorage> {
  return async (size) => {
    check(Number.isSafeInteger(size) && size >= 0, 'ZIP_SIZE');
    try {
      const storage = await opfsStorage(size);
      if (storage) return storage;
    } catch (error) {
      const failure = storageFailure(error, '');
      if (failure instanceof FormatError && failure.code === 'CANCELLED')
        throw failure;
      check(
        size <= availableMemory,
        'ZIP_STORAGE',
        'Temporary browser storage is unavailable. This ZIP entry exceeds the 8 MiB memory fallback.',
      );
    }
    check(
      size <= availableMemory,
      'ZIP_STORAGE',
      'Temporary browser storage is required to open ZIP entries larger than the available 8 MiB memory fallback.',
    );
    availableMemory -= size;
    let bytes: Uint8Array;
    try {
      bytes = new Uint8Array(size);
    } catch {
      availableMemory += size;
      throw new FormatError(
        'ZIP_STORAGE',
        'Unable to allocate temporary ZIP storage.',
      );
    }
    let position = 0;
    let finished = false;
    let disposed = false;
    return {
      async write(chunk) {
        check(
          !finished && !disposed && position + chunk.length <= size,
          'ZIP_STORAGE',
        );
        bytes.set(chunk, position);
        position += chunk.length;
      },
      async finish() {
        check(!finished && !disposed && position === size, 'ZIP_SIZE');
        finished = true;
        return {
          size,
          async read(offset, length) {
            bounds(size, offset, length);
            check(!disposed, 'CANCELLED');
            return bytes.slice(offset, offset + length);
          },
        };
      },
      async dispose() {
        if (disposed) return;
        disposed = true;
        bytes = new Uint8Array();
        availableMemory += size;
      },
    };
  };
}
