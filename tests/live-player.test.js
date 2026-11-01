import test from 'node:test';

import assert from 'node:assert/strict';

import { LivePlayer } from '../dist/ui/live-player.js';

const context = () => ({
  currentTime: 0,
  sampleRate: 32768,
  destination: {},
  scheduled: [],
  sources: [],
  async resume() {},
  createBuffer(channels, length, rate) {
    const data = Array.from(
      { length: channels },
      () => new Float32Array(length),
    );
    return {
      length: length,
      duration: length / rate,
      data: data,
      copyToChannel(values, channel) {
        data[channel].set(values);
      },
    };
  },
  createBufferSource() {
    const c = this;
    const source = {
      playbackRate: { value: 1 },
      connect() {},
      disconnect() {},
      stop() {},
      start(time, offset = 0) {
        this.time = time;
        this.offset = offset;
        c.scheduled.push(time);
        c.sources.push(this);
      },
    };
    return source;
  },
});

function continuousPlayer(options = {}) {
  const ctx = context(),
    requests = [];
  let frame = 0;
  const call = async (type, values) => {
    requests.push({ type: type, values: values });
    if (type === 'live-open') {
      return {
        session: 'continuous',
        sampleRate: 32768,
        length: options.length ?? 32768 * 180,
        loopStart: 8192,
      };
    }
    if (type === 'live-seek') {
      frame = Math.floor(values.seconds * 32768);
      return { frame: frame, sampleRate: 32768 };
    }
    if (type === 'live-read') {
      if (options.read) {
        await options.read(frame);
      }
      const length = Math.min(8192, (options.length ?? Infinity) - frame),
        channel = Float32Array.from({ length: length }, (_, i) => frame + i);
      frame += length;
      return {
        channels: [channel],
        frame: frame,
        length: options.length ?? 32768 * 180,
        done: frame === options.length,
      };
    }
    return {};
  };
  return {
    ctx: ctx,
    requests: requests,
    player: new LivePlayer({ call: call, context: ctx, ...options }),
  };
}

test('uneven decoder warmup does not insert silence between the first audio blocks', async () => {
  let fixture;
  fixture = continuousPlayer({
    read: async (frame) => {
      fixture.ctx.currentTime += frame < 24576 ? 0.35 : 0.01;
    },
  });
  const { player, ctx } = fixture;
  try {
    await player.open('track');
    await player.play();
    assert.ok(ctx.sources.length >= 3);
    for (let index = 1; index < ctx.sources.length; index++) {
      const previous = ctx.sources[index - 1];
      const end =
        previous.time + previous.buffer.duration / previous.playbackRate.value;
      assert.ok(Math.abs(ctx.sources[index].time - end) < 1e-9);
    }
    assert.equal(ctx.sources[0].buffer.data[0][0], 0);
    assert.ok(
      player.queue.reduce((frames, item) => frames + item.buffer.length, 0) <=
        32768 * 1.5,
    );
  } finally {
    player.dispose();
  }
});

test('pause resumes at the next original PCM sample without replaying the decoder', async () => {
  const { player, ctx, requests } = continuousPlayer();
  try {
    await player.open('track');
    await player.play();
    ctx.currentTime = 0.42;
    player.pause();
    assert.equal(player.currentTime, 0.375);
    const count = ctx.sources.length;
    ctx.currentTime = 10;
    await player.play();
    const resumed = ctx.sources[count];
    assert.equal(
      resumed.buffer.data[0][Math.round(resumed.offset * 32768)],
      12288,
    );
    assert.equal(requests.filter((r) => r.type === 'live-seek').length, 0);
    assert.equal(resumed.playbackRate.value, 1);
    assert.equal(player.currentTime, 0.375);
  } finally {
    player.dispose();
  }
});

test('a read finishing while paused is retained for seamless resume', async () => {
  const gate = deferred(),
    reading = deferred();
  const { player, ctx, requests } = continuousPlayer({
    read: async (frame) => {
      if (!frame) {
        reading.resolve();
        await gate.promise;
      }
    },
  });
  try {
    await player.open('track');
    const first = player.play();
    await reading.promise;
    player.pause();
    const resumed = player.play();
    gate.resolve();
    await Promise.all([first, resumed]);
    assert.equal(ctx.sources[0].buffer.data[0][0], 0);
    assert.equal(ctx.sources[1].buffer.data[0][0], 8192);
    assert.equal(requests.filter((r) => r.type === 'live-seek').length, 0);
  } finally {
    gate.resolve();
    player.dispose();
  }
});

