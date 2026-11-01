function put16(bytes, offset, value) {
  bytes[offset] = value & 255;
  bytes[offset + 1] = value >> 8;
}

function nativeProgram(echoAtMusic) {
  const ram = new Uint8Array(0x1600),
    labels = new Map(),
    fixups = [];
  let p = 0x200;
  const at = (address) => (p = address);
  const emit = (...values) => {
    ram.set(values, p - 0x200);
    p += values.length;
  };
  const label = (name) => labels.set(name, p);
  const jump = (opcode, name) => {
    emit(opcode, 0, 0);
    fixups.push({ p: p - 2, name });
  };
  const branch = (opcode, name) => {
    emit(opcode, 0);
    fixups.push({ p: p - 1, name, relative: true });
  };
  const dsp = (reg, value) => emit(0x8f, reg, 0xf2, 0x8f, value, 0xf3);
  label('boot');
  emit(0xc0, 0x20, 0xcd, 0xff, 0xbd);
  dsp(0x6c, echoAtMusic ? 0 : 0x20);
  if (echoAtMusic) {
    dsp(0x6d, 0x40);
    dsp(0x7d, 0);
  }
  dsp(0x0c, 0x60);
  dsp(0x1c, 0x60);
  dsp(0x5d, 0x30);
  emit(0x8f, 0x10, 0xfa, 0x8f, 1, 0xf1);
  emit(0x8f, 0, 0xf4, 0x8f, 0, 0xf5, 0x8f, 0, 0xf6, 0x8f, 0, 0xf7);
  emit(0x8f, 0x19, 0xf4, 0x8f, 0x67, 0xf5, 0x8f, 7, 0xf6, 0x8f, 4, 0xf7);
  label('wait');
  emit(0xe4, 0xf4);
  branch(0xf0, 'wait');
  emit(0x64, 0xf4);
  branch(0xd0, 'wait');
  emit(0x68, 3);
  branch(0xf0, 'transfer');
  for (const [command, handler] of [
    [1, 'load'],
    [2, 'directory'],
    [4, 'music'],
    [8, 'effect'],
  ]) {
    emit(0x68, command, 0xd0, 3);
    jump(0x5f, handler);
  }
  label('ack');
  emit(0x8f, 0x37, 0xf1, 0xe4, 0xd5, 0xbc, 0xc4, 0xd5, 0xc4, 0xf4);
  jump(0x5f, 'wait');
  label('transfer');
  emit(
    0x8d,
    0,
    0xe4,
    0xf5,
    0xd7,
    0xd8,
    0x3a,
    0xd8,
    0xe4,
    0xf6,
    0xd7,
    0xd8,
    0x3a,
    0xd8,
    0xe4,
    0xf7,
    0xd7,
    0xd8,
    0x3a,
    0xd8,
  );
  jump(0x5f, 'ack');
  label('load');
  emit(0xe4, 0xf5, 0xc4, 0xd6, 0x8f, 0, 0xd8, 0x8f, 0x40, 0xd9);
  jump(0x5f, 'ack');
  label('directory');
  emit(
    0xe4,
    0xf5,
    0x8f,
    0,
    0xe0,
    0x8f,
    0x30,
    0xe1,
    0x1c,
    0x1c,
    0xfd,
    0xfa,
    0xd8,
    0xd0,
    0xe4,
    0xd0,
    0xd7,
    0xe0,
    0xfc,
    0xfa,
    0xd9,
    0xd1,
    0xe4,
    0xd1,
    0xd7,
    0xe0,
    0xfc,
    0x60,
    0x89,
    0xf6,
    0xd0,
    0x89,
    0xf7,
    0xd1,
    0xe4,
    0xd0,
    0xd7,
    0xe0,
    0xfc,
    0xe4,
    0xd1,
    0xd7,
    0xe0,
  );
  jump(0x5f, 'ack');
  at(0x400);
  label('music');
  jump(0x3f, 'mainHeader');
  jump(0x3f, 'play');
  jump(0x5f, 'ack');
  label('effect');
  emit(0xe4, 0xf5, 0x68, 2, 0xb0, 6);
  jump(0x3f, 'effectHeader');
  jump(0x3f, 'play');
  jump(0x5f, 'ack');
  at(0x500);
  label('mainHeader');
  emit(
    0x8f,
    0,
    0xe0,
    0x8f,
    0x40,
    0xe1,
    0xfa,
    0xe0,
    0xde,
    0xfa,
    0xe1,
    0xdf,
    0x8d,
    0,
    0xf7,
    0xe0,
    0xc4,
    0xef,
    0x3a,
    0xe0,
  );
  emit(
    0x8d,
    0,
    0xf7,
    0xe0,
    0x60,
    0x84,
    0xde,
    0xc4,
    0xe2,
    0xfc,
    0xf7,
    0xe0,
    0x84,
    0xdf,
    0xc4,
    0xe3,
    0x6f,
  );
  emit(0x7d, 0x60, 0x88, 0x10, 0x5d, 0xc8, 0x60, 0xd0, 0);
  label('effectHeader');
  emit(
    0x1c,
    0x5d,
    0xf5,
    0,
    0x12,
    0xc4,
    0xe0,
    0xf5,
    1,
    0x12,
    0xc4,
    0xe1,
    0xfa,
    0xe0,
    0xde,
    0xfa,
    0xe1,
    0xdf,
    0x8d,
    0,
    0xcd,
    0x60,
  );
  emit(
    0xf7,
    0xe0,
    0x60,
    0x84,
    0xde,
    0xc4,
    0xe2,
    0xfc,
    0xf7,
    0xe0,
    0x84,
    0xdf,
    0xc4,
    0xe3,
    0x6f,
  );
  label('play');
  emit(0x8d, 1, 0xf7, 0xe2, 0xc4, 0xe2);
  emit(
    0xe4,
    0xe2,
    0x1c,
    0x1c,
    0x1c,
    0x5d,
    0xf5,
    0,
    0x13,
    0x2d,
    0x3d,
    0xe4,
    0xe9,
    0x80,
    0xb5,
    0,
    0x13,
    0xae,
    0x8f,
    4,
    0xf2,
    0xc4,
    0xf3,
  );
  dsp(0, 0x7f);
  dsp(1, 0x7f);
  dsp(2, 0);
  dsp(3, 0x10);
  dsp(5, 0);
  dsp(7, 0x7f);
  dsp(0x4c, 1);
  emit(0x6f);
  emit(
    0xcd,
    0,
    0xf5,
    0,
    0x14,
    0xc4,
    0xe2,
    0x3d,
    0xe4,
    0xe9,
    0x75,
    0,
    0x14,
    0x90,
    5,
    0xab,
    0xe2,
    0x3d,
    0x2f,
    0xf6,
    0xe4,
    0xe2,
  );
  for (const fixup of fixups) {
    const target = labels.get(fixup.name);
    if (fixup.relative) {
      const offset = target - fixup.p - 1;
      if (offset < -128 || offset > 127)
        throw new Error('Authored branch range');
      ram[fixup.p - 0x200] = offset & 255;
    } else put16(ram, fixup.p - 0x200, target);
  }
  put16(ram, 0x1000, 0x1210);
  put16(ram, 0x1002, 0x1220);
  ram.set([4, 0, 255, 255, 0xfc, 1, 1, 4, 40, 0x7f, 0xfe], 0x1010);
  ram.set([4, 0, 255, 255, 0xfc, 2, 1, 4, 45, 0x7f, 0xfe], 0x1020);
  for (let id = 0; id < 32; id++) ram[0x1100 + id * 8] = id;
  ram.set([1, 42, 128], 0x1200);
  return ram;
}

