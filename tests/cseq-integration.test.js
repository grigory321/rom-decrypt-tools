import test from 'node:test';
import assert from 'node:assert/strict';
import { arraySource } from '../dist/binary.js';
import { readPlatformAudio } from '../dist/platform-files.js';

import { score, cseqBundle } from './cseq-integration-fixtures.js';
import { unzipSync } from '../dist/vendor/fflate.mjs';
import { wavFixture } from './game-audio-fixtures.js';
import { createGameDecoder } from '../dist/game-audio.js';

test('a standalone CSEQ without original instruments stays downloadable with a specific resource diagnostic', async () => {
  const bytes = score();
  const imported = await readPlatformAudio(arraySource(bytes), 'melody.bcseq');
  assert.equal(imported.assets.length, 1);
  assert.equal(imported.assets[0].format, 'CSEQ');
  assert.equal(imported.assets[0].playable, false);
  assert.ok(imported.warnings.some((warning) => warning.code === 'CSEQ_BANK'));
  assert.deepEqual(
    await imported.assets[0].source.read(0, bytes.length),
    bytes,
  );
});

test('random and variable prefixes reject an unknown inner command instead of finishing successfully', async () => {
  const fixture = cseqBundle();
  const imported = await readPlatformAudio(
    arraySource(fixture.bytes),
    'theme.bcsar',
  );
  const context = imported.assets.find((asset) => asset.format === 'CSEQ').cseq;
  for (const bytes of [
    [0xa0, 0x82, 0, 0, 0, 0, 255],
    [0xa1, 0x82, 0, 255],
  ]) {
    const source = score();
    source.set(bytes, 72);
    const decoder = await createGameDecoder(arraySource(source), 'CSEQ', {
      cseq: context,
    });
    await assert.rejects(decoder.read(8192), { code: 'CSEQ_COMMAND' });
  }
});

test('CSEQ plays through the worker, exports its complete WAV and MP3, and preserves original banks in a reimportable ZIP', async () => {
  const replies = [];
  globalThis.self = { postMessage: (message) => replies.push(message) };
  await import('../dist/worker.js?cseq-integration');
  const dispatch = self.onmessage;
  let id = 0;
  const request = async (type, args = {}) => {
    const serial = ++id;
    await dispatch({ data: { id: serial, type, ...args } });
    const reply = replies.find(
      (message) => message.id === serial && !message.progress,
    );
    assert.ok(reply, type);
    assert.equal(reply.error, undefined, JSON.stringify(reply.error));
    return reply.result;
  };
  const collect = async (output) => {
    const parts = [];
    let offset = 0;
    while (output.size === null || offset < output.size) {
      const bytes = await request('chunk', { job: output.job, offset });
      if (!bytes.length) break;
      parts.push(bytes);
      offset += bytes.length;
    }
    await request('release', { job: output.job });
    return new Uint8Array(await new Blob(parts).arrayBuffer());
  };
  const fixture = cseqBundle();
  const loaded = await request('load', {
    file: new File([fixture.bytes], 'theme.bcsar'),
  });
  const songs = loaded.tracks.filter((track) => track.format === 'CSEQ');
  assert.equal(songs.length, 1);
  const track = songs[0];
  assert.equal(track.playable, true);
  assert.equal(track.sourceArchive, true);
  await request('load', { file: new File([wavFixture()], 'next.wav') });
  const opened = await request('live-open', { track: track.id });
  let frames = 0;
  let audible = false;
  for (;;) {
    const pcm = await request('live-read', { session: opened.session });
    frames += pcm.channels[0].length;
    assert.equal(
      pcm.frame,
      frames,
      'live playback positions must include every delivered sample',
    );
    audible ||= pcm.channels.some((channel) =>
      channel.some((value) => value !== 0),
    );
    if (pcm.done) {
      assert.equal(pcm.length, frames);
      break;
    }
    assert.ok(frames < 65536);
  }
  assert.ok(audible);
  assert.ok(frames > 16000 && frames < 20000);
  const wav = await collect(
    await request('export', {
      track: track.id,
      format: 'wav',
      wholeSong: true,
      fade: 0,
    }),
  );
  assert.equal(new DataView(wav.buffer).getUint32(40, true), frames * 4);
  const mp3 = await collect(
    await request('export', {
      track: track.id,
      format: 'mp3',
      wholeSong: true,
      bitrate: 192,
      fade: 0,
    }),
  );
  assert.ok(mp3.length > 1000);
  const original = await collect(
    await request('export', { track: track.id, format: 'original' }),
  );
  assert.deepEqual(original, fixture.sequence);
  const packed = await collect(await request('zip', { tracks: [track.id] }));
  const files = unzipSync(packed);
  assert.equal(Object.keys(files).length, 1);
  assert.deepEqual(Object.values(files)[0], fixture.bytes);
  const reimported = await request('load', {
    file: new File([packed], 'originals.zip'),
  });
  assert.equal(
    reimported.tracks.filter((item) => item.format === 'CSEQ' && item.playable)
      .length,
    1,
  );
});
