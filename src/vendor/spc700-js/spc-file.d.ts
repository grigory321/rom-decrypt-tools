export interface SPCRegisters {
  pc: number;
  a: number;
  x: number;
  y: number;
  psw: number;
  sp: number;
}
export interface SPCTags {
  title?: string;
  game?: string;
  dumper?: string;
  comment?: string;
  artist?: string;
  publisher?: string;
  ostTitle?: string;
  ostDisc?: number;
  ostTrack?: number;
  copyrightYear?: number;
  date?: string;
  playSeconds?: number;
  fadeMilliseconds?: number;
  mutedVoices?: number;
  introSeconds?: number;
  loopSeconds?: number;
  endSeconds?: number;
  loopCount?: number;
  amplification?: number;
}
export interface SPCFile {
  registers: SPCRegisters;
  ram: Uint8Array;
  dspRegs: Uint8Array;
  iplRom: Uint8Array;
  tags: SPCTags;
}
export declare function isSPCFile(data: Uint8Array): boolean;
export declare function parseSPC(input: Uint8Array | ArrayBuffer): SPCFile;
