import type { KeySet, ProgressReporter, SourceInput } from './contracts.js';
import { check } from './binary.js';
import { asSource } from './source-input.js';
import { inspectDsiModcrypt } from './dsi-modcrypt.js';

const dsiName = /\.(nds|srl)$/i;

export async function inspectRomFile(
  file: SourceInput,
  name: string,
  keys?: KeySet,
) {
  if (dsiName.test(name)) {
    const info = await inspectDsiModcrypt(asSource(file));
    check(info, 'DSI_MODCRYPT');
    return {
      format: 'DSi',
      titleId: info.gameCode,
      encrypted: info.encrypted,
      count: info.regions.length,
    };
  }
  const { inspectRom } = await import('./conversion.js');
  const info = await inspectRom(file, name, keys);
  return {
    format: info.format,
    titleId: info.titleId,
    encrypted: info.contents.some(
      (item) => item.encrypted || item.outerEncrypted,
    ),
    count: info.contents.length,
  };
}

export async function prepareRomFile(
  file: SourceInput,
  name: string,
  target = 'decrypt',
  keys?: KeySet,
  report: ProgressReporter = () => {},
) {
  if (dsiName.test(name)) {
    check(target === 'decrypt', 'OUTPUT_FORMAT');
    const info = await inspectDsiModcrypt(asSource(file), () =>
      report({ phase: 'decrypt', value: null }),
    );
    check(info, 'DSI_MODCRYPT');
    return {
      source: info.source,
      filename: name.replace(/\.(nds|srl)$/i, '-decrypted.$1'),
      format: 'DSi',
      titleId: info.gameCode,
      warnings: [],
    };
  }
  const { prepareConversion } = await import('./conversion.js');
  return prepareConversion(file, name, target, keys, report);
}
