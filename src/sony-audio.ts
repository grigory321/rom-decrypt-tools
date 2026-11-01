import type {
  AudioAsset,
  AudioImport,
  ByteSource,
  CompanionFile,
  ProgressReporter,
  SonyPlayback,
} from './contracts.js';
import { check } from './binary.js';
import { asSource, sourceName } from './source-input.js';
import { errorCode, errorDetail } from './container-errors.js';
import { readSonySequence } from './audio-sony-sequence.js';
import { openVabBank } from './audio-vab.js';
import { isFileReadError } from './errors.js';

const normalized = (name: string) =>
  name
    .replaceAll('\\', '/')
    .replace(/^(?:\.\/)+/, '')
    .toLowerCase();

function dependencyName(name: string) {
  const path = name.replaceAll('\\', '/').replace(/^(?:\.\/)+/, '');
  check(
    path.length > 0 &&
      path.length <= 4096 &&
      !/[:\x00-\x1f]/.test(path) &&
      path.split('/').every((part) => part && part !== '.' && part !== '..'),
    'SONY_BANK',
    'Unsafe companion path.',
  );
  return path;
}

function matching(
  name: string,
  extension: string,
  companions: CompanionFile[],
) {
  const wanted = normalized(name).replace(/\.[^./]+$/, '.' + extension);
  const candidates = companions.filter(
    (file) => normalized(sourceName(file, true)) === wanted,
  );
  check(candidates.length <= 1, 'SONY_BANK', 'Ambiguous companion: ' + wanted);
  return candidates[0];
}

export async function readSonyAudio(
  source: ByteSource,
  name: string,
  companions: CompanionFile[],
  report: ProgressReporter = () => {},
): Promise<AudioImport> {
  const current = () => report({ phase: 'scan', value: null });
  const info = await readSonySequence(source, name, current);
  const dependencies = [
    { name: dependencyName(name), source, size: source.size },
  ];
  const warnings: AudioImport['warnings'] = [];
  let playback: SonyPlayback | undefined;
  try {
    const combined = matching(name, 'vab', companions);
    const header = combined || matching(name, 'vh', companions);
    check(header, 'SONY_BANK', 'Matching VAB or VH is missing: ' + name);
    const bank = asSource(header);
    const body = combined ? undefined : matching(name, 'vb', companions);
    check(combined || body, 'SONY_BANK', 'Matching VB is missing: ' + name);
    await openVabBank(
      bank,
      sourceName(header, true),
      body ? [body] : [],
      report,
    );
    playback = { bank, body: body ? asSource(body) : undefined };
    for (const file of body ? [header, body] : [header]) {
      const data = asSource(file);
      dependencies.push({
        name: dependencyName(sourceName(file, true)),
        source: data,
        size: data.size,
      });
    }
  } catch (error) {
    if (
      isFileReadError(error) ||
      ['CANCELLED', 'TOO_MANY', 'TOO_LARGE'].includes(errorCode(error))
    )
      throw error;
    warnings.push({
      code: 'SONY_BANK',
      detail:
        errorDetail(error) ||
        'A matching, valid original instrument bank is required.',
    });
  }
  const assets: AudioAsset[] = info.songs.map((song) => ({
    source,
    name:
      info.songs.length === 1
        ? name
        : name.replace(/\.[^./]+$/, '') +
          '/' +
          String(song.index + 1).padStart(3, '0') +
          '.sep',
    format: info.format,
    size: source.size,
    kind: 'sequence',
    playable: !!playback,
    gameAudio: true,
    song: song.index,
    sony: playback,
    dependencies,
  }));
  return { assets, warnings };
}
