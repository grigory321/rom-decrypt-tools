import type { MipsCpu } from './mips-cpu.js';
import type { PsxMachine } from './psf-machine.js';
import { check, FormatError } from './binary.js';

const jumpRegisters = [31, 29, 30, 16, 17, 18, 19, 20, 21, 22, 23, 28];
const callbackReturn = 0x800000f0;

interface BiosCpuState {
  registers: Int32Array;
  cop0: Int32Array;
  pc: number;
  nextPC: number;
  delaySlot: boolean;
  hi: number;
  lo: number;
  loadRegister: number;
  loadValue: number;
}

interface BiosCallback {
  address: number;
  argument?: number;
}
interface BiosEvent {
  classId: number;
  spec: number;
  mode: number;
  address: number;
  enabled: boolean;
  fired: boolean;
}
type BiosInterruptStep =
  | { kind: 'queue'; priority: number }
  | { kind: 'timer' | 'timer-return'; index: number }
  | { kind: 'events' };
interface BiosInterruptFrame {
  saved: BiosCpuState;
  callbacks: BiosCallback[];
  steps?: BiosInterruptStep[];
  allowHook?: boolean;
}
interface BiosHeapBlock {
  offset: number;
  size: number;
}

export class PsxBios {
  events: Map<number, BiosEvent>;
  nextEvent: number;
  interruptFrames: BiosInterruptFrame[];
  hook: number;
  random: number;
  heap: BiosHeapBlock[];
  heapBase: number;
  heapSize: number;
  systemHeap: number;
  threads: Map<number, BiosCpuState>;
  currentThread: number;
  irqQueues: Map<number, number>;
  clearCounters: boolean[];
  constructor(readonly machine: PsxMachine) {
    this.events = new Map();
    this.nextEvent = 1;
    this.interruptFrames = [];
    this.hook = 0;
    this.random = 1;
    this.heap = [];
    this.heapBase = 0;
    this.heapSize = 0;
    this.systemHeap = 0x80008000;
    this.threads = new Map();
    this.currentThread = 0;
    this.irqQueues = new Map();
    this.clearCounters = [true, true, true, true];
    for (let index = 0; index < 256; index++)
      machine.ramView.setUint32(
        0x1000 + index * 4,
        0x80003000 + index * 4,
        true,
      );
    for (let index = 0; index < 32; index++)
      machine.ramView.setUint32(
        0x1400 + index * 4,
        0x80003800 + index * 4,
        true,
      );
    machine.ramView.setUint32(0x108, 0x80001800, true);
    machine.ramView.setUint32(0x10c, 8, true);
    machine.ramView.setUint32(0x110, 0x80001900, true);
    machine.ramView.setUint32(0x114, 0x400, true);
    machine.ramView.setUint32(0x1800, 0x80001900, true);
    machine.ramView.setUint32(0x1400 + 6 * 4, 0x80004000, true);
    machine.ramView.setUint32(0x1000 + 0x5b * 4, 0x80004000, true);
    machine.ramView.setUint32(0x4070, 0x3c080000, true);
    machine.ramView.setUint32(0x4074, 0x25084000, true);
  }

  range(address: number, length: number) {
    const physical = address & 0x1fffffff;
    check(
      Number.isSafeInteger(length) &&
        length >= 0 &&
        physical <= this.machine.ram.length &&
        length <= this.machine.ram.length - physical,
      'PSF_DRIVER',
      'BIOS memory range',
    );
    return physical;
  }

  string(address: number, limit = 0x200000) {
    const start = this.range(address, 0);
    const end = Math.min(this.machine.ram.length, start + limit);
    let cursor = start;
    while (cursor < end && this.machine.ram[cursor]) cursor++;
    check(
      cursor < end || cursor === start + limit,
      'PSF_DRIVER',
      'Unterminated BIOS string',
    );
    return this.machine.ram.subarray(start, cursor);
  }

