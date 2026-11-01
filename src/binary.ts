import type { BlobInput, ByteSource } from './contracts.js';
import { FormatError } from './errors.js';
import { readBlobRange } from './blob-reader.js';

export { FormatError } from './errors.js';

export function check(ok: unknown, code = 'INVALID', detail = ''): asserts ok {
  if (!ok) {
    throw new FormatError(code, detail);
  }
}

export function bounds(size: number, offset: number, length: number): void {
  check(
    Number.isSafeInteger(offset) &&
      Number.isSafeInteger(length) &&
      offset >= 0 &&
      length >= 0 &&
      offset <= size &&
      length <= size - offset,
    'BOUNDS',
  );
}

export function blobSource(blob: BlobInput, signal?: AbortSignal): ByteSource {
  return {
    size: blob.size,
    async read(offset, length) {
      bounds(blob.size, offset, length);
      return readBlobRange(blob, offset, length, signal);
    },
  };
}

export function arraySource(bytes: Uint8Array): ByteSource {
  return {
    size: bytes.length,
    async read(offset, length) {
      bounds(bytes.length, offset, length);
      return bytes.slice(offset, offset + length);
    },
  };
}

export function bufferBytes(bytes: Uint8Array): Uint8Array<ArrayBuffer> {
  return bytes.buffer instanceof ArrayBuffer
    ? new Uint8Array(bytes.buffer, bytes.byteOffset, bytes.byteLength)
    : new Uint8Array(bytes);
}

export function sliceSource(
  src: ByteSource,
  base: number,
  size: number,
): ByteSource {
  bounds(src.size, base, size);
  return {
    size,
    async read(o, n) {
      bounds(size, o, n);
      return src.read(base + o, n);
    },
  };
}

export class Bin {
  readonly b: Uint8Array;
  readonly d: DataView;

  constructor(bytes: Uint8Array) {
    this.b = bytes;
    this.d = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  }
  range(o: number, n: number) {
    bounds(this.b.length, o, n);
  }
  u8(o: number) {
    this.range(o, 1);
    return this.b[o];
  }
  i8(o: number) {
    return (this.u8(o) << 24) >> 24;
  }
  u16(o: number, le = true) {
    this.range(o, 2);
    return this.d.getUint16(o, le);
  }
  i16(o: number, le = true) {
    this.range(o, 2);
    return this.d.getInt16(o, le);
  }
  u32(o: number, le = true) {
    this.range(o, 4);
    return this.d.getUint32(o, le);
  }
  u64(o: number, le = true) {
    this.range(o, 8);
    const v = this.d.getBigUint64(o, le);
    check(v <= BigInt(Number.MAX_SAFE_INTEGER), 'TOO_LARGE');
    return Number(v);
  }
  str(o: number, n: number) {
    this.range(o, n);
    return String.fromCharCode(...this.b.subarray(o, o + n));
  }
  zstr(o: number) {
    this.range(o, 1);
    let e = o;
    while (e < this.b.length && this.b[e] && e - o < 4096) {
      e++;
    }
    return new TextDecoder().decode(this.b.subarray(o, e));
  }
  slice(o: number, n: number) {
    this.range(o, n);
    return this.b.subarray(o, o + n);
  }
}

export const align = (v: number, n = 64) => Math.ceil(v / n) * n;
