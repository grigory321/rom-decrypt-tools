import fs from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { build } from './build.mjs';

const root = fileURLToPath(new URL('../', import.meta.url));
const available = (await fs.readdir(new URL('../tests/', import.meta.url)))
  .filter((name) => name.endsWith('.test.js'))
  .sort();
const requested = process.argv
  .slice(2)
  .map((name) => name.replaceAll('\\', '/').replace(/^tests\//, ''));
for (const name of requested) {
  if (!available.includes(name)) throw new Error('Unknown test file: ' + name);
}
const files = (requested.length ? requested : available).map(
  (name) => 'tests/' + name,
);

await build();

const result = spawnSync(process.execPath, ['--test', ...files], {
  cwd: root,
  stdio: 'inherit',
});
if (result.error) process.stderr.write(result.error.message + '\n');
process.exitCode = result.status ?? 1;
