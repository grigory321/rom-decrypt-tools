import type {
  IopOptions,
  IopFile,
  IopModule,
  IopImport,
  IopExport,
  IopGuestCall,
  IopCpuState,
  IopThreadStatus,
  IopWait,
  IopEventWait,
  IopPoolWait,
  IopMailboxWait,
  IopThread,
  IopSemaphore,
  IopEvent,
  IopHandler,
  IopAlarm,
  IopTimer,
  IopFileHandle,
  IopPool,
  IopMailbox,
  IopCallbackFrame,
  IopModuleFrame,
} from './psf2-types.js';
import { check, FormatError } from './binary.js';
import { MipsCpu } from './mips-cpu.js';
import { Spu2 } from './psf2-spu.js';
import { loadIrx } from './psf2-elf.js';
import { IopHeap } from './psf2-memory.js';

const THREAD_RETURN = 0x1fff00;
const CALLBACK_RETURN = 0x1fff04;
const MODULE_RETURN = 0x1fff08;
const GUEST_RETURN = 0x1fff0c;
const CLOCK = 36864000;

class PendingIo {
  constructor(readonly load: () => Promise<void>) {}
}

export function iopPath(path: string) {
  const parts = String(path)
    .replace(/\\/g, '/')
    .replace(/^[^:]*:/, '')
    .split('/');
  const result: string[] = [];
  for (const part of parts) {
    if (!part || part === '.') continue;
    if (part === '..') {
      check(result.length > 0, 'PSF2_FILESYSTEM');
      result.pop();
    } else result.push(part.toLowerCase());
  }
  return result.join('/');
}

function eventThread(
  thread: IopThread,
): thread is IopThread & { wait: IopEventWait } {
  return (
    thread.status === 'event' &&
    typeof thread.wait === 'object' &&
    thread.wait !== null &&
    'bits' in thread.wait
  );
}
function poolThread(
  thread: IopThread,
): thread is IopThread & { wait: IopPoolWait } {
  return (
    thread.status === 'pool' &&
    typeof thread.wait === 'object' &&
    thread.wait !== null &&
    'size' in thread.wait
  );
}
function mailboxThread(
  thread: IopThread,
): thread is IopThread & { wait: IopMailboxWait } {
  return (
    thread.status === 'mailbox' &&
    typeof thread.wait === 'object' &&
    thread.wait !== null &&
    'result' in thread.wait
  );
}

export class IopMachine {
  options: IopOptions;
  files: Map<string, IopFile>;
  ram: Uint8Array;
  view: DataView;
  scratch: Uint8Array;
  registers: Map<number, number>;
  imports: Map<number, IopImport>;
  exports: Map<string, IopExport>;
  modules: IopModule[];
  allocations: Map<number, number>;
  threads: Map<number, IopThread>;
  semaphores: Map<number, IopSemaphore>;
  events: Map<number, IopEvent>;
  handlers: Map<number, IopHandler>;
  alarms: Map<number, IopAlarm>;
  timers: Map<number, IopTimer>;
  handles: Map<number, IopFileHandle>;
  heaps: Map<number, IopHeap>;
  pools: Map<number, IopPool>;
  mailboxes: Map<number, IopMailbox>;
  nextHandle: number;
  nextObject: number;
  threadOrder: number;
  heapEnd: number;
  stackEnd: number;
  cycles: number;
  interruptsEnabled: boolean;
  pendingInterrupts: number[];
  callbacks: IopCallbackFrame[];
  moduleCalls: IopModuleFrame[];
  guestCalls: IopGuestCall[];
  current: IopThread | null;
  spu: Spu2;
  cpu: MipsCpu;
  constructor(
    files: ReadonlyMap<string, IopFile | Uint8Array>,
    options: IopOptions = {},
  ) {
    this.options = options;
    this.files = new Map(
      [...files].map(([path, file]) => [
        path,
        file instanceof Uint8Array ? { bytes: file, size: file.length } : file,
      ]),
    );
    this.ram = new Uint8Array(0x200000);
    this.view = new DataView(this.ram.buffer);
    this.scratch = new Uint8Array(1024);
    this.registers = new Map();
    this.imports = new Map();
    this.exports = new Map();
    this.modules = [];
    this.allocations = new Map();
    this.threads = new Map();
    this.semaphores = new Map();
    this.events = new Map();
    this.handlers = new Map();
    this.alarms = new Map();
    this.timers = new Map();
    this.handles = new Map();
    this.heaps = new Map();
    this.pools = new Map();
    this.mailboxes = new Map();
    this.nextHandle = 3;
    this.nextObject = 1;
    this.threadOrder = 1;
    this.heapEnd = 0x10000;
    this.stackEnd = 0x1f0000;
    this.cycles = 0;
    this.interruptsEnabled = true;
    this.pendingInterrupts = [];
    this.callbacks = [];
    this.moduleCalls = [];
    this.guestCalls = [];
    this.current = null;
    this.spu = new Spu2(() => this.raiseInterrupt(9));
    this.cpu = new MipsCpu(this);
    const main = this.loadPath('psf2.irx');
    main.started = true;
    const argv = this.allocate(16);
    const name = this.allocate(32);
    this.writeString(name, 'psf2.irx');
    this.write32(argv, name);
    const thread = this.createThread(main.entry, 0x10000, 32, main.gp);
    thread.registers[4] = 1;
    thread.registers[5] = argv;
    thread.status = 'ready';
    this.schedule();
  }

  abort() {
    if (
      this.options.signal?.aborted ||
      this.options.cancelled?.() ||
      this.options.isCancelled?.()
    )
      throw new FormatError('CANCELLED');
  }

  memoryRange(address: number, length: number) {
    address = (address >>> 0) & 0x1fffffff;
    check(
      Number.isSafeInteger(length) &&
        length >= 0 &&
        address < this.ram.length &&
        address + length <= this.ram.length,
      'PSF2_MEMORY',
      'IOP RAM range',
    );
    return address;
  }

  allocate(size: number, mode = 0, requested = 0) {
    check(
      Number.isSafeInteger(size) && size > 0 && size <= 0x200000,
      'PSF2_MEMORY',
      'Allocation size',
    );
    const length = Math.ceil(size / 256) * 256;
    let address = 0x10000;
    const occupied = [...this.allocations].sort((a, b) => a[0] - b[0]);
    if (mode === 1) {
      let end = this.stackEnd;
      for (const [start, count] of occupied.toReversed()) {
        if (end - start - count >= length) break;
        end = start;
      }
      address = end - length;
    } else if (mode === 0) {
      for (const [start, count] of occupied) {
        if (start - address >= length) break;
        address = Math.max(address, start + count);
      }
    }
    if (mode === 2) {
      address = (requested >>> 0) & 0x1fffffff;
      check(
        !(address & 255) && address >= 0x10000,
        'PSF2_MEMORY',
        'Fixed allocation',
      );
      for (const [start, count] of this.allocations)
        check(
          address + length <= start || address >= start + count,
          'PSF2_MEMORY',
          'Overlapping allocation',
        );
    } else
      check(mode === 0 || mode === 1, 'PSF2_UNSUPPORTED', 'Allocation mode');
    check(
      address + length <= this.stackEnd,
      'PSF2_MEMORY',
      'IOP RAM exhausted',
    );
    this.heapEnd = Math.max(this.heapEnd, address + length);
    this.allocations.set(address, length);
    this.ram.fill(0, address, address + length);
    return address;
  }

