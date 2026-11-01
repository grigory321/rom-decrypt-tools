import { WorkerPlayback } from './worker/playback.js';
import { isProgramAudio } from './audio-policy.js';
import {
  safeFilename as safe,
  originalAudioExtension,
} from './output-names.js';
import type {
  ArchiveEntry,
  ByteSource,
  Archive,
  AudioAsset,
  AudioImport,
  CompanionFile,
  KeySet,
  LibraryTrack,
  OutputSource,
  PcmData,
  Progress,
  ProgressReporter,
  SelectedFile,
  SourceInput,
  TrackMetadata,
} from './contracts.js';
import type {
  FiniteOutput,
  LoadResult,
  RpcResult,
  WorkerFileInput,
} from './rpc-types.js';
import { parseWorkerRequest, rpcMessageId } from './rpc-codec.js';
import { standardKeys, automaticKeys } from './defaults.js';
import { check, arraySource } from './binary.js';
import { createTrackDecoder } from './audio-decoder.js';
import { sourceAudioFormats } from './audio-formats.js';
import { asSource, sourceIncludes, sourceName } from './source-input.js';
import { isFileReadError } from './errors.js';

type ContentArchive = Archive & { name: string };
interface AudioGroup {
  file: WorkerFileInput;
  path: string;
  inputs: ReadonlyMap<string, object | null>;
  assets: AudioAsset[];
  dispose?: () => Promise<void>;
}

const tracks = new Map<string, LibraryTrack>(),
  groups = new Map<string, AudioGroup>(),
  roms = new Map<string, WorkerFileInput>(),
  jobs = new Map<string, OutputSource>(),
  inputSelections = new Map<string, SelectedFile[]>(),
  contentArchives = new Map<string, ContentArchive>();
const companionInputCache = new WeakMap<
  readonly CompanionFile[],
  ReadonlyMap<string, object | null>
>();

let keys: KeySet = standardKeys(),
  next = 1,
  epoch = 0,
  loadEpoch = 0,
  conversionEpoch = 0,
  contentEpoch = 0,
  exportEpoch = 0;

const playback = new WorkerPlayback(() => 'p' + next++);
let activeLoad: AbortController | null = null;

void import('./zip-storage.js')
  .then(({ cleanupZipStorage }) => cleanupZipStorage())
  .catch(() => {});

const metadata = (t: LibraryTrack): TrackMetadata => ({
  id: t.id,
  group: t.group,
  name: t.name,
  format: t.format,
  kind: t.kind,
  size: t.raw?.length || t.asset.size,
  zipSizeBound:
    t.asset.psf || t.asset.dependencies
      ? (t.asset.psf?.dependencies ?? t.asset.dependencies ?? []).reduce(
          (size, file) => size + file.size + file.name.length * 8 + 4096,
          4096,
        )
      : (t.raw?.length || t.asset.size) +
        (t.asset.format === 'SDAT' ? t.asset.size : 0) +
        4096,
  zipDependencyKey: t.asset.dependencies
    ? t.group +
      ':' +
      JSON.stringify(t.asset.dependencies.map((file) => file.name))
    : undefined,
  source: t.source,
  playable: t.playable,
  sourceArchive:
    t.asset?.format === 'SDAT' ||
    (t.asset?.psf?.dependencies.length || 0) > 1 ||
    (!!t.asset.cseq && !!t.asset.dependencies?.length) ||
    (t.asset.dependencies?.length || 0) > 1,
  audio: t.audio,
});

function inputIdentity(input: SourceInput): object {
  if ('source' in input) return input.source;
  if ('file' in input) return input.file;
  if ('blob' in input) return input.blob;
  return input;
}

function inputPath(path: string): string {
  return path
    .replaceAll('\\', '/')
    .replace(/^(?:\.\/)+/, '')
    .toLowerCase();
}

