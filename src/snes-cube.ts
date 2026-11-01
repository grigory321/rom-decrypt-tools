import type { AudioAsset, AudioImport } from './contracts.js';
import { bounds, check } from './binary.js';
import { SPCAPU } from './vendor/spc700-js/apu.js';
import { snapshotSnesAudio } from './snes-snapshot.js';
import {
  materializeSnesUpload,
  scanSnesUploads,
  snesPattern,
  snesRange,
  snesUploadSuffix,
  type SnesImage,
  type SnesUpload,
} from './snes-upload.js';

type Checkpoint = () => Promise<void>;

interface Mapping {
  hirom: boolean;
  addressToFile: (address: number) => number;
}

interface CubeDriver {
  upload: SnesUpload;
  ready: number[];
  commands: {
    load: number;
    sample: number;
    transfer: number;
    music: number;
    effect: number;
  };
  directory: number;
  destination: number;
  effects: { table: number; count: number };
  instruments: number;
  percussion: number;
}

interface Sequence {
  body: Uint8Array;
  notes: Map<number, Set<number>>;
}

interface Sample {
  id: number;
  loop: number;
  body: Uint8Array;
}

interface Selection {
  id: number;
  kind: 'music' | 'effect';
  sequence: Sequence;
  samples: Sample[];
}

interface Descriptor {
  table: number;
  bankBase: number;
  kind: number;
}

const word = (bytes: Uint8Array, p: number) => bytes[p] | (bytes[p + 1] << 8);
const covered = (image: SnesImage, p: number, length: number) =>
  snesRange(65536, p, length) &&
  image.coverage.subarray(p, p + length).every((owner) => owner > 0);

function findPatterns(image: SnesImage, values: readonly number[]) {
  const result: number[] = [];
  for (let p = 0x100; p + values.length <= 0xffc0; p++)
    if (snesPattern(image.ram, p, values) && covered(image, p, values.length))
      result.push(p);
  return result;
}

