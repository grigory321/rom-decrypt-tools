import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import { parseSdat, decodeSwav } from '../dist/nitro.js';
import { renderEngine } from '../dist/engine.js';
import { decodeStream, dsp } from '../dist/stream.js';
import { wav } from '../dist/export.js';
import { cwav } from './helpers.js';
import * as categories from '../dist/audio-category.js';
import { scanEmbeddedAudio } from '../dist/embedded-audio.js';
import { arraySource } from '../dist/binary.js';

test('common binary 0x8000 values do not exhaust discovery before a valid later sound', async () => {
  const tail = cwav();
  const offset = 220000;
  const bytes = new Uint8Array(offset + tail.length);
  for (let index = 0; index < offset; index += 2) bytes[index] = 0x80;
  bytes.set(tail, offset);
  const found = [];
  await scanEmbeddedAudio(arraySource(bytes), async (candidate) => {
    found.push(candidate);
    return true;
  });
  assert.equal(found.length, 1);
  assert.equal(found[0].offset, offset);
  assert.equal(found[0].format, 'CWAV');
  assert.deepEqual(await found[0].source.read(0, tail.length), tail);
});

test('long BGM streams stay visible before sequences and explicit SE names remain effects', () => {
  const score = { name: 'BGM_MAP', format: 'SSEQ', kind: 'sequence' };
  const ending = {
    name: 'ST_BGM_004_32_2db',
    format: 'STRM',
    kind: 'stream',
    audio: { sampleRate: 32728, channels: 2, length: 8299714, loop: false },
  };
  const effect = {
    name: 'ST_RENKIN_NIKOMU_SE',
    format: 'STRM',
    kind: 'stream',
    audio: { sampleRate: 32728, channels: 1, length: 231981, loop: true },
  };
  assert.equal(categories.classifyAudio(effect), 'sfx');
  assert.deepEqual(
    categories
      .orderAudioTracks([score, effect, ending])
      .map((track) => track.name),
    ['ST_BGM_004_32_2db', 'BGM_MAP', 'ST_RENKIN_NIKOMU_SE'],
  );
});

const fixture = async (n) =>
  new Uint8Array(await fs.readFile(new URL('fixtures/' + n, import.meta.url)));

test('SWAV signed PCM8 retains negative samples and loop markers', async () => {
  const p = decodeSwav(await fixture('eight.swav'));
  assert.equal(p.sampleRate, 8e3);
  assert.deepEqual(
    [...p.channels[0]],
    [0, 0.25, 0.5, 0.25, 0, -0.25, -0.5, -0.25],
  );
  assert.equal(p.loopStart, 0);
  assert.equal(p.loop, true);
});

test('SDAT uses real sequence symbols, original bank and original waves', async () => {
  const tracks = parseSdat(await fixture('original.sdat'));
  const song = tracks.find((x) => x.name === 'Pixel_Picnic');
  assert.ok(song);
  assert.equal(song.format, 'SSEQ');
  assert.ok(song.bank);
  assert.ok(song.waves[0]);
  assert.ok(tracks.some((x) => x.name === 'Level_Up' && x.format === 'SSAR'));
  const p = await renderEngine(song, 15, 22050);
  assert.equal(p.channels.length, 2);
  assert.ok(p.channels[0].some((v) => Math.abs(v) > 0.05));
  assert.ok(p.channels[0].length / 22050 < 15);
});

test('3DS CWAV PCM16 produces exact channel samples', () => {
  const p = decodeStream(cwav());
  assert.equal(p.sampleRate, 8e3);
  assert.deepEqual([...p.channels[0]], [0.25, -0.25, 0, 0]);
});

test('WAV contains valid RIFF header and interleaved signed PCM', () => {
  const bytes = wav({
    sampleRate: 8e3,
    channels: [new Float32Array([0.25, -0.25])],
  });
  const b = new DataView(bytes.buffer);
  assert.equal(new TextDecoder().decode(bytes.subarray(0, 4)), 'RIFF');
  assert.equal(b.getUint32(24, true), 8e3);
  assert.equal(b.getInt16(44, true), 8192);
  assert.equal(b.getInt16(46, true), -8192);
});

test('STRM rejects block lengths inconsistent with sample count before decoding', () => {
  const b = new Uint8Array(104 + 4 * 1024 * 1024),
    d = new DataView(b.buffer);
  b.set(new TextEncoder().encode('STRM'));
  b[24] = 0;
  b[26] = 1;
  d.setUint16(28, 8e3, true);
  d.setUint32(36, 1, true);
  d.setUint32(40, 104, true);
  d.setUint32(44, 1, true);
  d.setUint32(56, 4 * 1024 * 1024, true);
  d.setUint32(60, 1, true);
  assert.throws(
    () => decodeStream(b),
    (e) => e.code === 'INVALID_AUDIO',
  );
});

test('DSP ADPCM uses high nibble first and applies its scale', () => {
  const p = dsp(
    Uint8Array.from([1, 23, 143, 0, 0, 0, 0, 0]),
    new Array(16).fill(0),
    4,
  );
  assert.deepEqual([...p], [2 / 32768, 14 / 32768, -16 / 32768, -2 / 32768]);
});

test('CSTM deinterleaves stereo blocks including padded final blocks', () => {
  const b = new Uint8Array(256),
    d = new DataView(b.buffer),
    put = (o, n) => d.setUint32(o, n, true);
  b.set(new TextEncoder().encode('CSTM'));
  b.set([255, 254], 4);
  d.setUint16(16, 2, true);
  put(24, 64);
  put(36, 208);
  b.set(new TextEncoder().encode('INFO'), 64);
  put(76, 24);
  put(92, 80);
  const p = 96;
  b[p] = 1;
  b[p + 2] = 2;
  put(p + 4, 8e3);
  put(p + 12, 3);
  put(p + 16, 2);
  put(p + 20, 4);
  put(p + 24, 2);
  put(p + 28, 2);
  put(p + 32, 1);
  put(p + 36, 4);
  put(p + 52, 24);
  const table = 152;
  put(table, 2);
  put(table + 8, 20);
  put(table + 16, 28);
  put(176, 0);
  put(184, 0);
  b.set(new TextEncoder().encode('DATA'), 208);
  [8192, 16384, -8192, -16384, 24576, 0, -24576, 0].forEach((v, i) =>
    d.setInt16(240 + i * 2, v, true),
  );
  const out = decodeStream(b);
  assert.equal(out.sampleRate, 8e3);
  assert.deepEqual([...out.channels[0]], [0.25, 0.5, 0.75]);
  assert.deepEqual([...out.channels[1]], [-0.25, -0.5, -0.75]);
});
