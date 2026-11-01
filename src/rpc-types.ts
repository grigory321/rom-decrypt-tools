import type {
  CompanionFile,
  Diagnostic,
  PcmBlock,
  PcmData,
  ProgressReporter,
  SelectedFile,
  SourceInput,
  TrackMetadata,
} from './contracts.js';

export type WorkerFileInput = SourceInput & { name: string; size: number };

export type UiMode = 'convert' | 'contents' | 'audio';
export type ConversionTarget = 'decrypt' | 'cia' | '3ds';
export type AudioExportFormat = 'original' | 'wav' | 'mp3';

export interface StreamedOutput {
  job: string;
  filename: string;
  size: number | null;
  estimatedSize?: number;
  mime?: string;
  blob?: undefined;
}

export interface FiniteOutput extends StreamedOutput {
  size: number;
}

export interface ConversionOutput extends FiniteOutput {
  format: string;
  titleId: string;
  warnings: string[];
}

export interface BufferedOutput {
  blob: Blob;
  filename: string;
  job?: string;
  size?: number | null;
  estimatedSize?: number;
  mime?: string;
}

export type SavedOutput = BufferedOutput | StreamedOutput;

export interface DownloadedFile {
  filename: string;
  blob: Blob;
}

export interface RpcError {
  code: string;
  detail?: string;
  message?: string;
}

export interface RomMetadata {
  id: string;
  name: string;
  size: number;
  format: string;
  titleId: string;
  encrypted: boolean;
  count: number;
}

export interface ContentMetadata {
  id: number;
  path: string;
  size: number;
  kind: string;
}

export interface ContentsMetadata {
  session: string;
  format: string;
  titleId?: string;
  entries: ContentMetadata[];
}

export interface LoadResult {
  group: string;
  tracks: TrackMetadata[];
  warnings: Diagnostic[];
}

export interface LiveSession {
  session: string;
  sampleRate: number;
  length: number | null;
  loop: boolean;
  loopStart: number;
  loopEnd: number | null;
  info: { title: string; game: string; artist: string } | null;
}

export interface LiveBlock extends PcmBlock {
  length: number | null;
  loopStart: number;
}

export interface LiveSeek {
  frame: number;
  sampleRate: number;
}

export type EmptyResult = Record<string, never>;

export interface RpcArguments {
  'inputs-open': { files: SelectedFile[] };
  'inputs-close': { selection: string };
  load: {
    file?: WorkerFileInput;
    selection?: string;
    fileIndex?: number;
    companions?: CompanionFile[];
    sourcePath?: string;
  };
  cancelLoad: EmptyResult;
  inspect: { file: WorkerFileInput };
  convert: { rom: string; target: ConversionTarget };
  'contents-open': {
    file: WorkerFileInput | SelectedFile;
    companions?: CompanionFile[];
    sourcePath?: string;
    directory?: boolean;
  };
  'contents-preview': { session: string; entry: number };
  'contents-file': { session: string; entry: number };
  'contents-clear': EmptyResult;
  'contents-zip': { session: string; entries?: number[]; all?: boolean };
  cancelConversion: EmptyResult;
  chunk: { job: string; offset: number };
  release: { job: string };
  removeRom: { rom: string };
  clearKeys: EmptyResult;
  remove: { group: string };
  'live-open': { track: string; sampleRate?: number };
  'live-read': { session: string };
  'live-input': { session: string; buttons: number };
  'live-seek': { session: string; seconds: number };
  'live-close': { session?: string };
  render: { track: string; seconds?: number };
  cancelExport: EmptyResult;
  export: {
    track: string;
    format: AudioExportFormat;
    bitrate?: number;
    seconds?: number;
    fade?: number;
    wholeSong?: boolean;
  };
  zip: { tracks: string[] };
  archive: { group: string };
}

export interface RpcResults {
  'inputs-open': { selection: string };
  'inputs-close': EmptyResult;
  load: LoadResult;
  cancelLoad: EmptyResult;
  inspect: RomMetadata;
  convert: ConversionOutput;
  'contents-open': ContentsMetadata;
  'contents-preview': Uint8Array;
  'contents-file': FiniteOutput;
  'contents-clear': EmptyResult;
  'contents-zip': FiniteOutput;
  cancelConversion: EmptyResult;
  chunk: Uint8Array;
  release: EmptyResult;
  removeRom: EmptyResult;
  clearKeys: { count: number };
  remove: EmptyResult;
  'live-open': LiveSession;
  'live-read': LiveBlock;
  'live-input': EmptyResult;
  'live-seek': LiveSeek;
  'live-close': EmptyResult;
  render: PcmData;
  cancelExport: EmptyResult;
  export: StreamedOutput;
  zip: FiniteOutput;
  archive: FiniteOutput;
}

export type RpcMethod = keyof RpcArguments;
export type RpcRequest = {
  [K in RpcMethod]: RpcArguments[K] extends EmptyResult
    ? { id: number; type: K }
    : { id: number; type: K } & RpcArguments[K];
}[RpcMethod];
export type RpcResult = RpcResults[RpcMethod];
export type RpcClient = <K extends RpcMethod>(
  type: K,
  data: RpcArguments[K],
  busy?: boolean,
  onProgress?: ProgressReporter,
) => Promise<RpcResults[K]>;

export interface UiServices {
  call: RpcClient;
  download: (file: DownloadedFile) => void;
  showError: (error: unknown, file?: File) => void;
}