  reserveRanges(ranges: { address: number; length: number }[]) {
    const reserved: { start: number; end: number }[] = [];
    for (const range of [...ranges].sort((a, b) => a.address - b.address)) {
      check(
        Number.isSafeInteger(range.address) &&
          Number.isSafeInteger(range.length) &&
          range.address >= 0x10000 &&
          range.length > 0 &&
          range.address + range.length <= this.stackEnd,
        'PSF2_MEMORY',
        'Fixed ELF RAM range',
      );
      const start = Math.floor(range.address / 256) * 256;
      const end = Math.ceil((range.address + range.length) / 256) * 256;
      const previous = reserved.at(-1);
      if (previous && start <= previous.end)
        previous.end = Math.max(previous.end, end);
      else reserved.push({ start, end });
    }
    for (const range of reserved)
      for (const [start, length] of this.allocations)
        check(
          range.end <= start || range.start >= start + length,
          'PSF2_MEMORY',
          'Fixed ELF overlaps allocation',
        );
    for (const range of reserved) {
      this.allocations.set(range.start, range.end - range.start);
      this.heapEnd = Math.max(this.heapEnd, range.end);
    }
  }

  read8(address: number): number {
    const physical = (address >>> 0) & 0x1fffffff;
    if (physical < 0x200000) return this.ram[physical];
    if (physical >= 0x1f800000 && physical < 0x1f800400)
      return this.scratch[physical - 0x1f800000];
    return (this.read16(address & ~1) >>> ((address & 1) * 8)) & 255;
  }

  read16(address: number): number {
    const physical = (address >>> 0) & 0x1fffffff;
    if (physical < 0x1fffff) return this.view.getUint16(physical, true);
    if (physical >= 0x1f900000 && physical < 0x1f900800)
      return this.spu.read16(physical);
    if (physical >= 0x1f800000 && physical < 0x1f8003ff)
      return (
        this.scratch[physical - 0x1f800000] |
        (this.scratch[physical - 0x1f800000 + 1] << 8)
      );
    if (physical >= 0x1f801000 && physical <= 0x1f808300)
      return (this.read32(physical & ~3) >>> ((physical & 2) * 8)) & 65535;
    throw new FormatError('PSF2_MEMORY', `IOP read16 ${physical.toString(16)}`);
  }

  read32(address: number): number {
    const physical = (address >>> 0) & 0x1fffffff;
    if (physical < 0x1ffffd) return this.view.getUint32(physical, true);
    if (physical >= 0x1f900000 && physical < 0x1f9007fd)
      return (
        (this.spu.read16(physical) | (this.spu.read16(physical + 2) << 16)) >>>
        0
      );
    if (physical >= 0x1f800000 && physical < 0x1f8003fd)
      return (this.read16(physical) | (this.read16(physical + 2) << 16)) >>> 0;
    if (physical >= 0x1f801000 && physical <= 0x1f808300) {
      if (physical === 0x1f801078) return 1;
      if (
        [
          0x1f801100, 0x1f801110, 0x1f801120, 0x1f801480, 0x1f801490,
          0x1f8014a0,
        ].includes(physical)
      )
        return this.cycles & 65535;
      return this.registers.get(physical) || 0;
    }
    if (physical === 0x1ffe0130) return 0;
    throw new FormatError('PSF2_MEMORY', `IOP read32 ${physical.toString(16)}`);
  }

  write8(address: number, value: number) {
    const physical = (address >>> 0) & 0x1fffffff;
    if (physical < 0x200000) this.ram[physical] = value;
    else if (physical >= 0x1f800000 && physical < 0x1f800400)
      this.scratch[physical - 0x1f800000] = value;
    else
      this.write16(
        address & ~1,
        (this.read16(address & ~1) & ~(255 << ((address & 1) * 8))) |
          ((value & 255) << ((address & 1) * 8)),
      );
  }

  write16(address: number, value: number) {
    const physical = (address >>> 0) & 0x1fffffff;
    if (physical < 0x1fffff) this.view.setUint16(physical, value, true);
    else if (physical >= 0x1f900000 && physical < 0x1f900800)
      this.spu.write16(physical, value);
    else if (physical >= 0x1f800000 && physical < 0x1f8003ff) {
      this.scratch[physical - 0x1f800000] = value;
      this.scratch[physical - 0x1f800000 + 1] = value >>> 8;
    } else if (physical >= 0x1f801000 && physical <= 0x1f808300) {
      const aligned = physical & ~3;
      const shift = (physical & 2) * 8;
      this.write32(
        aligned,
        (this.read32(aligned) & ~(65535 << shift)) | ((value & 65535) << shift),
      );
    } else
      throw new FormatError(
        'PSF2_MEMORY',
        `IOP write16 ${physical.toString(16)}`,
      );
  }

  write32(address: number, value: number) {
    const physical = (address >>> 0) & 0x1fffffff;
    if (physical < 0x1ffffd) this.view.setUint32(physical, value, true);
    else if (physical >= 0x1f900000 && physical < 0x1f9007fd) {
      this.spu.write16(physical, value);
      this.spu.write16(physical + 2, value >>> 16);
    } else if (physical >= 0x1f800000 && physical < 0x1f8003fd) {
      this.write16(physical, value);
      this.write16(physical + 2, value >>> 16);
    } else if (physical >= 0x1f801000 && physical <= 0x1f808300) {
      this.registers.set(physical, value >>> 0);
      if (
        (physical === 0x1f8010c8 || physical === 0x1f801508) &&
        value & 0x1000000
      ) {
        const core = physical === 0x1f8010c8 ? 0 : 1;
        const base = physical - 8;
        const block = this.registers.get(base + 4) || 0;
        const count = block & 65535;
        const length = count * (value & 0x600 ? block >>> 16 : 1) * 4;
        const source = this.registers.get(base) || 0;
        this.memoryRange(source, length);
        this.spu.transfer(core, this, source, length, !!(value & 1));
        this.registers.set(physical, value & ~0x1000000);
        this.registers.set(base, source + length);
        this.raiseInterrupt(core ? 40 : 36);
      }
    } else if (physical !== 0x1ffe0130)
      throw new FormatError(
        'PSF2_MEMORY',
        `IOP write32 ${physical.toString(16)}`,
      );
  }

  readString(address: number, maximum = 4096) {
    let result = '';
    for (let index = 0; index < maximum; index++) {
      const value = this.read8(address + index);
      if (!value) return result;
      result += String.fromCharCode(value);
    }
    throw new FormatError('PSF2_MEMORY', 'Unterminated IOP string');
  }

  writeString(address: number, value: string) {
    this.memoryRange(address, value.length + 1);
    for (let index = 0; index < value.length; index++)
      this.write8(address + index, value.charCodeAt(index));
    this.write8(address + value.length, 0);
    return address;
  }

