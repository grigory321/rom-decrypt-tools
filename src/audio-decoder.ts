import type {
  AudioDecoder,
  DecoderOptions,
  LibraryTrack,
} from './contracts.js';
import { arraySource, check } from './binary.js';
import { sourceAudioFormats } from './audio-formats.js';

export async function createTrackDecoder(
  track: LibraryTrack,
  sampleRate = 32768,
  options: Pick<DecoderOptions, 'cancelled'> = {},
): Promise<AudioDecoder> {
  if (track.kind === 'sequence' && track.sequence) {
    const { createEngine } = await import('./engine.js');
    return createEngine(track, sampleRate);
  }
  const source = track.raw ? arraySource(track.raw) : track.asset.source;
  if (track.asset?.gameAudio || sourceAudioFormats.has(track.format)) {
    const { createGameDecoder } = await import('./game-audio.js');
    return createGameDecoder(
      source,
      track.format === 'RSTM' ? 'BRSTM' : track.format,
      {
        ...options,
        sampleRate,
        song: track.asset?.song,
        psf: track.asset?.psf,
        name: track.asset?.name,
        inputEvents: track.asset?.inputEvents,
        m4a: track.asset?.m4a,
        sony: track.asset?.sony,
        cseq: track.asset?.cseq,
        heartbeat: track.asset?.heartbeat,
        xaFile: track.asset?.xaFile,
        xaChannel: track.asset?.xaChannel,
        xaCoding: track.asset?.xaCoding,
        xaFrames: track.asset?.xaFrames,
      },
    );
  }
  check(source.size <= 128 * 1024 ** 2, 'TOO_LARGE');
  const { createStreamDecoder } = await import('./stream.js');
  return createStreamDecoder(track.raw || (await source.read(0, source.size)));
}