function detectDriver(
  bytes: Uint8Array,
  upload: SnesUpload,
): CubeDriver | null {
  if (upload.blocks.reduce((sum, block) => sum + block.length, 0) < 128)
    return null;
  const block = upload.blocks.find(
    (part) =>
      upload.entry >= part.destination &&
      upload.entry + 5 <= part.destination + part.length,
  );
  if (
    !block ||
    !snesPattern(
      bytes,
      block.source + upload.entry - block.destination,
      [0xc0, 0x20, 0xcd, -1, 0xbd],
    )
  )
    return null;
  const image = materializeSnesUpload(bytes, upload),
    ram = image.ram;
  const ready = findPatterns(
    image,
    [0x8f, -1, 0xf4, 0x8f, -1, 0xf5, 0x8f, -1, 0xf6, 0x8f, -1, 0xf7],
  ).filter((p) => ram[p + 1] || ram[p + 4] || ram[p + 7] || ram[p + 10]);
  const ack = findPatterns(
    image,
    [0x8f, 0x37, 0xf1, 0xe4, 0xd5, 0xbc, 0xc4, 0xd5, 0xc4, 0xf4],
  );
  const load = findPatterns(
    image,
    [0xe4, 0xf5, 0xc4, 0xd6, 0x8f, -1, 0xd8, 0x8f, -1, 0xd9],
  );
  const directory = findPatterns(
    image,
    [
      0xe4, 0xf5, 0x8f, -1, 0xe0, 0x8f, -1, 0xe1, 0x1c, 0x1c, 0xfd, 0xfa, 0xd8,
      0xd0,
    ],
  );
  const transfer = findPatterns(
    image,
    [
      0xe4, 0xf5, 0xd7, 0xd8, 0x3a, 0xd8, 0xe4, 0xf6, 0xd7, 0xd8, 0x3a, 0xd8,
      0xe4, 0xf7, 0xd7, 0xd8, 0x3a, 0xd8,
    ],
  );
  const music = findPatterns(
    image,
    [
      0x8f, -1, 0xe0, 0x8f, -1, 0xe1, 0xfa, 0xe0, 0xde, 0xfa, 0xe1, 0xdf, 0x8d,
      0, 0xf7, 0xe0, 0xc4, 0xef, 0x3a, 0xe0,
    ],
  );
  const effects = findPatterns(
    image,
    [
      0x1c, 0x5d, 0xf5, -1, -1, 0xc4, 0xe0, 0xf5, -1, -1, 0xc4, 0xe1, 0xfa,
      0xe0, 0xde, 0xfa, 0xe1, 0xdf, 0x8d, 0, 0xcd, 0x60,
    ],
  );
  if (
    [ready, ack, load, directory, transfer, music, effects].some(
      (matches) => matches.length !== 1,
    )
  )
    return null;
  const destination = ram[load[0] + 5] | (ram[load[0] + 8] << 8);
  if (destination !== (ram[music[0] + 1] | (ram[music[0] + 4] << 8)))
    return null;
  const effectTable = word(ram, effects[0] + 3);
  if (word(ram, effects[0] + 8) !== effectTable + 1) return null;
  const dispatch = findPatterns(
    image,
    [0xe4, 0xf4, 0xf0, -1, 0x64, 0xf4, 0xd0, -1, 0x68, -1, 0xf0, -1],
  );
  if (dispatch.length !== 1) return null;
  const start = dispatch[0],
    transferTarget = start + 12 + ((ram[start + 11] << 24) >> 24);
  if (transfer[0] < transferTarget || transfer[0] > transferTarget + 2)
    return null;
  const handlers = new Map<number, number>();
  for (let p = start + 12; p < Math.min(start + 128, 0xffc0); p++)
    if (snesPattern(ram, p, [0x68, -1, 0xd0, 3, 0x5f, -1, -1]))
      handlers.set(ram[p + 1], word(ram, p + 5));
  const commandFor = (address: number, call: boolean) => {
    const found: number[] = [];
    for (const [command, target] of handlers) {
      if (!call && target === address) found.push(command);
      if (call) {
        for (let p = target; p < target + 24; p++) {
          if (!covered(image, p, 3)) break;
          if (ram[p] === 0x5f) break;
          if (snesPattern(ram, p, [0x3f, address & 255, address >> 8])) {
            found.push(command);
            break;
          }
        }
      }
    }
    return found.length === 1 ? found[0] : -1;
  };
  const commands = {
    load: commandFor(load[0], false),
    sample: commandFor(directory[0], false),
    transfer: ram[start + 9],
    music: commandFor(music[0], true),
    effect: commandFor(effects[0], true),
  };
  if (
    Object.values(commands).some((value) => value <= 0) ||
    new Set(Object.values(commands)).size !== 5
  )
    return null;
  const effectHandler = handlers.get(commands.effect);
  if (
    effectHandler === undefined ||
    !snesPattern(ram, effectHandler, [0xe4, 0xf5, 0x68, -1, 0xb0])
  )
    return null;
  const count = ram[effectHandler + 3],
    dir = ram[directory[0] + 3] | (ram[directory[0] + 6] << 8);
  if (
    !count ||
    count > 128 ||
    dir & 255 ||
    destination < dir + 1024 ||
    destination >= 0xff00 ||
    !covered(image, effectTable, count * 2)
  )
    return null;
  if (
    !findPatterns(image, [0x7d, 0x60, 0x88, 0x10, 0x5d, 0xc8, 0x60, 0xd0]).some(
      (p) => p > music[0] && p < music[0] + 128,
    )
  )
    return null;
  const patches = findPatterns(
    image,
    [
      0xe4, 0xe2, 0x1c, 0x1c, 0x1c, 0x5d, 0xf5, -1, -1, 0x2d, 0x3d, 0xe4, 0xe9,
      0x80, 0xb5, -1, -1,
    ],
  );
  const kits = findPatterns(
    image,
    [
      0xcd, 0, 0xf5, -1, -1, 0xc4, 0xe2, 0x3d, 0xe4, 0xe9, 0x75, -1, -1, 0x90,
      5, 0xab, 0xe2, 0x3d, 0x2f, 0xf6, 0xe4, 0xe2,
    ],
  );
  if (
    patches.length !== 1 ||
    kits.length !== 1 ||
    word(ram, patches[0] + 7) !== word(ram, patches[0] + 15) ||
    word(ram, kits[0] + 3) !== word(ram, kits[0] + 11)
  )
    return null;
  return {
    upload,
    ready: [
      ram[ready[0] + 1],
      ram[ready[0] + 4],
      ram[ready[0] + 7],
      ram[ready[0] + 10],
    ],
    commands,
    destination,
    directory: dir,
    instruments: word(ram, patches[0] + 7),
    percussion: word(ram, kits[0] + 3),
    effects: { table: effectTable, count },
  };
}

