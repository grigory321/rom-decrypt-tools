import assert from 'node:assert/strict';
import test from 'node:test';
import { scanHeartbeatResources } from '../dist/ps-heartbeat.js';
import { heartbeatBankResource } from '../dist/ps-heartbeat-driver.js';

test('HeartBeat resource headers cross read boundaries and retain original bank references', async () => {
  const bytes = new Uint8Array(65792);
  const view = new DataView(bytes.buffer);
  const start = 65520;
  view.setUint32(start, 24, true);
  view.setUint16(start + 4, 19, true);
  bytes[start + 6] = 4;
  for (let bank = 0; bank < 4; bank++)
    view.setUint16(start + 20 + bank * 12, bank < 2 ? bank + 1 : 65535, true);
  bytes.set(new TextEncoder().encode('qQES'), start + 60);
  let maximum = 0;
  const source = {
    size: bytes.length,
    async read(offset, length) {
      maximum = Math.max(maximum, length);
      return bytes.slice(offset, offset + length);
    },
  };
  const found = await scanHeartbeatResources(source, 'nested/archive.dat');
  assert.equal(found.length, 1);
  assert.equal(found[0].offset, start);
  assert.equal(found[0].size, 84);
  assert.equal(found[0].id, 19);
  assert.deepEqual(
    found[0].banks.map((bank) => bank.id),
    [1, 2, 65535, 65535],
  );
  assert.deepEqual(
    await found[0].source.read(0, 84),
    bytes.slice(start, start + 84),
  );
  assert(maximum <= 65536);
});

test('an explicitly embedded bank takes precedence over an external bank with the same ID', () => {
  const required = { id: 2, waveSize: 16, attributeSize: 4, offset: 60 };
  const sequence = { banks: [required] };
  const external = { banks: [{ ...required, waveSize: 32 }] };
  assert.equal(
    heartbeatBankResource(sequence, required, [external, sequence]),
    sequence,
  );
  assert.equal(
    heartbeatBankResource(sequence, { ...required, waveSize: 0 }, [
      external,
      sequence,
    ]),
    external,
  );
});
