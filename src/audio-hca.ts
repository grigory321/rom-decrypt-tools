import { keyCompanionName } from './audio-types.js';
import type {
  AudioDecoder,
  ByteSource,
  CompanionFile,
  DecoderOptions,
} from './contracts.js';
import type { HcaMetadata } from './audio-types.js';
import { asSource } from './source-input.js';
import { bounds, check, FormatError } from './binary.js';
import { audioDecoder, readAudio } from './audio-codecs.js';

interface HcaKeyCandidate {
  key?: bigint;
  subkey: number;
}

function crc16(bytes: Uint8Array, length = bytes.length) {
  let crc = 0;
  for (let i = 0; i < length; i++) {
    crc ^= bytes[i] << 8;
    for (let bit = 0; bit < 8; bit++)
      crc = ((crc << 1) ^ (crc & 32768 ? 0x8005 : 0)) & 65535;
  }
  return crc;
}

function writeChecksum(bytes: Uint8Array) {
  const crc = crc16(bytes, bytes.length - 2);
  bytes[bytes.length - 2] = crc >> 8;
  bytes[bytes.length - 1] = crc & 255;
}

export async function inspectHca(source: ByteSource): Promise<HcaMetadata> {
  const prefix = await readAudio(source, 0, 8);
  check(
    String.fromCharCode(...prefix.subarray(0, 4).map((v) => v & 127)) ===
      'HCA\0',
    'INVALID_AUDIO',
  );
  const headerSize = prefix[6] * 256 + prefix[7];
  check(headerSize >= 40, 'INVALID_AUDIO');
  const bytes = await readAudio(source, 0, headerSize);
  check(crc16(bytes) === 0, 'HCA_CRC');
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const metadata: HcaMetadata = {
    bytes,
    channels: 0,
    sampleRate: 0,
    length: 0,
    frameCount: 0,
    delay: 0,
    padding: 0,
    frameSize: 0,
    minResolution: 0,
    maxResolution: 0,
    tracks: 0,
    channelConfig: 0,
    totalBands: 0,
    baseBands: 0,
    stereoBands: 0,
    hfrBands: 0,
    hfrGroups: 0,
    dataEnd: 0,
    loopStart: 0,
    loopEnd: 0,
    headerSize,
    version: view.getUint16(4),
    cipherType: 0,
    cipherOffset: null,
    chunkOffsets: [],
    athType: view.getUint16(4) < 0x200 ? 1 : 0,
    loop: false,
    msStereo: 0,
  };
  check(
    [0x101, 0x102, 0x103, 0x200, 0x300].includes(metadata.version),
    'CODEC',
    'HCA version',
  );
  let offset = 8,
    format = false,
    compression = false;
  const chunks = new Set<string>();
  while (offset < headerSize - 2) {
    bounds(headerSize - 2, offset, 4);
    const tag = String.fromCharCode(
      ...bytes.subarray(offset, offset + 4).map((v) => v & 127),
    );
    if (tag === '\0\0\0\0') break;
    check(!chunks.has(tag), 'INVALID_AUDIO');
    chunks.add(tag);
    metadata.chunkOffsets.push(offset);
    const requireBytes = (count: number) =>
      bounds(headerSize - 2, offset, count);
    if (tag === 'fmt\0') {
      check(!format && !compression, 'INVALID_AUDIO');
      requireBytes(16);
      metadata.channels = bytes[offset + 4];
      metadata.sampleRate = view.getUint32(offset + 4) & 0xffffff;
      metadata.frameCount = view.getUint32(offset + 8);
      metadata.delay = view.getUint16(offset + 12);
      metadata.padding = view.getUint16(offset + 14);
      format = true;
      offset += 16;
    } else if (tag === 'comp' || tag === 'dec\0') {
      check(format && !compression, 'INVALID_AUDIO');
      requireBytes(tag === 'comp' ? 16 : 12);
      metadata.frameSize = view.getUint16(offset + 4);
      metadata.minResolution = bytes[offset + 6];
      metadata.maxResolution = bytes[offset + 7];
      if (tag === 'comp') {
        metadata.tracks = bytes[offset + 8] || 1;
        metadata.channelConfig = bytes[offset + 9];
        metadata.totalBands = bytes[offset + 10];
        metadata.baseBands = bytes[offset + 11];
        metadata.stereoBands = bytes[offset + 12];
        metadata.hfrBands = bytes[offset + 13];
        metadata.msStereo = bytes[offset + 14];
        check(
          bytes[offset + 15] === 0,
          'CODEC',
          'HCA reserved compression flags',
        );
        offset += 16;
      } else {
        metadata.totalBands = bytes[offset + 8] + 1;
        metadata.baseBands = bytes[offset + 11]
          ? bytes[offset + 9] + 1
          : metadata.totalBands;
        metadata.tracks = bytes[offset + 10] >> 4 || 1;
        metadata.channelConfig = bytes[offset + 10] & 15;
        metadata.stereoBands = metadata.totalBands - metadata.baseBands;
        metadata.hfrBands = 0;
        offset += 12;
      }
      compression = true;
    } else if (tag === 'ath\0') {
      requireBytes(6);
      metadata.athType = view.getUint16(offset + 4);
      offset += 6;
    } else if (tag === 'loop') {
      check(!metadata.loop, 'INVALID_AUDIO');
      requireBytes(16);
      const start = view.getUint32(offset + 4),
        end = view.getUint32(offset + 8);
      check(start <= end && end < metadata.frameCount, 'INVALID_AUDIO');
      metadata.loop = true;
      metadata.loopStart =
        start * 1024 - metadata.delay + view.getUint16(offset + 12);
      metadata.loopEnd =
        (end + 1) * 1024 - metadata.delay - view.getUint16(offset + 14);
      offset += 16;
    } else if (tag === 'ciph') {
      check(metadata.cipherOffset === null, 'INVALID_AUDIO');
      requireBytes(6);
      metadata.cipherType = view.getUint16(offset + 4);
      metadata.cipherOffset = offset;
      offset += 6;
    } else if (tag === 'rva\0') {
      requireBytes(8);
      check(Number.isFinite(view.getFloat32(offset + 4)), 'INVALID_AUDIO');
      offset += 8;
    } else if (tag === 'comm') {
      requireBytes(5);
      const count = bytes[offset + 4];
      requireBytes(5 + count);
      offset += 5 + count;
    } else if (tag === 'pad\0') {
      break;
    } else {
      check(false, 'CODEC', `HCA header chunk ${tag}`);
    }
  }
  check(format && compression, 'INVALID_AUDIO');
  check(
    metadata.channels >= 1 &&
      metadata.channels <= 8 &&
      metadata.sampleRate >= 1000 &&
      metadata.sampleRate <= 192000,
    'INVALID_AUDIO',
  );
  check(metadata.frameCount > 0 && metadata.frameSize >= 8, 'INVALID_AUDIO');
  check([0, 1, 56].includes(metadata.cipherType), 'HCA_KEY');
  check(
    metadata.athType === 0 || metadata.athType === 1,
    'CODEC',
    'HCA ATH mode',
  );
  check(
    !metadata.msStereo && !(metadata.channelConfig & 128),
    'CODEC',
    'HCA MS stereo or ambisonics',
  );
  check(
    metadata.tracks <= metadata.channels &&
      metadata.channels % metadata.tracks === 0,
    'INVALID_AUDIO',
  );
  check(
    metadata.minResolution <= metadata.maxResolution &&
      metadata.maxResolution <= 15 &&
      (metadata.version > 0x200 ||
        (metadata.minResolution === 1 && metadata.maxResolution === 15)),
    'INVALID_AUDIO',
  );
  check(
    metadata.totalBands > 0 &&
      metadata.totalBands <= 128 &&
      metadata.baseBands + metadata.stereoBands > 0 &&
      metadata.baseBands + metadata.stereoBands <= metadata.totalBands &&
      metadata.stereoBands <= metadata.baseBands &&
      metadata.hfrBands <= 128,
    'INVALID_AUDIO',
  );
  metadata.hfrGroups = metadata.hfrBands
    ? Math.ceil(
        (metadata.totalBands - metadata.baseBands - metadata.stereoBands) /
          metadata.hfrBands,
      )
    : 0;
  check(
    metadata.baseBands + metadata.stereoBands + metadata.hfrGroups <= 128,
    'INVALID_AUDIO',
  );
  metadata.length =
    metadata.frameCount * 1024 - metadata.delay - metadata.padding;
  check(metadata.length >= 0, 'INVALID_AUDIO');
  if (metadata.loop)
    check(
      metadata.loopStart >= 0 &&
        metadata.loopStart < metadata.loopEnd &&
        metadata.loopEnd <= metadata.length,
      'INVALID_AUDIO',
    );
  bounds(source.size, headerSize, metadata.frameCount * metadata.frameSize);
  metadata.dataEnd = headerSize + metadata.frameCount * metadata.frameSize;
  return metadata;
}

