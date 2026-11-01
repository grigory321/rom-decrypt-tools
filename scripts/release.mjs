import './check.mjs';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { build } from './build.mjs';
import { zipSync, unzipSync } from '../public/vendor/fflate.mjs';

const root = await fs.realpath(fileURLToPath(new URL('../', import.meta.url)));
const args = process.argv.slice(2);
if (args.length && (args.length !== 2 || args[0] !== '--output'))
  throw new Error('Usage: npm run release -- [--output DIRECTORY]');

const output = path.resolve(root, args[1] || 'releases');
const relativeOutput = path.relative(root, output);
if (
  !relativeOutput ||
  (!relativeOutput.startsWith('..' + path.sep) &&
    !path.isAbsolute(relativeOutput) &&
    relativeOutput !== 'releases' &&
    !relativeOutput.startsWith('releases' + path.sep))
)
  throw new Error('Use releases/ or a directory outside the source checkout.');

await fs.mkdir(output, { recursive: true });
if ((await fs.realpath(output)).toLowerCase() !== output.toLowerCase())
  throw new Error('The output directory must not resolve through a symlink.');

await build();
const encoder = new TextEncoder();
const decoder = new TextDecoder();
const sourceFiles = {};
const builtFiles = {};
const rootFiles = [
  'README.md',
  'LICENSE.txt',
  'package.json',
  'package-lock.json',
  'serve.cjs',
  'Start-ROM-Studio.cmd',
  '.gitignore',
  '.gitattributes',
  '.editorconfig',
  '.prettierrc.json',
  'tsconfig.json',
  'tsconfig.worker.json',
];

async function include(files, relative) {
  const filename = path.join(root, relative);
  const stat = await fs.lstat(filename);
  if (stat.isSymbolicLink()) throw new Error('Release symlink: ' + relative);
  if (stat.isDirectory()) {
    for (const name of (await fs.readdir(filename)).sort())
      await include(files, path.join(relative, name));
    return;
  }
  const name = relative.split(path.sep).join('/');
  if (
    name.split('/').some((part) => part.startsWith('.')) &&
    !rootFiles.includes(name) &&
    !name.startsWith('.github/') &&
    name !== 'public/.nojekyll' &&
    name !== 'dist/.nojekyll'
  )
    throw new Error('Private release path: ' + name);
  if (name.endsWith('.md') && name !== 'README.md')
    throw new Error('Unexpected documentation: ' + name);
  if (/\.(?:wasm|asm\.js)$|favicon/i.test(name))
    throw new Error('Unexpected runtime asset: ' + name);
  const bytes = new Uint8Array(await fs.readFile(filename));
  if (/\.(?:[cm]?[jt]s|json|md|txt|py|css|html|yml|cjs)$/i.test(name)) {
    const text = decoder.decode(bytes);
    if (
      /[A-Z]:[\\/]Users[\\/]|BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY/.test(text)
    )
      throw new Error('Private workspace content: ' + name);
  }
  files[name] = bytes;
}

for (const directory of [
  'src',
  'public',
  'tests',
  'vendor',
  'scripts',
  '.github',
])
  await include(sourceFiles, directory);
for (const name of rootFiles) await include(sourceFiles, name);
for (const directory of ['dist', 'vendor'])
  await include(builtFiles, directory);
for (const name of [
  'README.md',
  'LICENSE.txt',
  'serve.cjs',
  'Start-ROM-Studio.cmd',
  'scripts/start.mjs',
])
  await include(builtFiles, name);

const manifest = JSON.parse(decoder.decode(sourceFiles['package.json']));
const builtManifest = {
  ...manifest,
  scripts: { start: 'node scripts/start.mjs' },
};
delete builtManifest.devDependencies;
builtFiles['package.json'] = encoder.encode(
  JSON.stringify(builtManifest, null, 2) + '\n',
);

const editions = [
  {
    name: 'ROM-Studio-Source.zip',
    files: sourceFiles,
    required: [
      'src/app.ts',
      'src/ui/audio-workspace.ts',
      'src/worker/playback.ts',
      'public/index.html',
      'scripts/release.mjs',
      'README.md',
      'LICENSE.txt',
      'public/vendor/spc700-js/LICENSE.txt',
      'vendor/spc700-js/LICENSE.txt',
    ],
    forbidden: /^(?:dist|docs|releases)\//,
  },
  {
    name: 'ROM-Studio-JS.zip',
    files: builtFiles,
    required: [
      'dist/app.js',
      'dist/worker.js',
      'dist/ui/audio-workspace.js',
      'dist/worker/playback.js',
      'dist/.nojekyll',
      'dist/vendor/NOTICES.txt',
      'scripts/start.mjs',
      'README.md',
      'LICENSE.txt',
      'dist/vendor/spc700-js/LICENSE.txt',
      'vendor/spc700-js/LICENSE.txt',
    ],
    forbidden: /^(?:src|public|tests|docs|node_modules)\//,
  },
];
const releases = [];
for (const edition of editions) {
  const bytes = zipSync(edition.files, {
    level: 6,
    mtime: new Date(2000, 0, 1),
  });
  const verified = unzipSync(bytes);
  for (const name of edition.required)
    if (!verified[name]) throw new Error('Missing release file: ' + name);
  for (const [name, data] of Object.entries(verified)) {
    if (edition.forbidden.test(name))
      throw new Error('Unexpected release file: ' + name);
    if (!Buffer.from(data).equals(edition.files[name]))
      throw new Error('Release verification failed: ' + name);
  }
  await fs.writeFile(path.join(output, edition.name), bytes);
  releases.push({
    name: edition.name,
    files: Object.keys(verified).length,
    bytes: bytes.length,
    sha256: createHash('sha256').update(bytes).digest('hex'),
  });
}

await fs.writeFile(
  path.join(output, 'ROM-Studio-SHA256.txt'),
  releases.map((release) => release.sha256 + '  ' + release.name).join('\n') +
    '\n',
);
await fs.writeFile(
  path.join(output, 'release.json'),
  JSON.stringify({ version: manifest.version, releases }, null, 2) + '\n',
);
console.log(
  JSON.stringify({ version: manifest.version, output, releases }, null, 2),
);
