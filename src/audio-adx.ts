import { keyCompanionName } from './audio-types.js';
import type {
  AudioDecoder,
  ByteSource,
  CompanionFile,
  DecoderOptions,
} from './contracts.js';
import type { FiniteAudioMetadata } from './audio-types.js';
import { asSource } from './source-input.js';
import { bounds, check } from './binary.js';
import {
  audioDecoder,
  clamp16,
  readAudio,
  signedNibble,
} from './audio-codecs.js';
import { adxKeys8, adxKeys9 } from './adx-keys.js';

type AdxKey = [number, number, number];
interface AdxMetadata extends FiniteAudioMetadata {
  encryption: number;
  blockCount: number;
  dataOffset: number;
  histories: number[][];
  coefficients: number[];
  encoding: number;
  version: number;
  padding: number;
  cutoff: number;
}

const blockSize = 18;
const blockSamples = 32;
const fixedCoefficients = [
  [0, 0],
  [3840, 0],
  [7360, -3328],
  [6272, -3520],
];
let keyPrimes: Uint16Array | undefined;

function triplet(start: unknown, mult: unknown, add: unknown): AdxKey {
  check(
    typeof start === 'number' &&
      typeof mult === 'number' &&
      typeof add === 'number',
    'ADX_KEY',
  );
  const key: AdxKey = [start, mult, add];
  check(
    key.every(
      (value) => Number.isInteger(value) && value >= 0 && value <= 32767,
    ),
    'ADX_KEY',
  );
  return key;
}

function deriveKey9(code: bigint, subkey: number): AdxKey {
  check(code > 0n && code <= 0xffffffffffffffffn, 'ADX_KEY');
  if (subkey)
    code = BigInt.asUintN(
      64,
      code * ((BigInt(subkey) << 16n) | BigInt((subkey ^ 65535) + 2)),
    );
  code = BigInt.asUintN(64, code - 1n);
  return [
    Number((code >> 27n) & 32767n),
    Number((code >> 12n) & 32764n) | 1,
    Number((code << 1n) & 32767n) | 1,
  ];
}

function deriveKey8(bytes: Uint8Array): AdxKey {
  check(
    bytes.length > 0 &&
      bytes.length <= 64 &&
      bytes.every((byte) => byte >= 0x20 && byte <= 0x8f),
    'ADX_KEY',
  );
  if (!keyPrimes) {
    const sieve = new Uint8Array(32768);
    for (let value = 2; value * value < sieve.length; value++) {
      if (sieve[value]) continue;
      for (
        let multiple = value * value;
        multiple < sieve.length;
        multiple += value
      )
        sieve[multiple] = 1;
    }
    keyPrimes = new Uint16Array(1024);
    for (let value = 16384, index = 0; index < keyPrimes.length; value++) {
      if (!sieve[value]) keyPrimes[index++] = value;
    }
  }
  const key: AdxKey = [keyPrimes[256], keyPrimes[512], keyPrimes[768]];
  for (const byte of bytes) {
    const prime = keyPrimes[((byte << 24) >> 24) + 128];
    for (let index = 0; index < key.length; index++)
      key[index] = keyPrimes[(key[index] * prime) % 1024];
  }
  return key;
}

