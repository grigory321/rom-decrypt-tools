import type { AudioAsset, AudioImport } from './contracts.js';
import { bounds, check } from './binary.js';
import { SPCAPU } from './vendor/spc700-js/apu.js';
import { snapshotSnesAudio } from './snes-snapshot.js';

import {
  scanSnesUploads,
  materializeSnesUpload as materialize,
  snesUploadSuffix as suffixOf,
  snesOverlap as intersects,
  type SnesUpload as Upload,
  type SnesUploadBlock as UploadBlock,
  type SnesImage as Image,
} from './snes-upload.js';

type Checkpoint = () => Promise<void>;
interface Driver {
  upload: Upload;
  code: UploadBlock;
  section: number;
  songs: number;
  instruments: number;
  directory: number;
}
interface Song {
  id: number;
  sections: Set<number>;
  tracks: Set<number>;
}
interface Selection {
  driver: Driver;
  bank: Upload | null;
  song: Song;
}
interface Work {
  remaining: number;
}

const commandLengths = [
  1, 1, 2, 3, 0, 1, 2, 1, 2, 1, 1, 3, 0, 1, 2, 3, 1, 3, 3, 0, 1, 3, 0, 3, 3, 3,
  1,
];
const init = [
  0x20, 0xcd, 0xcf, 0xbd, 0xe8, 0, 0x5d, 0xaf, 0xc8, 0xe0, 0xd0, 0xfb,
];
const u16 = (bytes: Uint8Array, p: number) => bytes[p] | (bytes[p + 1] << 8);
const within = (size: number, p: number, length: number) =>
  Number.isSafeInteger(p) &&
  Number.isSafeInteger(length) &&
  p >= 0 &&
  length >= 0 &&
  p <= size &&
  length <= size - p;
const covered = (image: Image, p: number, length: number) =>
  within(65536, p, length) &&
  image.coverage.subarray(p, p + length).every((value) => value > 0);
const pattern = (bytes: Uint8Array, p: number, values: readonly number[]) =>
  within(bytes.length, p, values.length) &&
  values.every((value, i) => value < 0 || bytes[p + i] === value);
function compatible(driver: Driver, bank: Upload) {
  return (
    bank !== driver.upload &&
    bank.entry === driver.upload.entry &&
    !bank.blocks.some((block) => intersects(block, driver.code))
  );
}

function findInCode(
  image: Image,
  code: UploadBlock,
  values: readonly number[],
) {
  const matches: number[] = [];
  for (
    let p = code.destination;
    p + values.length <= code.destination + code.length;
    p++
  )
    if (pattern(image.ram, p, values)) matches.push(p);
  return matches;
}