test('speed controls scale source scheduling and the elapsed song clock', async () => {
  const { player, ctx, requests } = continuousPlayer();
  try {
    await player.open('track');
    assert.equal(player.rate, 1);
    player.setRate(2);
    await player.play();
    assert.equal(ctx.sources[0].playbackRate.value, 2);
    assert.ok(
      Math.abs(ctx.sources[1].time - ctx.sources[0].time - 0.125) < 1e-10,
    );
    ctx.currentTime = 0.17;
    assert.ok(Math.abs(player.currentTime - 0.25) < 1e-10);
    const count = ctx.sources.length;
    await player.setRate(0.5);
    const changed = ctx.sources[count];
    assert.equal(changed.playbackRate.value, 0.5);
    assert.equal(
      changed.buffer.data[0][Math.round(changed.offset * 32768)],
      8192,
    );
    ctx.currentTime = changed.time + 0.5;
    assert.ok(Math.abs(player.currentTime - 0.5) < 1e-10);
    player.pause();
    player.setRate(10);
    assert.equal(player.rate, 2);
    player.setRate(0.1);
    assert.equal(player.rate, 0.5);
    player.setRate(NaN);
    assert.equal(player.rate, 0.5);
    assert.equal(requests.filter((r) => r.type === 'live-seek').length, 0);
  } finally {
    player.dispose();
  }
});

test('rolling PCM storage stays bounded during long playback and pause cycles', async () => {
  const { player, ctx, requests } = continuousPlayer();
  try {
    await player.open('track');
    await player.play();
    for (let i = 0; i < 80; i++) {
      ctx.currentTime += 0.2;
      player.pause();
      await player.play();
      const samples = player.queue.reduce(
        (n, chunk) => n + chunk.buffer.length,
        0,
      );
      assert.ok(samples <= 32768 * 1.5, String(samples));
    }
    assert.ok(player.currentTime > 10);
    assert.equal(requests.filter((r) => r.type === 'live-seek').length, 0);
  } finally {
    player.dispose();
  }
});

test('a seek ignores a late PCM block from the former timeline', async () => {
  const gate = deferred(),
    reading = deferred(),
    ctx = context();
  let firstRead = true,
    frame = 0;
  const player = new LivePlayer({
    context: ctx,
    call: async (type, values) => {
      if (type === 'live-open') {
        return {
          session: 'race',
          sampleRate: 32768,
          length: 32768 * 60,
          loopStart: 0,
        };
      }
      if (type === 'live-seek') {
        frame = values.seconds * 32768;
        return { frame: frame, sampleRate: 32768 };
      }
      if (type === 'live-read') {
        const start = frame;
        frame += 8192;
        if (firstRead) {
          firstRead = false;
          reading.resolve();
          await gate.promise;
        }
        return {
          channels: [new Float32Array(8192).fill(start)],
          frame: start + 8192,
          length: 32768 * 60,
          done: false,
        };
      }
      return {};
    },
  });
  try {
    await player.open('track');
    const playing = player.play();
    await reading.promise;
    await player.seek(10);
    gate.resolve();
    await playing;
    assert.equal(ctx.sources[0].buffer.data[0][0], 327680);
    assert.equal(player.currentTime, 10);
    assert.ok(
      ctx.sources.every((source) => source.buffer.data[0][0] >= 327680),
    );
  } finally {
    gate.resolve();
    player.dispose();
  }
});

test('natural ending notifies once and stale stopped sources cannot notify', async () => {
  let ended = 0;
  const { player, ctx } = continuousPlayer({
    length: 16384,
    onEnded: () => ended++,
  });
  try {
    await player.open('track');
    await player.play();
    const stale = ctx.sources.map((source) => source.onended);
    player.pause();
    stale.forEach((callback) => callback());
    assert.equal(ended, 0);
    await player.play();
    const sources = ctx.sources.slice(2);
    ctx.currentTime = sources[0].time + 0.5;
    sources.forEach((source) => source.onended());
    assert.equal(ended, 1);
    assert.equal(player.currentTime, 0.5);
    sources.forEach((source) => source.onended?.());
    assert.equal(ended, 1);
  } finally {
    player.dispose();
  }
});

