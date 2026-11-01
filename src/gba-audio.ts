import type {
  AudioAsset,
  AudioImport,
  ByteSource,
  Diagnostic,
  ProgressReporter,
} from './contracts.js';
import { Bin, bounds, check } from './binary.js';
import { readAudio } from './audio-codecs.js';
import { openGbaCartridge } from './gba-cartridge.js';
import type { M4aSongs } from './m4a-types.js';
export type { M4aSong, M4aSongs } from './m4a-types.js';

interface M4aDriver {
  mode: number;
  songTable: number;
  tracks: number[];
}

interface M4aWave {
  offset: number;
  frequency: number;
  size: number;
  loop: boolean;
  loopStart: number;
}

const signatures = [
  '00b50004074a0849400b401883885900c918890089180a680168101c00f0',
  '00b50004074b0849400b40188288510089188900c9180a680168101c00f0',
].map((value) =>
  Uint8Array.from(value.match(/../g) ?? [], (byte) => parseInt(byte, 16)),
);

function romOffset(source: ByteSource, address: number, size = 1) {
  const offset = address - 0x08000000;
  return offset >= 0 && size <= source.size - offset ? offset : null;
}

function ramAddress(address: number) {
  return (
    (address >= 0x02000000 && address < 0x02040000) ||
    (address >= 0x03000000 && address < 0x03008000)
  );
}

async function driverAt(source: ByteSource, offset: number) {
  if (offset < 64 || offset % 2 || offset + 44 > source.size) return null;
  const bytes = new Bin(await readAudio(source, offset - 64, 108));
  const playerTable = romOffset(source, bytes.u32(100), 12);
  const songTable = romOffset(source, bytes.u32(104), 8);
  if (playerTable === null || songTable === null || songTable % 4) return null;
  for (let main = 32; main <= 64; main += 2) {
    if (bytes.u16(main) !== 0xb500) continue;
    for (const distance of [16, 32]) {
      const config = main - distance;
      const mode = bytes.u32(config);
      const players = bytes.u32(config + 4);
      const table = romOffset(source, bytes.u32(config + 8), players * 12);
      const polyphony = (mode >>> 8) & 15;
      const frequency = (mode >>> 16) & 15;
      const dac = (mode >>> 20) & 15;
      if (
        mode >>> 24 ||
        !((mode >>> 12) & 15) ||
        polyphony < 1 ||
        polyphony > 12 ||
        frequency < 1 ||
        frequency > 12 ||
        dac < 8 ||
        dac > 11 ||
        players < 1 ||
        players > 32 ||
        table !== playerTable ||
        table + players * 12 !== songTable
      )
        continue;
      const records = new Bin(await readAudio(source, table, players * 12));
      const tracks: number[] = [];
      for (let player = 0; player < players; player++) {
        const at = player * 12;
        const count = records.u8(at + 8);
        if (
          !ramAddress(records.u32(at)) ||
          !ramAddress(records.u32(at + 4)) ||
          count < 1 ||
          count > 16
        )
          break;
        tracks.push(count);
      }
      if (tracks.length === players) return { mode, songTable, tracks };
    }
  }
  return null;
}

async function songsFor(
  source: ByteSource,
  driver: M4aDriver,
  report: ProgressReporter,
) {
  const banks = new Set<number>();
  const songs: M4aSongs['songs'] = [];
  let slots = 0;
  let nonempty = 0;
  for (
    ;
    slots < 4096 && driver.songTable + slots * 8 + 8 <= source.size;
    slots++
  ) {
    if (slots % 64 === 0) {
      report({ phase: 'scan' });
      await new Promise<void>((resolve) => setTimeout(resolve, 0));
    }
    const entry = new Bin(
      await readAudio(source, driver.songTable + slots * 8, 8),
    );
    const songOffset = romOffset(source, entry.u32(0), 8);
    const player = entry.u16(4);
    if (
      songOffset === null ||
      songOffset % 4 ||
      player >= driver.tracks.length ||
      entry.u16(6) >= driver.tracks.length
    )
      break;
    const song = new Bin(await readAudio(source, songOffset, 8));
    const tracks = song.u8(0);
    if (tracks === 0) continue;
    const bank = romOffset(source, song.u32(4), 128 * 12);
    if (
      tracks > driver.tracks[player] ||
      bank === null ||
      bank % 4 ||
      songOffset + 8 + tracks * 4 > source.size
    )
      break;
    const parts = new Bin(await readAudio(source, songOffset + 8, tracks * 4));
    let valid = true;
    for (let track = 0; track < tracks; track++)
      if (romOffset(source, parts.u32(track * 4)) === null) valid = false;
    if (!valid) break;
    banks.add(bank);
    songs.push({
      index: slots,
      offset: songOffset,
      bank,
      tracks: Array.from(
        { length: tracks },
        (_, track) => parts.u32(track * 4) - 0x08000000,
      ),
      priority: song.u8(2),
      reverb: song.u8(3),
      blocks: song.u8(1),
    });
    nonempty++;
  }
  return nonempty > 0 && slots < 4096
    ? { slots, nonempty, banks: [...banks], mode: driver.mode, songs }
    : null;
}

