import type { ByteSource, ProgressReporter } from './contracts.js';
import { Bin, bounds, check } from './binary.js';

const MAX_CODE = 128 * 1024 * 1024;

export interface CodeCache {
  source: ByteSource | null;
  bytes: Uint8Array | null;
  pending: Promise<void>;
}

export function codeCache(): CodeCache {
  return { source: null, bytes: null, pending: Promise.resolve() };
}

async function decode(
  source: ByteSource,
  size: number,
  footer: Bin,
  report: ProgressReporter,
) {
  const input = await source.read(0, source.size),
    output = new Uint8Array(size),
    start = source.size - (footer.u32(0) & 16777215),
    header = footer.u32(0) >>> 24;
  for (let i = source.size - header; i < source.size - 8; i++) {
    check(input[i] === 255, 'INVALID_CODE_COMPRESSION');
  }
  output.set(input.subarray(0, start));
  let cursor = source.size - header,
    out = size,
    nextYield = size - 1024 * 1024;
  while (out > start) {
    check(cursor > start, 'INVALID_CODE_COMPRESSION');
    const flags = input[--cursor];
    for (let mask = 128; mask && out > start; mask >>= 1) {
      if (flags & mask) {
        check(cursor - start >= 2, 'INVALID_CODE_COMPRESSION');
        const high = input[--cursor],
          low = input[--cursor],
          count = (high >>> 4) + 3,
          distance = (((high & 15) << 8) | low) + 3;
        check(
          distance <= size - out && count <= out - start,
          'INVALID_CODE_COMPRESSION',
        );
        for (let i = 0; i < count; i++) {
          out--;
          output[out] = output[out + distance];
        }
      } else {
        check(cursor > start, 'INVALID_CODE_COMPRESSION');
        output[--out] = input[--cursor];
      }
    }
    if (out <= nextYield) {
      report({ phase: 'decompress', value: (size - out) / (size - start) });
      await new Promise((resolve) => setTimeout(resolve, 0));
      nextYield = out - 1024 * 1024;
    }
  }
  check(cursor === start, 'INVALID_CODE_COMPRESSION');
  report({ phase: 'decompress', value: 1 });
  return output;
}

export async function decompressedCode(
  source: ByteSource,
  cache = codeCache(),
  report: ProgressReporter = () => {},
): Promise<ByteSource> {
  check(source.size >= 8, 'INVALID_CODE_COMPRESSION');
  check(source.size <= MAX_CODE, 'CODE_TOO_LARGE');
  const footer = new Bin(await source.read(source.size - 8, 8)),
    extra = footer.u32(4),
    size = source.size + extra;
  check(size <= MAX_CODE, 'CODE_TOO_LARGE');
  if (!extra) {
    return source;
  }
  const compressed = footer.u32(0) & 16777215,
    header = footer.u32(0) >>> 24;
  check(
    header >= 8 && compressed > header && compressed <= source.size,
    'INVALID_CODE_COMPRESSION',
  );
  return {
    size,
    async read(offset, length) {
      bounds(size, offset, length);
      if (!length) {
        return new Uint8Array();
      }
      const pending = cache.pending.then(async () => {
        if (cache.source !== source) {
          cache.source = null;
          cache.bytes = null;
          cache.bytes = await decode(source, size, footer, report);
          cache.source = source;
        }
        check(cache.bytes, 'INVALID_CODE_COMPRESSION');
        return cache.bytes.slice(offset, offset + length);
      });
      cache.pending = pending.then(
        () => {},
        () => {},
      );
      return pending;
    },
  };
}
