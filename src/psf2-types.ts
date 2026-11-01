import type { ByteSource, DecoderOptions } from './contracts.js';
import type { IopHeap } from './psf2-memory.js';

export interface IopOptions extends DecoderOptions {
  log?: (text: string) => void;
}

export interface IopFile {
  size: number;
  bytes?: Uint8Array | null;
  source?: ByteSource;
}

export interface IopModule {
  id: number;
  name: string;
  base: number;
  size: number;
  entry: number;
  gp: number;
  started: boolean;
  ranges: { start: number; end: number }[];
}

export interface IopImport {
  library: string;
  id: number;
  module: string;
}
export interface IopExport {
  address: number;
  entries: number[];
}
export interface IopGuestCall {
  gp: number;
  ra: number;
}
export interface IopCpuState {
  registers: Int32Array;
  pc: number;
  nextPC: number;
  hi: number;
  lo: number;
  loadRegister: number;
  loadValue: number;
  delaySlot: boolean;
  guestCalls: IopGuestCall[];
}

export type IopThreadStatus =
  | 'dormant'
  | 'ready'
  | 'running'
  | 'delay'
  | 'sleep'
  | 'semaphore'
  | 'event'
  | 'pool'
  | 'mailbox';
export interface IopEventWait {
  id: number;
  bits: number;
  mode: number;
  result: number;
}
export interface IopPoolWait {
  id: number;
  size: number;
}
export interface IopMailboxWait {
  id: number;
  result: number;
}
export type IopWait =
  number | IopEventWait | IopPoolWait | IopMailboxWait | null;
export interface IopThread extends IopCpuState {
  id: number;
  order: number;
  priority: number;
  status: IopThreadStatus;
  wait: IopWait;
  wake: number;
  wakeups: number;
  entry: number;
  stackBase: number;
  stackSize: number;
  initialPriority: number;
  initialGp: number;
}
export interface IopSemaphore {
  count: number;
  maximum: number;
}
export interface IopEvent {
  bits: number;
}
export interface IopHandler {
  address: number;
  argument: number;
  enabled: boolean;
  gp: number;
}
export interface IopAlarm {
  id: number;
  due: number;
  address: number;
  argument: number;
  gp: number;
}
export interface IopTimer {
  index: number;
  size: number;
  maxScale: number;
  mode: number;
  compare: number;
  running: boolean;
  due: number;
  prescale: number;
  counter: number;
  epoch: number;
  fired: boolean;
}
export interface IopFileHandle {
  file: IopFile;
  position: number;
  pending: { position: number; count: number; bytes: Uint8Array } | null;
}
export interface IopPool {
  library: string;
  heap: IopHeap;
  fixed: number;
  attributes: number;
  options: number;
}
export interface IopMailbox {
  messages: number[];
  attributes: number;
  options: number;
}
export interface IopCallbackFrame {
  state: IopCpuState;
  current: IopThread | null;
  alarm: IopAlarm | null;
}
export interface IopModuleFrame {
  state: IopCpuState;
  module: IopModule;
  resultAddress: number;
}
