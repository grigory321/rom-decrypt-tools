import { SPCAPU } from './vendor/spc700-js/apu.js';

export function snapshotSnesAudio(apu: SPCAPU, title: string, game: string) {
  const bytes = new Uint8Array(0x10200),
    view = new DataView(bytes.buffer),
    encoder = new TextEncoder();
  const text = (offset: number, value: string, length: number) =>
    bytes.set(encoder.encode(value).subarray(0, length), offset);
  text(0, 'SNES-SPC700 Sound File Data v0.30', 33);
  bytes.set([26, 26, 26, 30], 33);
  view.setUint16(37, apu.cpu.PC, true);
  bytes.set([apu.cpu.A, apu.cpu.X, apu.cpu.Y, apu.cpu.PSW, apu.cpu.SP], 39);
  text(46, title, 32);
  text(78, game, 32);
  text(110, 'ROM Studio', 16);
  text(126, 'Original ROM SPC driver and data', 32);
  bytes.set(apu.ram, 256);
  bytes[256 + 0xf1] = apu.control;
  bytes[256 + 0xf2] = apu.dspAddr;
  bytes.set(apu.inputPorts, 256 + 0xf4);
  for (let i = 0; i < 3; i++) {
    bytes[256 + 0xfa + i] = apu.timers[i].target;
    bytes[256 + 0xfd + i] = apu.timers[i].out;
  }
  bytes.set(apu.dsp.regs, 0x10100);
  bytes.set(apu.iplRom, 0x101c0);
  return bytes;
}
