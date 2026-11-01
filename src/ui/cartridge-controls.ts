import { check } from '../binary.js';
import { element, elements } from './elements.js';

export function initCartridgeControls(
  press: (buttons: number) => Promise<void>,
  showError: (error: unknown) => void,
) {
  for (const control of elements('#cartridge-controls button')) {
    check(control instanceof HTMLButtonElement, 'UI_ELEMENT');
    const buttons = Number(control.dataset.cartridgeButton);
    check(
      Number.isInteger(buttons) && buttons > 0 && buttons <= 255,
      'UI_ELEMENT',
    );
    control.onclick = () => {
      void press(buttons).catch(showError);
    };
  }
}

export function updateCartridgeControls(
  format: string | undefined,
  enabled: boolean,
) {
  element('#cartridge-controls').hidden = format !== 'GB' && format !== 'GBC';
  for (const control of elements('#cartridge-controls button')) {
    check(control instanceof HTMLButtonElement, 'UI_ELEMENT');
    control.disabled = !enabled;
  }
}
