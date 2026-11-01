import { check } from '../binary.js';
import { element } from './elements.js';

export function initInterfaceMotion() {
  const updateVisibility = () =>
    document.body.classList.toggle('page-hidden', document.hidden);
  document.addEventListener('visibilitychange', updateVisibility);
  updateVisibility();

  for (const [workspaceId, countId] of [
    ['converter-workspace', 'rom-count'],
    ['contents-workspace', 'contents-total'],
    ['audio-workspace', 'library-total'],
  ]) {
    const workspace = element('#' + workspaceId);
    const count = element('#' + countId);
    let populated = false;
    function update() {
      const hasData = Number(count.textContent) > 0;
      workspace.classList.toggle('has-data', hasData);
      if (hasData && !populated) {
        const compatibility = workspace.querySelector('[data-compatibility]');
        check(compatibility instanceof HTMLDetailsElement, 'UI_ELEMENT');
        compatibility.open = false;
      }
      populated = hasData;
    }
    new MutationObserver(update).observe(count, {
      childList: true,
      characterData: true,
      subtree: true,
    });
    update();
  }
}
