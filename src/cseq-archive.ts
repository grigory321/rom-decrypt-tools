import type {
  AudioAsset,
  AudioDependency,
  AudioImport,
  ByteSource,
  CompanionFile,
  ProgressReporter,
} from './contracts.js';
import type { CseqBank, CseqPlayback } from './cseq-types.js';
import { bounds, check, sliceSource } from './binary.js';
import { asSource, sourceName } from './source-input.js';
import { errorCode, errorDetail } from './container-errors.js';
import { isAbortError, isFileReadError } from './errors.js';
import {
  cseqBlock,
  CseqInfo,
  readCseqBlockHeader,
  readCseqContainer,
  readCseqFile,
  readCseqInfo,
  readCwarFile,
} from './cseq-files.js';
import type { CseqCheck } from './cseq-files.js';
import { readCseqBank } from './cseq-bank.js';
import type { CseqParsedBank } from './cseq-bank.js';

interface Resource {
  source: ByteSource;
  dependency: AudioDependency;
}

interface ArchiveFile {
  internal?: Resource;
  external?: string;
}

interface ArchiveSound {
  index: number;
  name: string;
  file: number;
  bankIds: readonly number[];
  volume: number;
  startOffset: number;
  channelPriority: number;
  allocatedTracks: number;
}

interface Group {
  label: string;
  identity: string;
  files: ReadonlyMap<number, Resource>;
}

const normalized = (name: string) =>
  name
    .replaceAll('\\', '/')
    .replace(/^(?:\.\/)+/, '')
    .toLowerCase();

function safePath(name: string): string {
  const path = name.replaceAll('\\', '/').replace(/^(?:\.\/)+/, '');
  check(
    path.length > 0 &&
      path.length <= 4096 &&
      !/[:\x00-\x1f]/.test(path) &&
      path.split('/').every((part) => part && part !== '.' && part !== '..'),
    'CSEQ_BANK',
    'Unsafe resource path.',
  );
  return path;
}

function fatal(error: unknown): boolean {
  return (
    isAbortError(error) ||
    isFileReadError(error) ||
    ['CANCELLED', 'TOO_MANY', 'TOO_LARGE'].includes(errorCode(error))
  );
}

function dependency(name: string, source: ByteSource): AudioDependency {
  return { name: safePath(name), source, size: source.size };
}

function addDependency(
  dependencies: AudioDependency[],
  resource: AudioDependency,
): void {
  if (
    !dependencies.some(
      (entry) => normalized(entry.name) === normalized(resource.name),
    )
  )
    dependencies.push(resource);
}

function companionAt(
  path: string,
  companions: CompanionFile[],
): Resource | null {
  const seen = new Set<object>();
  const candidates = companions.filter((entry) => {
    if (normalized(sourceName(entry)) !== normalized(path)) return false;
    const identity = companionIdentity(entry);
    if (seen.has(identity)) return false;
    seen.add(identity);
    return true;
  });
  check(candidates.length <= 1, 'CSEQ_BANK', 'Ambiguous resource: ' + path);
  const file = candidates[0];
  if (!file) return null;
  const source = asSource(file);
  return { source, dependency: dependency(sourceName(file), source) };
}

function companionIdentity(file: CompanionFile): object {
  if ('source' in file) return file.source;
  if ('file' in file) return file.file;
  if ('blob' in file) return file.blob;
  return file;
}

function references(
  info: CseqInfo,
  offset: number,
): readonly (number | null)[] {
  const count = info.count(offset, 8);
  const entries: (number | null)[] = [];
  for (let index = 0; index < count; index++)
    entries.push(info.reference(offset + 4 + index * 8, offset));
  return entries;
}

function infoTable(info: CseqInfo, id: number): readonly (number | null)[] {
  info.bin.range(0, 64);
  for (let index = 0; index < 8; index++) {
    if (info.u16(index * 8) !== id) continue;
    const target = info.reference(index * 8, 0);
    return target === null ? [] : references(info, target);
  }
  return [];
}