function parseKey(value: unknown, type: number, subkey: number): AdxKey {
  if (
    typeof value === 'object' &&
    value !== null &&
    !(value instanceof Uint8Array)
  ) {
    return triplet(
      ('start' in value ? value.start : undefined) ??
        ('seed' in value ? value.seed : undefined),
      'mult' in value ? value.mult : undefined,
      ('add' in value ? value.add : undefined) ??
        ('inc' in value ? value.inc : undefined),
    );
  }
  if (typeof value === 'bigint') {
    check(type === 9, 'ADX_KEY');
    return deriveKey9(value, subkey);
  }
  if (typeof value === 'string') {
    if (type === 9) {
      check(/^[0-9]{1,20}$/.test(value), 'ADX_KEY');
      return deriveKey9(BigInt(value), subkey);
    }
    check(
      [...value].every((character) => character.charCodeAt(0) <= 0x8f),
      'ADX_KEY',
    );
    return deriveKey8(
      Uint8Array.from(value, (character) => character.charCodeAt(0)),
    );
  }
  check(value instanceof Uint8Array && value.length <= 64, 'ADX_KEY');
  if (type === 8 && value.every((byte) => byte >= 0x20 && byte <= 0x8f))
    return deriveKey8(value);
  if (
    type === 9 &&
    value.length > 0 &&
    value.length <= 20 &&
    value.every((byte) => byte >= 48 && byte <= 57)
  )
    return deriveKey9(BigInt(new TextDecoder().decode(value)), subkey);
  const view = new DataView(value.buffer, value.byteOffset, value.byteLength);
  if (value.length === 6)
    return triplet(view.getUint16(0), view.getUint16(2), view.getUint16(4));
  check(type === 9 && (value.length === 8 || value.length === 10), 'ADX_KEY');
  return deriveKey9(
    view.getBigUint64(0),
    value.length === 10 ? view.getUint16(8) : subkey,
  );
}

function keyAt(key: AdxKey, index: number) {
  let value = key[0],
    mult = key[1],
    add = key[2];
  while (index > 0) {
    if (index % 2) value = (value * mult + add) & 32767;
    add = (add * (mult + 1)) & 32767;
    mult = (mult * mult) & 32767;
    index = Math.floor(index / 2);
  }
  return value;
}

function normalizedName(name: string | undefined) {
  return String(name ?? '')
    .replaceAll('\\', '/')
    .replace(/\/+/g, '/')
    .replace(/^(?:\.\/)+/, '')
    .toLowerCase();
}

function baseName(name: string | undefined) {
  return normalizedName(name).split('/').pop() ?? '';
}

async function companionKeys(
  options: DecoderOptions,
  type: number,
  subkey: number,
) {
  const target = normalizedName(options.name);
  const archiveTarget = normalizedName(options.archiveName);
  const companions = (options.companions ?? []).filter((entry) =>
    baseName(keyCompanionName(entry)).endsWith('.adxkey'),
  );
  let selected: CompanionFile[] = [];
  for (const candidate of [target, archiveTarget]) {
    if (!candidate) continue;
    const names = [
      `${candidate.replace(/\.[^/.]+$/, '')}.adxkey`,
      `${candidate}.adxkey`,
    ];
    selected = companions.filter((entry) =>
      names.includes(normalizedName(keyCompanionName(entry))),
    );
    if (!selected.length) {
      const basenames = names.map(baseName);
      selected = companions.filter((entry) =>
        basenames.includes(baseName(keyCompanionName(entry))),
      );
    }
    if (selected.length) break;
  }
  if (!selected.length)
    selected = companions.filter(
      (entry) => baseName(keyCompanionName(entry)) === '.adxkey',
    );
  if (!selected.length && !target && !archiveTarget && companions.length === 1)
    selected = companions;
  check(selected.length <= 256, 'ADX_KEY');
  const keys: AdxKey[] = [];
  for (const entry of selected) {
    const source = asSource(entry);
    check(
      Number.isSafeInteger(source.size) &&
        source.size > 0 &&
        source.size <= 64 &&
        typeof source.read === 'function',
      'ADX_KEY',
    );
    keys.push(parseKey(await readAudio(source, 0, source.size), type, subkey));
  }
  check(new Set(keys.map((key) => key.join(','))).size <= 1, 'ADX_KEY');
  return keys;
}

