import { needsExportDuration } from './audio-policy.js';
import type {
  ByteSource,
  SourceInput,
  CompanionFile,
  ProgressReporter,
  Archive,
  ArchiveEntry,
  Diagnostic,
  AudioAsset,
  AudioImport,
  DecoderOptions,
} from './contracts.js';
import { asSource, sourceName } from './source-input.js';
import { errorCode, errorDetail } from './container-errors.js';
import { Bin, check, sliceSource } from './binary.js';
import { readAudio } from './audio-codecs.js';
import { isGameAudioFile, sourceAudioFormats } from './audio-formats.js';
import type { RxwsBank } from './audio-rxws.js';

const audioArchiveNames = /\.(awb|afs2|awx|vab|vh)$/i;
const rxwsNames = /\.(xws|xwh)$/i;
const audioKeyNames = /\.(adxkey|hcakey)$/i;

async function decryptAudioSource(
  source: ByteSource,
  format: string,
  options: DecoderOptions,
) {
  if (format === 'ADX')
    return (await import('./audio-adx.js')).decryptAdxSource(source, options);
  if (format === 'HCA')
    return (await import('./audio-hca.js')).decryptHcaSource(source, options);
  return source;
}

function deferredAudioSource(
  source: ByteSource,
  format: string,
  options: DecoderOptions,
): ByteSource {
  let pending: Promise<ByteSource> | undefined;
  return {
    size: source.size,
    async read(offset, length) {
      pending ||= decryptAudioSource(source, format, options);
      return (await pending).read(offset, length);
    },
  };
}

function audioKeys(files: (SourceInput | ArchiveEntry)[]) {
  return files
    .filter((file) => audioKeyNames.test(sourceName(file)))
    .map((file) => ({ name: sourceName(file), source: asSource(file) }));
}

const cartridgeNames = /\.(sfc|smc|swc|fig|spc|gb|gbc|gbs|gba)$/i;
const discNames = /\.(iso|bin|cue)$/i;
const wiiNames = /\.(iso|wbfs|wad|arc|u8|wud|wux|rpx|rpl|app|tmd)$/i;
const ndsNames = /\.(nds|srl)$/i;
const ctrNames = /\.(cia|3ds|cci|cxi|cfa|ncch)$/i;
const psfNames = /\.(psf|psf2|minipsf|minipsf2|psflib|psf2lib)$/i;
const audioNames =
  /\.(brstm|rwav|brwav|dsp|vag|ss2|ads|wav|spc|xa|str|pxa|xai|ixa|xap|bcwav|bcstm|bfwav|bfstm|swav|strm|sdat|brsar|brwar|bfsar|bfwar|bcsar|bcwar|bcgrp|bfgrp)$/i;
const nintendoAudio = new Set([
  'RSTM',
  'RWAV',
  'CWAV',
  'CSTM',
  'FWAV',
  'FSTM',
  'SWAV',
  'STRM',
  'SDAT',
  'SSEQ',
  'CSEQ',
  'FSEQ',
]);

export const isPlatformFile = (name: string) =>
  /\.(zip|pss)$/i.test(name) ||
  cartridgeNames.test(name) ||
  ndsNames.test(name) ||
  ctrNames.test(name) ||
  psfNames.test(name) ||
  discNames.test(name) ||
  wiiNames.test(name) ||
  audioNames.test(name) ||
  isGameAudioFile(name) ||
  audioArchiveNames.test(name) ||
  rxwsNames.test(name);

export function folderContents(files: SourceInput[]): Archive {
  check(files.length > 0 && files.length <= 200000, 'TOO_MANY');
  const paths = new Set<string>();
  let pathCharacters = 0;
  const entries = files.map((file) => {
    const input =
      'file' in file ? file.file : 'blob' in file ? file.blob : file;
    const path =
      ('path' in file && file.path) ||
      ('webkitRelativePath' in input && input.webkitRelativePath) ||
      sourceName(file, true);
    pathCharacters += path?.length || 0;
    check(pathCharacters <= 16 * 1024 ** 2, 'TOO_LARGE');
    check(
      path &&
        path.length <= 4096 &&
        !path
          .split('/')
          .some(
            (part) =>
              !part ||
              part === '.' ||
              part === '..' ||
              /[\\\x00-\x1f]/.test(part),
          ),
      'UNSAFE_NAME',
    );
    check(!paths.has(path), 'DUPLICATE_PATH');
    paths.add(path);
    const source = asSource(file);
    return { path, kind: 'file', size: source.size, source };
  });
  return { format: 'FOLDER', entries };
}