function detectDriver(bytes: Uint8Array, upload: Upload): Driver | null {
  const code = upload.blocks.find(
    (block) =>
      upload.entry >= block.destination &&
      upload.entry + init.length <= block.destination + block.length,
  );
  if (!code) return null;
  if (!pattern(bytes, code.source + upload.entry - code.destination, init))
    return null;
  const image = materialize(bytes, upload, null),
    ram = image.ram;
  if (!pattern(ram, upload.entry, init)) return null;
  const sectionReaders = findInCode(
    image,
    code,
    [0x8d, 0, 0xf7, -1, 0x3a, -1, 0x2d, 0xf7, -1, 0x3a, -1, 0xfd, 0xae],
  ).filter(
    (p) =>
      ram[p + 3] < 0xef &&
      ram[p + 3] === ram[p + 5] &&
      ram[p + 3] === ram[p + 8] &&
      ram[p + 3] === ram[p + 10],
  );
  const portReaders = findInCode(
    image,
    code,
    [0xf4, 4, 0xd5, 0xf4, 0, 0xf5, 0xf4, 0, 0x75, 0xf4, 0, 0xd0, 0xf8],
  ).filter(
    (p) =>
      findInCode(image, code, [0xcd, 0, 0x3f, p & 255, p >> 8]).length &&
      Array.from({ length: 16 }, (_, i) => p + 13 + i).some(
        (q) =>
          q + 2 <= code.destination + code.length &&
          (pattern(ram, q, [0xd4, 0]) || pattern(ram, q, [0xdb, 0])),
      ),
  );
  if (sectionReaders.length !== 1 || !portReaders.length) return null;
  const section = ram[sectionReaders[0] + 3];
  const lists = [
    ...findInCode(image, code, [
      0xf5,
      -1,
      -1,
      0xfd,
      0xf5,
      -1,
      -1,
      0xda,
      section,
    ])
      .filter((p) => u16(ram, p + 1) === u16(ram, p + 5) + 1)
      .map((p) => u16(ram, p + 5)),
    ...findInCode(image, code, [
      0x1c,
      0x5d,
      0xf5,
      -1,
      -1,
      0xfd,
      0xd0,
      3,
      0xc4,
      -1,
      0x6f,
      0xf5,
      -1,
      -1,
      0xda,
      section,
    ])
      .filter((p) => u16(ram, p + 3) === u16(ram, p + 12) + 1)
      .map((p) => u16(ram, p + 12)),
  ];
  const instruments = findInCode(
    image,
    code,
    [0x8d, 6, 0xcf, 0xda, -1, 0x60, 0x98, -1, -1, 0x98, -1, -1],
  )
    .filter((p) => ram[p + 4] === ram[p + 8] && ram[p + 11] === ram[p + 4] + 1)
    .map((p) => ram[p + 7] | (ram[p + 10] << 8));
  const directories = [
    ...findInCode(image, code, [0x8f, 0x5d, 0xf2, 0x8f, -1, 0xf3]).map(
      (p) => ram[p + 4] << 8,
    ),
    ...findInCode(image, code, [0xe8, -1, 0x8d, 0x5d, 0x3f, -1, -1])
      .filter((p) =>
        pattern(ram, u16(ram, p + 5), [0xcc, 0xf2, 0, 0xc5, 0xf3, 0]),
      )
      .map((p) => ram[p + 1] << 8),
  ];
  const dispatch = findInCode(
    image,
    code,
    [
      0x1c, 0xfd, 0xf6, -1, -1, 0x2d, 0xf6, -1, -1, 0x2d, 0xdd, 0x5c, 0xfd,
      0xf6, -1, -1,
    ],
  ).filter((p) => {
    const addresses = u16(ram, p + 7) + 0xc0,
      lengths = u16(ram, p + 14) + 0x60;
    return (
      u16(ram, p + 3) === u16(ram, p + 7) + 1 &&
      covered(image, addresses, 54) &&
      covered(image, lengths, 27) &&
      addresses + 54 === lengths &&
      pattern(ram, lengths, commandLengths) &&
      Array.from({ length: 27 }, (_, i) => u16(ram, addresses + i * 2)).every(
        (address) =>
          address >= code.destination &&
          address < code.destination + code.length,
      )
    );
  });
  const firstCommand = findInCode(
    image,
    code,
    [0x68, 0xe0, 0x90, 5, 0x3f, -1, -1, 0x2f, -1],
  ).some((p) => dispatch.includes(u16(ram, p + 5)));
  if (
    !dispatch.length ||
    !firstCommand ||
    new Set(lists).size !== 1 ||
    new Set(instruments).size !== 1 ||
    new Set(directories).size !== 1
  )
    return null;
  return {
    upload,
    code,
    section,
    songs: lists[0],
    instruments: instruments[0],
    directory: directories[0],
  };
}

function validSample(
  image: Image,
  directory: number,
  source: number,
  work: Work,
) {
  const entry = directory + source * 4;
  if (!covered(image, entry, 4)) return false;
  const start = u16(image.ram, entry),
    loop = u16(image.ram, entry + 2);
  if (start < 0x100) return false;
  for (let p = start, blocks = 0; blocks < 7281; p += 9, blocks++) {
    if (--work.remaining < 0) return false;
    if (!covered(image, p, 9)) return false;
    const header = image.ram[p];
    if (header & 1)
      return (
        !(header & 2) ||
        (loop >= start && loop <= p && (loop - start) % 9 === 0)
      );
  }
  return false;
}

