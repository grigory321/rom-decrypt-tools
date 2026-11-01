import { bounds, check } from './binary.js';
import type {
  ByteSource,
  CompanionFile,
  Diagnostic,
  PcmData,
  Progress,
  SelectedFile,
  TrackMetadata,
} from './contracts.js';
import type {
  ContentsMetadata,
  ConversionOutput,
  EmptyResult,
  FiniteOutput,
  LiveBlock,
  LiveSeek,
  LiveSession,
  LoadResult,
  RomMetadata,
  RpcError,
  RpcMethod,
  RpcRequest,
  RpcResults,
  StreamedOutput,
  WorkerFileInput,
} from './rpc-types.js';

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function integer(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
}

function finite(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value);
}

function optionalString(value: unknown): value is string | undefined {
  return value === undefined || typeof value === 'string';
}

function optionalNumber(value: unknown): value is number | undefined {
  return value === undefined || finite(value);
}

function nullableLength(value: unknown): value is number | null {
  return value === null || integer(value);
}

function isDiagnostic(value: unknown): value is Diagnostic {
  return (
    record(value) &&
    typeof value.code === 'string' &&
    optionalString(value.detail)
  );
}

function isProgress(value: unknown): value is Progress {
  return (
    record(value) &&
    typeof value.phase === 'string' &&
    (value.value === undefined ||
      value.value === null ||
      finite(value.value)) &&
    (value.count === undefined || integer(value.count)) &&
    optionalString(value.detail)
  );
}

function isRpcError(value: unknown): value is RpcError {
  return (
    record(value) &&
    typeof value.code === 'string' &&
    optionalString(value.detail) &&
    optionalString(value.message)
  );
}

function isTrack(value: unknown): value is TrackMetadata {
  if (!record(value)) return false;
  const audio = value.audio;
  return (
    typeof value.id === 'string' &&
    typeof value.group === 'string' &&
    typeof value.name === 'string' &&
    typeof value.format === 'string' &&
    (value.kind === 'sequence' ||
      value.kind === 'stream' ||
      value.kind === 'sample') &&
    integer(value.size) &&
    integer(value.zipSizeBound) &&
    optionalString(value.zipDependencyKey) &&
    typeof value.source === 'string' &&
    typeof value.playable === 'boolean' &&
    typeof value.sourceArchive === 'boolean' &&
    (audio === undefined ||
      (record(audio) &&
        finite(audio.sampleRate) &&
        integer(audio.channels) &&
        nullableLength(audio.length) &&
        (audio.loop === undefined || typeof audio.loop === 'boolean')))
  );
}

function isPcm(value: unknown): value is PcmData {
  return (
    record(value) &&
    Array.isArray(value.channels) &&
    value.channels.length <= 8 &&
    value.channels.every(
      (channel: unknown) => channel instanceof Float32Array,
    ) &&
    finite(value.sampleRate) &&
    value.sampleRate > 0 &&
    (value.loop === undefined || typeof value.loop === 'boolean') &&
    (value.loopStart === undefined || integer(value.loopStart)) &&
    (value.loopEnd === undefined || nullableLength(value.loopEnd)) &&
    optionalString(value.engine) &&
    (value.warnings === undefined ||
      (Array.isArray(value.warnings) && value.warnings.every(isDiagnostic)))
  );
}

function isLiveBlock(value: unknown): value is LiveBlock {
  return (
    isPcm(value) &&
    record(value) &&
    typeof value.done === 'boolean' &&
    integer(value.frame) &&
    nullableLength(value.length) &&
    integer(value.loopStart)
  );
}

function isStreamedOutput(value: unknown): value is StreamedOutput {
  return (
    record(value) &&
    typeof value.job === 'string' &&
    typeof value.filename === 'string' &&
    nullableLength(value.size) &&
    (value.estimatedSize === undefined || integer(value.estimatedSize)) &&
    optionalString(value.mime) &&
    value.blob === undefined
  );
}

function isFiniteOutput(value: unknown): value is FiniteOutput {
  return isStreamedOutput(value) && integer(value.size);
}

function isConversion(value: unknown): value is ConversionOutput {
  return (
    isFiniteOutput(value) &&
    record(value) &&
    typeof value.format === 'string' &&
    typeof value.titleId === 'string' &&
    Array.isArray(value.warnings) &&
    value.warnings.every((warning: unknown) => typeof warning === 'string')
  );
}