export async function openPlatformContents(
  file: SourceInput,
  name: string,
  companions: CompanionFile[] = [],
  report: ProgressReporter = () => {},
): Promise<Archive | null> {
  const source = asSource(file);
  const zip =
    source.size >= 4 ? new Bin(await readAudio(source, 0, 4)).u32(0) : 0;
  if (/\.zip$/i.test(name) || zip === 0x04034b50 || zip === 0x06054b50)
    return (await import('./zip-input.js')).openZipArchive(source, report);
  if (cartridgeNames.test(name)) {
    if (/\.gba$/i.test(name))
      return (await import('./gba-cartridge.js')).openGbaCartridge(
        source,
        name,
      );
    if (/\.(gb|gbc|gbs)$/i.test(name)) {
      const { openGameBoy } = await import('./gameboy-files.js');
      return openGameBoy(source, name);
    }
    const { openCartridge } = await import('./cartridge-images.js');
    return openCartridge(source, name);
  }
  const header = await readAudio(source, 0, Math.min(128, source.size)),
    u8 = header.length >= 4 && new Bin(header).u32(0, false) === 0x55aa382d;
  if (header.length >= 4 && new Bin(header).str(0, 4) === 'CSAR')
    return {
      format: 'CSAR',
      entries: [{ path: name, kind: 'container', size: source.size, source }],
    };
  if (
    /\.(vab|vh)$/i.test(name) ||
    (header.length >= 4 && new Bin(header).str(0, 4) === 'pBAV')
  )
    return (await import('./audio-vab.js')).openVabBank(
      source,
      name,
      companions,
      report,
    );
  if (
    psfNames.test(name) ||
    (header[0] === 80 &&
      header[1] === 83 &&
      header[2] === 70 &&
      [1, 2].includes(header[3]))
  ) {
    const { readPsf } = await import('./psf.js');
    return readPsf(source, name, companions, report);
  }
  if (header.length >= 4 && new Bin(header).str(0, 4) === 'AFS2') {
    const archive = await (
      await import('./audio-archives.js')
    ).openAudioArchive(source, report);
    const selectedKeys = audioKeys(companions);
    for (const entry of archive.entries)
      if (entry.format && ['ADX', 'HCA'].includes(entry.format))
        entry.source = deferredAudioSource(entry.source, entry.format, {
          name: entry.path,
          archiveName: name,
          companions: selectedKeys,
          subkey: entry.subkey,
        });
    return archive;
  }
  if (wiiNames.test(name) || u8) {
    const { detectWiiImage, openWiiImage } = await import('./wii-images.js');
    if (await detectWiiImage(source, name))
      return openWiiImage(file, name, companions, report);
  }
  const direct = await audioAsset(source, name, header, {
    companions: audioKeys(companions),
  });
  if (!direct && discNames.test(name)) {
    const { openDiscImage } = await import('./disc-images.js');
    return openDiscImage(file, name, companions, report);
  }
  if (direct || audioNames.test(name) || isGameAudioFile(name))
    return {
      format: 'AUDIO',
      entries: [
        {
          path: 'audio/' + name.split(/[\\/]/).at(-1),
          kind: 'audio',
          size: direct?.size ?? source.size,
          source: direct?.source || source,
        },
      ],
    };
  return null;
}

async function audioAsset(
  source: ByteSource,
  name: string,
  header?: Uint8Array,
  options: DecoderOptions = {},
): Promise<AudioAsset | null> {
  if (source.size < 4) return null;
  const bytes =
    header || (await readAudio(source, 0, Math.min(128, source.size)));
  const magic = new Bin(bytes).str(0, 4);
  const { identifyGameAudio, createGameDecoder } =
    await import('./game-audio.js');
  if (nintendoAudio.has(magic)) {
    if (sourceAudioFormats.has(magic)) await createGameDecoder(source, magic);
    return {
      source,
      name,
      format: magic,
      size: source.size,
      gameAudio: sourceAudioFormats.has(magic),
    };
  }
  const info = await identifyGameAudio(source, name, bytes);
  if (info)
    source = await decryptAudioSource(source, info.format, {
      ...options,
      name,
    });
  if (info && !needsExportDuration({ kind: 'stream', format: info.format }))
    await createGameDecoder(source, info.format);
  return info
    ? {
        ...info,
        source,
        name: info.name || name,
        size: source.size,
        gameAudio: true,
      }
    : null;
}

