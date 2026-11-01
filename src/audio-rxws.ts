import type {
  AudioDecoder,
  ByteSource,
  CompanionFile,
  DecoderOptions,
  Diagnostic,
} from './contracts.js';
import type { ChannelReader } from './audio-types.js';
import { Bin, bounds, check, FormatError } from './binary.js';
import {
  channelDecoder,
  encodedChannel,
  interleavedAudio,
  readAudio,
} from './audio-codecs.js';
import { asSource, sourceName } from './source-input.js';

export interface RxwsTrack {
  index: number;
  name: string;
  source: ByteSource;
  format: 'RXWS';
  codec: 'psx' | 'pcm16';
  sampleRate: number;
  channels: number;
  length: number;
  loop: boolean;
  loopStart: number;
  loopEnd: number;
}

export interface RxwsBank {
  tracks: RxwsTrack[];
  diagnostics: Diagnostic[];
  split: boolean;
}

interface Chunk {
  start: number;
  size: number;
}

interface StreamRecord {
  index: number;
  type: number;
  channels: number;
  sampleRate: number;
  offset: number;
  bytes: number;
  loop: number;
}

function validateSource(source: ByteSource) {
  check(
    source &&
      Number.isSafeInteger(source.size) &&
      source.size >= 0 &&
      typeof source.read === 'function',
    'INVALID_AUDIO',
  );
}

function standaloneSource(
  body: ByteSource,
  start: number,
  record: StreamRecord,
  name: string,
  originalName: Uint8Array | undefined,
  checkCancelled: () => void,
): ByteSource {
  const title = originalName
    ? new Uint8Array(originalName.length + 1)
    : new TextEncoder().encode(name + '\0');
  if (originalName) title.set(originalName);
  const nameSize = 8 + title.length;
  const header = new Uint8Array(0x60 + nameSize);
  const view = new DataView(header.buffer);
  const text = (offset: number, value: string) =>
    header.set(new TextEncoder().encode(value), offset);
  const size = header.length + record.bytes;
  text(0, 'RXWS');
  view.setUint32(4, size - 16, true);
  view.setUint32(8, 0x100, true);
  text(16, 'FORM');
  view.setUint32(20, 32, true);
  view.setUint32(24, 0x100, true);
  view.setUint32(32, 1, true);
  header[36] = record.type;
  header[37] = 28;
  header[45] = record.channels;
  view.setUint16(46, record.sampleRate, true);
  view.setInt32(56, record.bytes, true);
  view.setInt32(60, record.loop, true);
  text(64, 'FTXT');
  view.setUint32(68, nameSize, true);
  view.setUint32(80, 1, true);
  view.setUint32(84, 8, true);
  header.set(title, 88);
  const bodyHeader = 80 + nameSize;
  text(bodyHeader, 'BODY');
  view.setUint32(bodyHeader + 4, record.bytes, true);
  return {
    size,
    async read(offset, length) {
      checkCancelled();
      bounds(size, offset, length);
      const output = new Uint8Array(length);
      const prefix = Math.min(length, Math.max(0, header.length - offset));
      if (prefix) output.set(header.subarray(offset, offset + prefix));
      let written = prefix;
      while (written < length) {
        checkCancelled();
        const count = Math.min(65536, length - written);
        output.set(
          await readAudio(
            body,
            start + offset + written - header.length,
            count,
          ),
          written,
        );
        written += count;
      }
      checkCancelled();
      return output;
    },
  };
}