  loadPath(path: string): IopModule {
    const key = iopPath(path);
    const file = this.files.get(key);
    check(file, 'PSF2_MODULE', `Missing module ${path}`);
    if (!file.bytes)
      throw new PendingIo(async () => {
        check(
          file.size <= 8 * 1024 ** 2,
          'PSF2_MODULE',
          'IRX file exceeds bounded module cache',
        );
        check(file.source, 'PSF2_FILESYSTEM', 'Missing IRX file source');
        const bytes = await file.source.read(0, file.size);
        check(
          bytes instanceof Uint8Array && bytes.length === file.size,
          'PSF2_FILESYSTEM',
          'Truncated IRX file',
        );
        file.bytes = bytes;
      });
    const module = loadIrx(this, file.bytes, key);
    if (key !== 'psf2.irx' && file.source) file.bytes = null;
    return module;
  }

  capture(): IopCpuState {
    return {
      registers: this.cpu.registers.slice(),
      pc: this.cpu.pc,
      nextPC: this.cpu.nextPC,
      hi: this.cpu.hi,
      lo: this.cpu.lo,
      loadRegister: this.cpu.loadRegister,
      loadValue: this.cpu.loadValue,
      delaySlot: this.cpu.delaySlot,
      guestCalls: this.guestCalls.map((call) => ({ ...call })),
    };
  }

  restore(state: IopCpuState) {
    this.cpu.registers.set(state.registers);
    this.guestCalls = (state.guestCalls || []).map((call) => ({ ...call }));
    this.cpu.pc = state.pc;
    this.cpu.nextPC = state.nextPC;
    this.cpu.hi = state.hi;
    this.cpu.lo = state.lo;
    this.cpu.loadRegister = state.loadRegister;
    this.cpu.loadValue = state.loadValue;
    this.cpu.delaySlot = state.delaySlot;
  }

  createThread(entry: number, stackSize: number, priority = 32, gp = 0) {
    check(
      Number.isSafeInteger(stackSize) &&
        stackSize > 0 &&
        stackSize <= 0x100000 &&
        !(entry & 3),
      'PSF2_KERNEL',
      'Thread parameters',
    );
    const length = Math.ceil(stackSize / 256) * 256;
    this.stackEnd -= length;
    check(
      this.stackEnd > this.heapEnd,
      'PSF2_MEMORY',
      'Thread stack exhausted',
    );
    const registers = new Int32Array(32);
    registers[28] = gp;
    registers[29] = this.stackEnd + length - 32;
    registers[30] = registers[29];
    registers[31] = THREAD_RETURN;
    const thread: IopThread = {
      id: this.nextObject++,
      order: this.threadOrder++,
      priority,
      registers,
      pc: entry,
      nextPC: entry + 4,
      hi: 0,
      lo: 0,
      loadRegister: 0,
      loadValue: 0,
      delaySlot: false,
      status: 'dormant',
      wait: null,
      guestCalls: [],
      wake: Infinity,
      wakeups: 0,
      entry,
      stackBase: this.stackEnd,
      stackSize: length,
      initialPriority: priority,
      initialGp: gp,
    };
    this.threads.set(thread.id, thread);
    return thread;
  }

  schedule() {
    if (this.callbacks.length || this.moduleCalls.length) return;
    for (const thread of this.threads.values())
      if (thread.status === 'delay' && thread.wake <= this.cycles)
        thread.status = 'ready';
    const ready =
      [...this.threads.values()]
        .filter((thread) => thread.status === 'ready')
        .sort((a, b) => a.priority - b.priority || a.order - b.order)[0] ||
      null;
    if (this.current && this.current.status === 'running') {
      if (!ready || ready.priority >= this.current.priority) return;
      this.saveThread(this.current, 'ready', this.current.wait);
    }
    this.current = ready;
    if (this.current) {
      this.restore(this.current);
      this.current.status = 'running';
    }
  }

  saveThread(thread: IopThread, status: IopThreadStatus, wait: IopWait) {
    const state = this.capture();
    thread.registers = state.registers;
    thread.pc = state.pc;
    thread.nextPC = state.nextPC;
    thread.hi = state.hi;
    thread.lo = state.lo;
    thread.loadRegister = state.loadRegister;
    thread.loadValue = state.loadValue;
    thread.delaySlot = state.delaySlot;
    thread.guestCalls = state.guestCalls;
    thread.status = status;
    thread.wait = wait;
    thread.order = this.threadOrder++;
  }

  suspend(status: IopThreadStatus, wait: IopWait = null) {
    check(
      this.current && !this.callbacks.length && !this.moduleCalls.length,
      'PSF2_UNSUPPORTED',
      'Blocking service in callback/module start',
    );
    this.saveThread(this.current, status, wait);
    this.current = null;
    this.schedule();
  }

  returnValue(value = 0) {
    this.cpu.registers[2] = value;
    this.cpu.resetPC(this.cpu.registers[31] >>> 0);
  }

  registerLibrary(address: number) {
    check(
      this.read32(address) === 0x41c00000,
      'PSF2_KERNEL',
      'Invalid export table',
    );
    let name = '';
    for (let index = 0; index < 8; index++) {
      const value = this.read8(address + 12 + index);
      if (!value) break;
      name += String.fromCharCode(value);
    }
    const entries: number[] = [];
    for (let index = 0; index < 4096; index++) {
      const entry = this.read32(address + 20 + index * 4);
      if (!entry) break;
      this.memoryRange(entry, 4);
      entries.push(entry);
    }
    check(entries.length, 'PSF2_KERNEL', 'Empty export table');
    this.exports.set(name, { address, entries });
    return 0;
  }

  startModule(
    module: IopModule | undefined,
    argsLength = 0,
    argsAddress = 0,
    resultAddress = 0,
  ) {
    check(
      module && !module.started && argsLength <= 65536,
      'PSF2_MODULE',
      'Invalid module start',
    );
    module.started = true;
    const frame = { state: this.capture(), module, resultAddress };
    frame.state.registers[2] = module.id;
    frame.state.pc = this.cpu.registers[31] >>> 0;
    frame.state.nextPC = frame.state.pc + 4;
    frame.state.delaySlot = false;
    this.moduleCalls.push(frame);
    this.guestCalls = [];
    const argumentsList = [module.name];
    if (argsLength) {
      this.memoryRange(argsAddress, argsLength);
      let current = '';
      for (let index = 0; index < argsLength; index++) {
        const value = this.read8(argsAddress + index);
        if (value) current += String.fromCharCode(value);
        else if (current) {
          argumentsList.push(current);
          current = '';
        }
      }
      if (current) argumentsList.push(current);
    }
    const argv = this.allocate((argumentsList.length + 1) * 4);
    for (let index = 0; index < argumentsList.length; index++)
      this.write32(
        argv + index * 4,
        this.writeString(
          this.allocate(argumentsList[index].length + 1),
          argumentsList[index],
        ),
      );
    this.cpu.registers[4] = argumentsList.length;
    this.cpu.registers[5] = argv;
    this.cpu.registers[28] = module.gp;
    this.cpu.registers[31] = MODULE_RETURN;
    this.cpu.resetPC(module.entry);
  }

