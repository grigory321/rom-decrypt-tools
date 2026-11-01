import type {
  ArchiveEntry,
  AudioAsset,
  AudioImport,
  ByteSource,
  DecoderOptions,
  ProgressReporter,
} from './contracts.js';
import { bounds, check, FormatError, sliceSource } from './binary.js';
import { readAudio } from './audio-codecs.js';
import { cooperativeYield } from './cooperative.js';
import {
  createHeartbeatDecoder,
  identifyHeartbeatDriver,
} from './ps-heartbeat-driver.js';
import type { HeartbeatDriver } from './ps-heartbeat-driver.js';

export { createHeartbeatDecoder };

export interface HeartbeatBank {
  id: number;
  waveSize: number;
  attributeSize: number;
  offset: number;
}

export interface HeartbeatResource {
  name: string;
  source: ByteSource;
  offset: number;
  size: number;
  id: number;
  loadSlot: number;
  sequenceSize: number;
  sequenceOffset: number;
  banks: HeartbeatBank[];
}

export interface HeartbeatPlayback {
  executable: ByteSource;
  driver: HeartbeatDriver;
  sequence: HeartbeatResource;
  banks: HeartbeatResource[];
}

function resourceHeader(bytes: Uint8Array, at: number, available: number) {
  if (
    bytes[at + 6] > 4 ||
    bytes[at + 7] > 7 ||
    bytes[at + 3] !== 0 ||
    bytes[at + 2] > 4
  )
    return null;
  const header = new DataView(bytes.buffer, bytes.byteOffset + at, 60);
  const sequenceSize = header.getUint32(0, true);
  const id = header.getUint16(4, true);
  const count = bytes[at + 6];
  const loadSlot = bytes[at + 7];
  if (
    count > 4 ||
    loadSlot > 7 ||
    sequenceSize > 262144 ||
    sequenceSize % 4 ||
    (sequenceSize > 0 && (sequenceSize < 20 || id === 65535))
  )
    return null;
  const banks: HeartbeatBank[] = [];
  let size = 60;
  let waveBytes = 0;
  const ids = new Set<number>();
  for (let index = 0; index < 4; index++) {
    const field = 12 + index * 12;
    const waveSize = header.getUint32(field, true);
    const attributeSize = header.getUint32(field + 4, true);
    const bankId = header.getUint16(field + 8, true);
    if (
      waveSize > 524288 ||
      attributeSize > 65536 ||
      waveSize % 16 ||
      attributeSize % 4 ||
      !!waveSize !== !!attributeSize ||
      (waveSize > 0 && (bankId === 65535 || ids.has(bankId))) ||
      (index >= count && waveSize > 0)
    )
      return null;
    if (index < count)
      banks.push({ id: bankId, waveSize, attributeSize, offset: size });
    if (waveSize) ids.add(bankId);
    size += waveSize + attributeSize;
    waveBytes += waveSize;
  }
  const sequenceOffset = size;
  size += sequenceSize;
  if (
    size <= 60 ||
    size > 1048576 ||
    waveBytes > 524288 ||
    size > available ||
    (!sequenceSize && !waveBytes)
  )
    return null;
  return { size, id, loadSlot, sequenceSize, sequenceOffset, banks };
}

export async function scanHeartbeatResources(
  source: ByteSource,
  name: string,
  report: ProgressReporter = () => {},
  checkpoint = cooperativeYield(() => report({ phase: 'scan', value: null })),
): Promise<HeartbeatResource[]> {
  check(source.size <= 16 * 1024 ** 3, 'TOO_LARGE');
  const resources: HeartbeatResource[] = [];
  let tail = new Uint8Array(0);
  let skip = 0;
  for (let offset = 0; offset < source.size; offset += 65536) {
    report({ phase: 'scan', value: offset / source.size, detail: name });
    const next = await readAudio(
      source,
      offset,
      Math.min(65536, source.size - offset),
    );
    const bytes = new Uint8Array(tail.length + next.length);
    bytes.set(tail);
    bytes.set(next, tail.length);
    const base = offset - tail.length;
    for (let at = (4 - (base % 4)) % 4; at + 60 <= bytes.length; at += 4) {
      const start = base + at;
      if (start < skip) continue;
      const info = resourceHeader(bytes, at, source.size - start);
      if (!info) continue;
      let valid = true;
      if (info.sequenceSize) {
        const position = at + info.sequenceOffset;
        const magic =
          position + 4 <= bytes.length
            ? bytes.subarray(position, position + 4)
            : await readAudio(source, start + info.sequenceOffset, 4);
        valid =
          magic[0] === 113 &&
          magic[1] === 81 &&
          magic[2] === 69 &&
          magic[3] === 83;
      }
      if (!valid) continue;
      for (const bank of info.banks) {
        if (!bank.waveSize) continue;
        const block = await readAudio(source, start + bank.offset, 16);
        if (block[0] >>> 4 > 4 || (block[1] & 248) !== 0) {
          valid = false;
          break;
        }
      }
      if (!valid) continue;
      check(resources.length < 20000, 'TOO_MANY', 'HeartBeat resources');
      resources.push({
        ...info,
        offset: start,
        name,
        source: sliceSource(source, start, info.size),
      });
      skip = start + info.size;
    }
    tail = bytes.slice(Math.max(0, bytes.length - 59));
    await checkpoint();
  }
  return resources;
}

