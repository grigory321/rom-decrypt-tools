import test from 'node:test';
import assert from 'node:assert/strict';
import { cubeRom } from './snes-cube-fixtures.js';
import { extractSnesAudio } from '../dist/snes-extract.js';
import { arraySource } from '../dist/binary.js';
import { parseSPC } from '../dist/vendor/spc700-js/spc-file.js';
import { SPCPlayer } from '../dist/vendor/spc700-js/player.js';
import { extractCubeAudio } from '../dist/snes-cube.js';

const mapping = {
  hirom: false,
  addressToFile(address) {
    const bank = address >>> 16,
      low = address & 65535;
    return low < 0x8000 || bank === 0x7e || bank === 0x7f
      ? -1
      : (bank & 127) * 32768 + (low & 32767);
  },
};

const extract = (fixture, report = () => {}) =>
  extractSnesAudio(arraySource(fixture.bytes), 'Original.sfc', report);

test('Cube ignores unreachable bytes after an infinite native loop', async () => {
  const result = await extract(cubeRom({ loopTail: true }));
  assert.equal(
    result.assets.filter((asset) => asset.name.includes('music')).length,
    2,
  );
});

test('Cube noise instruments do not require a BRR sample with the noise flag as its index', async () => {
  const fixture = cubeRom();
  fixture.bytes[0x10110] = 0x81;
  const result = await extract(fixture);
  assert.equal(
    result.assets.filter((asset) => asset.name.includes('music')).length,
    2,
  );
});

test('Cube resolves percussion notes through the native kit and instrument tables', async () => {
  const fixture = cubeRom({ missingAssociation: true });
  fixture.bytes[0x10110] = 0x7f;
  fixture.bytes[0x10112] = 4;
  const result = await extract(fixture);
  assert.equal(
    result.assets.filter((asset) => asset.name.includes('music')).length,
    2,
  );
});

test('Cube retains the outer loop after a finite inner repeat and resolves the later instrument', async () => {
  const result = await extract(cubeRom({ nestedLoops: true }));
  const music = result.assets.filter((asset) => asset.name.includes('music'));
  assert.equal(music.length, 2);
  const parsed = parseSPC(await music[0].source.read(0, 0x10200));
  assert.notEqual(parsed.ram[0x3008] | (parsed.ram[0x3009] << 8), 0);
});

test('Cube resident effects retain native directory samples and distinct PCM', async () => {
  const result = await extract(cubeRom());
  const effects = result.assets.filter((asset) =>
    asset.name.includes('effect'),
  );
  assert.equal(effects.length, 2);
  const waves = [];
  for (const asset of effects) {
    const player = new SPCPlayer({ sampleRate: 32000 });
    player.load(await asset.source.read(0, asset.size));
    const pcm = player.render(2048).left;
    assert.ok(pcm.some((sample) => Math.abs(sample) > 100));
    waves.push(pcm);
  }
  assert.notDeepEqual(waves[0], waves[1]);
});

test('Cube keeps resident effects with a partial diagnostic when host music references cannot be verified', async () => {
  const fixture = cubeRom();
  fixture.bytes[fixture.code] = 0;
  const result = await extract(fixture);
  assert.equal(result.assets.length, 2);
  assert.equal(result.warnings[0]?.code, 'SFC_PARTIAL');
});

test('Cube preserves valid music siblings when an explicitly loaded BRR record is damaged', async () => {
  const fixture = cubeRom();
  fixture.bytes[0x18140] = 8;
  const result = await extract(fixture);
  assert.equal(
    result.assets.filter((asset) => asset.name.includes('music')).length,
    1,
  );
  assert.equal(result.warnings[0].code, 'SFC_PARTIAL');
});

test('Cube snapshots remain independent, copy safe and cancellable after cached reads', async () => {
  const fixture = cubeRom();
  let stop = false;
  const cancelled = new Error('cancel Cube');
  const result = await extractCubeAudio(
    fixture.bytes,
    'Authored',
    mapping,
    async () => {
      if (stop) throw cancelled;
    },
  );
  assert.ok(result);
  const [first, second] = await Promise.all(
    result.assets.slice(0, 2).map((asset) => asset.source.read(0, asset.size)),
  );
  assert.notDeepEqual(first, second);
  first.fill(0);
  assert.equal((await result.assets[0].source.read(0, 1))[0], 83);
  stop = true;
  await assert.rejects(result.assets[0].source.read(0, 1), cancelled);
  stop = false;
  assert.equal((await result.assets[0].source.read(0, 1))[0], 83);
  await assert.rejects(result.assets[0].source.read(0x10200, 1));
  assert.equal((await result.assets[0].source.read(0, 0)).length, 0);
});