function readPath(info: CseqInfo, target: number): string {
  const available = Math.min(4097, info.bin.b.length - target);
  info.bin.range(target, available);
  const bytes = info.bin.slice(target, available);
  const end = bytes.indexOf(0);
  check(
    end >= 0 && end <= 4096,
    'CSEQ_BANK',
    'Resource path exceeds its limit.',
  );
  return new TextDecoder().decode(bytes.subarray(0, end));
}

async function readStrings(
  source: ByteSource,
  container: Awaited<ReturnType<typeof readCseqContainer>>,
  checkCurrent: CseqCheck,
): Promise<readonly string[]> {
  const block = container.blocks.get(0x2000);
  if (!block) return [];
  const info = await readCseqInfo(
    source,
    block,
    'STRG',
    container.littleEndian,
    checkCurrent,
  );
  const table = info.reference(0, 0);
  if (table === null) return [];
  const count = info.count(table, 12);
  const strings: string[] = [];
  for (let index = 0; index < count; index++) {
    checkCurrent();
    const reference = table + 4 + index * 12;
    const offset = info.u32(reference + 4);
    const length = info.u32(reference + 8);
    check(
      length > 0 && length <= 4097,
      'TOO_LARGE',
      'Archive label exceeds its limit.',
    );
    strings.push(
      new TextDecoder()
        .decode(info.bin.slice(table + offset, length))
        .replace(/\0.*$/, ''),
    );
  }
  return strings;
}

async function readGroup(
  resource: Resource,
  label: string,
  identity: string,
  checkCurrent: CseqCheck,
): Promise<Group> {
  const source = resource.source;
  const container = await readCseqContainer(source, 'CGRP', checkCurrent);
  const info = await readCseqInfo(
    source,
    cseqBlock(container, 0x7800),
    'INFO',
    container.littleEndian,
    checkCurrent,
  );
  const file = cseqBlock(container, 0x7801);
  await readCseqBlockHeader(
    source,
    file,
    'FILE',
    container.littleEndian,
    checkCurrent,
  );
  const files = new Map<number, Resource>();
  for (const entry of references(info, 0)) {
    checkCurrent();
    if (entry === null) continue;
    const id = info.u32(entry);
    const offset = info.u32(entry + 8);
    const size = info.u32(entry + 12);
    if (offset === 0xffffffff) continue;
    check(!files.has(id), 'CSEQ_FORMAT', 'Duplicate group file ID.');
    bounds(file.size - 8, offset, size);
    files.set(id, {
      source: sliceSource(source, file.offset + 8 + offset, size),
      dependency: resource.dependency,
    });
  }
  return { label, identity, files };
}

function assetName(
  name: string,
  sound: ArchiveSound,
  group: Group | null,
): string {
  const label =
    sound.name.replace(/[^\p{L}\p{N}_.-]/gu, '_') ||
    'sequence_' + String(sound.index).padStart(5, '0');
  const variant = group
    ? '/' + group.label.replace(/[^\p{L}\p{N}_.-]/gu, '_')
    : '';
  return name.replace(/\.[^./]+$/, '') + variant + '/' + label + '.bcseq';
}

