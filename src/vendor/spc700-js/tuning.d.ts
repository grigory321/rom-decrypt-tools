import { type BasePitch } from './brr-analyzer.js';
export declare class Tuning {
  private readonly ram;
  private dirPage;
  private readonly base;
  private readonly deviations;
  private readonly correction;
  constructor(ram: Uint8Array, dirPage: number);
  setDirectoryPage(page: number): void;
  baseOf(srcn: number): BasePitch;
  noteOf(srcn: number, pitch: number): number | null;
  observe(srcn: number, pitch: number): void;
  isRefined(srcn: number): boolean;
}
