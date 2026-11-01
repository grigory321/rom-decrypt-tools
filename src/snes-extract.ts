import type {
  AudioAsset,
  AudioImport,
  BlobInput,
  ByteSource,
  ProgressReporter,
} from './contracts.js';
import { arraySource, blobSource, check } from './binary.js';
import { SPCAPU } from './vendor/spc700-js/apu.js';
import {
  findHeartBeatProfile,
  extractHeartBeatAudio,
} from './snes-heartbeat.js';
import { snapshotSnesAudio } from './snes-snapshot.js';

type Checkpoint = () => Promise<void>;
interface SnesCartridge {
  hirom: boolean;
  extended: boolean;
  score: number;
  title: string;
}
interface ModDriver {
  family: 'SNESMOD';
  offset: number;
  bytes: Uint8Array;
}
interface GssDriver {
  family: 'SNESGSS';
  offset: number;
  size: number;
  load: number;
  bytes: Uint8Array;
}
type SnesDriver = ModDriver | GssDriver;
interface ModModule {
  id: number;
  body: Uint8Array;
  sources: { loop: number; bytes: Uint8Array }[];
  starts: number[];
}
interface ModBank {
  base: number;
  modules: ModModule[];
  skipped: number;
}
interface GssSong {
  offset: number;
  size: number;
  body: Uint8Array;
}

const modPrefix = [
  0xcd, 0, 0xe8, 0, 0xaf, 0xc8, 0xf0, 0xd0, 0xfb, 0x8f, 0, 0xf5,
];
const gssPrefix = [0x20, 0xcd, 0xef, 0xbd, 0x2f, 0x13, 0x2f, 6];
const fromHex = (value: string) =>
  Uint8Array.from(value.match(/../g) ?? [], (byte) => parseInt(byte, 16));
const modStartup = fromHex('a900205884a97f209e84200584');
const gssStartup = fromHex(
  'a9010022958480a97000aa22a58480e23022f48480a900a200228d8580a9dfa20422a68580a928a23f228d8580a901a25022bf8580',
);
const uploaderPrefix = [
  0xae, 0x40, 0x21, 0xe0, 0xaa, 0xbb, 0xd0, 0xf8, 0x8e, 0x41, 0x21, 0xa2, 0, 4,
  0x8e, 0x42, 0x21, 0xa9, 0xcc, 0x8d, 0x40, 0x21, 0xcd, 0x40, 0x21, 0xd0, 0xfb,
  0xaf,
];
const yieldCpu = () => new Promise<void>((resolve) => setTimeout(resolve, 0));
const u16 = (bytes: Uint8Array, p: number) => bytes[p] | (bytes[p + 1] << 8);
const u24 = (bytes: Uint8Array, p: number) =>
  u16(bytes, p) | (bytes[p + 2] << 16);
const matches = (
  bytes: Uint8Array,
  p: number,
  signature: readonly number[] | Uint8Array,
) =>
  p >= 0 &&
  p + signature.length <= bytes.length &&
  signature.every((value, i) => bytes[p + i] === value);

function requireDriver(ok: boolean | number, detail: string): asserts ok {
  check(ok, 'SFC_DRIVER', detail);
}

function hash(bytes: Uint8Array, start: number, end: number) {
  let value = 2166136261;
  for (let p = start; p < end; p++)
    value = Math.imul(value ^ bytes[p], 16777619);
  return value >>> 0;
}

function cartridge(bytes: Uint8Array): SnesCartridge {
  const candidates: SnesCartridge[] = [];
  const headers = [
    { offset: 0x7fc0, mode: 0x20, hirom: false, extended: false },
    { offset: 0xffc0, mode: 0x21, hirom: true, extended: false },
    { offset: 0x40ffc0, mode: 0x25, hirom: true, extended: true },
  ];
  for (const header of headers) {
    const p = header.offset;
    if (p + 64 > bytes.length) continue;
    const mode = bytes[p + 21] & 0x2f;
    if (mode !== header.mode) continue;
    if (u16(bytes, p + 60) < 0x8000) continue;
    const nameBytes = bytes.subarray(p, p + 21);
    const printable = [...nameBytes].filter(
      (value) => value >= 32 && value < 127,
    ).length;
    const checksum = (u16(bytes, p + 28) ^ u16(bytes, p + 30)) === 65535;
    if (printable < 16 && !checksum) continue;
    candidates.push({
      hirom: header.hirom,
      extended: header.extended,
      score: printable + (checksum ? 20 : 0),
      title: new TextDecoder().decode(nameBytes).trim(),
    });
  }
  candidates.sort(
    (a, b) => b.score - a.score || Number(b.extended) - Number(a.extended),
  );
  requireDriver(
    candidates.length,
    'No supported LoROM, HiROM or ExHiROM header was found.',
  );
  return candidates[0];
}