for (const pause of [false, true]) {
  test(`prefetched EOF preserves every remaining frame after ${pause ? 'pause and resume at a faster speed' : 'a faster speed change'}`, async (t) => {
    t.mock.timers.enable({ apis: ['setTimeout'] });
    let ended = 0;
    const { player, ctx, requests } = continuousPlayer({
      length: 32768,
      onEnded: () => ended++,
    });
    const endDueSources = () => {
      for (const source of ctx.sources) {
        const end =
          source.time +
          (source.buffer.duration - source.offset) / source.playbackRate.value;
        if (end <= ctx.currentTime) {
          source.onended?.();
        }
      }
    };
    try {
      await player.open('track');
      player.setRate(0.5);
      await player.play();
      ctx.currentTime = 0.245;
      t.mock.timers.tick(1000);
      await new Promise((resolve) => setImmediate(resolve));
      assert.equal(
        requests.filter((request) => request.type === 'live-read').length,
        4,
      );
      const firstResumed = ctx.sources.length;
      if (pause) {
        player.pause();
        player.setRate(2);
        await player.play();
      } else {
        await player.setRate(2);
      }
      ctx.currentTime = 0.62;
      endDueSources();
      assert.equal(ended, 0);
      t.mock.timers.tick(40);
      await new Promise((resolve) => setImmediate(resolve));
      const resumed = ctx.sources.slice(firstResumed),
        samples = resumed.flatMap((source) =>
          Array.from(
            source.buffer.data[0].subarray(Math.round(source.offset * 32768)),
          ),
        );
      assert.deepEqual(
        samples,
        Array.from({ length: 29492 }, (_, i) => i + 3276),
      );
      assert.equal(
        requests.filter((request) => request.type === 'live-read').length,
        4,
      );
      assert.equal(
        requests.filter((request) => request.type === 'live-seek').length,
        0,
      );
      assert.equal(ended, 0);
      ctx.currentTime = 0.77;
      endDueSources();
      assert.equal(ended, 1);
      assert.equal(player.currentTime, 1);
    } finally {
      player.dispose();
    }
  });
}

test('repeat-one restarts at the loop marker before continuous playback is notified', async () => {
  let ended = 0;
  const { player, ctx } = continuousPlayer({
    length: 16384,
    onEnded: () => ended++,
  });
  try {
    await player.open('track');
    player.loop = true;
    await player.play();
    ctx.currentTime = 0.545;
    ctx.sources.slice().forEach((source) => source.onended());
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(player.playing, true);
    assert.equal(player.position, 0.25);
    assert.equal(ctx.sources[2].buffer.data[0][0], 8192);
    assert.equal(ended, 0);
  } finally {
    player.dispose();
  }
});

test('live playback starts from bounded blocks without rendering the whole song', async () => {
  const ctx = context(),
    requests = [];
  let frame = 0;
  const call = async (type) => {
    requests.push(type);
    if (type === 'live-open') {
      return {
        session: 'p',
        sampleRate: 32768,
        length: 32768 * 180,
        loopStart: 0,
      };
    }
    if (type === 'live-read') {
      frame += 8192;
      return {
        channels: [new Float32Array(8192), new Float32Array(8192)],
        frame: frame,
        length: 32768 * 180,
        done: false,
      };
    }
    return {};
  };
  const player = new LivePlayer({
    call: call,
    context: ctx,
  });
  try {
    assert.equal(await player.open('track'), true);
    assert.equal(frame, 0);
    await player.play();
    assert.ok(ctx.scheduled.length > 0);
    assert.ok(frame > 0 && frame <= 32768, 'prefetch stays within one second');
    assert.ok(ctx.scheduled[0] < 0.05);
    assert.ok(!requests.includes('render'));
  } finally {
    player.dispose();
  }
  assert.equal(player.nodes.size, 0);
});

test('a paused player never schedules an audio block that arrives afterward', async () => {
  const ctx = context();
  let release, notify;
  const gate = new Promise((r) => (release = r)),
    reading = new Promise((r) => (notify = r));
  const call = async (type) => {
    if (type === 'live-open') {
      return {
        session: 'p',
        sampleRate: 32768,
        length: 65536,
        loopStart: 0,
      };
    }
    if (type === 'live-read') {
      notify();
      await gate;
      return {
        channels: [new Float32Array(8192)],
        length: 65536,
        done: false,
      };
    }
    return {};
  };
  const player = new LivePlayer({
    call: call,
    context: ctx,
  });
  await player.open('track', 60);
  const playing = player.play();
  await reading;
  player.pause();
  release();
  await playing;
  assert.equal(ctx.scheduled.length, 0);
  assert.equal(player.playing, false);
  player.dispose();
});