  raiseInterrupt(line: number) {
    if (this.handlers.has(line) && !this.pendingInterrupts.includes(line))
      this.pendingInterrupts.push(line);
  }

  callback(
    address: number,
    args: number[],
    alarm: IopAlarm | null = null,
    gp: number | null = null,
  ) {
    this.callbacks.push({
      state: this.capture(),
      current: this.current,
      alarm,
    });
    this.guestCalls = [];
    for (let index = 0; index < args.length; index++)
      this.cpu.registers[4 + index] = args[index];
    this.cpu.registers[29] = 0x1ffe00 - this.callbacks.length * 0x200;
    this.cpu.registers[31] = CALLBACK_RETURN;
    if (gp !== null) this.cpu.registers[28] = gp;
    this.cpu.resetPC(address);
  }

  intercept(cpu: MipsCpu) {
    const address = cpu.pc & 0x1fffffff;
    const call = this.imports.get(address);
    if (
      ![THREAD_RETURN, CALLBACK_RETURN, MODULE_RETURN, GUEST_RETURN].includes(
        address,
      ) &&
      !call
    )
      return false;
    if (cpu.loadRegister) {
      cpu.registers[cpu.loadRegister] = cpu.loadValue;
      cpu.loadRegister = 0;
    }
    if (address === CALLBACK_RETURN) {
      const value = cpu.registers[2] >>> 0;
      const callback = this.callbacks.pop();
      check(callback, 'PSF2_KERNEL');
      if (callback.alarm && value) {
        callback.alarm.due = this.cycles + value;
        this.alarms.set(callback.alarm.id, callback.alarm);
      }
      this.restore(callback.state);
      this.current = callback.current;
      return true;
    }
    if (address === MODULE_RETURN) {
      const frame = this.moduleCalls.pop();
      check(frame, 'PSF2_KERNEL');
      if (frame.resultAddress)
        this.write32(frame.resultAddress, cpu.registers[2]);
      this.restore(frame.state);
      return true;
    }
    if (address === GUEST_RETURN) {
      const frame = this.guestCalls.pop();
      check(frame, 'PSF2_KERNEL', 'Guest library return without caller');
      cpu.registers[28] = frame.gp;
      cpu.registers[31] = frame.ra;
      cpu.resetPC(frame.ra);
      return true;
    }
    if (address === THREAD_RETURN) {
      check(this.current, 'PSF2_KERNEL', 'Return without thread');
      this.current.status = 'dormant';
      this.current = null;
      this.schedule();
      return true;
    }
    check(call, 'PSF2_KERNEL', 'Missing import');
    const guest = this.exports.get(call.library)?.entries[call.id];
    if (guest) {
      this.guestCalls.push({
        gp: cpu.registers[28],
        ra: cpu.registers[31] >>> 0,
      });
      const owner = this.modules.find((item) =>
        item.ranges.some((range) => guest >= range.start && guest < range.end),
      );
      if (owner) cpu.registers[28] = owner.gp;
      cpu.registers[25] = guest;
      cpu.registers[31] = GUEST_RETURN;
      cpu.resetPC(guest);
      return true;
    }
    const result = this.invoke(call.library, call.id, call.module);
    if (result !== null) this.returnValue(result);
    return true;
  }

  exception(cpu: MipsCpu, code: number): never {
    throw new FormatError(
      'PSF2_CPU',
      `IOP exception ${code} at ${cpu.instructionPC.toString(16)}`,
    );
  }

  invoke(library: string, id: number, module: string): number | null {
    const r = this.cpu.registers;
    const a = r[4] >>> 0;
    const b = r[5] >>> 0;
    const c = r[6] >>> 0;
    const d = r[7] >>> 0;
    if (library === 'sysmem') {
      if (id === 4) return this.allocate(b, a, c);
      if (id === 5) return this.allocations.delete(a) ? 0 : -1;
      if (id === 6) return this.ram.length;
      if (id === 7 || id === 8) return this.stackEnd - this.heapEnd;
      if (id === 14) return this.print(a);
    } else if (library === 'loadcore') {
      if (id === 4 || id === 5) return 0;
      if (id === 12) return 0;
      if (id === 6) return this.registerLibrary(a);
      if (id === 7) {
        for (const [name, table] of this.exports)
          if (table.address === a) this.exports.delete(name);
        return 0;
      }
    } else if (library === 'modload') {
      if (id === 7) {
        this.startModule(this.loadPath(this.readString(a)), b, c, d);
        return null;
      }
      if (id === 8) {
        this.startModule(
          this.modules.find((item) => item.id === a),
          c,
          d,
          this.read32((r[29] >>> 0) + 16),
        );
        return null;
      }
      if (id === 19) return this.loadPath(this.readString(a)).id;
      if (id === 22)
        return (
          this.modules.find((item) => item.name === iopPath(this.readString(a)))
            ?.id ?? -1
        );
      if (id === 28) return this.allocate(b);
    } else if (library === 'heaplib') {
      if (id === 4) {
        const base = this.allocate(a);
        this.heaps.set(base, new IopHeap(base, a));
        return base;
      }
      const heap = this.heaps.get(a);
      if (!heap) return -1;
      if (id === 5) {
        this.heaps.delete(a);
        this.allocations.delete(a);
        return 0;
      }
      if (id === 6) return heap.allocate(b);
      if (id === 7) return heap.free(b) ? 0 : -1;
    } else if (library === 'sysclib') return this.libc(id, a, b, c);
    else if (library === 'stdio' && id === 4) return this.print(a);
    else if (library === 'ioman' || library === 'iomanx')
      return this.fileService(id, a, b, c);
    else if (library === 'intrman') {
      if (id === 4) {
        check(a <= 63 && !(c & 3), 'PSF2_KERNEL');
        this.handlers.set(a, {
          address: c,
          argument: d,
          enabled: false,
          gp: r[28],
        });
        return 0;
      }
      if (id === 5) return this.handlers.delete(a) ? 0 : -1;
      if (id === 6 || id === 7) {
        const handler = this.handlers.get(a);
        if (handler) handler.enabled = id === 6;
        if (id === 7 && b) this.write32(b, a);
        return 0;
      }
      if (id === 8 || id === 9 || id === 17 || id === 18) {
        if (id === 17 && a) this.write32(a, this.interruptsEnabled ? 1 : 0);
        this.interruptsEnabled = id === 9 || (id === 18 && !!a);
        return 0;
      }
      if (id === 23) return this.callbacks.length ? 1 : 0;
    } else if (library === 'thbase') return this.threadService(id, a, b, c);
    else if (library === 'thsemap') return this.semaphoreService(id, a);
    else if (library === 'thevent') return this.eventService(id, a, b, c, d);
    else if (library === 'thfpool' || library === 'thvpool')
      return this.poolService(library, id, a, b);
    else if (library === 'thmsgbx') return this.mailboxService(id, a, b);
    else if (library === 'timrman') return this.timerService(id, a, b, c, d);
    else if (library === 'sifman') {
      if (id === 5 || id === 7) return 0;
      if (id === 8) return -1;
      if (id === 29) return 1;
    } else if (library === 'dmacman') {
      if ([14, 16, 18].includes(id)) {
        this.registers.set(0x1f8010f0 + (id - 14) * 0x78, a);
        return 0;
      }
      if ([15, 17, 19].includes(id))
        return this.registers.get(0x1f8010f0 + (id - 15) * 0x78) || 0;
      if (id === 33 || id === 34 || id === 35) return 0;
    }
    throw new FormatError(
      'PSF2_UNSUPPORTED',
      `IOP import ${library}:${id}${module ? ` in ${module}` : ''}`,
    );
  }