function importInputs(
  file: WorkerFileInput,
  path: string,
  companions: readonly CompanionFile[],
): ReadonlyMap<string, object | null> {
  let related = companionInputCache.get(companions);
  if (!related) {
    const indexed = new Map<string, object | null>();
    for (const companion of companions) {
      const key = inputPath(sourceName(companion));
      const identity = inputIdentity(companion);
      if (!indexed.has(key)) indexed.set(key, identity);
      else if (indexed.get(key) !== identity) indexed.set(key, null);
    }
    related = indexed;
    companionInputCache.set(companions, related);
  }
  const key = inputPath(path);
  const identity = inputIdentity(file);
  if (related.get(key) === identity) return related;
  const inputs = new Map(related);
  inputs.set(key, inputs.has(key) ? null : identity);
  return inputs;
}

function sameInputs(
  left: ReadonlyMap<string, object | null>,
  right: ReadonlyMap<string, object | null>,
): boolean {
  if (left.size !== right.size) return false;
  for (const [path, identity] of left)
    if (!identity || right.get(path) !== identity) return false;
  return true;
}

function sameCseqResources(
  left: AudioAsset,
  right: AudioAsset,
  leftInputs: ReadonlyMap<string, object | null>,
  rightInputs: ReadonlyMap<string, object | null>,
): boolean {
  const a = left.cseq;
  const b = right.cseq;
  if (
    !a?.identity ||
    a.identity !== b?.identity ||
    left.size !== right.size ||
    left.song !== right.song ||
    a.startOffset !== b.startOffset ||
    a.volume !== b.volume ||
    a.channelPriority !== b.channelPriority ||
    a.allocatedTracks !== b.allocatedTracks ||
    a.banks.length !== b.banks.length ||
    a.banks.some((bank, index) => !!bank !== !!b.banks[index])
  )
    return false;
  const resources = (asset: AudioAsset) =>
    (asset.dependencies ?? [])
      .filter((file) => file.source !== asset.source)
      .map((file) => ({ path: inputPath(file.name), size: file.size }))
      .sort((left, right) => left.path.localeCompare(right.path));
  const leftResources = resources(left);
  const rightResources = resources(right);
  return (
    leftResources.length > 0 &&
    leftResources.length === rightResources.length &&
    leftResources.every((resource, index) => {
      const other = rightResources[index];
      const identity = leftInputs.get(resource.path);
      return (
        other?.path === resource.path &&
        other.size === resource.size &&
        !!identity &&
        rightInputs.get(resource.path) === identity
      );
    })
  );
}

async function releaseArchives() {
  const archives = [...contentArchives.values()];
  contentArchives.clear();
  await Promise.all(archives.map((archive) => archive.dispose?.()));
}

async function releaseGroups() {
  const imported = [...groups.values()];
  groups.clear();
  await Promise.all(imported.map((group) => group.dispose?.()));
}

async function load(
  file: WorkerFileInput,
  report: ProgressReporter,
  companions: CompanionFile[] = [],
  sourcePath = file.name,
): Promise<LoadResult> {
  activeLoad?.abort();
  const controller = new AbortController();
  activeLoad = controller;
  try {
    check(file.size > 0, 'FILE_EMPTY');
    return await loadAudioFile(
      file,
      report,
      controller.signal,
      companions,
      sourcePath,
    );
  } finally {
    if (activeLoad === controller) activeLoad = null;
  }
}

