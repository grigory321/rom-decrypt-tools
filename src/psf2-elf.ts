import type { IopMachine } from './psf2-iop.js';
import { check, FormatError } from './binary.js';

interface IrxProgram {
  offset: number;
  address: number;
  fileSize: number;
  memorySize: number;
}
interface IrxSection {
  type: number;
  address: number;
  offset: number;
  size: number;
}

function range(bytes: Uint8Array, offset: number, length: number) {
  check(
    Number.isSafeInteger(offset) &&
      Number.isSafeInteger(length) &&
      offset >= 0 &&
      length >= 0 &&
      offset + length <= bytes.length,
    'PSF2_ELF',
    'ELF range',
  );
}

export function inspectIrx(bytes: Uint8Array) {
  check(bytes instanceof Uint8Array && bytes.length >= 52, 'PSF2_ELF');
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  check(
    view.getUint32(0, true) === 0x464c457f &&
      bytes[4] === 1 &&
      bytes[5] === 1 &&
      bytes[6] === 1 &&
      view.getUint16(18, true) === 8,
    'PSF2_ELF',
    'Expected ELF32 little-endian MIPS',
  );
  const type = view.getUint16(16, true);
  check([2, 0xff80, 0xff81].includes(type), 'PSF2_ELF', 'Unsupported ELF type');
  const programs: IrxProgram[] = [];
  const programOffset = view.getUint32(28, true);
  const programSize = view.getUint16(42, true);
  const programCount = view.getUint16(44, true);
  check(
    programCount <= 128 && (!programCount || programSize >= 32),
    'PSF2_ELF',
  );
  range(bytes, programOffset, programSize * programCount);
  for (let index = 0; index < programCount; index++) {
    const at = programOffset + index * programSize;
    if (view.getUint32(at, true) !== 1) continue;
    const offset = view.getUint32(at + 4, true);
    const address = view.getUint32(at + 8, true);
    const fileSize = view.getUint32(at + 16, true);
    const memorySize = view.getUint32(at + 20, true);
    range(bytes, offset, fileSize);
    check(
      fileSize <= memorySize &&
        memorySize <= 0x200000 &&
        address + memorySize <= 0x200000,
      'PSF2_ELF',
      'ELF program size',
    );
    programs.push({ offset, address, fileSize, memorySize });
  }
  check(programs.length > 0, 'PSF2_ELF', 'Missing loadable program');
  programs.sort((a, b) => a.address - b.address);
  for (let index = 0; index < programs.length; index++) {
    const program = programs[index];
    check(program.memorySize > 0, 'PSF2_ELF', 'Empty loadable program');
    if (type === 2)
      check(
        program.address >= 0x10000,
        'PSF2_ELF',
        'Fixed ELF overlaps kernel RAM',
      );
    if (index)
      check(
        program.address >=
          programs[index - 1].address + programs[index - 1].memorySize,
        'PSF2_ELF',
        'Overlapping ELF segments',
      );
  }
  const sections: IrxSection[] = [];
  const sectionOffset = view.getUint32(32, true);
  const sectionSize = view.getUint16(46, true);
  const sectionCount = view.getUint16(48, true);
  check(
    sectionCount <= 4096 && (!sectionCount || sectionSize >= 40),
    'PSF2_ELF',
  );
  range(bytes, sectionOffset, sectionSize * sectionCount);
  for (let index = 0; index < sectionCount; index++) {
    const at = sectionOffset + index * sectionSize;
    const section = {
      type: view.getUint32(at + 4, true),
      address: view.getUint32(at + 12, true),
      offset: view.getUint32(at + 16, true),
      size: view.getUint32(at + 20, true),
    };
    if (section.type !== 8) range(bytes, section.offset, section.size);
    sections.push(section);
  }
  return {
    type,
    entry: view.getUint32(24, true),
    programs,
    sections,
    view,
    size: Math.max(
      ...programs.map((program) => program.address + program.memorySize),
    ),
  };
}