function isRom(value: unknown): value is RomMetadata {
  return (
    record(value) &&
    typeof value.id === 'string' &&
    typeof value.name === 'string' &&
    integer(value.size) &&
    typeof value.format === 'string' &&
    typeof value.titleId === 'string' &&
    typeof value.encrypted === 'boolean' &&
    integer(value.count)
  );
}

function isContents(value: unknown): value is ContentsMetadata {
  return (
    record(value) &&
    typeof value.session === 'string' &&
    typeof value.format === 'string' &&
    optionalString(value.titleId) &&
    Array.isArray(value.entries) &&
    value.entries.every(
      (entry: unknown) =>
        record(entry) &&
        integer(entry.id) &&
        typeof entry.path === 'string' &&
        integer(entry.size) &&
        typeof entry.kind === 'string',
    )
  );
}

function isLoad(value: unknown): value is LoadResult {
  return (
    record(value) &&
    typeof value.group === 'string' &&
    Array.isArray(value.tracks) &&
    value.tracks.every(isTrack) &&
    Array.isArray(value.warnings) &&
    value.warnings.every(isDiagnostic)
  );
}

function isLiveSession(value: unknown): value is LiveSession {
  if (!record(value)) return false;
  const info = value.info;
  return (
    typeof value.session === 'string' &&
    finite(value.sampleRate) &&
    nullableLength(value.length) &&
    typeof value.loop === 'boolean' &&
    integer(value.loopStart) &&
    nullableLength(value.loopEnd) &&
    (info === null ||
      (record(info) &&
        typeof info.title === 'string' &&
        typeof info.game === 'string' &&
        typeof info.artist === 'string'))
  );
}

function isLiveSeek(value: unknown): value is LiveSeek {
  return record(value) && integer(value.frame) && finite(value.sampleRate);
}

function isEmpty(value: unknown): value is EmptyResult {
  return record(value) && Object.keys(value).length === 0;
}

function validated<T>(
  value: unknown,
  guard: (candidate: unknown) => candidate is T,
): T {
  check(guard(value), 'REQUEST', 'Invalid worker response');
  return value;
}

const resultParsers: { [K in RpcMethod]: (value: unknown) => RpcResults[K] } = {
  'inputs-open': (value) =>
    validated(
      value,
      (candidate): candidate is RpcResults['inputs-open'] =>
        record(candidate) && typeof candidate.selection === 'string',
    ),
  'inputs-close': (value) => validated(value, isEmpty),
  load: (value) => validated(value, isLoad),
  cancelLoad: (value) => validated(value, isEmpty),
  inspect: (value) => validated(value, isRom),
  convert: (value) => validated(value, isConversion),
  'contents-open': (value) => validated(value, isContents),
  'contents-preview': (value) =>
    validated(
      value,
      (candidate): candidate is Uint8Array => candidate instanceof Uint8Array,
    ),
  'contents-file': (value) => validated(value, isFiniteOutput),
  'contents-clear': (value) => validated(value, isEmpty),
  'contents-zip': (value) => validated(value, isFiniteOutput),
  cancelConversion: (value) => validated(value, isEmpty),
  chunk: (value) =>
    validated(
      value,
      (candidate): candidate is Uint8Array => candidate instanceof Uint8Array,
    ),
  release: (value) => validated(value, isEmpty),
  removeRom: (value) => validated(value, isEmpty),
  clearKeys: (value) =>
    validated(
      value,
      (candidate): candidate is RpcResults['clearKeys'] =>
        record(candidate) && integer(candidate.count),
    ),
  remove: (value) => validated(value, isEmpty),
  'live-open': (value) => validated(value, isLiveSession),
  'live-read': (value) => validated(value, isLiveBlock),
  'live-input': (value) => validated(value, isEmpty),
  'live-seek': (value) => validated(value, isLiveSeek),
  'live-close': (value) => validated(value, isEmpty),
  render: (value) => validated(value, isPcm),
  cancelExport: (value) => validated(value, isEmpty),
  export: (value) => validated(value, isStreamedOutput),
  zip: (value) => validated(value, isFiniteOutput),
  archive: (value) => validated(value, isFiniteOutput),
};

export function parseRpcResult<K extends RpcMethod>(
  type: K,
  value: unknown,
): RpcResults[K] {
  return resultParsers[type](value);
}

export type RpcEnvelope =
  | { fatal: RpcError }
  | { id: number; progress: Progress }
  | { id: number; error: RpcError }
  | { id: number; result: unknown };