async function loadAudioFile(
  file: WorkerFileInput,
  report: ProgressReporter,
  signal: AbortSignal,
  companions: CompanionFile[],
  sourcePath: string,
): Promise<LoadResult> {
  const inputs = importInputs(file, sourcePath, companions);
  for (const [group, imported] of groups) {
    if (
      inputIdentity(imported.file) === inputIdentity(file) &&
      inputPath(imported.path) === inputPath(sourcePath) &&
      sameInputs(imported.inputs, inputs)
    )
      return {
        group,
        tracks: [...tracks.values()]
          .filter((track) => track.group === group)
          .map(metadata),
        warnings: [],
      };
  }
  const generation = epoch,
    importGeneration = ++loadEpoch,
    checkCurrent = () =>
      check(
        generation === epoch && importGeneration === loadEpoch,
        'CANCELLED',
      ),
    notify = (value: Progress) => {
      checkCurrent();
      report({ ...value, detail: file.name });
    };
  let committed = false;
  const original = asSource(file, 'INVALID_SOURCE', signal);
  const source: ByteSource = {
    size: original.size,
    async read(offset, length) {
      if (!committed) checkCurrent();
      const bytes = await original.read(offset, length);
      if (!committed) checkCurrent();
      return bytes;
    },
  };
  const { readSource: readSource } = await import('./containers.js'),
    { parseSdat: parseSdat } = await import('./nitro.js');
  if (/\.(cia|3ds|cci|cxi|cfa|ncch|romfs)$/i.test(file.name)) {
    keys = await automaticKeys();
  }
  const { readPlatformAudio } = await import('./platform-files.js');
  const discovery: ProgressReporter = (update) =>
    notify({
      ...update,
      value: typeof update.value === 'number' ? update.value * 0.8 : null,
    });
  const related = companions
    .filter((item) => !sourceIncludes(item, file))
    .map((item) => ({
      source: asSource(item, 'INVALID_SOURCE', signal),
      name: sourceName(item, true),
      path: sourceName(item),
    }));
  const result: AudioImport =
    (await readPlatformAudio(source, sourcePath, related, discovery)) ||
    (await readSource(source, sourcePath, keys, discovery));
  const group = 'g' + next++,
    added: LibraryTrack[] = [],
    reused: LibraryTrack[] = [],
    assets: AudioAsset[] = [],
    warnings = [...result.warnings];
  const importedCseq = new Map<string, LibraryTrack[]>();
  for (const track of tracks.values()) {
    const identity = track.asset.cseq?.identity;
    if (!identity) continue;
    const candidates = importedCseq.get(identity) ?? [];
    candidates.push(track);
    importedCseq.set(identity, candidates);
  }
  try {
    checkCurrent();
    for (let index = 0; index < result.assets.length; index++) {
      const asset = result.assets[index];
      if (index % 32 === 0) {
        notify({
          phase: 'scan',
          value: 0.8 + (0.05 * index) / result.assets.length,
        });
        await new Promise((resolve) => setTimeout(resolve, 0));
        checkCurrent();
      }
      try {
        if (asset.cseq?.identity) {
          const existing = importedCseq
            .get(asset.cseq.identity)
            ?.find((track) => {
              const imported = groups.get(track.group);
              return (
                imported &&
                sameCseqResources(track.asset, asset, imported.inputs, inputs)
              );
            });
          if (existing) {
            reused.push(existing);
            continue;
          }
        }
        if (asset.format === 'SDAT') {
          check(asset.size <= 128 * 1024 * 1024, 'TOO_LARGE');
          const raw = await asset.source.read(0, asset.size);
          checkCurrent();
          for (const t of parseSdat(raw)) {
            added.push({
              ...t,
              id: 't' + next++,
              group,
              source: file.name,
              asset,
            });
          }
        } else {
          const t: LibraryTrack = {
            id: 't' + next++,
            group,
            source: file.name,
            name: asset.name.split('/').at(-1) ?? '',
            format: asset.format,
            kind:
              asset.kind === 'sample'
                ? 'sample'
                : asset.kind === 'sequence' || asset.format.endsWith('SEQ')
                  ? 'sequence'
                  : 'stream',
            asset,
            playable: asset.playable ?? !asset.format.endsWith('SEQ'),
          };
          if (['GBA', 'SEQ', 'SEP', 'CSEQ', 'HEARTBEAT'].includes(asset.format))
            t.audio = {
              sampleRate: ['GBA', 'CSEQ'].includes(asset.format)
                ? 32768
                : 44100,
              channels: 2,
              length: null,
            };
          added.push(t);
        }
        assets.push(asset);
      } catch (error) {
        const failure = errorFields(error);
        if (
          isFileReadError(error) ||
          ['CANCELLED', 'TOO_LARGE', 'TOO_MANY', 'DEPTH'].includes(failure.code)
        )
          throw error;
        warnings.push({
          code: failure.code === 'ERROR' ? 'INVALID_AUDIO' : failure.code,
          detail: asset.name + (failure.detail ? ': ' + failure.detail : ''),
        });
      }
    }
    for (let index = 0; index < added.length; index++) {
      const track = added[index];
      if (index % 32 === 0) {
        notify({ phase: 'scan', value: 0.85 + (0.15 * index) / added.length });
        await new Promise((resolve) => setTimeout(resolve, 0));
      }
      checkCurrent();
      if (
        !['stream', 'sample'].includes(track.kind) ||
        !sourceAudioFormats.has(track.format) ||
        isProgramAudio(track.format)
      )
        continue;
      try {
        const decoder = await createTrackDecoder(track);
        checkCurrent();
        track.audio = {
          sampleRate: decoder.sampleRate,
          channels: decoder.channels,
          length: decoder.length,
          loop: decoder.loop,
        };
      } catch (error) {
        if (isFileReadError(error) || errorFields(error).code === 'CANCELLED')
          throw error;
      }
    }
    checkCurrent();
    if (!added.length && reused.length) {
      await result.dispose?.();
      committed = true;
      const existing = reused[0];
      return {
        group: existing.group,
        tracks: reused
          .filter((track) => track.group === existing.group)
          .map(metadata),
        warnings,
      };
    }
    check(
      added.length > 0,
      'NO_AUDIO',
      warnings
        .slice(0, 8)
        .map((warning) => `${warning.detail} (${warning.code})`)
        .join('\n'),
    );
    groups.set(group, {
      file,
      path: sourcePath,
      inputs,
      assets,
      dispose: result.dispose,
    });
    committed = true;
    for (const t of added) {
      tracks.set(t.id, t);
    }
    notify({ phase: 'scan', value: 1 });
    return {
      group,
      tracks: added.map(metadata),
      warnings,
    };
  } finally {
    if (!committed) await result.dispose?.();
  }
}