  capture(cpu: MipsCpu): BiosCpuState {
    return {
      registers: cpu.registers.slice(),
      cop0: cpu.cop0.slice(),
      pc: cpu.pc,
      nextPC: cpu.nextPC,
      delaySlot: cpu.delaySlot,
      hi: cpu.hi,
      lo: cpu.lo,
      loadRegister: cpu.loadRegister,
      loadValue: cpu.loadValue,
    };
  }

  restore(cpu: MipsCpu, saved: BiosCpuState) {
    cpu.registers.set(saved.registers);
    cpu.cop0.set(saved.cop0);
    cpu.pc = saved.pc;
    cpu.nextPC = saved.nextPC;
    cpu.delaySlot = saved.delaySlot;
    cpu.hi = saved.hi;
    cpu.lo = saved.lo;
    cpu.loadRegister = saved.loadRegister;
    cpu.loadValue = saved.loadValue;
  }

  flushLoad(cpu: MipsCpu) {
    if (cpu.loadRegister) cpu.registers[cpu.loadRegister] = cpu.loadValue;
    cpu.loadRegister = 0;
  }

  intercept(cpu: MipsCpu) {
    const address = cpu.pc & 0x1fffffff;
    if (address === (callbackReturn & 0x1fffffff)) {
      check(
        this.interruptFrames.length > 0,
        'PSF_DRIVER',
        'Unexpected BIOS callback return',
      );
      const frame = this.interruptFrames[this.interruptFrames.length - 1];
      this.finishInterrupt(cpu, frame);
      return true;
    }
    let table = address;
    let fn = cpu.registers[9] & 255;
    if (address >= 0x3000 && address < 0x3400) {
      table = 0xb0;
      fn = (address - 0x3000) >>> 2;
    }
    if (address >= 0x3800 && address < 0x3880) {
      table = 0xc0;
      fn = (address - 0x3800) >>> 2;
    }
    if (table !== 0xa0 && table !== 0xb0 && table !== 0xc0 && table !== 0)
      return false;
    this.flushLoad(cpu);
    if (table === 0) {
      cpu.resetPC(cpu.registers[31]);
      return true;
    }
    const result =
      table === 0xa0
        ? this.a0(fn, cpu)
        : table === 0xb0
          ? this.b0(fn, cpu)
          : this.c0(fn, cpu);
    if (result !== false) cpu.resetPC(cpu.registers[31]);
    return true;
  }

  exception(cpu: MipsCpu, code: number) {
    if (code === 8) {
      const fn = cpu.registers[4];
      if (fn === 1) {
        cpu.registers[2] = cpu.cop0[12] & 1;
        cpu.cop0[12] &= ~1;
      } else if (fn === 2) cpu.cop0[12] |= 1;
      else throw new FormatError('PSF_SERVICE', `PlayStation syscall ${fn}`);
      return true;
    }
    if (this.machine.ramView.getUint32(0x80, true)) return false;
    throw new FormatError(
      'PSF_DRIVER',
      `MIPS exception ${code} at ${(cpu.instructionPC >>> 0).toString(16)}`,
    );
  }

  startCallback(cpu: MipsCpu, callback: BiosCallback) {
    cpu.resetPC(callback.address);
    cpu.registers[31] = callbackReturn;
    cpu.registers[4] = callback.argument || 0;
    cpu.cop0[12] &= ~1;
  }

  callbacks(
    cpu: MipsCpu,
    addresses: BiosCallback[],
    saved = this.capture(cpu),
  ) {
    if (!addresses.length) return;
    this.interruptFrames.push({ saved, callbacks: addresses.slice(1) });
    this.startCallback(cpu, addresses[0]);
  }

  deliverEvent(eventClass: number, spec: number) {
    const callbacks: BiosCallback[] = [];
    for (const event of this.events.values())
      if (
        event.enabled &&
        event.classId === eventClass >>> 0 &&
        event.spec === spec >>> 0
      ) {
        if (event.mode === 0x1000 && event.address)
          callbacks.push({ address: event.address });
        else event.fired = true;
      }
    return callbacks;
  }

