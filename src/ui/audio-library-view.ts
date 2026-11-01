import type { TrackMetadata } from '../contracts.js';
import type { ImportedAudioFile } from './audio-types.js';
import { t } from '../i18n.js';
import { classifyAudio as category } from '../audio-category.js';
import {
  element,
  button as uiButton,
  childElement,
  childButton,
  childInput,
} from './elements.js';
import { icon } from './icons.js';
import { formatTime, formatSize } from './formatters.js';

interface AudioLibraryState {
  allTracks: readonly TrackMetadata[];
  visible: readonly TrackMetadata[];
  selected: string | null;
  selectedIds: ReadonlySet<string>;
  playing: boolean;
  durations: ReadonlyMap<string, number>;
  trackPageSize: number;
  files: readonly ImportedAudioFile[];
}

interface AudioLibraryActions {
  select: (id: string) => void;
  openExport: (id: string) => void;
  togglePlayback: () => Promise<void>;
  playTrack: (id: string) => Promise<void>;
  onSelection: (id: string, selected: boolean) => void;
}

interface ImportedFileActions {
  archive: (group: string) => Promise<void>;
  remove: (group: string) => Promise<void>;
  showError: (error: unknown) => void;
}

const title = (track: TrackMetadata) => track.name;

export function renderAudioLibrary(
  state: AudioLibraryState,
  actions: AudioLibraryActions,
) {
  const {
    allTracks,
    visible,
    selected,
    selectedIds,
    playing,
    durations,
    trackPageSize,
    files,
  } = state;
  const { select, openExport, togglePlayback, playTrack, onSelection } =
    actions;
  const list = element('#track-list');
  list.replaceChildren();
  element('#library-total').textContent = String(allTracks.length);
  element('#empty').hidden = allTracks.length > 0;
  element('#no-matches').hidden = !allTracks.length || visible.length > 0;
  for (const [i, track] of visible.slice(0, trackPageSize).entries()) {
    const row = document.createElement('div');
    row.className = 'track-row' + (selected === track.id ? ' active' : '');
    row.setAttribute('role', 'row');
    row.dataset.track = track.id;
    row.innerHTML = `
      <span role="cell">
        <input type="checkbox" class="track-check">
      </span>
      <button class="track-play" data-tone="${i % 3}">
        ${icon(selected === track.id && playing ? 'pause' : 'play')}
      </button>
      <div class="track-name" role="cell">
        <span class="track-title"></span>
        <span class="track-subtitle"></span>
      </div>
      <span class="track-category type-col ${category(track)}" role="cell"></span>
      <span class="format-badge format-col" role="cell"></span>
      <span class="time-col" role="cell"></span>
      <button class="icon-button row-export">
        ${icon('download')}
      </button>
    `;
    const checkbox = childInput(row, 'input');
    checkbox.checked = selectedIds.has(track.id);
    checkbox.setAttribute('aria-label', t('selected') + ': ' + title(track));
    checkbox.onchange = () => {
      onSelection(track.id, checkbox.checked);
    };
    childElement(row, '.track-title').textContent = title(track);
    childElement(row, '.track-subtitle').textContent =
      track.source + (!track.playable ? ' · ' + t('unsupported') : '');
    childElement(row, '.track-category').textContent = t(category(track));
    childElement(row, '.format-badge').textContent = track.format;
    const seconds =
      durations.get(track.id) ??
      (track.audio?.length === null || !track.audio
        ? undefined
        : track.audio.length / track.audio.sampleRate);
    childElement(row, '.time-col').textContent =
      seconds === undefined ? '—' : formatTime(seconds);
    const play = childButton(row, '.track-play');
    play.dataset.play = track.id;
    play.setAttribute(
      'aria-label',
      t(selected === track.id && playing ? 'pause' : 'play') +
        ': ' +
        title(track),
    );
    play.onclick = () => {
      if (!track.playable) {
        select(track.id);
        openExport(track.id);
        return;
      }
      if (selected === track.id) {
        togglePlayback();
      } else {
        playTrack(track.id);
      }
    };
    const exp = childButton(row, '.row-export');
    exp.setAttribute('aria-label', t('export') + ': ' + title(track));
    exp.onclick = () => openExport(track.id);
    childElement(row, '.track-name').onclick = () => select(track.id);
    list.append(row);
  }
  uiButton('#tracks-more').hidden = visible.length <= trackPageSize;
  element('#library-summary').textContent =
    `${String(allTracks.length).padStart(2, '0')} ${t('trackCount')} · ${files.length} ${t('fileCount')}`;
}

export function renderImportedFiles(
  files: readonly ImportedAudioFile[],
  filePageSize: number,
  actions: ImportedFileActions,
) {
  const list = element('#file-list');
  list.replaceChildren();
  element('#file-total').textContent = String(files.length);
  element('#file-drawer').hidden = !files.length;
  uiButton('#files-more').hidden = files.length <= filePageSize;
  for (const file of files.slice(0, filePageSize)) {
    const row = document.createElement('div');
    row.className = 'file-item';
    const span = document.createElement('span');
    span.textContent = file.name;
    const small = document.createElement('small');
    small.textContent = formatSize(file.size);
    span.append(small);
    row.append(span);
    const tools = document.createElement('div');
    tools.className = 'file-tools';
    const save = document.createElement('button');
    save.className = 'text-button';
    save.textContent = t('sourceAudio');
    save.onclick = async () => {
      save.disabled = true;
      try {
        await actions.archive(file.group);
      } catch (e) {
        actions.showError(e);
      } finally {
        save.disabled = false;
      }
    };
    const remove = document.createElement('button');
    remove.className = 'icon-button';
    remove.innerHTML = icon('x');
    remove.title = t('remove');
    remove.setAttribute('aria-label', t('remove') + ': ' + file.name);
    remove.onclick = () => actions.remove(file.group);
    tools.append(save, remove);
    row.append(tools);
    list.append(row);
  }
}
