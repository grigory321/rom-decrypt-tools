import type { Progress, TrackMetadata } from '../contracts.js';
import type { UiServices } from '../rpc-types.js';
import { t, errorText, errorInfo } from '../i18n.js';
import { isAbortError } from '../errors.js';
import { prepareAndSaveOutput, zipOutputBound } from '../save-output.js';
import { chooseAudioInputs, companionFiles } from '../file-selection.js';
import { classifyAudio, orderAudioTracks } from '../audio-category.js';
import {
  element,
  elements,
  button as uiButton,
  input as uiInput,
  select as uiSelect,
  canvas as uiCanvas,
} from './elements.js';
import { LivePlayer } from './live-player.js';
import { AudioVisualizer } from './audio-visualizer.js';
import { bindMediaControls } from './media-controls.js';
import {
  initCartridgeControls,
  updateCartridgeControls,
} from './cartridge-controls.js';
import { initAudioExport } from './audio-export.js';
import {
  renderAudioLibrary,
  renderImportedFiles,
} from './audio-library-view.js';
import { formatTime } from './formatters.js';
import { icon } from './icons.js';
import type { ImportedAudioFile } from './audio-types.js';
import type { Notifications } from './notifications.js';
import { openFilePicker } from './file-picker.js';

interface AudioWorkspaceOptions extends UiServices {
  toast: Notifications['toast'];
  onImportProgress?: (progress: Progress | null) => void;
}

