import type { PsfBundle } from './contracts.js';
import type { IopFile, IopOptions } from './psf2-types.js';
import { check, FormatError } from './binary.js';
import { audioDecoder } from './audio-codecs.js';
import { IopMachine, iopPath } from './psf2-iop.js';

function seconds(value: string | undefined | null) {
  if (value === undefined || value === null || value === '') return null;
  const parts = String(value).trim().split(':');
  if (parts.length > 3 || parts.some((part) => !/^\d+(?:\.\d+)?$/.test(part)))
    return null;
  if (parts.slice(1).some((part) => Number(part) >= 60)) return null;
  let total = 0;
  for (const part of parts) total = total * 60 + Number(part);
  return Number.isFinite(total) && total >= 0 && total <= 86400 ? total : null;
}

export async function createPsf2Decoder(
  bundle: PsfBundle,
  options: IopOptions = {},
) {
  check(
    bundle?.format === 'PSF2' && Array.isArray(bundle.files),
    'PSF2_FILESYSTEM',
  );
  const files = new Map<string, IopFile>();
  const abort = () => {
    if (
      options.signal?.aborted ||
      options.cancelled?.() ||
      options.isCancelled?.()
    )
      throw new FormatError('CANCELLED');
  };
  for (const file of bundle.files) {
    abort();
    const size = file.size ?? file.source?.size ?? file.bytes?.length;
    check(
      Number.isSafeInteger(size) && size >= 0,
      'PSF2_FILESYSTEM',
      'IOP file size',
    );
    const descriptor: IopFile = { source: file.source, size };
    if (file.bytes instanceof Uint8Array) {
      check(file.bytes.length === size, 'PSF2_FILESYSTEM');
      descriptor.bytes = file.bytes;
    } else {
      check(typeof file.source?.read === 'function', 'PSF2_FILESYSTEM');
    }
    const path = iopPath(file.path);
    check(path && !files.has(path), 'PSF2_FILESYSTEM', 'Duplicate IOP path');
    files.set(path, descriptor);
  }
  const main = files.get('psf2.irx');
  check(main, 'PSF2_MODULE', 'Missing psf2.irx');
  check(
    main.size <= 8 * 1024 ** 2,
    'PSF2_MODULE',
    'IRX file exceeds bounded module cache',
  );
  if (!main.bytes) {
    check(main.source, 'PSF2_FILESYSTEM', 'Missing psf2.irx source');
    main.bytes = await main.source.read(0, main.size);
    check(
      main.bytes instanceof Uint8Array && main.bytes.length === main.size,
      'PSF2_FILESYSTEM',
      'Truncated psf2.irx',
    );
  }
  const duration = seconds(bundle.tags?.length);
  const fade = duration === null ? 0 : (seconds(bundle.tags?.fade) ?? 0);
  const length =
    duration === null ? null : Math.round((duration + fade) * 48000);
  abort();
  let machine = new IopMachine(files, options);
  const reset = () => {
    abort();
    machine = new IopMachine(files, options);
  };
  return audioDecoder(
    { sampleRate: 48000, channels: 2, length, loop: false, tags: bundle.tags },
    async (count: number, position: number) => {
      const channels = await machine.renderAsync(count);
      if (duration !== null && fade > 0)
        for (let index = 0; index < count; index++) {
          const gain = Math.max(
            0,
            Math.min(1, (duration + fade - (position + index) / 48000) / fade),
          );
          channels[0][index] *= gain;
          channels[1][index] *= gain;
        }
      await Promise.resolve();
      abort();
      return channels;
    },
    reset,
  );
}
