import { check } from './binary.js';

export interface SpuReverb {
  advance(
    sampleIndex: number,
    sampleLeft: number,
    sampleRight: number,
    ram: DataView,
  ): [number, number];
  rd16(addr: number): number;
  wr16(addr: number, data: number): void;
}

export function createSpuReverb(): SpuReverb {
  let vLOUT = 0;
  let vROUT = 0;
  let mBASE = 0;
  let dAPF1 = 0;
  let dAPF2 = 0;
  let vIIR = 0;
  let vCOMB1 = 0;
  let vCOMB2 = 0;
  let vCOMB3 = 0;
  let vCOMB4 = 0;
  let vWALL = 0;
  let vAPF1 = 0;
  let vAPF2 = 0;
  let mLSAME = 0;
  let mRSAME = 0;
  let mLCOMB1 = 0;
  let mRCOMB1 = 0;
  let mLCOMB2 = 0;
  let mRCOMB2 = 0;
  let dLSAME = 0;
  let dRSAME = 0;
  let mLDIFF = 0;
  let mRDIFF = 0;
  let mLCOMB3 = 0;
  let mRCOMB3 = 0;
  let mLCOMB4 = 0;
  let mRCOMB4 = 0;
  let dLDIFF = 0;
  let dRDIFF = 0;
  let mLAPF1 = 0;
  let mRAPF1 = 0;
  let mLAPF2 = 0;
  let mRAPF2 = 0;
  let vLIN = 0;
  let vRIN = 0;

  let memory: DataView = new DataView(new ArrayBuffer(0));
  let bufferAddress = 0;
  let left = 0;
  let right = 0;

  const s16 = (d: number) => (d << 16) >> 16;
  const u16d8 = (d: number) => (d << 16) >>> 13;

  const writeHandlers = new Map<number, (data: number) => void>([
    [0x1d84, (data) => (vLOUT = s16(data))],
    [0x1d86, (data) => (vROUT = s16(data))],
    [
      0x1da2,
      (data) => {
        const m = u16d8(data);
        if (m !== mBASE) bufferAddress = m;
        mBASE = m;
      },
    ],
    [0x1dc0, (data) => (dAPF1 = u16d8(data))],
    [0x1dc2, (data) => (dAPF2 = u16d8(data))],
    [0x1dc4, (data) => (vIIR = s16(data))],
    [0x1dc6, (data) => (vCOMB1 = s16(data))],
    [0x1dc8, (data) => (vCOMB2 = s16(data))],
    [0x1dca, (data) => (vCOMB3 = s16(data))],
    [0x1dcc, (data) => (vCOMB4 = s16(data))],
    [0x1dce, (data) => (vWALL = s16(data))],
    [0x1dd0, (data) => (vAPF1 = s16(data))],
    [0x1dd2, (data) => (vAPF2 = s16(data))],
    [0x1dd4, (data) => (mLSAME = u16d8(data))],
    [0x1dd6, (data) => (mRSAME = u16d8(data))],
    [0x1dd8, (data) => (mLCOMB1 = u16d8(data))],
    [0x1dda, (data) => (mRCOMB1 = u16d8(data))],
    [0x1ddc, (data) => (mLCOMB2 = u16d8(data))],
    [0x1dde, (data) => (mRCOMB2 = u16d8(data))],
    [0x1de0, (data) => (dLSAME = u16d8(data))],
    [0x1de2, (data) => (dRSAME = u16d8(data))],
    [0x1de4, (data) => (mLDIFF = u16d8(data))],
    [0x1de6, (data) => (mRDIFF = u16d8(data))],
    [0x1de8, (data) => (mLCOMB3 = u16d8(data))],
    [0x1dea, (data) => (mRCOMB3 = u16d8(data))],
    [0x1dec, (data) => (mLCOMB4 = u16d8(data))],
    [0x1dee, (data) => (mRCOMB4 = u16d8(data))],
    [0x1df0, (data) => (dLDIFF = u16d8(data))],
    [0x1df2, (data) => (dRDIFF = u16d8(data))],
    [0x1df4, (data) => (mLAPF1 = u16d8(data))],
    [0x1df6, (data) => (mRAPF1 = u16d8(data))],
    [0x1df8, (data) => (mLAPF2 = u16d8(data))],
    [0x1dfa, (data) => (mRAPF2 = u16d8(data))],
    [0x1dfc, (data) => (vLIN = s16(data))],
    [0x1dfe, (data) => (vRIN = s16(data))],
  ]);

  const registers = new Map<number, number>();

  const loc = (addr: number) => {
    const size = 0x80000 - mBASE;
    return mBASE + ((((bufferAddress + addr) % size) + size) % size);
  };
  const saturate = (data: number) =>
    data < -32768 ? -32768 : data > 32767 ? 32767 : data;

  const rd16 = (addr: number) => memory.getInt16(loc(addr), true);
  const wr16 = (addr: number, data: number) =>
    memory.setInt16(loc(addr), saturate(data), true);

  const norm = (data: number) => Math.round(data / 0x8000);

  const reverbLeft = (sample: number) => {
    const Lin = vLIN * sample;

    wr16(
      mLSAME,
      norm((Lin + norm(rd16(dLSAME) * vWALL) - rd16(mLSAME - 2)) * vIIR) +
        rd16(mLSAME - 2),
    );

    wr16(
      mLDIFF,
      norm((Lin + norm(rd16(dRDIFF) * vWALL) - rd16(mLDIFF - 2)) * vIIR) +
        rd16(mLDIFF - 2),
    );

    let Lout =
      norm(vCOMB1 * rd16(mLCOMB1)) +
      norm(vCOMB2 * rd16(mLCOMB2)) +
      norm(vCOMB3 * rd16(mLCOMB3)) +
      norm(vCOMB4 * rd16(mLCOMB4));

    Lout = Lout - norm(vAPF1 * rd16(mLAPF1 - dAPF1));
    wr16(mLAPF1, Lout);
    Lout = norm(Lout * vAPF1) + rd16(mLAPF1 - dAPF1);

    Lout = Lout - norm(vAPF2 * rd16(mLAPF2 - dAPF2));
    wr16(mLAPF2, Lout);
    Lout = norm(Lout * vAPF2) + rd16(mLAPF2 - dAPF2);

    return (left = norm(Lout * vLOUT) / 0x8000);
  };

  const reverbRight = (sample: number) => {
    const Rin = vRIN * sample;

    wr16(
      mRSAME,
      norm((Rin + norm(rd16(dRSAME) * vWALL) - rd16(mRSAME - 2)) * vIIR) +
        rd16(mRSAME - 2),
    );

    wr16(
      mRDIFF,
      norm((Rin + norm(rd16(dLDIFF) * vWALL) - rd16(mRDIFF - 2)) * vIIR) +
        rd16(mRDIFF - 2),
    );

    let Rout =
      norm(vCOMB1 * rd16(mRCOMB1)) +
      norm(vCOMB2 * rd16(mRCOMB2)) +
      norm(vCOMB3 * rd16(mRCOMB3)) +
      norm(vCOMB4 * rd16(mRCOMB4));

    Rout = Rout - norm(vAPF1 * rd16(mRAPF1 - dAPF1));
    wr16(mRAPF1, Rout);
    Rout = norm(Rout * vAPF1) + rd16(mRAPF1 - dAPF1);

    Rout = Rout - norm(vAPF2 * rd16(mRAPF2 - dAPF2));
    wr16(mRAPF2, Rout);
    Rout = norm(Rout * vAPF2) + rd16(mRAPF2 - dAPF2);

    bufferAddress += 2;

    return (right = norm(Rout * vROUT) / 0x8000);
  };

  return {
    advance: (sampleIndex, sampleLeft, sampleRight, ram) => {
      memory = ram;
      return sampleIndex & 1
        ? [left, reverbRight(sampleRight)]
        : [reverbLeft(sampleLeft), right];
    },
    rd16: (addr) => {
      return registers.get(addr) ?? 0;
    },
    wr16: (addr, data) => {
      registers.set(addr, data & 0xffff);
      const write = writeHandlers.get(addr);
      check(write, 'PSF_DRIVER', 'Reverb register');
      write(data);
    },
  };
}
