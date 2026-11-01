import { check } from '../binary.js';
import { elements } from './elements.js';
import { t } from '../i18n.js';

interface SystemGuide {
  id: string;
  name?: string;
  label?: string;
  rom: string[];
  audio: string[];
  snapshots?: string[];
  libraries?: string[];
  companions?: string[];
}

const systems: SystemGuide[] = [
  {
    id: 'gb',
    name: 'Game Boy / Color',
    rom: ['gb', 'gbc'],
    audio: ['gbs'],
    snapshots: ['gbs'],
  },
  {
    id: 'gba',
    name: 'Game Boy Advance',
    rom: ['gba'],
    audio: [],
  },
  {
    id: 'nds',
    name: 'Nintendo DS',
    rom: ['nds', 'srl'],
    audio: ['sdat', 'sseq', 'swav', 'strm'],
  },
  {
    id: 'ctr',
    name: 'Nintendo 3DS',
    rom: ['3ds', 'cia', 'cci', 'cxi', 'cfa', 'ncch'],
    audio: ['bcwav', 'bcstm', 'bcsar', 'bcwar', 'bcgrp'],
  },
  {
    id: 'dsi',
    name: 'Nintendo DSi',
    rom: ['nds', 'srl'],
    audio: ['sdat', 'sseq', 'swav', 'strm'],
  },
  {
    id: 'wii',
    name: 'Wii',
    rom: ['iso', 'wbfs', 'wad', 'arc', 'u8'],
    audio: ['brstm', 'rwav', 'dsp', 'brsar', 'brwar'],
  },
  {
    id: 'cafe',
    name: 'Wii U',
    rom: ['wud', 'wux', 'app', 'tmd', 'rpx', 'rpl'],
    audio: ['bfwav', 'bfstm', 'bfsar', 'bfwar', 'bfgrp', 'idsp'],
  },
  {
    id: 'switch',
    name: 'Nintendo Switch',
    rom: [],
    audio: ['bwav', 'idsp'],
    snapshots: ['bwav', 'idsp'],
  },
  {
    id: 'snes',
    label: 'systemSnes',
    rom: ['sfc', 'smc', 'swc', 'fig'],
    audio: ['spc'],
    snapshots: ['spc'],
  },
  {
    id: 'ps1',
    name: 'PlayStation',
    rom: ['iso', 'bin', 'cue', 'vab', 'vh'],
    audio: ['psf', 'minipsf', 'vag', 'wav', 'xa', 'str'],
    snapshots: ['psf', 'minipsf'],
    libraries: ['psflib'],
    companions: ['vb'],
  },
  {
    id: 'ps2',
    name: 'PlayStation 2',
    rom: ['iso', 'bin', 'cue'],
    audio: [
      'psf2',
      'minipsf2',
      'vag',
      'ss2',
      'ads',
      'wav',
      'adx',
      'pss',
      'xws',
      'xwh',
    ],
    snapshots: ['psf2', 'minipsf2'],
    libraries: ['psf2lib'],
    companions: ['xwb'],
  },
  {
    id: 'shared',
    label: 'systemShared',
    rom: ['zip', 'awb', 'afs2', 'awx'],
    audio: ['adx', 'hca', 'aif', 'aiff', 'aifc', 'au', 'snd'],
    snapshots: ['adx', 'hca', 'aif', 'aiff', 'aifc', 'au', 'snd'],
    companions: ['adxkey', 'hcakey'],
  },
];

function extensionGroups(system: SystemGuide, mode: string | undefined) {
  const groups = [{ label: t('romFormats'), extensions: system.rom }];
  if (mode === 'audio') {
    groups.push({ label: t('audioFormats'), extensions: system.audio });
  }
  if (mode === 'contents' && system.snapshots) {
    groups.push({ label: t('snapshotFormats'), extensions: system.snapshots });
  }
  if (system.libraries)
    groups.push({ label: t('companionFormats'), extensions: system.libraries });
  if (system.companions)
    groups.push({
      label: t('companionFilesLabel'),
      extensions: system.companions,
    });
  return groups;
}

export function initFormatGuides() {
  for (const guide of elements('[data-format-guide]')) {
    const scope = guide.dataset.formatGuide;
    const available =
      scope === 'convert'
        ? systems.filter((system) => system.id === 'ctr' || system.id === 'dsi')
        : systems;
    const options = guideElement(guide, '.hardware-options');
    const panel = guideElement(guide, '.extension-column');
    const groups = guideElement(guide, '.extension-groups');
    let selected = available[0];

    function renderExtensions() {
      groups.replaceChildren();
      for (const { label, extensions } of extensionGroups(selected, scope)) {
        if (!extensions.length) continue;
        const group = document.createElement('div');
        group.className = 'extension-group';
        const heading = document.createElement('span');
        heading.className = 'extension-label';
        heading.textContent = label;
        const list = document.createElement('div');
        list.className = 'extension-tags';
        for (const extension of extensions) {
          const item = document.createElement('code');
          item.textContent = '.' + extension;
          list.append(item);
        }
        group.append(heading, list);
        groups.append(group);
      }
      panel.setAttribute('aria-labelledby', `hardware-${scope}-${selected.id}`);
    }

    function choose(system: SystemGuide, focus = false) {
      selected = system;
      for (const button of options.children) {
        check(button instanceof HTMLButtonElement, 'UI_ELEMENT');
        const active = button.dataset.system === system.id;
        button.setAttribute('aria-selected', String(active));
        button.tabIndex = active ? 0 : -1;
        if (active && focus) button.focus();
      }
      renderExtensions();
    }

    for (const system of available) {
      const button = document.createElement('button');
      button.type = 'button';
      button.className = 'hardware-option';
      button.id = `hardware-${scope}-${system.id}`;
      button.dataset.system = system.id;
      button.setAttribute('role', 'tab');
      button.setAttribute('aria-controls', panel.id);
      button.textContent = system.name || t(system.label || system.id);
      button.addEventListener('click', () => choose(system));
      button.addEventListener('keydown', (event) => {
        const offset = ['ArrowRight', 'ArrowDown'].includes(event.key)
          ? 1
          : ['ArrowLeft', 'ArrowUp'].includes(event.key)
            ? -1
            : 0;
        if (!offset && !['Home', 'End'].includes(event.key)) return;
        event.preventDefault();
        const index =
          event.key === 'Home'
            ? 0
            : event.key === 'End'
              ? available.length - 1
              : (available.indexOf(selected) + offset + available.length) %
                available.length;
        choose(available[index], true);
      });
      options.append(button);
    }

    document.addEventListener('romstudio-language', () => {
      for (const system of available) {
        const button = options.querySelector(`[data-system="${system.id}"]`);
        check(button instanceof HTMLButtonElement, 'UI_ELEMENT');
        button.textContent = system.name || t(system.label || system.id);
      }
      renderExtensions();
    });
    choose(selected);
  }
}

function guideElement(guide: HTMLElement, selector: string): HTMLElement {
  const child = guide.querySelector(selector);
  check(child instanceof HTMLElement, 'UI_ELEMENT', selector);
  return child;
}
