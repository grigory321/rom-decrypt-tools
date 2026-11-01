import type {
  UiServices,
  ContentsMetadata,
  ContentMetadata,
  RpcArguments,
} from '../rpc-types.js';
import { bufferBytes } from '../binary.js';
import { element, input, select as selectElement, button } from './elements.js';
import { errorName } from '../container-errors.js';
import { bufferedOutputLimit } from '../output-limits.js';
import { chooseMainFile, companionFiles } from '../file-selection.js';
import { t } from '../i18n.js';
import { icon } from './icons.js';
import { formatSize } from './formatters.js';
import { createProgressIndicator } from './progress-indicator.js';
import { openFilePicker } from './file-picker.js';

interface ContentsServices extends UiServices {
  onAudio?: (files: File[]) => void;
}
interface OpenArchive extends ContentsMetadata {
  name: string;
  currentFile: File;
  directory: boolean;
}

function contentKind(kind: string) {
  return [
    'code',
    'romfs',
    'metadata',
    'container',
    'nitrofs',
    'file',
    'cartridge',
    'audio',
    'directory',
  ].includes(kind)
    ? kind
    : 'file';
}

function hexDump(bytes: Uint8Array) {
  const lines: string[] = [];

  for (let offset = 0; offset < bytes.length; offset += 16) {
    const row = bytes.subarray(offset, offset + 16);
    const hex = [...row]
      .map((value) => value.toString(16).padStart(2, '0'))
      .join(' ');
    const ascii = [...row]
      .map((value) =>
        value >= 32 && value < 127 ? String.fromCharCode(value) : '.',
      )
      .join('');
    lines.push(
      offset.toString(16).padStart(8, '0') +
        '  ' +
        hex.padEnd(47) +
        '  ' +
        ascii,
    );
  }

  return lines.join('\n');
}

