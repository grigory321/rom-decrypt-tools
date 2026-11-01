import type { AudioMetadata, TrackMetadata } from './contracts.js';

export type AudioCategory = 'bgm' | 'sfx' | 'sample' | 'audio';

export type AudioCategoryTrack = Pick<
  TrackMetadata,
  'name' | 'format' | 'kind'
> & {
  audio?: Pick<AudioMetadata, 'sampleRate' | 'channels' | 'length' | 'loop'>;
};

export function classifyAudio(track: AudioCategoryTrack): AudioCategory {
  if (track.kind === 'sample') return 'sample';
  const format = track.format.toUpperCase();
  if (format === 'SSAR') return 'sfx';
  const name = track.name.slice(
    Math.max(track.name.lastIndexOf('/'), track.name.lastIndexOf('\\')) + 1,
  );
  if (/(?:^|[^a-z])(?:sfx|effects?|voices?)(?=$|[^a-z])/i.test(name))
    return 'sfx';
  if (/^(?:SEQ_)?(?:SE|VO)_/i.test(name)) return 'sfx';
  if (/(?:^|[_\s-])SE(?:$|[_\s.-])/i.test(name)) return 'sfx';
  if (/(?:^|[^a-z])(?:bgm|music|theme)(?=$|[^a-z])/i.test(name)) return 'bgm';
  if (track.audio?.loop) return 'bgm';
  const audio = track.audio;
  if (
    !audio ||
    audio.length === null ||
    !Number.isFinite(audio.length) ||
    !Number.isFinite(audio.sampleRate) ||
    audio.length <= 0 ||
    audio.sampleRate <= 0
  )
    return 'audio';
  const duration = audio.length / audio.sampleRate;
  if (!Number.isFinite(duration) || duration <= 0) return 'audio';
  if (duration <= 12) return 'sfx';
  if (duration >= 30) return 'bgm';
  return 'audio';
}

export function orderAudioTracks<T extends AudioCategoryTrack>(
  tracks: readonly T[],
): T[] {
  const order = { bgm: 0, audio: 1, sfx: 2, sample: 3 };
  return tracks
    .map((track) => {
      const audio = track.audio;
      const duration =
        audio && audio.length !== null && audio.sampleRate > 0
          ? audio.length / audio.sampleRate
          : 0;
      return {
        track,
        rank: order[classifyAudio(track)],
        duration: Number.isFinite(duration) ? duration : 0,
      };
    })
    .sort(
      (a, b) => a.rank - b.rank || (a.rank === 0 ? b.duration - a.duration : 0),
    )
    .map(({ track }) => track);
}