async function resolveKey(
  source: ByteSource,
  metadata: AdxMetadata,
  options: DecoderOptions,
) {
  const subkey = options.subkey ?? 0;
  check(Number.isInteger(subkey) && subkey >= 0 && subkey <= 65535, 'ADX_KEY');
  let candidates =
    options.key === undefined
      ? await companionKeys(options, metadata.encryption, subkey)
      : [parseKey(options.key, metadata.encryption, subkey)];
  const supplied = candidates.length > 0;
  if (!supplied)
    candidates =
      metadata.encryption === 8
        ? adxKeys8
        : adxKeys9.map(([start, mult, add, code]): AdxKey =>
            code && (subkey || !(start || mult || add))
              ? deriveKey9(BigInt(code), subkey)
              : [start, mult, add],
          );
  candidates = [
    ...new Map(candidates.map((key) => [key.join(','), key])).values(),
  ];
  check(candidates.length > 0 && candidates.length <= 256, 'ADX_KEY');
  const states = candidates.map((key) => key[0]);
  const mask = metadata.encryption === 8 ? 0xe000 : 0x1000;
  const limit = Math.min(8192, metadata.blockCount);
  let valid = 0,
    tested = 0;
  while (tested < limit && valid < 128) {
    const count = Math.min(1820, limit - tested);
    const raw = await readAudio(
      source,
      metadata.dataOffset + tested * blockSize,
      count * blockSize,
    );
    for (let block = 0; block < count && valid < 128; block++, tested++) {
      const offset = block * blockSize;
      const blank = raw
        .subarray(offset, offset + blockSize)
        .every((byte) => byte === 0);
      const scale = raw[offset] * 256 + raw[offset + 1];
      for (let index = 0; index < candidates.length; index++) {
        if (states[index] < 0) continue;
        if (!blank && ((scale ^ states[index]) & mask) !== 0) {
          states[index] = -1;
          continue;
        }
        states[index] =
          (states[index] * candidates[index][1] + candidates[index][2]) & 32767;
      }
      if (!blank) valid++;
    }
  }
  const matches = candidates.filter((_, index) => states[index] >= 0);
  check((supplied || valid >= 128) && matches.length === 1, 'ADX_KEY');
  return matches[0];
}

async function transformedSource(
  source: ByteSource,
  metadata: AdxMetadata,
  options: DecoderOptions,
): Promise<ByteSource> {
  const key = await resolveKey(source, metadata, options);
  const dataEnd = metadata.dataOffset + metadata.blockCount * blockSize;
  const mask = metadata.encryption === 8 ? 0xe000 : 0x1000;
  return {
    size: source.size,
    async read(offset: number, length: number) {
      bounds(source.size, offset, length);
      const output = new Uint8Array(length);
      for (let position = 0; position < length; position += 65536) {
        const count = Math.min(65536, length - position);
        output.set(await readAudio(source, offset + position, count), position);
      }
      const end = offset + length;
      if (offset <= 19 && end > 19) output[19 - offset] = 0;
      const first = Math.max(
        0,
        Math.floor((offset - metadata.dataOffset) / blockSize),
      );
      const last = Math.min(
        metadata.blockCount,
        Math.ceil((Math.min(end, dataEnd) - metadata.dataOffset) / blockSize),
      );
      let state = keyAt(key, first);
      for (let block = first; block < last; block++) {
        const start = metadata.dataOffset + block * blockSize;
        if (start + 2 > offset && start < end) {
          const raw =
            start >= offset && start + blockSize <= end
              ? output.subarray(start - offset, start - offset + blockSize)
              : await readAudio(source, start, blockSize);
          if (raw.some((byte) => byte !== 0)) {
            const scale = raw[0] * 256 + raw[1];
            check(((scale ^ state) & mask) === 0, 'ADX_KEY');
            const decrypted = (scale ^ state) & 8191;
            if (start >= offset) output[start - offset] = decrypted >> 8;
            if (start + 1 >= offset && start + 1 < end)
              output[start + 1 - offset] = decrypted & 255;
          }
        }
        state = (state * key[1] + key[2]) & 32767;
      }
      return output;
    },
  };
}

export async function decryptAdxSource(
  source: ByteSource,
  options: DecoderOptions = {},
) {
  const metadata = await inspectAdx(source);
  return metadata.encryption
    ? transformedSource(source, metadata, options)
    : source;
}

