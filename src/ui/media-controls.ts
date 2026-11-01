export interface MediaControlState {
  playing: boolean;
  position: number;
  duration: number | null;
  rate: number;
}

export interface MediaControlTrack {
  title: string;
  album?: string;
}

export interface MediaControlsOptions {
  play: () => void | Promise<void>;
  pause: () => void | Promise<void>;
  previous: () => void | Promise<void>;
  next: () => void | Promise<void>;
  seek: (seconds: number) => void | Promise<void>;
  onError: (error: unknown) => void;
}

export interface MediaControls {
  update(track: MediaControlTrack | null, state: MediaControlState): void;
  dispose(): void;
}

export function bindMediaControls(
  options: MediaControlsOptions,
  session = typeof navigator === 'undefined'
    ? undefined
    : navigator.mediaSession,
): MediaControls {
  if (!session) return { update() {}, dispose() {} };
  const installed = new Set<MediaSessionAction>();
  let disposed = false,
    hasTrack = false,
    position = 0,
    duration: number | null = null,
    metadataSet = false,
    title: string | null = null,
    album: string | undefined,
    positionSet = false;
  const run = (action: () => void | Promise<void>) => {
    if (disposed) return;
    try {
      void Promise.resolve(action()).catch(options.onError);
    } catch (error) {
      options.onError(error);
    }
  };
  const seek = (seconds: number) => {
    if (!hasTrack || !Number.isFinite(seconds)) return;
    const target = Math.min(duration ?? Infinity, Math.max(0, seconds));
    run(() => options.seek(target));
  };
  const install = (
    action: MediaSessionAction,
    handler: MediaSessionActionHandler,
  ) => {
    try {
      session.setActionHandler(action, handler);
      installed.add(action);
    } catch {}
  };
  const relativeSeek = (offset: number | undefined, direction: number) => {
    const seconds = offset ?? 10;
    if (!Number.isFinite(seconds) || seconds < 0) return;
    seek(position + seconds * direction);
  };
  install('play', () => run(options.play));
  install('pause', () => run(options.pause));
  install('previoustrack', () => run(options.previous));
  install('nexttrack', () => run(options.next));
  install('seekbackward', (details) => relativeSeek(details.seekOffset, -1));
  install('seekforward', (details) => relativeSeek(details.seekOffset, 1));
  install('seekto', (details) => {
    if (details.seekTime !== undefined) seek(details.seekTime);
  });
  return {
    update(track, state) {
      if (disposed) return;
      hasTrack = track !== null;
      duration =
        state.duration !== null &&
        Number.isFinite(state.duration) &&
        state.duration > 0
          ? state.duration
          : null;
      position = Number.isFinite(state.position)
        ? Math.min(duration ?? Infinity, Math.max(0, state.position))
        : 0;
      if (!metadataSet || track?.title !== title || track?.album !== album) {
        metadataSet = true;
        title = track?.title ?? null;
        album = track?.album;
        try {
          session.metadata =
            track && typeof MediaMetadata !== 'undefined'
              ? new MediaMetadata({ title: track.title, album: track.album })
              : null;
        } catch {}
      }
      try {
        session.playbackState = track
          ? state.playing
            ? 'playing'
            : 'paused'
          : 'none';
      } catch {}
      if (
        hasTrack &&
        duration !== null &&
        Number.isFinite(state.position) &&
        Number.isFinite(state.rate) &&
        state.rate > 0
      ) {
        try {
          session.setPositionState({
            duration,
            playbackRate: state.rate,
            position,
          });
          positionSet = true;
        } catch {}
      } else if (positionSet) {
        positionSet = false;
        try {
          session.setPositionState();
        } catch {}
      }
    },
    dispose() {
      if (disposed) return;
      disposed = true;
      for (const action of installed) {
        try {
          session.setActionHandler(action, null);
        } catch {}
      }
      installed.clear();
    },
  };
}