function cpuToFile(address: number, cart: SnesCartridge) {
  const bank = address >>> 16,
    low = address & 65535;
  if (bank === 0x7e || bank === 0x7f) return -1;
  if (cart.hirom) {
    if (!(bank & 0x40) && low < 0x8000) return -1;
    return (
      (bank & 63) * 65536 + low + (cart.extended && bank < 0x80 ? 0x400000 : 0)
    );
  }
  if (low < 0x8000) return -1;
  return (bank & 127) * 32768 + (low & 32767);
}

async function readRom(
  input: ByteSource | BlobInput,
  report: ProgressReporter,
) {
  const source = 'read' in input ? input : blobSource(input);
  requireDriver(
    Number.isSafeInteger(source?.size) &&
      source.size >= 0x8000 &&
      source.size <= 0x1000000 + 512,
    'Unsupported or truncated SFC ROM size.',
  );
  const header = source.size % 0x8000 === 512 ? 512 : 0;
  requireDriver(
    (source.size - header) % 0x8000 === 0,
    'SFC ROM size is not a complete cartridge bank.',
  );
  const bytes = new Uint8Array(source.size - header);
  for (let p = 0; p < bytes.length; p += 65536) {
    report({
      phase: 'scan',
      value: p / bytes.length,
      detail: 'Reading SFC audio driver data',
    });
    await yieldCpu();
    const count = Math.min(65536, bytes.length - p);
    const part = await source.read(p + header, count);
    requireDriver(
      part instanceof Uint8Array && part.length === count,
      'The SFC source returned truncated data.',
    );
    bytes.set(part, p);
  }
  return bytes;
}

async function findDrivers(
  bytes: Uint8Array,
  cart: SnesCartridge,
  checkpoint: Checkpoint,
) {
  const drivers: SnesDriver[] = [];
  for (let p = 0; p < bytes.length - 16; p++) {
    if ((p & 65535) === 0) await checkpoint();
    if (
      matches(bytes, p, modPrefix) &&
      p + 5227 <= bytes.length &&
      hash(bytes, p, p + 5227) === 1056083733
    ) {
      let loader = false;
      for (let q = 0; q + 64 <= bytes.length; q++) {
        if (
          matches(bytes, q, uploaderPrefix) &&
          cpuToFile(u24(bytes, q + 28), cart) === p &&
          bytes[q + 40] === 0xbf &&
          u24(bytes, q + 41) === u24(bytes, q + 28) &&
          matches(bytes, q + 59, [0xe0, 0x6b, 0x14, 0x90, 0xe7])
        ) {
          loader = true;
          break;
        }
        if ((q & 65535) === 0) await checkpoint();
      }
      if (loader)
        drivers.push({
          family: 'SNESMOD',
          offset: p,
          bytes: bytes.slice(p, p + 5227),
        });
    }
    if (matches(bytes, p + 2, gssPrefix)) {
      const size = u16(bytes, p),
        load = u16(bytes, p + 14),
        adsr = u16(bytes, p + 10);
      if (
        size >= 0x92e &&
        p + size + 2 <= bytes.length &&
        load === size + 0x200 &&
        load < 0xff00 &&
        adsr === 0x0b2e &&
        hash(bytes, p + 16, p + 0x902) === 318261517
      ) {
        drivers.push({
          family: 'SNESGSS',
          offset: p,
          size: size + 2,
          load,
          bytes: bytes.slice(p + 2, p + 2 + size),
        });
        p += size + 1;
      }
    }
  }
  return drivers;
}

