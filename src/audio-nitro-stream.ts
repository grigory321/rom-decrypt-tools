import type { AudioDecoder, ByteSource } from './contracts.js';
import type {
  ChannelReader,
  EncodedCodec,
  InitialChannelState,
} from './audio-types.js';
import { align, Bin, bounds, check } from './binary.js';
import {
  channelDecoder,
  contiguousAudio,
  encodedChannel,
  readAudio,
} from './audio-codecs.js';

const codecs: EncodedCodec[] = ['pcm8', 'pcm16', 'ima'];

export async function createNitroStreamDecoder(
  source: ByteSource,
  format?: string,
): Promise<AudioDecoder> {
  const header = new Bin(await readAudio(source, 0, Math.min(64, source.size))),
    magic = header.str(0, 4);
  check(
    ['SWAV', 'STRM'].includes(magic) && (!format || format === magic),
    'FORMAT',
    magic,
  );
  if (magic === 'SWAV') {
    const codec = header.u8(24),
      size = (header.u16(30) + header.u32(32)) * 4,
      length = codec === 0 ? size : codec === 1 ? size / 2 : (size - 4) * 2,
      loopStart = Math.max(
        0,
        header.u16(30) * (codec === 0 ? 4 : codec === 1 ? 2 : 8) -
          (codec === 2 ? 8 : 0),
      );
    check(codec <= 2, 'CODEC', String(codec));
    check(length > 0 && loopStart <= length, 'INVALID_AUDIO');
    bounds(source.size, 36, size);
    const initial: InitialChannelState = {};
    if (codec === 2) {
      initial.h1 = header.i16(36);
      initial.index = header.u8(38);
    }
    return channelDecoder(
      {
        sampleRate: header.u16(26),
        channels: 1,
        length,
        loop: !!header.u8(25),
        loopStart,
        loopEnd: length,
      },
      [
        encodedChannel(
          contiguousAudio(
            source,
            codec === 2 ? 40 : 36,
            size - (codec === 2 ? 4 : 0),
          ),
          codecs[codec],
          length,
          initial,
          true,
        ),
      ],
    );
  }
  const codec = header.u8(24),
    channels = header.u8(26),
    length = header.u32(36),
    start = header.u32(40),
    blocks = header.u32(44),
    blockSize = header.u32(48),
    blockSamples = header.u32(52),
    lastSize = header.u32(56) + (blocks === 1 && codec === 2 ? 4 : 0),
    lastSamples = header.u32(60);
  check(
    codec <= 2 &&
      channels >= 1 &&
      channels <= 8 &&
      length > 0 &&
      blocks > 0 &&
      blocks <= 100000 &&
      lastSamples > 0 &&
      (blocks === 1 || blockSamples > 0) &&
      (blocks - 1) * blockSamples + lastSamples === length &&
      start >= 64,
    'INVALID_AUDIO',
  );
  const needed = (samples: number) =>
      codec === 0
        ? samples
        : codec === 1
          ? samples * 2
          : 4 + Math.ceil(samples / 2),
    validSize = (size: number, samples: number) =>
      size >= needed(samples) &&
      size <= needed(samples) + 3 &&
      size <= 4 * 1024 ** 2;
  check(
    validSize(lastSize, lastSamples) &&
      (blocks === 1 || validSize(blockSize, blockSamples)),
    'INVALID_AUDIO',
  );
  const firstEnd = align(start + blockSize * channels, 4),
    stride = align(blockSize * channels, 4),
    blockOffset = (block: number) =>
      block === 0 ? start : firstEnd + (block - 1) * stride;
  bounds(
    source.size,
    start,
    blockOffset(blocks - 1) + lastSize * channels - start,
  );
  const readers = Array.from({ length: channels }, (_, channel) => {
    let block = -1,
      remaining = 0,
      skip = 0,
      current: ChannelReader | null = null;
    async function begin() {
      block++;
      const size = block === blocks - 1 ? lastSize : blockSize,
        offset = blockOffset(block) + channel * size,
        initial: InitialChannelState = {};
      remaining = block === blocks - 1 ? lastSamples : blockSamples;
      if (codec === 2) {
        const state = new Bin(await readAudio(source, offset, 4));
        initial.h1 = state.i16(0);
        initial.index = state.u8(2);
      }
      current = encodedChannel(
        contiguousAudio(
          source,
          offset + (codec === 2 ? 4 : 0),
          size - (codec === 2 ? 4 : 0),
        ),
        codecs[codec],
        remaining,
        initial,
        true,
      );
      if (codec !== 2) {
        check(current.seek, 'INVALID_AUDIO');
        current.seek(skip);
      } else {
        let left = skip;
        while (left) {
          const count = Math.min(16384, left);
          await current.read(count);
          left -= count;
        }
      }
      remaining -= skip;
      skip = 0;
    }
    return {
      reset() {
        block = -1;
        remaining = 0;
        skip = 0;
        current = null;
      },
      seek(target: number) {
        const next =
          target < (blocks - 1) * blockSamples
            ? Math.floor(target / blockSamples)
            : blocks - 1;
        block = next - 1;
        remaining = 0;
        skip = target - next * blockSamples;
        current = null;
      },
      async read(frames: number) {
        if (!remaining) await begin();
        check(current, 'INVALID_AUDIO');
        if (frames <= remaining) {
          const output = await current.read(frames);
          remaining -= frames;
          return output;
        }
        const output = new Float32Array(frames);
        let written = 0;
        while (written < frames) {
          if (!remaining) await begin();
          check(current, 'INVALID_AUDIO');
          const count = Math.min(frames - written, remaining);
          output.set(await current.read(count), written);
          written += count;
          remaining -= count;
        }
        return output;
      },
    };
  });
  return channelDecoder(
    {
      sampleRate: header.u16(28),
      channels,
      length,
      loop: !!header.u8(25),
      loopStart: header.u32(32),
      loopEnd: length,
    },
    readers,
  );
}
