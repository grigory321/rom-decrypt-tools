import type { AudioDecoder, ByteSource } from './contracts.js';
import type {
  ChannelReader,
  EncodedCodec,
  FiniteAudioMetadata,
  InitialChannelState,
} from './audio-types.js';
import { Bin, check, bounds } from './binary.js';
import {
  readAudio,
  contiguousAudio,
  interleavedAudio,
  encodedChannel,
  encodedSize,
  channelDecoder,
} from './audio-codecs.js';

const nibbleSamples = (nibbles: number) =>
  Math.floor(nibbles / 16) * 14 + Math.max(0, (nibbles % 16) - 2);
const codecName = (value: number): EncodedCodec => {
  check(value >= 0 && value <= 3, 'CODEC', String(value));
  const codecs: EncodedCodec[] = ['pcm8', 'pcm16', 'dsp', 'ima'];
  return codecs[value];
};
const readBin = async (source: ByteSource, offset: number, length: number) =>
  new Bin(await readAudio(source, offset, length));

async function dspState(
  source: ByteSource,
  offset: number,
  littleEndian: boolean,
  gain = false,
) {
  const bytes = await readBin(source, offset, gain ? 48 : 46);
  return {
    coefs: Array.from({ length: 16 }, (_, index) =>
      bytes.i16(index * 2, littleEndian),
    ),
    h1: bytes.i16(gain ? 36 : 34, littleEndian),
    h2: bytes.i16(gain ? 38 : 36, littleEndian),
  };
}

export async function createDspDecoder(
  source: ByteSource,
): Promise<AudioDecoder> {
  const header = await readBin(source, 0, 96),
    length = header.u32(0, false),
    nibbles = header.u32(4, false);
  check(
    header.u16(14, false) === 0 &&
      header.u16(12, false) <= 1 &&
      length > 0 &&
      nibbleSamples(nibbles) >= length &&
      nibbleSamples(nibbles) <= length + 13,
    'INVALID_AUDIO',
  );
  const metadata = {
    channels: 1,
    sampleRate: header.u32(8, false),
    length,
    loop: !!header.u16(12, false),
    loopStart: nibbleSamples(header.u32(16, false)),
    loopEnd: Math.min(length, nibbleSamples(header.u32(20, false) + 1)),
  };
  const initial = {
    coefs: Array.from({ length: 16 }, (_, index) =>
      header.i16(28 + index * 2, false),
    ),
    h1: header.i16(64, false),
    h2: header.i16(66, false),
  };
  const raw = contiguousAudio(source, 96, Math.ceil(nibbles / 2));
  return channelDecoder(metadata, [
    encodedChannel(raw, 'dsp', length, initial),
  ]);
}

export async function createBrstmDecoder(
  source: ByteSource,
): Promise<AudioDecoder> {
  const header = await readBin(source, 0, 64);
  check(
    header.str(0, 4) === 'RSTM' && header.u16(4, false) === 0xfeff,
    'INVALID_AUDIO',
  );
  const version = header.u16(6, false),
    headOffset = version === 1 ? header.u16(12, false) : header.u32(16, false),
    head = await readBin(source, headOffset, 32);
  check(head.str(0, 4) === 'HEAD', 'INVALID_AUDIO');
  const infoOffset =
      version === 1 ? headOffset + 8 : headOffset + 8 + head.u32(12, false),
    info = await readBin(source, infoOffset, 52),
    codec = codecName(info.u8(0));
  check(codec !== 'ima', 'CODEC', codec);
  const metadata = {
    channels: info.u8(2),
    sampleRate: info.u16(4, false),
    length: info.u32(12, false),
    loop: !!info.u8(1),
    loopStart: info.u32(8, false),
    loopEnd: info.u32(12, false),
  };
  check(metadata.channels >= 1 && metadata.channels <= 8, 'INVALID_AUDIO');
  const start = info.u32(16, false),
    blocks = info.u32(20, false),
    blockSize = info.u32(24, false),
    blockSamples = info.u32(28, false),
    lastBytes = info.u32(32, false),
    lastSamples = info.u32(36, false),
    lastStride = info.u32(40, false);
  check(
    blocks > 0 &&
      blockSize > 0 &&
      blockSize <= 16 * 1024 * 1024 &&
      lastBytes > 0 &&
      lastBytes <= blockSize &&
      lastStride >= lastBytes &&
      (blocks - 1) * blockSamples + lastSamples === metadata.length,
    'INVALID_AUDIO',
  );
  check(
    blocks === 1 || blockSize >= encodedSize(codec, blockSamples),
    'INVALID_AUDIO',
  );
  check(
    lastBytes >=
      Math.ceil(lastSamples / (codec === 'dsp' ? 14 : 1)) *
        (codec === 'dsp' ? 8 : codec === 'pcm16' ? 2 : 1),
    'INVALID_AUDIO',
  );
  bounds(
    source.size,
    start,
    (blocks - 1) * blockSize * metadata.channels +
      lastStride * (metadata.channels - 1) +
      lastBytes,
  );
  const readers: ChannelReader[] = [];
  let table: Bin | undefined;
  if (codec === 'dsp' && version !== 1)
    table = await readBin(
      source,
      headOffset + 8 + head.u32(28, false),
      4 + metadata.channels * 8,
    );
  for (let channel = 0; channel < metadata.channels; channel++) {
    let initial: InitialChannelState = {};
    if (codec === 'dsp') {
      let offset: number;
      if (version === 1) offset = headOffset + 0x38 + channel * 48;
      else {
        check(table, 'INVALID_AUDIO');
        offset = headOffset + 8 + table.u32(8 + channel * 8, false) + 8;
      }
      initial = await dspState(source, offset, false, true);
    }
    const raw = interleavedAudio(
      source,
      start,
      channel,
      metadata.channels,
      blockSize,
      (blocks - 1) * blockSize + lastBytes,
      lastStride,
    );
    readers.push(encodedChannel(raw, codec, metadata.length, initial));
  }
  return channelDecoder(metadata, readers);
}

