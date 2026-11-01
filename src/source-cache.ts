import type { ByteSource } from './contracts.js';
import { bounds, check } from './binary.js';

const pageSize = 65536;
const pageCount = 4;
const sharedPageCount = 64;

interface CachePage {
  offset: number;
  owner: Map<number, CachePage>;
  pending: Promise<Uint8Array>;
}

const sharedPages = new Set<CachePage>();

function discard(page: CachePage) {
  page.owner.delete(page.offset);
  sharedPages.delete(page);
}

export function cacheSource(source: ByteSource): ByteSource {
  const pages = new Map<number, CachePage>();

  function page(offset: number) {
    const found = pages.get(offset);
    if (found) {
      pages.delete(offset);
      pages.set(offset, found);
      sharedPages.delete(found);
      sharedPages.add(found);
      return found.pending;
    }
    const length = Math.min(pageSize, source.size - offset);
    const pending = source.read(offset, length).then((bytes) => {
      check(bytes.length === length, 'BOUNDS');
      return bytes;
    });
    const created = { offset, owner: pages, pending };
    pages.set(offset, created);
    sharedPages.add(created);
    void pending.catch(() => {
      if (pages.get(offset) === created) discard(created);
    });
    while (pages.size > pageCount) {
      const first = pages.values().next();
      if (!first.done) discard(first.value);
    }
    while (sharedPages.size > sharedPageCount) {
      const first = sharedPages.values().next();
      if (!first.done) discard(first.value);
    }
    return pending;
  }

  return {
    size: source.size,
    async read(offset, length) {
      bounds(source.size, offset, length);
      if (length > pageSize) return source.read(offset, length);
      const output = new Uint8Array(length);
      for (let copied = 0; copied < length;) {
        const position = offset + copied;
        const start = Math.floor(position / pageSize) * pageSize;
        const bytes = await page(start);
        const at = position - start;
        const count = Math.min(length - copied, bytes.length - at);
        output.set(bytes.subarray(at, at + count), copied);
        copied += count;
      }
      return output;
    },
  };
}