  finishInterrupt(cpu: MipsCpu, frame: BiosInterruptFrame) {
    const machine = this.machine;
    while (!frame.callbacks.length) {
      const step = frame.steps?.shift();
      if (!step) break;
      if (step.kind === 'queue') {
        const queue = this.irqQueues.get(step.priority);
        const handler =
          queue === undefined ? 0 : machine.read32(queue + 8) >>> 0;
        if (handler)
          frame.callbacks.push({ address: handler, argument: queue });
      } else if (step.kind === 'timer') {
        const bit = step.index === 3 ? 1 : 1 << (4 + step.index);
        if (machine.interruptStatus & machine.interruptMask & bit) {
          frame.callbacks.push(
            ...this.deliverEvent(0xf2000000 + step.index, 2),
          );
          frame.steps?.unshift({ kind: 'timer-return', index: step.index });
        }
      } else if (step.kind === 'timer-return') {
        if (this.clearCounters[step.index]) {
          const bit = step.index === 3 ? 1 : 1 << (4 + step.index);
          machine.interruptStatus &= ~bit;
          frame.steps = [];
          frame.allowHook = false;
          break;
        }
      } else {
        const cause = machine.interruptStatus & machine.interruptMask;
        if (cause & 8)
          frame.callbacks.push(...this.deliverEvent(0xf0000009, 0x1000));
        if (cause & 0x200)
          frame.callbacks.push(...this.deliverEvent(0xf0000009, 0x20));
      }
    }
    const callback = frame.callbacks.shift();
    if (callback) this.startCallback(cpu, callback);
    else if (frame.allowHook && this.hook) {
      frame.allowHook = false;
      this.longJump(cpu, this.hook, 1);
      cpu.cop0[12] &= ~1;
    } else {
      this.interruptFrames.pop();
      this.restore(cpu, frame.saved);
    }
  }

  interrupt() {
    const machine = this.machine,
      cpu = machine.cpu;
    if (!(cpu.cop0[12] & 1) || this.interruptFrames.length) return;
    const cause = machine.interruptStatus & machine.interruptMask;
    if (!cause) return;
    if (machine.ramView.getUint32(0x80, true)) {
      cpu.interrupt(true);
      return;
    }
    this.flushLoad(cpu);
    const saved = this.capture(cpu);
    cpu.cop0[14] = cpu.pc;
    cpu.cop0[13] = (cpu.cop0[13] & ~0xff) | 0x400;
    const steps: BiosInterruptStep[] = [];
    const priorities = [
      ...new Set([0, 1, 2, 3, ...this.irqQueues.keys()]),
    ].sort((left, right) => left - right);
    for (const priority of priorities) {
      steps.push({ kind: 'queue', priority });
      if (priority === 1)
        for (const index of [3, 2, 1, 0]) steps.push({ kind: 'timer', index });
      if (priority === 3) steps.push({ kind: 'events' });
    }
    const frame: BiosInterruptFrame = {
      saved,
      callbacks: [],
      steps,
      allowHook: true,
    };
    this.interruptFrames.push(frame);
    this.finishInterrupt(cpu, frame);
  }

  longJump(cpu: MipsCpu, buffer: number, value: number) {
    const base = this.range(buffer, jumpRegisters.length * 4);
    jumpRegisters.forEach((register, index) => {
      cpu.registers[register] = this.machine.ramView.getInt32(
        base + index * 4,
        true,
      );
    });
    cpu.registers[2] = value || 1;
    cpu.resetPC(cpu.registers[31]);
  }

  malloc(size: number) {
    size = Math.ceil((size >>> 0) / 8) * 8;
    if (!size || size > this.heapSize) return 0;
    let offset = 0;
    for (const block of this.heap) {
      if (block.offset - offset >= size) break;
      offset = block.offset + block.size;
    }
    if (offset + size > this.heapSize) return 0;
    this.heap.push({ offset, size });
    this.heap.sort((a, b) => a.offset - b.offset);
    return (this.heapBase + offset) | 0;
  }

