import type { ByteSource } from './contracts.js';
import { Bin, bounds, check, sliceSource } from './binary.js';

export type CseqCheck = () => void;

export interface CseqBlock {
  offset: number;
  size: number;
}

export interface CseqContainer {
  littleEndian: boolean;
  blocks: ReadonlyMap<number, CseqBlock>;
}

export interface CseqFile {
  data: ByteSource;
  labels: ReadonlyMap<string, number>;
  littleEndian: boolean;
  bytecodeEndian: 'big';
}

export const cseqMaximumItems = 65536;
const maximumMetadata = 16 * 1024 * 1024;

export class CseqInfo {
  readonly bin: Bin;

  constructor(
    bytes: Uint8Array,
    readonly littleEndian: boolean,
  ) {
    this.bin = new Bin(bytes);
  }

  u8(offset: number): number {
    return this.bin.u8(offset);
  }

  u16(offset: number): number {
    return this.bin.u16(offset, this.littleEndian);
  }

  u32(offset: number): number {
    return this.bin.u32(offset, this.littleEndian);
  }

  i32(offset: number): number {
    this.bin.range(offset, 4);
    return this.bin.d.getInt32(offset, this.littleEndian);
  }

  count(offset: number, stride: number, maximum = cseqMaximumItems): number {
    const count = this.u32(offset);
    check(
      count <= maximum,
      'TOO_MANY',
      'CSEQ resource table exceeds its limit.',
    );
    this.bin.range(offset + 4, count * stride);
    return count;
  }

  reference(offset: number, base: number): number | null {
    const relative = this.i32(offset + 4);
    if (relative === -1) return null;
    check(relative >= 0, 'CSEQ_FORMAT', 'Negative resource reference.');
    const target = base + relative;
    this.bin.range(target, 1);
    return target;
  }

  flags(offset: number): ReadonlyMap<number, number> {
    const flags = this.u32(offset);
    const values = new Map<number, number>();
    let cursor = offset + 4;
    for (let bit = 0; bit < 32; bit++) {
      if ((flags >>> bit) & 1) {
        values.set(bit, this.u32(cursor));
        cursor += 4;
      }
    }
    return values;
  }
}

async function exactRead(
  source: ByteSource,
  offset: number,
  length: number,
  checkCurrent: CseqCheck,
): Promise<Uint8Array> {
  checkCurrent();
  bounds(source.size, offset, length);
  check(length <= 65536, 'TOO_LARGE');
  const bytes = await source.read(offset, length);
  checkCurrent();
  check(bytes.length === length, 'CSEQ_FORMAT', 'Truncated resource.');
  return bytes;
}

export async function readCseqContainer(
  source: ByteSource,
  magic: string,
  checkCurrent: CseqCheck = () => {},
): Promise<CseqContainer> {
  const first = new Bin(await exactRead(source, 0, 20, checkCurrent));
  check(first.str(0, 4) === magic, 'CSEQ_FORMAT', 'Expected ' + magic + '.');
  const bom = first.u16(4);
  check(bom === 0xfeff || bom === 0xfffe, 'CSEQ_FORMAT', 'Invalid byte order.');
  const littleEndian = bom === 0xfeff;
  const headerSize = first.u16(6, littleEndian);
  const fileSize = first.u32(12, littleEndian);
  const count = first.u16(16, littleEndian);
  check(count <= 64, 'TOO_MANY', 'Too many resource blocks.');
  check(
    headerSize >= 20 + count * 12 &&
      headerSize <= 65536 &&
      fileSize >= headerSize &&
      (fileSize <= source.size ||
        (fileSize - source.size < 32 && fileSize % 32 === 0)),
    'CSEQ_FORMAT',
    'Invalid resource header.',
  );
  const entries = new Bin(
    await exactRead(source, 20, count * 12, checkCurrent),
  );
  const blocks = new Map<number, CseqBlock>();
  for (let index = 0; index < count; index++) {
    const position = index * 12;
    const id = entries.u16(position, littleEndian);
    const offset = entries.u32(position + 4, littleEndian);
    const size = entries.u32(position + 8, littleEndian);
    if (offset === 0xffffffff) continue;
    check(
      offset >= headerSize && size >= 8,
      'CSEQ_FORMAT',
      'Invalid resource block.',
    );
    bounds(fileSize, offset, size);
    bounds(source.size, offset, 8);
    check(!blocks.has(id), 'CSEQ_FORMAT', 'Duplicate resource block.');
    for (const block of blocks.values()) {
      check(
        offset + size <= block.offset || block.offset + block.size <= offset,
        'CSEQ_FORMAT',
        'Overlapping resource blocks.',
      );
    }
    blocks.set(id, { offset, size });
  }
  return { littleEndian, blocks };
}

