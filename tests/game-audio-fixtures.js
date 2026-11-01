const writeText = (bytes, offset, value) =>
  bytes.set(new TextEncoder().encode(value), offset);

export function memorySource(bytes, maxRead = 65536) {
  const reads = [];
  return {
    size: bytes.length,
    reads,
    async read(offset, length) {
      if (
        offset < 0 ||
        length < 0 ||
        offset + length > bytes.length ||
        length > maxRead
      )
        throw new Error('Unbounded audio source read');
      reads.push({ offset, length });
      return bytes.slice(offset, offset + length);
    },
  };
}

export function vagFixture() {
  const bytes = new Uint8Array(0x30 + 48),
    view = new DataView(bytes.buffer);
  writeText(bytes, 0, 'VAGp');
  view.setUint32(4, 0x20);
  view.setUint32(12, 48);
  view.setUint32(16, 22050);
  writeText(bytes, 32, 'Authored waveform');
  bytes.set([0x0c, 6, 0x21, 0x43, 0x65, 0x87], 48);
  bytes.set([0x1c, 2, 0x11, 0x11, 0x11, 0x11], 64);
  bytes.set([0x0c, 3, 0xfe, 0xdc], 80);
  return bytes;
}

export function dspFixture() {
  const bytes = new Uint8Array(0x70),
    view = new DataView(bytes.buffer);
  view.setUint32(0, 28);
  view.setUint32(4, 32);
  view.setUint32(8, 32000);
  view.setUint16(12, 1);
  view.setUint32(16, 2);
  view.setUint32(20, 31);
  view.setUint32(24, 2);
  view.setInt16(28, 2048);
  view.setInt16(64, 100);
  bytes.set([0x00, 0x12, 0x34, 0x56, 0x78, 0x9a, 0xbc, 0xde], 0x60);
  bytes.set([0x00, 0x12, 0x34, 0x56, 0x78, 0x9a, 0xbc, 0xde], 0x68);
  return bytes;
}

export function brstmFixture(codec = 2) {
  const bytes = new Uint8Array(0x240),
    view = new DataView(bytes.buffer),
    head = 0x40,
    info = 0x60;
  writeText(bytes, 0, 'RSTM');
  view.setUint16(4, 0xfeff);
  view.setUint16(6, 0x100);
  view.setUint32(8, bytes.length);
  view.setUint16(12, 0x40);
  view.setUint16(14, 3);
  view.setUint32(16, head);
  view.setUint32(20, 0x180);
  view.setUint32(24, 0x1c0);
  view.setUint32(28, 0x40);
  view.setUint32(32, 0x200);
  view.setUint32(36, 0x40);
  writeText(bytes, head, 'HEAD');
  view.setUint32(head + 4, 0x180);
  view.setUint32(head + 12, info - head - 8);
  view.setUint32(head + 28, 0x70);
  bytes[info] = codec;
  bytes[info + 1] = 1;
  bytes[info + 2] = 2;
  view.setUint16(info + 4, 32000);
  view.setUint32(info + 8, 14);
  view.setUint32(info + 12, 28);
  view.setUint32(info + 16, 0x220);
  view.setUint32(info + 20, 2);
  view.setUint32(info + 24, 8);
  view.setUint32(info + 28, 14);
  view.setUint32(info + 32, 8);
  view.setUint32(info + 36, 14);
  view.setUint32(info + 40, 8);
  bytes[head + 0x78] = 2;
  for (let channel = 0; channel < 2; channel++) {
    const definition = head + 0x8c + channel * 0x38,
      state = definition + 8;
    view.setUint32(head + 0x7c + channel * 8, 0x01000000);
    view.setUint32(head + 0x80 + channel * 8, definition - head - 8);
    view.setInt16(state, 2048);
    view.setInt16(state + 36, channel ? -100 : 100);
  }
  writeText(bytes, 0x200, 'DATA');
  view.setUint32(0x204, 0x40);
  writeText(bytes, 0x1c0, 'ADPC');
  view.setUint32(0x1c4, 0x40);
  for (let block = 0; block < 2; block++) {
    view.setInt16(0x1c8 + block * 8, 100 + block * 14);
    view.setInt16(0x1ca + block * 8, 99 + block * 14);
    view.setInt16(0x1cc + block * 8, -100 - block * 14);
    view.setInt16(0x1ce + block * 8, -99 - block * 14);
  }
  for (let block = 0; block < 2; block++) {
    bytes.set(
      [0, 0x11, 0x11, 0x11, 0x11, 0x11, 0x11, 0x11],
      0x220 + block * 16,
    );
    bytes.set(
      [0, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff],
      0x228 + block * 16,
    );
  }
  return bytes;
}

