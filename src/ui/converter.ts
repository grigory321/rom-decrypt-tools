import type { UiServices, RomMetadata } from '../rpc-types.js';
import type { ProgressReporter } from '../contracts.js';
import { check } from '../binary.js';
import { element, input, select, button, progress } from './elements.js';
import { isAbortError } from '../errors.js';
import { prepareAndSaveOutput } from '../save-output.js';
import { t } from '../i18n.js';
import { icon } from './icons.js';
import { formatSize } from './formatters.js';
import { createProgressIndicator } from './progress-indicator.js';
import { openFilePicker } from './file-picker.js';

export function initConverter({ call, download, showError }: UiServices) {
  const indicator = createProgressIndicator('#conversion-progress');
  let roms: RomMetadata[] = [],
    current: string | null = null,
    adding = false,
    busy = false,
    queueGeneration = 0;
  let controller: AbortController | null = null;
  function clearStatus() {
    element('#conversion-progress').hidden = true;
    element('#conversion-status').textContent = '';
    progress('#conversion-bar').removeAttribute('value');
  }
  function render() {
    const list = element('#rom-list');
    list.replaceChildren();
    element('#rom-count').textContent = String(roms.length);
    element('#rom-empty').hidden = roms.length > 0;
    element('#converter-queue').hidden = !roms.length;
    element('#conversion-output').hidden = !roms.length;
    element('#convert-settings').hidden = !roms.length;
    button('#rom-clear').disabled = busy || !roms.length;
    button('#rom-drop').disabled = busy || adding;
    input('#rom-input').disabled = busy || adding;
    for (const rom of roms) {
      const row = document.createElement('div');
      row.className = 'rom-row' + (current === rom.id ? ' selected' : '');
      const choose = document.createElement('button');
      choose.className = 'rom-select';
      choose.disabled = busy || adding;
      choose.setAttribute('aria-pressed', String(current === rom.id));
      choose.innerHTML = `<span class="rom-file-icon">${rom.format === 'DSi' ? 'DSi' : rom.format === 'CIA' ? 'CIA' : '3DS'}</span><span class="rom-file-text"><strong></strong><small></small></span>`;
      const title = choose.querySelector('strong'),
        detail = choose.querySelector('small');
      check(
        title instanceof HTMLElement && detail instanceof HTMLElement,
        'UI_ELEMENT',
      );
      title.textContent = rom.name;
      detail.textContent =
        rom.titleId +
        ' · ' +
        formatSize(rom.size) +
        ' · ' +
        rom.count +
        ' ' +
        t('contents');
      choose.onclick = () => {
        if (busy || adding) {
          return;
        }
        current = rom.id;
        clearStatus();
        select('#rom-target').value = 'decrypt';
        render();
      };
      row.append(choose);
      const remove = document.createElement('button');
      remove.className = 'icon-button';
      remove.innerHTML = icon('x');
      remove.setAttribute('aria-label', t('remove') + ': ' + rom.name);
      remove.disabled = busy || adding;
      remove.onclick = async () => {
        await call(
          'removeRom',
          {
            rom: rom.id,
          },
          false,
        );
        roms = roms.filter((r) => r.id !== rom.id);
        if (current === rom.id) {
          current = roms[0]?.id || null;
          clearStatus();
        }
        render();
      };
      row.append(remove);
      list.append(row);
    }
    const rom = roms.find((r) => r.id === current);
    element('#conversion-filename').textContent = rom?.name || '';
    button('#convert-run').disabled = busy || adding || !rom;
    select('#rom-target').disabled = busy || adding;
    const options = select('#rom-target').options;
    if (rom?.format === 'DSi') select('#rom-target').value = 'decrypt';
    options[1].disabled = rom?.format === 'CIA' || rom?.format === 'DSi';
    options[2].disabled = rom?.format !== 'CIA';
  }
  async function add(files: File[]) {
    if (busy || adding) return;
    adding = true;
    render();
    const generation = queueGeneration;
    try {
      for (const file of files) {
        if (generation !== queueGeneration) {
          return;
        }
        try {
          const item = await call('inspect', {
            file,
          });
          if (generation !== queueGeneration) {
            try {
              await call(
                'removeRom',
                {
                  rom: item.id,
                },
                false,
              );
            } catch {}
            return;
          }
          roms.push(item);
          current = item.id;
          clearStatus();
          render();
        } catch (e) {
          if (generation !== queueGeneration) {
            return;
          }
          showError(e);
        }
      }
    } finally {
      adding = false;
      render();
    }
  }
  const romInput = input('#rom-input');
  select('#rom-target').onchange = clearStatus;
  romInput.onchange = () => {
    if (romInput.files) void add([...romInput.files]);
  };
  let depth = 0;
  const drop = element('#rom-drop');
  drop.addEventListener('click', () => openFilePicker(romInput));
  for (const event of ['dragenter', 'dragover', 'dragleave', 'drop']) {
    drop.addEventListener(event, (e) => {
      e.preventDefault();
      e.stopPropagation();
    });
  }
  drop.addEventListener('dragenter', () => {
    depth++;
    drop.classList.add('drag');
  });
  drop.addEventListener('dragleave', () => {
    if (!--depth) {
      drop.classList.remove('drag');
    }
  });
  drop.addEventListener('drop', (e) => {
    depth = 0;
    drop.classList.remove('drag');
    if (e.dataTransfer) void add([...e.dataTransfer.files]);
  });
  button('#rom-clear').onclick = async () => {
    queueGeneration++;
    const removed = roms;
    roms = [];
    current = null;
    clearStatus();
    render();
    for (const rom of removed) {
      try {
        await call(
          'removeRom',
          {
            rom: rom.id,
          },
          false,
        );
      } catch (e) {
        showError(e);
      }
    }
  };
  button('#convert-cancel').onclick = async () => {
    controller?.abort();
    await call('cancelConversion', {}, false).catch(showError);
  };
  function status(key: string, value?: number | null) {
    indicator.set(t(key), value);
  }
  button('#convert-run').onclick = async () => {
    const rom = roms.find((r) => r.id === current);
    if (!rom || busy || adding) {
      return;
    }
    const target = select('#rom-target').value;
    check(
      target === 'decrypt' || target === 'cia' || target === '3ds',
      'OUTPUT_FORMAT',
    );
    const extension =
      target === 'decrypt' ? rom.name.split('.').at(-1) || 'bin' : target;
    const pending = new AbortController();
    controller = pending;
    busy = true;
    button('#convert-cancel').hidden = false;
    element('#conversion-progress').hidden = false;
    status('converting');
    render();
    try {
      let warnings: string[] = [];
      const progress: ProgressReporter = (update) => {
        const writing = update.phase === 'writing';
        status(
          update.phase === 'destination'
            ? 'chooseSaveLocation'
            : writing
              ? 'writingRom'
              : update.phase === 'verify'
                ? 'verifying'
                : 'decrypting',
          writing ? update.value : null,
        );
      };
      await prepareAndSaveOutput(
        async () => {
          const result = await call(
            'convert',
            { rom: rom.id, target },
            false,
            progress,
          );
          warnings = result.warnings;
          return result;
        },
        {
          filename:
            rom.name.replace(/\.[^.]+$/, '') + '-decrypted.' + extension,
          maximumSize: rom.size * 2 + 16 * 1024 ** 2,
          signal: pending.signal,
          call,
          download,
          onProgress: progress,
        },
      );
      status('conversionDone', 1);
      if (warnings.includes('SKIPPED_UPDATES')) {
        element('#conversion-status').textContent +=
          ' · ' + t('skippedUpdates');
      }
    } catch (e) {
      const cancelled = pending.signal.aborted || isAbortError(e);
      indicator.stop(t(cancelled ? 'cancelled' : 'conversionFailed'));
      if (!cancelled) showError(e);
    } finally {
      if (controller === pending) controller = null;
      busy = false;
      button('#convert-cancel').hidden = true;
      render();
    }
  };
  document.addEventListener('romstudio-language', render);
  render();
}