  print(address: number) {
    const text = this.format(address, 5);
    this.options.log?.(text);
    return text.length;
  }

  format(
    address: number,
    firstRegister = 6,
    argumentPointer: number | null = null,
  ) {
    let argument = 0;
    const next = () => {
      const index = argument++;
      if (argumentPointer !== null)
        return this.read32(argumentPointer + index * 4);
      const register = firstRegister + index;
      return register < 8
        ? this.cpu.registers[register] >>> 0
        : this.read32((this.cpu.registers[29] >>> 0) + 16 + (register - 8) * 4);
    };
    const input = this.readString(address);
    const pattern = /%([-+ #0]*)(\d*)(?:\.(\d+))?([cdisuxXop%])/g;
    check(
      !input.replace(pattern, '').includes('%'),
      'PSF2_UNSUPPORTED',
      'IOP printf conversion',
    );
    const output = input.replace(
      pattern,
      (
        _match: string,
        flags: string,
        widthText: string,
        precisionText: string | undefined,
        type: string,
      ) => {
        if (type === '%') return '%';
        const value = next();
        const width = Math.min(4096, Number(widthText) || 0);
        const precision =
          precisionText === undefined
            ? null
            : Math.min(4096, Number(precisionText));
        let text: string;
        if (type === 's')
          text = this.readString(value).slice(0, precision ?? 4096);
        else if (type === 'c') text = String.fromCharCode(value & 255);
        else {
          const signed = type === 'd' || type === 'i';
          const number = signed ? value | 0 : value >>> 0;
          const base =
            type === 'x' || type === 'X' || type === 'p'
              ? 16
              : type === 'o'
                ? 8
                : 10;
          text = Math.abs(number).toString(base);
          if (precision !== null) text = text.padStart(precision, '0');
          if (number < 0) text = '-' + text;
          else if (signed && flags.includes('+')) text = '+' + text;
          if (type === 'p' || (flags.includes('#') && base === 16 && number))
            text = '0x' + text;
          if (type === 'X') text = text.toUpperCase();
        }
        return flags.includes('-')
          ? text.padEnd(width, ' ')
          : text.padStart(width, flags.includes('0') ? '0' : ' ');
      },
    );
    check(output.length <= 16384, 'PSF2_MEMORY', 'IOP printf output');
    return output;
  }

  libc(id: number, a: number, b: number, c: number) {
    if (id === 19 || id === 42) {
      const text = this.format(b, 6, id === 42 ? c : null);
      this.writeString(a, text);
      return text.length;
    }
    if (id === 6 || id === 7)
      return (
        id === 6
          ? String.fromCharCode(a & 255).toUpperCase()
          : String.fromCharCode(a & 255).toLowerCase()
      ).charCodeAt(0);
    if (id === 11 || id === 15) {
      this.memoryRange(a, c);
      this.memoryRange(b, c);
      for (let index = 0; index < c; index++)
        if (this.read8(a + index) !== this.read8(b + index))
          return this.read8(a + index) - this.read8(b + index);
      return 0;
    }
    if (id === 12 || id === 13 || id === 16 || id === 40) {
      let destination = a;
      let source = b;
      let count = id === 40 ? c * 2 : c;
      if (id === 16) {
        destination = b;
        source = a;
      }
      destination = this.memoryRange(destination, count);
      source = this.memoryRange(source, count);
      this.ram.copyWithin(destination, source, source + count);
      return a;
    }
    if (id === 14 || id === 17 || id === 41) {
      const count = id === 17 ? b : id === 41 ? c * 2 : c;
      const destination = this.memoryRange(a, count);
      if (id === 41)
        for (let index = 0; index < count; index += 2)
          this.view.setUint16(destination + index, b, true);
      else
        this.ram.fill(
          id === 17 ? 0 : b & 255,
          destination,
          destination + count,
        );
      return a;
    }
    if (id === 27) return this.readString(a).length;
    if (id === 22 || id === 29) {
      const count = id === 29 ? c : 4096;
      check(count <= 0x200000, 'PSF2_MEMORY');
      for (let index = 0; index < count; index++) {
        const av = this.read8(a + index);
        const bv = this.read8(b + index);
        if (av !== bv || !av) return av - bv;
      }
      return 0;
    }
    if (id === 23) return this.writeString(a, this.readString(b));
    if (id === 30) {
      const destination = this.memoryRange(a, c);
      const value = this.readString(b);
      this.ram.fill(0, destination, destination + c);
      for (let index = 0; index < Math.min(c, value.length); index++)
        this.ram[destination + index] = value.charCodeAt(index);
      return a;
    }
    if (id === 20)
      return this.writeString(a, this.readString(a) + this.readString(b));
    if (id === 21 || id === 25 || id === 32) {
      const text = this.readString(a);
      const index =
        id === 32
          ? text.lastIndexOf(String.fromCharCode(b & 255))
          : text.indexOf(String.fromCharCode(b & 255));
      if (!(b & 255)) return a + text.length;
      return index < 0 ? 0 : a + index;
    }
    if (id === 34) {
      const index = this.readString(a).indexOf(this.readString(b));
      return index < 0 ? 0 : a + index;
    }
    if (id === 4) {
      const saved = [31, 29, 30, 16, 17, 18, 19, 20, 21, 22, 23, 28];
      for (let index = 0; index < saved.length; index++)
        this.write32(a + index * 4, this.cpu.registers[saved[index]]);
      return 0;
    }
    if (id === 5) {
      const saved = [31, 29, 30, 16, 17, 18, 19, 20, 21, 22, 23, 28];
      for (let index = 0; index < saved.length; index++)
        this.cpu.registers[saved[index]] = this.read32(a + index * 4);
      this.returnValue(b || 1);
      return null;
    }
    throw new FormatError('PSF2_UNSUPPORTED', `IOP import sysclib:${id}`);
  }

  fileService(id: number, a: number, b: number, c: number) {
    if (id === 4) {
      if ((b & 3) !== 1) return -13;
      const file = this.files.get(iopPath(this.readString(a)));
      if (!file) return -2;
      const handle = this.nextHandle++;
      this.handles.set(handle, { file, position: 0, pending: null });
      return handle;
    }
    if (id === 5) return this.handles.delete(a) ? 0 : -9;
    if (id === 6) {
      const file = this.handles.get(a);
      if (!file) return -9;
      const count = Math.min(c, file.file.size - file.position);
      const destination = this.memoryRange(b, count);
      if (!count) return 0;
      if (file.file.bytes)
        this.ram.set(
          file.file.bytes.subarray(file.position, file.position + count),
          destination,
        );
      else {
        if (
          !file.pending ||
          file.pending.position !== file.position ||
          file.pending.count !== count
        )
          throw new PendingIo(async () => {
            this.abort();
            check(
              file.file.source,
              'PSF2_FILESYSTEM',
              'Missing IOP file source',
            );
            const bytes = await file.file.source.read(file.position, count);
            check(
              bytes instanceof Uint8Array && bytes.length === count,
              'PSF2_FILESYSTEM',
              'Truncated IOP read',
            );
            file.pending = { position: file.position, count, bytes };
          });
        this.ram.set(file.pending.bytes, destination);
        file.pending = null;
      }
      file.position += count;
      return count;
    }
    if (id === 7 && (a === 1 || a === 2)) {
      this.memoryRange(b, c);
      this.options.log?.(
        String.fromCharCode(...this.ram.subarray(b, b + Math.min(c, 4096))),
      );
      return c;
    }
    if (id === 8) {
      const file = this.handles.get(a);
      if (!file) return -9;
      const position =
        (c === 0
          ? 0
          : c === 1
            ? file.position
            : c === 2
              ? file.file.size
              : NaN) +
        (b | 0);
      if (
        !Number.isSafeInteger(position) ||
        position < 0 ||
        position > file.file.size
      )
        return -22;
      file.position = position;
      return position;
    }
    throw new FormatError('PSF2_UNSUPPORTED', `IOP import ioman:${id}`);
  }

  threadService(id: number, a: number, b: number, c: number) {
    if (id === 4)
      return this.createThread(
        this.read32(a + 8),
        this.read32(a + 12),
        this.read32(a + 16),
        this.cpu.registers[28],
      ).id;
    if (id === 5) return this.threads.delete(a) ? 0 : -1;
    if (id === 6 || id === 7) {
      const thread = this.threads.get(a);
      if (!thread || thread.status !== 'dormant') return -1;
      const argumentBytes = id === 7 ? Math.ceil(b / 4) * 4 : 0;
      check(
        Number.isSafeInteger(argumentBytes) &&
          argumentBytes <= thread.stackSize - 32,
        'PSF2_MEMORY',
        'Thread arguments exceed stack',
      );
      const source = id === 7 && b ? this.memoryRange(c, b) : 0;
      thread.registers.fill(0);
      thread.registers[28] = thread.initialGp;
      thread.registers[29] =
        thread.stackBase + thread.stackSize - argumentBytes - 32;
      thread.registers[30] = thread.registers[29];
      thread.registers[31] = THREAD_RETURN;
      thread.pc = thread.entry;
      thread.nextPC = thread.entry + 4;
      thread.priority = thread.initialPriority;
      thread.hi = thread.lo = thread.loadRegister = thread.loadValue = 0;
      thread.delaySlot = false;
      thread.guestCalls = [];
      thread.wake = Infinity;
      thread.wakeups = 0;
      thread.wait = null;
      thread.order = this.threadOrder++;
      thread.registers[4] = b;
      if (id === 7) {
        const destination = thread.stackBase + thread.stackSize - argumentBytes;
        if (b) this.ram.copyWithin(destination, source, source + b);
        thread.registers[5] = destination;
      } else
        this.ram.fill(
          0,
          thread.stackBase +
            thread.stackSize -
            Math.min(thread.stackSize, 0xb8),
          thread.stackBase + thread.stackSize,
        );
      thread.status = 'ready';
      return 0;
    }
    if (id === 8 || id === 9) {
      this.returnValue(0);
      this.suspend('dormant');
      return null;
    }
    if (id === 10) {
      const thread = this.threads.get(a);
      if (!thread) return -1;
      thread.status = 'dormant';
      return 0;
    }
    if (id === 14) {
      const thread = a ? this.threads.get(a) : this.current;
      if (!thread) return -1;
      thread.priority = b;
      return 0;
    }
    if (id === 16) {
      this.returnValue(0);
      this.suspend('ready');
      return null;
    }
    if (id === 18 || id === 19 || id === 25 || id === 26) {
      const thread = this.threads.get(a);
      if (!thread) return -1;
      if (['sleep', 'delay', 'semaphore', 'event'].includes(thread.status))
        thread.status = 'ready';
      else thread.wakeups++;
      return 0;
    }
    if (id === 20) return this.current?.id || 0;
    if (id === 24 || id === 33) {
      if (id === 24 && this.current?.wakeups) {
        this.current.wakeups--;
        return 0;
      }
      const thread = this.current;
      check(thread, 'PSF2_KERNEL', 'Blocking service without thread');
      this.returnValue(0);
      if (id === 33)
        thread.wake =
          this.cycles + Math.max(1, Math.ceil((a * CLOCK) / 1000000));
      this.suspend(id === 33 ? 'delay' : 'sleep');
      return null;
    }
    if (id === 27 || id === 28) {
      const thread = this.threads.get(a);
      if (!thread) return -1;
      const count = thread.wakeups;
      thread.wakeups = 0;
      return count;
    }
    if (id === 34) {
      this.write32(a, this.cycles);
      this.write32(a + 4, Math.floor(this.cycles / 0x100000000));
      return 0;
    }
    if (id === 35 || id === 36) {
      const delay = this.read32(a) + this.read32(a + 4) * 0x100000000;
      const alarm = {
        id: this.nextObject++,
        due: this.cycles + Math.max(1, delay),
        address: b,
        argument: c,
        gp: this.cpu.registers[28],
      };
      this.alarms.set(alarm.id, alarm);
      return alarm.id;
    }
    if (id === 37 || id === 38) {
      for (const [key, alarm] of this.alarms)
        if (alarm.address === a && alarm.argument === b)
          this.alarms.delete(key);
      return 0;
    }
    if (id === 39) {
      const clock = Math.round((a * CLOCK) / 1000000);
      this.write32(b, clock);
      this.write32(b + 4, Math.floor(clock / 0x100000000));
      return 0;
    }
    if (id === 40) {
      const clock = this.read32(a) + this.read32(a + 4) * 0x100000000;
      if (b) this.write32(b, Math.floor(clock / CLOCK));
      if (c) this.write32(c, Math.floor((clock * 1000000) / CLOCK) % 1000000);
      return 0;
    }
    if (id === 42) return this.current?.priority || 0;
    if (id === 43) return this.cycles;
    throw new FormatError('PSF2_UNSUPPORTED', `IOP import thbase:${id}`);
  }

  semaphoreService(id: number, a: number) {
    if (id === 4) {
      const key = this.nextObject++;
      this.semaphores.set(key, {
        count: this.read32(a + 8),
        maximum: this.read32(a + 12),
      });
      return key;
    }
    if (id === 5) return this.semaphores.delete(a) ? 0 : -1;
    const semaphore = this.semaphores.get(a);
    if (!semaphore) return -1;
    if (id === 6 || id === 7) {
      const waiter = [...this.threads.values()].find(
        (thread) => thread.status === 'semaphore' && thread.wait === a,
      );
      if (waiter) waiter.status = 'ready';
      else semaphore.count = Math.min(semaphore.maximum, semaphore.count + 1);
      return 0;
    }
    if (id === 8 || id === 9) {
      if (semaphore.count > 0) {
        semaphore.count--;
        return 0;
      }
      if (id === 9) return -419;
      this.returnValue(0);
      this.suspend('semaphore', a);
      return null;
    }
    throw new FormatError('PSF2_UNSUPPORTED', `IOP import thsemap:${id}`);
  }

  eventService(id: number, a: number, b: number, c: number, d: number) {
    if (id === 4) {
      const key = this.nextObject++;
      this.events.set(key, { bits: this.read32(a + 8) });
      return key;
    }
    if (id === 5) return this.events.delete(a) ? 0 : -1;
    const event = this.events.get(a);
    if (!event) return -1;
    const matches = (bits: number, mode: number) =>
      mode & 1 ? !!(event.bits & bits) : (event.bits & bits) === bits;
    if (id === 6 || id === 7) {
      event.bits |= b;
      for (const thread of this.threads.values())
        if (
          eventThread(thread) &&
          thread.wait.id === a &&
          matches(thread.wait.bits, thread.wait.mode)
        ) {
          if (thread.wait.result) this.write32(thread.wait.result, event.bits);
          thread.status = 'ready';
          if (thread.wait.mode & 16) event.bits = 0;
        }
      return 0;
    }
    if (id === 8 || id === 9) {
      event.bits &= b;
      return 0;
    }
    if (id === 10 || id === 11) {
      if (matches(b, c)) {
        if (d) this.write32(d, event.bits);
        if (c & 16) event.bits = 0;
        return 0;
      }
      if (id === 11) return -425;
      this.returnValue(0);
      this.suspend('event', { id: a, bits: b, mode: c, result: d });
      return null;
    }
    throw new FormatError('PSF2_UNSUPPORTED', `IOP import thevent:${id}`);
  }

  poolService(library: string, id: number, a: number, b: number) {
    if (id === 4) {
      const fixed =
        library === 'thfpool' ? Math.ceil(this.read32(a + 8) / 8) * 8 : 0;
      const count = fixed ? this.read32(a + 12) : 1;
      const size = fixed ? fixed * count : this.read32(a + 8);
      check(
        Number.isSafeInteger(size) && size > 0 && size <= 0x200000,
        'PSF2_KERNEL',
        'IOP pool size',
      );
      const base = this.allocate(size);
      const key = this.nextObject++;
      this.pools.set(key, {
        library,
        heap: new IopHeap(base, size),
        fixed,
        attributes: this.read32(a),
        options: this.read32(a + 4),
      });
      return key;
    }
    const pool = this.pools.get(a);
    if (!pool || pool.library !== library) return -1;
    if (id === 5) {
      this.pools.delete(a);
      this.allocations.delete(pool.heap.base);
      return 0;
    }
    if (id === 6 || id === 7 || id === 8) {
      const size = pool.fixed || b;
      const address = pool.heap.allocate(size);
      if (address) return address;
      if (id !== 6) return -400;
      this.returnValue(0);
      this.suspend('pool', { id: a, size });
      return null;
    }
    if (id === 9) {
      if (!pool.heap.free(b)) return -1;
      for (const thread of this.threads.values())
        if (poolThread(thread) && thread.wait.id === a) {
          const address = pool.heap.allocate(thread.wait.size);
          if (!address) break;
          thread.registers[2] = address;
          thread.status = 'ready';
        }
      return 0;
    }
    if (id === 11 && library === 'thvpool') {
      for (const [offset, value] of [
        [0, pool.attributes],
        [4, pool.options],
        [8, pool.heap.size],
        [12, pool.heap.available],
        [
          16,
          [...this.threads.values()].filter(
            (thread) => poolThread(thread) && thread.wait.id === a,
          ).length,
        ],
      ])
        this.write32(b + offset, value);
      return 0;
    }
    throw new FormatError('PSF2_UNSUPPORTED', `IOP import ${library}:${id}`);
  }

  mailboxService(id: number, a: number, b: number) {
    if (id === 4) {
      const key = this.nextObject++;
      this.mailboxes.set(key, {
        messages: [],
        attributes: this.read32(a),
        options: this.read32(a + 4),
      });
      return key;
    }
    if (id === 5) return this.mailboxes.delete(a) ? 0 : -1;
    const mailbox = this.mailboxes.get(id === 8 || id === 9 ? b : a);
    if (!mailbox) return -1;
    if (id === 6 || id === 7) {
      this.memoryRange(b, 8);
      const waiter = [...this.threads.values()].find(
        (thread): thread is IopThread & { wait: IopMailboxWait } =>
          mailboxThread(thread) && thread.wait.id === a,
      );
      if (waiter) {
        this.write32(waiter.wait.result, b);
        waiter.status = 'ready';
      } else {
        this.write32(b, 0);
        const previous = mailbox.messages.at(-1);
        if (previous !== undefined) this.write32(previous, b);
        mailbox.messages.push(b);
      }
      return 0;
    }
    if (id === 8 || id === 9) {
      this.memoryRange(a, 4);
      if (mailbox.messages.length) {
        const message = mailbox.messages.shift();
        check(message !== undefined, 'PSF2_KERNEL', 'Empty mailbox');
        this.write32(a, message);
        return 0;
      }
      if (id === 9) return -424;
      this.returnValue(0);
      this.suspend('mailbox', { id: b, result: a });
      return null;
    }
    if (id === 11) {
      for (const [offset, value] of [
        [0, mailbox.attributes],
        [4, mailbox.options],
        [
          8,
          [...this.threads.values()].filter(
            (thread): thread is IopThread & { wait: IopMailboxWait } =>
              mailboxThread(thread) && thread.wait.id === a,
          ).length,
        ],
        [12, mailbox.messages.length],
        [16, mailbox.messages[0] || 0],
      ])
        this.write32(b + offset, value);
      return 0;
    }
    throw new FormatError('PSF2_UNSUPPORTED', `IOP import thmsgbx:${id}`);
  }

  timerService(id: number, a: number, b: number, c: number, d: number) {
    if (![4, 6, 7, 8, 10, 11, 16, 20, 22, 23, 24].includes(id))
      throw new FormatError('PSF2_UNSUPPORTED', `IOP import timrman:${id}`);
    if (id === 4) {
      check(a === 1, 'PSF2_UNSUPPORTED', 'IOP pixel/HLine timer source');
      if (![16, 32].includes(b) || ![1, 8, 16, 256].includes(c)) return -150;
      const sizes = [16, 16, 16, 32, 32, 32];
      const maxScales = [1, 1, 8, 1, 256, 256];
      let index = 5;
      while (
        index >= 0 &&
        (sizes[index] !== b ||
          maxScales[index] < c ||
          this.timers.has(index + 1))
      )
        index--;
      if (index < 0) return -150;
      const key = index + 1;
      this.timers.set(key, {
        index,
        size: b,
        maxScale: maxScales[index],
        mode: [1, 8, 16, 256].indexOf(c) << 9,
        compare: b === 16 ? 65535 : 0xffffffff,
        running: false,
        due: Infinity,
        prescale: c,
        counter: 0,
        epoch: this.cycles,
        fired: false,
      });
      return key;
    }
    if (!a) {
      if ([7, 8, 10, 11].includes(id)) return 0;
      if (id === 16) return 4;
    }
    if (id === 6) return this.timers.delete(a) ? 0 : -151;
    const timer = this.timers.get(a);
    if (!timer) return -151;
    if (id === 7) {
      check(
        !(b & ~0x658),
        'PSF2_UNSUPPORTED',
        'IOP gated/external/overflow timer mode',
      );
      const prescale = [1, 8, 16, 256][(b >>> 9) & 3];
      check(
        prescale <= timer.maxScale,
        'PSF2_UNSUPPORTED',
        'IOP timer prescale',
      );
      this.syncTimer(timer);
      timer.mode = b;
      timer.prescale = prescale;
      timer.fired = false;
      this.scheduleTimer(timer);
      return 0;
    }
    if (id === 8) return timer.mode | 0x800;
    if (id === 10) return Math.floor(this.timerCounter(timer));
    if (id === 11) {
      timer.compare = timer.size === 16 ? b & 65535 : b >>> 0;
      timer.counter = 0;
      timer.epoch = this.cycles;
      timer.fired = false;
      this.scheduleTimer(timer);
      return 0;
    }
    if (id === 16) return [4, 5, 6, 14, 15, 16][timer.index];
    if (id === 20) {
      check(c && !(c & 3), 'PSF2_KERNEL', 'IOP timer callback address');
      this.memoryRange(c, 4);
      this.syncTimer(timer);
      timer.compare = timer.size === 16 ? b & 65535 : b >>> 0;
      this.handlers.set([4, 5, 6, 14, 15, 16][timer.index], {
        address: c,
        argument: d,
        gp: this.cpu.registers[28],
        enabled: timer.running,
      });
      timer.fired = false;
      this.scheduleTimer(timer);
      return 0;
    }
    if (id === 22) {
      check(
        b === 1 &&
          c === 0 &&
          [1, 8, 16, 256].includes(d) &&
          d <= timer.maxScale,
        'PSF2_UNSUPPORTED',
        'IOP timer source/gating/prescale',
      );
      this.syncTimer(timer);
      timer.prescale = d;
      timer.mode = (timer.mode & ~0x700) | ([1, 8, 16, 256].indexOf(d) << 9);
      this.scheduleTimer(timer);
      return 0;
    }
    if (id === 23) {
      timer.counter = 0;
      timer.epoch = this.cycles;
      timer.running = true;
      timer.mode |= 0x58;
      timer.fired = false;
      const handler = this.handlers.get([4, 5, 6, 14, 15, 16][timer.index]);
      if (handler) handler.enabled = true;
      this.scheduleTimer(timer);
      return 0;
    }
    if (id === 24) {
      this.syncTimer(timer);
      timer.running = false;
      timer.mode &= ~0x58;
      timer.due = Infinity;
      const handler = this.handlers.get([4, 5, 6, 14, 15, 16][timer.index]);
      if (handler) handler.enabled = false;
      return 0;
    }
    throw new FormatError('PSF2_UNSUPPORTED', `IOP import timrman:${id}`);
  }

  timerCounter(timer: IopTimer) {
    const ticks =
      timer.counter +
      (timer.running ? (this.cycles - timer.epoch) / timer.prescale : 0);
    const period = timer.mode & 8 ? timer.compare + 1 : 2 ** timer.size;
    return ticks % period;
  }

  syncTimer(timer: IopTimer) {
    timer.counter = this.timerCounter(timer);
    timer.epoch = this.cycles;
  }

  scheduleTimer(timer: IopTimer) {
    if (
      !timer.running ||
      !(timer.mode & 16) ||
      (timer.fired && !(timer.mode & 64))
    ) {
      timer.due = Infinity;
      return;
    }
    const current = this.timerCounter(timer);
    let distance = timer.compare + 1 - current;
    if (distance <= 0) distance += 2 ** timer.size;
    timer.due = this.cycles + Math.max(1, Math.ceil(distance * timer.prescale));
  }

  advance(target: number) {
    let steps = 0;
    while (this.cycles < target) {
      if (!(steps++ & 1023)) this.abort();
      this.schedule();
      if (
        !this.callbacks.length &&
        !this.moduleCalls.length &&
        this.interruptsEnabled
      ) {
        const line = this.pendingInterrupts.findIndex(
          (value) => this.handlers.get(value)?.enabled,
        );
        if (line >= 0) {
          const number = this.pendingInterrupts.splice(line, 1)[0];
          const handler = this.handlers.get(number);
          check(handler, 'PSF2_KERNEL', 'Missing interrupt handler');
          this.callback(handler.address, [handler.argument], null, handler.gp);
        } else {
          const alarm = [...this.alarms.values()].find(
            (item) => item.due <= this.cycles,
          );
          if (alarm) {
            this.alarms.delete(alarm.id);
            this.callback(alarm.address, [alarm.argument], alarm, alarm.gp);
          } else {
            const timer = [...this.timers.values()].find(
              (item) => item.running && item.due <= this.cycles,
            );
            if (timer) {
              timer.fired = true;
              this.raiseInterrupt([4, 5, 6, 14, 15, 16][timer.index]);
              this.scheduleTimer(timer);
            }
          }
        }
      }
      if (this.current || this.callbacks.length || this.moduleCalls.length)
        this.cycles += this.cpu.step();
      else {
        const nextThread = Math.min(
          ...[...this.threads.values()]
            .filter((thread) => thread.status === 'delay')
            .map((thread) => thread.wake),
        );
        const nextAlarm = Math.min(
          ...[...this.alarms.values()].map((alarm) => alarm.due),
        );
        const nextTimer = Math.min(
          ...[...this.timers.values()]
            .filter((timer) => timer.running)
            .map((timer) => timer.due),
        );
        this.cycles = Math.max(
          this.cycles + 1,
          Math.min(
            target,
            nextThread,
            nextAlarm,
            nextTimer,
            this.interruptsEnabled &&
              this.pendingInterrupts.some(
                (line) => this.handlers.get(line)?.enabled,
              )
              ? this.cycles + 1
              : Infinity,
          ),
        );
      }
    }
  }

  render(count: number) {
    this.abort();
    const left = new Float32Array(count);
    const right = new Float32Array(count);
    for (let frame = 0; frame < count; frame++) {
      this.advance((this.spu.samples + 1) * 768);
      const sample = this.spu.sample();
      left[frame] = sample[0];
      right[frame] = sample[1];
    }
    return [left, right];
  }

  async renderAsync(count: number) {
    this.abort();
    const left = new Float32Array(count);
    const right = new Float32Array(count);
    for (let frame = 0; frame < count; frame++) {
      while (true) {
        try {
          this.advance((this.spu.samples + 1) * 768);
          break;
        } catch (pending) {
          if (!(pending instanceof PendingIo)) throw pending;
          await pending.load();
          this.abort();
        }
      }
      const sample = this.spu.sample();
      left[frame] = sample[0];
      right[frame] = sample[1];
      if ((frame & 255) === 255) {
        await new Promise<void>((resolve) => setTimeout(resolve, 0));
        this.abort();
      }
    }
    return [left, right];
  }
}