async function sameBytes(
  first: ByteSource,
  firstOffset: number,
  second: ByteSource,
  secondOffset: number,
  length: number,
  report: ProgressReporter,
  checkpoint: () => Promise<void>,
) {
  for (let at = 0; at < length; at += 65536) {
    report({ phase: 'scan', value: null });
    const count = Math.min(65536, length - at);
    const a = await readAudio(first, firstOffset + at, count);
    const b = await readAudio(second, secondOffset + at, count);
    if (!a.every((value, index) => value === b[index])) return false;
    await checkpoint();
  }
  return true;
}

async function fingerprint(
  resource: HeartbeatResource,
  report: ProgressReporter,
  checkpoint: () => Promise<void>,
) {
  let hash = 2166136261;
  for (let offset = 0; offset < resource.size; offset += 65536) {
    report({ phase: 'scan', value: null });
    const bytes = await readAudio(
      resource.source,
      offset,
      Math.min(65536, resource.size - offset),
    );
    for (const value of bytes) hash = Math.imul(hash ^ value, 16777619);
    await checkpoint();
  }
  return resource.id + ':' + resource.size + ':' + (hash >>> 0);
}

async function uniqueResources(
  resources: HeartbeatResource[],
  report: ProgressReporter,
  checkpoint: () => Promise<void>,
) {
  const groups = new Map<string, HeartbeatResource[]>();
  const unique: HeartbeatResource[] = [];
  for (const resource of resources) {
    const key = await fingerprint(resource, report, checkpoint);
    const group = groups.get(key) || [];
    let duplicate = false;
    for (const previous of group)
      if (
        await sameBytes(
          resource.source,
          0,
          previous.source,
          0,
          resource.size,
          report,
          checkpoint,
        )
      ) {
        duplicate = true;
        break;
      }
    if (duplicate) continue;
    group.push(resource);
    groups.set(key, group);
    unique.push(resource);
  }
  return unique;
}

function resourceName(resource: HeartbeatResource) {
  return (
    resource.name +
    '/heartbeat/' +
    (resource.sequenceSize ? 'sequence_' : 'bank_') +
    String(resource.id).padStart(5, '0') +
    '_' +
    resource.offset.toString(16) +
    '.snd'
  );
}

async function associatedBanks(
  sequence: HeartbeatResource,
  resources: HeartbeatResource[],
  report: ProgressReporter,
  checkpoint: () => Promise<void>,
) {
  const selected: HeartbeatResource[] = [];
  for (const required of sequence.banks) {
    await checkpoint();
    if (required.id === 65535) continue;
    if (required.waveSize) {
      if (!selected.includes(sequence)) selected.push(sequence);
      continue;
    }
    const matches = resources.filter((resource) =>
      resource.banks.some((bank) => bank.id === required.id && bank.waveSize),
    );
    if (!matches.length) return { error: 'Missing bank ' + required.id };
    const first = matches[0];
    const firstBank = first.banks.find(
      (bank) => bank.id === required.id && bank.waveSize,
    );
    check(firstBank, 'PSF_DRIVER');
    for (const match of matches.slice(1)) {
      const bank = match.banks.find(
        (candidate) => candidate.id === required.id && candidate.waveSize,
      );
      check(bank, 'PSF_DRIVER');
      if (
        bank.waveSize !== firstBank.waveSize ||
        bank.attributeSize !== firstBank.attributeSize ||
        !(await sameBytes(
          first.source,
          firstBank.offset,
          match.source,
          bank.offset,
          bank.waveSize + bank.attributeSize,
          report,
          checkpoint,
        ))
      )
        return { error: 'Ambiguous bank ' + required.id };
    }
    if (!selected.includes(first)) selected.push(first);
  }
  return { banks: selected };
}