export function parseRpcEnvelope(value: unknown): RpcEnvelope {
  if (record(value) && 'fatal' in value) {
    check(
      !('id' in value) &&
        !('progress' in value) &&
        !('error' in value) &&
        !('result' in value),
      'REQUEST',
      'Invalid fatal worker envelope',
    );
    return { fatal: validated(value.fatal, isRpcError) };
  }
  check(
    record(value) && integer(value.id),
    'REQUEST',
    'Invalid worker envelope',
  );
  const variants =
    Number('progress' in value) +
    Number('error' in value) +
    Number('result' in value);
  check(variants === 1, 'REQUEST', 'Invalid worker envelope payload');
  if ('progress' in value)
    return { id: value.id, progress: validated(value.progress, isProgress) };
  if ('error' in value)
    return { id: value.id, error: validated(value.error, isRpcError) };
  return { id: value.id, result: value.result };
}

export function rpcMessageId(value: unknown): number {
  return record(value) && integer(value.id) ? value.id : 0;
}

function text(value: unknown): string {
  check(typeof value === 'string', 'REQUEST');
  return value;
}

function numberOption(value: unknown): number | undefined {
  check(optionalNumber(value), 'REQUEST');
  return value;
}

function stringOption(value: unknown): string | undefined {
  check(optionalString(value), 'REQUEST');
  return value;
}

function booleanOption(value: unknown): boolean | undefined {
  check(value === undefined || typeof value === 'boolean', 'REQUEST');
  return value;
}

function sourceRecord(value: unknown, size: number): ByteSource {
  check(record(value), 'REQUEST');
  if (typeof value.read === 'function') {
    const read = value.read;
    return {
      size,
      async read(offset, length) {
        bounds(size, offset, length);
        const result: unknown = await Reflect.apply(read, value, [
          offset,
          length,
        ]);
        check(
          result instanceof Uint8Array && result.length === length,
          'BOUNDS',
        );
        return result;
      },
    };
  }
  check(typeof value.slice === 'function', 'REQUEST');
  const slice = value.slice;
  return {
    size,
    async read(offset, length) {
      bounds(size, offset, length);
      const part: unknown = Reflect.apply(slice, value, [
        offset,
        offset + length,
      ]);
      check(record(part) && typeof part.arrayBuffer === 'function', 'BOUNDS');
      const result: unknown = await Reflect.apply(part.arrayBuffer, part, []);
      check(
        result instanceof ArrayBuffer && result.byteLength === length,
        'BOUNDS',
      );
      return new Uint8Array(result);
    },
  };
}

function workerFile(value: unknown): WorkerFileInput {
  if (typeof File !== 'undefined' && value instanceof File) return value;
  check(
    record(value) && typeof value.name === 'string' && integer(value.size),
    'REQUEST',
  );
  const backing =
    'source' in value
      ? value.source
      : 'blob' in value
        ? value.blob
        : 'file' in value
          ? value.file
          : value;
  check(record(backing) && backing.size === value.size, 'REQUEST');
  return {
    name: value.name,
    size: value.size,
    path: stringOption(value.path),
    source: sourceRecord(backing, value.size),
  };
}

function selectedFile(value: unknown): SelectedFile {
  check(
    record(value) &&
      typeof Blob !== 'undefined' &&
      typeof File !== 'undefined' &&
      value.file instanceof Blob,
    'REQUEST',
  );
  const name = text(value.name);
  const file =
    value.file instanceof File ? value.file : new File([value.file], name);
  return {
    file,
    name,
    path: stringOption(value.path),
    webkitRelativePath: stringOption(value.webkitRelativePath),
  };
}

function companion(value: unknown): CompanionFile {
  if (typeof File !== 'undefined' && value instanceof File) return value;
  check(record(value), 'REQUEST');
  if ('file' in value) return selectedFile(value);
  const name = stringOption(value.name),
    path = stringOption(value.path);
  const backing =
    'source' in value ? value.source : 'blob' in value ? value.blob : value;
  check(record(backing) && integer(backing.size), 'REQUEST');
  return { source: sourceRecord(backing, backing.size), name, path };
}

function companions(value: unknown): CompanionFile[] | undefined {
  if (value === undefined) return undefined;
  check(Array.isArray(value), 'REQUEST');
  check(value.length <= 200000, 'TOO_MANY');
  return value.map(companion);
}

function contentEntry(value: unknown): number {
  check(integer(value), 'CONTENT_ENTRY');
  return value;
}

