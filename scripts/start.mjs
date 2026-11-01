#!/usr/bin/env node
import fs from 'node:fs/promises';

const source = new URL('../src/', import.meta.url);
if (await fs.stat(source).catch(() => null)) {
  const compiler = new URL(
    '../node_modules/typescript/bin/tsc',
    import.meta.url,
  );
  if (!(await fs.stat(compiler).catch(() => null)))
    throw new Error(
      'Run npm ci before starting the TypeScript source edition.',
    );
  const { build } = await import('./build.mjs');
  await build();
}
await import('../serve.cjs');