async function knownStartup(
  bytes: Uint8Array,
  driver: SnesDriver,
  checkpoint: Checkpoint,
) {
  const signature = driver.family === 'SNESMOD' ? modStartup : gssStartup;
  for (let p = 0; p + signature.length <= bytes.length; p++) {
    if ((p & 65535) === 0) await checkpoint();
    const end =
      driver.offset + ('size' in driver ? driver.size : driver.bytes.length);
    if (p >= driver.offset && p < end) {
      p = end - 1;
      continue;
    }
    if (matches(bytes, p, signature)) return true;
  }
  return false;
}

function modPattern(body: Uint8Array, address: number) {
  let p = address - 0x1a00;
  if (p < 0x268 || p >= body.length) return null;
  const rows = body[p++] + 1;
  let notes = false;
  for (let row = 0; row < rows; row++) {
    if (p + 2 > body.length) return null;
    p++;
    const channels = body[p++];
    for (let channel = 0; channel < 8; channel++) {
      if (!(channels & (1 << channel))) continue;
      if (p >= body.length) return null;
      const mask = body[p++];
      if (mask & 16) {
        if (p >= body.length) return null;
        if (body[p++] < 120) notes = true;
      }
      if (mask & 32) p++;
      if (mask & 64) p++;
      if (mask & 128) p += 2;
      if (p > body.length) return null;
    }
  }
  return { notes };
}

async function modBank(
  bytes: Uint8Array,
  base: number,
  hirom: boolean,
  checkpoint: Checkpoint,
): Promise<ModBank | null> {
  const sources = u16(bytes, base),
    count = u16(bytes, base + 2),
    stride = hirom ? 65536 : 32768;
  if (
    !count ||
    count > 128 ||
    !sources ||
    sources > 256 ||
    base + 0x184 + sources * 3 > bytes.length
  )
    return null;
  const pointer = (table: number, id: number) => {
    const p = base + table + id * 3,
      address = u16(bytes, p);
    if (!hirom && address < 0x8000) return -1;
    const offset =
      base + bytes[p + 2] * stride + (hirom ? address : address & 32767);
    return offset >= base + 0x184 + sources * 3 && offset + 4 <= bytes.length
      ? offset
      : -1;
  };
  const readModule = (id: number): ModModule | null => {
    const p = pointer(4, id);
    if (p < 0) return null;
    const length = u16(bytes, p) * 2,
      used = u16(bytes, p + 2),
      start = p + 4 + used * 2;
    if (
      used < 1 ||
      used > 64 ||
      length < 0x268 ||
      start + length > bytes.length ||
      0x1a00 + length >= 0xff00
    )
      return null;
    const body = bytes.slice(start, start + length);
    if (
      !body[0] ||
      !body[2] ||
      body[1] < 32 ||
      body[0] > 128 ||
      body[0x15] > 15
    )
      return null;
    const sourceRecords: ModModule['sources'] = [];
    let end = 0x1a00 + length;
    for (let index = 0; index < used; index++) {
      const sourceId = u16(bytes, p + 4 + index * 2);
      if (sourceId >= sources) return null;
      const q = pointer(0x184, sourceId);
      if (q < 0) return null;
      const size = u16(bytes, q),
        loop = u16(bytes, q + 2),
        padded = (size + 1) & ~1;
      if (
        !size ||
        size % 9 ||
        loop % 9 ||
        loop >= size ||
        q + 4 + padded > bytes.length ||
        !(bytes[q + 4 + size - 9] & 1)
      )
        return null;
      end += padded;
      sourceRecords.push({ loop, bytes: bytes.slice(q + 4, q + 4 + padded) });
    }
    const echoStart = body[0x15] ? 65536 - body[0x15] * 2048 : 0xff00;
    if (end > echoStart) return null;
    const starts: number[] = [],
      patterns = new Map<number, { notes: boolean }>();
    let afterEnd = true;
    for (let position = 0; position < 200; position++) {
      const pattern = body[0x20 + position];
      if (pattern === 255) {
        afterEnd = true;
        continue;
      }
      if (pattern === 254) continue;
      if (pattern >= 64) return null;
      const address = body[0xe8 + pattern] | (body[0x128 + pattern] << 8);
      if (address < 0x1c68 || address >= 0x1a00 + length) return null;
      if (!patterns.has(pattern)) {
        const info = modPattern(body, address);
        if (!info) return null;
        patterns.set(pattern, info);
      }
      if (afterEnd) starts.push(position);
      afterEnd = false;
    }
    if (!starts.length || ![...patterns.values()].some((info) => info.notes))
      return null;
    return { id, body, sources: sourceRecords, starts };
  };
  const modules: ModModule[] = [];
  for (let id = 0; id < count; id++) {
    await checkpoint();
    const module = readModule(id);
    if (module) modules.push(module);
  }
  return modules.length
    ? { base, modules, skipped: count - modules.length }
    : null;
}

