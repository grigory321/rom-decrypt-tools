import { check } from '../binary.js';
import type { Progress, TrackMetadata } from '../contracts.js';
import type { AudioExportFormat, UiServices } from '../rpc-types.js';
import { progressLabel as phase } from '../rpc-client.js';
import { t } from '../i18n.js';
import { needsExportDuration } from '../audio-policy.js';
import { isAbortError } from '../errors.js';
import { audioOutputName } from '../output-names.js';
import { prepareAndSaveOutput, audioOutputBound } from '../save-output.js';
import {
  element,
  button as uiButton,
  dialog as uiDialog,
  form as uiForm,
  formInput,
  formSelect,
  radioValue,
} from './elements.js';
import { openDialog } from './dialogs.js';
import { createProgressIndicator } from './progress-indicator.js';

interface AudioExportOptions extends UiServices {
  onSaved: () => void;
}

export function initAudioExport({
  call,
  download,
  showError,
  onSaved,
}: AudioExportOptions) {
  let exportTrack: TrackMetadata | undefined;
  let exportController: AbortController | null = null;
  const indicator = createProgressIndicator('#audio-export-progress');
  function exportFormat(form: HTMLFormElement): AudioExportFormat {
    const value = radioValue(form, 'format');
    check(
      value === 'original' || value === 'wav' || value === 'mp3',
      'UI_FORMAT',
    );
    return value;
  }

  function open(track: TrackMetadata | undefined) {
    exportTrack = track;
    if (!exportTrack) {
      return;
    }
    element('#export-name').textContent = exportTrack.name;
    element('#export-meta').textContent =
      exportTrack.format + ' · ' + exportTrack.source;
    const form = uiForm('#export-form');
    for (const radio of form.querySelectorAll('input[name="format"]')) {
      check(radio instanceof HTMLInputElement, 'UI_ELEMENT', 'format');
      radio.disabled = !exportTrack.playable && radio.value !== 'original';
      radio.checked =
        radio.value === (exportTrack.playable ? 'mp3' : 'original');
    }
    formInput(form, 'fade').value = exportTrack.kind === 'sequence' ? '2' : '0';
    formInput(form, 'duration').value = '60';
    formInput(form, 'wholeSong').checked = [
      'GBA',
      'SEQ',
      'SEP',
      'CSEQ',
    ].includes(exportTrack.format);
    updateExportFields();
    openDialog('export-dialog');
  }

  function updateExportFields() {
    const form = uiForm('#export-form'),
      format = exportFormat(form),
      seq = !!exportTrack && needsExportDuration(exportTrack),
      original = format === 'original';
    const wholeSong =
      !!exportTrack &&
      ['GBA', 'SEQ', 'SEP', 'CSEQ'].includes(exportTrack.format);
    element('#whole-song-field').hidden = original || !wholeSong;
    formInput(form, 'wholeSong').disabled = original || !wholeSong;
    element('#bitrate-field').hidden = format !== 'mp3';
    element('#duration-field').hidden = original || !seq;
    formInput(form, 'duration').disabled =
      original || !seq || (wholeSong && formInput(form, 'wholeSong').checked);
    element('#fade-field').hidden = original;
    formInput(form, 'fade').disabled = original;
    element('#sequence-note').hidden = original || !seq;
    element('#dependencies-note').hidden = !exportTrack?.sourceArchive;
    element('#save-btn span').textContent = t(
      original ? 'saveOriginal' : 'save',
    );
  }

  uiForm('#export-form').onchange = updateExportFields;

  uiButton('#audio-export-cancel').onclick = () => {
    exportController?.abort();
    void call('cancelExport', {}, false).catch(showError);
  };

  uiDialog('#export-dialog').addEventListener('close', () => {
    if (exportController) uiButton('#audio-export-cancel').click();
  });

  uiForm('#export-form').onsubmit = async (event) => {
    event.preventDefault();
    if (!exportTrack || exportController) return;
    const form = uiForm('#export-form');
    const controller = new AbortController();
    exportController = controller;
    uiButton('#save-btn').disabled = true;
    element('#audio-export-progress').hidden = false;
    indicator.set(t('working'));
    const progress = (data: Progress) => {
      if (exportController !== controller) return;
      indicator.set(t(phase(data.phase)), data.value);
    };
    try {
      const track = exportTrack;
      const settings = {
        track: track.id,
        format: exportFormat(form),
        bitrate: Number(formSelect(form, 'bitrate').value),
        seconds: Number(formInput(form, 'duration').value),
        fade: Number(formInput(form, 'fade').value),
        wholeSong:
          !formInput(form, 'wholeSong').disabled &&
          formInput(form, 'wholeSong').checked,
      };
      await prepareAndSaveOutput(
        () => call('export', settings, false, progress),
        {
          filename: audioOutputName(track, settings.format),
          maximumSize: audioOutputBound(track, settings),
          call,
          download,
          onProgress: progress,
          signal: controller.signal,
        },
      );
      exportController = null;
      uiDialog('#export-dialog').close();
      onSaved();
    } catch (error) {
      if (!controller.signal.aborted && !isAbortError(error)) showError(error);
    } finally {
      if (exportController === controller) exportController = null;
      uiButton('#save-btn').disabled = false;
      element('#audio-export-progress').hidden = true;
    }
  };

  return { open, refresh: updateExportFields };
}