export async function readCseqArchive(
  source: ByteSource,
  name: string,
  companions: CompanionFile[] = [],
  report: ProgressReporter = () => {},
): Promise<AudioImport> {
  check(companions.length <= 65536, 'TOO_MANY', 'Too many CSEQ companions.');
  const checkCurrent = () => report({ phase: 'scan', value: null });
  const container = await readCseqContainer(source, 'CSAR', checkCurrent);
  const info = await readCseqInfo(
    source,
    cseqBlock(container, 0x2001),
    'INFO',
    container.littleEndian,
    checkCurrent,
  );
  const fileBlock = cseqBlock(container, 0x2002);
  await readCseqBlockHeader(
    source,
    fileBlock,
    'FILE',
    container.littleEndian,
    checkCurrent,
  );
  const original = dependency(name, source);
  const strings = await readStrings(source, container, checkCurrent);
  const warnings: AudioImport['warnings'] = [];
  const files: ArchiveFile[] = [];
  for (const entry of infoTable(info, 0x2106)) {
    checkCurrent();
    const file: ArchiveFile = {};
    if (entry !== null) {
      const target = info.reference(entry, entry);
      if (target !== null && info.u16(entry) === 0x220c) {
        const offset = info.u32(target + 4);
        const size = info.u32(target + 8);
        if (offset !== 0xffffffff) {
          bounds(fileBlock.size - 8, offset, size);
          file.internal = {
            source: sliceSource(source, fileBlock.offset + 8 + offset, size),
            dependency: original,
          };
        }
      } else if (target !== null && info.u16(entry) === 0x220d)
        file.external = readPath(info, target);
    }
    files.push(file);
  }
  const directory = name.replaceAll('\\', '/').replace(/[^/]*$/, '');
  const mainCache = new Map<number, Resource | null>();
  const main = (id: number): Resource | null => {
    if (mainCache.has(id)) return mainCache.get(id) ?? null;
    const entry = files[id];
    check(entry, 'CSEQ_BANK', 'Archive file ID is missing: ' + id);
    const resource =
      entry.internal ??
      (entry.external
        ? companionAt(directory + safePath(entry.external), companions)
        : null);
    mainCache.set(id, resource);
    return resource;
  };
  const groups: Group[] = [];
  const groupSources = new Set<ByteSource>();
  const groupCompanionPaths = new Set<string>();
  let groupItems = 0;
  const loadGroup = async (
    resource: Resource,
    label: string,
    identity: string,
  ) => {
    check(groups.length < 4096, 'TOO_MANY', 'Too many instrument groups.');
    const group = await readGroup(resource, label, identity, checkCurrent);
    groupItems += group.files.size;
    check(
      groupItems <= 262144,
      'TOO_MANY',
      'Too many instrument group entries.',
    );
    groups.push(group);
    groupSources.add(resource.source);
    if (resource.dependency !== original)
      groupCompanionPaths.add(normalized(resource.dependency.name));
  };
  for (const entry of infoTable(info, 0x2105)) {
    if (entry === null) continue;
    const fileId = info.u32(entry);
    const resource = main(fileId);
    if (!resource || groupSources.has(resource.source)) continue;
    const values = info.flags(entry + 4);
    const string = values.get(0);
    const label =
      string === undefined
        ? 'group_' + groups.length
        : strings[string & 0xffffff] || 'group_' + groups.length;
    try {
      await loadGroup(
        resource,
        label,
        resource.dependency === original
          ? 'internal:' + fileId
          : 'external:' + normalized(resource.dependency.name),
      );
    } catch (error) {
      if (fatal(error)) throw error;
      warnings.push({
        code: 'CSEQ_BANK',
        detail: errorDetail(error) || 'Invalid instrument group: ' + label,
      });
    }
  }
  for (const companion of companions) {
    checkCurrent();
    if (!/\.(?:bcgrp|cgrp)$/i.test(sourceName(companion))) continue;
    if (!normalized(sourceName(companion)).startsWith(normalized(directory)))
      continue;
    check(groups.length < 4096, 'TOO_MANY', 'Too many instrument groups.');
    const resource = {
      source: asSource(companion),
      dependency: dependency(sourceName(companion), asSource(companion)),
    };
    if (
      groupSources.has(resource.source) ||
      groupCompanionPaths.has(normalized(resource.dependency.name))
    )
      continue;
    const label = sourceName(companion).replace(/\.[^./]+$/, '');
    try {
      await loadGroup(
        resource,
        label,
        'external:' + normalized(resource.dependency.name),
      );
    } catch (error) {
      if (fatal(error)) throw error;
      warnings.push({
        code: 'CSEQ_BANK',
        detail: errorDetail(error) || 'Invalid instrument group: ' + label,
      });
    }
  }
  const bankFiles = infoTable(info, 0x2101).map((entry) =>
    entry === null ? null : info.u32(entry),
  );
  const waveFiles = infoTable(info, 0x2103).map((entry) =>
    entry === null ? null : info.u32(entry),
  );
  const sounds: ArchiveSound[] = [];
  const soundFiles = new Set<number>();
  for (const [index, entry] of infoTable(info, 0x2100).entries()) {
    checkCurrent();
    if (entry !== null) soundFiles.add(info.u32(entry));
    if (entry === null || info.u16(entry + 12) !== 0x2203) continue;
    const detail = info.reference(entry + 12, entry);
    check(detail !== null, 'CSEQ_FORMAT', 'Sequence details are missing.');
    const bankTable = info.reference(detail, detail);
    const bankIds: number[] = [];
    if (bankTable !== null) {
      const count = info.count(bankTable, 4, 4);
      for (let index = 0; index < count; index++)
        bankIds.push(info.u32(bankTable + 4 + index * 4) & 0xffffff);
    }
    const flags = info.flags(entry + 20);
    const sequenceFlags = info.flags(detail + 12);
    const string = flags.get(0);
    sounds.push({
      index,
      name: string === undefined ? '' : strings[string & 0xffffff] || '',
      file: info.u32(entry),
      bankIds,
      volume: info.u8(entry + 8),
      startOffset: sequenceFlags.get(0) ?? 0,
      channelPriority: (sequenceFlags.get(1) ?? 64) & 0xff,
      allocatedTracks: info.u32(detail + 8),
    });
  }
  const parsedBanks = new Map<ByteSource, Promise<CseqParsedBank>>();
  const parsedWaves = new Map<
    ByteSource,
    Promise<readonly (ByteSource | null)[]>
  >();
  let bankMetadataBytes = 0;
  let waveReferences = 0;
  let waveMetadataItems = 0;
  const metadataBank = (resource: Resource): Promise<CseqParsedBank> => {
    let parsed = parsedBanks.get(resource.source);
    if (!parsed) {
      check(parsedBanks.size < 4096, 'TOO_MANY', 'Too many instrument banks.');
      bankMetadataBytes += resource.source.size;
      check(
        bankMetadataBytes <= 64 * 1024 * 1024,
        'TOO_LARGE',
        'Instrument bank metadata exceeds its aggregate limit.',
      );
      parsed = readCseqBank(resource.source, async () => null, checkCurrent);
      parsedBanks.set(resource.source, parsed);
    }
    return parsed;
  };
  const boundBanks = new Map<
    Group | null,
    Map<
      number,
      Promise<{ bank: CseqBank; dependencies: readonly AudioDependency[] }>
    >
  >();
  const boundBank = (file: number, group: Group | null) => {
    let context = boundBanks.get(group);
    if (!context) {
      context = new Map();
      boundBanks.set(group, context);
    }
    const cached = context.get(file);
    if (cached) return cached;
    const load = async () => {
      const dependencies: AudioDependency[] = [];
      const resolve = (id: number): Resource => {
        const resource = main(id) ?? group?.files.get(id);
        check(
          resource,
          'CSEQ_BANK',
          'Original resource is missing in ' +
            (group?.label || name) +
            ': file ' +
            id,
        );
        addDependency(dependencies, resource.dependency);
        return resource;
      };
      const resource = resolve(file);
      const metadata = await metadataBank(resource);
      const waveMap = new Map<string, ByteSource>();
      waveReferences += metadata.waves.length;
      check(
        waveReferences <= 1048576,
        'TOO_MANY',
        'Too many sequence wave references.',
      );
      for (const wave of metadata.waves) {
        checkCurrent();
        const waveFile = waveFiles[wave.archive];
        check(
          waveFile !== null && waveFile !== undefined,
          'CSEQ_BANK',
          'Wave archive item ID is missing: ' + wave.archive,
        );
        const resource = resolve(waveFile);
        let parsed = parsedWaves.get(resource.source);
        if (!parsed) {
          check(parsedWaves.size < 4096, 'TOO_MANY', 'Too many wave archives.');
          parsed = readCwarFile(resource.source, checkCurrent).then((waves) => {
            waveMetadataItems += waves.length;
            check(
              waveMetadataItems <= 262144,
              'TOO_MANY',
              'Too many wave archive entries.',
            );
            return waves;
          });
          parsedWaves.set(resource.source, parsed);
        }
        const wav = (await parsed)[wave.wave];
        check(wav, 'CSEQ_BANK', 'Original instrument wave is missing.');
        waveMap.set(wave.archive + ':' + wave.wave, wav);
      }
      return {
        bank: metadata.withWaveResolver(
          async (archive, wave) => waveMap.get(archive + ':' + wave) ?? null,
        ),
        dependencies,
      };
    };
    const loaded = load();
    context.set(file, loaded);
    return loaded;
  };
  const assets: AudioAsset[] = [];
  for (const sound of sounds) {
    checkCurrent();
    const required = new Set<number>([sound.file]);
    for (const id of sound.bankIds) {
      if (id === 0xffffff) continue;
      const file = bankFiles[id];
      if (file !== null && file !== undefined) required.add(file);
    }
    const candidateGroups = new Set<Group>();
    const discover = (id: number) => {
      if (main(id)) return;
      for (const group of groups)
        if (group.files.has(id)) candidateGroups.add(group);
    };
    try {
      for (const id of required) discover(id);
      for (const id of sound.bankIds) {
        const file = bankFiles[id];
        if (file === null || file === undefined) continue;
        const choices = main(file)
          ? [main(file)]
          : groups.map((group) => group.files.get(file));
        for (const resource of choices) {
          if (!resource) continue;
          const parsed = await metadataBank(resource);
          for (const wave of parsed.waves) {
            const waveFile = waveFiles[wave.archive];
            if (waveFile !== null && waveFile !== undefined) discover(waveFile);
          }
        }
      }
    } catch (error) {
      if (fatal(error)) throw error;
    }
    const contexts: (Group | null)[] = candidateGroups.size
      ? [...candidateGroups]
      : [null];
    check(
      contexts.length <= 256 && assets.length + contexts.length <= 65536,
      'TOO_MANY',
      'Too many sequence group variants.',
    );
    for (const group of contexts) {
      checkCurrent();
      const dependencies = [original];
      const resolve = (id: number): Resource => {
        const resource = main(id) ?? group?.files.get(id);
        check(
          resource,
          'CSEQ_BANK',
          'Original resource is missing in ' +
            (group?.label || name) +
            ': file ' +
            id,
        );
        addDependency(dependencies, resource.dependency);
        return resource;
      };
      let sequence: ByteSource | null = null;
      let playback: CseqPlayback | undefined;
      try {
        const candidate = resolve(sound.file).source;
        const parsed = await readCseqFile(candidate, checkCurrent);
        check(
          sound.startOffset < parsed.data.size,
          'CSEQ_BANK',
          'Sequence entrypoint is outside DATA.',
        );
        sequence = candidate;
        const banks: (CseqBank | null)[] = [];
        let bankCount = 0;
        for (const id of sound.bankIds) {
          if (id === 0xffffff) {
            banks.push(null);
            continue;
          }
          const file = bankFiles[id];
          check(
            file !== null && file !== undefined,
            'CSEQ_BANK',
            'Bank item ID is missing: ' + id,
          );
          const loaded = await boundBank(file, group);
          banks.push(loaded.bank);
          for (const dependency of loaded.dependencies)
            addDependency(dependencies, dependency);
          bankCount++;
        }
        check(
          bankCount > 0,
          'CSEQ_BANK',
          'Original instrument bank is missing.',
        );
        playback = {
          identity:
            normalized(original.name) +
            ':sound:' +
            sound.index +
            ':group:' +
            (group?.identity ?? 'main') +
            ':start:' +
            sound.startOffset,
          banks,
          volume: sound.volume,
          startOffset: sound.startOffset,
          channelPriority: sound.channelPriority,
          allocatedTracks: sound.allocatedTracks,
        };
      } catch (error) {
        if (fatal(error)) throw error;
        warnings.push({
          code: 'CSEQ_BANK',
          detail:
            assetName(name, sound, group) +
            ': ' +
            (errorDetail(error) ||
              'A valid original instrument bank is required.'),
        });
      }
      if (!sequence) continue;
      assets.push({
        source: sequence,
        name: assetName(name, sound, group),
        format: 'CSEQ',
        size: sequence.size,
        kind: 'sequence',
        playable: !!playback,
        gameAudio: true,
        song: sound.index,
        cseq: playback,
        dependencies,
      });
    }
  }
  const preserveUnreferenced = async (
    id: number,
    resource: Resource,
    group: Group | null,
  ) => {
    checkCurrent();
    if (soundFiles.has(id) || resource.source.size < 4) return;
    const magic = await resource.source.read(0, 4);
    checkCurrent();
    check(magic.length === 4, 'CSEQ_FORMAT', 'Truncated original resource.');
    if (
      magic[0] !== 67 ||
      magic[1] !== 83 ||
      magic[2] !== 69 ||
      magic[3] !== 81
    )
      return;
    check(assets.length < 65536, 'TOO_MANY', 'Too many original CSEQ files.');
    const dependencies = [original];
    addDependency(dependencies, resource.dependency);
    const fileName =
      name.replace(/\.[^./]+$/, '') +
      (group ? '/' + group.label.replace(/[^\p{L}\p{N}_.-]/gu, '_') : '') +
      '/unreferenced_' +
      String(id).padStart(5, '0') +
      '.bcseq';
    assets.push({
      source: resource.source,
      name: fileName,
      format: 'CSEQ',
      size: resource.source.size,
      kind: 'sequence',
      playable: false,
      gameAudio: true,
      dependencies,
    });
    warnings.push({
      code: 'CSEQ_BANK',
      detail:
        fileName +
        ': No sound table entry identifies the original instrument banks.',
    });
  };
  for (const [id, file] of files.entries()) {
    if (soundFiles.has(id)) continue;
    try {
      const resource = file.internal ?? (file.external ? main(id) : null);
      if (resource) await preserveUnreferenced(id, resource, null);
    } catch (error) {
      if (fatal(error)) throw error;
      warnings.push({
        code: 'CSEQ_BANK',
        detail:
          name + ': ' + (errorDetail(error) || 'Invalid original resource.'),
      });
    }
  }
  for (const group of groups) {
    for (const [id, resource] of group.files) {
      if (files[id]?.internal) continue;
      await preserveUnreferenced(id, resource, group);
    }
  }
  return { assets, warnings };
}

