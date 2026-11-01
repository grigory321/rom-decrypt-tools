import type {
  ByteSource,
  SourceInput,
  CompanionFile,
  MaybePromise,
} from './contracts.js';
import { asSource, sourceName, sourceIncludes } from './source-input.js';
import './vendor/aes.js';
import { Bin, bounds, check } from './binary.js';
import { unhex, signatureBody } from './crypto.js';

export { asSource, memorySource } from './source-input.js';

export const MAX_METADATA = 16 * 1024 * 1024;
export const MAX_ENTRIES = 200000;
export const decoder = new TextDecoder('utf-8', { fatal: true });
export const zeroIV = () => new Uint8Array(16);

const commonKeys = [
  unhex('ebe42a225e8593e448d9c5457381aaf7'),
  unhex('63b82bb4f4614e2e13f2fefbba4c9b7e'),
  unhex('30bfc76e7c19afbb23163330ced7c28d'),
];
const debugKey = unhex('a1604a6a7123b529ae8bec32c816fcaa');
const cafeKey = unhex('d7b00402659ba2abd2cb0db27fa2b656');
const cafeDebugKey = unhex('2f5c1b2944e7fd6fc397964b057691fa');

export async function readBytes(
  source: ByteSource,
  offset: number,
  length: number,
) {
  bounds(source.size, offset, length);
  const bytes = await source.read(offset, length);
  check(bytes instanceof Uint8Array && bytes.length === length, 'TRUNCATED');
  return bytes;
}

export function cbcDecrypt(
  bytes: Uint8Array,
  key: Uint8Array,
  iv: Uint8Array = zeroIV(),
) {
  check(
    bytes.length % 16 === 0 && key.length === 16 && iv.length === 16,
    'AES_ALIGNMENT',
  );
  return new globalThis.aesjs.ModeOfOperation.cbc(key, iv).decrypt(bytes);
}

export function ticketInfo(bytes: Uint8Array, cafe = false) {
  const base = signatureBody(bytes),
    view = new Bin(bytes),
    iv = zeroIV();
  const titleId = view.slice(base + 0x9c, 8).slice();
  check(
    view.u32(base + 0x98, false) === 0,
    'PERSONALIZED_TICKET',
    'Console-specific tickets require the owning console key',
  );
  iv.set(titleId);
  const issuer = boundedName(bytes, base, 64, false),
    index = view.u8(base + 0xb1);
  const common = cafe
    ? /Root-CA00000004-/.test(issuer)
      ? cafeDebugKey
      : cafeKey
    : /Root-CA00000002-/.test(issuer)
      ? debugKey
      : commonKeys[index];
  check(common, 'WII_COMMON_KEY_INDEX', String(index));
  return { titleId, key: cbcDecrypt(view.slice(base + 0x7f, 16), common, iv) };
}