const deferred = () => {
  let resolve, reject;
  const promise = new Promise((accept, decline) => {
    resolve = accept;
    reject = decline;
  });
  return {
    promise: promise,
    resolve: resolve,
    reject: reject,
  };
};

function seekHarness(options = {}) {
  const ctx = context(),
    seeks = [],
    requests = [];
  const call = async (type, value) => {
    requests.push(type);
    if (type === 'live-open') {
      return {
        session: 'p',
        sampleRate: 32768,
        length: 32768 * 60,
        loopStart: 0,
      };
    }
    if (type === 'live-seek') {
      const gate = deferred();
      seeks.push({
        seconds: value.seconds,
        ...gate,
      });
      return gate.promise;
    }
    if (type === 'live-read') {
      return {
        channels: [new Float32Array(8192)],
        length: 32768 * 60,
        done: false,
      };
    }
    return {};
  };
  return {
    ctx: ctx,
    seeks: seeks,
    requests: requests,
    player: new LivePlayer({
      call: call,
      context: ctx,
      ...options,
    }),
  };
}

test('overlapping playing seeks resume at the latest target and ignore an older completion', async () => {
  const {
    player: player,
    ctx: ctx,
    seeks: seeks,
    requests: requests,
  } = seekHarness();
  try {
    await player.open('track', 60);
    await player.play();
    assert.equal(player.playing, true);
    const first = player.seek(10),
      second = player.seek(11);
    assert.deepEqual(
      seeks.map((s) => s.seconds),
      [10, 11],
    );
    assert.equal(player.nodes.size, 0);
    seeks[1].resolve({
      frame: 11 * 32768,
      sampleRate: 32768,
    });
    await second;
    assert.equal(player.playing, true);
    assert.equal(player.position, 11);
    assert.equal(player.nodes.size, 3);
    assert.equal(ctx.scheduled.length, 6);
    const reads = requests.filter((t) => t === 'live-read').length;
    seeks[0].resolve({
      frame: 10 * 32768,
      sampleRate: 32768,
    });
    await first;
    assert.equal(player.playing, true);
    assert.equal(player.position, 11);
    assert.equal(requests.filter((t) => t === 'live-read').length, reads);
    assert.equal(ctx.scheduled.length, 6);
  } finally {
    for (const s of seeks) {
      s.resolve({
        frame: s.seconds * 32768,
        sampleRate: 32768,
      });
    }
    player.dispose();
  }
});

test('an explicit pause during pending seeks prevents their automatic resume', async () => {
  const { player: player, ctx: ctx, seeks: seeks } = seekHarness();
  try {
    await player.open('track', 60);
    await player.play();
    const first = player.seek(10),
      second = player.seek(11);
    player.pause();
    for (const s of seeks) {
      s.resolve({
        frame: s.seconds * 32768,
        sampleRate: 32768,
      });
    }
    await Promise.all([first, second]);
    assert.equal(player.playing, false);
    assert.equal(player.position, 11);
    assert.equal(player.nodes.size, 0);
    assert.equal(ctx.scheduled.length, 3);
  } finally {
    player.dispose();
  }
});

test('paused seeks defer decoder work until play and use only the latest target', async () => {
  const { player: player, seeks: seeks } = seekHarness();
  try {
    await player.open('track', 60);
    await player.seek(10);
    await player.seek(11);
    assert.equal(player.playing, false);
    assert.equal(seeks.length, 0);
    const playing = player.play();
    assert.deepEqual(
      seeks.map((s) => s.seconds),
      [11],
    );
    seeks[0].resolve({
      frame: 11 * 32768,
      sampleRate: 32768,
    });
    await playing;
    assert.equal(player.playing, true);
    assert.equal(player.position, 11);
  } finally {
    for (const s of seeks) {
      s.resolve({
        frame: s.seconds * 32768,
        sampleRate: 32768,
      });
    }
    player.dispose();
  }
});