export async function createRwavDecoder(
  source: ByteSource,
): Promise<AudioDecoder> {
  const header = await readBin(source, 0, 32);
  check(
    header.str(0, 4) === 'RWAV' && header.u16(4, false) === 0xfeff,
    'INVALID_AUDIO',
  );
  const infoOffset = header.u32(16, false),
    dataOffset = header.u32(24, false),
    section = await readBin(source, infoOffset, 36),
    data = await readBin(source, dataOffset, 8);
  check(
    section.str(0, 4) === 'INFO' && data.str(0, 4) === 'DATA',
    'INVALID_AUDIO',
  );
  const waveOffset = infoOffset + 8,
    info = new Bin(section.b.subarray(8)),
    codec = codecName(info.u8(0));
  check(codec !== 'ima' && info.u8(6) === 0, 'CODEC', 'RWAV data location');
  const samples = (value: number) =>
    codec === 'dsp' ? nibbleSamples(value) : value;
  const metadata = {
    channels: info.u8(2),
    sampleRate: info.u8(3) * 65536 + info.u16(4, false),
    length: samples(info.u32(12, false)),
    loop: !!info.u8(1),
    loopStart: samples(info.u32(8, false)),
    loopEnd: samples(info.u32(12, false)),
  };
  check(metadata.channels >= 1 && metadata.channels <= 8, 'INVALID_AUDIO');
  const table = await readBin(
      source,
      waveOffset + info.u32(16, false),
      metadata.channels * 4,
    ),
    readers: ChannelReader[] = [];
  for (let channel = 0; channel < metadata.channels; channel++) {
    const definition = await readBin(
      source,
      waveOffset + table.u32(channel * 4, false),
      8,
    );
    const initial =
      codec === 'dsp'
        ? await dspState(
            source,
            waveOffset + definition.u32(4, false),
            false,
            true,
          )
        : {};
    const raw = contiguousAudio(
      source,
      dataOffset + 8 + info.u32(20, false) + definition.u32(0, false),
      encodedSize(codec, metadata.length),
    );
    readers.push(encodedChannel(raw, codec, metadata.length, initial));
  }
  return channelDecoder(metadata, readers);
}