async function render(
  id: string,
  seconds: number | undefined,
  report: ProgressReporter = () => {},
): Promise<PcmData & { length?: number }> {
  const t = tracks.get(id);
  check(t, 'TRACK_GONE');
  check(t.playable, 'UNSUPPORTED_SEQUENCE');
  if (t.kind === 'sequence' && t.sequence) {
    const { renderEngine: renderEngine } = await import('./engine.js');
    return renderEngine(t, seconds, 32768, report);
  }
  const decoder = await createTrackDecoder(t);
  const length =
    decoder.length ?? Math.floor((seconds || 60) * decoder.sampleRate);
  const channels = decoder.channels || 2;
  check(
    Number.isSafeInteger(length) &&
      length >= 0 &&
      length * channels * 4 <= 128 * 1024 ** 2,
    'TOO_LARGE',
  );
  const output = Array.from(
    { length: channels },
    () => new Float32Array(length),
  );
  let offset = 0;
  while (offset < length) {
    check(tracks.get(id) === t, 'CANCELLED');
    const pcm = await decoder.read(Math.min(16384, length - offset));
    const frames = pcm.channels[0]?.length || 0;
    for (let channel = 0; channel < channels; channel++)
      output[channel].set(pcm.channels[channel], offset);
    offset += frames;
    report({ phase: 'render', value: length ? offset / length : 1 });
    if (pcm.done || !frames) break;
    await new Promise((resolve) => setTimeout(resolve, 0));
  }
  return {
    sampleRate: decoder.sampleRate,
    channels: output.map((channel) => channel.subarray(0, offset)),
    length: offset,
    loop: decoder.loop,
    loopStart: decoder.loopStart || 0,
    loopEnd: decoder.loopEnd || offset,
  };
}

