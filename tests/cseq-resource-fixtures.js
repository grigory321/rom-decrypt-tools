export function container(magic, blocks, littleEndian = true) {
  const headerSize = Math.ceil((20 + blocks.length * 12) / 32) * 32;
  const size =
    headerSize + blocks.reduce((sum, block) => sum + block.bytes.length + 8, 0);
  const bytes = new Uint8Array(size);
  const view = new DataView(bytes.buffer);
  bytes.set(new TextEncoder().encode(magic));
  view.setUint16(4, 0xfeff, littleEndian);
  view.setUint16(6, headerSize, littleEndian);
  view.setUint32(8, 0x01000000, littleEndian);
  view.setUint32(12, size, littleEndian);
  view.setUint16(16, blocks.length, littleEndian);
  let offset = headerSize;
  for (let index = 0; index < blocks.length; index++) {
    const block = blocks[index];
    view.setUint16(20 + index * 12, block.id, littleEndian);
    view.setUint32(24 + index * 12, offset, littleEndian);
    view.setUint32(28 + index * 12, block.bytes.length + 8, littleEndian);
    bytes.set(new TextEncoder().encode(block.magic), offset);
    view.setUint32(offset + 4, block.bytes.length + 8, littleEndian);
    bytes.set(block.bytes, offset + 8);
    offset += block.bytes.length + 8;
  }
  return bytes;
}

export function score(littleEndian = true) {
  const labels = new Uint8Array(32);
  const view = new DataView(labels.buffer);
  view.setUint32(0, 1, littleEndian);
  view.setUint16(4, 0x5100, littleEndian);
  view.setUint32(8, 12, littleEndian);
  view.setUint16(12, 0x1f00, littleEndian);
  view.setUint32(16, 2, littleEndian);
  view.setUint32(20, 5, littleEndian);
  labels.set(new TextEncoder().encode('start'), 24);
  return container(
    'CSEQ',
    [
      { id: 0x5000, magic: 'DATA', bytes: Uint8Array.of(0x80, 1, 0xff) },
      { id: 0x5001, magic: 'LABL', bytes: labels },
    ],
    littleEndian,
  );
}

export function waves(value = 33, littleEndian = true) {
  const wave = container(
    'CWAV',
    [{ id: 0x7000, magic: 'INFO', bytes: Uint8Array.of(value, 0, 0, 0) }],
    littleEndian,
  );
  const info = new Uint8Array(16);
  const view = new DataView(info.buffer);
  view.setUint32(0, 1, littleEndian);
  view.setUint16(4, 0x1f00, littleEndian);
  view.setUint32(8, 0, littleEndian);
  view.setUint32(12, wave.length, littleEndian);
  return container(
    'CWAR',
    [
      { id: 0x6800, magic: 'INFO', bytes: info },
      { id: 0x6801, magic: 'FILE', bytes: wave },
    ],
    littleEndian,
  );
}

export function bank({
  waveArchive = 0,
  keyType = 0x6000,
  velocityType = 0x6000,
  littleEndian = true,
} = {}) {
  const bytes = new Uint8Array(512);
  const view = new DataView(bytes.buffer);
  let cursor = 16;
  const allocate = (length) => {
    const offset = cursor;
    cursor += length;
    return offset;
  };
  const ref = (offset, id, base, target) => {
    view.setUint16(offset, id, littleEndian);
    view.setInt32(
      offset + 4,
      target === null ? -1 : target - base,
      littleEndian,
    );
  };
  const waveTable = allocate(12);
  view.setUint32(waveTable, 1, littleEndian);
  view.setUint32(waveTable + 4, 0x05000000 | waveArchive, littleEndian);
  const instruments = allocate(12);
  view.setUint32(instruments, 1, littleEndian);
  const instrument = allocate(8);
  ref(instruments + 4, 0x5900, instruments, instrument);
  ref(0, 0x0100, 0, waveTable);
  ref(8, 0x0101, 0, instruments);
  const table = (node, type, low, high, childType) => {
    const count = type === 0x6002 ? high - low + 1 : 1;
    const head = type === 0x6000 ? 0 : type === 0x6001 ? 8 : 4;
    const target = allocate(head + count * 8);
    ref(node, type, node, target);
    if (type === 0x6001) {
      view.setUint32(target, 1, littleEndian);
      bytes[target + 4] = high;
    }
    if (type === 0x6002) {
      bytes[target] = low;
      bytes[target + 1] = high;
    }
    const child = allocate(8);
    for (let index = 0; index < count; index++)
      ref(
        target + head + index * 8,
        childType,
        target,
        index === count - 1 ? child : null,
      );
    return child;
  };
  const key = table(instrument, keyType, 59, 60, 0x5901);
  table(key, velocityType, 63, 64, 0x5902);
  const region = allocate(48);
  const fixChild = (node) => {
    const target = node + view.getInt32(node + 4, littleEndian);
    const type = view.getUint16(node, littleEndian);
    const refOffset =
      type === 0x6000 ? target : type === 0x6001 ? target + 8 : target + 12;
    ref(refOffset, 0x5902, target, region);
  };
  fixChild(key);
  view.setUint32(region, 0, littleEndian);
  view.setUint32(region + 4, 0x21f, littleEndian);
  view.setUint32(region + 8, 60, littleEndian);
  view.setUint32(region + 12, 101, littleEndian);
  view.setUint32(region + 16, 70, littleEndian);
  view.setFloat32(region + 20, 1.25, littleEndian);
  view.setUint32(region + 24, 0x010701, littleEndian);
  view.setUint32(region + 28, 32, littleEndian);
  ref(region + 32, 0, region + 32, region + 40);
  bytes.set([10, 20, 30, 40, 50], region + 40);
  return container(
    'CBNK',
    [{ id: 0x5800, magic: 'INFO', bytes: bytes.slice(0, cursor) }],
    littleEndian,
  );
}