function cipherTable(type: number, key = 0n) {
  if (type === 0) return Uint8Array.from({ length: 256 }, (_, i) => i);
  const table = new Uint8Array(256);
  table[255] = 255;
  let position = 1;
  if (type === 1) {
    let value = 0;
    for (let i = 0; i < 256; i++) {
      value = (value * 13 + 11) & 255;
      if (value && value !== 255) table[position++] = value;
    }
    return table;
  }
  const keyBytes = Array.from({ length: 7 }, (_, i) =>
    Number(((key - 1n) >> BigInt(i * 8)) & 255n),
  );
  const [a, b, c, d, e, f, g] = keyBytes;
  const seeds = [
    b,
    g ^ b,
    c ^ d,
    c,
    b ^ c,
    d ^ e,
    d,
    c ^ d,
    e ^ f,
    e,
    d ^ e,
    f ^ g,
    f,
    e ^ f,
    g ^ b,
    g,
  ];
  const row = (seed: number) => {
    let value = seed >> 4;
    return Uint8Array.from({ length: 16 }, () => {
      value = (value * (((seed & 1) << 3) | 5) + ((seed & 14) | 1)) & 15;
      return value;
    });
  };
  const rows = row(a),
    mixed = new Uint8Array(256);
  for (let i = 0; i < 16; i++) {
    const columns = row(seeds[i]);
    for (let j = 0; j < 16; j++) mixed[i * 16 + j] = rows[i] * 16 + columns[j];
  }
  for (let i = 1; i <= 256; i++) {
    const value = mixed[(i * 17) & 255];
    if (value && value !== 255) table[position++] = value;
  }
  return table;
}

