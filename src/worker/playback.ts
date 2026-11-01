import { check } from '../binary.js';
import { createTrackDecoder } from '../audio-decoder.js';
import type {
  AudioAsset,
  AudioDecoder,
  LibraryTrack,
  PcmBlock,
} from '../contracts.js';
import type { LiveBlock, LiveSeek, LiveSession } from '../rpc-types.js';

interface PlaybackSession {
  asset: AudioAsset;
  decoder: AudioDecoder;
  length: number | null;
  group: string;
  generation: number;
  operation: Promise<void>;
  seeking: boolean;
}

function enqueue<T>(
  session: PlaybackSession,
  operation: () => Promise<T>,
): Promise<T> {
  const result = session.operation.then(operation);
  session.operation = result.then(
    () => {},
    () => {},
  );
  return result;
}

export class WorkerPlayback {
  private readonly sessions = new Map<string, PlaybackSession>();
  private generation = 0;

  constructor(private readonly nextSession: () => string) {}

  async open(
    track: LibraryTrack,
    sampleRate: number,
    checkCurrent: () => void,
  ): Promise<LiveSession> {
    const generation = ++this.generation;
    this.sessions.clear();
    const decoder = await createTrackDecoder(track, sampleRate);
    checkCurrent();
    check(generation === this.generation, 'CANCELLED');
    const length = track.kind === 'sequence' ? null : decoder.length;
    const session = this.nextSession();
    this.sessions.set(session, {
      asset: track.asset,
      decoder,
      length,
      group: track.group,
      generation: 0,
      operation: Promise.resolve(),
      seeking: false,
    });
    return {
      session,
      sampleRate: decoder.sampleRate,
      length,
      loop: !!decoder.loop,
      loopStart: decoder.loopStart || 0,
      loopEnd: decoder.loopEnd || length,
      info: decoder.tags
        ? {
            title: decoder.tags.title || '',
            game: decoder.tags.game || '',
            artist: decoder.tags.artist || '',
          }
        : null,
    };
  }

  read(id: string): Promise<LiveBlock> {
    const session = this.find(id);
    check(!session.seeking, 'CANCELLED');
    const generation = session.generation;
    return enqueue(session, async () => {
      this.checkCurrent(id, session, generation);
      check(!session.seeking, 'CANCELLED');
      const remaining =
        session.length === null
          ? Infinity
          : session.length - session.decoder.frame;
      const block: PcmBlock =
        remaining > 0
          ? await session.decoder.read(Math.min(8192, remaining))
          : {
              channels: [],
              sampleRate: session.decoder.sampleRate,
              frame: session.decoder.frame,
              done: true,
            };
      this.checkCurrent(id, session, generation);
      const done =
        block.done ||
        (session.length !== null && session.decoder.frame >= session.length);
      return {
        ...block,
        frame: session.decoder.frame,
        done,
        length: done
          ? (session.decoder.length ?? session.decoder.frame)
          : session.length,
        loopStart: session.decoder.loopStart || 0,
      };
    });
  }

  async input(id: string, buttons: number): Promise<void> {
    const session = this.find(id);
    await enqueue(session, async () => {
      check(this.sessions.get(id) === session, 'CANCELLED');
      check(typeof session.decoder.setButtons === 'function', 'INVALID_AUDIO');
      session.decoder.setButtons(
        buttons,
        Math.round(session.decoder.sampleRate * 0.12),
      );
      if (session.decoder.inputEvents)
        session.asset.inputEvents = [...session.decoder.inputEvents];
    });
  }

  async seek(id: string, seconds: number): Promise<LiveSeek> {
    const session = this.find(id);
    const generation = ++session.generation;
    check(Number.isFinite(seconds), 'INVALID');
    const frame = Math.min(
      session.length ?? Infinity,
      Math.max(0, Math.floor(seconds * session.decoder.sampleRate)),
    );
    session.seeking = true;
    try {
      return await enqueue(session, async () => {
        const current = () => this.checkCurrent(id, session, generation);
        current();
        if (typeof session.decoder.seek === 'function')
          await session.decoder.seek(frame);
        else {
          await session.decoder.reset();
          while (session.decoder.frame < frame) {
            current();
            const block = await session.decoder.read(
              Math.min(16384, frame - session.decoder.frame),
            );
            current();
            if (block.done) break;
            await new Promise((resolve) => setTimeout(resolve, 0));
          }
        }
        current();
        return {
          frame: session.decoder.frame,
          sampleRate: session.decoder.sampleRate,
        };
      });
    } finally {
      if (generation === session.generation) session.seeking = false;
    }
  }

  close(id?: string): void {
    if (id) this.sessions.delete(id);
    else {
      this.generation++;
      this.sessions.clear();
    }
  }

  removeGroup(group: string): void {
    for (const [id, session] of this.sessions) {
      if (session.group === group) this.sessions.delete(id);
    }
  }

  private find(id: string): PlaybackSession {
    const session = this.sessions.get(id);
    check(session, 'TRACK_GONE');
    return session;
  }

  private checkCurrent(
    id: string,
    session: PlaybackSession,
    generation: number,
  ): void {
    check(
      this.sessions.get(id) === session && session.generation === generation,
      'CANCELLED',
    );
  }
}