export function initContents({
  call,
  download,
  showError,
  onAudio,
}: ContentsServices) {
  let selectedFiles: File[] = [];
  const saveIndicator = createProgressIndicator('#contents-saving');
  let folderName: string | null = null;
  let archive: OpenArchive | null = null;
  let generation = 0;
  let previewGeneration = 0;
  let visibleCount = 200;
  let loading = false;
  let saving = false;
  let saveGeneration = 0;
  const selected = new Set<number>();

  function clearPreview() {
    previewGeneration++;
    element('#contents-preview').hidden = true;
    element('#contents-hex').textContent = '';
  }

  function entries() {
    const search = input('#contents-search').value.toLocaleLowerCase().trim();
    const kind = selectElement('#contents-kind').value;
    return (archive?.entries || []).filter(
      (entry) =>
        (!search || entry.path.toLocaleLowerCase().includes(search)) &&
        (kind === 'all' ||
          contentKind(entry.kind) === kind ||
          (kind === 'romfs' && entry.kind === 'directory')),
    );
  }

  function updateSelection() {
    const files = entries().filter((entry) => entry.kind !== 'directory');
    const count = files.filter((entry) => selected.has(entry.id)).length;
    input('#contents-select-all').checked =
      !!files.length && count === files.length;
    input('#contents-select-all').indeterminate =
      count > 0 && count < files.length;
    input('#contents-select-all').disabled = !files.length || saving;
    button('#contents-zip').disabled = !selected.size || saving;
    button('#contents-zip-all').disabled =
      !archive?.entries.some((entry) => entry.kind !== 'directory') || saving;
    element('#contents-selected').textContent = String(selected.size);
  }

  async function preview(entry: ContentMetadata) {
    if (!archive) return;
    const token = generation;
    const previewToken = ++previewGeneration;
    element('#contents-preview-name').textContent = entry.path;
    element('#contents-hex').textContent = '';
    element('#contents-preview').hidden = false;

    try {
      const bytes = await call(
        'contents-preview',
        { session: archive.session, entry: entry.id },
        false,
      );
      if (token !== generation || previewToken !== previewGeneration) return;
      element('#contents-hex').textContent = hexDump(bytes) || t('emptyFile');
    } catch (error) {
      if (token === generation && previewToken === previewGeneration)
        showError(error);
    }
  }

  async function saveSource<K extends 'contents-file' | 'contents-zip'>(
    type: K,
    data: RpcArguments[K],
    filename: string,
    estimatedSize: number,
    mime: string,
  ) {
    if (!archive || saving) return;
    const token = generation;
    const operation = ++saveGeneration;
    let writable: FileSystemWritableFileStream | null | undefined;
    let handle: FileSystemFileHandle | undefined;
    let job: string | undefined;
    saving = true;
    saveIndicator.set(t('savingContents'), 0);
    render();

    const checkCurrent = () => {
      if (token !== generation || operation !== saveGeneration)
        throw { code: 'CANCELLED' };
    };
    const chooseDestination = async () => {
      if (typeof window.showSaveFilePicker !== 'function')
        throw { code: 'STREAM_BROWSER' };
      const result = await window.showSaveFilePicker({
        suggestedName: filename,
      });
      checkCurrent();
      return result;
    };

    try {
      if (estimatedSize > bufferedOutputLimit)
        handle = await chooseDestination();
      const result = await call(type, data, false);
      job = result.job;
      checkCurrent();
      if (!handle && result.size > bufferedOutputLimit)
        handle = await chooseDestination();

      if (handle) {
        writable = await handle.createWritable();
        checkCurrent();
      }

      const chunks: Uint8Array<ArrayBuffer>[] = [];
      let offset = 0;

      while (offset < result.size) {
        const bytes = await call('chunk', { job, offset }, false);
        checkCurrent();
        if (!bytes.length || offset + bytes.length > result.size)
          throw { code: 'BOUNDS' };
        if (writable) {
          await writable.write(bufferBytes(bytes));
          checkCurrent();
        } else chunks.push(bufferBytes(bytes));
        offset += bytes.length;
        saveIndicator.set(t('savingContents'), offset / result.size);
      }

      checkCurrent();
      if (writable) {
        await writable.close();
        writable = null;
      } else
        download({
          filename: result.filename,
          blob: new Blob(chunks, { type: mime }),
        });
    } catch (error) {
      if (writable) {
        try {
          await writable.abort();
        } catch {}
      }
      if (token === generation && errorName(error) !== 'AbortError')
        showError(error);
    } finally {
      if (job) await call('release', { job }, false).catch(() => {});
      if (operation === saveGeneration) {
        saving = false;
        render();
      }
    }
  }

  function save(entry: ContentMetadata) {
    if (!archive) return;
    return saveSource(
      'contents-file',
      { session: archive.session, entry: entry.id },
      entry.path.split('/').at(-1) || '',
      entry.size,
      'application/octet-stream',
    );
  }

  function saveZip(all: boolean) {
    if (!archive || saving) return;
    const chosen = archive.entries.filter(
      (entry) => all || (entry.kind !== 'directory' && selected.has(entry.id)),
    );
    if (!chosen.length) return;
    const estimatedSize =
      98 +
      chosen.reduce(
        (total, entry) =>
          total +
          entry.size +
          148 +
          new TextEncoder().encode(entry.path).length * 2,
        0,
      );
    const filename = archive.name.replace(/\.[^.]+$/, '') + '-contents.zip';
    return saveSource(
      'contents-zip',
      {
        session: archive.session,
        all,
        entries: all ? undefined : [...selected],
      },
      filename,
      estimatedSize,
      'application/zip',
    );
  }

  function render() {
    const list = element('#contents-list');
    list.replaceChildren();
    const filtered = entries();
    element('#contents-browser').hidden = !archive && !loading;
    element('#contents-file-heading').hidden = !archive && !loading && !saving;
    element('#contents-empty').hidden = !!archive || loading;
    element('#contents-table').hidden = !archive;
    element('#contents-loading').hidden = !loading;
    button('#contents-cancel').hidden = !loading && !saving;
    element('#contents-saving').hidden = !saving;
    button('#contents-clear').disabled = !archive && !loading && !saving;
    element('#contents-source').textContent = archive?.name || '';
    element('#contents-source-picker').hidden = !selectedFiles.length;
    button('#contents-audio').disabled = !archive || loading || saving;
    selectElement('#contents-file-select').disabled = loading || saving;
    input('#contents-file-search').disabled = loading || saving;
    element('#contents-total').textContent = archive
      ? String(
          archive.entries.filter((entry) => entry.kind !== 'directory').length,
        )
      : '0';
    element('#contents-more').hidden = filtered.length <= visibleCount;

    for (const entry of filtered.slice(0, visibleCount)) {
      const row = document.createElement('div');
      row.className =
        'content-row' + (entry.kind === 'directory' ? ' directory-row' : '');
      const checkbox = document.createElement('input');
      checkbox.type = 'checkbox';
      checkbox.checked = selected.has(entry.id);
      checkbox.disabled = entry.kind === 'directory' || saving;
      checkbox.setAttribute('aria-label', t('selected') + ': ' + entry.path);
      checkbox.onchange = () => {
        checkbox.checked ? selected.add(entry.id) : selected.delete(entry.id);
        updateSelection();
      };
      const name = document.createElement('button');
      name.className = 'content-name';
      name.disabled = entry.kind === 'directory';
      name.innerHTML = icon(
        entry.kind === 'directory'
          ? 'folder'
          : entry.kind === 'code'
            ? 'code'
            : 'file',
      );
      const path = document.createElement('span');
      path.className = 'content-label';
      const basename = entry.path.split('/').filter(Boolean).at(-1) || '';
      const filename = document.createElement('strong');
      filename.textContent = basename;
      const parent = document.createElement('small');
      parent.textContent = entry.path.slice(
        0,
        entry.path.lastIndexOf(basename),
      );
      path.append(filename, parent);
      name.append(path);
      name.title = entry.path;
      name.onclick = () => preview(entry);
      const kind = document.createElement('span');
      kind.className = 'content-kind';
      kind.textContent = t('kind_' + contentKind(entry.kind));
      const size = document.createElement('span');
      size.className = 'content-size';
      size.textContent =
        entry.kind === 'directory' ? '—' : formatSize(entry.size);
      const button = document.createElement('button');
      button.className = 'icon-button';
      button.innerHTML = icon('download');
      button.disabled = entry.kind === 'directory' || saving;
      button.setAttribute('aria-label', t('downloadFile') + ': ' + entry.path);
      button.onclick = () => save(entry);
      row.append(checkbox, name, kind, size, button);
      list.append(row);
    }

    element('#contents-no-matches').hidden = !archive || filtered.length > 0;
    updateSelection();
  }

  async function clear() {
    generation++;
    selectedFiles = [];
    folderName = null;
    archive = null;
    saveGeneration++;
    saving = false;
    loading = false;
    selected.clear();
    clearPreview();
    render();
    await call('contents-clear', {}, false);
  }

  async function open(file: File, directory = false) {
    const token = ++generation;
    archive = null;
    saveGeneration++;
    saving = false;
    loading = true;
    selected.clear();
    visibleCount = 200;
    clearPreview();
    render();

    try {
      await call('contents-clear', {}, false);
      if (token !== generation) return;
      const companions = companionFiles(
        selectedFiles.filter((item) => item !== file),
      );
      const main = directory
        ? { file, name: file.name, path: file.webkitRelativePath || file.name }
        : file;
      const result = await call('contents-open', {
        file: main,
        sourcePath: file.webkitRelativePath || file.name,
        companions,
        directory,
      });
      if (token !== generation) return;
      archive = {
        ...result,
        name: directory
          ? (file.webkitRelativePath || file.name).split('/')[0]
          : file.name,
        currentFile: file,
        directory,
      };
      renderFileChoices(file, directory);
    } catch (error) {
      if (token === generation) showError(error);
    } finally {
      if (token === generation) {
        loading = false;
        render();
      }
    }
  }

  function renderFileChoices(current: File | undefined, directory = false) {
    const select = selectElement('#contents-file-select');
    select.replaceChildren();
    if (folderName) {
      const option = document.createElement('option');
      option.value = 'folder';
      option.textContent = folderName + '/';
      option.selected = directory;
      select.append(option);
    }
    const search = input('#contents-file-search')
      .value.toLocaleLowerCase()
      .trim();
    input('#contents-file-search').hidden = selectedFiles.length <= 200;
    let shown = 0;
    let currentShown = false;
    for (const [index, file] of selectedFiles.entries()) {
      if (shown >= 200) break;
      if (
        search &&
        !(file.webkitRelativePath || file.name)
          .toLocaleLowerCase()
          .includes(search)
      )
        continue;
      const option = document.createElement('option');
      option.value = String(index);
      option.textContent = file.webkitRelativePath || file.name;
      option.selected = file === current && !directory;
      currentShown ||= file === current;
      select.append(option);
      shown++;
    }
    if (current && !currentShown && !directory) {
      const option = document.createElement('option');
      option.value = String(selectedFiles.indexOf(current));
      option.textContent = current.webkitRelativePath || current.name;
      option.selected = true;
      select.append(option);
    }
  }
  function openSelection(files: File[], directory = false) {
    selectedFiles = files;
    input('#contents-file-search').value = '';
    folderName = directory
      ? (files[0]?.webkitRelativePath || files[0]?.name || '').split('/')[0]
      : null;
    const main = chooseMainFile(files);
    renderFileChoices(main, directory);
    if (main) void open(main, directory);
  }
  const fileInput = input('#contents-input');
  fileInput.onchange = () => {
    if (fileInput.files?.length) openSelection([...fileInput.files]);
  };
  button('#choose-contents-folder').onclick = () =>
    openFilePicker(input('#contents-folder'));
  const folderInput = input('#contents-folder');
  folderInput.onchange = () => {
    if (folderInput.files?.length) openSelection([...folderInput.files], true);
  };
  const fileSelect = selectElement('#contents-file-select');
  fileSelect.onchange = () => {
    if (fileSelect.value === 'folder') {
      const main = chooseMainFile(selectedFiles);
      if (main) void open(main, true);
      return;
    }
    const file = selectedFiles[Number(fileSelect.value)];
    if (file) void open(file, false);
  };
  button('#contents-audio').onclick = () => onAudio?.(selectedFiles);
  input('#contents-file-search').oninput = () =>
    renderFileChoices(archive?.currentFile, archive?.directory);
  const drop = button('#contents-drop');
  drop.addEventListener('click', () => openFilePicker(fileInput));

  for (const type of ['dragenter', 'dragover', 'dragleave', 'drop']) {
    drop.addEventListener(type, (event) => {
      event.preventDefault();
      event.stopPropagation();
    });
  }

  drop.addEventListener('dragover', () => drop.classList.add('drag'));
  drop.addEventListener('dragleave', () => drop.classList.remove('drag'));
  drop.addEventListener('drop', (event) => {
    drop.classList.remove('drag');
    if (event.dataTransfer?.files.length)
      openSelection([...event.dataTransfer.files]);
  });
  button('#contents-clear').onclick = () => clear().catch(showError);
  button('#contents-cancel').onclick = () => clear().catch(showError);
  input('#contents-search').oninput = () => {
    visibleCount = 200;
    render();
  };
  selectElement('#contents-kind').onchange = () => {
    visibleCount = 200;
    render();
  };
  element('#contents-more').onclick = () => {
    visibleCount += 200;
    render();
  };
  const selectAll = input('#contents-select-all');
  selectAll.onchange = () => {
    for (const entry of entries().filter((item) => item.kind !== 'directory')) {
      selectAll.checked ? selected.add(entry.id) : selected.delete(entry.id);
    }

    render();
  };
  button('#contents-zip').onclick = () => saveZip(false);
  button('#contents-zip-all').onclick = () => saveZip(true);
  document.addEventListener('romstudio-language', render);
  render();
}