function parseSequence(
  body: Uint8Array,
  channels: number,
  header: number,
): Sequence | null {
  if (!snesRange(body.length, header, channels * 2)) return null;
  const pending: { p: number; program: number; loop: number; outer: number }[] =
      [],
    notes = new Map<number, Set<number>>(),
    visited = new Set<string>();
  for (let channel = 0; channel < channels; channel++) {
    const pointer = word(body, header + channel * 2);
    if (channels === 2 && pointer === 65535) break;
    if (pointer < header + channels * 2 || pointer >= body.length) return null;
    pending.push({ p: pointer, program: 0, loop: -1, outer: -1 });
  }
  let audible = false;
  while (pending.length) {
    const state = pending.pop();
    if (!state) break;
    let { p, program, loop, outer } = state,
      ended = false;
    while (p < body.length) {
      const key = `${p}:${program}:${loop}:${outer}`;
      if (visited.has(key)) {
        ended = true;
        break;
      }
      if (visited.size > 131072) return null;
      visited.add(key);
      const op = body[p];
      if (op === 0xfe) {
        ended = true;
        break;
      }
      const length =
        op === 0xf9 || (op >= 0x80 && op < 0xf6) || op === 0xff
          ? 1
          : op === 0 || op >= 0xf6
            ? 2
            : 4;
      if (!snesRange(body.length, p, length)) return null;
      if (op === 0xfc) program = body[p + 1];
      if ((op > 0 && op < 0xf6) || op === 0xff) {
        const pitch = op & 127;
        if (pitch) {
          audible = true;
          let pitches = notes.get(program);
          if (!pitches) {
            pitches = new Set();
            notes.set(program, pitches);
          }
          pitches.add(pitch);
        }
      }
      if (op === 0xf9) {
        loop = p + 1;
        if (outer < 0) outer = loop;
      }
      if (op === 0xf8) {
        if (outer < 0) return null;
        if (loop < 0) p = outer;
        else {
          if (body[p + 1] !== 0)
            pending.push({ p: p + 2, program, loop: -1, outer });
          p = loop;
        }
      } else p += length;
    }
    if (!ended) return null;
  }
  return audible ? { body, notes } : null;
}

function sequenceSamples(
  image: SnesImage,
  driver: CubeDriver,
  sequence: Sequence,
) {
  const ids = new Set<number>();
  for (const [program, pitches] of sequence.notes) {
    if (program & 128) continue;
    for (const pitch of pitches) {
      let patch = program;
      if (program === 127) {
        const table = driver.percussion;
        if (!covered(image, table, 2)) return null;
        patch = image.ram[table];
        let index = 1;
        while (index < 33) {
          if (!covered(image, table + index, 1)) return null;
          const threshold = image.ram[table + index];
          if (pitch < threshold) break;
          if (index > 1 && threshold <= image.ram[table + index - 1])
            return null;
          patch++;
          index++;
        }
        if (index === 33) return null;
      }
      const p = driver.instruments + (patch & 31) * 8;
      if (!covered(image, p, 8)) return null;
      ids.add(image.ram[p]);
    }
  }
  return ids;
}

function hostBank(offset: number, mapping: Mapping) {
  return mapping.hirom
    ? 0xc0 + Math.floor(offset / 65536)
    : 0x80 + Math.floor(offset / 32768);
}