function parseKey(value: unknown) {
  check(
    typeof value === 'bigint' ||
      (typeof value === 'number' && Number.isSafeInteger(value)) ||
      (typeof value === 'string' &&
        /^(?:[0-9]{1,20}|0x[0-9a-f]{1,16})$/i.test(value)),
    'HCA_KEY',
  );
  const key = BigInt(value);
  check(key > 0n && key <= 0xffffffffffffffffn, 'HCA_KEY');
  return key;
}

function deriveKey(key: bigint, subkey: number) {
  check(Number.isInteger(subkey) && subkey >= 0 && subkey <= 65535, 'HCA_KEY');
  return subkey
    ? BigInt.asUintN(
        64,
        key * ((BigInt(subkey) << 16n) | BigInt((~subkey & 65535) + 2)),
      )
    : key;
}

function normalizedPath(name: string | undefined) {
  const value = String(name ?? '')
    .replaceAll('\\', '/')
    .toLowerCase();
  const absolute = value.startsWith('/'),
    parts: string[] = [];
  for (const part of value.split('/')) {
    if (!part || part === '.') continue;
    if (part === '..' && parts.length && parts.at(-1) !== '..') parts.pop();
    else if (part !== '..' || !absolute) parts.push(part);
  }
  return (absolute ? '/' : '') + parts.join('/');
}

function baseName(name: string | undefined) {
  return normalizedPath(name).split('/').pop() ?? '';
}

function matchesKeyName(name: string, target: string) {
  const dot = target.lastIndexOf('.'),
    slash = target.lastIndexOf('/');
  const stem = dot > slash ? target.slice(0, dot) : target;
  return name === `${stem}.hcakey` || name === `${target}.hcakey`;
}

async function companionKeys(options: DecoderOptions) {
  const targets = [
    normalizedPath(options.name),
    normalizedPath(options.archiveName),
  ];
  const companions = (options.companions ?? []).filter((entry) =>
    baseName(keyCompanionName(entry)).endsWith('.hcakey'),
  );
  let selected: CompanionFile[] = [];
  for (const target of targets) {
    if (!target) continue;
    selected = companions.filter((entry) =>
      matchesKeyName(normalizedPath(keyCompanionName(entry)), target),
    );
    if (!selected.length)
      selected = companions.filter((entry) =>
        matchesKeyName(baseName(keyCompanionName(entry)), baseName(target)),
      );
    if (selected.length) break;
  }
  if (!selected.length)
    selected = companions.filter(
      (entry) => baseName(keyCompanionName(entry)) === '.hcakey',
    );
  if (!selected.length && !targets.some(Boolean) && companions.length === 1)
    selected = companions;
  check(selected.length <= 256, 'HCA_KEY');
  const keys: HcaKeyCandidate[] = [];
  for (const companion of selected) {
    const source = asSource(companion);
    check(
      source &&
        Number.isSafeInteger(source.size) &&
        source.size >= 1 &&
        source.size <= 20 &&
        typeof source.read === 'function',
      'HCA_KEY',
    );
    const bytes = await readAudio(source, 0, source.size);
    const text = new TextDecoder().decode(bytes);
    let key: bigint | undefined,
      subkey = options.subkey ?? 0;
    if (/^[0-9]{1,20}$/.test(text)) key = parseKey(text);
    else if (bytes.length === 8 || bytes.length === 10) {
      const view = new DataView(
        bytes.buffer,
        bytes.byteOffset,
        bytes.byteLength,
      );
      key = parseKey(view.getBigUint64(0));
      if (bytes.length === 10) subkey = view.getUint16(8);
    } else if (bytes.length === 2) {
      subkey = bytes[0] * 256 + bytes[1];
    } else check(false, 'HCA_KEY');
    keys.push({ key, subkey });
  }
  return keys;
}

