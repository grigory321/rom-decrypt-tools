import { check } from '../binary.js';
import { elements, dialog as uiDialog } from './elements.js';

export function openDialog(id: string) {
  const dialog = uiDialog('#' + id);
  if (!dialog.open) {
    dialog.showModal();
  }
}

export function initDialogs() {
  elements('[data-open]').forEach(
    (b) => (b.onclick = () => openDialog(b.dataset.open ?? '')),
  );

  elements('[data-close]').forEach(
    (b) =>
      (b.onclick = () => {
        const owner = b.closest('dialog');
        check(owner, 'UI_ELEMENT', 'dialog');
        owner.close();
      }),
  );

  elements('dialog').forEach((d) => {
    check(d instanceof HTMLDialogElement, 'UI_ELEMENT', 'dialog');
    d.addEventListener('click', (e) => {
      if (e.target === d) {
        const r = d.getBoundingClientRect();
        if (
          e.clientX < r.left ||
          e.clientX > r.right ||
          e.clientY < r.top ||
          e.clientY > r.bottom
        ) {
          d.close();
        }
      }
    });
  });
}
