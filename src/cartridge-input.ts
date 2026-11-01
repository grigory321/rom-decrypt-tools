import type {
  AudioDecoder,
  CartridgeInputEvent,
  DecoderOptions,
} from './contracts.js';
import { check, FormatError } from './binary.js';
import { audioDecoder } from './audio-codecs.js';

interface InteractiveDecoder extends AudioDecoder {
  setButtons(mask: number, durationFrames?: number): void;
}

export function cartridgeInput(
  core: InteractiveDecoder,
  options: DecoderOptions,
): AudioDecoder {
  const events: CartridgeInputEvent[] = [];
  check(!options.inputEvents || options.inputEvents.length <= 4096, 'TOO_MANY');
  for (const event of options.inputEvents || []) {
    validate(event);
    const ratio = core.sampleRate / (event.sampleRate ?? core.sampleRate);
    const mapped = {
      frame: Math.round(event.frame * ratio),
      sampleRate: core.sampleRate,
      buttons: event.buttons,
      durationFrames:
        event.durationFrames === undefined
          ? undefined
          : Math.max(1, Math.round(event.durationFrames * ratio)),
    };
    validate(mapped);
    check(
      !events.length || mapped.frame >= events[events.length - 1].frame,
      'INVALID_AUDIO',
    );
    events.push(mapped);
  }
  let nextEvent = 0;
  function current() {
    if (
      options.signal?.aborted ||
      options.cancelled?.() ||
      options.isCancelled?.()
    )
      throw new FormatError('CANCELLED');
  }
  async function read(count: number) {
    const channels = Array.from(
      { length: core.channels },
      () => new Float32Array(count),
    );
    let written = 0;
    while (written < count) {
      current();
      while (
        nextEvent < events.length &&
        events[nextEvent].frame <= core.frame
      ) {
        const event = events[nextEvent++];
        core.setButtons(event.buttons, event.durationFrames);
      }
      const boundary = events[nextEvent]?.frame ?? Infinity;
      const block = await core.read(
        Math.min(count - written, boundary - core.frame),
      );
      const length = block.channels[0].length;
      check(length > 0, 'INVALID_AUDIO');
      for (let channel = 0; channel < core.channels; channel++)
        channels[channel].set(block.channels[channel], written);
      written += length;
    }
    return channels;
  }
  async function reset() {
    current();
    await core.reset();
    nextEvent = 0;
  }
  const decoder = audioDecoder(core, read, reset);
  decoder.inputEvents = events;
  decoder.setButtons = (buttons, durationFrames) => {
    const event = {
      frame: core.frame,
      sampleRate: core.sampleRate,
      buttons,
      durationFrames,
    };
    validate(event);
    const future = events.findIndex((item) => item.frame >= core.frame);
    if (future >= 0) events.splice(future);
    check(events.length < 4096, 'TOO_MANY');
    events.push(event);
    nextEvent = events.length;
    core.setButtons(buttons, durationFrames);
  };
  return decoder;
}

function validate(event: CartridgeInputEvent) {
  check(
    Number.isSafeInteger(event.frame) &&
      event.frame >= 0 &&
      (event.sampleRate === undefined ||
        (Number.isInteger(event.sampleRate) &&
          event.sampleRate >= 8000 &&
          event.sampleRate <= 96000)) &&
      Number.isInteger(event.buttons) &&
      event.buttons >= 0 &&
      event.buttons <= 255 &&
      (event.durationFrames === undefined ||
        (Number.isSafeInteger(event.durationFrames) &&
          event.durationFrames > 0)),
    'INVALID_AUDIO',
  );
}