function decryptFrame(bytes: Uint8Array, table: Uint8Array) {
  check(crc16(bytes) === 0, 'HCA_CRC');
  check(bytes[0] === 255 && bytes[1] === 255, 'INVALID_AUDIO');
  const output = new Uint8Array(bytes);
  for (let i = 0; i < output.length - 2; i++) output[i] = table[output[i]];
  writeChecksum(output);
  return output;
}

async function resolveCipher(
  source: ByteSource,
  metadata: HcaMetadata,
  options: DecoderOptions,
) {
  if (metadata.cipherType !== 56) return cipherTable(metadata.cipherType);
  const { createFrameDecoder } = await import('./hca-decoder.js');
  const { knownKeys } = await import('./hca-tables.js');
  const companions =
    options.key === undefined ? await companionKeys(options) : [];
  const explicit =
    options.key !== undefined
      ? [{ key: parseKey(options.key), subkey: options.subkey ?? 0 }]
      : companions.filter(
          (entry): entry is HcaKeyCandidate & { key: bigint } =>
            entry.key !== undefined,
        );
  const subkey =
    companions.find((entry) => entry.key === undefined)?.subkey ??
    options.subkey ??
    0;
  check(
    companions
      .filter((entry) => entry.key === undefined)
      .every((entry) => entry.subkey === subkey),
    'HCA_KEY',
    'Conflicting HCA subkeys',
  );
  const effectiveKeys = new Set(
    explicit.map((entry) =>
      (deriveKey(entry.key, entry.subkey) & 0xffffffffffffffn).toString(),
    ),
  );
  check(effectiveKeys.size <= 1, 'HCA_KEY', 'Conflicting HCA companion keys');
  const candidates = explicit.length
    ? explicit
    : knownKeys.map((key) => ({ key, subkey }));
  const samples: Uint8Array[] = [];
  for (let index = 0; index < Math.min(metadata.frameCount, 32); index++) {
    const bytes = await readAudio(
      source,
      metadata.headerSize + index * metadata.frameSize,
      metadata.frameSize,
    );
    check(crc16(bytes) === 0, 'HCA_CRC');
    check(bytes[0] === 255 && bytes[1] === 255, 'INVALID_AUDIO');
    if (
      bytes.subarray(2, -2).some((value) => value !== 0) &&
      !samples.some((sample) =>
        sample.every((value, index) => value === bytes[index]),
      )
    )
      samples.push(new Uint8Array(bytes));
    if (samples.length === 8) break;
  }
  check(
    samples.length || explicit.length,
    'HCA_KEY',
    'HCA key cannot be validated from silent frames',
  );
  check(
    explicit.length || samples.length >= 2,
    'HCA_KEY',
    'HCA automatic keys require two distinct frames',
  );
  let match: Uint8Array | null = null;
  const tested = new Set<string>();
  for (const candidate of candidates) {
    const table = cipherTable(56, deriveKey(candidate.key, candidate.subkey));
    const identity = Array.from(table).join(',');
    if (tested.has(identity)) continue;
    tested.add(identity);
    try {
      const decoder = await createFrameDecoder(metadata);
      let evidence = 0;
      for (const bytes of samples) {
        decoder.decode(decryptFrame(bytes, table), true);
        if (decoder.keyEvidence) evidence++;
      }
      check(evidence >= Math.min(2, samples.length), 'INVALID_AUDIO');
      check(!match, 'HCA_KEY', 'HCA key is ambiguous');
      match = table;
    } catch (error) {
      if (error instanceof FormatError && error.code === 'HCA_KEY') throw error;
      if (!(error instanceof FormatError)) throw error;
    }
  }
  check(match, 'HCA_KEY', 'No validated HCA key found');
  return match;
}

