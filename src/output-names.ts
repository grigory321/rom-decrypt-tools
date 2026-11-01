import type { TrackMetadata } from './contracts.js';
import type { AudioExportFormat } from './rpc-types.js';

export function safeFilename(name: string): string {
  return name.replace(/[<>:"/\\|?*\x00-\x1f]/g, '_').slice(0, 180) || 'audio';
}

export function originalAudioExtension(
  name: string,
  format: string,
  preserveName: boolean,
): string {
  return (
    (preserveName && name.match(/\.([^.\/]+)$/)?.[1]) || format.toLowerCase()
  );
}

export function audioOutputName(
  track: Pick<TrackMetadata, 'name' | 'format' | 'sourceArchive'>,
  format: AudioExportFormat,
): string {
  const extension =
    format === 'original'
      ? originalAudioExtension(track.name, track.format, !track.sourceArchive)
      : format;
  return safeFilename(track.name.replace(/\.[^.]+$/, '')) + '.' + extension;
}