  unsupported(table: number, fn: number): never {
    throw new FormatError(
      'PSF_SERVICE',
      `PlayStation BIOS ${table.toString(16)}:${fn.toString(16)}`,
    );
  }

  a0(fn: number, cpu: MipsCpu) {
    const r = cpu.registers,
      machine = this.machine,
      ram = machine.ram;
    const a = r[4] >>> 0,
      b = r[5] >>> 0,
      c = r[6] >>> 0;
    switch (fn) {
      case 0x0e:
        r[2] = Math.abs(r[4]);
        break;
      case 0x0f:
        r[2] = Math.abs(r[4]);
        break;
      case 0x10:
        r[2] =
          Number.parseInt(new TextDecoder().decode(this.string(a)), 10) || 0;
        break;
      case 0x11:
        r[2] =
          Number.parseInt(new TextDecoder().decode(this.string(a)), 10) || 0;
        break;
      case 0x13: {
        const base = this.range(a, jumpRegisters.length * 4);
        jumpRegisters.forEach((register, index) =>
          machine.ramView.setInt32(base + index * 4, r[register], true),
        );
        r[2] = 0;
        break;
      }
      case 0x14:
        this.longJump(cpu, a, b);
        return false;
      case 0x15:
      case 0x16:
      case 0x19:
      case 0x1a: {
        const source = this.string(
          b,
          fn === 0x16 || fn === 0x1a ? c : 0x200000,
        ).slice();
        const prefix = fn === 0x15 || fn === 0x16 ? this.string(a).length : 0;
        const count = fn === 0x1a ? c : source.length + 1;
        const start = this.range(a + prefix, count);
        ram.fill(0, start, start + count);
        ram.set(source.subarray(0, count), start);
        r[2] = a;
        break;
      }
      case 0x17:
      case 0x18:
      case 0x29:
      case 0x2d: {
        const strings = fn === 0x17 || fn === 0x18;
        const count =
          fn === 0x17
            ? Math.max(this.string(a).length, this.string(b).length) + 1
            : c;
        let result = 0;
        const aa = this.range(a, count),
          bb = this.range(b, count);
        for (let n = 0; n < count; n++) {
          result = ram[aa + n] - ram[bb + n];
          if (result || (strings && !ram[aa + n])) break;
        }
        r[2] = result;
        break;
      }
      case 0x1b:
        r[2] = this.string(a).length;
        break;
      case 0x1c:
      case 0x1d:
      case 0x1e:
      case 0x1f: {
        const value = b & 255,
          data = this.string(a);
        const last = fn === 0x1d || fn === 0x1f;
        const found = value
          ? last
            ? data.lastIndexOf(value)
            : data.indexOf(value)
          : data.length;
        r[2] = found < 0 ? 0 : a + found;
        break;
      }
      case 0x25:
        r[2] = a >= 97 && a <= 122 ? a - 32 : a;
        break;
      case 0x26:
        r[2] = a >= 65 && a <= 90 ? a + 32 : a;
        break;
      case 0x27:
      case 0x2a:
      case 0x2c: {
        const destination = fn === 0x27 ? b : a;
        const source = fn === 0x27 ? a : b;
        const dest = this.range(destination, c),
          src = this.range(source, c);
        ram.copyWithin(dest, src, src + c);
        r[2] = destination;
        break;
      }
      case 0x28: {
        const start = this.range(a, b);
        ram.fill(0, start, start + b);
        r[2] = a;
        break;
      }
      case 0x2b: {
        const start = this.range(a, c);
        ram.fill(b & 255, start, start + c);
        r[2] = a;
        break;
      }
      case 0x2e: {
        const start = this.range(a, c);
        const found = ram.subarray(start, start + c).indexOf(b & 255);
        r[2] = found < 0 ? 0 : a + found;
        break;
      }
      case 0x2f:
        this.random = (Math.imul(this.random, 1103515245) + 12345) | 0;
        r[2] = (this.random >>> 16) & 0x7fff;
        break;
      case 0x30:
        this.random = a;
        r[2] = 0;
        break;
      case 0x33:
        r[2] = this.malloc(a);
        break;
      case 0x34:
        this.heap = this.heap.filter(
          (block) => (this.heapBase + block.offset) >>> 0 !== a,
        );
        r[2] = 0;
        break;
      case 0x37: {
        const size = a * b;
        check(
          Number.isSafeInteger(size) && size <= 0x200000,
          'PSF_DRIVER',
          'calloc size',
        );
        r[2] = this.malloc(size);
        if (r[2]) {
          const start = this.range(r[2], size);
          ram.fill(0, start, start + size);
        }
        break;
      }
      case 0x38: {
        if (!a) {
          r[2] = this.malloc(b);
          break;
        }
        const previous = this.heap.find(
          (block) => (this.heapBase + block.offset) >>> 0 === a,
        );
        check(previous, 'PSF_DRIVER', 'realloc pointer');
        const result = this.malloc(b);
        if (result) {
          ram.copyWithin(
            this.range(result, b),
            this.range(a, previous.size),
            this.range(a, previous.size) + Math.min(b, previous.size),
          );
          this.heap = this.heap.filter((block) => block !== previous);
        }
        r[2] = result;
        break;
      }
      case 0x39:
        this.range(a, b);
        this.heapBase = a;
        this.heapSize = b;
        this.heap = [];
        r[2] = 0;
        break;
      case 0x3c:
        r[2] = a & 255;
        break;
      case 0x3e:
        r[2] = this.string(a).length;
        break;
      case 0x3f:
      case 0x40:
      case 0x44:
      case 0x70:
      case 0x71:
      case 0x72:
      case 0x9f:
      case 0xa0:
      case 0xa1:
      case 0xa2:
      case 0xa3:
        r[2] = 0;
        break;
      default:
        this.unsupported(0xa0, fn);
    }
  }