function songAt(
  image: Image,
  driver: Driver,
  id: number,
  bank: boolean,
  samples: Map<number, boolean>,
  work: Work,
): Song | null {
  const ram = image.ram,
    tableEntry = driver.songs + id * 2;
  if (!covered(image, tableEntry, 2)) return null;
  const start = u16(ram, tableEntry);
  if (start < 0x100 || start >= 0xfff0) return null;
  const sections = new Set<number>(),
    tracks = new Set<number>(),
    pending = [start],
    instruments = new Set<number>(),
    percussionBases = new Set([0]),
    percussionNotes = new Set<number>();
  let operations = 0,
    notes = false,
    bankData = image.coverage[tableEntry] === 2;
  const active = new Set<number>();
  const walkTrack = (
    startTrack: number,
    instrument: number,
    percussion: number,
    depth: number,
  ): { instrument: number; percussion: number } | null => {
    if (depth > 8 || active.has(startTrack)) return null;
    active.add(startTrack);
    let p = startTrack;
    for (;;) {
      if (++operations > 16384 || --work.remaining < 0 || !covered(image, p, 1))
        return null;
      const value = ram[p++];
      if (!value) {
        active.delete(startTrack);
        return { instrument, percussion };
      }
      if (value < 0x80) {
        if (!covered(image, p, 1)) return null;
        if (ram[p] < 0x80) p++;
      } else if (value < 0xe0) {
        if (value !== 0xc8 && value !== 0xc9) {
          notes = true;
          if (value >= 0xca) percussionNotes.add(value - 0xca);
          else instruments.add(instrument);
        }
      } else {
        if (value > 0xfa) return null;
        const count = commandLengths[value - 0xe0];
        if (!covered(image, p, count)) return null;
        if (value === 0xe0) {
          instrument = ram[p];
          instruments.add(instrument);
        }
        if (value === 0xfa) {
          percussion = ram[p];
          percussionBases.add(percussion);
        }
        if (value === 0xef) {
          const returned = walkTrack(
            u16(ram, p),
            instrument,
            percussion,
            depth + 1,
          );
          if (!returned) return null;
          instrument = returned.instrument;
          percussion = returned.percussion;
        }
        p += count;
      }
    }
  };
  while (pending.length) {
    let p = pending.pop();
    if (p === undefined) return null;
    while (!sections.has(p)) {
      if (++operations > 16384 || --work.remaining < 0 || !covered(image, p, 2))
        return null;
      sections.add(p);
      bankData ||= image.coverage[p] === 2;
      const section = u16(ram, p);
      if (!section) break;
      if (section < 0x100) {
        if (section === 0x80 || section === 0x81) {
          p += 2;
          continue;
        }
        if (section > 0x7f || !covered(image, p + 2, 2)) return null;
        pending.push(u16(ram, p + 2));
        p += 4;
        continue;
      }
      if (!covered(image, section, 16)) return null;
      for (let channel = 0; channel < 8; channel++) {
        const track = u16(ram, section + channel * 2);
        if (!track) continue;
        if (track < 0x100 || tracks.size > 256) return null;
        if (!tracks.has(track)) {
          tracks.add(track);
          if (!walkTrack(track, 0, 0, 0)) return null;
        }
      }
      p += 2;
    }
  }
  if (!notes || (bank && !bankData)) return null;
  for (const base of percussionBases)
    for (const note of percussionNotes) instruments.add(base + note);
  for (const instrument of instruments) {
    const p = driver.instruments + instrument * 6;
    if (instrument > 255 || !covered(image, p, 6)) return null;
    const source = ram[p];
    if (!samples.has(source))
      samples.set(source, validSample(image, driver.directory, source, work));
    if (!samples.get(source)) return null;
  }
  return { id, sections, tracks };
}

async function renderSelection(
  bytes: Uint8Array,
  selection: Selection,
  title: string,
  name: string,
  checkpoint: Checkpoint,
) {
  const apu = new SPCAPU(),
    image = materialize(bytes, selection.driver.upload, selection.bank),
    driver = selection.driver;
  apu.reset();
  apu.ram.set(image.ram);
  apu.inputPorts.fill(0);
  apu.cpu.PC = driver.upload.entry;
  let ready = false;
  for (let count = 0; count < 32000; count++) {
    if ((count & 511) === 0) await checkpoint();
    check(
      !apu.cpu.halted,
      'SFC_DRIVER',
      'The N-SPC program halted during initialization.',
    );
    apu.renderSample(apu.sampleOut);
    if (
      apu.control & 1 &&
      apu.timers[0].target === 0x10 &&
      !(apu.control & 0x80)
    ) {
      ready = true;
      break;
    }
  }
  check(
    ready,
    'SFC_DRIVER',
    'The N-SPC program did not initialize its native timer.',
  );
  apu.inputPorts[0] = selection.song.id;
  const snapshot = snapshotSnesAudio(apu, name.replace(/\.spc$/i, ''), title);
  for (let count = 0; count < 32000; count++) {
    if ((count & 511) === 0) await checkpoint();
    check(
      !apu.cpu.halted,
      'SFC_DRIVER',
      'The N-SPC program halted before accepting its music request.',
    );
    apu.renderSample(apu.sampleOut);
    const section = u16(apu.ram, driver.section);
    if (
      selection.song.sections.has(section) &&
      apu.ram[4] === selection.song.id &&
      apu.dsp.regs[0x5d] * 256 === driver.directory
    )
      return snapshot;
  }
  check(
    false,
    'SFC_DRIVER',
    'The N-SPC program did not select the validated music bank.',
  );
}

