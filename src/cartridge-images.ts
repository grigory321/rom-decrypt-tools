import type { ByteSource, ArchiveEntry } from './contracts.js';
import { Bin, bounds, check, sliceSource } from './binary.js';

const spcSignature = 'SNES-SPC700 Sound File Data';

export async function openCartridge(source: ByteSource, filename: string) {
  const entries: ArchiveEntry[] = [];

  function add(path: string, kind: string, offset: number, size: number) {
    entries.push({
      path,
      kind,
      size,
      source: sliceSource(source, offset, size),
    });
  }

  if (/\.spc$/i.test(filename)) {
    bounds(source.size, 0, 0x10200);
    const header = new Bin(await source.read(0, 0x100));
    check(header.str(0, spcSignature.length) === spcSignature, 'INVALID_AUDIO');
    add('spc/header.bin', 'metadata', 0, 0x100);
    add('spc/ram.bin', 'code', 0x100, 0x10000);
    add('spc/dsp-registers.bin', 'metadata', 0x10100, 0x80);
    add('spc/reserved.bin', 'metadata', 0x10180, 0x40);
    add('spc/ipl-rom.bin', 'code', 0x101c0, 0x40);
    if (source.size > 0x10200)
      add('spc/extended-tags.bin', 'metadata', 0x10200, source.size - 0x10200);
    return { format: 'SPC', entries };
  }

  check(/\.(sfc|smc|swc|fig)$/i.test(filename), 'INVALID_CARTRIDGE');
  const prefix = source.size % 0x8000 === 512 ? 512 : 0;
  const romSize = source.size - prefix;
  check(romSize >= 0x8000 && romSize <= 64 * 1024 ** 2, 'INVALID_CARTRIDGE');
  let selectedHeader: {
    offset: number;
    mapping: string;
    score: number;
  } | null = null;

  for (const [offset, mapping] of [
    [0x7fc0, 'LoROM'],
    [0xffc0, 'HiROM'],
    [0x40ffc0, 'ExHiROM'],
  ] as const) {
    if (offset + 64 > romSize) continue;
    const header = new Bin(await source.read(prefix + offset, 64));
    const mode = header.u8(0x15) & 0xef;
    const resetVector = header.u16(0x3c);
    const checksummed = (header.u16(0x1c) ^ header.u16(0x1e)) === 0xffff;
    let score = checksummed ? 8 : 0;
    if (resetVector >= 0x8000) score += 4;
    if (
      (mapping === 'LoROM' && [0x20, 0x22, 0x23].includes(mode)) ||
      (mapping !== 'LoROM' && [0x21, 0x25].includes(mode))
    )
      score += 4;
    else score -= 16;
    if (header.b.subarray(0, 21).some((value) => value !== 0 && value !== 255))
      score++;
    if (
      !selectedHeader ||
      score > selectedHeader.score ||
      (score === selectedHeader.score && mapping === 'ExHiROM' && mode === 0x25)
    )
      selectedHeader = { offset, mapping, score };
  }

  check(selectedHeader && selectedHeader.score >= 8, 'INVALID_CARTRIDGE');
  if (prefix) add('snes/copier-header.bin', 'metadata', 0, prefix);
  add('snes/header.bin', 'metadata', prefix + selectedHeader.offset, 64);
  for (let offset = 0, bank = 0; offset < romSize; offset += 0x8000, bank++) {
    add(
      'snes/rom/bank_' + bank.toString(16).padStart(4, '0') + '.bin',
      'cartridge',
      prefix + offset,
      Math.min(0x8000, romSize - offset),
    );
  }
  return { format: 'SNES', mapping: selectedHeader.mapping, entries };
}