export function hasAdxPrefix(bytes: Uint8Array, offset = 0): boolean {
  const encoding = bytes[offset + 4];
  const channels = bytes[offset + 7];
  return (
    bytes.length >= offset + 8 &&
    bytes[offset] === 0x80 &&
    bytes[offset + 1] === 0 &&
    encoding >= 2 &&
    encoding <= 4 &&
    bytes[offset + 5] === blockSize &&
    bytes[offset + 6] === 4 &&
    channels >= 1 &&
    channels <= 8
  );
}

export async function inspectAdx(source: ByteSource): Promise<AdxMetadata> {
  const header = await readAudio(source, 0, 20);
  const view = new DataView(
    header.buffer,
    header.byteOffset,
    header.byteLength,
  );
  check(hasAdxPrefix(header), 'INVALID_AUDIO');
  const dataOffset = view.getUint16(2) + 4;
  const encoding = header[4];
  const channels = header[7];
  const sampleRate = view.getUint32(8);
  const length = view.getUint32(12);
  const cutoff = view.getUint16(16);
  const version = header[18];
  const encryption = header[19];
  check(
    channels >= 1 &&
      channels <= 8 &&
      sampleRate >= 1000 &&
      sampleRate <= 192000 &&
      length <= 0x7fffffff,
    'INVALID_AUDIO',
  );
  check(
    [3, 4, 5].includes(version) &&
      (encryption === 0 ||
        (version === 4 && [8, 9].includes(encryption) && encoding === 3)),
    'INVALID_AUDIO',
  );
  const historySize = version === 4 ? Math.max(2, channels) * 4 : 0;
  const loopOffset = version === 3 ? 20 : 24 + historySize;
  check(
    dataOffset >= (version === 4 ? 24 + historySize : 20) + 6,
    'INVALID_AUDIO',
  );
  const marker = await readAudio(source, dataOffset - 6, 6);
  check(
    marker.every((byte, index) => byte === [40, 99, 41, 67, 82, 73][index]),
    'INVALID_AUDIO',
  );
  const blockCount = Math.ceil(length / blockSamples) * channels;
  bounds(source.size, dataOffset, blockCount * blockSize);
  const histories = Array.from({ length: channels }, () => [0, 0]);
  if (historySize) {
    const raw = await readAudio(source, 24, historySize);
    const historyView = new DataView(
      raw.buffer,
      raw.byteOffset,
      raw.byteLength,
    );
    histories.forEach((history, channel) => {
      history[0] = historyView.getInt16(channel * 4);
      history[1] = historyView.getInt16(channel * 4 + 2);
    });
  }
  let loop = false,
    loopStart = 0,
    loopEnd = length,
    padding = 0,
    infoSize = 0;
  if (version === 4 && loopOffset + 12 <= dataOffset - 6) {
    const raw = await readAudio(source, loopOffset + 4, 8);
    const info = new DataView(raw.buffer, raw.byteOffset, raw.byteLength);
    if (info.getUint32(0) === 0x41494e46) {
      infoSize = info.getUint32(4);
      check(
        infoSize >= 8 && infoSize <= dataOffset - 6 - loopOffset - 4,
        'INVALID_AUDIO',
      );
    }
  }
  if (version !== 5 && loopOffset + 24 <= dataOffset - 6 - infoSize) {
    const raw = await readAudio(source, loopOffset, 24);
    const loops = new DataView(raw.buffer, raw.byteOffset, raw.byteLength);
    padding = loops.getUint16(0);
    loop = loops.getUint32(4) !== 0;
    if (loop) {
      loopStart = loops.getUint32(8);
      loopEnd = loops.getUint32(16);
      check(loopStart < loopEnd && loopEnd <= length, 'INVALID_AUDIO');
    }
  }
  const a = Math.SQRT2 - Math.cos((2 * Math.PI * cutoff) / sampleRate);
  const b = Math.SQRT2 - 1;
  const c = (a - Math.sqrt((a + b) * (a - b))) / b;
  const coefficients = [Math.trunc(c * 8192), Math.trunc(c * c * -4096)];
  return {
    channels,
    sampleRate,
    length,
    loop,
    loopStart,
    loopEnd,
    padding,
    dataOffset,
    blockCount,
    encoding,
    version,
    encryption,
    cutoff,
    histories,
    coefficients,
  };
}