test('play retries a failed seek without retaining a rejected seek operation', async () => {
  const errors = [],
    { player, ctx } = continuousPlayer({
      onError: (error) => errors.push(error),
    }),
    call = player.call;
  let attempts = 0;
  player.call = async (type, values, busy) => {
    if (type === 'live-seek' && ++attempts === 1) {
      throw new Error('temporary decoder failure');
    }
    return call(type, values, busy);
  };
  try {
    await player.open('track');
    await player.play();
    await player.seek(10);
    assert.equal(player.playing, false);
    assert.equal(errors.length, 1);
    const resumed = ctx.sources.length;
    await player.play();
    assert.equal(player.playing, true);
    assert.equal(attempts, 2);
    assert.equal(errors.length, 1);
    assert.equal(ctx.sources[resumed].buffer.data[0][0], 327680);
  } finally {
    player.dispose();
  }
});

test('source completion refills contiguous audio while timer callbacks are withheld', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const { player, ctx } = continuousPlayer();
  try {
    await player.open('track');
    await player.play();
    for (let index = 0; index < 80; index++) {
      const source = ctx.sources[index];
      assert.ok(source, 'queued audio must survive without a timer callback');
      const end = source.time + source.buffer.duration;
      ctx.currentTime = end;
      source.onended();
      await new Promise((resolve) => setImmediate(resolve));
      const next = ctx.sources[index + 1];
      assert.ok(next);
      assert.ok(Math.abs(next.time - end) < 1e-10);
      assert.equal(next.buffer.data[0][0], (index + 1) * 8192);
      assert.ok(
        player.queue.reduce((sum, chunk) => sum + chunk.buffer.length, 0) <=
          32768 * 1.5,
      );
    }
    assert.ok(player.currentTime >= 20);
    assert.equal(player.playing, true);
  } finally {
    player.dispose();
  }
});

test('a stale seek failure cannot clear a newer pending seek or its playback intent', async () => {
  const errors = [],
    { player, seeks } = seekHarness({ onError: (error) => errors.push(error) });
  try {
    await player.open('track');
    await player.play();
    const first = player.seek(10),
      second = player.seek(11);
    seeks[0].reject(new Error('cancelled older seek'));
    await first;
    const resumed = player.play();
    assert.equal(seeks.length, 2);
    assert.equal(player.wantsPlay, true);
    assert.equal(player.nodes.size, 0);
    seeks[1].resolve({ frame: 11 * 32768, sampleRate: 32768 });
    await Promise.all([second, resumed]);
    assert.equal(player.playing, true);
    assert.equal(player.currentTime, 11);
    assert.deepEqual(errors, []);
  } finally {
    for (const seek of seeks) {
      seek.resolve({ frame: seek.seconds * 32768, sampleRate: 32768 });
    }
    player.dispose();
  }
});

test('pausing while audio context resume is pending prevents a completed seek from starting sources', async () => {
  const { player, ctx, seeks } = seekHarness(),
    resuming = deferred(),
    resumed = deferred();
  try {
    await player.open('track');
    await player.play();
    const sourceCount = ctx.sources.length;
    ctx.resume = async () => {
      resuming.resolve();
      await resumed.promise;
    };
    const seeking = player.seek(10);
    seeks[0].resolve({ frame: 10 * 32768, sampleRate: 32768 });
    await resuming.promise;
    player.pause();
    resumed.resolve();
    await seeking;
    assert.equal(player.playing, false);
    assert.equal(player.wantsPlay, false);
    assert.equal(ctx.sources.length, sourceCount);
    await player.play();
    assert.equal(player.playing, true);
    assert.equal(player.currentTime, 10);
  } finally {
    resumed.resolve();
    player.dispose();
  }
});

test('an event-driven refill failure pauses safely and preserves queued samples for retry', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const errors = [];
  let fail = true;
  const { player, ctx } = continuousPlayer({
    onError: (error) => errors.push(error),
    read: async (frame) => {
      if (frame >= 24576 && fail) {
        fail = false;
        throw new Error('temporary read failure');
      }
    },
  });
  try {
    await player.open('track');
    await player.play();
    ctx.currentTime = 0.295;
    ctx.sources[0].onended();
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(player.playing, false);
    assert.equal(player.wantsPlay, false);
    assert.equal(player.nodes.size, 0);
    assert.equal(errors.length, 1);
    const count = ctx.sources.length;
    await player.play();
    assert.equal(player.playing, true);
    assert.equal(ctx.sources[count].buffer.data[0][0], 8192);
    assert.equal(errors.length, 1);
  } finally {
    player.dispose();
  }
});