export async function readRxws(
  source: ByteSource,
  body?: ByteSource,
  checkCancelled: () => void = () => {},
): Promise<RxwsBank | null> {
  checkCancelled();
  validateSource(source);
  if (source.size < 4) return null;
  if (new Bin(await readAudio(source, 0, 4)).str(0, 4) !== 'RXWS') return null;
  check(source.size >= 16, 'INVALID_AUDIO', 'Truncated RXWS header');
  const header = new Bin(await readAudio(source, 0, 16));
  check(header.u32(4) + 16 === source.size, 'INVALID_AUDIO', 'RXWS file size');
  let form: Chunk | undefined;
  let names: Chunk | undefined;
  let data: Chunk | undefined;
  let position = 16;
  let chunks = 0;
  while (position < source.size) {
    checkCancelled();
    check(++chunks <= 20000, 'TOO_MANY');
    bounds(source.size, position, 16);
    const chunkHeader = new Bin(await readAudio(source, position, 16));
    const magic = chunkHeader.str(0, 4);
    const chunk = { start: position + 16, size: chunkHeader.u32(4) };
    bounds(source.size, chunk.start, chunk.size);
    if (position === 16)
      check(magic === 'FORM', 'INVALID_AUDIO', 'RXWS FORM must be first');
    if (magic === 'FORM') {
      check(!form, 'INVALID_AUDIO', 'Duplicate RXWS FORM');
      form = chunk;
    } else if (magic === 'FTXT') {
      check(!names, 'INVALID_AUDIO', 'Duplicate RXWS FTXT');
      names = chunk;
    } else if (magic === 'BODY') {
      check(!data, 'INVALID_AUDIO', 'Duplicate RXWS BODY');
      data = chunk;
    }
    position = chunk.start + chunk.size;
    if ((chunks & 127) === 0) {
      await new Promise<void>((resolve) => setTimeout(resolve, 0));
      checkCancelled();
    }
  }
  check(form && form.size >= 4, 'INVALID_AUDIO', 'Missing RXWS FORM');
  const count = new Bin(await readAudio(source, form.start, 4)).u32(0);
  check(count > 0 && count <= 20000, 'TOO_MANY');
  check(4 + count * 28 <= form.size, 'INVALID_AUDIO', 'RXWS FORM table');
  const records: StreamRecord[] = [];
  for (let index = 0; index < count; index++) {
    checkCancelled();
    const record = new Bin(
      await readAudio(source, form.start + 4 + index * 28, 28),
    );
    records.push({
      index,
      type: record.u8(0),
      channels: record.u8(9),
      sampleRate: record.u16(10),
      offset: record.u32(16),
      bytes: record.u32(20) | 0,
      loop: record.u32(24) | 0,
    });
    if ((index & 127) === 127) {
      await new Promise<void>((resolve) => setTimeout(resolve, 0));
      checkCancelled();
    }
  }
  const titles: string[] = [];
  const titleBytes: Uint8Array[] = [];
  if (names) {
    check(names.size >= 4 + count * 4, 'INVALID_AUDIO', 'RXWS FTXT table');
    check(
      new Bin(await readAudio(source, names.start, 4)).u32(0) === count,
      'INVALID_AUDIO',
      'RXWS FTXT count',
    );
    let characters = 0;
    for (let index = 0; index < count; index++) {
      checkCancelled();
      const offset = new Bin(
        await readAudio(source, names.start + 4 + index * 4, 4),
      ).u32(0);
      check(
        offset >= 4 + count * 4 && offset < names.size,
        'INVALID_AUDIO',
        'RXWS name offset',
      );
      const bytes = await readAudio(
        source,
        names.start + offset,
        Math.min(4096, names.size - offset),
      );
      const end = bytes.indexOf(0);
      check(end >= 0, 'INVALID_AUDIO', 'Unterminated RXWS name');
      characters += end;
      check(characters <= 16 * 1024 ** 2, 'TOO_LARGE', 'RXWS names');
      titles.push(new TextDecoder().decode(bytes.subarray(0, end)));
      titleBytes.push(bytes.slice(0, end));
      if ((index & 127) === 127) {
        await new Promise<void>((resolve) => setTimeout(resolve, 0));
        checkCancelled();
      }
    }
  }
  const split = !data;
  check(data || body, 'RXWS_COMPANION', 'Matching RXWS body is missing');
  const content = data ? source : body;
  check(content, 'RXWS_COMPANION');
  validateSource(content);
  const bodyStart = data?.start ?? 0;
  const bodySize = data?.size ?? content.size;
  const tracks: RxwsTrack[] = [];
  const diagnostics: Diagnostic[] = [];
  for (const record of records) {
    checkCancelled();
    const nextOffset = records[record.index + 1]?.offset ?? bodySize;
    check(
      record.offset < nextOffset && nextOffset <= bodySize,
      'INVALID_AUDIO',
      'RXWS stream extent',
    );
    check(
      record.channels >= 1 &&
        record.channels <= 8 &&
        record.sampleRate >= 1000 &&
        record.bytes > 0,
      'INVALID_AUDIO',
      'RXWS stream metadata',
    );
    if (record.type !== 0 && record.type !== 1) {
      diagnostics.push({
        code: 'CODEC',
        detail:
          'RXWS stream ' +
          (record.index + 1) +
          ': ' +
          (record.type === 2 ? 'ATRAC3' : 'codec ' + record.type),
      });
      continue;
    }
    const unit = record.type === 0 ? 16 : 2;
    const samples = record.type === 0 ? 28 : 1;
    const frameBytes = unit * record.channels;
    check(
      record.bytes <= nextOffset - record.offset &&
        record.bytes % frameBytes === 0 &&
        (record.loop < 0 ||
          (record.loop < record.bytes && record.loop % frameBytes === 0)),
      'INVALID_AUDIO',
      'RXWS stream size or loop',
    );
    const length = (record.bytes / frameBytes) * samples;
    const name =
      titles[record.index] ||
      'track_' + String(record.index + 1).padStart(5, '0');
    tracks.push({
      index: record.index,
      name,
      source: standaloneSource(
        content,
        bodyStart + record.offset,
        record,
        name,
        titleBytes[record.index]?.length ? titleBytes[record.index] : undefined,
        checkCancelled,
      ),
      format: 'RXWS',
      codec: record.type === 0 ? 'psx' : 'pcm16',
      sampleRate: record.sampleRate,
      channels: record.channels,
      length,
      loop: record.loop >= 0,
      loopStart: record.loop >= 0 ? (record.loop / frameBytes) * samples : 0,
      loopEnd: length,
    });
  }
  checkCancelled();
  return { tracks, diagnostics, split };
}