export async function readM4aCatalog(
  source: ByteSource,
  report: ProgressReporter = () => {},
): Promise<M4aSongs> {
  let tail = new Uint8Array(0);
  let candidates = 0;
  for (let offset = 0; offset < source.size; offset += 65536) {
    report({ phase: 'scan', value: offset / source.size });
    const chunk = await readAudio(
      source,
      offset,
      Math.min(65536, source.size - offset),
    );
    const bytes = new Uint8Array(tail.length + chunk.length);
    bytes.set(tail);
    bytes.set(chunk, tail.length);
    for (let at = 0; at + 28 <= bytes.length; at++) {
      if (bytes[at] !== 0 || bytes[at + 1] !== 0xb5) continue;
      if (
        !signatures.some((signature) =>
          signature.every((value, index) => bytes[at + index] === value),
        )
      )
        continue;
      check(
        ++candidates <= 64,
        'GBA_AUDIO_DRIVER',
        'Too many M4A driver candidates.',
      );
      const driver = await driverAt(source, offset - tail.length + at);
      if (driver === null) continue;
      const songs = await songsFor(source, driver, report);
      if (songs !== null) return songs;
    }
    tail = bytes.slice(Math.max(0, bytes.length - 27));
    await new Promise<void>((resolve) => setTimeout(resolve, 0));
  }
  check(
    false,
    'GBA_AUDIO_DRIVER',
    'No validated supported M4A sound driver and song table were found.',
  );
}

async function waveAt(source: ByteSource, offset: number) {
  if (offset % 4 || offset + 16 > source.size) return null;
  const header = new Bin(await readAudio(source, offset, 16));
  const flags = header.u32(0);
  const frequency = header.u32(4);
  const size = header.u32(12);
  const loopStart = header.u32(8);
  const loop = flags === 0x40000000;
  if (
    (flags !== 0 && !loop) ||
    frequency < 1024 ||
    frequency > 192000 * 1024 ||
    size < 1 ||
    size > source.size - offset - 16 ||
    loopStart > size ||
    (loop && loopStart === size)
  )
    return null;
  return { offset, frequency, size, loop, loopStart };
}

async function collectWaves(
  source: ByteSource,
  songs: M4aSongs,
  report: ProgressReporter,
) {
  const samples = new Map<number, M4aWave>();
  const visited = new Set<number>();
  const checkedWaves = new Set<number>();
  let skipped = 0;
  for (const bank of songs.banks) {
    const pending = Array.from({ length: 128 }, (_, index) => ({
      offset: bank + index * 12,
      grouped: false,
    }));
    for (let index = 0; index < pending.length; index++) {
      check(
        visited.size <= 65536,
        'GBA_AUDIO_DRIVER',
        'M4A instrument limit exceeded.',
      );
      if (index % 32 === 0) {
        report({ phase: 'scan', count: samples.size });
        await new Promise<void>((resolve) => setTimeout(resolve, 0));
      }
      const item = pending[index];
      if (visited.has(item.offset)) continue;
      visited.add(item.offset);
      const voice = new Bin(await readAudio(source, item.offset, 12));
      if (voice.b.every((value) => value === 0)) continue;
      const type = voice.u8(0);
      if (type === 0 || type === 8) {
        const offset = romOffset(source, voice.u32(4), 16);
        if (offset === null) {
          skipped++;
          continue;
        }
        if (checkedWaves.has(offset)) continue;
        checkedWaves.add(offset);
        const wave = await waveAt(source, offset);
        if (wave === null) skipped++;
        else samples.set(offset, wave);
      } else if ((type === 0x40 || type === 0x80) && !item.grouped) {
        const table = romOffset(source, voice.u32(4), 12);
        const map = type === 0x40 ? romOffset(source, voice.u32(8), 128) : null;
        if (table === null || table % 4 || (type === 0x40 && map === null)) {
          skipped++;
          continue;
        }
        const keys =
          map === null
            ? Uint8Array.from({ length: 128 }, (_, key) => key)
            : await readAudio(source, map, 128);
        for (const key of new Set(keys)) {
          if (table + key * 12 + 12 > source.size) {
            skipped++;
            continue;
          }
          pending.push({ offset: table + key * 12, grouped: true });
        }
      } else if (![1, 2, 3, 4].includes(type)) skipped++;
    }
  }
  return {
    samples: [...samples.values()].sort(
      (left, right) => left.offset - right.offset,
    ),
    skipped,
  };
}

