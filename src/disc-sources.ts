import type { ByteSource, SourceInput } from './contracts.js';
import { asSource } from './source-input.js';
import { Bin, bounds, check, sliceSource } from './binary.js';

const chunkSize = 128 * 1024;
export type RawSectorSize = 2336 | 2352;
const edcTable = Uint32Array.from({ length: 256 }, (_, byte) => {
  let value = byte;
  for (let bit = 0; bit < 8; bit++) {
    value = (value >>> 1) ^ (value & 1 ? 0xd8018001 : 0);
  }
  return value >>> 0;
});

export function discSource(value: SourceInput): ByteSource {
  const source = asSource(value, 'INVALID_DISC_SOURCE');
  check(
    Number.isSafeInteger(source.size) && source.size >= 0,
    'INVALID_DISC_SOURCE',
  );
  return {
    size: source.size,
    async read(offset, length) {
      bounds(source.size, offset, length);
      const output = new Uint8Array(length);
      for (let position = 0; position < length; position += chunkSize) {
        const count = Math.min(chunkSize, length - position);
        const bytes = await source.read(offset + position, count);
        check(
          bytes instanceof Uint8Array && bytes.length === count,
          'TRUNCATED_DISC',
        );
        output.set(bytes, position);
      }
      return output;
    },
  };
}

function checksum(bytes: Uint8Array, start: number, end: number) {
  let value = 0;
  for (let index = start; index < end; index++) {
    value = (value >>> 8) ^ edcTable[(value ^ bytes[index]) & 255];
  }
  return value >>> 0;
}

export function rawSectorPayload(
  bytes: Uint8Array,
  expectedMode = 0,
  sectorSize: RawSectorSize = 2352,
  allowForm2 = false,
) {
  check(bytes.length === sectorSize, 'INVALID_RAW_SECTOR');
  const header = sectorSize === 2352 ? 16 : 0;
  const mode = header ? bytes[15] : 2;
  check(
    (mode === 1 || mode === 2) && (!expectedMode || mode === expectedMode),
    'INVALID_RAW_SECTOR',
    'The CD sector mode does not match its data track.',
  );
  if (header) {
    check(
      bytes[0] === 0 &&
        bytes[11] === 0 &&
        bytes.subarray(1, 11).every((value) => value === 255),
      'INVALID_RAW_SECTOR',
      'The raw CD sector has an invalid synchronization header.',
    );
    for (let index = 12; index < 15; index++) {
      const value = bytes[index];
      check((value & 15) < 10 && value >>> 4 < 10, 'INVALID_RAW_SECTOR');
    }
    check(bytes[13] < 0x60 && bytes[14] < 0x75, 'INVALID_RAW_SECTOR');
  }
  if (mode === 2) {
    check(
      bytes
        .subarray(header, header + 4)
        .every((value, index) => value === bytes[header + 4 + index]),
      'INVALID_RAW_SECTOR',
      'The two XA subheaders disagree.',
    );
    check(
      allowForm2 || !(bytes[header + 2] & 32),
      'UNSUPPORTED_XA_FORM2',
      'XA Form 2 sectors have 2324-byte payloads and cannot be extracted as 2048-byte ISO data.',
    );
  }
  const form2 = mode === 2 && !!(bytes[header + 2] & 32);
  const start = mode === 1 ? 16 : header + 8;
  const end = start + (form2 ? 2324 : 2048);
  const edc = new Bin(bytes).u32(end);
  check(
    (form2 && edc === 0) ||
      edc === checksum(bytes, mode === 1 ? 0 : header, end),
    'INVALID_RAW_SECTOR',
    'The raw CD sector checksum does not match its data.',
  );
  if (mode === 1) {
    check(
      bytes.subarray(2068, 2076).every((value) => value === 0),
      'INVALID_RAW_SECTOR',
    );
  }
  return bytes.subarray(start, end);
}