async function findHostTables(
  bytes: Uint8Array,
  mapping: Mapping,
  checkpoint: Checkpoint,
) {
  const descriptors: Descriptor[] = [],
    associations: number[] = [];
  const prefix = [
    0xbd, -1, -1, 0x8d, 0x20, 0, 0xa9, -1, 0x8d, 0x1f, 0, 0x9c, 0x1e, 0, 0xbd,
    -1, -1, 0xc2, 0x20, 0x29, 0xff, 0, 0xa8, 0xe2, 0x20, 0xb7, 0x1e, 0x8d, 0x52,
    1, 0xc8, 0xb7, 0x1e, 0x8d, 0x1f, 0, 0xad, 0x52, 1, 0x8d, 0x1e, 0, 0xc2,
    0x20, 0xa0, 0, 0, 0xb7, 0x1e,
  ];
  for (let p = 0; p + 100 < bytes.length; p++) {
    if ((p & 16383) === 0) await checkpoint();
    if (
      snesPattern(bytes, p, prefix) &&
      word(bytes, p + 15) === word(bytes, p + 1) + 1
    ) {
      const table = mapping.addressToFile(
        (hostBank(p, mapping) << 16) | word(bytes, p + 1),
      );
      for (let q = p + 49; q < p + 80; q++)
        if (snesPattern(bytes, q, [0xa9, -1, 0, 0x8d, 0x46, 1, 0xe2, 0x20])) {
          if (
            (bytes[q + 1] === 2 || bytes[q + 1] === 4) &&
            snesRange(bytes.length, table, 2)
          )
            descriptors.push({
              table,
              bankBase: bytes[p + 7] << 8,
              kind: bytes[q + 1],
            });
          break;
        }
    }
    if (
      snesPattern(
        bytes,
        p,
        [
          0xa2, 0, 0, 0xbd, -1, -1, 0xe8, 0xc9, 0xff, 0xf0, -1, 0xcd, 0x53, 1,
          0xf0,
        ],
      )
    ) {
      const table = mapping.addressToFile(
        (hostBank(p, mapping) << 16) | word(bytes, p + 4),
      );
      if (snesRange(bytes.length, table, 1)) associations.push(table);
    }
  }
  return { descriptors, associations };
}

function readAssociations(bytes: Uint8Array, p: number) {
  const songs = new Map<number, number[]>();
  for (let count = 0; count < 256; count++) {
    if (!snesRange(bytes.length, p, 1)) return null;
    const id = bytes[p++];
    if (id === 255) return songs.size ? songs : null;
    if (songs.has(id)) return null;
    const samples: number[] = [];
    let terminated = false;
    for (let index = 0; index < 256 && p < bytes.length; index++) {
      const value = bytes[p++];
      if (value === 255) {
        terminated = true;
        break;
      }
      if (value !== 254) samples.push(value);
    }
    if (!terminated) return null;
    songs.set(id, samples);
  }
  return null;
}

function readRecord(
  bytes: Uint8Array,
  descriptor: Descriptor,
  id: number,
  mapping: Mapping,
) {
  const p = descriptor.table + id * 2;
  if (!snesRange(bytes.length, p, 2)) return -1;
  const bank = bytes[p] << 16,
    index = bytes[p + 1],
    pointer = mapping.addressToFile(bank | (descriptor.bankBase + index));
  if (index & 1 || !snesRange(bytes.length, pointer, 2)) return -1;
  return mapping.addressToFile(bank | word(bytes, pointer));
}

function readSample(
  bytes: Uint8Array,
  descriptor: Descriptor,
  id: number,
  mapping: Mapping,
): Sample | null {
  const p = readRecord(bytes, descriptor, id, mapping);
  if (!snesRange(bytes.length, p, 4)) return null;
  const length = word(bytes, p),
    loop = word(bytes, p + 2);
  if (!length || length % 9 || !snesRange(bytes.length, p + 4, length))
    return null;
  const body = bytes.subarray(p + 4, p + 4 + length);
  let ended = false;
  for (let q = 0; q < length; q += 9) {
    if (!(body[q] & 1)) continue;
    if (q !== length - 9 || (body[q] & 2 && (loop >= length || loop % 9)))
      return null;
    ended = true;
  }
  return ended ? { id, loop, body } : null;
}

function residentSample(image: SnesImage, directory: number, id: number) {
  const p = directory + id * 4;
  if (!covered(image, p, 4)) return false;
  const start = word(image.ram, p),
    loop = word(image.ram, p + 2);
  if (start < 0x100) return false;
  for (let q = start; q + 9 <= 65536; q += 9) {
    if (!covered(image, q, 9)) return false;
    if (image.ram[q] & 1)
      return (
        !(image.ram[q] & 2) ||
        (loop >= start && loop <= q && (loop - start) % 9 === 0)
      );
  }
  return false;
}