export function rwavFixture(codec = 2) {
  const bytes = new Uint8Array(0x110),
    view = new DataView(bytes.buffer),
    info = 0x28;
  writeText(bytes, 0, 'RWAV');
  view.setUint16(4, 0xfeff);
  view.setUint16(6, 0x102);
  view.setUint32(8, bytes.length);
  view.setUint16(12, 0x20);
  view.setUint16(14, 2);
  view.setUint32(16, 0x20);
  view.setUint32(20, 0xc0);
  view.setUint32(24, 0xe0);
  view.setUint32(28, 0x30);
  writeText(bytes, 0x20, 'INFO');
  view.setUint32(0x24, 0xc0);
  bytes[info] = codec;
  bytes[info + 1] = 1;
  bytes[info + 2] = 1;
  view.setUint16(info + 4, 32000);
  view.setUint32(info + 8, codec === 2 ? 2 : 0);
  view.setUint32(info + 12, codec === 2 ? 32 : 28);
  view.setUint32(info + 16, 0x1c);
  view.setUint32(info + 0x1c, 0x20);
  view.setUint32(info + 0x24, 0x40);
  view.setInt16(info + 0x40, 2048);
  view.setInt16(info + 0x40 + 36, 100);
  writeText(bytes, 0xe0, 'DATA');
  view.setUint32(0xe4, 0x30);
  bytes.set(
    [
      0, 0x11, 0x11, 0x11, 0x11, 0x11, 0x11, 0x11, 0, 0xff, 0xff, 0xff, 0xff,
      0xff, 0xff, 0xff,
    ],
    0xe8,
  );
  return bytes;
}

export function ss2Fixture(codec = 0x10) {
  const bytes = new Uint8Array(codec === 0x10 ? 0x68 : 0x38),
    view = new DataView(bytes.buffer);
  writeText(bytes, 0, 'SShd');
  view.setUint32(4, 0x18, true);
  view.setUint32(8, codec, true);
  view.setUint32(12, 24000, true);
  view.setUint32(16, 2, true);
  view.setUint32(20, codec === 0x10 ? 16 : 4, true);
  view.setUint32(24, 0xffffffff, true);
  view.setUint32(28, 0xffffffff, true);
  writeText(bytes, 32, 'SSbd');
  view.setUint32(36, bytes.length - 40, true);
  if (codec === 0x10) {
    bytes.set([12, 0, 0x21, 0x43], 40);
    bytes.set([12, 0, 0xfe, 0xdc], 56);
    bytes.set([12, 0, 0x65, 0x07], 72);
    bytes.set([12, 0, 0xba, 0x09], 88);
  } else {
    [1000, -1000, 2000, -2000, 3000, -3000, 4000, -4000].forEach(
      (value, index) => view.setInt16(40 + index * 2, value, true),
    );
  }
  return bytes;
}

export function wavFixture({
  format = 1,
  channels = 2,
  bits = 16,
  raw = new Uint8Array([0, 32, 0, 224, 0, 64, 0, 192]),
  blockAlign = (channels * bits) / 8,
  samplesPerBlock = 0,
  fact = null,
} = {}) {
  const fmtSize = samplesPerBlock ? 20 : 16,
    factSize = fact === null ? 0 : 12,
    offset = 20 + fmtSize + factSize + 8,
    bytes = new Uint8Array(offset + raw.length + (raw.length & 1)),
    view = new DataView(bytes.buffer);
  writeText(bytes, 0, 'RIFF');
  view.setUint32(4, bytes.length - 8, true);
  writeText(bytes, 8, 'WAVE');
  writeText(bytes, 12, 'fmt ');
  view.setUint32(16, fmtSize, true);
  view.setUint16(20, format, true);
  view.setUint16(22, channels, true);
  view.setUint32(24, 32000, true);
  view.setUint32(28, 64000, true);
  view.setUint16(32, blockAlign, true);
  view.setUint16(34, bits, true);
  if (samplesPerBlock) {
    view.setUint16(36, 2, true);
    view.setUint16(38, samplesPerBlock, true);
  }
  if (fact !== null) {
    writeText(bytes, 20 + fmtSize, 'fact');
    view.setUint32(24 + fmtSize, 4, true);
    view.setUint32(28 + fmtSize, fact, true);
  }
  writeText(bytes, offset - 8, 'data');
  view.setUint32(offset - 4, raw.length, true);
  bytes.set(raw, offset);
  return bytes;
}

