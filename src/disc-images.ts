import type {
  SourceInput,
  CompanionFile,
  ProgressReporter,
} from './contracts.js';
import { sourceIncludes } from './source-input.js';
import { Bin, check } from './binary.js';
import { discFileName, readCue } from './disc-cue.js';
import { discSource, rawSectorSource } from './disc-sources.js';
import { readIso9660 } from './disc-iso9660.js';

export async function openDiscImage(
  file: SourceInput,
  name: string,
  companions: CompanionFile[] = [],
  report: ProgressReporter = () => {},
) {
  const source = discSource(file);
  if (/\.cue$/i.test(name)) {
    return readCue(source, name, companions, report);
  }
  const stem = (name.replace(/\\/g, '/').split('/').at(-1) || '')
    .replace(/\.[^.]+$/, '')
    .toLowerCase();
  const cues = companions.filter(
    (item) =>
      (
        discFileName(item).replace(/\\/g, '/').split('/').at(-1) || ''
      ).toLowerCase() ===
      stem + '.cue',
  );
  check(cues.length <= 1, 'AMBIGUOUS_CUE_FILE');
  if (cues.length) {
    const included = companions.some((item) => sourceIncludes(item, file));
    const selected = included ? companions : [{ name, source }, ...companions];
    return readCue(
      discSource(cues[0]),
      discFileName(cues[0]),
      selected,
      report,
    );
  }
  check(source.size >= 18 * 2048, 'INVALID_ISO');
  const head = new Bin(await source.read(0, 16));
  const raw =
    head.u8(0) === 0 &&
    head.u8(11) === 0 &&
    head.slice(1, 10).every((value) => value === 255);
  const logical = raw ? rawSectorSource(source) : source;
  return readIso9660(
    logical,
    'iso/',
    report,
    raw ? { source, sectorSize: 2352, expectedMode: 0 } : undefined,
  );
}