export function cubeRom({
  shift = 0,
  missingAssociation = false,
  loopTail = false,
  nestedLoops = false,
  echoAtMusic = false,
} = {}) {
  const bytes = new Uint8Array(0x40000).fill(255),
    driver = nativeProgram(echoAtMusic);
  bytes.set(new TextEncoder().encode('AUTHORED CUBE FIXTURE '), 0x7fc0);
  bytes[0x7fd5] = 0x20;
  put16(bytes, 0x7fdc, 0x1234);
  put16(bytes, 0x7fde, 0xedcb);
  put16(bytes, 0x7ffc, 0x8000);
  const code = 0x1000 + shift,
    musicTable = 0x3000 + shift,
    sampleTable = 0x3100 + shift,
    associations = 0x3200 + shift,
    upload = 0x24000 + shift;
  const descriptor = (p, table, skip) => {
    const pointer = (table & 0x7fff) | 0x8000;
    bytes.set(
      [
        0xbd,
        pointer & 255,
        pointer >> 8,
        0x8d,
        0x20,
        0,
        0xa9,
        0x80,
        0x8d,
        0x1f,
        0,
        0x9c,
        0x1e,
        0,
        0xbd,
        (pointer + 1) & 255,
        (pointer + 1) >> 8,
        0xc2,
        0x20,
        0x29,
        0xff,
        0,
        0xa8,
        0xe2,
        0x20,
        0xb7,
        0x1e,
        0x8d,
        0x52,
        1,
        0xc8,
        0xb7,
        0x1e,
        0x8d,
        0x1f,
        0,
        0xad,
        0x52,
        1,
        0x8d,
        0x1e,
        0,
        0xc2,
        0x20,
        0xa0,
        0,
        0,
        0xb7,
        0x1e,
        0x8d,
        0x44,
        1,
        0xa9,
        skip,
        0,
        0x8d,
        0x46,
        1,
        0xe2,
        0x20,
      ],
      p,
    );
  };
  descriptor(code, musicTable, 2);
  descriptor(code + 0x100, sampleTable, 4);
  const associationPointer = associations | 0x8000;
  bytes.set(
    [
      0xa2,
      0,
      0,
      0xbd,
      associationPointer & 255,
      associationPointer >> 8,
      0xe8,
      0xc9,
      0xff,
      0xf0,
      0x37,
      0xcd,
      0x53,
      1,
      0xf0,
      10,
    ],
    code + 0x200,
  );
  bytes.set(
    [0, 0xfe, 1, 0xff, 1, 0xfe, ...(missingAssociation ? [] : [2]), 0xff, 0xff],
    associations,
  );
  for (let id = 0; id < 2; id++) {
    bytes.set([2, id * 2], musicTable + id * 2);
    const p = 0x10000 + 0x100 + id * 0x40;
    put16(bytes, 0x10000 + id * 2, (p & 0x7fff) | 0x8000);
    const events = nestedLoops
      ? [
          0xf9, 0xfc, 1, 1, 4, 40, 0x7f, 0xf9, 1, 4, 45, 0x7f, 0xf8, 2, 0xfc, 2,
          1, 4, 48, 0x7f, 0xf8, 0, 0xfe,
        ]
      : loopTail
        ? [0xfc, id + 1, 0xf9, 1, 4, 40 + id, 0x7f, 0xf8, 0, 0xfc, 0x7f, 0xfe]
        : [0xfc, id + 1, 1, 4, 40 + id, 0x7f, 0xfe];
    put16(bytes, p, 13 + events.length);
    bytes[p + 2] = 90;
    for (let channel = 0; channel < 6; channel++)
      put16(bytes, p + 3 + channel * 2, 13);
    bytes.set(events, p + 15);
  }
  for (let id = 1; id <= 2; id++) {
    bytes.set([3, id * 2], sampleTable + id * 2);
    const p = 0x18000 + 0x100 + id * 0x20;
    put16(bytes, 0x18000 + id * 2, (p & 0x7fff) | 0x8000);
    put16(bytes, p, 9);
    put16(bytes, p + 2, 0);
    bytes.set([0xc3, ...Array(8).fill(id === 1 ? 0x77 : 0x33)], p + 4);
  }
  let p = upload;
  for (let offset = 0; offset < driver.length; offset += 0x300) {
    const chunk = driver.subarray(offset, offset + 0x300);
    put16(bytes, p, chunk.length);
    put16(bytes, p + 2, 0x200 + offset);
    bytes.set(chunk, p + 4);
    p += chunk.length + 4;
  }
  const directory = new Uint8Array(16);
  for (let id = 1; id <= 2; id++) {
    if (id === 2 && missingAssociation) continue;
    put16(directory, id * 4, 0x3200 + (id - 1) * 0x10);
    put16(directory, id * 4 + 2, 0x3200 + (id - 1) * 0x10);
  }
  for (const [destination, payload] of [
    [0x3000, directory],
    [0x3200, Uint8Array.from([0xc3, ...Array(8).fill(0x77)])],
    [0x3210, Uint8Array.from([0xc3, ...Array(8).fill(0x33)])],
  ]) {
    put16(bytes, p, payload.length);
    put16(bytes, p + 2, destination);
    bytes.set(payload, p + 4);
    p += payload.length + 4;
  }
  put16(bytes, p, 0);
  put16(bytes, p + 2, 0x200);
  return { bytes, musicTable, sampleTable, associations, upload, code };
}
