import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import * as prettier from 'prettier';
import { checkTypes } from './typecheck.mjs';

const root = fileURLToPath(new URL('../', import.meta.url));
const config = JSON.parse(
  await fs.readFile(path.join(root, '.prettierrc.json'), 'utf8'),
);
checkTypes();

async function inspect(directory) {
  for (const entry of await fs.readdir(path.join(root, directory), {
    withFileTypes: true,
  })) {
    const relative = path.join(directory, entry.name);
    if (relative.replaceAll('\\', '/').startsWith('public/vendor/')) continue;
    if (entry.isDirectory()) await inspect(relative);
    else if (/\.(?:ts|mts|js|mjs|css|html)$/.test(entry.name)) {
      if (directory.startsWith('public') && /\.[mc]?js$/.test(entry.name))
        throw new Error('Authored JavaScript must live in src/: ' + relative);
      const text = await fs.readFile(path.join(root, relative), 'utf8');
      if (!(await prettier.check(text, { ...config, filepath: relative })))
        throw new Error('Format source before building: ' + relative);
      if (
        (entry.name.endsWith('.html') && /<!--/.test(text)) ||
        (entry.name.endsWith('.css') && /\/\*/.test(text))
      )
        throw new Error('Source comment: ' + relative);
    }
  }
}
await inspect('src');
await inspect('public');
await inspect('scripts');
console.log('Source layout and formatting are consistent.');