export function boundedName(
  bytes: Uint8Array,
  offset: number,
  limit = 1024,
  component = true,
) {
  bounds(bytes.length, offset, 1);
  let end = offset;
  while (end < bytes.length && end - offset < limit && bytes[end]) end++;
  check(end < bytes.length && end - offset < limit, 'INVALID_NAME');
  let name: string;
  try {
    name = decoder.decode(bytes.subarray(offset, end));
  } catch {
    try {
      name = new TextDecoder('shift_jis', { fatal: true }).decode(
        bytes.subarray(offset, end),
      );
    } catch {
      check(false, 'INVALID_NAME');
    }
  }
  if (component) {
    check(
      name &&
        name !== '.' &&
        name !== '..' &&
        !/[<>:"/\\|?*\x00-\x1f\x7f]/.test(name) &&
        !/[. ]$/.test(name),
      'UNSAFE_NAME',
      name,
    );
  }
  return name;
}

export class BlockCache<T = Uint8Array> {
  limit: number;
  bytes: number;
  entries: Map<string | number, { size: number; promise: Promise<T> }>;
  constructor(limit = 4 * 1024 * 1024) {
    this.limit = limit;
    this.bytes = 0;
    this.entries = new Map<
      string | number,
      { size: number; promise: Promise<T> }
    >();
  }
  async get(
    key: string | number,
    size: number,
    load: () => MaybePromise<T>,
  ): Promise<T> {
    let entry = this.entries.get(key);
    if (entry) {
      this.entries.delete(key);
      this.entries.set(key, entry);
      return entry.promise;
    }
    while (this.bytes + size > this.limit && this.entries.size) {
      const oldest = this.entries.entries().next();
      check(!oldest.done, 'CACHE_STATE');
      this.bytes -= oldest.value[1].size;
      this.entries.delete(oldest.value[0]);
    }
    entry = { size, promise: Promise.resolve().then(load) };
    if (size <= this.limit) {
      this.entries.set(key, entry);
      this.bytes += size;
    }
    try {
      return await entry.promise;
    } catch (error) {
      if (this.entries.get(key) === entry) {
        this.entries.delete(key);
        this.bytes -= size;
      }
      throw error;
    }
  }
}

export function blockSource(
  size: number,
  blockSize: number,
  load: (index: number) => Promise<Uint8Array>,
): ByteSource {
  return {
    size,
    async read(offset, length) {
      bounds(size, offset, length);
      check(length <= MAX_METADATA, 'READ_TOO_LARGE');
      const output = new Uint8Array(length);
      let copied = 0;
      while (copied < length) {
        const absolute = offset + copied,
          index = Math.floor(absolute / blockSize),
          within = absolute % blockSize;
        const block = await load(index),
          amount = Math.min(length - copied, blockSize - within);
        check(block.length >= within + amount, 'TRUNCATED');
        output.set(block.subarray(within, within + amount), copied);
        copied += amount;
      }
      return output;
    },
  };
}

export function indexedCbcSource(
  source: ByteSource,
  key: Uint8Array,
  index: number,
  cache: BlockCache,
  identity: string,
) {
  const iv = zeroIV();
  new DataView(iv.buffer).setUint16(0, index, false);
  return blockSource(source.size, 0x10000, (block) =>
    cache.get(`${identity}:${block}`, 0x10000, async () => {
      const offset = block * 0x10000,
        length = Math.min(0x10000, source.size - offset);
      check(length % 16 === 0, 'AES_ALIGNMENT');
      const actualIV = block ? await readBytes(source, offset - 16, 16) : iv;
      return cbcDecrypt(await readBytes(source, offset, length), key, actualIV);
    }),
  );
}

export function companionSet(
  file: SourceInput,
  name: string,
  companions: CompanionFile[],
) {
  check(
    Array.isArray(companions) && companions.length <= MAX_ENTRIES,
    'TOO_MANY',
  );
  return [
    { name, source: asSource(file) },
    ...companions
      .filter((item) => !sourceIncludes(item, file))
      .map((item) => ({ name: sourceName(item), source: asSource(item) })),
  ].map((item) => {
    check(
      typeof item.name === 'string' && item.name.length <= 4096,
      'INVALID_NAME',
    );
    return { ...item, name: item.name.replaceAll('\\', '/') };
  });
}

export function resolveCompanion(
  records: { name: string; source: ByteSource }[],
  anchor: string,
  wanted: string,
  optional?: false,
): { name: string; source: ByteSource };
export function resolveCompanion(
  records: { name: string; source: ByteSource }[],
  anchor: string,
  wanted: string,
  optional: true,
): { name: string; source: ByteSource } | null;
export function resolveCompanion(
  records: { name: string; source: ByteSource }[],
  anchor: string,
  wanted: string,
  optional = false,
) {
  const folder = anchor.includes('/')
    ? anchor.slice(0, anchor.lastIndexOf('/') + 1)
    : '';
  const requested = (folder + wanted).toLowerCase();
  let matches = records.filter((item) => item.name.toLowerCase() === requested);
  if (!matches.length)
    matches = records.filter(
      (item) =>
        (item.name.split('/').at(-1) || '').toLowerCase() ===
        wanted.toLowerCase(),
    );
  check(matches.length <= 1, 'AMBIGUOUS_COMPANION', wanted);
  check(optional || matches.length === 1, 'MISSING_COMPANION', wanted);
  return matches[0] || null;
}

export function concatenateSources(sources: ByteSource[]): ByteSource {
  let size = 0;
  const ranges = sources.map((source) => {
    const range = { source, offset: size };
    size += source.size;
    check(Number.isSafeInteger(size), 'TOO_LARGE');
    return range;
  });
  return {
    size,
    async read(offset, length) {
      bounds(size, offset, length);
      check(length <= MAX_METADATA, 'READ_TOO_LARGE');
      const output = new Uint8Array(length);
      for (const range of ranges) {
        const start = Math.max(offset, range.offset),
          end = Math.min(offset + length, range.offset + range.source.size);
        if (start < end)
          output.set(
            await readBytes(range.source, start - range.offset, end - start),
            start - offset,
          );
      }
      return output;
    },
  };
}
