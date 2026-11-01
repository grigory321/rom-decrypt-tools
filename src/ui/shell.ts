import { check } from '../binary.js';
import { t, setLanguage } from '../i18n.js';
import { element, elements, select as uiSelect } from './elements.js';

type WorkspaceMode = 'convert' | 'contents' | 'audio';

interface ShellOptions {
  onLanguageChange: () => void;
  onWorkspaceChange: (mode: WorkspaceMode) => void;
}

export function initialLanguage() {
  let initial = 'ja';

  try {
    initial =
      localStorage.getItem('romstudio-language') ||
      (['ja', 'ru', 'en'].includes(navigator.language.slice(0, 2))
        ? navigator.language.slice(0, 2)
        : 'ja');
  } catch {}

  return initial;
}

export function initShell({
  onLanguageChange,
  onWorkspaceChange,
}: ShellOptions) {
  function translate(lang: string) {
    setLanguage(lang);
    document.title = t('pageTitle');
    uiSelect('#language').value = lang;
    elements('[data-i18n]').forEach(
      (el) => (el.textContent = t(el.dataset.i18n)),
    );
    elements('[data-title]').forEach((el) => {
      el.title = t(el.dataset.title);
      el.setAttribute('aria-label', t(el.dataset.title));
    });
    elements('[data-placeholder]').forEach((el) => {
      check(
        el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement,
        'UI_ELEMENT',
        '[data-placeholder]',
      );
      el.placeholder = t(el.dataset.placeholder);
    });
    elements('[data-aria]').forEach((el) =>
      el.setAttribute('aria-label', t(el.dataset.aria)),
    );
    try {
      localStorage.setItem('romstudio-language', lang);
    } catch {}
    onLanguageChange();
    document.dispatchEvent(new Event('romstudio-language'));
  }

  uiSelect('#language').onchange = () => translate(uiSelect('#language').value);

  function setMode(mode: string | undefined) {
    check(
      mode === 'convert' || mode === 'contents' || mode === 'audio',
      'UI_MODE',
    );
    const audioMode = mode === 'audio';
    for (const name of ['convert', 'contents', 'audio']) {
      const workspace = name === 'convert' ? 'converter' : name;
      element('#' + workspace + '-workspace').hidden = name !== mode;
    }
    document.body.classList.toggle('mode-converter', !audioMode);
    document.body.dataset.workspace = mode;
    elements('[data-mode]').forEach((button) => {
      button.classList.toggle('active', button.dataset.mode === mode);
      button.setAttribute('aria-pressed', String(button.dataset.mode === mode));
    });
    onWorkspaceChange(mode);
    window.scrollTo({
      top: 0,
      behavior: matchMedia('(prefers-reduced-motion: reduce)').matches
        ? 'auto'
        : 'smooth',
    });
  }

  element('.brand').addEventListener('click', (event) => {
    event.preventDefault();
    setMode('convert');
  });

  elements('[data-mode]').forEach(
    (b) => (b.onclick = () => setMode(b.dataset.mode)),
  );

  return { translate, setMode };
}
