import { bounds, check } from './binary.js';
import type { ByteSource } from './contracts.js';
import { readAudio } from './audio-codecs.js';

export class M4aRom {
  private readonly pages = new Map<number, Uint8Array>();

  constructor(
    readonly source: ByteSource,
    readonly checkCurrent: () => void = () => {},
  ) {}

  offset(pointer: number, size = 1): number {
    const offset = pointer - 0x08000000;
    check(
      Number.isSafeInteger(pointer) && pointer >= 0x08000000,
      'GBA_M4A_POINTER',
    );
    bounds(this.source.size, offset, size);
    return offset;
  }

  async page(offset: number): Promise<{ offset: number; bytes: Uint8Array }> {
    this.checkCurrent();
    bounds(this.source.size, offset, 1);
    const start = Math.floor(offset / 65536) * 65536;
    let bytes = this.pages.get(start);
    if (bytes) this.pages.delete(start);
    else {
      bytes = await readAudio(
        this.source,
        start,
        Math.min(65536, this.source.size - start),
      );
      this.checkCurrent();
    }
    this.pages.set(start, bytes);
    while (this.pages.size > 4) {
      const first = this.pages.keys().next();
      if (!first.done) this.pages.delete(first.value);
    }
    return { offset: start, bytes };
  }

  async byte(offset: number): Promise<number> {
    const page = await this.page(offset);
    return page.bytes[offset - page.offset];
  }

  async bytes(offset: number, length: number): Promise<Uint8Array> {
    bounds(this.source.size, offset, length);
    const result = new Uint8Array(length);
    for (let copied = 0; copied < length;) {
      const page = await this.page(offset + copied);
      const start = offset + copied - page.offset;
      const count = Math.min(length - copied, page.bytes.length - start);
      result.set(page.bytes.subarray(start, start + count), copied);
      copied += count;
    }
    return result;
  }

  async word(offset: number): Promise<number> {
    const bytes = await this.bytes(offset, 4);
    return new DataView(bytes.buffer, bytes.byteOffset, 4).getUint32(0, true);
  }
}
