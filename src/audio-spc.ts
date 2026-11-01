import type { AudioDecoder, ByteSource, DecoderOptions } from './contracts.js';
import { Bin, check } from './binary.js';
import { readAudio, audioDecoder } from './audio-codecs.js';
import { SPCPlayer } from './vendor/spc700-js/player.js';

export async function createSpcDecoder(
  source: ByteSource,
  options: DecoderOptions = {},
): Promise<AudioDecoder> {
  check(source.size >= 0x10180, 'INVALID_AUDIO');
  let size = Math.min(source.size, 0x10200);
  if (source.size >= 0x10208) {
    const extension = new Bin(await readAudio(source, 0x10200, 8));
    if (extension.str(0, 4) === 'xid6') {
      const extra = extension.u32(4);
      check(
        extra <= 1024 * 1024 && extra <= source.size - 0x10208,
        'INVALID_AUDIO',
      );
      size = 0x10208 + extra;
    }
  }
  const snapshot = new Uint8Array(size);
  for (let offset = 0; offset < size; offset += 65536)
    snapshot.set(
      await readAudio(source, offset, Math.min(65536, size - offset)),
      offset,
    );
  const player = new SPCPlayer({
    sampleRate: 32000,
    defaultPlaySeconds: Infinity,
    defaultFadeSeconds: 0,
    clearEchoBuffer: options.clearEchoBuffer ?? true,
    resumeVoices: options.resumeVoices ?? false,
  });
  player.load(snapshot);
  const tags = player.tags;
  const length = Number.isFinite(player.totalSeconds)
    ? Math.round(player.totalSeconds * 32000)
    : null;
  const introSeconds = tags.introSeconds;
  const loopSeconds = tags.loopSeconds;
  const loop =
    typeof introSeconds === 'number' &&
    typeof loopSeconds === 'number' &&
    Number.isFinite(introSeconds) &&
    Number.isFinite(loopSeconds) &&
    loopSeconds > 0;
  const metadata = {
    channels: 2,
    sampleRate: 32000,
    length,
    loop,
    loopStart: loop ? Math.round(introSeconds * 32000) : 0,
    loopEnd: loop ? Math.round((introSeconds + loopSeconds) * 32000) : length,
    tags,
  };
  return audioDecoder(
    metadata,
    async (count) => {
      const { left, right } = player.render(count);
      return [
        Float32Array.from(left, (value) => value / 32768),
        Float32Array.from(right, (value) => value / 32768),
      ];
    },
    () => player.load(snapshot),
  );
}
