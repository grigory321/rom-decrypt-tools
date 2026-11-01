import assert from 'node:assert/strict';
import test from 'node:test';
import { scanEmbeddedAudio } from '../dist/embedded-audio.js';
import { readSonyAudio } from '../dist/sony-audio.js';
import { arraySource, FormatError } from '../dist/binary.js';
import {
  createSonySequenceDecoder,
  readSonySequenceExtent,
} from '../dist/audio-sony-sequence.js';

test('embedded Sony scores use parsed event and SEP extents and retain valid siblings', async () => {
  const timing = [0, 96, 7, 161, 32, 4, 2];
  const events = [
    0, 0xc0, 0, 0, 0x90, 60, 100, 96, 60, 0, 0, 0xff, 0x51, 7, 161, 32, 0, 0x51,
    6, 0, 0, 0, 0xff, 0x2f, 0,
  ];
  const seq = Uint8Array.from([
    112,
    81,
    69,
    83,
    0,
    0,
    0,
    1,
    ...timing,
    ...events,
  ]);
  const sep = Uint8Array.from([
    112,
    81,
    69,
    83,
    0,
    0,
    0,
    0,
    ...timing,
    0,
    0,
    0,
    4,
    0,
    255,
    47,
    0,
    0,
    1,
    ...timing,
    0,
    0,
    0,
    4,
    0,
    255,
    47,
    0,
  ]);
  const malformed = seq.slice();
  malformed[16] = 0xa0;
  const bytes = new Uint8Array(66080).fill(0xaa);
  bytes.set(malformed, 16);
  bytes.set(seq, 65530);
  bytes.set(sep, 65700);
  let maximum = 0;
  const source = {
    size: bytes.length,
    async read(offset, length) {
      maximum = Math.max(maximum, length);
      return bytes.slice(offset, offset + length);
    },
  };
  const found = [];
  await scanEmbeddedAudio(source, async (candidate) => {
    found.push(candidate);
    return true;
  });
  assert.deepEqual(
    found.map((item) => [item.format, item.offset, item.size]),
    [
      ['SEQ', 65530, seq.length],
      ['SEP', 65700, sep.length],
    ],
  );
  assert.deepEqual(await found[0].source.read(0, seq.length), seq);
  const unmatched = await readSonyAudio(found[0].source, 'archive/fff.seq', []);
  assert.equal(unmatched.assets[0].playable, false);
  assert.equal(unmatched.warnings[0].code, 'SONY_BANK');
  const bank = new Uint8Array(0xc30);
  const bankView = new DataView(bank.buffer);
  bank.set(new TextEncoder().encode('pBAV'));
  bankView.setUint32(4, 7, true);
  bankView.setUint32(12, bank.length, true);
  for (const offset of [18, 20, 22]) bankView.setUint16(offset, 1, true);
  bank[24] = bank[33] = bank[0x822] = 127;
  bank[25] = bank[36] = bank[0x823] = 64;
  bank[32] = 1;
  bank[0x824] = 60;
  bank[0x827] = 127;
  bankView.setUint16(0x830, 0x000f, true);
  bankView.setUint16(0x832, 0x1fc0, true);
  bankView.setUint16(0x836, 1, true);
  bankView.setUint16(0xa22, 2, true);
  bank[0xc20] = 0x0c;
  bank[0xc21] = 7;
  bank.fill(0x77, 0xc22);
  const bankSource = arraySource(bank);
  const companion = { path: 'archive/fff.vab', source: bankSource };
  const matched = await readSonyAudio(found[0].source, 'archive/fff.seq', [
    companion,
  ]);
  assert.equal(matched.assets[0].sony.bank, bankSource);
  const decoder = await createSonySequenceDecoder(found[0].source, bankSource);
  const pcm = await decoder.read(512);
  assert(pcm.channels.every((channel) => channel.every(Number.isFinite)));
  assert(pcm.channels.some((channel) => channel.some((value) => value !== 0)));
  const ambiguous = await readSonyAudio(found[0].source, 'archive/fff.seq', [
    companion,
    companion,
  ]);
  assert.equal(ambiguous.assets[0].playable, false);
  assert.equal(ambiguous.warnings[0].code, 'SONY_BANK');
  assert(maximum <= 65536);
});

test('a bounded SEP prefix preserves trailing siblings and short records yield cancellation', async () => {
  const packageBytes = (count, notes) => {
    const size = notes * 4 + 4;
    const bytes = new Uint8Array(6 + count * (13 + size) + 64).fill(0xaa);
    bytes.set([112, 81, 69, 83, 0, 0]);
    const view = new DataView(bytes.buffer);
    for (let id = 0; id < count; id++) {
      const at = 6 + id * (13 + size);
      view.setUint16(at, id);
      bytes.set([0, 96, 7, 161, 32, 4, 2], at + 2);
      view.setUint32(at + 9, size);
      for (let note = 0; note < notes; note++)
        bytes.set([0, 144, 60, 0], at + 13 + note * 4);
      bytes.set([0, 255, 47, 0], at + 13 + notes * 4);
    }
    return bytes;
  };
  const bounded = await readSonySequenceExtent(
    arraySource(packageBytes(4096, 0)),
  );
  assert.equal(bounded.songs.length, 4096);
  assert.equal(bounded.size, 6 + 4096 * 17);
  let fired = false;
  const timer = setTimeout(() => {
    fired = true;
  }, 0);
  try {
    await assert.rejects(
      readSonySequenceExtent(arraySource(packageBytes(1000, 1000)), () => {
        if (fired) throw new FormatError('CANCELLED');
      }),
      (error) => error.code === 'CANCELLED',
    );
  } finally {
    clearTimeout(timer);
  }
  assert(fired);
});