export async function extractNspcAudio(
  bytes: Uint8Array,
  title: string,
  checkpoint: Checkpoint,
): Promise<AudioImport | null> {
  check(
    bytes.length <= 0x1000000,
    'SFC_DRIVER',
    'The N-SPC source exceeds the bounded cartridge size.',
  );
  const verified: Driver[] = [];
  for await (const upload of scanSnesUploads(bytes, checkpoint)) {
    if (verified.some((driver) => suffixOf(upload, driver.upload))) continue;
    const driver = detectDriver(bytes, upload);
    if (driver) verified.push(driver);
  }
  const baselines: { driver: Driver; image: Image }[] = [];
  for (const driver of verified) {
    await checkpoint();
    const image = materialize(bytes, driver.upload, null);
    if (
      baselines.some(
        (other) =>
          driver.upload.entry === other.driver.upload.entry &&
          image.ram.every((value, p) => value === other.image.ram[p]) &&
          image.coverage.every((value, p) => value === other.image.coverage[p]),
      )
    )
      continue;
    if (baselines.length === 4) return null;
    baselines.push({ driver, image });
  }
  const drivers = baselines.map((value) => value.driver);
  if (!drivers.length) return null;
  const selections: Selection[] = [],
    accepted: Upload[] = [],
    work = { remaining: 0x400000 };
  const index = async (driver: Driver, bank: Upload | null) => {
    const image = materialize(bytes, driver.upload, bank),
      samples = new Map<number, boolean>();
    let count = 0;
    for (let id = 1; id <= 127; id++) {
      if ((id & 7) === 0) await checkpoint();
      const song = songAt(image, driver, id, bank !== null, samples, work);
      if (!song) continue;
      selections.push({ driver, bank, song });
      count++;
    }
    return count;
  };
  for (const driver of drivers) {
    await checkpoint();
    await index(driver, null);
    if (work.remaining < 0 || selections.length > 1024) return null;
  }
  for await (const upload of scanSnesUploads(bytes, checkpoint)) {
    if (
      verified.some((driver) =>
        driver.upload.blocks.some(
          (block) =>
            upload.offset >= block.source &&
            upload.offset < block.source + block.length,
        ),
      ) ||
      verified.some((driver) => driver.upload.offset === upload.offset) ||
      accepted.some((other) => suffixOf(upload, other))
    )
      continue;
    const matching = drivers.filter((driver) => compatible(driver, upload));
    if (matching.length !== 1) continue;
    if (await index(matching[0], upload)) accepted.push(upload);
    if (work.remaining < 0 || selections.length > 1024) return null;
  }
  if (!selections.length) return null;
  let cached: { selection: Selection; bytes: Promise<Uint8Array> } | null =
    null;
  let queue = Promise.resolve();
  const assets: AudioAsset[] = selections.map((selection) => {
    const bank = selection.bank ?? selection.driver.upload,
      name = `N-SPC bank ${bank.offset.toString(16).padStart(6, '0')} song ${String(selection.song.id).padStart(3, '0')}.spc`;
    return {
      name,
      format: 'SPC',
      size: 0x10200,
      gameAudio: true,
      song: selection.song.id,
      source: {
        size: 0x10200,
        async read(offset, length) {
          bounds(0x10200, offset, length);
          await checkpoint();
          if (!length) return new Uint8Array();
          if (!cached || cached.selection !== selection) {
            const pending = queue.then(() =>
              renderSelection(bytes, selection, title, name, checkpoint),
            );
            queue = pending.then(
              () => {},
              () => {},
            );
            cached = { selection, bytes: pending };
          }
          const pending = cached.bytes;
          try {
            const snapshot = await pending;
            check(snapshot, 'SFC_DRIVER');
            return snapshot.slice(offset, offset + length);
          } catch (error) {
            if (cached?.bytes === pending) cached = null;
            throw error;
          }
        },
      },
    };
  });
  return {
    assets,
    warnings: [
      {
        code: 'SFC_PARTIAL',
        detail:
          'Nintendo N-SPC: complete standard port-0 upload banks use their original SPC program and validated BRR samples. Split sample banks, other command protocols, game-driven changes and unvalidated banks are not reconstructed.',
      },
    ],
  };
}
