import { check } from './binary.js';

export class IopHeap {
  blocks: Map<number, number>;
  constructor(
    readonly base: number,
    readonly size: number,
  ) {
    this.blocks = new Map();
  }

  allocate(size: number) {
    check(
      Number.isSafeInteger(size) && size > 0 && size <= 0x200000,
      'PSF2_MEMORY',
    );
    const length = Math.ceil(size / 8) * 8;
    let address = this.base;
    for (const [start, count] of [...this.blocks].sort((a, b) => a[0] - b[0])) {
      if (start - address >= length) break;
      address = start + count;
    }
    if (address + length > this.base + this.size) return 0;
    this.blocks.set(address, length);
    return address;
  }

  free(address: number) {
    return this.blocks.delete(address);
  }

  get available() {
    return (
      this.size -
      [...this.blocks.values()].reduce((sum, length) => sum + length, 0)
    );
  }
}