async function sameBytes(
  left: ByteSource,
  right: ByteSource,
  checkCurrent: CseqCheck,
): Promise<boolean> {
  if (left.size !== right.size) return false;
  check(
    left.size <= 16 * 1024 * 1024,
    'TOO_LARGE',
    'Sequence exceeds companion matching limit.',
  );
  for (let offset = 0; offset < left.size; offset += 65536) {
    checkCurrent();
    const length = Math.min(65536, left.size - offset);
    const [a, b] = await Promise.all([
      left.read(offset, length),
      right.read(offset, length),
    ]);
    checkCurrent();
    check(
      a.length === length && b.length === length,
      'CSEQ_FORMAT',
      'Truncated companion sequence.',
    );
    if (a.some((value, index) => value !== b[index])) return false;
  }
  return true;
}

export async function readCseqAudio(
  source: ByteSource,
  name: string,
  companions: CompanionFile[] = [],
  report: ProgressReporter = () => {},
): Promise<AudioImport> {
  check(companions.length <= 65536, 'TOO_MANY', 'Too many CSEQ companions.');
  const checkCurrent = () => report({ phase: 'scan', value: null });
  await readCseqFile(source, checkCurrent);
  const dependencies = [dependency(name, source)];
  const warnings: AudioImport['warnings'] = [];
  let playback: CseqPlayback | undefined;
  try {
    const base = name.replace(/\.[^./]+$/, '');
    const banks = [
      companionAt(base + '.bcbnk', companions),
      companionAt(base + '.cbnk', companions),
    ].filter((entry) => entry !== null);
    const wars = [
      companionAt(base + '.bcwar', companions),
      companionAt(base + '.cwar', companions),
    ].filter((entry) => entry !== null);
    check(
      banks.length <= 1 && wars.length <= 1,
      'CSEQ_BANK',
      'Ambiguous standalone instrument resources.',
    );
    const bank = banks[0];
    const war = wars[0];
    check(
      bank && war,
      'CSEQ_BANK',
      'A matching original CBNK and CWAR are required.',
    );
    const waves = await readCwarFile(war.source, checkCurrent);
    const parsed = await readCseqBank(
      bank.source,
      async (archive, wave) => (archive === 0 ? (waves[wave] ?? null) : null),
      checkCurrent,
    );
    check(
      parsed.waves.every((wave) => wave.archive === 0 && waves[wave.wave]),
      'CSEQ_BANK',
      'Standalone bank requires another original wave archive.',
    );
    addDependency(dependencies, bank.dependency);
    addDependency(dependencies, war.dependency);
    playback = {
      banks: [parsed],
      startOffset: 0,
      volume: 127,
      channelPriority: 64,
      allocatedTracks: 0xffff,
    };
  } catch (error) {
    if (fatal(error)) throw error;
    const matched: AudioAsset[] = [];
    const compared = new Map<ByteSource, Promise<boolean>>();
    const archives = new Map<string, Set<object>>();
    let comparisons = 0;
    for (const companion of companions) {
      checkCurrent();
      if (!/\.(?:bcsar|csar)$/i.test(sourceName(companion))) continue;
      const path = normalized(sourceName(companion));
      let sources = archives.get(path);
      if (!sources) {
        sources = new Set();
        archives.set(path, sources);
      }
      const identity = companionIdentity(companion);
      if (sources.has(identity)) continue;
      sources.add(identity);
      check(
        comparisons++ < 64,
        'TOO_MANY',
        'Too many companion sound archives.',
      );
      try {
        const imported = await readCseqArchive(
          asSource(companion),
          sourceName(companion),
          companions,
          report,
        );
        const previous = matched.length;
        for (const asset of imported.assets) {
          let comparison = compared.get(asset.source);
          if (!comparison) {
            comparison = sameBytes(source, asset.source, checkCurrent);
            compared.set(asset.source, comparison);
          }
          if (await comparison) {
            const assetDependencies = [...dependencies];
            for (const file of asset.dependencies ?? [])
              addDependency(assetDependencies, file);
            matched.push({
              ...asset,
              source,
              size: source.size,
              dependencies: assetDependencies,
            });
          }
        }
        if (matched.length > previous)
          warnings.push(
            ...imported.warnings.filter(
              (warning) => warning.code === 'CSEQ_BANK',
            ),
          );
      } catch (error) {
        if (fatal(error)) throw error;
        warnings.push({
          code: 'CSEQ_BANK',
          detail:
            sourceName(companion) +
            ': ' +
            (errorDetail(error) || 'Invalid companion sound archive.'),
        });
      }
    }
    if (matched.length) return { assets: matched, warnings };
    warnings.push({
      code: 'CSEQ_BANK',
      detail:
        errorDetail(error) ||
        'A matching original instrument bank is required.',
    });
  }
  return {
    assets: [
      {
        source,
        name,
        format: 'CSEQ',
        size: source.size,
        kind: 'sequence',
        playable: !!playback,
        gameAudio: true,
        cseq: playback,
        dependencies,
      },
    ],
    warnings,
  };
}
