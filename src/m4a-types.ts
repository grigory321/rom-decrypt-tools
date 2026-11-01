export interface M4aSong {
  index: number;
  offset: number;
  bank: number;
  tracks: number[];
  priority: number;
  reverb: number;
  blocks: number;
}

export interface M4aSongs {
  slots: number;
  nonempty: number;
  banks: number[];
  mode: number;
  songs: M4aSong[];
}

export interface M4aPlayback {
  mode: number;
  song: M4aSong;
}

export interface M4aTrack {
  pc: number;
  ended: boolean;
  wait: number;
  running: number;
  key: number;
  velocity: number;
  instrument: Uint8Array;
  volume: number;
  pan: number;
  bend: number;
  bendRange: number;
  keyShift: number;
  tune: number;
  priority: number;
  lfoSpeed: number;
  lfoDepth: number;
  lfoType: number;
  lfoPhase: number;
  lfoDelay: number;
  lfoRemaining: number;
  modulation: number;
  echoVolume: number;
  echoLength: number;
  sampleStart: number;
  repeat: number;
  extendedWait: number;
  stack: number[];
  looped: boolean;
}

export type M4aEvent =
  | { type: 'tick' }
  | { type: 'end'; track: number }
  | { type: 'release'; track: number; key: number }
  | { type: 'port'; offset: number; value: number }
  | {
      type: 'note';
      priority: number;
      lfoDelay: number;
      track: number;
      key: number;
      velocity: number;
      gate: number;
      instrument: Uint8Array;
      sampleStart: number;
      echoVolume: number;
      echoLength: number;
    };