export function initAudioWorkspace({
  call,
  download,
  showError,
  toast,
  onImportProgress = () => {},
}: AudioWorkspaceOptions) {
  let allTracks: TrackMetadata[] = [],
    files: ImportedAudioFile[] = [],
    selected: string | null = null,
    filter = 'all',
    search = '',
    selectedIds = new Set<string>(),
    playing = false,
    renderToken = 0;
  let trackPageSize = 200;
  let filePageSize = 200;
  let libraryRefreshTimer: ReturnType<typeof setTimeout> | 0 = 0;

  let audioContext: AudioContext | undefined,
    gain: GainNode | undefined,
    live: LivePlayer | null = null,
    visualizer: AudioVisualizer | undefined;
  let muted = false;
  initCartridgeControls(
    (buttons) => live?.pressButtons(buttons) ?? Promise.resolve(),
    showError,
  );
  let playerInView = true;
  let animationFrame = 0;
  let lastFrame = 0;
  let scrubbing = false;

  const durations = new Map<string, number>();

  const category = classifyAudio;

  function title(track: TrackMetadata) {
    return track.name;
  }

  const mediaControls = bindMediaControls({
    play: async () => {
      if (!playing && !live?.wantsPlay) await togglePlayback();
    },
    pause: () => stop(),
    previous: () => step(-1),
    next: () => step(1),
    seek: seekTo,
    onError: showError,
  });
  const exporter = initAudioExport({
    call,
    download,
    showError,
    onSaved: () => toast(t('done')),
  });
  const openExport = (id: string | null) =>
    exporter.open(allTracks.find((track) => track.id === id));
  uiButton('#player-export').onclick = () => openExport(selected);
  uiInput('#file-input').onchange = () => {
    const input = uiInput('#file-input');
    loadFiles(Array.from(input.files ?? []));
  };

  const drop = element('#dropzone');

  drop.addEventListener('click', () => openFilePicker(uiInput('#file-input')));

  let dragDepth = 0;

  for (const type of ['dragenter', 'dragover', 'dragleave', 'drop']) {
    drop.addEventListener(type, (e) => {
      e.preventDefault();
      e.stopPropagation();
    });
  }

  drop.addEventListener('dragenter', () => {
    dragDepth++;
    drop.classList.add('drag');
  });

  drop.addEventListener('dragleave', () => {
    if (!--dragDepth) {
      drop.classList.remove('drag');
    }
  });

  drop.addEventListener('drop', (e) => {
    dragDepth = 0;
    drop.classList.remove('drag');
    loadFiles(Array.from(e.dataTransfer?.files ?? []));
  });

  document.addEventListener('dragover', (e) => e.preventDefault());

  document.addEventListener('drop', (e) => e.preventDefault());

  let loadQueue = Promise.resolve();
  let importGeneration = 0;
  let inputController: AbortController | null = null;

  uiButton('#import-cancel').onclick = () => {
    importGeneration++;
    inputController?.abort();
    onImportProgress(null);
    uiButton('#import-cancel').hidden = true;
    void call('cancelLoad', {}, false).catch(showError);
  };

  async function importAudioFile(
    file: File,
    selection: string,
    fileIndex: number | undefined,
    generation: number,
  ) {
    const existing = files.find((item) => item.file === file);
    if (existing) {
      select(
        allTracks.find(
          (track) => track.group === existing.group && track.playable,
        )?.id,
      );
      return 0;
    }

    try {
      const result = await call('load', {
        selection,
        fileIndex,
        sourcePath: file.webkitRelativePath || file.name,
      });

      if (generation !== importGeneration) {
        if (!files.some((item) => item.group === result.group))
          await call('remove', { group: result.group }, false);
        return 0;
      }

      if (files.some((item) => item.group === result.group)) {
        select(result.tracks.find((track) => track.playable)?.id);
        return 0;
      }
      const known = new Set(allTracks.map((track) => track.id));
      for (const track of result.tracks)
        if (!known.has(track.id)) allTracks.push(track);
      files.push({
        group: result.group,
        name: file.name,
        size: file.size,
        tracks: result.tracks.length,
        file,
      });
      scheduleLibraryRefresh();
      if (!selected)
        select(
          result.tracks.find((track) => track.playable)?.id ||
            result.tracks[0]?.id,
        );
      if (result.warnings.length) {
        const messages = [
          ...new Set(
            result.warnings.map((warning) => errorText(warning, false)),
          ),
        ];
        const details = result.warnings
          .slice(0, 5)
          .map((warning) => warning.detail?.slice(0, 4096) || warning.code)
          .join('\n\n');
        toast(messages.slice(0, 5).join(' · '), true, null, details);
      }
      return result.tracks.length;
    } catch (error) {
      if (errorInfo(error).code === 'CANCELLED') return;
      if (file.webkitRelativePath && errorInfo(error).code === 'NO_AUDIO')
        return 0;
      showError(error, file);
      return 0;
    }
  }

  function loadFiles(list: File[]) {
    const generation = importGeneration;
    loadQueue = loadQueue
      .then(async () => {
        if (generation !== importGeneration) return;
        const controller = new AbortController();
        inputController = controller;
        let selection: string | undefined;
        let importedTracks = 0;
        uiButton('#import-cancel').hidden = false;
        onImportProgress({
          phase: 'loading',
          value: null,
          detail: list[0]?.name,
        });
        try {
          const inputs = await chooseAudioInputs(list, controller.signal);
          if (generation !== importGeneration) return;
          if (!inputs.length) {
            showError({ code: 'NO_AUDIO' });
            return;
          }
          const opened = await call(
            'inputs-open',
            { files: companionFiles(list) },
            false,
          );
          selection = opened.selection;
          if (generation !== importGeneration) return;
          const fileIndices = new Map(list.map((file, index) => [file, index]));
          onImportProgress(null);
          for (const file of inputs) {
            if (generation !== importGeneration) break;
            importedTracks +=
              (await importAudioFile(
                file,
                selection,
                fileIndices.get(file),
                generation,
              )) || 0;
          }
        } finally {
          onImportProgress(null);
          if (selection)
            await call('inputs-close', { selection }, false).catch(() => {});
          if (inputController === controller) inputController = null;
          uiButton('#import-cancel').hidden = true;
          refreshLibrary();
        }
        if (generation === importGeneration && importedTracks)
          toast(t('loaded') + ' · ' + importedTracks);
      })
      .catch(showError);
    return loadQueue;
  }

  uiButton('#choose-audio-folder').onclick = () =>
    openFilePicker(uiInput('#audio-folder'));
  uiInput('#audio-folder').onchange = () => {
    const input = uiInput('#audio-folder');
    if (input.files?.length) void loadFiles(Array.from(input.files));
  };

  async function removeGroup(group: string, redraw = true) {
    const removed = allTracks.filter((t) => t.group === group).map((t) => t.id);
    if (selected !== null && removed.includes(selected)) {
      stop(true);
      selected = null;
      renderToken++;
    }
    allTracks = allTracks.filter((t) => t.group !== group);
    files = files.filter((f) => f.group !== group);
    for (const id of removed) {
      selectedIds.delete(id);
      durations.delete(id);
    }
    await call(
      'remove',
      {
        group,
      },
      false,
    );
    if (redraw) {
      renderLibrary();
      renderFiles();
      if (!selected && allTracks.length) {
        select(allTracks.find((t) => t.playable)?.id || allTracks[0].id);
      } else {
        updateNow();
      }
    }
  }

  function filtered() {
    return orderAudioTracks(
      allTracks.filter(
        (t) =>
          (filter === 'all' || category(t) === filter) &&
          (!search ||
            (title(t) + ' ' + t.format + ' ' + t.source)
              .toLocaleLowerCase()
              .includes(search)),
      ),
    );
  }

  function renderLibrary() {
    renderAudioLibrary(
      {
        allTracks,
        visible: filtered(),
        selected,
        selectedIds,
        playing,
        durations,
        trackPageSize,
        files,
      },
      {
        select,
        openExport,
        togglePlayback,
        playTrack,
        onSelection: (id, checked) => {
          checked ? selectedIds.add(id) : selectedIds.delete(id);
          updateSelection();
        },
      },
    );
    updateSelection();
  }

  function updateSelection() {
    const visible = filtered(),
      count = visible.filter((t) => selectedIds.has(t.id)).length;
    uiInput('#select-all').checked = count > 0 && count === visible.length;
    uiInput('#select-all').indeterminate = count > 0 && count < visible.length;
    uiInput('#select-all').disabled = !visible.length;
    uiButton('#zip-btn').disabled = !selectedIds.size;
    uiButton('#zip-btn').title = `${selectedIds.size} ${t('selected')}`;
  }

  uiButton('#tracks-more').onclick = () => {
    trackPageSize += 200;
    renderLibrary();
  };

  uiInput('#select-all').onchange = () => {
    for (const track of filtered()) {
      uiInput('#select-all').checked
        ? selectedIds.add(track.id)
        : selectedIds.delete(track.id);
    }
    renderLibrary();
  };

  elements('[data-filter]').forEach(
    (b) =>
      (b.onclick = () => {
        filter = b.dataset.filter ?? 'all';
        trackPageSize = 200;
        elements('[data-filter]').forEach((x) => {
          x.classList.toggle('active', x === b);
          x.setAttribute('aria-selected', String(x === b));
        });
        renderLibrary();
      }),
  );

  uiInput('#search').oninput = () => {
    search = uiInput('#search').value.toLocaleLowerCase().trim();
    trackPageSize = 200;
    renderLibrary();
  };

  uiButton('#reset-search').onclick = () => {
    search = '';
    uiInput('#search').value = '';
    filter = 'all';
    elements('[data-filter]').forEach((b) => {
      b.classList.toggle('active', b.dataset.filter === 'all');
      b.setAttribute('aria-selected', String(b.dataset.filter === 'all'));
    });
    renderLibrary();
  };

  function renderFiles() {
    renderImportedFiles(files, filePageSize, {
      archive: async (group) => {
        try {
          await prepareAndSaveOutput(() => call('archive', { group }), {
            filename: 'romstudio-source-audio.zip',
            call,
            download,
          });
        } catch (error) {
          if (!isAbortError(error)) showError(error);
        }
      },
      remove: removeGroup,
      showError,
    });
  }

  function refreshLibrary() {
    clearTimeout(libraryRefreshTimer);
    libraryRefreshTimer = 0;
    renderLibrary();
    renderFiles();
  }

  function scheduleLibraryRefresh() {
    if (!libraryRefreshTimer) {
      libraryRefreshTimer = setTimeout(refreshLibrary, 100);
    }
  }

  uiButton('#files-more').onclick = () => {
    filePageSize += 200;
    renderFiles();
  };

  function select(id: string | null | undefined) {
    if (!id) {
      return;
    }
    const track = allTracks.find((t) => t.id === id);
    if (!track) {
      return;
    }
    if (id !== selected) {
      stop(true);
      selected = id;
      renderToken++;
      drawWave();
    }
    updateNow();
    renderLibrary();
  }

  function updateNow() {
    const track = allTracks.find((item) => item.id === selected);
    mediaControls.update(
      track ? { title: title(track), album: track.source } : null,
      {
        playing: playing || !!live?.wantsPlay,
        position: live?.currentTime ?? 0,
        duration: live?.duration ?? null,
        rate: live?.rate ?? 1,
      },
    );
    element('#now-name').textContent =
      live?.info?.title || (track ? title(track) : t('nothingPlaying'));
    element('#now-meta').textContent = track
      ? [track.format, live?.info?.game, live?.info?.artist, track.source]
          .filter(Boolean)
          .join(' · ')
      : '';
    element('#mini-name').textContent = track ? title(track) : '';
    uiButton('#play-btn').disabled = !track?.playable;
    uiButton('#prev-btn').disabled = !track?.playable;
    uiButton('#next-btn').disabled = !track?.playable;
    uiButton('#player-export').disabled = !track;
    updateCartridgeControls(track?.format, playing && !!live?.session);
    uiButton('#stop-btn').disabled = !live?.session;
    uiInput('#seek').disabled = !live?.session;
    uiButton('#back-btn').disabled = !live?.session;
    uiButton('#forward-btn').disabled = !live?.session;
    element('#total-time').textContent =
      live && live.duration !== null ? formatTime(live.duration) : '—';
    element('#audio-details').textContent = live?.sampleRate
      ? (live.sampleRate / 1000).toFixed(1) + ' kHz'
      : '';
    element('#mini-player').hidden =
      playerInView ||
      !live?.session ||
      document.body.classList.contains('mode-converter');

    updateTimeline();
    updatePlayIcons();
    if (playing && !animationFrame)
      animationFrame = requestAnimationFrame(frame);
  }

  function updateTimeline() {
    const position = live?.currentTime ?? 0;
    element('#mini-time').textContent = formatTime(position);

    if (!scrubbing) {
      uiInput('#seek').max = String(
        live?.duration ?? Math.max(60, Math.ceil((position + 30) / 30) * 30),
      );
      uiInput('#seek').value = String(position);
      updateRange(uiInput('#seek'));
      element('#elapsed').textContent = formatTime(position);
    }
  }

  function audio() {
    if (!audioContext) {
      audioContext = new AudioContext();
      gain = audioContext.createGain();
      gain.gain.value = muted ? 0 : Number(uiInput('#volume').value);
      visualizer = new AudioVisualizer(audioContext, audioContext.destination);
      visualizer.mode =
        uiButton('#visual-wave').getAttribute('aria-pressed') === 'true'
          ? 'waveform'
          : 'spectrum';
      gain.connect(visualizer.input);
    }
    return audioContext;
  }

  function stop(reset = false) {
    renderToken++;
    if (live) {
      if (reset) {
        const old = live;
        live = null;
        old.dispose();
      } else {
        live.pause();
      }
    }
    playing = false;
    updateNow();
  }

  function updatePlayIcons() {
    const active = playing || !!live?.wantsPlay;
    uiButton('#play-btn').innerHTML = icon(active ? 'pause' : 'play');
    uiButton('#play-btn').title = t(active ? 'pause' : 'play');
    uiButton('#play-btn').setAttribute(
      'aria-label',
      t(active ? 'pause' : 'play'),
    );
    uiButton('#mini-play').innerHTML = icon(active ? 'pause' : 'play');
    uiButton('#mini-play').setAttribute(
      'aria-label',
      t(active ? 'pause' : 'play'),
    );
    uiButton('#mini-play').title = t(active ? 'pause' : 'play');
    document.body.classList.toggle('playing', playing);
    elements('[data-play]').forEach((b) => {
      const yes = b.dataset.play === selected && active;
      b.innerHTML = icon(yes ? 'pause' : 'play');
      const tr = allTracks.find((t) => t.id === b.dataset.play);
      b.setAttribute(
        'aria-label',
        t(yes ? 'pause' : 'play') + ': ' + (tr ? title(tr) : ''),
      );
    });
  }

  async function playTrack(id: string) {
    select(id);
    await togglePlayback();
  }

  async function togglePlayback() {
    if (playing || live?.wantsPlay) {
      stop();
      return;
    }
    const track = allTracks.find((t) => t.id === selected);
    if (!track?.playable) {
      return;
    }
    const token = ++renderToken;
    uiButton('#play-btn').disabled = true;
    try {
      const ctx = audio();
      await ctx.resume();

      if (
        token !== renderToken ||
        selected !== track.id ||
        document.body.classList.contains('mode-converter')
      ) {
        return;
      }

      if (!live || live.track !== track.id || !live.session) {
        if (live) {
          live.dispose();
        }
        const player = new LivePlayer({
          call,
          context: ctx,
          onError: showError,
          onEnded: () => {
            if (
              live === player &&
              selected === track.id &&
              uiButton('#autoplay-btn').getAttribute('aria-pressed') ===
                'true' &&
              !document.body.classList.contains('mode-converter')
            ) {
              step(1, false);
            }
          },
          onChange: (data) => {
            if (live !== player) {
              return;
            }
            playing = player.playing;
            if (player.session && player.sampleRate > 0) {
              const previousCategory = category(track);
              track.audio = {
                sampleRate: player.sampleRate,
                channels: track.audio?.channels ?? 2,
                length:
                  player.duration === null
                    ? null
                    : Math.round(player.duration * player.sampleRate),
                loop: player.sourceLoop,
              };
              if (player.duration !== null)
                durations.set(track.id, player.duration);
              if (category(track) !== previousCategory)
                scheduleLibraryRefresh();
            }
            updateNow();
            if (data) {
              drawWave(data);
            }
            if (!playing) {
              renderLibrary();
            }
          },
        });
        live = player;
        player.destination = gain;
        player.loop =
          uiButton('#loop-btn').getAttribute('aria-pressed') === 'true';
        player.setRate(Number(uiSelect('#playback-rate').value) || 1);
        const opened = await player.open(track.id);
        if (!opened || token !== renderToken || selected !== track.id) {
          return;
        }
      }
      await live.play();
    } catch (e) {
      if (token === renderToken) {
        showError(e);
      }
    } finally {
      if (token === renderToken && selected === track.id) {
        uiButton('#play-btn').disabled = false;
      }
    }
  }

  uiButton('#play-btn').onclick = togglePlayback;

  uiButton('#stop-btn').onclick = () => {
    stop(true);
    drawWave();
    updateNow();
    renderLibrary();
  };

  function nextPlayable(dir: number, wrap = true) {
    const choices = filtered().filter((track) => track.playable);
    if (!choices.length) return null;
    const at = choices.findIndex((track) => track.id === selected);

    if (
      uiButton('#shuffle-btn').getAttribute('aria-pressed') === 'true' &&
      choices.length > 1
    ) {
      const others = choices.filter((track) => track.id !== selected);
      return others[Math.floor(Math.random() * others.length)];
    }

    const index = at + dir;
    if (!wrap && (index < 0 || index >= choices.length)) return null;
    return choices[(index + choices.length) % choices.length];
  }

  function step(dir: number, wrap = true) {
    const track = nextPlayable(dir, wrap);
    if (track) void playTrack(track.id);
  }

  uiButton('#prev-btn').onclick = () => step(-1);
  uiButton('#next-btn').onclick = () => step(1);
  uiButton('#mini-prev').onclick = () => step(-1);
  uiButton('#mini-next').onclick = () => step(1);
  uiButton('#mini-play').onclick = togglePlayback;
  uiButton('#mini-open').onclick = () =>
    element('#main-player').scrollIntoView({
      behavior: 'smooth',
      block: 'center',
    });

  for (const id of ['shuffle-btn', 'autoplay-btn', 'loop-btn']) {
    element('#' + id).onclick = () => {
      const yes = element('#' + id).getAttribute('aria-pressed') !== 'true';
      element('#' + id).setAttribute('aria-pressed', String(yes));
      if (id === 'loop-btn' && live) live.loop = yes;
    };
  }

  function updateRange(input: HTMLInputElement) {
    const minimum = Number(input.min) || 0;
    const maximum = Number(input.max) || 1;
    const percentage =
      maximum > minimum
        ? ((Number(input.value) - minimum) / (maximum - minimum)) * 100
        : 0;
    input.style.setProperty(
      '--progress',
      Math.max(0, Math.min(100, percentage)) + '%',
    );
  }

  function updateVolume() {
    const value = Number(uiInput('#volume').value);
    if (gain && audioContext)
      gain.gain.setTargetAtTime(
        muted ? 0 : value,
        audioContext.currentTime,
        0.012,
      );
    element('#volume-value').textContent = Math.round(value * 100) + '%';
    updateRange(uiInput('#volume'));
    uiButton('#mute-btn').innerHTML = icon(
      muted || !value ? 'muted' : 'volume',
    );
    uiButton('#mute-btn').setAttribute('aria-pressed', String(muted));
    uiButton('#mute-btn').setAttribute(
      'aria-label',
      t(muted ? 'unmute' : 'mute'),
    );
    uiButton('#mute-btn').title = t(muted ? 'unmute' : 'mute');
  }

  uiInput('#volume').oninput = updateVolume;
  uiButton('#mute-btn').onclick = () => {
    muted = !muted;
    updateVolume();
  };
  uiSelect('#playback-rate').onchange = () => {
    if (live)
      Promise.resolve(
        live.setRate(Number(uiSelect('#playback-rate').value)),
      ).catch(showError);
  };
  uiButton('#back-btn').onclick = () => {
    if (live) seekTo(live.currentTime - 10);
  };
  uiButton('#forward-btn').onclick = () => {
    if (live) seekTo(live.currentTime + 10);
  };

  function seekTo(seconds: number) {
    if (!live) return;
    void live.seek(Math.max(0, seconds)).catch(showError);
  }
  uiInput('#seek').oninput = () => {
    const input = uiInput('#seek');
    scrubbing = true;
    element('#elapsed').textContent = formatTime(Number(input.value));
    updateRange(input);
  };
  uiInput('#seek').onchange = () => {
    scrubbing = false;
    seekTo(Number(uiInput('#seek').value));
  };

  for (const mode of ['spectrum', 'wave']) {
    element('#visual-' + mode).onclick = () => {
      for (const name of ['spectrum', 'wave'])
        element('#visual-' + name).setAttribute(
          'aria-pressed',
          String(name === mode),
        );
      if (visualizer)
        visualizer.mode = mode === 'wave' ? 'waveform' : 'spectrum';
      drawWave();
    };
  }

  if (typeof IntersectionObserver === 'function') {
    new IntersectionObserver(
      ([entry]) => {
        playerInView = entry.isIntersecting;
        updateNow();
      },
      { threshold: 0.05 },
    ).observe(element('#main-player'));
  }

  document.addEventListener('keydown', (e) => {
    if (
      e.code === 'Space' &&
      !document.body.classList.contains('mode-converter') &&
      !(
        e.target instanceof Element &&
        ['INPUT', 'SELECT', 'TEXTAREA', 'BUTTON'].includes(e.target.tagName)
      ) &&
      !document.querySelector('dialog[open]')
    ) {
      e.preventDefault();
      togglePlayback();
    }
  });

  function drawWave(_data?: Float32Array) {
    if (document.hidden || !visualizer || (playing && !playerInView)) return;
    visualizer.draw(uiCanvas('#waveform'), playing);
    const levels = visualizer.levels(playing);
    element('#meter-left').style.transform = 'scaleX(' + levels[0] + ')';
    element('#meter-right').style.transform = 'scaleX(' + levels[1] + ')';
  }

  window.addEventListener('resize', () => drawWave());

  function frame(time: number) {
    if (!playing || document.hidden) {
      animationFrame = 0;
      drawWave();
      return;
    }

    if (time - lastFrame >= 33 && !document.hidden) {
      lastFrame = time;

      updateTimeline();
      if (playerInView) drawWave();
    }

    animationFrame = requestAnimationFrame(frame);
  }

  document.addEventListener('visibilitychange', () => {
    if (document.hidden) return;
    updateNow();
    drawWave();
    if (
      live?.wantsPlay &&
      audioContext &&
      audioContext.state !== 'running' &&
      audioContext.state !== 'closed'
    )
      void audioContext.resume().catch(showError);
  });

  window.addEventListener('pagehide', (event) => {
    if (event.persisted) return;
    mediaControls.dispose();
    void call('clearKeys', {}, false).catch(() => {});
  });

  uiButton('#zip-btn').onclick = async () => {
    const ids = [...selectedIds];
    if (!ids.length) {
      return;
    }
    uiButton('#zip-btn').disabled = true;
    try {
      await prepareAndSaveOutput(() => call('zip', { tracks: ids }), {
        filename: 'romstudio-originals.zip',
        maximumSize: zipOutputBound(
          allTracks.filter((track) => selectedIds.has(track.id)),
        ),
        call,
        download,
      });
      toast(t('done'));
    } catch (e) {
      if (!isAbortError(e)) showError(e);
    } finally {
      updateSelection();
    }
  };

  return {
    loadFiles,
    pause: () => stop(),
    translate: () => {
      renderLibrary();
      renderFiles();
      updateNow();
      updateVolume();
      exporter.refresh();
    },
  };
}
