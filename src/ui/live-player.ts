import { check } from '../binary.js';
import type { RpcClient } from '../rpc-types.js';

interface LivePlayerOptions {
  call: RpcClient;
  context: AudioContext;
  onChange?: (samples?: Float32Array) => void;
  onError?: (error: unknown) => void;
  onEnded?: () => void;
}
interface QueuedAudio {
  buffer: AudioBuffer;
  start: number;
  end: number;
}
interface LiveTrackInfo {
  title?: string;
  game?: string;
  artist?: string;
}

export class LivePlayer {
  call: RpcClient;
  context: AudioContext;
  onChange: (samples?: Float32Array) => void;
  onError: (error: unknown) => void;
  onEnded: () => void;
  serial = 0;
  generation = 0;
  nodes = new Set<AudioBufferSourceNode>();
  queue: QueuedAudio[] = [];
  position = 0;
  duration: number | null = 0;
  rate = 1;
  playing = false;
  wantsPlay = false;
  done = false;
  loop = false;
  sourceLoop = false;
  needsSeek = false;
  readFrame = 0;
  nextFrame = 0;
  session: string | null = null;
  track: string | null = null;
  sampleRate = 0;
  info: LiveTrackInfo = {};
  loopStart = 0;
  origin = 0;
  nextTime: number | undefined;
  timer: ReturnType<typeof setTimeout> | undefined;
  pumping = 0;
  readPromise: Promise<void> | null = null;
  seekPromise: Promise<void> | null = null;
  destination: AudioNode | undefined;
  constructor({
    call,
    context,
    onChange = () => {},
    onError = () => {},
    onEnded = () => {},
  }: LivePlayerOptions) {
    this.call = call;
    this.context = context;
    this.onChange = onChange;
    this.onError = onError;
    this.onEnded = onEnded;
  }
  async open(track: string) {
    this.pause();
    const session = this.session;
    this.session = null;
    this.resetTimeline(0, false);
    if (session) {
      void this.closeSession(session);
    }
    const serial = ++this.serial;
    this.track = track;
    const meta = await this.call(
      'live-open',
      { track, sampleRate: this.context.sampleRate },
      false,
    );
    if (serial !== this.serial) {
      await this.closeSession(meta.session);
      return false;
    }
    this.session = meta.session;
    this.sourceLoop = !!meta.loop;
    this.sampleRate = meta.sampleRate;
    this.info = meta.info || {};
    this.duration = meta.length === null ? null : meta.length / meta.sampleRate;
    this.loopStart = meta.loopStart / meta.sampleRate;
    this.onChange();
    return true;
  }
  get currentTime() {
    if (!this.playing) {
      return this.position;
    }
    const scheduledEnd =
      this.nextTime === undefined ? Infinity : this.nextFrame / this.sampleRate;
    return Math.min(
      this.duration ?? Infinity,
      scheduledEnd,
      Math.max(
        this.position,
        (this.context.currentTime - this.origin) * this.rate,
      ),
    );
  }
  clearNodes() {
    for (const node of this.nodes) {
      node.onended = null;
      try {
        node.stop();
      } catch {}
      node.disconnect();
    }
    this.nodes.clear();
    clearTimeout(this.timer);
  }
  pruneQueue() {
    const frame = Math.floor(this.currentTime * this.sampleRate + 0.000001);
    while (this.queue.length && this.queue[0].end <= frame) {
      this.queue.shift();
    }
  }
  stopPlayback() {
    const position = this.currentTime;
    this.position = this.sampleRate
      ? Math.floor(position * this.sampleRate + 0.000001) / this.sampleRate
      : position;
    this.playing = false;
    this.serial++;
    this.clearNodes();
    this.pruneQueue();
    this.nextFrame = Math.round(this.position * (this.sampleRate || 1));
    this.nextTime = undefined;
    this.onChange();
  }
  pause() {
    this.wantsPlay = false;
    this.stopPlayback();
  }
  resetTimeline(position: number, needsSeek = true) {
    this.generation++;
    this.position = position;
    this.queue = [];
    this.readPromise = null;
    this.seekPromise = null;
    this.readFrame = Math.floor(position * (this.sampleRate || 1));
    this.nextFrame = this.readFrame;
    this.nextTime = undefined;
    this.needsSeek = needsSeek;
    this.done = false;
  }
  setRate(value: number) {
    if (!Number.isFinite(value)) {
      return;
    }
    const rate = Math.max(0.5, Math.min(2, value));
    if (rate === this.rate) {
      return;
    }
    const wasPlaying = this.playing;
    if (wasPlaying) {
      this.stopPlayback();
    }
    this.rate = rate;
    this.onChange();
    if (wasPlaying) {
      return this.play();
    }
  }
  async play() {
    if (!this.session || this.playing) {
      return;
    }
    this.wantsPlay = true;
    const serial = ++this.serial;
    try {
      if (this.duration !== null && this.position >= this.duration - 0.001) {
        this.resetTimeline(0);
      }
      if (this.needsSeek) {
        if (!this.seekPromise) {
          const generation = this.generation;
          const pending = this.call(
            'live-seek',
            { session: this.session, seconds: this.position },
            false,
          )
            .then((pcm) => {
              if (generation !== this.generation) {
                return;
              }
              this.position = pcm.frame / pcm.sampleRate;
              this.readFrame = pcm.frame;
              this.nextFrame = pcm.frame;
              this.needsSeek = false;
            })
            .finally(() => {
              if (this.seekPromise === pending) {
                this.seekPromise = null;
              }
            });
          this.seekPromise = pending;
        }
        await this.seekPromise;
        if (serial !== this.serial) {
          return;
        }
      }
      await this.context.resume();
      if (serial !== this.serial) {
        return;
      }
      await this.prefill(serial);
      if (serial !== this.serial || !this.wantsPlay) return;
      this.playing = true;
      this.nextFrame = Math.round(this.position * this.sampleRate);
      this.nextTime = this.context.currentTime + 0.045;
      this.origin = this.nextTime - this.position / this.rate;
      this.onChange();
      await this.pump(serial);
    } catch (error) {
      if (serial === this.serial) {
        this.pause();
        this.onError(error);
      }
    }
  }
  async prefill(serial: number) {
    const start = Math.floor(this.position * this.sampleRate);
    const frames = Math.ceil(this.sampleRate * Math.min(1, this.rate * 0.5));
    while (
      serial === this.serial &&
      this.wantsPlay &&
      !this.done &&
      this.readFrame - start < frames
    ) {
      await this.readNext();
    }
  }
  readNext() {
    if (this.readPromise) {
      return this.readPromise;
    }
    const generation = this.generation;
    const session = this.session;
    check(session, 'INVALID_AUDIO', 'Live session not open');
    const pending = this.call('live-read', { session }, false)
      .then((pcm) => {
        if (generation !== this.generation) {
          return;
        }
        const frames = pcm.channels[0]?.length || 0;
        this.duration =
          pcm.length === null ? null : pcm.length / this.sampleRate;
        if (Number.isFinite(pcm.loopStart))
          this.loopStart = pcm.loopStart / this.sampleRate;
        if (typeof pcm.loop === 'boolean') this.sourceLoop = pcm.loop;
        if (frames) {
          const buffer = this.context.createBuffer(
            pcm.channels.length,
            frames,
            this.sampleRate,
          );
          pcm.channels.forEach((channel, index) => {
            const samples =
              channel.buffer instanceof ArrayBuffer
                ? new Float32Array(
                    channel.buffer,
                    channel.byteOffset,
                    channel.length,
                  )
                : Float32Array.from(channel);
            buffer.copyToChannel(samples, index);
          });
          const start = Number.isFinite(pcm.frame)
            ? pcm.frame - frames
            : this.readFrame;
          this.readFrame = start + frames;
          this.queue.push({ buffer, start, end: this.readFrame });
        }
        this.done = pcm.done;
        if (this.done && this.duration === null) {
          this.duration = this.readFrame / this.sampleRate;
        }
      })
      .finally(() => {
        if (this.readPromise === pending) {
          this.readPromise = null;
        }
      });
    this.readPromise = pending;
    return pending;
  }
  async pump(serial: number) {
    if (serial !== this.serial || !this.playing || this.pumping === serial) {
      return;
    }
    this.pumping = serial;
    clearTimeout(this.timer);
    try {
      this.pruneQueue();
      while (
        serial === this.serial &&
        this.playing &&
        this.nextTime !== undefined &&
        this.nextTime - this.context.currentTime < 0.7 / this.rate
      ) {
        const chunk = this.queue.find((item) => item.end > this.nextFrame);
        if (!chunk) {
          if (this.done) {
            if (!this.nodes.size) {
              this.finish();
            }
            break;
          }
          await this.readNext();
          continue;
        }
        const frame = Math.max(chunk.start, this.nextFrame),
          node = this.context.createBufferSource();
        node.buffer = chunk.buffer;
        node.playbackRate.value = this.rate;
        node.connect(this.destination || this.context.destination);
        if (this.nextTime < this.context.currentTime + 0.008) {
          const late = this.context.currentTime + 0.02 - this.nextTime;
          this.nextTime += late;
          this.origin += late;
        }
        this.nodes.add(node);
        node.onended = () => {
          if (serial !== this.serial || !this.playing) {
            return;
          }
          node.onended = null;
          this.nodes.delete(node);
          node.disconnect();
          this.pruneQueue();
          if (this.done && !this.nodes.size) {
            this.finish();
          }
          void this.pump(serial);
        };
        node.start(this.nextTime, (frame - chunk.start) / this.sampleRate);
        this.nextFrame = chunk.end;
        this.nextTime += (chunk.end - frame) / this.sampleRate / this.rate;
        this.onChange(chunk.buffer.getChannelData?.(0));
      }
      if (
        serial === this.serial &&
        this.playing &&
        (!this.done || this.nextFrame < this.readFrame)
      ) {
        const remaining =
          (this.nextTime ?? this.context.currentTime) -
          this.context.currentTime;
        this.timer = setTimeout(
          () => this.pump(serial),
          Math.max(40, (remaining - 0.55 / this.rate) * 1000),
        );
      }
    } catch (error) {
      if (serial === this.serial) {
        this.pause();
        this.onError(error);
      }
    } finally {
      if (this.pumping === serial) {
        this.pumping = 0;
      }
    }
  }
  finish() {
    if (!this.playing || this.nextFrame < this.readFrame) {
      return;
    }
    this.position = this.duration ?? this.readFrame / this.sampleRate;
    this.playing = false;
    this.wantsPlay = false;
    this.serial++;
    this.queue = [];
    clearTimeout(this.timer);
    this.onChange();
    if (this.loop) {
      this.resetTimeline(this.loopStart || 0);
      void this.play();
    } else {
      this.onEnded();
    }
  }
  async seek(seconds: number) {
    if (!Number.isFinite(seconds)) {
      return;
    }
    const wasPlaying = this.wantsPlay || this.playing;
    this.stopPlayback();
    this.resetTimeline(
      Math.min(this.duration ?? Infinity, Math.max(0, seconds)),
    );
    this.onChange();
    if (wasPlaying) {
      await this.play();
    }
  }
  async closeSession(session: string) {
    try {
      await this.call('live-close', { session }, false);
    } catch {}
  }
  async pressButtons(buttons: number) {
    if (this.session)
      await this.call('live-input', { session: this.session, buttons }, false);
  }
  dispose() {
    this.pause();
    const session = this.session;
    this.session = null;
    this.resetTimeline(0, false);
    if (session) {
      void this.closeSession(session);
    }
  }
}
