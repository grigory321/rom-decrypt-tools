import assert from 'node:assert/strict';
import test from 'node:test';
import { arraySource, FormatError } from '../dist/binary.js';
import { createXaDecoder } from '../dist/audio-xa.js';
import { readXaAudio } from '../dist/xa-audio.js';
import { readIso9660 } from '../dist/disc-iso9660.js';
import { readPlatformAudio } from '../dist/platform-files.js';
import { unzipSync } from '../dist/vendor/fflate.mjs';

test('XA worker retains complete playback and original, WAV and ZIP exports', async () => {
  const sectors = Array.from({ length: 30 }, (_, index) =>
    sector(1, 0, 1, true, index === 29),
  );
  sectors.push(sector(1, 1, 0, true, true));
  const bytes = new Uint8Array(sectors.length * 2352);
  sectors.forEach((value, index) => bytes.set(value, index * 2352));
  const replies = new Map();
  const previous = globalThis.self;
  let id = 0;
  globalThis.self = {
    postMessage(message) {
      if (!message.progress) replies.set(message.id, message);
    },
  };
  try {
    await import('../dist/worker.js?xa-indexed');
    async function request(type, fields = {}) {
      const key = ++id;
      await self.onmessage({ data: { id: key, type, ...fields } });
      const message = replies.get(key);
      replies.delete(key);
      assert(message && !message.error, JSON.stringify(message?.error));
      return message.result;
    }
    const loaded = await request('load', {
      file: {
        name: 'mixed.xa',
        size: bytes.length,
        source: arraySource(bytes),
      },
    });
    assert.equal(loaded.tracks.length, 2);
    assert.deepEqual(
      loaded.tracks.map((track) => track.audio.length),
      [60480, 4032],
    );
    const track = loaded.tracks[0];
    const opened = await request('live-open', { track: track.id });
    let frames = 0;
    for (;;) {
      const block = await request('live-read', { session: opened.session });
      frames += block.channels[0].length;
      if (block.done) break;
    }
    assert.equal(frames, 60480);
    const original = await request('export', {
      track: track.id,
      format: 'original',
    });
    const raw = await request('chunk', { job: original.job, offset: 0 });
    assert.deepEqual(raw, bytes.subarray(0, 30 * 2352));
    await request('release', { job: original.job });
    const zip = await request('zip', { tracks: [track.id] });
    const archive = unzipSync(
      await request('chunk', { job: zip.job, offset: 0 }),
    );
    assert.deepEqual(Object.values(archive), [raw]);
    await request('release', { job: zip.job });
    const output = await request('export', { track: track.id, format: 'wav' });
    assert.equal(output.size, 44 + 60480 * 4);
    const data = await request('chunk', { job: output.job, offset: 0 });
    assert.equal(new DataView(data.buffer).getUint32(40, true), 60480 * 4);
    let written = data.length;
    while (written < output.size) {
      const part = await request('chunk', { job: output.job, offset: written });
      assert(part.length > 0);
      written += part.length;
    }
    assert.equal(written, output.size);
    await request('release', { job: output.job });
    await request('live-close', { session: opened.session });
    await request('remove', { group: loaded.group });
  } finally {
    globalThis.self = previous;
  }
});

function sector(file = 0, channel = 0, coding = 0, audio = false, end = false) {
  const bytes = new Uint8Array(2352);
  bytes.fill(255, 1, 11);
  bytes[15] = 2;
  const header = [file, channel, audio ? 0x64 | (end ? 0x80 : 0) : 8, coding];
  bytes.set(header, 16);
  bytes.set(header, 20);
  if (audio)
    for (let group = 0; group < 18; group++) {
      bytes.fill(12, 24 + group * 128, 40 + group * 128);
      bytes.fill(0x11, 40 + group * 128, 152 + group * 128);
    }
  else {
    let edc = 0;
    for (const value of bytes.subarray(16, 2072)) {
      edc ^= value;
      for (let bit = 0; bit < 8; bit++)
        edc = (edc >>> 1) ^ (edc & 1 ? 0xd8018001 : 0);
    }
    new DataView(bytes.buffer).setUint32(2072, edc >>> 0, true);
  }
  return bytes;
}