async function openHca(source: ByteSource, options: DecoderOptions) {
  const metadata = await inspectHca(source);
  const table = await resolveCipher(source, metadata, options);
  return { metadata, table };
}

export async function createHcaDecoder(
  source: ByteSource,
  options: DecoderOptions = {},
): Promise<AudioDecoder> {
  const { metadata, table } = await openHca(source, options);
  const { createFrameDecoder } = await import('./hca-decoder.js');
  let frameDecoder = await createFrameDecoder(metadata),
    frameIndex = 0,
    pending: Float32Array[] | null = null,
    position = 0;
  const reset = async () => {
    frameDecoder = await createFrameDecoder(metadata);
    frameIndex = 0;
    pending = null;
    position = 0;
  };
  return audioDecoder(
    metadata,
    async (count) => {
      const output = Array.from(
        { length: metadata.channels },
        () => new Float32Array(count),
      );
      let written = 0;
      while (written < count) {
        if (!pending || position === pending[0].length) {
          check(frameIndex < metadata.frameCount, 'BOUNDS');
          const bytes = await readAudio(
            source,
            metadata.headerSize + frameIndex * metadata.frameSize,
            metadata.frameSize,
          );
          pending = frameDecoder.decode(decryptFrame(bytes, table));
          position = Math.min(
            1024,
            Math.max(0, metadata.delay - frameIndex * 1024),
          );
          frameIndex++;
        }
        const take = Math.min(count - written, pending[0].length - position);
        for (let channel = 0; channel < output.length; channel++)
          output[channel].set(
            pending[channel].subarray(position, position + take),
            written,
          );
        position += take;
        written += take;
      }
      return output;
    },
    reset,
  );
}

export async function decryptHcaSource(
  source: ByteSource,
  options: DecoderOptions = {},
) {
  const { metadata, table } = await openHca(source, options);
  const header = new Uint8Array(metadata.bytes),
    patches = new Map<number, number>();
  const patch = (offset: number, value: number) => {
    if (header[offset] !== value) {
      header[offset] = value;
      patches.set(offset, value);
    }
  };
  for (const offset of metadata.chunkOffsets)
    for (let i = 0; i < 4; i++) patch(offset + i, header[offset + i] & 127);
  for (let i = 0; i < 4; i++) patch(i, header[i] & 127);
  if (metadata.cipherOffset !== null) {
    patch(metadata.cipherOffset + 4, 0);
    patch(metadata.cipherOffset + 5, 0);
  }
  const crc = crc16(header, header.length - 2);
  patch(header.length - 2, crc >> 8);
  patch(header.length - 1, crc & 255);
  if (!patches.size && metadata.cipherType === 0) return source;
  return patchedHcaSource(
    source,
    metadata.headerSize,
    metadata.frameSize,
    metadata.dataEnd,
    [...patches],
    table,
    metadata.cipherType !== 0,
  );
}

function patchedHcaSource(
  source: ByteSource,
  headerSize: number,
  frameSize: number,
  dataEnd: number,
  patches: [number, number][],
  table: Uint8Array,
  encrypted: boolean,
) {
  let cachedIndex = -1,
    cachedFrame: Uint8Array = new Uint8Array(0);
  return {
    size: source.size,
    async read(offset: number, length: number) {
      bounds(source.size, offset, length);
      const output = new Uint8Array(length);
      let written = 0;
      while (written < length) {
        const position = offset + written;
        let bytes: Uint8Array, start: number, count: number;
        if (position < headerSize) {
          count = Math.min(length - written, headerSize - position);
          bytes = await readAudio(source, position, count);
          start = 0;
        } else if (encrypted && position < dataEnd) {
          const index = Math.floor((position - headerSize) / frameSize);
          if (index !== cachedIndex) {
            cachedFrame = decryptFrame(
              await readAudio(
                source,
                headerSize + index * frameSize,
                frameSize,
              ),
              table,
            );
            cachedIndex = index;
          }
          bytes = cachedFrame;
          start = (position - headerSize) % frameSize;
          count = Math.min(length - written, frameSize - start);
        } else {
          count = Math.min(length - written, 65536);
          bytes = await readAudio(source, position, count);
          start = 0;
        }
        output.set(bytes.subarray(start, start + count), written);
        written += count;
      }
      for (const [position, value] of patches)
        if (position >= offset && position < offset + length)
          output[position - offset] = value;
      return output;
    },
  };
}