export function cseqBlock(container: CseqContainer, id: number): CseqBlock {
  const block = container.blocks.get(id);
  check(block, 'CSEQ_FORMAT', 'Missing resource block: ' + id.toString(16));
  return block;
}

export async function readCseqBlockHeader(
  source: ByteSource,
  block: CseqBlock,
  magic: string,
  littleEndian: boolean,
  checkCurrent: CseqCheck = () => {},
): Promise<void> {
  const header = new Bin(
    await exactRead(source, block.offset, 8, checkCurrent),
  );
  check(
    header.str(0, 4) === magic && header.u32(4, littleEndian) === block.size,
    'CSEQ_FORMAT',
    'Invalid ' + magic + ' block.',
  );
}

export async function readCseqInfo(
  source: ByteSource,
  block: CseqBlock,
  magic: string,
  littleEndian: boolean,
  checkCurrent: CseqCheck = () => {},
): Promise<CseqInfo> {
  check(
    block.size <= maximumMetadata,
    'TOO_LARGE',
    'CSEQ metadata exceeds its limit.',
  );
  await readCseqBlockHeader(source, block, magic, littleEndian, checkCurrent);
  const bytes = new Uint8Array(
    Math.min(block.size, source.size - block.offset) - 8,
  );
  for (let offset = 0; offset < bytes.length; offset += 65536) {
    const length = Math.min(65536, bytes.length - offset);
    bytes.set(
      await exactRead(source, block.offset + 8 + offset, length, checkCurrent),
      offset,
    );
  }
  return new CseqInfo(bytes, littleEndian);
}

export async function readCseqFile(
  source: ByteSource,
  checkCurrent: CseqCheck = () => {},
): Promise<CseqFile> {
  const container = await readCseqContainer(source, 'CSEQ', checkCurrent);
  const block = cseqBlock(container, 0x5000);
  await readCseqBlockHeader(
    source,
    block,
    'DATA',
    container.littleEndian,
    checkCurrent,
  );
  const data = sliceSource(source, block.offset + 8, block.size - 8);
  check(data.size > 0, 'CSEQ_FORMAT', 'Empty sequence data.');
  const labels = new Map<string, number>();
  const labelBlock = container.blocks.get(0x5001);
  if (labelBlock) {
    const info = await readCseqInfo(
      source,
      labelBlock,
      'LABL',
      container.littleEndian,
      checkCurrent,
    );
    const count = info.count(0, 8);
    for (let index = 0; index < count; index++) {
      checkCurrent();
      const entry = info.reference(4 + index * 8, 0);
      if (entry === null) continue;
      const target = info.i32(entry + 4);
      const length = info.u32(entry + 8);
      check(length <= 4096, 'TOO_LARGE', 'Sequence label exceeds its limit.');
      check(
        target >= 0 && target < data.size,
        'CSEQ_FORMAT',
        'Label points outside sequence.',
      );
      const name = new TextDecoder()
        .decode(info.bin.slice(entry + 12, length))
        .replace(/\0.*$/, '');
      check(!labels.has(name), 'CSEQ_FORMAT', 'Duplicate sequence label.');
      labels.set(name, target);
    }
  }
  return {
    data,
    labels,
    littleEndian: container.littleEndian,
    bytecodeEndian: 'big',
  };
}

export async function readCwarFile(
  source: ByteSource,
  checkCurrent: CseqCheck = () => {},
): Promise<readonly (ByteSource | null)[]> {
  const container = await readCseqContainer(source, 'CWAR', checkCurrent);
  const info = await readCseqInfo(
    source,
    cseqBlock(container, 0x6800),
    'INFO',
    container.littleEndian,
    checkCurrent,
  );
  const file = cseqBlock(container, 0x6801);
  await readCseqBlockHeader(
    source,
    file,
    'FILE',
    container.littleEndian,
    checkCurrent,
  );
  const count = info.count(0, 12);
  const waves: (ByteSource | null)[] = [];
  for (let index = 0; index < count; index++) {
    checkCurrent();
    const offset = info.u32(8 + index * 12);
    const size = info.u32(12 + index * 12);
    if (offset === 0xffffffff) waves.push(null);
    else {
      check(size >= 20, 'CSEQ_FORMAT', 'Invalid wave length.');
      bounds(file.size - 8, offset, size);
      waves.push(sliceSource(source, file.offset + 8 + offset, size));
    }
  }
  return waves;
}