function findContent(session: string, entryId: number) {
  const archive = contentArchives.get(session);
  check(archive, 'TRACK_GONE');
  check(
    Number.isSafeInteger(entryId) &&
      entryId >= 0 &&
      entryId < archive.entries.length,
    'CONTENT_ENTRY',
  );
  const entry = archive.entries[entryId];
  check(entry && entry.kind !== 'directory', 'CONTENT_ENTRY');
  return entry;
}

function originalExtension(track: LibraryTrack) {
  return originalAudioExtension(track.asset.name, track.format, !track.raw);
}

async function audioArchive(
  entries: ArchiveEntry[],
  filename: string,
  current: () => void,
): Promise<FiniteOutput> {
  const { createZipSource } = await import('./zip-source.js');
  current();
  const source = createZipSource(entries, { checkCurrent: current });
  const job = 'b' + next++;
  jobs.set(job, source);
  return {
    job,
    filename,
    size: source.size,
    estimatedSize: source.size,
    mime: 'application/zip',
  };
}

function addAudioDependencies(
  entries: ArchiveEntry[],
  asset: AudioAsset,
  prefix: string,
  seen: Set<string | AudioAsset>,
) {
  const files = asset.psf?.dependencies ?? asset.dependencies;
  if (!files) return false;
  for (const file of files) {
    const path = prefix + file.name;
    if (seen.has(path)) continue;
    seen.add(path);
    entries.push({ path, kind: 'file', size: file.size, source: file.source });
  }
  return true;
}

function errorFields(error: unknown): {
  code: string;
  detail: string;
  message: string;
} {
  const code =
    typeof error === 'object' &&
    error !== null &&
    'code' in error &&
    typeof error.code === 'string'
      ? error.code
      : '';
  const detail =
    typeof error === 'object' &&
    error !== null &&
    'detail' in error &&
    typeof error.detail === 'string'
      ? error.detail
      : '';
  return {
    code: code || 'ERROR',
    detail,
    message: code ? '' : error instanceof Error ? error.message : String(error),
  };
}

function transferBuffers(
  channels: (Uint8Array | Float32Array)[],
): ArrayBuffer[] {
  const transfers = new Set<ArrayBuffer>();
  for (const channel of channels)
    if (channel.buffer instanceof ArrayBuffer) transfers.add(channel.buffer);
  return [...transfers];
}

self.onmessageerror = () => {
  epoch++;
  activeLoad?.abort();
  playback.close();
  self.postMessage({ fatal: { code: 'WORKER_MESSAGE' } });
  if (typeof self.close === 'function') self.close();
};