class CubeHost {
  readonly apu = new SPCAPU();
  private counter = 0;
  private samples = 0;

  constructor(
    bytes: Uint8Array,
    private readonly driver: CubeDriver,
    private readonly checkpoint: Checkpoint,
  ) {
    this.apu.reset();
    for (const block of driver.upload.blocks)
      this.apu.ram.set(
        bytes.subarray(block.source, block.source + block.length),
        block.destination,
      );
    this.apu.cpu.PC = driver.upload.entry;
  }

  private async pump(until: () => boolean) {
    for (let count = 0; !until(); count++) {
      check(
        count < 64000 && !this.apu.cpu.halted,
        'SFC_DRIVER',
        'The native Cube program did not acknowledge its audio command.',
      );
      this.apu.renderSample(this.apu.sampleOut);
      if ((++this.samples & 1023) === 0) await this.checkpoint();
    }
  }

  private async send(command: number, a = 0, b = 0, c = 0) {
    this.apu.inputPorts.set([command, a, b, c]);
    this.counter = (this.counter + 1) & 255;
    await this.pump(() => this.apu.outputPorts[0] === this.counter);
  }

  private async transfer(bytes: Uint8Array) {
    for (let p = 0; p < bytes.length; p += 3) {
      await this.send(
        this.driver.commands.transfer,
        bytes[p],
        bytes[p + 1] ?? 0,
        bytes[p + 2] ?? 0,
      );
      if ((p & 1023) === 0) await this.checkpoint();
    }
  }

  async load(selection: Selection) {
    await this.pump(() =>
      this.driver.ready.every(
        (value, index) => this.apu.outputPorts[index] === value,
      ),
    );
    const commands = this.driver.commands;
    if (selection.kind === 'music') {
      let end =
        this.driver.destination +
        Math.ceil(selection.sequence.body.length / 3) * 3;
      const echoStart = this.apu.dsp.regs[0x6d] * 256,
        echoEnd =
          echoStart + Math.max(4, (this.apu.dsp.regs[0x7d] & 15) * 2048),
        echoWrites = !(this.apu.dsp.regs[0x6c] & 0x20);
      for (const sample of selection.samples)
        end += Math.ceil(sample.body.length / 3) * 3;
      check(
        end <= 0xffc0 &&
          (!echoWrites ||
            !(
              (this.driver.destination < Math.min(65536, echoEnd) &&
                end > echoStart) ||
              (echoEnd > 65536 && this.driver.destination < echoEnd - 65536)
            )),
        'SFC_DRIVER',
        'The Cube sequence and original BRR data overlap the native echo or boot area.',
      );
      await this.send(commands.load, selection.id);
      await this.transfer(selection.sequence.body);
      for (const sample of selection.samples) {
        await this.send(
          commands.sample,
          sample.id,
          sample.loop & 255,
          sample.loop >> 8,
        );
        await this.transfer(sample.body);
      }
    }
    this.apu.inputPorts.set([
      selection.kind === 'music' ? commands.music : commands.effect,
      selection.kind === 'effect' ? selection.id : 0,
      0,
      0,
    ]);
  }

  async snapshot(name: string, title: string) {
    const snapshot = snapshotSnesAudio(
      this.apu,
      name.replace(/\.spc$/i, ''),
      title,
    );
    const expected = (this.counter + 1) & 255;
    await this.pump(() => this.apu.outputPorts[0] === expected);
    check(
      this.apu.dsp.regs[0x5d] * 256 === this.driver.directory,
      'SFC_DRIVER',
      'The Cube program selected an unexpected BRR directory.',
    );
    return snapshot;
  }
}

