import type {
  ByteSource,
  SourceInput,
  CompanionFile,
  ProgressReporter,
  Archive,
  ArchiveEntry,
} from './contracts.js';
import { sourceName } from './source-input.js';
import { bounds, check, sliceSource } from './binary.js';
import type { RawSectorSize } from './disc-sources.js';
import {
  audioTrackSource,
  discSource,
  rawSectorSource,
} from './disc-sources.js';
import { readIso9660 } from './disc-iso9660.js';

interface CueFile {
  name: string;
  type: string;
  tracks: CueTrack[];
}
interface CueTrack {
  number: number;
  mode: string;
  indices: { index: number; position: number }[];
  file: CueFile;
  PREGAP?: number;
  POSTGAP?: number;
}

function normalizedPath(value: string) {
  const path = value.replace(/\\/g, '/').replace(/^(\.\/)+/, '');
  check(
    path.length > 0 &&
      path.length <= 4096 &&
      !path.startsWith('/') &&
      !/[\x00-\x1f:]/.test(path) &&
      path.split('/').every((part) => part && part !== '.' && part !== '..'),
    'UNSAFE_CUE_PATH',
  );
  return path.toLowerCase();
}

export function discFileName(file: SourceInput) {
  return sourceName(file);
}

function resolveFile(
  name: string,
  cueName: string,
  companions: CompanionFile[],
) {
  const requested = normalizedPath(name);
  const parent = cueName.replace(/\\/g, '/').split('/').slice(0, -1).join('/');
  const relative = parent ? normalizedPath(parent + '/' + name) : requested;
  const candidates = companions.map((file) => ({
    file,
    name: normalizedPath(discFileName(file)),
  }));
  let found = candidates.filter((item) => item.name === relative);
  if (!found.length && requested !== relative) {
    found = candidates.filter((item) => item.name === requested);
  }
  if (!found.length) {
    const basename = requested.split('/').at(-1);
    found = candidates.filter(
      (item) => item.name.split('/').at(-1) === basename,
    );
  }
  check(
    found.length > 0,
    'MISSING_CUE_FILE',
    `Select the CUE companion file "${name}" with the cue sheet.`,
  );
  check(
    found.length === 1,
    'AMBIGUOUS_CUE_FILE',
    `More than one selected file matches the CUE reference "${name}".`,
  );
  return discSource(found[0].file);
}

function frames(value: string) {
  check(/^\d{2,3}:\d{2}:\d{2}$/.test(value), 'INVALID_CUE');
  const [minutes, seconds, frame] = value.split(':').map(Number);
  check(seconds < 60 && frame < 75, 'INVALID_CUE');
  return minutes * 4500 + seconds * 75 + frame;
}

