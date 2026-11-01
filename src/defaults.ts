import type { KeySet } from './contracts.js';

const unhex = (s: string) =>
  Uint8Array.from(s.match(/../g) || [], (v) => parseInt(v, 16));

const values = {
  common0normal: '64c5fd55dd3ad988325baaec5243db98',
  common1normal: '4aaa3d0e27d4d728d0b1b433f0f9cbc8',
  common2normal: 'fbb0ef8cdbb0d8e453cd99344371697f',
  common3normal: '25959b7ad0409f72684198ba2ecd7dc6',
  common4normal: '7ada22caffc476cc8297a0c7ceeeeebe',
  common5normal: 'a5051ca1b37dcf3afbcf8cc1edd9ce02',
  slot0x2ckeyx: 'b98e95ceca3e4d171f76a94de934c053',
  slot0x25keyx: 'cee7d8ab30c00dae850ef5e382ac5af3',
  slot0x18keyx: '82e9c9bebfb8bdb875ecc0a07d474374',
  slot0x1bkeyx: '45ad04953992c7c893724a9a7bce6182',
  fixedsystemkey: '527ce630a9ca305f3696f3cde954194b',
};

export const standardKeys = () =>
  Object.fromEntries(Object.entries(values).map(([n, v]) => [n, unhex(v)]));

let seeds: KeySet | undefined;

export async function automaticKeys() {
  if (!seeds) {
    const url = new URL('./data/seeddb.bin', import.meta.url);
    let bytes: Uint8Array;
    if (typeof process !== 'undefined' && process.versions?.node) {
      const fs = await import('node:fs/promises');
      bytes = new Uint8Array(await fs.readFile(url));
    } else {
      const r = await fetch(url);
      if (!r.ok) {
        throw new Error('SEED_DATA');
      }
      bytes = new Uint8Array(await r.arrayBuffer());
    }
    const { importKeyFile: importKeyFile } = await import('./crypto.js');
    seeds = await importKeyFile('seeddb.bin', bytes);
  }
  return {
    ...standardKeys(),
    ...seeds,
  };
}