test('Cube rejects altered native ports and bounds a halted bootstrap', async () => {
  const wrong = cubeRom();
  const port = Buffer.from(wrong.bytes).indexOf(
    Buffer.from([0xe4, 0xf4, 0xf0]),
  );
  assert.ok(port > 0);
  wrong.bytes[port + 1] = 0xf6;
  await assert.rejects(extract(wrong), { code: 'SFC_DRIVER' });
  const halted = cubeRom();
  halted.bytes[halted.upload + 9] = 0xff;
  const result = await extract(halted);
  await assert.rejects(result.assets[0].source.read(0, 1), {
    code: 'SFC_DRIVER',
  });
  await assert.rejects(result.assets[0].source.read(0, 1), {
    code: 'SFC_DRIVER',
  });
});

test('Cube rejects a native program that halts before accepting the final playback command', async () => {
  const fixture = cubeRom();
  fixture.bytes[fixture.upload + 4 + 0x203] = 0xff;
  const result = await extract(fixture);
  const music = result.assets.find((asset) => asset.name.includes('music'));
  await assert.rejects(music.source.read(0, 1), { code: 'SFC_DRIVER' });
});

test('Cube rejects overlap with the four-byte native echo buffer even when echo delay is zero', async () => {
  const result = await extract(cubeRom({ echoAtMusic: true }));
  const music = result.assets.find((asset) => asset.name.includes('music'));
  await assert.rejects(music.source.read(0, 1), { code: 'SFC_DRIVER' });
});

test('Cube retains a resident waveform when the host never requests its replacement', async () => {
  const fixture = cubeRom();
  fixture.bytes[fixture.associations + 6] = 0xfe;
  fixture.bytes.fill(0x77, 0x18145, 0x1814d);
  const result = await extract(fixture);
  const music = result.assets.filter((asset) => asset.name.includes('music'));
  const parsed = parseSPC(await music[1].source.read(0, 0x10200));
  const start = parsed.ram[0x3008] | (parsed.ram[0x3009] << 8);
  assert.equal(start, 0x3210);
  assert.deepEqual(
    [...parsed.ram.subarray(start, start + 9)],
    [0xc3, ...Array(8).fill(0x33)],
  );
});

test('Cube import strips copier headers and keeps original file reads bounded', async () => {
  const fixture = cubeRom({ shift: 0x800 });
  const bytes = new Uint8Array(fixture.bytes.length + 512);
  bytes.set(fixture.bytes, 512);
  let largest = 0;
  const result = await extractSnesAudio(
    {
      size: bytes.length,
      async read(p, n) {
        largest = Math.max(largest, n);
        return bytes.slice(p, p + n);
      },
    },
    'renamed.smc',
  );
  assert.equal(result.assets.length, 4);
  assert.ok(largest <= 65536);
});

test('Cube false bootstrap candidates remain cancellable before the next ROM scan page', async () => {
  const bytes = new Uint8Array(13 * 256);
  for (let p = 0; p < bytes.length; p += 13)
    bytes.set([5, 0, 0, 2, 0xc0, 0x20, 0xcd, 0xff, 0xbd, 0, 0, 0, 2], p);
  let count = 0;
  const cancelled = new Error('cancel false Cube candidates');
  await assert.rejects(
    extractCubeAudio(bytes, 'Authored', mapping, async () => {
      if (++count === 2) throw cancelled;
    }),
    cancelled,
  );
});

test('Cube ROM extraction resolves native music and unlisted instrument dependencies through relocated ROM tables', async () => {
  const fixture = cubeRom({ shift: 0x400, missingAssociation: true });
  const result = await extract(fixture);
  const music = result.assets.filter((asset) => asset.name.includes('music'));
  assert.equal(music.length, 2);
  const waveforms = [];
  for (const [index, asset] of music.entries()) {
    const snapshot = await asset.source.read(0, asset.size);
    const parsed = parseSPC(snapshot);
    assert.equal(parsed.ram[0x400d], 0xfc);
    assert.equal(parsed.ram[0x400e], index + 1);
    const directory = 0x3000 + (index + 1) * 4;
    const start = parsed.ram[directory] | (parsed.ram[directory + 1] << 8);
    assert.deepEqual(
      [...parsed.ram.subarray(start, start + 9)],
      [0xc3, ...Array(8).fill(index ? 0x33 : 0x77)],
    );
    const player = new SPCPlayer({ sampleRate: 32000 });
    player.load(snapshot);
    const pcm = player.render(4096).left;
    assert.ok(pcm.some((sample) => Math.abs(sample) > 100));
    waveforms.push(pcm);
  }
  assert.notDeepEqual(waveforms[0], waveforms[1]);
});