async function rxwsAudio(
  source: ByteSource,
  name: string,
  companions: CompanionFile[],
  report: ProgressReporter,
): Promise<AudioImport> {
  const { readRxws, resolveRxwsBody } = await import('./audio-rxws.js');
  const current = () => report({ phase: 'scan', value: null });
  let bank: RxwsBank | null;
  try {
    bank = await readRxws(source, undefined, current);
  } catch (error) {
    if (errorCode(error) !== 'RXWS_COMPANION') throw error;
    bank = await readRxws(source, resolveRxwsBody(name, companions), current);
  }
  check(bank, 'INVALID_AUDIO');
  return {
    assets: bank.tracks.map((track) => ({
      source: track.source,
      name:
        name.replace(/\.[^./]+$/, '') +
        '/' +
        String(track.index + 1).padStart(5, '0') +
        '-' +
        track.name.replace(/[\\/\x00-\x1f]/g, '_') +
        '.xws',
      format: 'RXWS',
      size: track.source.size,
      gameAudio: true,
      playable: true,
    })),
    warnings: bank.diagnostics,
  };
}

export async function readPlatformAudio(
  file: SourceInput,
  name: string,
  companions: CompanionFile[] = [],
  notify: ProgressReporter = () => {},
  importDepth = 0,
): Promise<AudioImport | null> {
  check(importDepth <= 8, 'DEPTH');
  let reportProgress: ProgressReporter = (progress) =>
    notify({ ...progress, value: null, detail: name });
  const report: ProgressReporter = (progress) => reportProgress(progress);
  const source = asSource(file);
  if (/\.(gb|gbc)$/i.test(name)) {
    const { readGameBoyCartridgeHeader } =
      await import('./gameboy-cartridge.js');
    const header = await readGameBoyCartridgeHeader(source);
    return {
      assets: [
        {
          source,
          name,
          format: header.colorCompatible ? 'GBC' : 'GB',
          size: source.size,
          kind: 'sequence',
          gameAudio: true,
          playable: true,
        },
      ],
      warnings: [],
    };
  }
  if (/\.gba$/i.test(name)) {
    return (await import('./gba-audio.js')).readGbaAudio(source, name, report);
  }
  if (/\.(sfc|smc|swc|fig)$/i.test(name)) {
    const { extractSnesAudio } = await import('./snes-extract.js');
    return extractSnesAudio(source, name, report);
  }
  const header = await readAudio(source, 0, Math.min(128, source.size));
  if (header.length >= 4 && new Bin(header).str(0, 4) === 'CSEQ')
    return (await import('./cseq-archive.js')).readCseqAudio(
      source,
      name,
      companions,
      report,
    );
  if (header.length >= 4 && new Bin(header).str(0, 4) === 'pQES')
    return (await import('./sony-audio.js')).readSonyAudio(
      source,
      name,
      companions,
      report,
    );
  if (header.length >= 4 && new Bin(header).str(0, 4) === 'RXWS')
    return rxwsAudio(source, name, companions, report);
  if (
    /\.pss$/i.test(name) ||
    (header.length >= 4 && new Bin(header).u32(0, false) === 0x1ba)
  )
    return (await import('./audio-pss.js')).extractPssAudio(
      source,
      name,
      report,
    );
  if (
    psfNames.test(name) ||
    (header[0] === 80 &&
      header[1] === 83 &&
      header[2] === 70 &&
      [1, 2].includes(header[3]))
  ) {
    const { readPsf } = await import('./psf.js');
    const psf = await readPsf(source, name, companions, report);
    return {
      assets: [
        {
          source,
          name,
          format: psf.format,
          size: source.size,
          gameAudio: true,
          psf,
        },
      ],
      warnings: [],
    };
  }
  const direct = await audioAsset(source, name, header, {
    companions: audioKeys(companions),
  });
  if (direct && ['XA', 'XA2336'].includes(direct.format))
    return (await import('./xa-audio.js')).readXaAudio(
      direct.source,
      name,
      report,
      direct.format === 'XA' ? 2352 : 2336,
    );
  if (direct?.format === 'GBS') {
    const { readGbsHeader } = await import('./gameboy-files.js');
    const header = await readGbsHeader(source);
    return {
      assets: Array.from({ length: header.songs }, (_, song) => ({
        ...direct,
        song,
        name:
          (header.title || name.replace(/\.[^.]+$/, '')) +
          ' · ' +
          String(song + 1).padStart(2, '0'),
      })),
      warnings: [],
    };
  }
  if (direct) return { assets: [direct], warnings: [] };
  let archive: Archive | null;
  if (ndsNames.test(name)) {
    const { openNdsContents } = await import('./nds-contents.js');
    archive = await openNdsContents(source, report);
  } else if (ctrNames.test(name)) {
    const { openContents } = await import('./content-browser.js');
    archive = await openContents(source, name, undefined, report, companions);
  } else {
    try {
      archive = await openPlatformContents(file, name, companions, report);
    } catch (error) {
      if (!/\.bin$/i.test(name) || errorCode(error) !== 'INVALID_ISO')
        throw error;
      archive = null;
    }
  }
  if (!archive) {
    const { isXaSector } = await import('./audio-xa.js');
    let cdAudio: ArchiveEntry['cdAudio'];
    if (source.size % 2352 === 0 && isXaSector(header))
      cdAudio = { source, sectorSize: 2352 };
    archive = {
      format: '',
      entries: [
        { path: name, kind: 'container', size: source.size, source, cdAudio },
      ],
    };
  }
  const selectedArchive = archive;
  const assets: AudioAsset[] = [];
  const warnings: Diagnostic[] = [];
  const cseqIdentities = new Set<string>();
  const cseqOriginals = new Map<string, AudioAsset[]>();
  const originalResources = (asset: AudioAsset) =>
    (asset.dependencies ?? [])
      .filter(
        (file) =>
          file.source !== asset.source && !/\.(?:bcseq|cseq)$/i.test(file.name),
      )
      .sort((left, right) => left.name.localeCompare(right.name));
  const appendAssets = (items: readonly AudioAsset[]) => {
    for (const item of items) {
      const identity = item.cseq?.identity;
      if (identity && cseqIdentities.has(identity)) continue;
      if (identity) cseqIdentities.add(identity);
      if (item.format === 'CSEQ' && !item.playable) {
        const resources = originalResources(item);
        if (resources.some((file) => /\.(?:bcsar|csar)$/i.test(file.name))) {
          const key = item.name.replaceAll('\\', '/').toLowerCase();
          const originals = cseqOriginals.get(key) ?? [];
          if (
            originals.some((previous) => {
              if (previous.size !== item.size || previous.song !== item.song)
                return false;
              const previousResources = originalResources(previous);
              return (
                previousResources.length === resources.length &&
                previousResources.every((file, index) => {
                  const other = resources[index];
                  return (
                    other?.name === file.name &&
                    other.size === file.size &&
                    other.source === file.source
                  );
                })
              );
            })
          )
            continue;
          originals.push(item);
          cseqOriginals.set(key, originals);
        }
      }
      assets.push(item);
      check(assets.length <= 20000, 'TOO_MANY');
    }
  };
  let progressStart = 0;
  let progressEnd = 1;
  let completed = 0;
  const progress = (value: number) => {
    completed = Math.max(completed, Math.min(1, value));
    notify({
      phase: 'scan',
      value: completed,
      count: assets.length,
      detail: name,
    });
  };
  const companionsForAudio = audioKeys(companions);
  let visited = 0,
    pathCharacters = 0;
  const cleanups: (() => Promise<void>)[] = selectedArchive.dispose
    ? [selectedArchive.dispose]
    : [];
  const dispose = async () => {
    const results = await Promise.allSettled(
      cleanups.map((cleanup) => cleanup()),
    );
    for (const result of results)
      if (result.status === 'rejected') throw result.reason;
  };
  try {
    const referenced = new Set<string>();
    const canonical = (path: string) => {
      const parts: string[] = [];
      for (const part of path.replaceAll('\\', '/').split('/')) {
        if (part === '..') parts.pop();
        else if (part && part !== '.') parts.push(part);
      }
      return parts.join('/').toLowerCase();
    };
    if (selectedArchive.format === 'ZIP') {
      for (const cue of selectedArchive.entries.filter((entry) =>
        /\.cue$/i.test(entry.path),
      )) {
        check(cue.size <= 65536, 'INVALID_CUE');
        const text = new TextDecoder().decode(
          await readAudio(cue.source, 0, cue.size),
        );
        const directory = cue.path.slice(0, cue.path.lastIndexOf('/') + 1);
        for (const match of text.matchAll(
          /^\s*FILE\s+(?:"([^"]+)"|(\S+))\s+(?:BINARY|MOTOROLA)\s*$/gim,
        ))
          referenced.add(canonical(directory + (match[1] || match[2])));
      }
    }

    async function visitVabBank(
      source: ByteSource,
      path: string,
      companions: CompanionFile[],
      depth: number,
    ) {
      const bank = await (
        await import('./audio-vab.js')
      ).openVabBank(source, path, companions, report);
      await visit(
        bank.entries
          .filter((entry) => entry.format === 'VAG')
          .map((entry) => ({
            ...entry,
            kind: 'sample',
            path: path + '/' + entry.path,
          })),
        depth + 1,
      );
    }

    async function visitCseqArchive(
      source: ByteSource,
      path: string,
      resources: CompanionFile[],
      depth: number,
    ) {
      check(depth <= 8, 'DEPTH');
      let resolved = false;
      try {
        const nested = await (
          await import('./cseq-archive.js')
        ).readCseqArchive(source, path, resources, report);
        appendAssets(nested.assets);
        check(assets.length <= 20000, 'TOO_MANY');
        warnings.push(...nested.warnings);
        if (nested.dispose) cleanups.push(nested.dispose);
        resolved = true;
      } catch (error) {
        if (
          isFileReadError(error) ||
          ['CANCELLED', 'TOO_MANY', 'TOO_LARGE', 'DEPTH'].includes(
            errorCode(error),
          )
        )
          throw error;
        warnings.push({
          code: errorCode(error),
          detail: path + ': ' + errorDetail(error),
        });
      }
      await scanArchive(source, path, depth, resolved);
    }

    async function visit(
      entries: ArchiveEntry[],
      depth: number,
    ): Promise<void> {
      check(depth <= 8, 'DEPTH');
      companionsForAudio.push(...audioKeys(entries));
      try {
        const native = await (
          await import('./ps-heartbeat.js')
        ).readHeartbeatAudio(entries, report);
        if (native) {
          appendAssets(native.assets);
          warnings.push(...native.warnings);
          check(assets.length <= 20000, 'TOO_MANY');
        }
      } catch (error) {
        if (
          isFileReadError(error) ||
          ['CANCELLED', 'TOO_MANY', 'TOO_LARGE', 'DEPTH'].includes(
            errorCode(error),
          )
        )
          throw error;
        warnings.push({ code: errorCode(error), detail: errorDetail(error) });
      }
      const from = progressStart;
      const span = progressEnd - from;
      for (let index = 0; index < entries.length; index++) {
        const entry = entries[index];
        const previousReport = reportProgress;
        const previousStart = progressStart;
        const previousEnd = progressEnd;
        const start = from + (span * index) / entries.length;
        const end = from + (span * (index + 1)) / entries.length;
        progressStart = start;
        progressEnd = end;
        reportProgress = (update) => {
          const fraction =
            update.phase === 'scan' &&
            update.detail === entry.path &&
            typeof update.value === 'number'
              ? Math.max(0, Math.min(1, update.value))
              : 0;
          progress(start + (end - start) * fraction);
        };
        try {
          if (entry.kind === 'directory' || !entry.size) continue;
          if (
            selectedArchive.format === 'ZIP' &&
            depth === importDepth &&
            referenced.has(canonical(entry.path))
          )
            continue;
          if (
            /\.(psflib|psf2lib|adxkey|hcakey|vb)$/i.test(entry.path) ||
            ['VAB_HEADER', 'VAB_BODY'].includes(entry.format || '')
          )
            continue;
          check(++visited <= 200000, 'TOO_MANY');
          pathCharacters += entry.path.length;
          if ((visited & 127) === 0) {
            report({ phase: 'scan', value: null });
            await new Promise((resolve) => setTimeout(resolve, 0));
          }
          check(
            entry.path.length <= 4096 && pathCharacters <= 16 * 1024 ** 2,
            'TOO_LARGE',
            'Audio discovery paths',
          );
          try {
            if (
              entry.cdAudio ||
              ['XA', 'XA2336', 'MODE2/2336'].includes(entry.format || '')
            ) {
              const nested = await (
                await import('./xa-audio.js')
              ).readXaAudio(
                entry.cdAudio?.source ?? entry.source,
                entry.path,
                report,
                entry.cdAudio?.sectorSize ??
                  (entry.format === 'XA' ? 2352 : 2336),
              );
              appendAssets(nested.assets);
              warnings.push(...nested.warnings);
              if (entry.format?.startsWith('XA')) continue;
            }
            if (
              selectedArchive.format === 'ZIP' &&
              depth === importDepth &&
              (isPlatformFile(entry.path) || /\.(zip|pss)$/i.test(entry.path))
            ) {
              const nested = await readPlatformAudio(
                entry.source,
                entry.path,
                entries,
                report,
                depth + 1,
              );
              if (nested) {
                if (nested.dispose) cleanups.push(nested.dispose);
                check(
                  assets.length + nested.assets.length <= 20000,
                  'TOO_MANY',
                );
                appendAssets(nested.assets);
                warnings.push(...nested.warnings);
                continue;
              }
            }
            const header = await readAudio(
                entry.source,
                0,
                Math.min(128, entry.size),
              ),
              magic = header.length >= 4 ? new Bin(header).str(0, 4) : '';
            if (magic === 'CSAR') {
              await visitCseqArchive(
                entry.source,
                entry.path,
                [...companions, ...entries],
                depth,
              );
              continue;
            }
            if (magic === 'CSEQ') {
              const nested = await (
                await import('./cseq-archive.js')
              ).readCseqAudio(
                entry.source,
                entry.path,
                [...companions, ...entries],
                report,
              );
              appendAssets(nested.assets);
              check(assets.length <= 20000, 'TOO_MANY');
              warnings.push(...nested.warnings);
              continue;
            }
            if (magic === 'RXWS') {
              const nested = await rxwsAudio(
                entry.source,
                entry.path,
                entries,
                report,
              );
              check(assets.length + nested.assets.length <= 20000, 'TOO_MANY');
              appendAssets(nested.assets);
              warnings.push(...nested.warnings);
              continue;
            }
            if (magic === 'pQES') {
              const nested = await (
                await import('./sony-audio.js')
              ).readSonyAudio(entry.source, entry.path, entries, report);
              check(assets.length + nested.assets.length <= 20000, 'TOO_MANY');
              appendAssets(nested.assets);
              warnings.push(...nested.warnings);
              continue;
            }
            if (/\.(gb|gbc)$/i.test(entry.path)) {
              const nested = await readPlatformAudio(
                entry.source,
                entry.path,
                entries,
                report,
                depth + 1,
              );
              check(nested, 'INVALID_AUDIO');
              check(assets.length + nested.assets.length <= 20000, 'TOO_MANY');
              appendAssets(nested.assets);
              warnings.push(...nested.warnings);
              continue;
            }
            if (
              /\.pss$/i.test(entry.path) ||
              (header.length >= 4 && new Bin(header).u32(0, false) === 0x1ba)
            ) {
              const nested = await (
                await import('./audio-pss.js')
              ).extractPssAudio(entry.source, entry.path, report);
              if (nested) {
                check(
                  assets.length + nested.assets.length <= 20000,
                  'TOO_MANY',
                );
                appendAssets(nested.assets);
                warnings.push(...nested.warnings);
                continue;
              }
            }
            if (magic === 'pBAV') {
              await visitVabBank(entry.source, entry.path, entries, depth);
              continue;
            }
            if (
              selectedArchive.format === 'CIA' &&
              entry.kind === 'container' &&
              /\.bin$/i.test(entry.path) &&
              header.length >= 80 &&
              new Bin(header).u32(72) > 0 &&
              new Bin(header).u32(76) > 0
            ) {
              const { openNdsContents } = await import('./nds-contents.js');
              const nested = await openNdsContents(entry.source, report);
              await visit(
                nested.entries.map((child) => ({
                  ...child,
                  path: entry.path + '/' + child.path,
                })),
                depth + 1,
              );
              continue;
            }
            if (
              depth === 0 &&
              selectedArchive.format === 'WAD' &&
              /\.app$/i.test(entry.path) &&
              header.length >= 4 &&
              new Bin(header).u32(0, false) === 0x55aa382d
            )
              continue;
            const asset = await audioAsset(entry.source, entry.path, header, {
              companions: companionsForAudio,
              subkey: entry.subkey ?? 0,
            });
            if (asset) {
              if (selectedArchive.format === 'VAB' || entry.kind === 'sample')
                asset.kind = 'sample';
              if (['PSF', 'PSF2'].includes(asset.format)) {
                const { readPsf } = await import('./psf.js');
                asset.psf = await readPsf(
                  entry.source,
                  entry.path,
                  selectedArchive.entries,
                  report,
                );
              }
              assets.push(asset);
            } else if (
              magic === 'AFS2' ||
              magic === 'PK\u0003\u0004' ||
              /\.(arc|u8)$/i.test(entry.path) ||
              (header.length >= 4 &&
                new Bin(header).u32(0, false) === 0x55aa382d)
            ) {
              const nested = await openPlatformContents(
                entry.source,
                entry.path,
                companionsForAudio,
                report,
              );
              if (nested) {
                if (nested.dispose) cleanups.push(nested.dispose);
                await visit(
                  nested.entries.map((child) => ({
                    ...child,
                    path: entry.path + '/' + child.path,
                  })),
                  depth + 1,
                );
              }
            } else if (!(
              entry.kind === 'container' && /\.ncch$/i.test(entry.path)
            ))
              await scanArchive(entry.source, entry.path, depth);
          } catch (error) {
            if (
              isFileReadError(error) ||
              ['CANCELLED', 'TOO_MANY', 'DEPTH'].includes(errorCode(error)) ||
              errorDetail(error) === 'Audio discovery paths'
            )
              throw error;
            warnings.push({
              code: errorCode(error) || 'INVALID_AUDIO',
              detail:
                entry.path +
                (errorDetail(error) ? ': ' + errorDetail(error) : ''),
            });
          }
          check(assets.length <= 20000, 'TOO_MANY');
          if ((visited & 127) === 0) {
            report({ phase: 'scan', value: null });
            await new Promise((resolve) => setTimeout(resolve, 0));
          }
        } finally {
          reportProgress = previousReport;
          progressStart = previousStart;
          progressEnd = previousEnd;
          progress(end);
        }
      }
    }

    async function scanArchive(
      source: ByteSource,
      path: string,
      depth = 0,
      indexedSequences = false,
    ) {
      const { scanEmbeddedAudio } = await import('./embedded-audio.js');
      await scanEmbeddedAudio(
        source,
        async (candidate) => {
          if (indexedSequences && candidate.format === 'CSEQ') return true;
          if (candidate.format === 'CSAR' && candidate.offset === 0)
            return false;
          const previousStart = progressStart;
          const previousEnd = progressEnd;
          const span = previousEnd - previousStart;
          progressStart =
            previousStart + (span * candidate.offset) / source.size;
          progressEnd =
            previousStart +
            (span * (candidate.offset + candidate.size)) / source.size;
          try {
            const name =
              path +
              '/' +
              candidate.offset.toString(16) +
              '.' +
              candidate.format.toLowerCase();
            const previous = assets.length;
            const checkpoint: ProgressReporter = () =>
              report({ phase: 'scan', value: null });
            if (candidate.format === 'CSAR') {
              await visitCseqArchive(
                candidate.source,
                name,
                [...companions, ...selectedArchive.entries],
                depth + 1,
              );
            } else if (candidate.format === 'CSEQ') {
              const nested = await (
                await import('./cseq-archive.js')
              ).readCseqAudio(
                candidate.source,
                name,
                [...companions, ...selectedArchive.entries],
                checkpoint,
              );
              appendAssets(nested.assets);
              warnings.push(...nested.warnings);
            } else if (['SEQ', 'SEP'].includes(candidate.format)) {
              const nested = await (
                await import('./sony-audio.js')
              ).readSonyAudio(
                candidate.source,
                name,
                [...companions, ...selectedArchive.entries],
                checkpoint,
              );
              appendAssets(nested.assets);
              warnings.push(...nested.warnings);
            } else if (candidate.format === 'RXWS') {
              const nested = await rxwsAudio(
                candidate.source,
                name,
                [],
                checkpoint,
              );
              appendAssets(nested.assets);
              warnings.push(...nested.warnings);
            } else if (candidate.format === 'VAB') {
              await visitVabBank(candidate.source, name, [], depth);
            } else if (candidate.format === 'AFS2') {
              const nested = await openPlatformContents(
                candidate.source,
                name,
                companionsForAudio,
                checkpoint,
              );
              if (nested) {
                if (nested.dispose) cleanups.push(nested.dispose);
                await visit(
                  nested.entries.map((entry) => ({
                    ...entry,
                    path: name + '/' + entry.path,
                  })),
                  depth + 1,
                );
              }
            } else {
              if (nintendoAudio.has(candidate.format))
                await validateEmbedded(candidate.source, candidate.format);
              const asset = await audioAsset(
                candidate.source,
                name,
                undefined,
                {
                  companions: companionsForAudio,
                },
              );
              if (asset) assets.push(asset);
            }
            check(assets.length <= 20000, 'TOO_MANY');
            return assets.length > previous;
          } finally {
            progressStart = previousStart;
            progressEnd = previousEnd;
          }
        },
        (update) => report({ ...update, detail: path }),
      );
    }

    await visit(selectedArchive.entries, importDepth);
    const decisive = warnings.find((warning) =>
      ['ZIP_STORAGE', 'GBA_AUDIO_DRIVER', 'GBA_AUDIO_SAMPLES'].includes(
        warning.code,
      ),
    );
    progress(1);
    check(
      assets.length > 0,
      decisive?.code ??
        (cartridgeNames.test(name) ? 'NO_CARTRIDGE_AUDIO' : 'NO_AUDIO'),
      decisive?.detail ??
        warnings
          .slice(0, 8)
          .map((warning) => `${warning.detail ?? ''} (${warning.code})`)
          .join('\n'),
    );
    return { assets, warnings, ...(cleanups.length ? { dispose } : {}) };
  } catch (error) {
    await dispose();
    throw error;
  }
}