  b0(fn: number, cpu: MipsCpu) {
    const r = cpu.registers,
      machine = this.machine;
    const a = r[4] >>> 0,
      b = r[5] >>> 0,
      c = r[6] >>> 0;
    switch (fn) {
      case 0: {
        const size = Math.ceil(a / 8) * 8;
        check(
          size <= 0x7000 && this.systemHeap + size <= 0x8000f000,
          'PSF_DRIVER',
          'BIOS system heap',
        );
        r[2] = this.systemHeap;
        this.systemHeap += size;
        break;
      }
      case 2: {
        const index = a & 3;
        if (index === 3) {
          r[2] = 0;
          break;
        }
        let mode = 0;
        if (c & 0x1000) mode |= 0x50;
        if (c & 0x100) mode |= 8;
        if (c & 0x10) mode |= 1;
        if (c & 1) mode |= index === 2 ? 0x200 : 0x100;
        machine.writeTimer(0x1f801108 + index * 16, b);
        machine.writeTimer(0x1f801104 + index * 16, mode);
        r[2] = 1;
        break;
      }
      case 3:
        r[2] = (a & 3) === 3 ? 0 : machine.readTimer(0x1f801100 + (a & 3) * 16);
        break;
      case 4:
        machine.interruptMask |= (a & 3) === 3 ? 1 : 1 << (4 + (a & 3));
        r[2] = 1;
        break;
      case 5:
        machine.interruptMask &= ~((a & 3) === 3 ? 1 : 1 << (4 + (a & 3)));
        r[2] = 1;
        break;
      case 6:
        if ((a & 3) !== 3) {
          machine.writeTimer(0x1f801100 + (a & 3) * 16, 0);
          machine.writeTimer(0x1f801104 + (a & 3) * 16, 0);
          machine.writeTimer(0x1f801108 + (a & 3) * 16, 0);
        }
        r[2] = 1;
        break;
      case 7: {
        const callbacks = this.deliverEvent(a, b);
        r[2] = 1;
        cpu.resetPC(r[31]);
        this.callbacks(cpu, callbacks);
        return false;
      }
      case 8: {
        check(
          this.events.size < 256 && (c === 0x1000 || c === 0x2000),
          'PSF_SERVICE',
          'BIOS event mode',
        );
        const id = this.nextEvent++;
        this.events.set(id, {
          classId: a,
          spec: b,
          mode: c,
          address: r[7] >>> 0,
          enabled: false,
          fired: false,
        });
        r[2] = id;
        break;
      }
      case 9:
        this.events.delete(a);
        r[2] = 1;
        break;
      case 10:
      case 11: {
        const event = this.events.get(a);
        r[2] = event?.fired ? 1 : 0;
        if (fn === 10 && event?.enabled && !event.fired) return false;
        if (event) event.fired = false;
        break;
      }
      case 12:
      case 13: {
        const event = this.events.get(a);
        if (event) {
          event.enabled = fn === 12;
          event.fired = false;
        }
        r[2] = event ? 1 : 0;
        break;
      }
      case 14: {
        const id = this.threads.size + 1;
        check(id < 8, 'PSF_SERVICE', 'BIOS thread limit');
        const saved = this.capture(cpu);
        saved.pc = a;
        saved.nextPC = (a + 4) >>> 0;
        saved.delaySlot = false;
        saved.loadRegister = 0;
        saved.registers.fill(0);
        saved.registers[29] = b;
        saved.registers[30] = b;
        saved.registers[28] = c;
        this.threads.set(id, saved);
        r[2] = id;
        break;
      }
      case 15:
        this.threads.delete(a);
        r[2] = 1;
        break;
      case 16: {
        const target = this.threads.get(a);
        check(target, 'PSF_DRIVER', 'BIOS thread identifier');
        r[2] = 1;
        cpu.resetPC(r[31]);
        this.threads.set(this.currentThread, this.capture(cpu));
        this.currentThread = a;
        this.restore(cpu, target);
        return false;
      }
      case 0x17: {
        check(
          this.interruptFrames.length > 0,
          'PSF_DRIVER',
          'BIOS exception return',
        );
        const frame = this.interruptFrames.pop();
        check(frame, 'PSF_DRIVER', 'BIOS exception return');
        this.restore(cpu, frame.saved);
        return false;
      }
      case 0x18:
        this.hook = 0;
        r[2] = 0;
        break;
      case 0x19:
        this.range(a, 48);
        this.hook = a;
        r[2] = 0;
        break;
      case 0x3d:
        r[2] = b & 255;
        break;
      case 0x3f:
        r[2] = this.string(a).length;
        break;
      case 0x56:
        r[2] = 0x80001400;
        break;
      case 0x57:
        r[2] = 0x80001000;
        break;
      case 0x12:
      case 0x13:
      case 0x14:
      case 0x15:
      case 0x16:
      case 0x4a:
      case 0x4b:
      case 0x4c:
      case 0x5b:
        r[2] = 0;
        break;
      default:
        this.unsupported(0xb0, fn);
    }
  }

  c0(fn: number, cpu: MipsCpu) {
    const r = cpu.registers,
      a = r[4] >>> 0,
      b = r[5] >>> 0;
    switch (fn) {
      case 0:
      case 1:
      case 0xc:
        r[2] = 0;
        break;
      case 2:
        this.range(b, 12);
        this.irqQueues.set(a, b);
        r[2] = 0;
        break;
      case 3:
        this.irqQueues.delete(a);
        r[2] = 0;
        break;
      case 8:
        this.systemHeap = 0x80008000;
        r[2] = 0;
        break;
      case 0xa:
        r[2] = this.clearCounters[a & 3] ? 1 : 0;
        this.clearCounters[a & 3] = b !== 0;
        break;
      default:
        this.unsupported(0xc0, fn);
    }
  }
}
