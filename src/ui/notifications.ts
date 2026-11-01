import { element, input as fileInput } from './elements.js';
import { icon } from './icons.js';
import { t, errorText, errorInfo } from '../i18n.js';
import { isFileReadError } from '../errors.js';
import { openFilePicker } from './file-picker.js';

interface ToastAction {
  label: string;
  run: () => void;
}

export function createNotifications(retry: (files: File[]) => void) {
  function toast(
    text: string,
    error = false,
    action: ToastAction | null = null,
    detail = '',
  ) {
    const el = document.createElement('div');
    el.className = 'toast' + (error ? ' error' : '');
    el.setAttribute('role', error ? 'alert' : 'status');
    const mark = document.createElement('span');
    mark.className = 'toast-mark';
    mark.innerHTML = icon(error ? 'info' : 'check');
    el.append(mark);
    const span = document.createElement('span');
    span.textContent = text;
    const content = document.createElement('div');
    content.className = 'toast-content';
    content.append(span);
    let disclosure: HTMLDetailsElement | undefined;
    if (detail) {
      disclosure = document.createElement('details');
      const summary = document.createElement('summary');
      summary.textContent = t('diagnosticDetails');
      const description = document.createElement('pre');
      description.textContent = detail.slice(0, 16384);
      disclosure.append(summary, description);
      content.append(disclosure);
    }
    el.append(content);
    if (action) {
      const b = document.createElement('button');
      b.className = 'text-button';
      b.textContent = action.label;
      b.onclick = () => {
        el.remove();
        action.run();
      };
      el.append(b);
    }
    const close = document.createElement('button');
    close.className = 'icon-button';
    close.innerHTML = icon('x');
    close.setAttribute('aria-label', t('close'));
    close.onclick = () => el.remove();
    el.append(close);
    element('#toast-stack').append(el);
    while (element('#toast-stack').childElementCount > 6) {
      element('#toast-stack').firstElementChild?.remove();
    }
    const expiration = setTimeout(() => el.remove(), error ? 2e4 : 4500);
    if (disclosure)
      disclosure.ontoggle = () => {
        if (disclosure?.open) clearTimeout(expiration);
      };
  }

  function showError(input: unknown, file?: File) {
    const error = errorInfo(input);
    if (error.code === 'CANCELLED') {
      return;
    }
    const detail = ['MISSING_KEY', 'WRONG_KEY', 'WRONG_SEED'].includes(
      error.code,
    )
      ? ''
      : error.detail;
    toast(
      (file ? file.name + ' · ' : '') +
        errorText(
          {
            ...error,
            detail,
          },
          false,
        ),
      true,
      file
        ? {
            label: t(isFileReadError(error) ? 'chooseAgain' : 'retry'),
            run: () => {
              if (isFileReadError(error))
                openFilePicker(fileInput('#file-input'));
              else retry([file]);
            },
          }
        : null,
      detail,
    );
  }

  return { toast, showError };
}
export type Notifications = ReturnType<typeof createNotifications>;
