import { check } from '../binary.js';
import { t } from '../i18n.js';
import { element } from './elements.js';

export function createProgressIndicator(selector: string) {
  const owner = element(selector);
  const label = owner.querySelector('[data-progress-label]');
  const value = owner.querySelector('[data-progress-value]');
  const meter = owner.querySelector('progress');
  check(label instanceof HTMLElement, 'UI_ELEMENT', selector);
  check(value instanceof HTMLElement, 'UI_ELEMENT', selector);
  check(meter instanceof HTMLProgressElement, 'UI_ELEMENT', selector);

  return {
    set(text: string, fraction?: number | null) {
      meter.hidden = false;
      label.textContent = text;
      meter.setAttribute('aria-label', text);
      const known = typeof fraction === 'number' && Number.isFinite(fraction);
      owner.dataset.progressState = known ? 'determinate' : 'indeterminate';
      if (known) {
        meter.value = Math.max(0, Math.min(1, fraction));
        value.textContent = Math.round(meter.value * 100) + '%';
        meter.setAttribute('aria-valuetext', value.textContent);
      } else {
        meter.removeAttribute('value');
        value.textContent = '…';
        meter.setAttribute('aria-valuetext', t('progressIndeterminate'));
      }
    },
    stop(text: string) {
      label.textContent = text;
      meter.hidden = true;
      value.textContent = '—';
      owner.dataset.progressState = 'stopped';
    },
  };
}
