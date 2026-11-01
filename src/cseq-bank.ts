import type { ByteSource } from './contracts.js';
import type { CseqBank, CseqRegion } from './cseq-types.js';
import { check } from './binary.js';
import { cseqBlock, readCseqContainer, readCseqInfo } from './cseq-files.js';
import type { CseqCheck } from './cseq-files.js';

export interface CseqWaveId {
  archive: number;
  wave: number;
}

export interface CseqParsedBank extends CseqBank {
  readonly waves: readonly CseqWaveId[];
  withWaveResolver(resolveWave: CseqWaveResolver): CseqBank;
}

export type CseqWaveResolver = (
  archive: number,
  wave: number,
) => Promise<ByteSource | null>;

interface RegionValues extends Omit<CseqRegion, 'wave'> {
  waveId: CseqWaveId;
}

interface RegionTable<T> {
  kind: 'direct' | 'threshold' | 'index';
  start: number;
  bounds: readonly number[];
  entries: readonly (T | null)[];
}

function select<T>(table: RegionTable<T> | null, value: number): T | null {
  if (!table) return null;
  if (table.kind === 'direct') return table.entries[0] ?? null;
  if (table.kind === 'index') return table.entries[value - table.start] ?? null;
  const index = table.bounds.findIndex((bound) => value <= bound);
  return index < 0 ? null : (table.entries[index] ?? null);
}

export async function readCseqBank(
  source: ByteSource,
  resolveWave: CseqWaveResolver,
  checkCurrent: CseqCheck = () => {},
): Promise<CseqParsedBank> {
  const container = await readCseqContainer(source, 'CBNK', checkCurrent);
  const info = await readCseqInfo(
    source,
    cseqBlock(container, 0x5800),
    'INFO',
    container.littleEndian,
    checkCurrent,
  );
  const waves: CseqWaveId[] = [];
  const waveTable = info.reference(0, 0);
  if (waveTable !== null) {
    const count = info.count(waveTable, 8);
    for (let index = 0; index < count; index++) {
      const entry = waveTable + 4 + index * 8;
      const id = info.u32(entry);
      check(
        id >>> 24 === 5 || id >>> 24 === 0,
        'CSEQ_FORMAT',
        'Invalid wave archive item ID.',
      );
      waves.push({ archive: id & 0xffffff, wave: info.u32(entry + 4) });
    }
  }
  let nodes = 0;
  const touch = () => {
    checkCurrent();
    nodes++;
    check(nodes <= 262144, 'TOO_MANY', 'Too many bank regions.');
  };
  const regionCache = new Map<number, RegionValues>();
  const region = (offset: number): RegionValues => {
    const cached = regionCache.get(offset);
    if (cached) return cached;
    touch();
    const waveId = waves[info.u32(offset)];
    check(waveId, 'CSEQ_FORMAT', 'Invalid bank wave index.');
    const flags = info.flags(offset + 4);
    const note = flags.get(4) ?? 0;
    const pitchBits = flags.get(3) ?? 0x3f800000;
    const pitchView = new DataView(new ArrayBuffer(4));
    pitchView.setUint32(0, pitchBits);
    const pitch = pitchView.getFloat32(0);
    check(
      Number.isFinite(pitch) && pitch > 0 && pitch <= 256,
      'CSEQ_FORMAT',
      'Invalid bank pitch.',
    );
    const values: RegionValues = {
      waveId,
      originalKey: (flags.get(0) ?? 60) & 0xff,
      volume: (flags.get(1) ?? 127) & 0xff,
      pan: (flags.get(2) ?? 64) & 0xff,
      pitch,
      interpolation: (note >>> 16) & 0xff,
      keyGroup: (note >>> 8) & 0xff,
      percussion: (note & 0xff) !== 0,
      attack: 127,
      decay: 127,
      sustain: 127,
      hold: 127,
      release: 127,
    };
    const envelope = flags.get(9);
    if (envelope !== undefined && envelope !== 0xffffffff) {
      const reference = offset + envelope;
      const target = info.reference(reference, reference);
      if (target !== null) {
        values.attack = info.u8(target);
        values.decay = info.u8(target + 1);
        values.sustain = info.u8(target + 2);
        values.hold = info.u8(target + 3);
        values.release = info.u8(target + 4);
      }
    }
    check(
      values.originalKey <= 127 && values.volume <= 127 && values.pan <= 127,
      'CSEQ_FORMAT',
      'Invalid bank region values.',
    );
    check(
      [
        values.attack,
        values.decay,
        values.sustain,
        values.hold,
        values.release,
      ].every((value) => value <= 127),
      'CSEQ_FORMAT',
      'Invalid bank envelope.',
    );
    regionCache.set(offset, values);
    return values;
  };
  const table = <T>(
    offset: number,
    child: (target: number) => T | null,
  ): RegionTable<T> | null => {
    touch();
    const target = info.reference(offset, offset);
    if (target === null) return null;
    const id = info.u16(offset);
    let count = 1;
    let start = 0;
    let references = target;
    const thresholds: number[] = [];
    let kind: RegionTable<T>['kind'] = 'direct';
    if (id === 0x6001) {
      kind = 'threshold';
      count = info.count(target, 1, 128);
      check(count > 0, 'CSEQ_FORMAT', 'Empty bank range table.');
      references = target + 4 + Math.ceil(count / 4) * 4;
      for (let index = 0; index < count; index++) {
        const value = info.u8(target + 4 + index);
        check(
          value <= 127 && (index === 0 || value > thresholds[index - 1]),
          'CSEQ_FORMAT',
          'Invalid bank range boundaries.',
        );
        thresholds.push(value);
      }
    } else if (id === 0x6002) {
      kind = 'index';
      start = info.u8(target);
      const end = info.u8(target + 1);
      check(
        start <= end && end <= 127,
        'CSEQ_FORMAT',
        'Invalid bank index range.',
      );
      count = end - start + 1;
      references = target + 4;
    } else check(id === 0x6000, 'CSEQ_FORMAT', 'Unsupported bank table type.');
    info.bin.range(references, count * 8);
    const entries: (T | null)[] = [];
    for (let index = 0; index < count; index++) {
      const entry = info.reference(references + index * 8, target);
      entries.push(entry === null ? null : child(entry));
    }
    return { kind, start, bounds: thresholds, entries };
  };
  const instrumentTable = info.reference(8, 0);
  const instruments: (RegionTable<RegionTable<RegionValues>> | null)[] = [];
  if (instrumentTable !== null) {
    const count = info.count(instrumentTable, 8, 16384);
    for (let index = 0; index < count; index++) {
      const target = info.reference(
        instrumentTable + 4 + index * 8,
        instrumentTable,
      );
      instruments.push(
        target === null ? null : table(target, (key) => table(key, region)),
      );
    }
  }
  const bind = (resolve: CseqWaveResolver): CseqBank => ({
    async lookup(program, key, velocity) {
      if (
        ![program, key, velocity].every(Number.isInteger) ||
        program < 0 ||
        key < 0 ||
        key > 127 ||
        velocity < 0 ||
        velocity > 127
      )
        return null;
      const instrument = instruments[program];
      const selected = select(select(instrument ?? null, key), velocity);
      if (!selected) return null;
      const wave = await resolve(selected.waveId.archive, selected.waveId.wave);
      if (!wave) return null;
      return { ...selected, wave };
    },
  });
  return { waves, withWaveResolver: bind, ...bind(resolveWave) };
}
