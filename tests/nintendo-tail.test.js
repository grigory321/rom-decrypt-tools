import test from 'node:test';
import assert from 'node:assert/strict';
import { createNintendoDecoder } from '../dist/audio-nintendo.js';
import { arraySource } from '../dist/binary.js';
import { nintendoStreamFixture } from './game-audio-fixtures.js';

const stream = (magic, length) => {
  const bytes = nintendoStreamFixture(magic);
  new DataView(bytes.buffer).setUint32(108, length, magic === 'CSTM');
  return bytes;
};

test('Nintendo DSP total sample count survives stale final block counts', async () => {
  for (const magic of ['CSTM', 'FSTM']) {
    const decoder = await createNintendoDecoder(arraySource(stream(magic, 22)));
    const channels = [[], []];
    let done = false;
    while (!done) {
      const block = await decoder.read(9);
      block.channels.forEach((channel, index) =>
        channels[index].push(...channel),
      );
      done = block.done;
    }
    assert.equal(decoder.length, 22);
    assert.deepEqual(
      channels[0].map((value) => value * 32768),
      Array.from({ length: 22 }, (_, index) => 101 + index),
    );
    assert.deepEqual(
      channels[1].map((value) => value * 32768),
      Array.from({ length: 22 }, (_, index) => -101 - index),
    );
    await decoder.reset();
    assert.deepEqual(
      Array.from((await decoder.read(9)).channels[0]),
      channels[0].slice(0, 9),
    );
  }
});

test('Nintendo DSP rejects totals requiring bytes outside the final channel block', async () => {
  await assert.rejects(
    createNintendoDecoder(arraySource(stream('CSTM', 23))),
    (error) => error.code === 'INVALID_AUDIO',
  );
  const bytes = stream('CSTM', 22).subarray(0, 1068);
  await assert.rejects(createNintendoDecoder(arraySource(bytes)), (error) =>
    ['BOUNDS', 'INVALID_AUDIO'].includes(error.code),
  );
});

const pcmStream = (magic, length = 12) => {
  const bytes = nintendoStreamFixture(magic);
  const view = new DataView(bytes.buffer);
  const littleEndian = magic === 'CSTM';
  bytes[96] = 0;
  bytes[97] = 0;
  view.setUint32(104, 0, littleEndian);
  view.setUint32(108, length, littleEndian);
  view.setUint32(120, 8, littleEndian);
  view.setUint32(128, 2, littleEndian);
  bytes.set([1, 2, 3, 4, 5, 6, 7, 8], 1040);
  bytes.set([255, 254, 253, 252, 251, 250, 249, 248], 1048);
  bytes.set([9, 10, 11, 12, 127], 1056);
  bytes.set([247, 246, 245, 244, 128], 1064);
  return bytes;
};

test('Nintendo PCM total samples survive stale final block counts without channel padding', async () => {
  for (const magic of ['CSTM', 'FSTM']) {
    const decoder = await createNintendoDecoder(arraySource(pcmStream(magic)));
    const first = await decoder.read(7);
    const last = await decoder.read(7);
    assert.equal(last.done, true);
    assert.deepEqual(
      [...first.channels[0], ...last.channels[0]],
      Array.from({ length: 12 }, (_, index) => (index + 1) / 128),
    );
    assert.deepEqual(
      [...first.channels[1], ...last.channels[1]],
      Array.from({ length: 12 }, (_, index) => (-index - 1) / 128),
    );
    await decoder.seek(7);
    assert.deepEqual((await decoder.read(5)).channels, last.channels);
  }
});

test('Nintendo PCM stale counts cannot extend into channel stride padding', async () => {
  await assert.rejects(
    createNintendoDecoder(arraySource(pcmStream('CSTM', 14))),
    (error) => error.code === 'INVALID_AUDIO',
  );
  const zeroBlocks = pcmStream('CSTM');
  new DataView(zeroBlocks.buffer).setUint32(112, 0, true);
  await assert.rejects(
    createNintendoDecoder(arraySource(zeroBlocks)),
    (error) => error.code === 'INVALID_AUDIO',
  );
  const oddPcm16 = pcmStream('CSTM', 4);
  const view = new DataView(oddPcm16.buffer);
  oddPcm16[96] = 1;
  oddPcm16[98] = 1;
  view.setUint32(116, 5, true);
  view.setUint32(120, 2, true);
  view.setUint32(124, 4, true);
  view.setUint32(128, 1, true);
  view.setUint32(132, 4, true);
  view.setUint32(176, 1, true);
  oddPcm16.set([1, 0, 2, 0, 0xaa, 3, 0, 4, 0], 1040);
  await assert.rejects(
    createNintendoDecoder(arraySource(oddPcm16)),
    (error) => error.code === 'INVALID_AUDIO',
  );
});
