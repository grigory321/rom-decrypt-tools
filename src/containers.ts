import type {
  ByteSource,
  SourceInput,
  ProgressReporter,
  KeySet,
  Diagnostic,
  AudioAsset,
  AudioImport,
} from './contracts.js';
import { asSource } from './source-input.js';
import { errorCode, errorDetail } from './container-errors.js';
import { Bin, sliceSource, check, align, FormatError } from './binary.js';
import {
  cbcSource,
  ctrSource,
  ciaTitleKey,
  ncchKey,
  ncchCounter,
  signatureBody,
  sha256,
  sourceHash,
  hex,
} from './crypto.js';

const MAX_ASSET = 128 * 1024 * 1024;

const AUDIO = new Set([
  'SDAT',
  'SWAV',
  'STRM',
  'CWAV',
  'CSTM',
  'FWAV',
  'FSTM',
  'SSEQ',
  'CSEQ',
  'FSEQ',
]);

const SEARCH = new Set([...AUDIO, 'CWAR', 'FWAR', 'CSAR', 'FSAR', 'NARC']);

export async function readSource(
  blob: SourceInput,
  name: string,
  keys: KeySet = {},
  report: ProgressReporter = () => {},
): Promise<AudioImport> {
  const assets: AudioAsset[] = [],
    warnings: Diagnostic[] = [];
  let examined = 0;
  const notice = (code: string, detail = '') =>
    warnings.push({
      code,
      detail,
    });
  function asset(source: ByteSource, path: string, format: string) {
    check(assets.length < 2e4, 'TOO_MANY');
    assets.push({
      source,
      name: path,
      format,
      size: source.size,
    });
  }
  async function scan(source: ByteSource, path: string) {
    const first = await source.read(0, Math.min(source.size, 32));
    if (first.length < 4) {
      return;
    }
    const magic = new Bin(first).str(0, 4);
    if (AUDIO.has(magic)) {
      asset(source, path, magic);
      return;
    }
    if (!SEARCH.has(magic) && !/\.(bin|bcgrp|bcsar|bcwar|romfs)$/i.test(path)) {
      return;
    }
    for (let off = 0; off < source.size; off += 1024 * 1024) {
      const data = await source.read(
          off,
          Math.min(1024 * 1024 + 32, source.size - off),
        ),
        b = new Bin(data);
      for (let i = 0; i + 20 <= data.length && i < 1024 * 1024; i++) {
        if (![67, 70, 83].includes(data[i])) {
          continue;
        }
        const m = b.str(i, 4);
        if (!AUDIO.has(m)) {
          continue;
        }
        const le = b.u16(i + 4) !== 65534;
        const len = b.u32(i + (m[0] === 'C' || m[0] === 'F' ? 12 : 8), le);
        if (len < 32 || len > MAX_ASSET || off + i + len > source.size) {
          continue;
        }
        asset(
          sliceSource(source, off + i, len),
          path + '/audio_' + (off + i).toString(16) + '.' + m.toLowerCase(),
          m,
        );
        i += len - 1;
      }
      report({
        phase: 'scan',
        value: (off + data.length) / source.size,
      });
    }
  }
  async function nds(src: ByteSource, path: string) {
    const h = new Bin(await src.read(0, 512)),
      fatOff = h.u32(72),
      fatLen = h.u32(76),
      fntOff = h.u32(64),
      fntLen = h.u32(68);
    check(
      fatLen <= 16 * 1024 * 1024 &&
        fatLen % 8 === 0 &&
        fntLen <= 16 * 1024 * 1024,
      'INVALID_NDS',
    );
    const fat = new Bin(await src.read(fatOff, fatLen)),
      fnt = new Bin(await src.read(fntOff, fntLen));
    const names = new Map<number, string>(),
      visited = new Set<number>();
    function walk(id: number, prefix: string, depth = 0): void {
      check(depth < 64, 'DEPTH');
      if (visited.has(id)) {
        return;
      }
      visited.add(id);
      const entry = (id & 4095) * 8;
      let pos = fnt.u32(entry),
        file = fnt.u16(entry + 4);
      check(visited.size <= 4096, 'TOO_MANY');
      for (let count = 0; count < 65536; count++) {
        const n = fnt.u8(pos++);
        if (!n) {
          return;
        }
        const len = n & 127;
        const part = new TextDecoder().decode(fnt.slice(pos, len));
        pos += len;
        if (n & 128) {
          const child = fnt.u16(pos);
          pos += 2;
          walk(child, prefix + part + '/', depth + 1);
        } else {
          names.set(file++, prefix + part);
        }
      }
      check(false, 'TOO_MANY');
    }
    if (fntLen >= 8) {
      walk(61440, '');
    }
    for (let i = 0; i < fatLen / 8; i++) {
      const start = fat.u32(i * 8),
        end = fat.u32(i * 8 + 4);
      check(end >= start, 'INVALID_NDS');
      if (end === start) {
        continue;
      }
      await scan(
        sliceSource(src, start, end - start),
        path + '/' + (names.get(i) || 'file_' + i + '.bin'),
      );
      if ((i & 63) === 0) {
        report({
          phase: 'index',
          value: i / (fatLen / 8),
        });
      }
    }
  }
  async function romfs(src: ByteSource, path: string) {
    const h = new Bin(await src.read(0, Math.min(src.size, 96)));
    let level = 0;
    if (h.str(0, 4) === 'IVFC') {
      const log = h.u32(76);
      check(log >= 9 && log <= 20, 'INVALID_ROMFS');
      level = align(96 + h.u32(8), 2 ** log);
    }
    const head = new Bin(await src.read(level, 40));
    check(head.u32(0) === 40, 'INVALID_ROMFS');
    const dirOff = head.u32(12),
      dirSize = head.u32(16),
      fileOff = head.u32(28),
      fileSize = head.u32(32),
      dataOff = head.u32(36);
    check(
      dirSize <= 16 * 1024 * 1024 && fileSize <= 32 * 1024 * 1024,
      'TOO_LARGE',
    );
    const dir = new Bin(await src.read(level + dirOff, dirSize)),
      files = new Bin(await src.read(level + fileOff, fileSize)),
      seenDir = new Set<number>(),
      seenFile = new Set<number>();
    const name = (b: Bin, o: number, n: number) => {
      check(n <= 2048 && n % 2 === 0, 'INVALID_ROMFS');
      return new TextDecoder('utf-16le').decode(b.slice(o, n));
    };
    async function walk(o: number, prefix: string, depth = 0): Promise<void> {
      check(depth < 64 && !seenDir.has(o), 'INVALID_ROMFS');
      seenDir.add(o);
      check(seenDir.size < 1e5, 'TOO_MANY');
      const own = name(dir, o + 24, dir.u32(o + 20)),
        p = prefix + (own ? own + '/' : '');
      let file = dir.u32(o + 12);
      while (file !== 4294967295) {
        check(!seenFile.has(file), 'INVALID_ROMFS');
        seenFile.add(file);
        check(seenFile.size <= 1e5, 'TOO_MANY');
        const size = files.u64(file + 16),
          offset = files.u64(file + 8),
          n = name(files, file + 32, files.u32(file + 28));
        if (size) {
          await scan(
            sliceSource(src, level + dataOff + offset, size),
            path + '/' + p + n,
          );
        }
        file = files.u32(file + 4);
        if ((++examined & 31) === 0) {
          report({
            phase: 'index',
            value: null,
            count: examined,
          });
        }
      }
      let child = dir.u32(o + 8);
      while (child !== 4294967295) {
        await walk(child, p, depth + 1);
        child = dir.u32(child + 4);
      }
    }
    await walk(0, '');
  }
  async function ncch(src: ByteSource, path: string) {
    const h = await src.read(0, 512),
      b = new Bin(h);
    check(b.str(256, 4) === 'NCCH', 'WRONG_KEY');
    const clear = !!(b.u8(399) & 4);
    const romOff = b.u32(432) * 512,
      romSize = b.u32(436) * 512;
    if (romSize) {
      let r = sliceSource(src, romOff, romSize);
      if (!clear) {
        report({
          phase: 'decrypt',
          value: null,
        });
        r = ctrSource(
          r,
          await ncchKey(h, keys, true),
          ncchCounter(h, 3, romOff),
        );
        const hashLen = b.u32(440) * 512;
        check(hashLen <= 1024 * 1024 && hashLen <= r.size, 'INVALID_NCCH');
        if (hashLen) {
          const digest = await sha256(await r.read(0, hashLen));
          check(hex(digest) === hex(b.slice(480, 32)), 'WRONG_KEY');
        } else {
          check(new Bin(await r.read(0, 4)).str(0, 4) === 'IVFC', 'WRONG_KEY');
        }
      }
      await romfs(r, path + '/romfs');
    }
    const exeOff = b.u32(416) * 512,
      exeSize = b.u32(420) * 512;
    if (exeSize) {
      let e = sliceSource(src, exeOff, exeSize);
      if (!clear) {
        try {
          e = ctrSource(
            e,
            await ncchKey(h, keys, false),
            ncchCounter(h, 2, exeOff),
          );
        } catch (err) {
          if (isFileReadError(err)) throw err;
          if (romSize) {
            notice(errorCode(err), errorDetail(err));
            return;
          }
          throw err;
        }
      }
      const eh = new Bin(await e.read(0, 512));
      for (let i = 0; i < 10; i++) {
        if (eh.str(i * 16, 8).replace(/\0/g, '') !== 'banner') {
          continue;
        }
        const o = eh.u32(i * 16 + 8) + 512,
          n = eh.u32(i * 16 + 12);
        await scan(sliceSource(e, o, n), path + '/banner.bin');
      }
    }
  }
  async function cia(src: ByteSource, path: string) {
    const h = new Bin(await src.read(0, 8224));
    check(h.u32(0) === 8224, 'INVALID_CIA');
    const cert = align(8224),
      ticketOff = cert + align(h.u32(8)),
      ticketSize = h.u32(12),
      tmdOff = ticketOff + align(ticketSize),
      tmdSize = h.u32(16),
      contentOff = tmdOff + align(tmdSize);
    check(
      ticketSize <= 1024 * 1024 && tmdSize <= 16 * 1024 * 1024,
      'INVALID_CIA',
    );
    const tmdBytes = await src.read(tmdOff, tmdSize),
      t = new Bin(tmdBytes),
      base = signatureBody(tmdBytes),
      count = t.u16(base + 158, false);
    let pos = contentOff,
      titleKey: Uint8Array | undefined;
    for (let i = 0; i < count; i++) {
      const r = base + 2500 + i * 48,
        index = t.u16(r + 4, false),
        encrypted = !!(t.u16(r + 6, false) & 1),
        size = t.u64(r + 8, false);
      if (!(h.u8(32 + (index >> 3)) & (128 >> (index & 7)))) {
        continue;
      }
      let c = sliceSource(src, pos, size);
      pos += size;
      if (encrypted) {
        if (!titleKey) {
          titleKey = keys.titlekey;
          if (!titleKey) {
            titleKey = ciaTitleKey(await src.read(ticketOff, ticketSize), keys);
          }
        }
        const iv = new Uint8Array(16);
        new DataView(iv.buffer).setUint16(0, index, false);
        c = cbcSource(c, titleKey, iv);
      }
      check(
        hex(await sourceHash(c, report)) === hex(t.slice(r + 16, 32)),
        'CONTENT_HASH',
        String(index),
      );
      const tag = new Bin(await c.read(0, Math.min(size, 512)));
      if (size >= 512 && tag.str(256, 4) === 'NCCH') {
        await ncch(c, path + '/content_' + index);
      } else if (size >= 512 && tag.u32(72) > 0 && tag.u32(76) > 0) {
        await nds(c, path + '/content_' + index);
      } else if (encrypted) {
        throw new FormatError('WRONG_KEY');
      } else {
        notice('UNKNOWN_CONTENT', String(index));
      }
    }
  }
  const src = asSource(blob);
  check(src.size >= 32, 'INVALID');
  const h = new Bin(await src.read(0, Math.min(512, src.size))),
    magic = h.str(0, 4);
  if (h.b.length >= 512 && h.str(256, 4) === 'NCSD') {
    for (let i = 0; i < 8; i++) {
      const offset = h.u32(288 + i * 8) * 512,
        size = h.u32(292 + i * 8) * 512;
      if (!size) {
        continue;
      }
      try {
        await ncch(sliceSource(src, offset, size), name + '/partition_' + i);
      } catch (e) {
        if (isFileReadError(e)) throw e;
        if (!assets.length && i === 0) {
          throw e;
        }
        notice(errorCode(e), errorDetail(e));
      }
    }
  } else if (h.b.length >= 512 && h.str(256, 4) === 'NCCH') {
    await ncch(src, name);
  } else if (magic === 'IVFC') {
    await romfs(src, name);
  } else if (h.u32(0) === 8224 || /\.cia$/i.test(name)) {
    await cia(src, name);
  } else if (/\.(nds|srl)$/i.test(name)) {
    await nds(src, name);
  } else {
    await scan(src, name);
  }
  check(assets.length > 0, 'NO_AUDIO');
  return {
    assets,
    warnings,
  };
}
import { isFileReadError } from './errors.js';
