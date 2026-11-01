import type { AudioAsset, AudioImport } from './contracts.js';
import { bounds, check } from './binary.js';
import { SPCAPU } from './vendor/spc700-js/apu.js';
import { snapshotSnesAudio } from './snes-snapshot.js';

type Checkpoint = () => Promise<void>;

export interface HeartBeatProfile {
  name: string;
  driver: { offset: number; size: number; load: number; entry: number };
  songs: { offset: number; count: number };
  samples: { offset: number; count: number };
  ignoredControlIds?: readonly number[];
}

interface HeartBeatSample {
  loop: number;
  body: Uint8Array;
}

interface HeartBeatSong {
  id: number;
  body: Uint8Array;
  samples: HeartBeatSample[];
}

const dq3: HeartBeatProfile = {
  name: 'HeartBeat DQ3',
  driver: { offset: 0x5940e, size: 0x140d, load: 0xb00, entry: 0xb00 },
  songs: { offset: 0x723bc, count: 383 },
  samples: { offset: 0x8023a, count: 62 },
  ignoredControlIds: [0, 147],
};

const u16 = (bytes: Uint8Array, p: number) => bytes[p] | (bytes[p + 1] << 8);
const u24 = (bytes: Uint8Array, p: number) =>
  u16(bytes, p) | (bytes[p + 2] << 16);
const inRange = (size: number, p: number, length: number) =>
  Number.isSafeInteger(p) &&
  Number.isSafeInteger(length) &&
  p >= 0 &&
  length >= 0 &&
  p <= size &&
  length <= size - p;
const valid = (ok: unknown, detail: string) => check(ok, 'SFC_DRIVER', detail);

function hiromPointer(bytes: Uint8Array, p: number) {
  if (!inRange(bytes.length, p, 3)) return -1;
  const address = u24(bytes, p),
    bank = address >>> 16;
  if (bank < 0x40 || (bank >= 0x7e && bank < 0xc0)) return -1;
  return address & 0x3fffff;
}

export function findHeartBeatProfile(
  bytes: Uint8Array,
  hirom: boolean,
  title: string,
): HeartBeatProfile | null {
  if (!hirom || title !== 'DRAGONQUEST3' || bytes.length < 0x3c9f20)
    return null;
  const driver = dq3.driver,
    end = driver.offset + driver.size;
  if (
    u16(bytes, driver.offset - 4) !== driver.size ||
    u16(bytes, driver.offset - 2) !== driver.load ||
    u16(bytes, end) !== 0 ||
    u16(bytes, end + 2) !== driver.entry
  )
    return null;
  let hash = 2166136261;
  for (let p = driver.offset; p < end; p++)
    hash = Math.imul(hash ^ bytes[p], 16777619);
  return hash >>> 0 === 9018486 ? dq3 : null;
}

function readSample(
  bytes: Uint8Array,
  profile: HeartBeatProfile,
  id: number,
): HeartBeatSample | null {
  if (id >= profile.samples.count) return null;
  const p = hiromPointer(bytes, profile.samples.offset + id * 3);
  if (!inRange(bytes.length, p, 4)) return null;
  const length = u16(bytes, p),
    loop = u16(bytes, p + 2);
  if (
    !length ||
    length % 9 ||
    loop % 9 ||
    loop > length ||
    !inRange(bytes.length, p + 4, length) ||
    !(bytes[p + 4 + length - 9] & 1) ||
    (bytes[p + 4 + length - 9] & 2 && loop === length)
  )
    return null;
  return { loop, body: bytes.subarray(p + 4, p + 4 + length) };
}

function sequenceContent(
  body: Uint8Array,
  tracks: number[],
  header: number,
): 'notes' | 'control' | 'invalid' {
  const pending = [...tracks],
    visited = new Set<number>();
  const argumentsByCommand = [
    0, 0, 0, 0, 1, 0, 1, 2, 3, 1, 0, 1, 2, 1, 1, 1, 1, 3, 0, 1, 2, 3, 3, 3, 0,
    1, 2, 3, 3, 0, 0, 8, 2, 1, 2, 2, 0, 0, 0, 1, 0,
  ];
  while (pending.length && visited.size < body.length) {
    let p = pending.pop();
    if (p === undefined) break;
    while (p < body.length && !visited.has(p)) {
      visited.add(p);
      const command = body[p++];
      if (!command || command === 0xf4) break;
      if (command < 0x80) {
        if (p >= body.length) return 'invalid';
        if (body[p] < 0x80) p++;
        if (p >= body.length) return 'invalid';
        continue;
      }
      if (command <= 0xcf) return 'notes';
      if (command > 0xf9) return 'invalid';
      let count = argumentsByCommand[command - 0xd0];
      if (command === 0xf9) {
        if (p >= body.length) return 'invalid';
        const subcommand = body[p++];
        if (subcommand > 9 || subcommand === 8) return 'invalid';
        count =
          subcommand === 1 || subcommand === 9 ? 2 : subcommand === 2 ? 0 : 1;
        if (subcommand === 1 && inRange(body.length, p, count)) {
          const target = u16(body, p);
          if (target < header || target >= body.length) return 'invalid';
          pending.push(target);
        }
      }
      if (!inRange(body.length, p, count)) return 'invalid';
      if (command === 0xf2 || command === 0xf3) {
        const target = u16(body, p);
        if (target < header || target >= body.length) return 'invalid';
        pending.push(target);
        if (command === 0xf2) break;
      }
      p += count;
      if (p >= body.length) return 'invalid';
    }
  }
  return 'control';
}

