import type { TrackMetadata } from './contracts.js';

const programFormats = new Set([
  'HEARTBEAT',
  'CSEQ',
  'SPC',
  'GB',
  'GBC',
  'GBS',
  'GBA',
  'PSF',
  'PSF2',
  'SEQ',
  'SEP',
]);
const traversalFormats = new Set(['XA', 'XA2336']);

export function isProgramAudio(format: string): boolean {
  return programFormats.has(format.toUpperCase());
}

export function needsExportDuration(
  track: Pick<TrackMetadata, 'kind' | 'format' | 'audio'>,
): boolean {
  const traversal = traversalFormats.has(track.format.toUpperCase());
  const length = track.audio?.length;
  if (
    traversal &&
    typeof length === 'number' &&
    Number.isFinite(length) &&
    length > 0
  )
    return false;
  return track.kind === 'sequence' || isProgramAudio(track.format) || traversal;
}
