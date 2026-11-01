import type {
  AudioDecoder,
  ByteSource,
  DecoderOptions,
  PsfBundle,
  ProgressReporter,
} from './contracts.js';
import { bounds, check } from './binary.js';
import { audioDecoder, readAudio } from './audio-codecs.js';
import { PsxMachine } from './psf-machine.js';
import { cooperativeYield } from './cooperative.js';
import { checkHeartbeatCurrent, readHeartbeatRegion } from './ps-heartbeat.js';
import type {
  HeartbeatBank,
  HeartbeatPlayback,
  HeartbeatResource,
} from './ps-heartbeat.js';

export function heartbeatBankResource(
  sequence: HeartbeatResource,
  required: HeartbeatBank,
  resources: HeartbeatResource[],
) {
  if (required.waveSize) return sequence;
  return resources.find((candidate) =>
    candidate.banks.some((bank) => bank.id === required.id && bank.waveSize),
  );
}

export interface HeartbeatDriver {
  init: number;
  spuInit: number;
  allocate: number;
  openWave: number;
  enterSequence: number;
  playSequence: number;
  globalPointer: number;
  heapStart: number;
}

export async function identifyHeartbeatDriver(
  source: ByteSource,
  report: ProgressReporter = () => {},
): Promise<HeartbeatDriver | null> {
  if (source.size < 2048 || source.size > 2099200) return null;
  const bytes = await readHeartbeatRegion(source, 0, source.size, {
    cancelled: () => {
      report({ phase: 'scan', value: null });
      return false;
    },
  });
  const text = new TextDecoder('windows-1252').decode(bytes);
  if (!text.startsWith('PS-X EXE')) return null;
  const view = new DataView(bytes.buffer);
  const load = view.getUint32(24, true);
  const address = (offset: number) => (load + offset - 2048) >>> 0;
  const offset = (pointer: number) => pointer - load + 2048;
  const validOffset = (at: number, count = 4) =>
    at >= 2048 && at % 4 === 0 && at + count <= bytes.length;
  const word = (at: number) => view.getUint32(at, true);
  const target = (at: number) =>
    (((address(at) + 4) & 0xf0000000) | ((word(at) & 0x3ffffff) << 2)) >>> 0;
  const start = (at: number) => {
    for (let back = at; back >= Math.max(2048, at - 8192); back -= 4)
      if (word(back) >>> 16 === 0x27bd && word(back) & 32768) return back;
    return -1;
  };
  const previousCall = (at: number) => {
    for (let back = at - 4; back >= Math.max(2048, at - 96); back -= 4)
      if (word(back) >>> 26 === 3) return target(back);
    return 0;
  };
  const anchor = (needle: string) => {
    const stringOffset = text.indexOf(needle);
    if (stringOffset < 0 || text.indexOf(needle, stringOffset + 1) >= 0)
      return null;
    const pointer = address(stringOffset);
    const references: number[] = [];
    for (let at = 2048; at + 32 <= bytes.length; at += 4) {
      if (word(at) !== (0x3c040000 | (((pointer + 32768) >>> 16) & 65535)))
        continue;
      for (let step = 1; step <= 8; step++)
        if (word(at + step * 4) === (0x24840000 | (pointer & 65535))) {
          references.push(at);
          break;
        }
    }
    if (references.length !== 1) return null;
    const at = references[0];
    const call = previousCall(at);
    return call && validOffset(offset(call))
      ? { call, start: start(at) }
      : null;
  };
  const allocate = anchor('error mmalloc_spu!!');
  const openWave = anchor('error mopen_wave!!');
  const enterSequence = anchor('error mentry_seq!!');
  const playSequence = anchor('error mopenplay_seq!!');
  if (
    !allocate ||
    !openWave ||
    !enterSequence ||
    !playSequence ||
    allocate.start < 0 ||
    [openWave, enterSequence, playSequence].some(
      (item) => item.start !== allocate.start,
    )
  )
    return null;
  const init = start(allocate.start - 4);
  if (
    !validOffset(init, 24) ||
    word(init) !== 0x27bdffe8 ||
    word(init + 4) !== 0xafbf0010 ||
    word(init + 8) >>> 26 !== 3 ||
    word(init + 12) !== 0x24040005 ||
    word(init + 16) >>> 26 !== 3 ||
    word(init + 20) !== 0
  )
    return null;
  const spuCandidates: number[] = [];
  for (let at = 2048; at + 32 <= bytes.length; at += 4) {
    if (
      word(at) !== 0x27bdffe8 ||
      word(at + 4) !== 0xafbf0010 ||
      word(at + 8) >>> 26 !== 3 ||
      word(at + 12) !== 0x00002021 ||
      word(at + 16) !== 0x8fbf0010 ||
      word(at + 20) !== 0x27bd0018 ||
      word(at + 24) !== 0x03e00008 ||
      word(at + 28) !== 0
    )
      continue;
    const child = offset(target(at + 8));
    if (
      validOffset(child, 40) &&
      word(child) === 0x27bdffe8 &&
      word(child + 28) >>> 26 === 5 &&
      word(child + 32) === 0x3404c000 &&
      word(child + 36) === 0x24030017
    )
      spuCandidates.push(address(at));
  }
  if (spuCandidates.length !== 1) return null;
  const entry = offset(view.getUint32(16, true));
  if (!validOffset(entry, 64)) return null;
  const pointerAt = (at: number, register: number) => {
    if (
      word(at) >>> 16 !== (0x3c00 | register) ||
      word(at + 4) >>> 16 !== (0x2400 | (register << 5) | register)
    )
      return 0;
    return (((word(at) & 65535) << 16) + ((word(at + 4) << 16) >> 16)) >>> 0;
  };
  let globalPointer = view.getUint32(20, true);
  for (let at = entry; at < entry + 56; at += 4)
    if (pointerAt(at, 28)) globalPointer = pointerAt(at, 28);
  const clearStart = pointerAt(entry, 2);
  const clearEnd = pointerAt(entry + 8, 3);
  if (
    !globalPointer ||
    !clearStart ||
    !clearEnd ||
    clearEnd <= clearStart ||
    (clearEnd & 0x1fffffff) >= 0x180000 ||
    word(entry + 16) !== 0xac400000 ||
    word(entry + 20) !== 0x24420004
  )
    return null;
  const heapStart =
    Math.ceil(
      Math.max(
        clearEnd & 0x1fffffff,
        (load & 0x1fffffff) + bytes.length - 2048,
      ) / 256,
    ) * 256;
  return {
    init: address(init),
    spuInit: spuCandidates[0],
    allocate: allocate.call,
    openWave: openWave.call,
    enterSequence: enterSequence.call,
    playSequence: playSequence.call,
    globalPointer,
    heapStart,
  };
}