export async function readCue(
  source: ByteSource,
  name: string,
  companions: CompanionFile[],
  report: ProgressReporter,
): Promise<Archive> {
  check(source.size > 0 && source.size <= 1024 * 1024, 'INVALID_CUE');
  const bytes = await source.read(0, source.size);
  let text: string;
  try {
    text = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  } catch {
    check(false, 'INVALID_CUE');
  }
  const files: CueFile[] = [];
  const tracks: CueTrack[] = [];
  let file: CueFile | undefined;
  let track: CueTrack | undefined;
  for (const original of text.replace(/^\ufeff/, '').split(/\r?\n/)) {
    const line = original.trim();
    if (
      !line ||
      /^(REM|TITLE|PERFORMER|SONGWRITER|COMPOSER|ARRANGER|MESSAGE|CATALOG|ISRC)\b/i.test(
        line,
      )
    ) {
      continue;
    }
    check(line.length <= 8192, 'INVALID_CUE');
    const command = line.match(/^(\S+)\s*(.*)$/);
    check(command, 'INVALID_CUE');
    const keyword = command[1].toUpperCase();
    const value = command[2];
    if (keyword === 'FILE') {
      const match = value.match(/^(?:"([^"]+)"|(\S+))\s+(\S+)$/);
      check(match, 'INVALID_CUE');
      const type = match[3].toUpperCase();
      check(
        type === 'BINARY' || type === 'MOTOROLA',
        'UNSUPPORTED_CUE_FILE_TYPE',
        'CUE extraction supports raw BINARY or MOTOROLA companion files.',
      );
      file = { name: match[1] || match[2], type, tracks: [] };
      files.push(file);
      track = undefined;
    } else if (keyword === 'TRACK') {
      const match = value.match(/^(\d{1,2})\s+(\S+)$/);
      check(
        file &&
          match &&
          Number(match[1]) === tracks.length + 1 &&
          tracks.length < 99,
        'INVALID_CUE',
      );
      const mode = match[2].toUpperCase();
      check(
        [
          'AUDIO',
          'MODE1/2048',
          'MODE1/2352',
          'MODE2/2352',
          'MODE2/2336',
        ].includes(mode),
        'UNSUPPORTED_CUE_TRACK',
        `The CUE track mode "${mode}" is not supported.`,
      );
      check(
        mode === 'AUDIO' || file.type === 'BINARY',
        'UNSUPPORTED_CUE_TRACK',
      );
      track = { number: tracks.length + 1, mode, indices: [], file };
      tracks.push(track);
      file.tracks.push(track);
    } else if (keyword === 'INDEX') {
      const match = value.match(/^(\d{1,2})\s+(\S+)$/);
      check(track && match, 'INVALID_CUE');
      const index = Number(match[1]);
      const position = frames(match[2]);
      const previous = track.indices.at(-1);
      check(
        (!previous && index <= 1) ||
          (previous && index > previous.index && position >= previous.position),
        'INVALID_CUE',
      );
      track.indices.push({ index, position });
    } else if (keyword === 'PREGAP' || keyword === 'POSTGAP') {
      check(track && track[keyword] === undefined, 'INVALID_CUE');
      track[keyword] = frames(value);
    } else if (keyword === 'FLAGS') {
      check(
        track &&
          value.split(/\s+/).every((flag) => flag.toUpperCase() === 'DCP'),
        'UNSUPPORTED_CUE_FLAGS',
        'Pre-emphasis and four-channel CUE audio require processing that is not supported.',
      );
    } else {
      check(
        false,
        'UNSUPPORTED_CUE_COMMAND',
        `The CUE command "${keyword}" is not supported.`,
      );
    }
  }
  check(
    tracks.length > 0 && files.every((item) => item.tracks.length > 0),
    'INVALID_CUE',
  );
  const dataTracks = tracks.filter((item) => item.mode !== 'AUDIO');
  check(
    dataTracks.length <= 1 &&
      (!dataTracks.length || dataTracks[0].number === 1),
    'UNSUPPORTED_CUE_LAYOUT',
    'Only a single first data track followed by audio tracks is supported.',
  );
  const entries: ArchiveEntry[] = [];
  for (const item of files) {
    const source = resolveFile(item.name, name, companions);
    const sectorSizes = new Set(
      item.tracks.map((part) =>
        part.mode === 'MODE1/2048'
          ? 2048
          : part.mode === 'MODE2/2336'
            ? 2336
            : 2352,
      ),
    );
    check(
      sectorSizes.size === 1,
      'UNSUPPORTED_CUE_LAYOUT',
      'Tracks sharing one file must have the same physical sector size.',
    );
    const sectorSize = [...sectorSizes][0];
    check(
      source.size % sectorSize === 0,
      'INVALID_CUE',
      'The CUE companion file ends in an incomplete sector.',
    );
    const sectorCount = source.size / sectorSize;
    for (let index = 0; index < item.tracks.length; index++) {
      const part = item.tracks[index];
      const own = part.indices.find((index) => index.index === 1);
      check(own, 'INVALID_CUE', 'Every CUE track requires INDEX 01.');
      const next = item.tracks[index + 1];
      const end = next ? next.indices[0]?.position : sectorCount;
      check(
        typeof end === 'number' &&
          Number.isSafeInteger(end) &&
          own.position < end &&
          end <= sectorCount &&
          part.indices.every((item) => item.position < end),
        'INVALID_CUE',
      );
      if (index === 0) {
        check(
          part.indices[0].position === 0,
          'UNSUPPORTED_CUE_LAYOUT',
          'The first track in each companion file must start at file sector zero.',
        );
      }
      const bytes = (end - own.position) * sectorSize;
      bounds(source.size, own.position * sectorSize, bytes);
      const content = sliceSource(source, own.position * sectorSize, bytes);
      const number = String(part.number).padStart(2, '0');
      if (part.mode === 'AUDIO') {
        const pregap = part.indices.find((item) => item.index === 0);
        if (pregap && pregap.position < own.position) {
          const audio = sliceSource(
            source,
            pregap.position * sectorSize,
            (own.position - pregap.position) * sectorSize,
          );
          const wav = audioTrackSource(audio, item.type === 'MOTOROLA');
          entries.push({
            path: `tracks/${number}-pregap.wav`,
            kind: 'audio',
            size: wav.size,
            source: wav,
          });
        }
        const wav = audioTrackSource(content, item.type === 'MOTOROLA');
        entries.push({
          path: `tracks/${number}.wav`,
          kind: 'audio',
          size: wav.size,
          source: wav,
        });
      } else {
        const rawSize: RawSectorSize = sectorSize === 2336 ? 2336 : 2352;
        const expectedMode = part.mode.startsWith('MODE1') ? 1 : 2;
        const logical =
          sectorSize === 2048
            ? content
            : rawSectorSource(content, expectedMode, rawSize);
        const archive = await readIso9660(
          logical,
          `tracks/${number}/iso/`,
          report,
          sectorSize === 2048
            ? undefined
            : { source: content, sectorSize: rawSize, expectedMode },
        );
        entries.push(...archive.entries);
      }
    }
  }
  return { format: 'BIN/CUE', entries };
}