async function validateEmbedded(source: ByteSource, magic: string) {
  const header = new Bin(
      await readAudio(source, 0, Math.min(128, source.size)),
    ),
    littleEndian = header.u16(4) === 0xfeff,
    modern = /^[CF]/.test(magic),
    headerSize = header.u16(modern ? 6 : 12, littleEndian),
    sectionCount = header.u16(modern ? 16 : 14, littleEndian);
  check(
    sectionCount > 0 &&
      sectionCount <= 16 &&
      headerSize >= 16 &&
      headerSize <= source.size,
    'INVALID_AUDIO',
  );
  if (sourceAudioFormats.has(magic)) return;
  if (magic === 'SDAT') {
    check(
      sectionCount <= 4 && headerSize >= 16 + sectionCount * 8,
      'INVALID_AUDIO',
    );
    const sections = new Set<string>(),
      ranges: [number, number][] = [];
    for (let section = 0; section < sectionCount; section++) {
      const offset = header.u32(16 + section * 8, littleEndian),
        size = header.u32(20 + section * 8, littleEndian);
      if (!size) continue;
      check(offset >= headerSize && size >= 8, 'INVALID_AUDIO');
      const block = sliceSource(source, offset, size),
        bytes = new Bin(await readAudio(block, 0, 8)),
        tag = bytes.str(0, 4),
        storedSize = bytes.u32(4, littleEndian);
      check(
        ['SYMB', 'INFO', 'FAT ', 'FILE'].includes(tag) &&
          !sections.has(tag) &&
          (storedSize === size || storedSize === Math.ceil(size / 4) * 4) &&
          storedSize <= source.size - offset,
        'INVALID_AUDIO',
      );
      sections.add(tag);
      ranges.push([offset, storedSize]);
    }
    check(
      ['INFO', 'FAT ', 'FILE'].every((section) => sections.has(section)),
      'INVALID_AUDIO',
    );
    ranges.sort((left, right) => left[0] - right[0]);
    for (let index = 1; index < ranges.length; index++)
      check(
        ranges[index - 1][0] + ranges[index - 1][1] <= ranges[index][0],
        'INVALID_AUDIO',
      );
  } else {
    const block = new Bin(await readAudio(source, headerSize, 8)),
      size = block.u32(4, littleEndian);
    check(
      ['DATA', 'HEAD'].includes(block.str(0, 4)) &&
        size >= 8 &&
        size <= source.size - headerSize,
      'INVALID_AUDIO',
    );
  }
}
import { isFileReadError } from './errors.js';