function gssSong(
  bytes: Uint8Array,
  p: number,
  driver: GssDriver,
): GssSong | null {
  const size = u16(bytes, p),
    count = bytes[p + 2],
    start = p + 2,
    header = 1 + count * 2;
  if (
    count < 1 ||
    count > 8 ||
    size <= header ||
    p + size + 2 > bytes.length ||
    driver.load + size > 0xff00 ||
    u16(bytes, p + 3) !== driver.load + header
  )
    return null;
  const data = bytes.subarray(start, start + size),
    pointers: number[] = [];
  for (let channel = 0; channel < count; channel++) {
    const offset = u16(data, 1 + channel * 2) - driver.load;
    if (
      offset < header ||
      offset >= size ||
      (channel && offset <= pointers[channel - 1])
    )
      return null;
    pointers.push(offset);
  }
  let notes = 0,
    delays = 0,
    operations = 0;
  const validate = (
    offset: number,
    limit: number,
    depth: number,
    main: boolean,
  ): boolean => {
    if (depth > 8) return false;
    while (offset < limit && ++operations < 32768) {
      const op = data[offset++];
      if (op <= 148) {
        if (op) delays++;
        continue;
      }
      if (op <= 244) {
        notes++;
        continue;
      }
      if (op === 245) continue;
      const args = op === 246 || op === 255 ? 2 : op === 253 ? 3 : 1;
      if (offset + args > limit) return false;
      if (op === 246) {
        if (u16(data, offset)) delays++;
      }
      if (op === 253 || op === 255) {
        const target = u16(data, offset) - driver.load;
        if (target < header || target >= size) return false;
        if (op === 255) return main;
        const length = data[offset + 2];
        if (
          !length ||
          target + length > size ||
          !validate(target, target + length, depth + 1, false)
        )
          return false;
      }
      if (op === 254 && data[offset] >= 99) return false;
      offset += args;
    }
    return !main && offset === limit;
  };
  for (const offset of pointers)
    if (!validate(offset, size, 0, true)) return null;
  if (!notes || !delays) return null;
  return { offset: p, size: size + 2, body: data.slice() };
}

