import type { AudioMetadata, CompanionFile } from './contracts.js';

export type EncodedCodec = 'pcm8' | 'pcm16' | 'ima' | 'dsp' | 'psx';

export interface ImaState {
  h1: number;
  index: number;
}

export interface ChannelState extends ImaState {
  h2: number;
}

export interface InitialChannelState {
  h1?: number;
  h2?: number;
  index?: number;
  coefs?: number[];
}

export interface ChannelReader {
  read(frames: number): Promise<Float32Array>;
  reset(): void;
  seek?(frame: number): void;
  checkpoint?(): () => void;
}

export interface FiniteAudioMetadata extends AudioMetadata {
  length: number;
}

export interface HcaMetadata extends FiniteAudioMetadata {
  bytes: Uint8Array;
  headerSize: number;
  version: number;
  cipherType: number;
  cipherOffset: number | null;
  chunkOffsets: number[];
  athType: number;
  loop: boolean;
  loopStart: number;
  loopEnd: number;
  msStereo: number;
  frameCount: number;
  delay: number;
  padding: number;
  frameSize: number;
  minResolution: number;
  maxResolution: number;
  tracks: number;
  channelConfig: number;
  totalBands: number;
  baseBands: number;
  stereoBands: number;
  hfrBands: number;
  hfrGroups: number;
  dataEnd: number;
}

export function keyCompanionName(entry: CompanionFile): string {
  const name = 'name' in entry ? entry.name : undefined;
  const path = 'path' in entry ? entry.path : undefined;
  return name ?? path ?? '';
}