test('late mixed XA streams enumerate every channel/coding/EOF part and export only original sectors', async () => {
  const sectors = Array.from({ length: 36 }, () => sector());
  sectors.push(
    sector(1, 0, 1, true),
    sector(1, 1, 0, true, true),
    sector(),
    sector(1, 0, 1, true, true),
    sector(1, 0, 5, true, true),
    sector(1, 0, 1, true, true),
  );
  const invalid = sector(2, 2, 0, true, true);
  invalid.fill(0x40, 24, 40);
  sectors.push(invalid, sector(2, 3, 0x80, true, true));
  const bytes = new Uint8Array(sectors.length * 2352);
  sectors.forEach((value, index) => bytes.set(value, index * 2352));
  let maximum = 0;
  const source = {
    size: bytes.length,
    async read(offset, length) {
      maximum = Math.max(maximum, length);
      return bytes.slice(offset, offset + length);
    },
  };
  const audio = await readXaAudio(source, 'arbitrary/packed.bin');
  assert.deepEqual(
    audio.assets.map((asset) => [
      asset.xaFile,
      asset.xaChannel,
      asset.xaCoding,
      asset.size,
      asset.xaFrames,
    ]),
    [
      [1, 0, 1, 4704, 4032],
      [1, 1, 0, 2352, 4032],
      [1, 0, 5, 2352, 2016],
      [1, 0, 1, 2352, 2016],
    ],
  );
  assert.deepEqual(
    await audio.assets[0].source.read(0, 4704),
    Uint8Array.from([...sectors[36], ...sectors[39]]),
  );
  assert(audio.warnings.some((warning) => warning.code === 'CODEC'));
  assert(audio.warnings.some((warning) => warning.code === 'INVALID_AUDIO'));
  for (const asset of audio.assets) {
    const indexed = await createXaDecoder(asset.source, {
      xaFile: asset.xaFile,
      xaChannel: asset.xaChannel,
      xaCoding: asset.xaCoding,
      xaFrames: asset.xaFrames,
    });
    assert.equal(indexed.length, asset.xaFrames);
    assert.equal(indexed.loopEnd, asset.xaFrames);
    let frames = 0;
    for (;;) {
      const block = await indexed.read(1000);
      frames += block.channels[0].length;
      if (block.done) break;
    }
    assert.equal(frames, asset.xaFrames);
  }
  await assert.rejects(
    createXaDecoder(audio.assets[0].source, { xaFrames: -1 }),
    (error) => error.code === 'INVALID_AUDIO',
  );
  const decoder = await createXaDecoder(source, { xaFile: 1, xaChannel: 1 });
  const pcm = await decoder.read(4096);
  assert.equal(pcm.channels.length, 1);
  assert.equal(pcm.channels[0].length, 4032);
  assert(pcm.channels[0].every(Number.isFinite));
  assert(pcm.channels[0].some((value) => value !== 0));
  const stereo = await createXaDecoder(source, {
    xaFile: 1,
    xaChannel: 0,
    xaCoding: 1,
  });
  assert.equal((await stereo.read(8192)).channels[0].length, 4032);
  const shortSectors = new Uint8Array(sectors.length * 2336);
  sectors.forEach((value, index) =>
    shortSectors.set(value.subarray(16), index * 2336),
  );
  const shortAudio = await readXaAudio(
    arraySource(shortSectors),
    'sectors2336.bin',
    () => {},
    2336,
  );
  assert.equal(shortAudio.assets.length, 4);
  assert.equal(shortAudio.assets[0].format, 'XA2336');
  assert.equal(shortAudio.assets[0].size, 4672);
  assert(maximum <= 65536);
  const imported = await readPlatformAudio(source, 'packed.bin');
  assert.equal(imported.assets.length, 4);
  assert(imported.assets.every((asset) => asset.xaFrames > 0));
  const count = 21 + sectors.length;
  const logical = new Uint8Array(count * 2048);
  const view = new DataView(logical.buffer);
  const both = (at, value, width) => {
    if (width === 4) {
      view.setUint32(at, value, true);
      view.setUint32(at + 4, value);
    } else {
      view.setUint16(at, value, true);
      view.setUint16(at + 2, value);
    }
  };
  for (const [block, type] of [
    [16, 1],
    [17, 255],
  ]) {
    logical[block * 2048] = type;
    logical.set(new TextEncoder().encode('CD001'), block * 2048 + 1);
    logical[block * 2048 + 6] = 1;
  }
  both(16 * 2048 + 80, count, 4);
  for (const [offset, value] of [
    [120, 1],
    [124, 1],
    [128, 2048],
  ])
    both(16 * 2048 + offset, value, 2);
  const record = (at, block, size, flags, name) => {
    const id =
      typeof name === 'number'
        ? Uint8Array.of(name)
        : new TextEncoder().encode(name);
    const length = 33 + id.length + (id.length % 2 === 0 ? 1 : 0);
    logical[at] = length;
    both(at + 2, block, 4);
    both(at + 10, size, 4);
    logical[at + 25] = flags;
    both(at + 28, 1, 2);
    logical[at + 32] = id.length;
    logical.set(id, at + 33);
    return length;
  };
  record(16 * 2048 + 156, 20, 2048, 2, 0);
  let directory = 20 * 2048;
  directory += record(directory, 20, 2048, 2, 0);
  directory += record(directory, 20, 2048, 2, 1);
  record(directory, 21, sectors.length * 2048, 0, 'MIXED.BIN;1');
  const physical = new Uint8Array(count * 2352);
  physical.set(bytes, 21 * 2352);
  const archive = await readIso9660(arraySource(logical), 'iso/', () => {}, {
    source: arraySource(physical),
    sectorSize: 2352,
    expectedMode: 2,
  });
  const mixed = archive.entries.find((entry) => entry.path === 'iso/MIXED.BIN');
  assert.equal(mixed.size, sectors.length * 2048);
  assert.deepEqual(await mixed.source.read(0, 16), new Uint8Array(16));
  assert(mixed.cdAudio);
  assert.equal(mixed.cdAudio.source.size, bytes.length);
  assert.equal(
    (await readXaAudio(mixed.cdAudio.source, mixed.path)).assets.length,
    4,
  );
  let cancelled = false;
  const timer = setTimeout(() => {
    cancelled = true;
  }, 0);
  try {
    await assert.rejects(
      readXaAudio(
        {
          size: 2352 * 4096,
          async read(_offset, length) {
            return new Uint8Array(length);
          },
        },
        'cached.bin',
        () => {
          if (cancelled) throw new FormatError('CANCELLED');
        },
      ),
      (error) => error.code === 'CANCELLED',
    );
  } finally {
    clearTimeout(timer);
  }
});