export async function createNintendoDecoder(
  source: ByteSource,
): Promise<AudioDecoder> {
  const header = await readBin(source, 0, 64),
    magic = header.str(0, 4),
    littleEndian = header.u16(4) === 0xfeff;
  check(
    ['CWAV', 'FWAV', 'CSTM', 'FSTM'].includes(magic) &&
      (header.u16(4) === 0xfeff || header.u16(4) === 0xfffe),
    'FORMAT',
    magic,
  );
  const sectionCount = header.u16(16, littleEndian);
  check(sectionCount >= 2 && sectionCount <= 16, 'INVALID_AUDIO');
  const sectionTable = await readBin(source, 20, sectionCount * 12),
    sections: Partial<Record<string, number>> = {};
  for (let index = 0; index < sectionCount; index++) {
    const offset = sectionTable.u32(index * 12 + 4, littleEndian),
      tag = await readBin(source, offset, 8);
    sections[tag.str(0, 4)] = offset;
  }
  check(
    sections.INFO !== undefined && sections.DATA !== undefined,
    'INVALID_AUDIO',
  );
  const infoOffset = sections.INFO,
    dataOffset = sections.DATA,
    info = await readBin(source, infoOffset, 40),
    wave = magic.endsWith('WAV');
  let metadata: FiniteAudioMetadata,
    codec: EncodedCodec,
    tableOffset: number,
    layout:
      | { start: number; blockSize: number; size: number; lastStride: number }
      | undefined;
  if (wave) {
    codec = codecName(info.u8(8));
    metadata = {
      channels: 0,
      sampleRate: info.u32(12, littleEndian),
      length: info.u32(20, littleEndian),
      loop: !!info.u8(9),
      loopStart: info.u32(16, littleEndian),
      loopEnd: info.u32(20, littleEndian),
    };
    tableOffset = infoOffset + 28;
  } else {
    const p = infoOffset + 8 + info.u32(12, littleEndian),
      stream = await readBin(source, p, 56);
    codec = codecName(stream.u8(0));
    metadata = {
      channels: stream.u8(2),
      sampleRate: stream.u32(4, littleEndian),
      length: stream.u32(12, littleEndian),
      loop: !!stream.u8(1),
      loopStart: stream.u32(8, littleEndian),
      loopEnd: stream.u32(12, littleEndian),
    };
    tableOffset = infoOffset + 8 + info.u32(28, littleEndian);
    const blocks = stream.u32(16, littleEndian),
      blockSize = stream.u32(20, littleEndian),
      blockSamples = stream.u32(24, littleEndian),
      lastBytes = stream.u32(28, littleEndian),
      lastSamples = stream.u32(32, littleEndian),
      lastStride = stream.u32(36, littleEndian),
      start = dataOffset + 8 + stream.u32(52, littleEndian),
      finalSamples = metadata.length - (blocks - 1) * blockSamples;
    const capacity = (bytes: number) =>
      codec === 'dsp'
        ? nibbleSamples(bytes * 2)
        : codec === 'pcm16'
          ? Math.floor(bytes / 2)
          : codec === 'pcm8'
            ? bytes
            : bytes * 2;
    check(
      blocks > 0 &&
        blockSize > 0 &&
        blockSize <= 16 * 1024 * 1024 &&
        lastBytes > 0 &&
        lastBytes <= blockSize &&
        lastStride >= lastBytes &&
        (finalSamples === lastSamples ||
          ((codec !== 'dsp' || blockSize % 8 === 0) &&
            (codec !== 'pcm16' || blockSize % 2 === 0) &&
            blockSamples === capacity(blockSize) &&
            finalSamples > 0 &&
            finalSamples <= capacity(lastBytes))),
      'INVALID_AUDIO',
    );
    layout = {
      start,
      blockSize,
      size: (blocks - 1) * blockSize + lastBytes,
      lastStride,
    };
  }
  const count = (await readBin(source, tableOffset, 4)).u32(0, littleEndian);
  if (wave) metadata.channels = count;
  check(
    metadata.channels >= 1 &&
      metadata.channels <= 8 &&
      count === metadata.channels,
    'INVALID_AUDIO',
  );
  const table = await readBin(source, tableOffset, 4 + count * 8),
    readers: ChannelReader[] = [];
  for (let channel = 0; channel < count; channel++) {
    const definitionOffset =
        tableOffset + table.u32(8 + channel * 8, littleEndian),
      definition = await readBin(source, definitionOffset, wave ? 16 : 8);
    const stateOffset =
      definitionOffset + definition.u32(wave ? 12 : 4, littleEndian);
    let initial: InitialChannelState = {};
    if (codec === 'dsp')
      initial = await dspState(source, stateOffset, littleEndian);
    if (codec === 'ima') {
      const state = await readBin(source, stateOffset, 4);
      initial = {
        h1: state.i16(0, littleEndian),
        index: state.u16(2, littleEndian),
      };
    }
    let raw: ByteSource;
    if (wave)
      raw = contiguousAudio(
        source,
        dataOffset + 8 + definition.u32(4, littleEndian),
        encodedSize(codec, metadata.length),
      );
    else {
      check(layout, 'INVALID_AUDIO');
      raw = interleavedAudio(
        source,
        layout.start,
        channel,
        count,
        layout.blockSize,
        layout.size,
        layout.lastStride,
      );
    }
    readers.push(
      encodedChannel(raw, codec, metadata.length, initial, littleEndian),
    );
  }
  return channelDecoder(metadata, readers);
}
