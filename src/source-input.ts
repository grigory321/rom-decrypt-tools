import { blobSource, bounds, check, FormatError } from './binary.js';
import type { ByteSource, SourceInput } from './contracts.js';

function abortableSource(source: ByteSource, signal: AbortSignal): ByteSource {
  return {
    size: source.size,
    async read(offset, length) {
      bounds(source.size, offset, length);
      check(!signal.aborted, 'CANCELLED');
      return new Promise((resolve, reject: (error: unknown) => void) => {
        let settled = false;
        const cancelled = () => {
          if (settled) return;
          settled = true;
          reject(new FormatError('CANCELLED'));
        };
        signal.addEventListener('abort', cancelled, { once: true });
        Promise.resolve()
          .then(() => {
            check(!signal.aborted, 'CANCELLED');
            return source.read(offset, length);
          })
          .then(
            (bytes) => {
              if (settled) return;
              settled = true;
              signal.removeEventListener('abort', cancelled);
              resolve(bytes);
            },
            (error: unknown) => {
              if (settled) return;
              settled = true;
              signal.removeEventListener('abort', cancelled);
              reject(error);
            },
          );
      });
    },
  };
}

export function asSource(
  value: SourceInput,
  invalidCode = 'INVALID_SOURCE',
  signal?: AbortSignal,
): ByteSource {
  check(value && typeof value === 'object', invalidCode);
  if (value instanceof Uint8Array)
    return asSource(memorySource(value), invalidCode, signal);
  if ('source' in value) return asSource(value.source, invalidCode, signal);
  if ('file' in value) return asSource(value.file, invalidCode, signal);
  if ('blob' in value) return asSource(value.blob, invalidCode, signal);
  check(Number.isSafeInteger(value.size) && value.size >= 0, invalidCode);
  if ('read' in value && typeof value.read === 'function')
    return signal ? abortableSource(value, signal) : value;
  check('slice' in value && typeof value.slice === 'function', invalidCode);
  return blobSource(value, signal);
}

export function memorySource(bytes: Uint8Array): ByteSource {
  return {
    size: bytes.length,
    async read(offset, length) {
      bounds(bytes.length, offset, length);
      return bytes.slice(offset, offset + length);
    },
  };
}

export function sourceName(value: SourceInput, preferName = false): string {
  const path = 'path' in value ? value.path : undefined;
  const relative =
    'webkitRelativePath' in value ? value.webkitRelativePath : undefined;
  const name = 'name' in value ? value.name : undefined;
  const own = preferName ? name || path || relative : path || relative || name;
  if (own) return own;
  if ('file' in value) return sourceName(value.file, preferName);
  if ('blob' in value) return sourceName(value.blob, preferName);
  return '';
}

export function sourceIncludes(
  value: SourceInput,
  wanted: SourceInput,
): boolean {
  return (
    value === wanted ||
    ('source' in value && value.source === wanted) ||
    ('file' in value && value.file === wanted) ||
    ('blob' in value && value.blob === wanted)
  );
}