export async function readHeartbeatAudio(
  entries: ArchiveEntry[],
  report: ProgressReporter = () => {},
): Promise<AudioImport | null> {
  check(entries.length <= 200000, 'TOO_MANY');
  const checkpoint = cooperativeYield(() =>
    report({ phase: 'scan', value: null }),
  );
  const normalize = (path: string) => path.replaceAll('\\', '/').toLowerCase();
  const groups = new Map<
    string,
    {
      executables: { entry: ArchiveEntry; driver: HeartbeatDriver }[];
      resources: HeartbeatResource[];
    }
  >();
  const executableEntries = new Set<ArchiveEntry>();
  for (const entry of entries) {
    await checkpoint();
    if (entry.kind === 'directory' || entry.size < 2048 || entry.size > 2099200)
      continue;
    const header = await readAudio(entry.source, 0, 8);
    if (new TextDecoder().decode(header) !== 'PS-X EXE') continue;
    const found = await identifyHeartbeatDriver(entry.source, report);
    if (!found) continue;
    executableEntries.add(entry);
    const path = normalize(entry.path);
    const directory = path.slice(0, path.lastIndexOf('/') + 1);
    const group = groups.get(directory) || { executables: [], resources: [] };
    let duplicate = false;
    for (const previous of group.executables) {
      if (
        entry.size === previous.entry.size &&
        (await sameBytes(
          entry.source,
          0,
          previous.entry.source,
          0,
          entry.size,
          report,
          checkpoint,
        ))
      ) {
        duplicate = true;
        break;
      }
    }
    if (!duplicate) group.executables.push({ entry, driver: found });
    groups.set(directory, group);
  }
  if (!groups.size) return null;
  let candidateCount = 0;
  const directories = [...groups.keys()].sort(
    (left, right) => right.length - left.length,
  );
  for (const entry of entries) {
    await checkpoint();
    if (
      executableEntries.has(entry) ||
      entry.kind === 'directory' ||
      ['XA', 'XA2336', 'MODE2/2336'].includes(entry.format || '') ||
      entry.size < 60
    )
      continue;
    const path = normalize(entry.path);
    const directory = directories.find((prefix) => path.startsWith(prefix));
    if (directory === undefined) continue;
    const group = groups.get(directory);
    check(group, 'PSF_DRIVER');
    let resources: HeartbeatResource[];
    try {
      resources = await scanHeartbeatResources(
        entry.source,
        entry.path,
        report,
        checkpoint,
      );
    } catch (error) {
      if (error instanceof FormatError && error.code === 'UNSUPPORTED_XA_FORM2')
        continue;
      throw error;
    }
    candidateCount += resources.length;
    check(candidateCount <= 20000, 'TOO_MANY', 'HeartBeat resources');
    group.resources.push(...resources);
  }
  const assets: AudioAsset[] = [];
  const warnings: AudioImport['warnings'] = [];
  for (const [directory, group] of groups) {
    await checkpoint();
    const resources = await uniqueResources(
      group.resources,
      report,
      checkpoint,
    );
    const program =
      group.executables.length === 1 ? group.executables[0] : undefined;
    if (!program)
      warnings.push({
        code: 'PSF_DRIVER',
        detail: directory + ': Ambiguous HeartBeat executable',
      });
    const bankResources = resources.filter((resource) =>
      resource.banks.some((bank) => bank.waveSize),
    );
    for (const sequence of resources.filter(
      (resource) => resource.sequenceSize,
    )) {
      await checkpoint();
      const association = await associatedBanks(
        sequence,
        bankResources,
        report,
        checkpoint,
      );
      const name = resourceName(sequence);
      const banks = association.banks;
      const heartbeat: HeartbeatPlayback | undefined =
        banks && program
          ? {
              executable: program.entry.source,
              driver: program.driver,
              sequence,
              banks,
            }
          : undefined;
      const dependencies = [
        { name, source: sequence.source, size: sequence.size },
        ...group.executables.map(({ entry }) => ({
          name: entry.path,
          source: entry.source,
          size: entry.size,
        })),
        ...(banks || [])
          .filter((bank) => bank !== sequence)
          .map((bank) => ({
            name: resourceName(bank),
            source: bank.source,
            size: bank.size,
          })),
      ];
      if (association.error)
        warnings.push({
          code: 'HEARTBEAT_BANK',
          detail: name + ': ' + association.error,
        });
      assets.push({
        source: sequence.source,
        size: sequence.size,
        name,
        format: 'HEARTBEAT',
        kind: 'sequence',
        playable: !!heartbeat,
        heartbeat,
        gameAudio: true,
        dependencies,
      });
    }
  }
  return assets.length ? { assets, warnings } : null;
}

export function checkHeartbeatCurrent(options: DecoderOptions) {
  check(
    !options.signal?.aborted &&
      !options.cancelled?.() &&
      !options.isCancelled?.(),
    'CANCELLED',
  );
}

export async function readHeartbeatRegion(
  source: ByteSource,
  offset: number,
  length: number,
  options: DecoderOptions,
) {
  bounds(source.size, offset, length);
  check(length <= 2099200, 'TOO_LARGE', 'HeartBeat resource');
  const bytes = new Uint8Array(length);
  for (let at = 0; at < length; at += 65536) {
    checkHeartbeatCurrent(options);
    bytes.set(
      await readAudio(source, offset + at, Math.min(65536, length - at)),
      at,
    );
  }
  return bytes;
}