class OriginalDriver {
  apu: SPCAPU;
  validation: number;
  samples: number;
  constructor(
    driver: SnesDriver,
    readonly checkpoint: Checkpoint,
  ) {
    this.apu = new SPCAPU();
    this.apu.reset();
    this.apu.ram.set(driver.bytes, driver.family === 'SNESMOD' ? 0x400 : 0x200);
    this.apu.cpu.PC = driver.family === 'SNESMOD' ? 0x400 : 0x200;
    this.apu.cpu.SP = 0xef;
    this.validation = 0;
    this.samples = 0;
  }
  async pump(until: () => boolean, limit = 32000) {
    for (let count = 0; !until(); count++) {
      requireDriver(
        count < limit && !this.apu.cpu.halted,
        'The original SPC driver did not acknowledge its audio command.',
      );
      this.apu.renderSample(this.apu.sampleOut);
      if ((++this.samples & 1023) === 0) await this.checkpoint();
    }
  }
  async warmup(samples = 320) {
    const end = this.samples + samples;
    await this.pump(() => this.samples >= end, samples + 1);
  }
  async acknowledge() {
    const value = this.validation;
    this.apu.inputPorts[1] = value;
    await this.pump(() => this.apu.outputPorts[1] === value);
  }
  async transfer(bytes: Uint8Array) {
    for (let p = 0; p < bytes.length; p += 2) {
      this.apu.inputPorts[2] = bytes[p];
      this.apu.inputPorts[3] = bytes[p + 1] || 0;
      this.validation = p + 2 >= bytes.length ? 0 : this.validation ^ 128;
      await this.acknowledge();
      if ((p & 1023) === 0) await this.checkpoint();
    }
  }
  async loadModule(module: ModModule) {
    await this.warmup();
    this.apu.inputPorts[0] = 0;
    this.validation = (this.validation ^ 128) | 1;
    await this.acknowledge();
    await this.transfer(module.body);
    for (const source of module.sources) {
      this.apu.inputPorts[0] = 1;
      this.apu.inputPorts[2] = source.loop & 255;
      this.apu.inputPorts[3] = source.loop >> 8;
      this.validation = (this.validation ^ 128) | 1;
      await this.acknowledge();
      await this.transfer(source.bytes);
    }
    this.apu.inputPorts[0] = 0;
    this.validation ^= 128;
    await this.acknowledge();
    await this.warmup(64);
  }
  queueModule(position: number) {
    this.apu.inputPorts[0] = 3;
    this.apu.inputPorts[2] = 0;
    this.apu.inputPorts[3] = position;
    this.validation ^= 128;
    this.apu.inputPorts[1] = this.validation;
  }
  async modCommand(command: number, parameter: number) {
    this.apu.inputPorts[0] = command;
    this.apu.inputPorts[2] = 0;
    this.apu.inputPorts[3] = parameter;
    this.validation ^= 128;
    await this.acknowledge();
    await this.warmup(64);
  }
  async gssCommand(command: number, parameter = 0) {
    await this.pump(() => this.apu.outputPorts[0] === 0);
    this.apu.inputPorts[1] = 0;
    this.apu.inputPorts[2] = parameter & 255;
    this.apu.inputPorts[3] = parameter >> 8;
    this.apu.inputPorts[0] = command;
    await this.pump(
      () => this.apu.inputPorts[0] === 0 && this.apu.outputPorts[0] === 0,
    );
    await this.warmup(64);
  }
}

function asset(apu: SPCAPU, name: string, game: string): AudioAsset {
  const bytes = snapshotSnesAudio(apu, name.replace(/\.spc$/i, ''), game);
  return {
    name,
    format: 'SPC',
    source: arraySource(bytes),
    size: bytes.length,
    gameAudio: true,
  };
}