export async function createAdxDecoder(
  source: ByteSource,
  options: DecoderOptions = {},
): Promise<AudioDecoder> {
  const metadata = await inspectAdx(source);
  if (metadata.encryption)
    source = await transformedSource(source, metadata, options);
  const groupSize = blockSize * metadata.channels;
  const cacheSize = Math.floor(32768 / groupSize) * groupSize;
  const pending = Array.from(
    { length: metadata.channels },
    () => new Float32Array(blockSamples),
  );
  let histories: number[][] = [],
    group = 0,
    pendingPosition = 0,
    pendingLength = 0,
    cache: Uint8Array = new Uint8Array(0),
    cacheOffset = 0;
  function reset() {
    histories = metadata.histories.map((history) => history.slice());
    group = 0;
    pendingPosition = 0;
    pendingLength = 0;
    cache = new Uint8Array(0);
    cacheOffset = 0;
  }
  async function decodeGroup() {
    const offset = metadata.dataOffset + group * groupSize;
    if (
      offset < cacheOffset ||
      offset + groupSize > cacheOffset + cache.length
    ) {
      cacheOffset = offset;
      cache = await readAudio(
        source,
        offset,
        Math.min(
          cacheSize,
          metadata.blockCount * blockSize - group * groupSize,
        ),
      );
    }
    const base = offset - cacheOffset;
    const count = Math.min(
      blockSamples,
      metadata.length - group * blockSamples,
    );
    for (let channel = 0; channel < metadata.channels; channel++) {
      const start = base + channel * blockSize;
      const code = cache[start] * 256 + cache[start + 1];
      let coefficients = metadata.coefficients;
      let scale: number;
      if (metadata.encoding === 2) {
        const predictor = code >> 13;
        check(predictor < fixedCoefficients.length, 'INVALID_AUDIO');
        coefficients = fixedCoefficients[predictor];
        scale = (code & 8191) + 1;
      } else if (metadata.encoding === 4) {
        check(code <= 12, 'INVALID_AUDIO');
        scale = 2 ** (12 - code);
      } else {
        check(code <= 32767 || code === 0x8001, 'INVALID_AUDIO');
        scale = code === 0x8001 ? 0 : code + 1;
      }
      let [h1, h2] = histories[channel];
      for (let sample = 0; sample < count; sample++) {
        const nibble = signedNibble(
          (cache[start + 2 + (sample >> 1)] >> (sample & 1 ? 0 : 4)) & 15,
        );
        const prediction =
          metadata.version === 3
            ? Math.floor((coefficients[0] * h1) / 4096) +
              Math.floor((coefficients[1] * h2) / 4096)
            : Math.floor((coefficients[0] * h1 + coefficients[1] * h2) / 4096);
        const value = clamp16(nibble * scale + prediction);
        pending[channel][sample] = value / 32768;
        h2 = h1;
        h1 = value;
      }
      histories[channel][0] = h1;
      histories[channel][1] = h2;
    }
    group++;
    pendingPosition = 0;
    pendingLength = count;
  }
  reset();
  return audioDecoder(
    metadata,
    async (count) => {
      const output = Array.from(
        { length: metadata.channels },
        () => new Float32Array(count),
      );
      let written = 0;
      while (written < count) {
        if (pendingPosition === pendingLength) await decodeGroup();
        const take = Math.min(count - written, pendingLength - pendingPosition);
        output.forEach((channel, index) =>
          channel.set(
            pending[index].subarray(pendingPosition, pendingPosition + take),
            written,
          ),
        );
        pendingPosition += take;
        written += take;
      }
      return output;
    },
    reset,
  );
}
