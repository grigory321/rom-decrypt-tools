import fs from 'node:fs/promises';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import * as prettier from 'prettier';

const root = await fs.realpath(fileURLToPath(new URL('../', import.meta.url)));
const config = JSON.parse(
  await fs.readFile(path.join(root, '.prettierrc.json'), 'utf8'),
);

async function outputDirectory(name) {
  if (!['.build', 'dist', '.dist-previous'].includes(name))
    throw new Error('Invalid output directory');
  const target = path.resolve(root, name);
  const actual = await fs.realpath(target).catch((error) => {
    if (error.code !== 'ENOENT') throw error;
    return target;
  });
  if (
    path.dirname(target) !== root ||
    actual.toLowerCase() !== target.toLowerCase()
  )
    throw new Error('Output directory is outside this project');
  return target;
}

export function compile(project, emit = true) {
  const args = [
    path.join(root, 'node_modules/typescript/bin/tsc'),
    '-p',
    project,
    '--pretty',
    'false',
  ];
  if (!emit) args.push('--noEmit');
  const result = spawnSync(process.execPath, args, {
    cwd: root,
    stdio: 'inherit',
    windowsHide: true,
  });
  if (result.error) throw result.error;
  if (result.status !== 0)
    throw new Error('TypeScript check failed: ' + project);
}

async function formatOutput(directory) {
  for (const entry of await fs.readdir(directory, { withFileTypes: true })) {
    const filename = path.join(directory, entry.name);
    if (entry.isDirectory()) await formatOutput(filename);
    else if (entry.name.endsWith('.js')) {
      const source = await fs.readFile(filename, 'utf8');
      await fs.writeFile(
        filename,
        await prettier.format(source, { ...config, filepath: filename }),
      );
    }
  }
}

export async function build() {
  const staging = await outputDirectory('.build');
  const output = await outputDirectory('dist');
  const previous = await outputDirectory('.dist-previous');
  if (
    !(await fs.stat(output).catch(() => null)) &&
    (await fs.stat(previous).catch(() => null))
  )
    await fs.rename(previous, output);
  await fs.rm(staging, { recursive: true, force: true });
  await fs.mkdir(staging);
  compile('tsconfig.json');
  compile('tsconfig.worker.json');
  await formatOutput(staging);
  await fs.cp(path.join(root, 'public'), staging, { recursive: true });
  await fs.access(path.join(staging, 'index.html'));
  await fs.access(path.join(staging, 'app.js'));
  await fs.access(path.join(staging, 'worker.js'));
  await fs.rm(previous, { recursive: true, force: true });
  const exists = await fs.stat(output).catch(() => null);
  if (exists) await fs.rename(output, previous);
  try {
    await fs.rename(staging, output);
  } catch (error) {
    if (exists) await fs.rename(previous, output);
    throw error;
  }
  await fs.rm(previous, { recursive: true, force: true });
  console.log('Built dist/ from src/ and public/.');
}

if (
  process.argv[1] &&
  path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)
)
  await build();
