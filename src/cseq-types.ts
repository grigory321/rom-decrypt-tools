import type { ByteSource } from './contracts.js';

export interface CseqRegion {
  wave: ByteSource;
  originalKey: number;
  volume: number;
  pan: number;
  pitch: number;
  interpolation: number;
  keyGroup: number;
  percussion: boolean;
  attack: number;
  decay: number;
  sustain: number;
  hold: number;
  release: number;
}

export interface CseqBank {
  lookup(
    program: number,
    key: number,
    velocity: number,
  ): Promise<CseqRegion | null>;
}

export interface CseqPlayback {
  identity?: string;
  banks: readonly (CseqBank | null)[];
  startOffset: number;
  volume: number;
  channelPriority: number;
  allocatedTracks: number;
}