self.onmessage = async (event: MessageEvent<unknown>) => {
  const id = rpcMessageId(event.data),
    generation = epoch;
  let lastProgressAt = -Infinity;
  let lastProgress: Progress | undefined;
  const report: ProgressReporter = (value) => {
    check(generation === epoch, 'CANCELLED');
    const now = Date.now();
    if (
      lastProgress?.phase === value.phase &&
      now - lastProgressAt < 50 &&
      !(value.value === 1 && lastProgress.value !== 1)
    )
      return;
    lastProgressAt = now;
    lastProgress = value;
    self.postMessage({
      id,
      progress: value,
    });
  };
  try {
    const m = parseWorkerRequest(event.data);
    const type = m.type;
    let result: RpcResult;
    if (type === 'inputs-open') {
      check(Array.isArray(m.files) && m.files.length <= 200000, 'TOO_MANY');
      const selection = 'i' + next++;
      inputSelections.set(selection, m.files);
      result = { selection };
    } else if (type === 'inputs-close') {
      inputSelections.delete(m.selection);
      result = {};
    } else if (type === 'load') {
      let companions: CompanionFile[];
      let file = m.file;
      if (m.selection) {
        const selection = inputSelections.get(m.selection);
        check(selection, 'TRACK_GONE');
        companions = selection;
        if (m.fileIndex !== undefined && Number.isInteger(m.fileIndex))
          file = selection[m.fileIndex]?.file;
      } else companions = m.companions || [];
      check(file, 'TRACK_GONE');
      result = await load(file, report, companions, m.sourcePath || file.name);
    } else if (type === 'cancelLoad') {
      loadEpoch++;
      activeLoad?.abort();
      result = {};
    } else if (type === 'inspect') {
      check(m.file.size > 0, 'FILE_EMPTY');
      const { inspectRomFile } = await import('./rom-tools.js');
      const info = await inspectRomFile(m.file, m.file.name, standardKeys());
      check(generation === epoch, 'CANCELLED');
      const rom = 'r' + next++;
      roms.set(rom, m.file);
      result = {
        id: rom,
        name: m.file.name,
        size: m.file.size,
        format: info.format,
        titleId: info.titleId,
        encrypted: info.encrypted,
        count: info.count,
      };
    } else if (type === 'convert') {
      const cg = conversionEpoch,
        file = roms.get(m.rom);
      check(file, 'TRACK_GONE');
      const { prepareRomFile } = await import('./rom-tools.js');
      const notify: ProgressReporter = (p) => {
        check(cg === conversionEpoch, 'CANCELLED');
        report(p);
      };
      const value = await prepareRomFile(
        file,
        file.name,
        m.target,
        undefined,
        notify,
      );
      check(generation === epoch && cg === conversionEpoch, 'CANCELLED');
      const job = 'j' + next++;
      jobs.set(job, value.source);
      result = {
        job,
        filename: value.filename,
        size: value.source.size,
        format: value.format,
        titleId: value.titleId,
        warnings: value.warnings,
      };
    } else if (type === 'contents-open') {
      check(m.directory || asSource(m.file).size > 0, 'FILE_EMPTY');
      const contentGeneration = ++contentEpoch;
      for (const job of jobs.keys()) {
        if (job.startsWith('f')) jobs.delete(job);
      }
      await releaseArchives();
      check(
        generation === epoch && contentGeneration === contentEpoch,
        'CANCELLED',
      );
      const { openContents } = await import('./content-browser.js');
      const notify: ProgressReporter = (progress) => {
        check(contentGeneration === contentEpoch, 'CANCELLED');
        report(progress);
      };
      const archive = await openContents(
        m.file,
        m.sourcePath || m.file.name,
        /\.(nds|srl)$/i.test(m.file.name)
          ? standardKeys()
          : await automaticKeys(),
        notify,
        m.companions || [],
        !!m.directory,
      );
      if (contentGeneration !== contentEpoch) {
        await archive.dispose?.();
        check(false, 'CANCELLED');
      }
      const session = 'a' + next++;
      contentArchives.set(session, { ...archive, name: m.file.name });
      result = {
        session,
        format: archive.format,
        titleId: archive.titleId,
        entries: archive.entries.map((entry, index) => ({
          id: index,
          path: entry.path,
          size: entry.size,
          kind: entry.kind,
        })),
      };
    } else if (type === 'contents-preview') {
      const entry = findContent(m.session, m.entry);
      const bytes = await entry.source.read(0, Math.min(512, entry.size));
      check(contentArchives.has(m.session), 'CANCELLED');
      self.postMessage({ id, result: bytes }, transferBuffers([bytes]));
      return;
    } else if (type === 'contents-file') {
      const entry = findContent(m.session, m.entry);
      const job = 'f' + next++;
      jobs.set(job, entry.source);
      result = {
        job,
        filename: safe(entry.path.split('/').at(-1) ?? ''),
        size: entry.size,
      };
    } else if (type === 'contents-clear') {
      contentEpoch++;
      for (const job of jobs.keys()) {
        if (job.startsWith('f')) jobs.delete(job);
      }
      await releaseArchives();

      result = {};
    } else if (type === 'contents-zip') {
      const archive = contentArchives.get(m.session);
      check(archive, 'TRACK_GONE');
      check(
        m.all === true ||
          (Array.isArray(m.entries) &&
            m.entries.length > 0 &&
            m.entries.length <= 200000),
        'NO_SELECTION',
      );
      const selected =
        m.all === true
          ? archive.entries
          : [...new Set(m.entries ?? [])].map((entry) =>
              findContent(m.session, entry),
            );
      check(selected.length > 0, 'NO_SELECTION');
      const contentGeneration = contentEpoch;
      const { createZipSource } = await import('./zip-source.js');
      const source = createZipSource(selected, {
        checkCurrent: () =>
          check(contentGeneration === contentEpoch, 'CANCELLED'),
      });
      check(contentGeneration === contentEpoch, 'CANCELLED');
      const job = 'f' + next++;
      jobs.set(job, source);
      result = {
        job,
        size: source.size,
        filename: safe(archive.name.replace(/\.[^.]+$/, '')) + '-contents.zip',
      };
    } else if (type === 'cancelConversion') {
      conversionEpoch++;

      for (const job of jobs.keys()) {
        if (job.startsWith('j')) jobs.delete(job);
      }
      result = {};
    } else if (type === 'chunk') {
      const src = jobs.get(m.job);
      check(src, 'TRACK_GONE');
      const chunkSize = src.chunkSize ?? 4 * 1024 * 1024;
      check(
        Number.isSafeInteger(chunkSize) &&
          chunkSize > 0 &&
          chunkSize <= 4 * 1024 * 1024,
        'BOUNDS',
      );
      const bytes = await src.read(
        m.offset,
        src.size === null
          ? chunkSize
          : Math.min(chunkSize, src.size - m.offset),
      );
      check(generation === epoch, 'CANCELLED');
      check(jobs.get(m.job) === src, 'CANCELLED');
      if (typeof src.progress === 'number')
        report({ phase: src.progressPhase ?? 'encode', value: src.progress });
      self.postMessage(
        {
          id,
          result: bytes,
        },
        transferBuffers([bytes]),
      );
      return;
    } else if (type === 'release') {
      jobs.delete(m.job);
      result = {};
    } else if (type === 'removeRom') {
      roms.delete(m.rom);
      result = {};
    } else if (type === 'clearKeys') {
      epoch++;
      activeLoad?.abort();
      inputSelections.clear();
      contentEpoch++;
      keys = standardKeys();
      tracks.clear();
      roms.clear();
      jobs.clear();
      playback.close();
      await Promise.all([releaseGroups(), releaseArchives()]);
      result = {
        count: 0,
      };
    } else if (type === 'remove') {
      for (const [key, t] of tracks) {
        if (t.group === m.group) {
          tracks.delete(key);
        }
      }
      playback.removeGroup(m.group);
      const imported = groups.get(m.group);
      groups.delete(m.group);
      await imported?.dispose?.();
      result = {};
    } else if (type === 'live-open') {
      const track = tracks.get(m.track);
      check(track?.playable, 'TRACK_GONE');
      result = await playback.open(track, m.sampleRate || 32768, () =>
        check(generation === epoch && tracks.has(m.track), 'CANCELLED'),
      );
    } else if (type === 'live-read') {
      const block = await playback.read(m.session);
      self.postMessage({ id, result: block }, transferBuffers(block.channels));
      return;
    } else if (type === 'live-input') {
      await playback.input(m.session, m.buttons);
      result = {};
    } else if (type === 'live-seek') {
      result = await playback.seek(m.session, m.seconds);
    } else if (type === 'live-close') {
      playback.close(m.session);
      result = {};
    } else if (type === 'render') {
      const p = await render(m.track, m.seconds, report);
      check(generation === epoch, 'CANCELLED');
      result = {
        ...p,
      };
      self.postMessage(
        {
          id,
          result,
        },
        transferBuffers(p.channels),
      );
      return;
    } else if (type === 'cancelExport') {
      exportEpoch++;
      for (const job of jobs.keys()) if (job.startsWith('s')) jobs.delete(job);
      result = {};
    } else if (type === 'export') {
      const outputGeneration = ++exportEpoch;
      const track = tracks.get(m.track);
      check(track, 'TRACK_GONE');
      const isCurrent = () =>
        generation === epoch &&
        outputGeneration === exportEpoch &&
        tracks.has(m.track);
      const current = () => check(isCurrent(), 'CANCELLED');
      let output: { source: OutputSource; estimatedSize: number; mime: string };
      let extension: string = m.format;
      if (m.format === 'original') {
        const source = track.raw ? arraySource(track.raw) : track.asset.source;
        output = {
          source,
          estimatedSize: source.size,
          mime: 'application/octet-stream',
        };
        extension = originalExtension(track);
      } else {
        check(track.playable, 'UNSUPPORTED_SEQUENCE');
        report({ phase: 'audio-init', value: null });
        const decoder = await createTrackDecoder(track, 32768, {
          cancelled: () => !isCurrent(),
        });
        current();
        const { createAudioOutput } = await import('./audio-output.js');
        output = await createAudioOutput(decoder, {
          format: m.format,
          bitrate: m.bitrate,
          seconds: m.seconds,
          fade: m.fade || 0,
          wholeSong: m.wholeSong,
          report,
          checkCurrent: current,
        });
      }
      current();
      const job = 's' + next++;
      jobs.set(job, output.source);
      result = {
        job,
        size: output.source.size,
        estimatedSize: output.estimatedSize,
        mime: output.mime,
        filename: safe(track.name.replace(/\.[^.]+$/, '')) + '.' + extension,
      };
    } else if (type === 'zip') {
      check(
        Array.isArray(m.tracks) &&
          m.tracks.length > 0 &&
          m.tracks.length <= 20000,
        'NO_SELECTION',
      );
      const entries: ArchiveEntry[] = [];
      const dependencies = new Set<string | AudioAsset>();
      for (const [index, id] of [...new Set(m.tracks)].entries()) {
        const track = tracks.get(id);
        check(track, 'TRACK_GONE');
        if (
          addAudioDependencies(
            entries,
            track.asset,
            (track.asset.psf ? 'psf/' : 'originals/') + safe(track.group) + '/',
            dependencies,
          )
        )
          continue;
        const source = track.raw ? arraySource(track.raw) : track.asset.source;
        entries.push({
          path:
            safe(index + '_' + track.name.replace(/\.[^.]+$/, '')) +
            '.' +
            originalExtension(track),
          kind: 'file',
          size: source.size,
          source,
        });
        if (track.asset.format === 'SDAT' && !dependencies.has(track.asset)) {
          dependencies.add(track.asset);
          entries.push({
            path:
              'dependencies/' + safe(track.group + '_' + index + '_sound.sdat'),
            kind: 'file',
            size: track.asset.size,
            source: track.asset.source,
          });
        }
      }
      result = await audioArchive(entries, 'romstudio-originals.zip', () =>
        check(generation === epoch, 'CANCELLED'),
      );
    } else if (type === 'archive') {
      const group = groups.get(m.group);
      check(group, 'TRACK_GONE');
      const entries: ArchiveEntry[] = [];
      const dependencies = new Set<string | AudioAsset>();
      for (const [index, asset] of group.assets.entries()) {
        if (
          addAudioDependencies(
            entries,
            asset,
            asset.psf ? 'psf/' : 'originals/',
            dependencies,
          )
        )
          continue;
        entries.push({
          path: safe(index + '_' + asset.name.split('/').at(-1)),
          kind: 'file',
          size: asset.size,
          source: asset.source,
        });
      }
      result = await audioArchive(entries, 'romstudio-source-audio.zip', () =>
        check(generation === epoch && groups.has(m.group), 'CANCELLED'),
      );
    } else {
      check(false, 'REQUEST');
    }
    if (type !== 'clearKeys' && type !== 'remove') {
      check(generation === epoch, 'CANCELLED');
    }
    self.postMessage({
      id,
      result,
    });
  } catch (e) {
    self.postMessage({
      id,
      error: {
        ...errorFields(e),
      },
    });
  }
};
