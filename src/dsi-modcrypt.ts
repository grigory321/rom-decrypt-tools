import type { ByteSource } from './contracts.js';
import { Bin, bounds, check } from './binary.js';

import './vendor/aes.js';

export interface DsiModcryptRegion {
  offset: number;
  size: number;
}

export interface DsiModcryptInfo {
  source: ByteSource;
  encrypted: boolean;
  regions: DsiModcryptRegion[];
  title: string;
  gameCode: string;
}

interface CryptRegion extends DsiModcryptRegion {
  counter: bigint;
}

const mask = (1n << 128n) - 1n;
const chunkSize = 65536;

function littleInteger(bytes: Uint8Array) {
  let value = 0n;
  for (let i = bytes.length - 1; i >= 0; i--) {
    value = (value << 8n) | BigInt(bytes[i]);
  }
  return value;
}

function bigBytes(value: bigint) {
  const bytes = new Uint8Array(16);
  for (let i = 15; i >= 0; i--) {
    bytes[i] = Number(value & 255n);
    value >>= 8n;
  }
  return bytes;
}

function headerKey(header: Uint8Array) {
  if (header[0x1c] & 4 || header[0x1bf] & 0x80) {
    return header.slice(0, 16).reverse();
  }
  const x = new Uint8Array(16);
  x.set(new TextEncoder().encode('Nintendo'));
  x.set(header.subarray(0xc, 0x10), 8);
  x.set(header.slice(0xc, 0x10).reverse(), 12);
  const sum =
    ((littleInteger(x) ^ littleInteger(header.subarray(0x350, 0x360))) +
      0xfffefb4e295902582a680f5f1a4f3e79n) &
    mask;
  return bigBytes(((sum << 42n) | (sum >> 86n)) & mask);
}

function repairHeader(header: Uint8Array) {
  header[0x1c] &= ~2;
  let crc = 0xffff;
  for (let i = 0; i < 0x15e; i++) {
    crc ^= header[i];
    for (let bit = 0; bit < 8; bit++) {
      crc = (crc >>> 1) ^ (crc & 1 ? 0xa001 : 0);
    }
  }
  new DataView(header.buffer, header.byteOffset, header.byteLength).setUint16(
    0x15e,
    crc,
    true,
  );
}

async function readExact(
  source: ByteSource,
  offset: number,
  length: number,
  checkCancelled: () => void,
) {
  checkCancelled();
  const bytes = await source.read(offset, length);
  checkCancelled();
  check(bytes instanceof Uint8Array && bytes.length === length, 'TRUNCATED');
  return bytes;
}

export async function inspectDsiModcrypt(
  source: ByteSource,
  checkCancelled: () => void = () => {},
): Promise<DsiModcryptInfo | null> {
  checkCancelled();
  check(Number.isSafeInteger(source.size) && source.size >= 0, 'BOUNDS');
  if (source.size < 0x13) {
    return null;
  }
  const base = await readExact(
    source,
    0,
    Math.min(source.size, 0x20),
    checkCancelled,
  );
  if (!(base[0x12] & 2)) {
    return null;
  }
  check(source.size >= 0x4000, 'INVALID_NDS');
  const header = (await readExact(source, 0, 0x1000, checkCancelled)).slice();
  const bin = new Bin(header);
  const encrypted = Boolean(header[0x1c] & 2);
  const regions: CryptRegion[] = [];
  for (let index = 0; index < 2; index++) {
    const offset = bin.u32(0x220 + index * 8);
    const size = bin.u32(0x224 + index * 8);
    if (!size) {
      continue;
    }
    check(
      offset >= 0x4000 &&
        offset % 16 === 0 &&
        size % 16 === 0 &&
        offset <= source.size &&
        size <= source.size - offset,
      'INVALID_NDS',
    );
    regions.push({
      offset,
      size,
      counter: littleInteger(
        header.subarray(0x300 + index * 0x14, 0x310 + index * 0x14),
      ),
    });
  }
  const cipher = encrypted ? new globalThis.aesjs.AES(headerKey(header)) : null;
  if (encrypted) {
    repairHeader(header);
  }
  const decrypted: ByteSource = {
    size: source.size,
    async read(offset, length) {
      bounds(source.size, offset, length);
      checkCancelled();
      const output = new Uint8Array(length);
      for (let cursor = 0; cursor < length; cursor += chunkSize) {
        const start = offset + cursor;
        const amount = Math.min(chunkSize, length - cursor);
        const data = await readExact(source, start, amount, checkCancelled);
        output.set(data, cursor);
        if (cipher) {
          for (const region of regions) {
            const end = Math.min(start + amount, region.offset + region.size);
            let position = Math.max(start, region.offset);
            while (position < end) {
              checkCancelled();
              const relative = position - region.offset;
              const skip = relative % 16;
              const pad = cipher.encrypt(
                bigBytes(
                  (region.counter + BigInt(Math.floor(relative / 16))) & mask,
                ),
              );
              const count = Math.min(16 - skip, end - position);
              for (let i = 0; i < count; i++) {
                output[position - offset + i] ^= pad[15 - skip - i];
              }
              position += count;
            }
          }
        }
        if (encrypted && start < header.length) {
          output.set(
            header.subarray(start, Math.min(start + amount, header.length)),
            cursor,
          );
        }
      }
      return output;
    },
  };
  return {
    source: decrypted,
    encrypted,
    regions: regions.map(({ offset, size }) => ({ offset, size })),
    title: bin.str(0, 12).replace(/\0.*$/, '').trim(),
    gameCode: bin.str(0xc, 4),
  };
}