function waveSource(source: ByteSource, wave: M4aWave): ByteSource {
  const header = new Uint8Array(wave.loop ? 112 : 44);
  const view = new DataView(header.buffer);
  const text = (offset: number, value: string) =>
    header.set(new TextEncoder().encode(value), offset);
  const size = header.length + wave.size + (wave.size & 1);
  const rate = Math.round(wave.frequency / 1024);
  text(0, 'RIFF');
  view.setUint32(4, size - 8, true);
  text(8, 'WAVEfmt ');
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true);
  view.setUint16(22, 1, true);
  view.setUint32(24, rate, true);
  view.setUint32(28, rate, true);
  view.setUint16(32, 1, true);
  view.setUint16(34, 8, true);
  if (wave.loop) {
    text(36, 'smpl');
    view.setUint32(40, 60, true);
    view.setUint32(52, Math.round(1e9 / (wave.frequency / 1024)), true);
    view.setUint32(56, 60, true);
    view.setUint32(72, 1, true);
    view.setUint32(88, wave.loopStart, true);
    view.setUint32(92, wave.size - 1, true);
  }
  text(header.length - 8, 'data');
  view.setUint32(header.length - 4, wave.size, true);
  return {
    size,
    async read(offset, length) {
      bounds(size, offset, length);
      const output = new Uint8Array(length);
      if (offset < header.length)
        output.set(
          header.subarray(offset, Math.min(header.length, offset + length)),
        );
      const start = Math.max(offset, header.length);
      const end = Math.min(offset + length, header.length + wave.size);
      for (let at = start; at < end; at += 65536) {
        const bytes = await readAudio(
          source,
          wave.offset + 16 + at - header.length,
          Math.min(65536, end - at),
        );
        for (let index = 0; index < bytes.length; index++)
          output[at - offset + index] = bytes[index] ^ 128;
      }
      return output;
    },
  };
}

function cartridgeName(name: string) {
  return (
    name
      .replaceAll('\\', '/')
      .split('/')
      .at(-1)
      ?.replace(/\.gba$/i, '') || 'gba'
  );
}

async function sampleImport(
  source: ByteSource,
  name: string,
  songs: M4aSongs,
  report: ProgressReporter,
  samplesOnly: boolean,
): Promise<AudioImport> {
  const { samples, skipped } = await collectWaves(source, songs, report);
  check(
    !samplesOnly || samples.length > 0,
    'GBA_AUDIO_SAMPLES',
    'The validated M4A driver has no supported valid original PCM instruments.',
  );
  const prefix = cartridgeName(name);
  const assets: AudioAsset[] = samples.map((wave) => {
    const encoded = waveSource(source, wave);
    return {
      source: encoded,
      name:
        prefix +
        '/gba-m4a/samples/pcm_' +
        wave.offset.toString(16).padStart(8, '0') +
        '.wav',
      format: 'WAV',
      size: encoded.size,
      kind: 'sample',
      playable: true,
      gameAudio: true,
    };
  });
  const warnings: Diagnostic[] = [];
  if (samplesOnly)
    warnings.push({
      code: 'GBA_M4A_SAMPLES_ONLY',
      detail:
        songs.slots +
        ' song slots; ' +
        songs.nonempty +
        ' nonempty; ' +
        songs.banks.length +
        ' voicegroup' +
        (songs.banks.length === 1 ? '' : 's') +
        '; ' +
        assets.length +
        ' PCM sample' +
        (assets.length === 1 ? '' : 's') +
        '. Original instruments at reference rates; complete songs, note sequences and CGB channels are not rendered.',
    });
  if (skipped)
    warnings.push({
      code: 'GBA_M4A_SKIPPED',
      detail:
        String(skipped) +
        ' invalid or unsupported M4A instrument records omitted.',
    });
  const rounded = samples.filter((wave) => wave.frequency % 1024 !== 0).length;
  if (rounded)
    warnings.push({
      code: 'GBA_M4A_RATE_ROUNDED',
      detail:
        String(rounded) +
        ' M4A reference rates rounded to the nearest integer Hz for WAV, with at most 0.5 Hz difference; PCM samples are unchanged.',
    });
  report({ phase: 'scan', value: 1, count: assets.length });
  return { assets, warnings };
}

export async function readGbaSamples(
  source: ByteSource,
  name: string,
  report: ProgressReporter = () => {},
): Promise<AudioImport> {
  await openGbaCartridge(source, name);
  return sampleImport(
    source,
    name,
    await readM4aCatalog(source, report),
    report,
    true,
  );
}

export async function readGbaAudio(
  source: ByteSource,
  name: string,
  report: ProgressReporter = () => {},
): Promise<AudioImport> {
  await openGbaCartridge(source, name);
  const catalog = await readM4aCatalog(source, report);
  const samples = await sampleImport(source, name, catalog, report, false);
  const original = {
    name: name.replaceAll('\\', '/'),
    source,
    size: source.size,
  };
  const songs: AudioAsset[] = catalog.songs.map((song) => ({
    source,
    name:
      cartridgeName(name) +
      '/m4a/song_' +
      String(song.index).padStart(3, '0') +
      '.gba',
    format: 'GBA',
    size: source.size,
    kind: 'sequence',
    playable: true,
    gameAudio: true,
    song: song.index,
    m4a: { mode: catalog.mode, song },
    dependencies: [original],
  }));
  return { assets: [...songs, ...samples.assets], warnings: samples.warnings };
}