export function parseWorkerRequest(value: unknown): RpcRequest {
  check(
    record(value) && integer(value.id) && typeof value.type === 'string',
    'REQUEST',
  );
  const id = value.id;
  switch (value.type) {
    case 'inputs-open':
      check(Array.isArray(value.files), 'REQUEST');
      check(value.files.length <= 200000, 'TOO_MANY');
      return { id, type: value.type, files: value.files.map(selectedFile) };
    case 'inputs-close':
      return { id, type: value.type, selection: text(value.selection) };
    case 'load': {
      const selection = stringOption(value.selection);
      const fileIndex = numberOption(value.fileIndex);
      check(
        value.file !== undefined ||
          (selection !== undefined &&
            fileIndex !== undefined &&
            integer(fileIndex)),
        'REQUEST',
      );
      return {
        id,
        type: value.type,
        selection,
        fileIndex,
        file: value.file === undefined ? undefined : workerFile(value.file),
        companions: companions(value.companions),
        sourcePath: stringOption(value.sourcePath),
      };
    }
    case 'inspect':
      return { id, type: value.type, file: workerFile(value.file) };
    case 'convert':
      check(
        value.target === 'decrypt' ||
          value.target === 'cia' ||
          value.target === '3ds',
        'REQUEST',
      );
      return {
        id,
        type: value.type,
        rom: text(value.rom),
        target: value.target,
      };
    case 'contents-open':
      return {
        id,
        type: value.type,
        file:
          record(value.file) && 'file' in value.file
            ? selectedFile(value.file)
            : workerFile(value.file),
        companions: companions(value.companions),
        sourcePath: stringOption(value.sourcePath),
        directory: booleanOption(value.directory),
      };
    case 'contents-preview':
    case 'contents-file':
      return {
        id,
        type: value.type,
        session: text(value.session),
        entry: contentEntry(value.entry),
      };
    case 'contents-zip': {
      const all = booleanOption(value.all);
      let entries: number[] | undefined;
      if (value.entries !== undefined) {
        check(Array.isArray(value.entries), 'REQUEST');
        check(value.entries.length <= 200000, 'NO_SELECTION');
        entries = value.entries.map(contentEntry);
      }
      check(all === true || (entries && entries.length > 0), 'NO_SELECTION');
      return {
        id,
        type: value.type,
        session: text(value.session),
        all,
        entries,
      };
    }
    case 'chunk':
      check(integer(value.offset), 'REQUEST');
      return {
        id,
        type: value.type,
        job: text(value.job),
        offset: value.offset,
      };
    case 'release':
      return { id, type: value.type, job: text(value.job) };
    case 'removeRom':
      return { id, type: value.type, rom: text(value.rom) };
    case 'remove':
      return { id, type: value.type, group: text(value.group) };
    case 'live-open':
      return {
        id,
        type: value.type,
        track: text(value.track),
        sampleRate: numberOption(value.sampleRate),
      };
    case 'live-read':
      return { id, type: value.type, session: text(value.session) };
    case 'live-input':
      return {
        id,
        type: value.type,
        session: text(value.session),
        buttons: validated(
          value.buttons,
          (buttons): buttons is number => integer(buttons) && buttons <= 255,
        ),
      };
    case 'live-seek':
      return {
        id,
        type: value.type,
        session: text(value.session),
        seconds: validated(value.seconds, finite),
      };
    case 'live-close':
      return { id, type: value.type, session: stringOption(value.session) };
    case 'render':
      return {
        id,
        type: value.type,
        track: text(value.track),
        seconds: numberOption(value.seconds),
      };
    case 'export':
      check(
        value.format === 'original' ||
          value.format === 'wav' ||
          value.format === 'mp3',
        'REQUEST',
      );
      return {
        id,
        type: value.type,
        track: text(value.track),
        format: value.format,
        bitrate: numberOption(value.bitrate),
        seconds: numberOption(value.seconds),
        fade: numberOption(value.fade),
        wholeSong: booleanOption(value.wholeSong),
      };
    case 'zip':
      check(Array.isArray(value.tracks), 'REQUEST');
      check(
        value.tracks.length > 0 && value.tracks.length <= 20000,
        'NO_SELECTION',
      );
      return { id, type: value.type, tracks: value.tracks.map(text) };
    case 'archive':
      return { id, type: value.type, group: text(value.group) };
    case 'contents-clear':
    case 'cancelLoad':
    case 'cancelConversion':
    case 'clearKeys':
    case 'cancelExport':
      return { id, type: value.type };
    default:
      check(false, 'REQUEST');
  }
}
