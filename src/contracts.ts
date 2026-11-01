import type { M4aPlayback } from './m4a-types.js';
import type { CseqPlayback } from './cseq-types.js';
import type { HeartbeatPlayback } from './ps-heartbeat.js';

export type MaybePromise<T> = T | Promise<T>;

export interface ByteSource {
  readonly size: number;
  read(offset: number, length: number): Promise<Uint8Array>;
}

export interface OutputSource {
  readonly size: number | null;
  readonly progress?: number;
  readonly chunkSize?: number;
  readonly progressPhase?: 'render' | 'encode';
  read(offset: number, length: number): Promise<Uint8Array>;
}

export interface BlobInput {
  readonly size: number;
  slice(start?: number, end?: number): { arrayBuffer(): Promise<ArrayBuffer> };
}

export interface SelectedFile {
  file: File;
  name: string;
  path?: string;
  webkitRelativePath?: string;
}

export interface BlobFile {
  blob: BlobInput;
  name?: string;
  path?: string;
}

export interface NamedSource {
  source: ByteSource;
  name?: string;
  path?: string;
  size?: number;
}

export type SourceInput =
  ByteSource | BlobInput | SelectedFile | NamedSource | BlobFile | Uint8Array;
export type CompanionFile =
  | File
  | SelectedFile
  | NamedSource
  | BlobFile
  | (ByteSource & { name: string; path?: string });

export interface Progress {
  phase: string;
  value?: number | null;
  count?: number;
  detail?: string;
}

export type ProgressReporter = (progress: Progress) => void;

export interface Diagnostic {
  code: string;
  detail?: string;
}

export type KeySet = Record<string, Uint8Array>;

export interface ArchiveEntry {
  path: string;
  kind: string;
  size: number;
  source: ByteSource;
  format?: string | null;
  subkey?: number;
  cdAudio?: { source: ByteSource; sectorSize: 2336 | 2352 };
}

export interface Archive {
  format: string;
  entries: ArchiveEntry[];
  titleId?: string;
  warnings?: Diagnostic[];
  dispose?: () => Promise<void>;
}

export interface PsfEntry {
  pc: number;
  gp: number;
  sp: number;
}

export interface PsfFile {
  path: string;
  size: number;
  source?: ByteSource;
  bytes?: Uint8Array;
  kind?: string;
}

export interface PsfBundle {
  format: 'PSF' | 'PSF2';
  name: string;
  tags: Record<string, string>;
  entry: PsfEntry | null;
  programs: { name: string; bytes: Uint8Array }[];
  files: PsfFile[];
  entries: ArchiveEntry[];
  dependencies: AudioDependency[];
}

export interface AudioDependency {
  name: string;
  source: ByteSource;
  size: number;
}

export interface SonyPlayback {
  bank: ByteSource;
  body?: ByteSource;
}

export interface AudioAsset {
  inputEvents?: readonly CartridgeInputEvent[];
  source: ByteSource;
  name: string;
  format: string;
  size: number;
  kind?: string;
  playable?: boolean;
  gameAudio?: boolean;
  psf?: PsfBundle;
  song?: number;
  m4a?: M4aPlayback;
  sony?: SonyPlayback;
  cseq?: CseqPlayback;
  heartbeat?: HeartbeatPlayback;
  xaFile?: number;
  xaChannel?: number;
  xaCoding?: number;
  xaFrames?: number;
  dependencies?: AudioDependency[];
}

export interface AudioImport {
  assets: AudioAsset[];
  warnings: Diagnostic[];
  dispose?: () => Promise<void>;
}

export interface AudioTags {
  title?: string;
  game?: string;
  artist?: string;
  author?: string;
  introSeconds?: number;
  loopSeconds?: number;
}

export interface PcmData {
  channels: Float32Array[];
  sampleRate: number;
  loop?: boolean;
  loopStart?: number;
  loopEnd?: number | null;
  warnings?: Diagnostic[];
  engine?: string;
}

export interface PcmBlock extends PcmData {
  done: boolean;
  frame: number;
  length?: number | null;
}

export interface AudioMetadata {
  channels: number;
  sampleRate: number;
  length: number | null;
  loop?: boolean;
  loopStart?: number;
  loopEnd?: number | null;
  tags?: AudioTags;
}

export interface AudioDecoder extends AudioMetadata {
  readonly continuous?: boolean;
  readonly loopIsInfinite?: boolean;
  inputEvents?: readonly CartridgeInputEvent[];
  readonly frame: number;
  read(frames: number): MaybePromise<PcmBlock>;
  reset(): MaybePromise<void>;
  seek?(frame: number): MaybePromise<void>;
  checkpoint?(): () => void;
  setButtons?(mask: number, durationFrames?: number): void;
}

export interface DecoderOptions {
  inputEvents?: readonly CartridgeInputEvent[];
  sampleRate?: number;
  song?: number;
  name?: string;
  archiveName?: string;
  companions?: CompanionFile[];
  psf?: PsfBundle;
  m4a?: M4aPlayback;
  sony?: SonyPlayback;
  cseq?: CseqPlayback;
  heartbeat?: HeartbeatPlayback;
  signal?: AbortSignal;
  cancelled?: () => boolean;
  isCancelled?: () => boolean;
  clearEchoBuffer?: boolean;
  resumeVoices?: boolean;
  xaFile?: number;
  xaChannel?: number;
  xaCoding?: number;
  xaFrames?: number;
  subkey?: number;
  key?: DecryptionKey;
}

export interface CartridgeInputEvent {
  frame: number;
  sampleRate?: number;
  buttons: number;
  durationFrames?: number;
}

export type DecryptionKey =
  | string
  | number
  | bigint
  | Uint8Array
  | {
      start?: number;
      seed?: number;
      mult: number;
      add?: number;
      inc?: number;
    };

export interface ParsedTrack {
  name: string;
  format: string;
  kind: 'sequence' | 'stream' | 'sample';
  playable: boolean;
  raw?: Uint8Array;
  sequence?: Uint8Array;
  start?: number;
  bank?: Uint8Array | null;
  waves?: (Uint8Array | null | undefined)[];
  volume?: number;
  bankID?: number;
  audio?: Pick<AudioMetadata, 'sampleRate' | 'channels' | 'length' | 'loop'>;
}

export interface LibraryTrack extends ParsedTrack {
  id: string;
  group: string;
  source: string;
  asset: AudioAsset;
}

export interface TrackMetadata {
  id: string;
  group: string;
  name: string;
  format: string;
  kind: ParsedTrack['kind'];
  size: number;
  zipSizeBound: number;
  zipDependencyKey?: string;
  source: string;
  playable: boolean;
  sourceArchive: boolean;
  audio?: Pick<AudioMetadata, 'sampleRate' | 'channels' | 'length' | 'loop'>;
}