function readSong(
  bytes: Uint8Array,
  profile: HeartBeatProfile,
  id: number,
  samples: Map<number, HeartBeatSample | null>,
): HeartBeatSong | 'control' | null {
  const p = hiromPointer(bytes, profile.songs.offset + id * 4 + 1);
  if (!inRange(bytes.length, p, 1)) return null;
  const count = bytes[p],
    sequence = p + 1 + count;
  if (count < 1 || count > 128 || !inRange(bytes.length, sequence, 2))
    return null;
  const length = u16(bytes, sequence),
    start = sequence + 2;
  if (!length || !inRange(bytes.length, start, length)) return null;
  const body = bytes.subarray(start, start + length);
  const records: HeartBeatSample[] = [];
  let end = 0x2300 + Math.ceil(length / 3) * 3;
  for (let index = 0; index < count; index++) {
    const sampleId = bytes[p + 1 + index];
    if (!samples.has(sampleId))
      samples.set(sampleId, readSample(bytes, profile, sampleId));
    const sample = samples.get(sampleId);
    if (!sample) return null;
    end += sample.body.length;
    if (end > 0xff00) return null;
    records.push(sample);
  }
  if (length === 1 && !body[0]) return 'control';
  if (count > 16 || length < 8) return null;
  const instruments = u16(body, 0),
    tracks: number[] = [];
  let header = 2;
  for (let track = 0; track < 8; track++) {
    if (!inRange(length, header, 2)) return null;
    const pointer = u16(body, header);
    header += 2;
    if (!pointer) break;
    if (pointer >= length) return null;
    tracks.push(pointer);
  }
  if (
    !tracks.length ||
    instruments < header ||
    instruments + 6 > Math.min(...tracks) ||
    tracks.some((pointer) => pointer < header)
  )
    return null;
  const content = sequenceContent(body, tracks, header);
  if (content === 'invalid') return null;
  if (content === 'control') return 'control';
  return { id, body, samples: records };
}

class HeartBeatHost {
  readonly apu = new SPCAPU();
  private counter = 0;
  private samples = 0;

  constructor(
    bytes: Uint8Array,
    profile: HeartBeatProfile,
    readonly checkpoint: Checkpoint,
  ) {
    this.apu.reset();
    const driver = profile.driver;
    this.apu.ram.set(
      bytes.subarray(driver.offset, driver.offset + driver.size),
      driver.load,
    );
    this.apu.cpu.PC = driver.entry;
  }

  async pump(until: () => boolean, limit = 32000) {
    for (let count = 0; !until(); count++) {
      valid(
        count < limit && !this.apu.cpu.halted,
        'The original HeartBeat SPC program did not acknowledge its audio command.',
      );
      this.apu.renderSample(this.apu.sampleOut);
      if ((++this.samples & 1023) === 0) await this.checkpoint();
    }
  }

  async send(command: number | null, parameter: number) {
    if (command !== null) this.apu.inputPorts[1] = command;
    this.apu.inputPorts[2] = parameter & 255;
    this.apu.inputPorts[3] = parameter >> 8;
    await this.acknowledge();
  }

  async acknowledge() {
    this.counter = (this.counter + 1) & 255;
    this.apu.inputPorts[0] = this.counter;
    await this.pump(() => this.apu.outputPorts[0] === this.counter);
  }

  async transfer(bytes: Uint8Array) {
    for (let p = 0; p < bytes.length; p += 3) {
      this.apu.inputPorts[1] = bytes[p];
      this.apu.inputPorts[2] = bytes[p + 1] || 0;
      this.apu.inputPorts[3] = bytes[p + 2] || 0;
      await this.acknowledge();
      if ((p & 1023) === 0) await this.checkpoint();
    }
  }

