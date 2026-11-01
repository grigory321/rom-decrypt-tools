export interface SnesUploadBlock {
  header: number;
  source: number;
  destination: number;
  length: number;
}

export interface SnesUpload {
  offset: number;
  end: number;
  entry: number;
  blocks: SnesUploadBlock[];
}

export interface SnesImage {
  ram: Uint8Array;
  coverage: Uint8Array;
}

const word = (bytes: Uint8Array, p: number) => bytes[p] | (bytes[p + 1] << 8);

export const snesRange = (size: number, p: number, length: number) =>
  Number.isSafeInteger(p) &&
  Number.isSafeInteger(length) &&
  p >= 0 &&
  length >= 0 &&
  p <= size &&
  length <= size - p;

export const snesPattern = (
  bytes: Uint8Array,
  p: number,
  values: readonly number[],
) =>
  snesRange(bytes.length, p, values.length) &&
  values.every((value, i) => value < 0 || bytes[p + i] === value);

export const snesOverlap = (a: SnesUploadBlock, b: SnesUploadBlock) =>
  a.destination < b.destination + b.length &&
  b.destination < a.destination + a.length;

function readUpload(bytes: Uint8Array, offset: number): SnesUpload | null {
  const blocks: SnesUploadBlock[] = [];
  let p = offset,
    total = 0;
  for (let count = 0; count <= 64; count++) {
    if (!snesRange(bytes.length, p, 4)) return null;
    const length = word(bytes, p),
      destination = word(bytes, p + 2);
    if (!length)
      return blocks.length && destination >= 0x100 && destination < 0xffc0
        ? { offset, end: p + 4, entry: destination, blocks }
        : null;
    if (
      count === 64 ||
      destination < 0x100 ||
      !snesRange(65536, destination, length) ||
      !snesRange(bytes.length, p + 4, length) ||
      total + length > 65536
    )
      return null;
    const block = { header: p, source: p + 4, destination, length };
    if (blocks.some((other) => snesOverlap(other, block))) return null;
    blocks.push(block);
    p += 4 + length;
    total += length;
  }
  return null;
}

export async function* scanSnesUploads(
  bytes: Uint8Array,
  checkpoint: () => Promise<void>,
) {
  for (let p = 0; p + 8 <= bytes.length; p++) {
    if ((p & 16383) === 0) await checkpoint();
    const length = word(bytes, p),
      destination = word(bytes, p + 2);
    if (
      !length ||
      destination < 0x100 ||
      !snesRange(65536, destination, length) ||
      !snesRange(bytes.length, p + 4, length)
    )
      continue;
    const upload = readUpload(bytes, p);
    if (upload) yield upload;
  }
}

export function materializeSnesUpload(
  bytes: Uint8Array,
  base: SnesUpload,
  bank: SnesUpload | null = null,
): SnesImage {
  const image = { ram: new Uint8Array(65536), coverage: new Uint8Array(65536) };
  for (const { upload, owner } of [
    { upload: base, owner: 1 },
    { upload: bank, owner: 2 },
  ]) {
    if (!upload) continue;
    for (const block of upload.blocks) {
      image.ram.set(
        bytes.subarray(block.source, block.source + block.length),
        block.destination,
      );
      image.coverage.fill(
        owner,
        block.destination,
        block.destination + block.length,
      );
    }
  }
  return image;
}

export function snesUploadSuffix(upload: SnesUpload, other: SnesUpload) {
  return (
    other.offset < upload.offset &&
    other.end === upload.end &&
    other.blocks.some((block) => block.header === upload.offset)
  );
}