export function group(files) {
  const info = new Uint8Array(4 + files.length * 24);
  const view = new DataView(info.buffer);
  const body = new Uint8Array(
    files.reduce((sum, file) => sum + file.bytes.length, 0),
  );
  view.setUint32(0, files.length, true);
  let bodyOffset = 0;
  files.forEach((file, index) => {
    const item = 4 + files.length * 8 + index * 16;
    view.setUint16(4 + index * 8, 0x7900, true);
    view.setUint32(8 + index * 8, item, true);
    view.setUint32(item, file.id, true);
    view.setUint16(item + 4, 0x1f00, true);
    view.setUint32(item + 8, bodyOffset, true);
    view.setUint32(item + 12, file.bytes.length, true);
    body.set(file.bytes, bodyOffset);
    bodyOffset += file.bytes.length;
  });
  return container('CGRP', [
    { id: 0x7800, magic: 'INFO', bytes: info },
    { id: 0x7801, magic: 'FILE', bytes: body },
  ]);
}

export function archive({
  files = [score(), bank({ waveArchive: 1 }), null, waves(11), waves(77)],
  bankItems = [1],
  warItems = [3, 4],
  soundBank = 0,
  startOffset = 2,
  groups = [],
  soundCount = 1,
  soundPrefix = false,
} = {}) {
  const info = new Uint8Array(8192);
  const view = new DataView(info.buffer);
  let cursor = 64;
  const allocate = (length) => {
    const offset = cursor;
    cursor += length;
    return offset;
  };
  const ref = (at, id, base, target) => {
    view.setUint16(at, id, true);
    view.setInt32(at + 4, target === null ? -1 : target - base, true);
  };
  const table = (slot, id, lengths) => {
    const target = allocate(4 + lengths.length * 8);
    ref(slot * 8, id, 0, target);
    view.setUint32(target, lengths.length, true);
    return lengths.map((length, index) => {
      const entry = allocate(length);
      ref(target + 4 + index * 8, 0, target, entry);
      return entry;
    });
  };
  const soundEntries = table(
    0,
    0x2100,
    Array(soundCount + Number(soundPrefix)).fill(44),
  );
  for (const [index, sound] of soundEntries.entries()) {
    if (soundPrefix && index === 0) {
      ref(sound + 12, 0x2201, sound, null);
      continue;
    }
    view.setUint32(sound, 0, true);
    info[sound + 8] = 93;
    const detail = allocate(28);
    ref(sound + 12, 0x2203, sound, detail);
    const bankTable = allocate(8);
    ref(detail, 0x0100, detail, bankTable);
    view.setUint32(detail + 8, 0x0005, true);
    view.setUint32(detail + 12, 3, true);
    view.setUint32(detail + 16, startOffset, true);
    view.setUint32(detail + 20, 45, true);
    view.setUint32(bankTable, 1, true);
    view.setUint32(bankTable + 4, 0x03000000 | soundBank, true);
  }
  table(1, 0x2104, []);
  table(
    2,
    0x2101,
    bankItems.map(() => 16),
  ).forEach((entry, index) => {
    view.setUint32(entry, bankItems[index], true);
    ref(entry + 4, 0x0100, entry, null);
  });
  table(
    3,
    0x2103,
    warItems.map(() => 8),
  ).forEach((entry, index) => view.setUint32(entry, warItems[index], true));
  table(
    4,
    0x2105,
    groups.map(() => 8),
  ).forEach((entry, index) => view.setUint32(entry, groups[index], true));
  table(5, 0x2102, []);
  const locations = table(
    6,
    0x2106,
    files.map(() => 24),
  );
  const data = new Uint8Array(
    files.reduce(
      (sum, file) => sum + (file instanceof Uint8Array ? file.length : 0),
      0,
    ),
  );
  let fileOffset = 0;
  files.forEach((file, index) => {
    const entry = locations[index];
    if (typeof file === 'string') {
      const path = new TextEncoder().encode(file + '\0');
      const target = allocate(path.length);
      info.set(path, target);
      ref(entry, 0x220d, entry, target);
    } else {
      ref(entry, 0x220c, entry, entry + 8);
      view.setUint16(entry + 8, 0x1f00, true);
      view.setUint32(entry + 12, file ? fileOffset : 0xffffffff, true);
      view.setUint32(entry + 16, file ? file.length : 0, true);
      if (file) {
        data.set(file, fileOffset);
        fileOffset += file.length;
      }
    }
  });
  return container('CSAR', [
    { id: 0x2001, magic: 'INFO', bytes: info.slice(0, cursor) },
    { id: 0x2002, magic: 'FILE', bytes: data },
  ]);
}
