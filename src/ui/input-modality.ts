export function initInputModality(): void {
  document.addEventListener(
    'pointerdown',
    () => {
      document.documentElement.dataset.input = 'pointer';
    },
    { capture: true },
  );
  document.addEventListener(
    'keydown',
    (event) => {
      if (event.ctrlKey || event.metaKey || event.altKey) return;
      document.documentElement.dataset.input = 'keyboard';
    },
    { capture: true },
  );
}