  async load(song: HeartBeatSong) {
    await this.checkpoint();
    await this.pump(
      () =>
        this.apu.outputPorts[1] === 0x65 &&
        this.apu.outputPorts[2] === 0x61 &&
        this.apu.outputPorts[3] === 0x74,
    );
    let address = 0x2300 + Math.ceil(song.body.length / 3) * 3;
    for (let id = 0; id < song.samples.length; id++) {
      const sample = song.samples[id];
      await this.send(1, 0);
      for (const parameter of [
        id,
        address,
        address + sample.loop,
        sample.body.length / 3,
      ])
        await this.send(null, parameter);
      await this.transfer(sample.body);
      address += sample.body.length;
    }
    await this.send(2, 0);
    await this.send(null, 0);
    for (let id = 0; id < 16; id += 2)
      await this.send(null, id | ((id + 1) << 8));
    await this.send(null, 0x2300);
    await this.send(null, Math.ceil(song.body.length / 3));
    await this.transfer(song.body);
    this.apu.inputPorts[1] = 3;
    this.apu.inputPorts[2] = 0;
    this.apu.inputPorts[3] = 0;
    this.apu.inputPorts[0] = (this.counter + 1) & 255;
  }
}

export async function extractHeartBeatAudio(
  bytes: Uint8Array,
  profile: HeartBeatProfile,
  title: string,
  checkpoint: Checkpoint,
): Promise<AudioImport> {
  const driver = profile.driver;
  valid(
    inRange(bytes.length, driver.offset, driver.size) &&
      driver.size > 0 &&
      inRange(0x2300, driver.load, driver.size) &&
      driver.entry >= driver.load &&
      driver.entry < driver.load + driver.size &&
      Number.isSafeInteger(driver.entry) &&
      Number.isSafeInteger(profile.songs.count) &&
      profile.songs.count > 0 &&
      profile.songs.count <= 1024 &&
      Number.isSafeInteger(profile.samples.count) &&
      profile.samples.count > 0 &&
      profile.samples.count <= 256 &&
      inRange(bytes.length, profile.songs.offset, profile.songs.count * 4) &&
      inRange(
        bytes.length,
        profile.samples.offset,
        profile.samples.count * 3,
      ) &&
      (profile.ignoredControlIds?.length ?? 0) <= profile.songs.count &&
      (profile.ignoredControlIds ?? []).every(
        (id) => Number.isSafeInteger(id) && id >= 0 && id < profile.songs.count,
      ),
    'The HeartBeat driver profile or pointer tables are out of range.',
  );
  const assets: AudioAsset[] = [],
    samples = new Map<number, HeartBeatSample | null>(),
    ignoredControls = new Set(profile.ignoredControlIds);
  const skipped: number[] = [];
  let cached: { id: number; bytes: Promise<Uint8Array> } | null = null;
  for (let id = 0; id < profile.songs.count; id++) {
    await checkpoint();
    const song = readSong(bytes, profile, id, samples);
    if (song === 'control') {
      if (!ignoredControls.has(id)) skipped.push(id);
      continue;
    }
    if (!song) {
      skipped.push(id);
      continue;
    }
    const name = `${profile.name} sequence ${String(id).padStart(3, '0')}.spc`;
    assets.push({
      name,
      format: 'SPC',
      size: 0x10200,
      gameAudio: true,
      source: {
        size: 0x10200,
        async read(offset, length) {
          bounds(0x10200, offset, length);
          await checkpoint();
          if (!length) return new Uint8Array();
          if (!cached || cached.id !== id) {
            const host = new HeartBeatHost(bytes, profile, checkpoint);
            const pending = host
              .load(song)
              .then(() =>
                snapshotSnesAudio(host.apu, name.replace(/\.spc$/i, ''), title),
              );
            cached = { id, bytes: pending };
          }
          const pending = cached.bytes;
          try {
            return (await pending).slice(offset, offset + length);
          } catch (error) {
            if (cached?.bytes === pending) cached = null;
            throw error;
          }
        },
      },
    });
  }
  valid(assets.length, 'No complete valid HeartBeat audio sequence was found.');
  return {
    assets,
    warnings: skipped.length
      ? [
          {
            code: 'SFC_PARTIAL',
            detail: `${profile.name}: ${assets.length} native sequence entries use their original SPC program and BRR instruments.${skipped.length ? ` ${skipped.length} preload, control, invalid, or unavailable-sample entries were skipped (native IDs ${skipped.slice(0, 32).join(', ')}${skipped.length > 32 ? ', …' : ''}).` : ''} Music, jingles and effects retain native sequence IDs. Game-driven transitions and external playback commands are not reconstructed.`,
          },
        ]
      : [],
  };
}
