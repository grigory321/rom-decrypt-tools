import { check } from '../binary.js';

export function element(selector: string) {
  const node = document.querySelector(selector);
  check(node instanceof HTMLElement, 'UI_ELEMENT', selector);
  return node;
}

export function elements(selector: string) {
  const nodes: HTMLElement[] = [];
  for (const node of document.querySelectorAll(selector)) {
    check(node instanceof HTMLElement, 'UI_ELEMENT', selector);
    nodes.push(node);
  }
  return nodes;
}

export function button(selector: string) {
  const node = document.querySelector(selector);
  check(node instanceof HTMLButtonElement, 'UI_ELEMENT', selector);
  return node;
}

export function input(selector: string) {
  const node = document.querySelector(selector);
  check(node instanceof HTMLInputElement, 'UI_ELEMENT', selector);
  return node;
}

export function select(selector: string) {
  const node = document.querySelector(selector);
  check(node instanceof HTMLSelectElement, 'UI_ELEMENT', selector);
  return node;
}

export function canvas(selector: string) {
  const node = document.querySelector(selector);
  check(node instanceof HTMLCanvasElement, 'UI_ELEMENT', selector);
  return node;
}

export function dialog(selector: string) {
  const node = document.querySelector(selector);
  check(node instanceof HTMLDialogElement, 'UI_ELEMENT', selector);
  return node;
}

export function form(selector: string) {
  const node = document.querySelector(selector);
  check(node instanceof HTMLFormElement, 'UI_ELEMENT', selector);
  return node;
}

export function progress(selector: string) {
  const node = document.querySelector(selector);
  check(node instanceof HTMLProgressElement, 'UI_ELEMENT', selector);
  return node;
}

export function formInput(owner: HTMLFormElement, name: string) {
  const node = owner.elements.namedItem(name);
  check(node instanceof HTMLInputElement, 'UI_ELEMENT', name);
  return node;
}

export function formSelect(owner: HTMLFormElement, name: string) {
  const node = owner.elements.namedItem(name);
  check(node instanceof HTMLSelectElement, 'UI_ELEMENT', name);
  return node;
}

export function radioValue(owner: HTMLFormElement, name: string) {
  const node = owner.elements.namedItem(name);
  check(node instanceof RadioNodeList, 'UI_ELEMENT', name);
  return node.value;
}

export function childElement(
  owner: HTMLElement,
  selector: string,
): HTMLElement {
  const node = owner.querySelector(selector);
  check(node instanceof HTMLElement, 'UI_ELEMENT', selector);
  return node;
}
export function childButton(
  owner: HTMLElement,
  selector: string,
): HTMLButtonElement {
  const node = owner.querySelector(selector);
  check(node instanceof HTMLButtonElement, 'UI_ELEMENT', selector);
  return node;
}
export function childInput(
  owner: HTMLElement,
  selector: string,
): HTMLInputElement {
  const node = owner.querySelector(selector);
  check(node instanceof HTMLInputElement, 'UI_ELEMENT', selector);
  return node;
}
