import type { Archive, ArchiveEntry, ByteSource } from './contracts.js';
import { Bin, bounds, check, sliceSource } from './binary.js';

export interface GbsHeader {
  songs: number;
  firstSong: number;
  load: number;
  init: number;
  play: number;
  stack: number;
  modulo: number;
  timer: number;
  title: string;
  author: string;
  copyright: string;
}

export async function readGbsHeader(source: ByteSource): Promise<GbsHeader> {
  bounds(source.size, 0, 0x71);
  check(source.size <= 4 * 1024 ** 2 + 0x70, 'TOO_LARGE');
  const header = new Bin(await source.read(0, 0x70));
  check(header.str(0, 3) === 'GBS' && header.u8(3) === 1, 'INVALID_AUDIO');
  const songs = header.u8(4);
  const firstSong = header.u8(5);
  const load = header.u16(6);
  const init = header.u16(8);
  const play = header.u16(10);
  const stack = header.u16(12);
  const timer = header.u8(15);
  check(songs > 0 && firstSong >= 1 && firstSong <= songs, 'INVALID_AUDIO');
  check(
    [load, init, play].every((address) => address >= 0x400 && address < 0x8000),
    'INVALID_AUDIO',
  );
  check(
    (stack >= 0xa002 && stack <= 0xe000) || stack >= 0xff82,
    'INVALID_AUDIO',
  );
  check(!(timer & 0x38), 'INVALID_AUDIO');
  if (timer & 0x40)
    check(load <= 0x7fb0 && source.size >= 0xc0, 'INVALID_AUDIO');
  const text = (offset: number) =>
    new TextDecoder('windows-1252')
      .decode(header.b.subarray(offset, offset + 32))
      .replace(/\0.*$/, '')
      .trim();
  return {
    songs,
    firstSong: firstSong - 1,
    load,
    init,
    play,
    stack,
    modulo: header.u8(14),
    timer,
    title: text(0x10),
    author: text(0x30),
    copyright: text(0x50),
  };
}

export async function openGameBoy(
  source: ByteSource,
  name: string,
): Promise<Archive & { metadata?: GbsHeader }> {
  const entries: ArchiveEntry[] = [];
  const add = (path: string, kind: string, offset: number, size: number) =>
    entries.push({
      path,
      kind,
      size,
      source: sliceSource(source, offset, size),
    });
  if (/\.gbs$/i.test(name)) {
    const metadata = await readGbsHeader(source);
    add('gbs/header.bin', 'metadata', 0, 0x70);
    add('gbs/driver.bin', 'code', 0x70, source.size - 0x70);
    return { format: 'GBS', metadata, entries };
  }
  bounds(source.size, 0, 0x150);
  const header = new Bin(await source.read(0x100, 0x50));
  let checksum = 0;
  for (let offset = 0x34; offset <= 0x4c; offset++)
    checksum = (checksum - header.u8(offset) - 1) & 255;
  check(checksum === header.u8(0x4d), 'INVALID_CARTRIDGE');
  const sizeCode = header.u8(0x48);
  const unusualBanks: Partial<Record<number, number>> = {
    0x52: 72,
    0x53: 80,
    0x54: 96,
  };
  const banks = sizeCode <= 8 ? 2 << sizeCode : unusualBanks[sizeCode];
  check(
    banks && source.size >= banks * 16384 && source.size <= 8 * 1024 ** 2,
    'INVALID_CARTRIDGE',
  );
  const color = [0x80, 0xc0].includes(header.u8(0x43));
  add('gameboy/header.bin', 'metadata', 0x100, 0x50);
  for (let bank = 0; bank < banks; bank++)
    add(
      'gameboy/rom/bank_' + bank.toString(16).padStart(3, '0') + '.bin',
      'cartridge',
      bank * 16384,
      16384,
    );
  if (source.size > banks * 16384)
    add(
      'gameboy/trailing.bin',
      'file',
      banks * 16384,
      source.size - banks * 16384,
    );
  return { format: color ? 'GBC' : 'GB', entries };
}
