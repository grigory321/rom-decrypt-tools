import type { ProgressReporter, TrackMetadata } from './contracts.js';
import type {
  DownloadedFile,
  RpcArguments,
  RpcClient,
  SavedOutput,
} from './rpc-types.js';
import { bufferBytes, check, FormatError } from './binary.js';
import { bufferedOutputLimit as blobLimit } from './output-limits.js';

interface OutputWriter {
  write(chunk: Blob | Uint8Array<ArrayBuffer>): Promise<void>;
  close(): Promise<void>;
  abort(): Promise<void>;
}
interface OutputHandle {
  createWritable(): Promise<OutputWriter>;
}
type FilePicker = (options?: {
  suggestedName?: string;
}) => Promise<OutputHandle>;
export interface SaveOptions {
  call: RpcClient;
  download: (file: DownloadedFile) => void;
  onProgress?: ProgressReporter;
  signal?: AbortSignal;
  handle?: OutputHandle;
}
export interface PrepareSaveOptions extends Omit<SaveOptions, 'handle'> {
  filename?: string;
  maximumSize?: number;
  pickFile?: FilePicker;
}

export function audioOutputBound(
  track: Pick<Partial<TrackMetadata>, 'size' | 'audio'>,
  settings: Pick<
    RpcArguments['export'],
    'format' | 'seconds' | 'bitrate' | 'wholeSong'
  >,
) {
  if (settings.format === 'original') return track.size;
  const audio = track.audio;
  if (!audio || !Number.isFinite(audio.sampleRate) || audio.sampleRate <= 0)
    return undefined;
  const frames =
    audio.length === null
      ? Math.floor(
          (settings.wholeSong ? 3600 : (settings.seconds ?? NaN)) *
            audio.sampleRate,
        )
      : audio.length;
  if (!Number.isSafeInteger(frames) || frames < 0) return undefined;
  const channels = Math.min(2, audio.channels);
  if (!Number.isInteger(channels) || channels < 1) return undefined;
  if (settings.format === 'wav') return frames * channels * 2 + 80;
  if (
    settings.format === 'mp3' &&
    typeof settings.bitrate === 'number' &&
    [128, 192, 320].includes(settings.bitrate)
  )
    return (
      Math.ceil((frames / audio.sampleRate) * settings.bitrate * 125 * 1.01) +
      65536
    );
  return undefined;
}

export function zipOutputBound(
  tracks: Pick<TrackMetadata, 'id' | 'zipSizeBound' | 'zipDependencyKey'>[],
) {
  const seen = new Set<string>();
  let size = 4096;
  for (const track of tracks) {
    const key = track.zipDependencyKey ?? track.id;
    if (seen.has(key)) continue;
    seen.add(key);
    size += track.zipSizeBound;
  }
  return size;
}

function chooseDestination(
  pending: Promise<OutputHandle>,
  signal?: AbortSignal,
): Promise<OutputHandle> {
  if (!signal) return pending;
  return new Promise((resolve, reject: (error: unknown) => void) => {
    const cancel = () => {
      signal.removeEventListener('abort', cancel);
      reject(new FormatError('CANCELLED'));
    };
    signal.addEventListener('abort', cancel, { once: true });
    pending.then(
      (handle) => {
        signal.removeEventListener('abort', cancel);
        resolve(handle);
      },
      (error: unknown) => {
        signal.removeEventListener('abort', cancel);
        reject(error);
      },
    );
    if (signal.aborted) cancel();
  });
}

export async function prepareAndSaveOutput(
  prepare: () => Promise<SavedOutput>,
  {
    filename,
    maximumSize,
    pickFile = globalThis.window?.showSaveFilePicker?.bind(globalThis.window),
    ...options
  }: PrepareSaveOptions,
) {
  check(!options.signal?.aborted, 'CANCELLED');
  const needsDestination =
    typeof pickFile === 'function' &&
    !(
      typeof maximumSize === 'number' &&
      Number.isSafeInteger(maximumSize) &&
      maximumSize >= 0 &&
      maximumSize <= blobLimit
    );
  let handle: OutputHandle | undefined;
  if (needsDestination) {
    options.onProgress?.({ phase: 'destination', value: null });
    handle = await chooseDestination(
      pickFile({ suggestedName: filename }),
      options.signal,
    );
    options.onProgress?.({ phase: 'prepare', value: null });
  }
  check(!options.signal?.aborted, 'CANCELLED');
  const result = await prepare();
  return saveOutput(result, { ...options, handle });
}

export async function saveOutput(
  result: SavedOutput,
  { call, download, onProgress = () => {}, signal, handle }: SaveOptions,
) {
  let writable: OutputWriter | null = null;
  const current = () => check(!signal?.aborted, 'CANCELLED');
  try {
    current();
    if (handle) {
      writable = await handle.createWritable();
      current();
    }
    if (result.blob) {
      if (writable) {
        await writable.write(result.blob);
        current();
        await writable.close();
        writable = null;
      } else {
        check(result.blob.size <= blobLimit, 'STREAM_BROWSER');
        download(result);
      }
      return;
    }
    check(
      writable ||
        (result.estimatedSize ?? result.size ?? Infinity) <= blobLimit,
      'STREAM_BROWSER',
    );
    const chunks: Uint8Array<ArrayBuffer>[] = [];
    let offset = 0;
    while (result.size === null || offset < result.size) {
      current();
      const bytes = await call(
        'chunk',
        { job: result.job, offset },
        false,
        onProgress,
      );
      current();
      if (!bytes.length) {
        check(result.size === null, 'BOUNDS');
        break;
      }
      check(
        result.size === null || bytes.length <= result.size - offset,
        'BOUNDS',
      );
      if (writable) await writable.write(bufferBytes(bytes));
      else {
        check(offset + bytes.length <= blobLimit, 'STREAM_BROWSER');
        chunks.push(bufferBytes(bytes));
      }
      offset += bytes.length;
      current();
      if (result.size !== null)
        onProgress({
          phase: 'writing',
          value: result.size ? offset / result.size : 1,
        });
    }
    current();
    check(result.size === null || offset === result.size, 'BOUNDS');
    if (writable) {
      await writable.close();
      writable = null;
    } else
      download({
        filename: result.filename,
        blob: new Blob(chunks, {
          type: result.mime || 'application/octet-stream',
        }),
      });
  } catch (error) {
    if (writable) {
      try {
        await writable.abort();
      } catch {}
    }
    throw error;
  } finally {
    if (result.job)
      await call('release', { job: result.job }, false).catch(() => {});
  }
}