export function spcFixture({ tagged = true, pitch = 0x1000 } = {}) {
  const bytes = new Uint8Array(0x10200),
    view = new DataView(bytes.buffer),
    ram = bytes.subarray(0x100, 0x10100),
    dsp = bytes.subarray(0x10100, 0x10180);
  writeText(bytes, 0, 'SNES-SPC700 Sound File Data v0.30');
  bytes[0x21] = 0x1a;
  bytes[0x22] = 0x1a;
  bytes[0x23] = tagged ? 26 : 27;
  bytes[0x24] = 30;
  view.setUint16(0x25, 0x200, true);
  bytes[0x2b] = 0xef;
  if (tagged) {
    writeText(bytes, 0x2e, 'Authored SPC700 BRR fixture');
    writeText(bytes, 0xa9, '001');
    writeText(bytes, 0xac, '00000');
  }
  ram.set([0x8f, 0x4c, 0xf2, 0x8f, 0x01, 0xf3, 0x2f, 0xfe], 0x200);
  ram[0x300] = 0;
  ram[0x301] = 4;
  ram[0x302] = 0;
  ram[0x303] = 4;
  ram.set([0xb3, 0x12, 0x34, 0x56, 0x76, 0x54, 0x32, 0x1f, 0xed], 0x400);
  dsp[0] = 0x7f;
  dsp[1] = 0x7f;
  dsp[2] = pitch & 255;
  dsp[3] = pitch >> 8;
  dsp[7] = 0x7f;
  dsp[0x0c] = 0x7f;
  dsp[0x1c] = 0x7f;
  dsp[0x5d] = 3;
  dsp[0x6c] = 0x20;
  return bytes;
}

export function xaFixture() {
  const bytes = new Uint8Array(2352 * 4);
  for (let sector = 0; sector < 4; sector++) {
    const start = sector * 2352;
    bytes.fill(255, start + 1, start + 11);
    bytes[start + 15] = 2;
    const flags = sector === 0 ? 0x22 : sector === 3 ? 0xa4 : 0x24;
    bytes.set([2, sector === 2 ? 4 : 3, flags, 1], start + 16);
    bytes.set([2, sector === 2 ? 4 : 3, flags, 1], start + 20);
    for (let group = 0; group < 18; group++) {
      const offset = start + 24 + group * 128;
      bytes.fill(12, offset, offset + 16);
      for (let index = 0; index < 28; index++)
        bytes.set([0xf1, 0xe2, 0xd3, 0xc4], offset + 16 + index * 4);
    }
  }
  return bytes;
}

export function nintendoStreamFixture(magic = 'FSTM') {
  const littleEndian = magic === 'CSTM',
    bytes = new Uint8Array(1072),
    view = new DataView(bytes.buffer),
    put = (offset, value) => view.setUint32(offset, value, littleEndian),
    info = 96,
    table = 176;
  writeText(bytes, 0, magic);
  bytes.set(littleEndian ? [255, 254] : [254, 255], 4);
  view.setUint16(6, 64, littleEndian);
  put(12, bytes.length);
  view.setUint16(16, 2, littleEndian);
  put(24, 64);
  put(36, 1024);
  writeText(bytes, 64, 'INFO');
  put(76, 24);
  put(92, table - 72);
  bytes[info] = 2;
  bytes[info + 1] = 1;
  bytes[info + 2] = 2;
  put(info + 4, 32000);
  put(info + 8, 14);
  put(info + 12, 21);
  put(info + 16, 2);
  put(info + 20, 8);
  put(info + 24, 14);
  put(info + 28, 5);
  put(info + 32, 7);
  put(info + 36, 8);
  put(info + 52, 8);
  put(table, 2);
  for (let channel = 0; channel < 2; channel++) {
    const definition = 240 + channel * 8,
      state = 320 + channel * 48;
    put(table + 8 + channel * 8, definition - table);
    put(definition + 4, state - definition);
    view.setInt16(state, 2048, littleEndian);
    view.setInt16(state + 34, channel ? -100 : 100, littleEndian);
  }
  writeText(bytes, 1024, 'DATA');
  for (let block = 0; block < 2; block++) {
    bytes.set([0, 0x11, 0x11, 0x11, 0x11, 0x11, 0x11, 0x11], 1040 + block * 16);
    bytes.set([0, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff], 1048 + block * 16);
  }
  return bytes;
}

export function msWaveFixture() {
  const bytes = new Uint8Array(70),
    view = new DataView(bytes.buffer);
  writeText(bytes, 0, 'RIFF');
  view.setUint32(4, bytes.length - 8, true);
  writeText(bytes, 8, 'WAVE');
  writeText(bytes, 12, 'fmt ');
  view.setUint32(16, 26, true);
  view.setUint16(20, 2, true);
  view.setUint16(22, 1, true);
  view.setUint32(24, 32000, true);
  view.setUint32(28, 64000, true);
  view.setUint16(32, 8, true);
  view.setUint16(34, 4, true);
  view.setUint16(36, 8, true);
  view.setUint16(38, 4, true);
  view.setUint16(40, 1, true);
  view.setInt16(42, 256, true);
  writeText(bytes, 46, 'data');
  view.setUint32(50, 16, true);
  bytes.set(
    [0, 16, 0, 100, 0, 90, 0, 0x1f, 0, 16, 0, 206, 255, 196, 255, 0xf1],
    54,
  );
  return bytes;
}