async function nativeCall(
  machine: PsxMachine,
  address: number,
  args: number[],
  returnAddress: number,
  options: DecoderOptions,
) {
  const checkpoint = cooperativeYield(() => checkHeartbeatCurrent(options));
  machine.cpu.registers[29] = 0x801fff00;
  machine.cpu.registers[30] = 0x801fff00;
  machine.cpu.registers[31] = returnAddress;
  for (let index = 0; index < 4; index++)
    machine.cpu.registers[4 + index] = args[index] || 0;
  machine.cpu.resetPC(address);
  let steps = 0;
  while (machine.cpu.pc >>> 0 !== returnAddress && steps < 3000000) {
    machine.cycles += machine.cpu.step();
    if ((++steps & 511) === 0) {
      machine.updateTimers();
      if (machine.interruptStatus & machine.interruptMask)
        machine.bios.interrupt();
    }
    if ((steps & 16383) === 0) {
      await checkpoint();
    }
  }
  checkHeartbeatCurrent(options);
  check(
    machine.cpu.pc >>> 0 === returnAddress,
    'PSF_DRIVER',
    'HeartBeat native call budget',
  );
  return machine.cpu.registers[2] >>> 0;
}

async function initializeHeartbeat(
  playback: HeartbeatPlayback,
  options: DecoderOptions,
) {
  checkHeartbeatCurrent(options);
  const { driver, sequence } = playback;
  const bytes = await readHeartbeatRegion(
    playback.executable,
    0,
    playback.executable.size,
    options,
  );
  const returnOffset = driver.heapStart;
  check(
    returnOffset >= 65536 && returnOffset + 256 < 0x1e0000,
    'PSF_DRIVER',
    'HeartBeat free memory',
  );
  const returnAddress = (0x80000000 + returnOffset) >>> 0;
  const bundle: PsfBundle = {
    format: 'PSF',
    name: sequence.name,
    tags: {},
    entry: { pc: driver.init, gp: driver.globalPointer, sp: 0x801fff00 },
    programs: [{ name: 'Original HeartBeat executable', bytes }],
    files: [],
    entries: [],
    dependencies: [],
  };
  const machine = new PsxMachine(bundle);
  machine.ramView.setUint32(returnOffset, 0x1000ffff, true);
  const call = (address: number, args: number[] = []) =>
    nativeCall(machine, address, args, returnAddress, options);
  await call(driver.spuInit);
  await call(driver.init);
  let ramOffset = returnOffset + 256;
  const sequenceAddress = (0x80000000 + ramOffset) >>> 0;
  const sequenceBytes = await readHeartbeatRegion(
    sequence.source,
    sequence.sequenceOffset,
    sequence.sequenceSize,
    options,
  );
  check(
    ramOffset + 60 + sequenceBytes.length < 0x1e0000,
    'PSF_DRIVER',
    'HeartBeat sequence memory',
  );
  bounds(machine.ram.length, ramOffset, 60 + sequenceBytes.length);
  machine.ram.set(await readAudio(sequence.source, 0, 60), ramOffset);
  machine.ram.set(sequenceBytes, ramOffset + 60);
  ramOffset = Math.ceil((ramOffset + 60 + sequenceBytes.length) / 16) * 16;
  let slot = 0;
  const loaded = new Set<number>();
  for (const required of sequence.banks) {
    if (required.id === 65535 || loaded.has(required.id)) continue;
    const resource = heartbeatBankResource(sequence, required, playback.banks);
    check(resource, 'HEARTBEAT_BANK', 'HeartBeat bank ' + required.id);
    const bank = resource.banks.find(
      (candidate) => candidate.id === required.id && candidate.waveSize,
    );
    check(bank, 'HEARTBEAT_BANK', 'HeartBeat bank ' + required.id);
    check(slot < 2, 'PSF_SERVICE', 'HeartBeat bank slot count');
    const waveAddress = await call(driver.allocate, [slot, bank.waveSize]);
    check(waveAddress > 0, 'PSF_DRIVER', 'HeartBeat SPU allocation');
    bounds(machine.spu.memory.length, waveAddress, bank.waveSize);
    for (let at = 0; at < bank.waveSize; at += 65536) {
      checkHeartbeatCurrent(options);
      machine.spu.memory.set(
        await readAudio(
          resource.source,
          bank.offset + at,
          Math.min(65536, bank.waveSize - at),
        ),
        waveAddress + at,
      );
    }
    check(
      ramOffset + bank.attributeSize < 0x1e0000,
      'PSF_DRIVER',
      'HeartBeat instrument memory',
    );
    machine.ram.set(
      await readHeartbeatRegion(
        resource.source,
        bank.offset + bank.waveSize,
        bank.attributeSize,
        options,
      ),
      ramOffset,
    );
    const opened = await call(driver.openWave, [
      slot,
      bank.id,
      (0x80000000 + ramOffset) >>> 0,
      0,
    ]);
    check(
      opened !== 0xffffffff,
      'PSF_DRIVER',
      'HeartBeat instrument registration',
    );
    ramOffset = Math.ceil((ramOffset + bank.attributeSize) / 16) * 16;
    loaded.add(bank.id);
    slot++;
  }
  const entered = await call(driver.enterSequence, [
    sequenceAddress,
    sequence.loadSlot,
    sequenceAddress + 60,
  ]);
  check(
    entered !== 0xffffffff,
    'PSF_DRIVER',
    'HeartBeat sequence registration',
  );
  const played = await call(driver.playSequence, [sequence.id, 0, 0]);
  check(played !== 0xffffffff, 'PSF_DRIVER', 'HeartBeat sequence start');
  machine.cpu.resetPC(returnAddress);
  machine.sampleCycle = machine.cycles;
  return machine;
}

export async function createHeartbeatDecoder(
  playback: HeartbeatPlayback,
  options: DecoderOptions = {},
): Promise<AudioDecoder> {
  let machine: PsxMachine | null = await initializeHeartbeat(playback, options);
  const checkpoint = cooperativeYield(() => checkHeartbeatCurrent(options));
  return audioDecoder(
    {
      channels: 2,
      sampleRate: 44100,
      length: null,
      tags: { title: 'Sequence ' + playback.sequence.id },
    },
    async (frames) => {
      const channels = [new Float32Array(frames), new Float32Array(frames)];
      for (let at = 0; at < frames; at += 512) {
        checkHeartbeatCurrent(options);
        check(machine, 'PSF_DRIVER');
        const count = Math.min(512, frames - at);
        const block = machine.render(count);
        channels[0].set(block[0], at);
        channels[1].set(block[1], at);
        await checkpoint();
      }
      return channels;
    },
    async () => {
      machine = null;
      machine = await initializeHeartbeat(playback, options);
    },
  );
}