export function rawSectorSource(
  source: ByteSource,
  expectedMode = 0,
  sectorSize: RawSectorSize = 2352,
  original = false,
): ByteSource {
  check(
    source.size % sectorSize === 0,
    'INVALID_RAW_IMAGE',
    `A CD image must contain complete ${sectorSize}-byte sectors.`,
  );
  check(sectorSize === 2352 || expectedMode === 2, 'INVALID_RAW_IMAGE');
  const logicalSize = original ? sectorSize : 2048;
  const size = (source.size / sectorSize) * logicalSize;
  return {
    size,
    async read(offset, length) {
      bounds(size, offset, length);
      const output = new Uint8Array(length);
      let position = 0;
      while (position < length) {
        const logical = offset + position;
        const sector = Math.floor(logical / logicalSize);
        const within = logical % logicalSize;
        const count = Math.min(
          48,
          Math.ceil((length - position + within) / logicalSize),
        );
        const bytes = await source.read(
          sector * sectorSize,
          count * sectorSize,
        );
        for (let index = 0; index < count; index++) {
          const raw = bytes.subarray(
            index * sectorSize,
            (index + 1) * sectorSize,
          );
          const data = rawSectorPayload(
            raw,
            expectedMode,
            sectorSize,
            original,
          );
          const payload = original ? raw : data;
          const start = index === 0 ? within : 0;
          const size = Math.min(logicalSize - start, length - position);
          output.set(payload.subarray(start, start + size), position);
          position += size;
        }
      }
      return output;
    },
  };
}

export function extentSource(
  source: ByteSource,
  extents: { offset: number; size: number }[],
): ByteSource {
  const sections: { start: number; size: number; source: ByteSource }[] = [];
  let size = 0;
  for (const extent of extents) {
    sections.push({
      start: size,
      size: extent.size,
      source: sliceSource(source, extent.offset, extent.size),
    });
    size += extent.size;
    check(Number.isSafeInteger(size), 'TOO_LARGE');
  }
  return {
    size,
    async read(offset, length) {
      bounds(size, offset, length);
      const output = new Uint8Array(length);
      const end = offset + length;
      for (const section of sections) {
        const start = Math.max(offset, section.start);
        const stop = Math.min(end, section.start + section.size);
        if (stop > start) {
          output.set(
            await section.source.read(start - section.start, stop - start),
            start - offset,
          );
        }
      }
      return output;
    },
  };
}

export function audioTrackSource(
  source: ByteSource,
  motorola = false,
): ByteSource {
  check(
    source.size % 4 === 0 && source.size <= 0xffffffff - 36,
    'INVALID_CD_AUDIO',
  );
  const header = new Uint8Array(44);
  const view = new DataView(header.buffer);
  header.set(new TextEncoder().encode('RIFF'), 0);
  view.setUint32(4, source.size + 36, true);
  header.set(new TextEncoder().encode('WAVEfmt '), 8);
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true);
  view.setUint16(22, 2, true);
  view.setUint32(24, 44100, true);
  view.setUint32(28, 176400, true);
  view.setUint16(32, 4, true);
  view.setUint16(34, 16, true);
  header.set(new TextEncoder().encode('data'), 36);
  view.setUint32(40, source.size, true);
  return {
    size: source.size + 44,
    async read(offset, length) {
      bounds(source.size + 44, offset, length);
      const output = new Uint8Array(length);
      if (offset < 44) {
        output.set(header.subarray(offset, Math.min(44, offset + length)));
      }
      const start = Math.max(44, offset);
      const count = offset + length - start;
      if (count > 0) {
        const position = start - 44;
        if (motorola) {
          const aligned = position - (position % 2);
          const end = Math.ceil((position + count) / 2) * 2;
          const bytes = await source.read(aligned, end - aligned);
          for (let index = 0; index < bytes.length; index += 2) {
            const first = bytes[index];
            bytes[index] = bytes[index + 1];
            bytes[index + 1] = first;
          }
          output.set(
            bytes.subarray(position - aligned, position - aligned + count),
            start - offset,
          );
        } else {
          output.set(await source.read(position, count), start - offset);
        }
      }
      return output;
    },
  };
}