export function resolveRxwsBody(
  name: string,
  companions: CompanionFile[],
): ByteSource {
  const normalize = (name: string) =>
    name
      .replaceAll('\\', '/')
      .replace(/^(?:\.\/)+/, '')
      .toLowerCase();
  const wanted = normalize(name).replace(/\.[^./]+$/, '.xwb');
  const matches = companions.filter(
    (file) => normalize(sourceName(file)) === wanted,
  );
  check(
    matches.length === 1,
    'RXWS_COMPANION',
    matches.length ? 'Ambiguous RXWS body' : 'Matching RXWS body is missing',
  );
  return asSource(matches[0]);
}

function cachedAudio(
  source: ByteSource,
  checkCancelled: () => void,
): ByteSource {
  const pages = new Map<number, Uint8Array>();
  return {
    size: source.size,
    async read(offset, length) {
      checkCancelled();
      bounds(source.size, offset, length);
      check(length <= 65536, 'TOO_LARGE');
      const output = new Uint8Array(length);
      let written = 0;
      while (written < length) {
        const start = Math.floor((offset + written) / 65536) * 65536;
        let bytes = pages.get(start);
        if (!bytes) {
          bytes = await readAudio(
            source,
            start,
            Math.min(65536, source.size - start),
          );
          if (pages.size === 2) {
            const oldest = pages.keys().next().value;
            check(oldest !== undefined, 'INVALID_AUDIO');
            pages.delete(oldest);
          }
        } else pages.delete(start);
        pages.set(start, bytes);
        const within = offset + written - start;
        const count = Math.min(length - written, bytes.length - within);
        output.set(bytes.subarray(within, within + count), written);
        written += count;
        checkCancelled();
      }
      return output;
    },
  };
}

export async function createRxwsDecoder(
  source: ByteSource,
  options: DecoderOptions = {},
): Promise<AudioDecoder> {
  const checkCancelled = () => {
    if (
      options.signal?.aborted ||
      options.cancelled?.() ||
      options.isCancelled?.()
    )
      throw new FormatError('CANCELLED');
  };
  let bank: RxwsBank | null;
  try {
    bank = await readRxws(source, undefined, checkCancelled);
  } catch (error) {
    if (!(error instanceof FormatError) || error.code !== 'RXWS_COMPANION')
      throw error;
    bank = await readRxws(
      source,
      resolveRxwsBody(options.name || '', options.companions || []),
      checkCancelled,
    );
  }
  check(bank, 'FORMAT', 'RXWS');
  const index = options.song ?? bank.tracks[0]?.index;
  check(
    Number.isSafeInteger(index) && index !== undefined && index >= 0,
    'CODEC',
    'RXWS stream',
  );
  const track = bank.tracks.find((item) => item.index === index);
  check(track, 'CODEC', 'Unsupported RXWS stream ' + (index + 1));
  const standalone = cachedAudio(track.source, checkCancelled);
  const unitBytes = track.codec === 'psx' ? 16 : 2;
  const channelBytes =
    (track.length / (track.codec === 'psx' ? 28 : 1)) * unitBytes;
  const start = standalone.size - channelBytes * track.channels;
  const readers: ChannelReader[] = [];
  for (let channel = 0; channel < track.channels; channel++)
    readers.push(
      encodedChannel(
        interleavedAudio(
          standalone,
          start,
          channel,
          track.channels,
          unitBytes,
          channelBytes,
        ),
        track.codec,
        track.length,
        {},
        true,
      ),
    );
  const decoder = channelDecoder(track, readers);
  const read = decoder.read.bind(decoder);
  decoder.read = async (frames) => {
    checkCancelled();
    const block = await read(frames);
    checkCancelled();
    return block;
  };
  return decoder;
}
