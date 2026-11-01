import type { ChannelReader } from './audio-types.js';
import type { AudioDecoder, ByteSource } from './contracts.js';
import { Bin, check, bounds } from './binary.js';
import {
  readAudio,
  contiguousAudio,
  interleavedAudio,
  encodedChannel,
  channelDecoder,
} from './audio-codecs.js';

export async function createVagDecoder(
  source: ByteSource,
): Promise<AudioDecoder> {
  const header = new Bin(await readAudio(source, 0, 48)),
    magic = header.str(0, 4),
    version = header.u32(4, false),
    size = header.u32(12, false);
  check(['VAGp', 'VAGi', 'VAG1', 'VAG2'].includes(magic), 'FORMAT', magic);
  let channels = 1,
    start = 48,
    interleave = 16,
    channelSize = size;
  if (magic === 'VAGi') {
    channels = 2;
    start = 2048;
    interleave = header.u32(8);
  } else if (magic === 'VAG2') {
    channels = 2;
    start = 64;
    interleave = 2048;
  } else if (magic === 'VAG1') {
    channels = header.u8(30) || 1;
    start = 64;
    if (size === source.size - start) channelSize /= channels;
  } else {
    check(
      [0, 2, 3, 4, 6, 0x20].includes(version) && header.u8(30) <= 1,
      'CODEC',
      'VAG variant',
    );
  }
  check(
    channels >= 1 &&
      channels <= 8 &&
      channelSize > 0 &&
      channelSize % 16 === 0 &&
      interleave > 0 &&
      interleave % 16 === 0,
    'INVALID_AUDIO',
  );
  bounds(source.size, start, channelSize * channels);
  const metadata = {
    channels,
    sampleRate: header.u32(16, false),
    length: (channelSize / 16) * 28,
    loop: false,
    loopStart: 0,
    loopEnd: (channelSize / 16) * 28,
  };
  let loopStart: number | null = null;
  const onFlag = (flag: number, sample: number) => {
    if (flag === 6 && loopStart === null) loopStart = sample;
    if (flag === 3 && loopStart !== null) {
      metadata.loop = true;
      metadata.loopStart = loopStart;
      metadata.loopEnd = sample + 28;
    }
  };
  const readers: ChannelReader[] = [];
  for (let channel = 0; channel < channels; channel++) {
    const raw =
      channels === 1
        ? contiguousAudio(source, start, channelSize)
        : interleavedAudio(
            source,
            start,
            channel,
            channels,
            interleave,
            channelSize,
          );
    readers.push(
      encodedChannel(
        raw,
        'psx',
        metadata.length,
        {},
        false,
        channel === 0 ? onFlag : undefined,
      ),
    );
  }
  return channelDecoder(metadata, readers);
}

export async function createSs2Decoder(
  source: ByteSource,
): Promise<AudioDecoder> {
  const header = new Bin(await readAudio(source, 0, 40));
  check(
    header.str(0, 4) === 'SShd' &&
      header.str(32, 4) === 'SSbd' &&
      [0x18, 0x20, source.size - 8].includes(header.u32(4)),
    'INVALID_AUDIO',
  );
  const codecId = header.u32(8),
    channels = header.u32(16),
    interleave = header.u32(20),
    bodySize = header.u32(36),
    start = source.size - bodySize >= 2048 ? 2048 : 40;
  check(
    channels >= 1 &&
      channels <= 8 &&
      bodySize > 0 &&
      bodySize % channels === 0 &&
      interleave > 0 &&
      interleave <= 16 * 1024 * 1024,
    'INVALID_AUDIO',
  );
  check(
    [0, 1, 0x80000001, 2, 0x10].includes(codecId),
    'CODEC',
    String(codecId),
  );
  const codec = codecId === 2 || codecId === 0x10 ? 'psx' : 'pcm16',
    unit = codec === 'psx' ? 16 : 2,
    samplesPerUnit = codec === 'psx' ? 28 : 1,
    channelSize = bodySize / channels;
  check(channelSize % unit === 0 && interleave % unit === 0, 'INVALID_AUDIO');
  bounds(source.size, start, bodySize);
  const length = (channelSize / unit) * samplesPerUnit;
  const loopAddress = header.u32(24),
    loopEndAddress = header.u32(28),
    loopByteStart = loopAddress * 16,
    loopByteEnd =
      loopEndAddress === 0xffffffff ? bodySize : loopEndAddress * 16;
  const loop =
    loopAddress !== 0xffffffff &&
    loopByteStart < loopByteEnd &&
    loopByteEnd <= bodySize;
  const metadata = {
    channels,
    sampleRate: header.u32(12),
    length,
    loop,
    loopStart: loop
      ? Math.floor(loopByteStart / channels / unit) * samplesPerUnit
      : 0,
    loopEnd: loop
      ? Math.floor(loopByteEnd / channels / unit) * samplesPerUnit
      : length,
  };
  const readers: ChannelReader[] = [];
  for (let channel = 0; channel < channels; channel++) {
    const raw = interleavedAudio(
      source,
      start,
      channel,
      channels,
      interleave,
      channelSize,
    );
    readers.push(encodedChannel(raw, codec, length, {}, codecId !== 0));
  }
  return channelDecoder(metadata, readers);
}