export function loadIrx(
  machine: IopMachine,
  bytes: Uint8Array,
  name = 'module.irx',
) {
  const elf = inspectIrx(bytes);
  check(
    !(elf.entry & 3) &&
      elf.programs.some(
        (program) =>
          elf.entry >= program.address &&
          elf.entry + 4 <= program.address + program.fileSize,
      ),
    'PSF2_ELF',
    'ELF entry',
  );
  const base = elf.type === 2 ? 0 : machine.allocate(elf.size);
  if (elf.type === 2)
    machine.reserveRanges(
      elf.programs.map((program) => ({
        address: program.address,
        length: program.memorySize,
      })),
    );
  for (const program of elf.programs) {
    const address = base + program.address;
    machine.memoryRange(address, program.memorySize);
    machine.ram.fill(0, address, address + program.memorySize);
    machine.ram.set(
      bytes.subarray(program.offset, program.offset + program.fileSize),
      address,
    );
  }
  const word = (offset: number) => {
    check(
      !(offset & 3) &&
        elf.programs.some(
          (program) =>
            offset >= program.address &&
            offset + 4 <= program.address + program.memorySize,
        ),
      'PSF2_ELF',
      'Relocation outside module',
    );
    return machine.read32(base + offset);
  };
  const put = (offset: number, value: number) =>
    machine.write32(base + offset, value);
  for (const section of elf.sections) {
    if (section.type !== 9) continue;
    check(!(section.size % 8), 'PSF2_ELF', 'Relocation table length');
    const pending: { offset: number; instruction: number }[] = [];
    for (let record = 0; record < section.size; record += 8) {
      const offset = elf.view.getUint32(section.offset + record, true);
      const type = elf.view.getUint32(section.offset + record + 4, true) & 255;
      if (!type) continue;
      const instruction = word(offset);
      if (type === 2) put(offset, instruction + base);
      else if (type === 4)
        put(
          offset,
          (instruction & 0xfc000000) |
            (((instruction & 0x3ffffff) + (base >>> 2)) & 0x3ffffff),
        );
      else if (type === 5) pending.push({ offset, instruction });
      else if (type === 6) {
        const low = (instruction << 16) >> 16;
        for (const high of pending) {
          const value = ((high.instruction & 65535) * 65536 + low + base) >>> 0;
          put(
            high.offset,
            (high.instruction & 0xffff0000) |
              (((value + 0x8000) >>> 16) & 65535),
          );
        }
        pending.length = 0;
        put(offset, (instruction & 0xffff0000) | ((low + base) & 65535));
      } else if (type === 0xfa && elf.type === 0xff81) {
        check(
          record + 8 < section.size &&
            (elf.view.getUint32(section.offset + record + 12, true) & 255) ===
              0xfb,
          'PSF2_ELF',
          'MHI16 addend',
        );
        const value =
          elf.view.getUint32(section.offset + record + 8, true) + base;
        let link = offset;
        const visited = new Set<number>();
        while (true) {
          check(
            !visited.has(link) && visited.size < elf.size / 4,
            'PSF2_ELF',
            'Cyclic MHI16 chain',
          );
          visited.add(link);
          const previous = word(link);
          const delta = ((previous << 16) >> 16) * 4;
          put(
            link,
            (previous & 0xffff0000) | (((value + 0x8000) >>> 16) & 65535),
          );
          if (!delta) break;
          link += delta;
        }
        record += 8;
      } else
        throw new FormatError(
          'PSF2_UNSUPPORTED',
          `ELF relocation ${type} in ${name}`,
        );
    }
    check(!pending.length, 'PSF2_ELF', 'Unpaired HI16 relocation');
  }
  let gp = 0;
  for (const section of elf.sections)
    if (section.type === 0x70000080 && section.size >= 12)
      gp = base + elf.view.getUint32(section.offset + 8, true);
  const module = {
    id: machine.modules.length + 1,
    name,
    base,
    size: elf.size,
    entry: base + elf.entry,
    gp,
    started: false,
    ranges: elf.programs.map((program) => ({
      start: base + program.address,
      end: base + program.address + program.memorySize,
    })),
  };
  machine.modules.push(module);
  for (const program of elf.programs) {
    const end = program.address + program.fileSize;
    for (let offset = program.address; offset + 20 <= end; offset += 4) {
      const address = base + offset;
      if (machine.read32(address) !== 0x41e00000) continue;
      let library = '';
      for (let index = 0; index < 8; index++) {
        const code = machine.read8(address + 12 + index);
        if (!code) break;
        library += String.fromCharCode(code);
      }
      check(/^[a-zA-Z0-9_]+$/.test(library), 'PSF2_ELF', 'Import library name');
      let stub = address + 20;
      while (stub + 8 <= base + end && machine.read32(stub) === 0x03e00008) {
        const ordinal = machine.read32(stub + 4);
        check(ordinal >>> 16 === 0x2400, 'PSF2_ELF', 'Invalid IRX import stub');
        machine.imports.set(stub, {
          library,
          id: ordinal & 65535,
          module: name,
        });
        stub += 8;
      }
      offset = stub - base - 4;
    }
  }
  return module;
}
