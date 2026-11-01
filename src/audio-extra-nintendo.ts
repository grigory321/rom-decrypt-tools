import type { AudioDecoder, ByteSource } from './contracts.js';
import type { ChannelReader, FiniteAudioMetadata } from './audio-types.js';
import { Bin, bounds, check } from './binary.js';
import {
  readAudio,
  contiguousAudio,
  interleavedAudio,
  encodedChannel,
  encodedSize,
  channelDecoder,
} from './audio-codecs.js';

export async function createBwavDecoder(
  source: ByteSource,
): Promise<AudioDecoder> {
  const header = new Bin(await readAudio(source, 0, 16));
  check(
    header.str(0, 4) === 'BWAV' &&
      header.u16(4) === 0xfeff &&
      [1, 0x100].includes(header.u16(6)),
    'INVALID_AUDIO',
  );
  check(header.u16(12) === 0, 'CODEC', 'BWAV prefetch');
  const channels = header.u16(14);
  check(channels >= 1 && channels <= 8, 'INVALID_AUDIO');
  const tableEnd = 16 + channels * 76;
  bounds(source.size, 0, tableEnd);
  const readers: ChannelReader[] = [],
    ranges: { start: number; end: number }[] = [];
  let metadata: FiniteAudioMetadata | undefined, encoding: number | undefined;
  for (let channel = 0; channel < channels; channel++) {
    const info = new Bin(await readAudio(source, 16 + channel * 76, 76));
    const codec = info.u16(0);
    check(codec <= 1, 'CODEC', 'BWAV codec ' + codec);
    const current = {
      channels,
      sampleRate: info.u32(4),
      length: info.u32(12),
      loop: info.u32(60) !== 0xffffffff,
      loopEnd: info.u32(60) === 0xffffffff ? info.u32(12) : info.u32(60),
      loopStart: info.u32(64),
    };
    check(current.length > 0 && current.length <= info.u32(8), 'INVALID_AUDIO');
    if (metadata)
      check(
        codec === encoding &&
          (
            [
              'channels',
              'sampleRate',
              'length',
              'loop',
              'loopEnd',
              'loopStart',
            ] as const
          ).every((key) => current[key] === metadata?.[key]),
        'INVALID_AUDIO',
        'BWAV channel metadata',
      );
    else {
      metadata = current;
      encoding = codec;
    }
    const start = info.u32(52);
    const size = encodedSize(codec ? 'dsp' : 'pcm16', metadata.length);
    check(
      start >= tableEnd &&
        ranges.every(
          (range) => start >= range.end || start + size <= range.start,
        ),
      'INVALID_AUDIO',
    );
    bounds(source.size, start, size);
    ranges.push({ start, end: start + size });
    readers.push(
      encodedChannel(
        contiguousAudio(source, start, size),
        codec ? 'dsp' : 'pcm16',
        metadata.length,
        {
          coefs: Array.from({ length: 16 }, (_, index) =>
            info.i16(16 + index * 2),
          ),
          h1: info.i16(70),
          h2: info.i16(72),
        },
        true,
      ),
    );
  }
  check(metadata, 'INVALID_AUDIO');
  return channelDecoder(metadata, readers);
}

const nibbleSamples = (nibbles: number) =>
  Math.floor(nibbles / 16) * 14 + Math.max(0, (nibbles % 16) - 2);

export async function createIdspDecoder(
  source: ByteSource,
): Promise<AudioDecoder> {
  const header = new Bin(await readAudio(source, 0, 48));
  check(header.str(0, 4) === 'IDSP', 'INVALID_AUDIO');
  check(header.u32(4, false) === 0, 'CODEC', 'IDSP variant');
  const channels = header.u32(8, false);
  check(channels >= 1 && channels <= 8, 'INVALID_AUDIO');
  const metadata: FiniteAudioMetadata = {
    channels,
    sampleRate: header.u32(12, false),
    length: header.u32(16, false),
    loop: false,
  };
  check(metadata.length > 0, 'INVALID_AUDIO');
  const offset = header.u32(32, false),
    spacing = header.u32(36, false),
    start = header.u32(40, false),
    channelSize = header.u32(44, false);
  const block = header.u32(28, false) || channelSize;
  check(
    offset >= 48 &&
      spacing >= 96 &&
      start >= offset + spacing * (channels - 1) + 96 &&
      block > 0 &&
      block % 8 === 0 &&
      channelSize > 0 &&
      channelSize % block === 0,
    'INVALID_AUDIO',
  );
  bounds(source.size, start, channelSize * channels);
  const readers: ChannelReader[] = [];
  for (let channel = 0; channel < channels; channel++) {
    const info = new Bin(
      await readAudio(source, offset + channel * spacing, 96),
    );
    const nibbles = info.u32(4, false);
    check(
      info.u32(0, false) === metadata.length &&
        info.u32(8, false) === metadata.sampleRate &&
        info.u16(12, false) <= 1 &&
        info.u16(14, false) === 0 &&
        info.u16(60, false) === 0 &&
        nibbleSamples(nibbles) >= metadata.length &&
        nibbleSamples(nibbles) <= metadata.length + 13 &&
        Math.ceil(nibbles / 2) <= channelSize,
      'INVALID_AUDIO',
    );
    const loop = !!info.u16(12, false);
    const loopStart = nibbleSamples(info.u32(16, false));
    const loopEnd = Math.min(
      metadata.length,
      nibbleSamples(info.u32(20, false) + 1),
    );
    if (channel)
      check(
        loop === metadata.loop &&
          (!loop ||
            (loopStart === metadata.loopStart && loopEnd === metadata.loopEnd)),
        'INVALID_AUDIO',
      );
    else Object.assign(metadata, { loop, loopStart, loopEnd });
    const raw = interleavedAudio(
      source,
      start,
      channel,
      channels,
      block,
      Math.ceil(nibbles / 2),
      block,
    );
    readers.push(
      encodedChannel(raw, 'dsp', metadata.length, {
        coefs: Array.from({ length: 16 }, (_, index) =>
          info.i16(28 + index * 2, false),
        ),
        h1: info.i16(64, false),
        h2: info.i16(66, false),
      }),
    );
  }
  check(metadata, 'INVALID_AUDIO');
  return channelDecoder(metadata, readers);
}