export async function extractSnesAudio(
  source: ByteSource | BlobInput,
  _filename: string,
  report: ProgressReporter = () => {},
): Promise<AudioImport> {
  const bytes = await readRom(source, report),
    cart = cartridge(bytes);
  let lastYield = 0;
  const checkpoint = async () => {
    if (Date.now() - lastYield < 8) return;
    lastYield = Date.now();
    report({
      phase: 'scan',
      value: null,
      detail: 'Extracting original SFC sound driver music',
    });
    await yieldCpu();
  };
  const heartbeat = findHeartBeatProfile(bytes, cart.hirom, cart.title);
  if (heartbeat) {
    const result = await extractHeartBeatAudio(
      bytes,
      heartbeat,
      cart.title,
      checkpoint,
    );
    report({
      phase: 'scan',
      value: 1,
      detail: `${result.assets.length} original-driver SFC audio sequences indexed`,
    });
    return result;
  }
  const drivers = await findDrivers(bytes, cart, checkpoint);
  if (!drivers.length) {
    const { extractCubeAudio } = await import('./snes-cube.js');
    const cube = await extractCubeAudio(
      bytes,
      cart.title,
      {
        hirom: cart.hirom,
        addressToFile: (address) => cpuToFile(address, cart),
      },
      checkpoint,
    );
    if (cube) {
      report({
        phase: 'scan',
        value: 1,
        detail: `${cube.assets.length} original Cube audio sequences indexed`,
      });
      return cube;
    }
    const { extractNspcAudio } = await import('./snes-nspc.js');
    const result = await extractNspcAudio(bytes, cart.title, checkpoint);
    if (result) {
      report({
        phase: 'scan',
        value: 1,
        detail: `${result.assets.length} original N-SPC music sequences indexed`,
      });
      return result;
    }
  }
  requireDriver(
    drivers.length,
    'No complete supported SFC sound bank was found. Supported layouts include SNESMOD, SNESGSS Qv2, structural Cube banks, HeartBeat DQ3 and standard port-0 N-SPC upload banks.',
  );
  const assets: AudioAsset[] = [],
    warnings: AudioImport['warnings'] = [];
  for (const driver of drivers) {
    const startup = await knownStartup(bytes, driver, checkpoint);
    if (driver.family === 'SNESMOD') {
      let bankId = 0;
      for (
        let p = 0;
        p + 0x184 < bytes.length;
        p += cart.hirom ? 65536 : 32768
      ) {
        await checkpoint();
        const bank = await modBank(bytes, p, cart.hirom, checkpoint);
        if (!bank) continue;
        bankId++;
        if (bank.skipped)
          warnings.push({
            code: 'SFC_PARTIAL',
            detail: `SNESMOD bank ${bankId}: skipped ${bank.skipped} invalid, damaged, or empty music modules; valid sibling modules were retained.`,
          });
        for (const module of bank.modules) {
          const host = new OriginalDriver(driver, checkpoint);
          await host.loadModule(module);
          if (startup) await host.modCommand(5, 127);
          const loaded = host.apu.saveState(),
            validation = host.validation;
          for (const position of module.starts) {
            requireDriver(
              assets.length < 1024,
              'The SFC contains too many music sequence starts.',
            );
            host.apu.loadState(loaded);
            host.validation = validation;
            host.queueModule(position);
            const name = `SNESMOD bank ${bankId} module ${String(module.id + 1).padStart(3, '0')}${position ? ` position ${position}` : ''}.spc`;
            assets.push(asset(host.apu, name, cart.title));
          }
        }
      }
      warnings.push({
        code: 'SFC_PARTIAL',
        detail:
          'SNESMOD: validated modules and separate sequence runs were found. Overlapping subsongs and dynamic game commands require a game profile.' +
          (startup
            ? ' The recognized original startup module gain is restored.'
            : ' Unrecognized game-side volume changes are not applied.'),
      });
    } else {
      const songs: GssSong[] = [];
      for (let p = 0; p + 5 < bytes.length; p++) {
        if ((p & 16383) === 0) await checkpoint();
        if (p >= driver.offset && p < driver.offset + driver.size) {
          p = driver.offset + driver.size - 1;
          continue;
        }
        const song = gssSong(bytes, p, driver);
        if (!song) continue;
        requireDriver(
          songs.length < 512,
          'The SFC contains too many SNESGSS music blobs.',
        );
        songs.push(song);
        p += song.size - 1;
      }
      for (let i = 0; i < songs.length; i++) {
        const host = new OriginalDriver(driver, checkpoint);
        host.apu.ram.set(songs[i].body, driver.load);
        await host.warmup();
        await host.gssCommand(1);
        if (startup) {
          for (const [command, parameter] of [
            [3, 1],
            [4, 0x7070],
            [10, 0],
            [11, 0],
            [12, 0x04df],
            [11, 0x3f28],
            [13, 0x5001],
          ]) {
            await host.gssCommand(command, parameter);
          }
          await host.pump(
            () =>
              host.apu.dsp.regs[0x0c] === 112 &&
              host.apu.dsp.regs[0x1c] === 112,
          );
        }
        host.apu.inputPorts[0] = 6;
        assets.push(
          asset(
            host.apu,
            `SNESGSS song ${String(i + 1).padStart(3, '0')}.spc`,
            cart.title,
          ),
        );
      }
      warnings.push({
        code: 'SFC_PARTIAL',
        detail:
          'SNESGSS: validated music blobs use their original driver and samples. ROM-wide completeness and dynamic game commands require a game profile.' +
          (startup
            ? ' The recognized original startup stereo, gain and echo settings are restored.'
            : ' No original startup settings profile matched; native driver defaults are retained.'),
      });
    }
  }
  requireDriver(
    assets.length,
    'A recognized SFC audio driver was found, but no complete valid music bank or song blob could be extracted.',
  );
  report({
    phase: 'scan',
    value: 1,
    detail: `${assets.length} original-driver SFC music sequences extracted`,
  });
  return { assets, warnings };
}
