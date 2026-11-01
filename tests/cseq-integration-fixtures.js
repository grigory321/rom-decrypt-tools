import { archive, bank, container } from './cseq-resource-fixtures.js';
import { cwav } from './helpers.js';

export function score() {
  const bytes = new Uint8Array(128);
  const view = new DataView(bytes.buffer);
  const text = (offset, value) =>
    bytes.set(new TextEncoder().encode(value), offset);
  text(0, 'CSEQ');
  view.setUint16(4, 0xfeff, true);
  view.setUint16(6, 64, true);
  view.setUint32(8, 0x01000000, true);
  view.setUint32(12, bytes.length, true);
  view.setUint16(16, 2, true);
  view.setUint16(20, 0x5000, true);
  view.setUint32(24, 64, true);
  view.setUint32(28, 32, true);
  view.setUint16(32, 0x5001, true);
  view.setUint32(36, 96, true);
  view.setUint32(40, 32, true);
  text(64, 'DATA');
  view.setUint32(68, 32, true);
  bytes.set([0xe1, 0, 120, 60, 100, 48, 255], 72);
  text(96, 'LABL');
  view.setUint32(100, 32, true);
  return bytes;
}

export function cseqBundle() {
  const wave = cwav();
  wave[73] = 1;
  const info = new Uint8Array(16);
  const view = new DataView(info.buffer);
  view.setUint32(0, 1, true);
  view.setUint16(4, 0x1f00, true);
  view.setUint32(12, wave.length, true);
  const war = container('CWAR', [
    { id: 0x6800, magic: 'INFO', bytes: info },
    { id: 0x6801, magic: 'FILE', bytes: wave },
  ]);
  const instrument = bank();
  const envelope = Uint8Array.of(10, 20, 30, 40, 50);
  let changed = false;
  for (
    let offset = 0;
    offset + envelope.length <= instrument.length;
    offset++
  ) {
    if (
      envelope.every((value, index) => instrument[offset + index] === value)
    ) {
      instrument.set([127, 127, 127, 0, 127], offset);
      changed = true;
      break;
    }
  }
  if (!changed) throw new Error('Authored bank envelope is missing');
  const sequence = score();
  return {
    sequence,
    bank: instrument,
    war,
    bytes: archive({
      files: [sequence, instrument, war],
      warItems: [2],
      startOffset: 0,
    }),
  };
}
