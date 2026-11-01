import type { Archive, ArchiveEntry, ByteSource } from './contracts.js';
import { Bin, check, sliceSource } from './binary.js';

export async function openGbaCartridge(
  source: ByteSource,
  filename: string,
): Promise<Archive> {
  check(
    /\.gba$/i.test(filename) &&
      Number.isSafeInteger(source.size) &&
      source.size >= 0xc4 &&
      source.size <= 0x2000000,
    'INVALID_CARTRIDGE',
  );
  const bytes = await source.read(0, 0xc0);
  check(bytes.length === 0xc0, 'INVALID_CARTRIDGE');
  const header = new Bin(bytes);
  const instruction = header.u32(0);
  const entryPoint = 8 + ((instruction << 8) >> 6);
  check(
    header.u8(3) === 0xea &&
      entryPoint >= 0xc0 &&
      entryPoint <= source.size - 4 &&
      header.u8(0xb2) === 0x96 &&
      header.u8(0xb3) === 0,
    'INVALID_CARTRIDGE',
  );
  let complement = -0x19;
  for (let offset = 0xa0; offset <= 0xbc; offset++)
    complement -= header.u8(offset);
  check((complement & 255) === header.u8(0xbd), 'INVALID_CARTRIDGE');
  const entries: ArchiveEntry[] = [
    {
      path: 'gba/header.bin',
      kind: 'metadata',
      size: 0xc0,
      source: sliceSource(source, 0, 0xc0),
    },
  ];
  for (
    let offset = 0, bank = 0;
    offset < source.size;
    offset += 0x10000, bank++
  ) {
    const size = Math.min(0x10000, source.size - offset);
    entries.push({
      path: 'gba/rom/bank_' + bank.toString(16).padStart(4, '0') + '.bin',
      kind: 'cartridge',
      size,
      source: sliceSource(source, offset, size),
    });
  }
  return { format: 'GBA', entries };
}