export async function extractCubeAudio(
  bytes: Uint8Array,
  title: string,
  mapping: Mapping,
  checkpoint: Checkpoint,
): Promise<AudioImport | null> {
  const drivers: CubeDriver[] = [];
  for await (const upload of scanSnesUploads(bytes, checkpoint)) {
    await checkpoint();
    if (drivers.some((driver) => snesUploadSuffix(upload, driver.upload)))
      continue;
    const driver = detectDriver(bytes, upload);
    if (driver) drivers.push(driver);
    if (drivers.length > 1) return null;
  }
  if (!drivers.length) return null;
  const driver = drivers[0],
    image = materializeSnesUpload(bytes, driver.upload),
    tables = await findHostTables(bytes, mapping, checkpoint),
    musicTables = tables.descriptors.filter(
      (descriptor) => descriptor.kind === 2,
    ),
    sampleTables = tables.descriptors.filter(
      (descriptor) => descriptor.kind === 4,
    ),
    selections: Selection[] = [];
  let skipped = 0,
    musicVerified = false;
  if (
    musicTables.length === 1 &&
    sampleTables.length === 1 &&
    tables.associations.length === 1
  ) {
    const associations = readAssociations(bytes, tables.associations[0]),
      samples = new Map<number, Sample | null>();
    if (associations) {
      musicVerified = true;
      const dynamic = new Set([...associations.values()].flat());
      for (const [id, declared] of associations) {
        await checkpoint();
        const p = readRecord(bytes, musicTables[0], id, mapping),
          length = snesRange(bytes.length, p, 2) ? word(bytes, p) : 0,
          sequence =
            length && snesRange(bytes.length, p + 2, length)
              ? parseSequence(bytes.subarray(p + 2, p + 2 + length), 6, 1)
              : null;
        if (!sequence) {
          skipped++;
          continue;
        }
        const inferred = sequenceSamples(image, driver, sequence);
        if (!inferred) {
          skipped++;
          continue;
        }
        const required = new Set([...declared, ...inferred]),
          records: Sample[] = [];
        let valid = true;
        for (const sampleId of required) {
          if (
            !declared.includes(sampleId) &&
            !dynamic.has(sampleId) &&
            residentSample(image, driver.directory, sampleId)
          )
            continue;
          if (!samples.has(sampleId))
            samples.set(
              sampleId,
              readSample(bytes, sampleTables[0], sampleId, mapping),
            );
          const sample = samples.get(sampleId);
          if (sample) records.push(sample);
          else valid = false;
        }
        if (valid)
          selections.push({ id, kind: 'music', sequence, samples: records });
        else skipped++;
      }
    }
  }
  for (let id = 0; id < driver.effects.count; id++) {
    await checkpoint();
    const p = word(image.ram, driver.effects.table + id * 2);
    if (!covered(image, p, 4)) continue;
    let end = p;
    while (end < 65536 && image.coverage[end]) end++;
    const sequence = parseSequence(image.ram.subarray(p, end), 2, 0);
    if (!sequence) continue;
    const required = sequenceSamples(image, driver, sequence);
    if (
      required &&
      [...required].every((sampleId) =>
        residentSample(image, driver.directory, sampleId),
      )
    )
      selections.push({ id, kind: 'effect', sequence, samples: [] });
    else skipped++;
  }
  if (!selections.length) return null;
  let cache: { selection: Selection; promise: Promise<Uint8Array> } | null =
    null;
  let queue = Promise.resolve();
  const assets: AudioAsset[] = selections.map((selection) => {
    const name = `Cube ${selection.kind} ${String(selection.id).padStart(3, '0')}.spc`;
    return {
      name,
      format: 'SPC',
      size: 0x10200,
      gameAudio: true,
      song: selection.id,
      source: {
        size: 0x10200,
        async read(offset, length) {
          bounds(0x10200, offset, length);
          await checkpoint();
          if (!length) return new Uint8Array();
          if (!cache || cache.selection !== selection) {
            const promise = queue.then(async () => {
              const host = new CubeHost(bytes, driver, checkpoint);
              await host.load(selection);
              return host.snapshot(name, title);
            });
            queue = promise.then(
              () => {},
              () => {},
            );
            cache = { selection, promise };
          }
          const pending = cache.promise;
          try {
            return (await pending).slice(offset, offset + length);
          } catch (error) {
            if (cache?.promise === pending) cache = null;
            throw error;
          }
        },
      },
    };
  });
  return {
    assets,
    warnings:
      skipped || !musicVerified
        ? [
            {
              code: 'SFC_PARTIAL',
              detail: musicVerified
                ? `Cube: ${skipped} damaged, empty or incomplete native sequences were not exposed.`
                : 'Cube: native resident effects were recovered, but the ROM-side music and sample references could not be verified.',
            },
          ]
        : [],
  };
}
