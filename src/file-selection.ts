import type { SelectedFile } from './contracts.js';
import { blobSource } from './binary.js';

const keyExtensions =
  /\.(key|tik|h3|cert|wbf\d+|psflib|psf2lib|adxkey|hcakey|vb|xwb|bcbnk|cbnk)$/i;
const packageExtensions = /\.(app|tmd|tik|h3)$/i;

function cuePath(value: string) {
  const path = value.replace(/\\/g, '/').replace(/^(\.\/)+/, '');
  return path.length > 0 &&
    path.length <= 4096 &&
    !path.startsWith('/') &&
    !/[\x00-\x1f:]/.test(path) &&
    path.split('/').every((part) => part && part !== '.' && part !== '..')
    ? path.toLowerCase()
    : null;
}

function companionIndex(files: File[]) {
  const paths = new Map<string, File | null>();
  const names = new Map<string, File | null>();
  for (const file of files) {
    const path = cuePath(file.webkitRelativePath || file.name);
    if (!path) continue;
    const name = path.split('/').at(-1) || '';
    paths.set(path, paths.has(path) ? null : file);
    names.set(name, names.has(name) ? null : file);
  }
  return { paths, names };
}

function cueCompanion(
  reference: string,
  cue: File,
  index: ReturnType<typeof companionIndex>,
) {
  const requested = cuePath(reference);
  const name = cue.webkitRelativePath || cue.name;
  const parent = name.replace(/\\/g, '/').split('/').slice(0, -1).join('/');
  const relative = parent ? cuePath(parent + '/' + reference) : requested;
  if (!requested || !relative) return null;
  if (index.paths.has(relative)) return index.paths.get(relative);
  if (index.paths.has(requested)) return index.paths.get(requested);
  return index.names.get(requested.split('/').at(-1) || '') || null;
}

export function chooseMainFile(files: File[]) {
  for (const pattern of [
    /\.cue$/i,
    /\.tmd$/i,
    /\.(wud|wux|wbfs|wad)$/i,
    /\.(vab|vh)$/i,
    /\.(nds|srl|cia|3ds|cci|cxi|cfa|ncch|iso|gb|gbc|gbs|psf|psf2|minipsf|minipsf2|sfc|smc|spc|rpx|rpl)$/i,
  ]) {
    const file = files.find((item) => pattern.test(item.name));
    if (file) return file;
  }
  return files.find((file) => !keyExtensions.test(file.name)) || files[0];
}

export async function chooseAudioInputs(files: File[], signal?: AbortSignal) {
  const cueFiles = files.filter((file) => /\.cue$/i.test(file.name));
  const index = cueFiles.length ? companionIndex(files) : null;
  const referenced = new Set<File>();
  for (const cue of cueFiles) {
    if (cue.size > 1024 ** 2) continue;
    const text = new TextDecoder().decode(
      await blobSource(cue, signal).read(0, cue.size),
    );
    for (const match of text.matchAll(
      /^\s*FILE\s+(?:"([^"]+)"|(\S+))\s+(?:BINARY|MOTOROLA)\s*$/gim,
    )) {
      if (!index) continue;
      const companion = cueCompanion(match[1] || match[2], cue, index);
      if (companion && companion !== cue) referenced.add(companion);
    }
  }
  const hasPackage = files.some((file) => /\.tmd$/i.test(file.name));
  const selected: File[] = [];
  for (const file of files) {
    if (
      keyExtensions.test(file.name) ||
      referenced.has(file) ||
      (hasPackage &&
        packageExtensions.test(file.name) &&
        !/\.tmd$/i.test(file.name))
    )
      continue;
    selected.push(file);
  }
  return selected;
}

export const companionFiles = (files: File[]): SelectedFile[] =>
  files.map((file) => ({
    file,
    name: file.name,
    path: file.webkitRelativePath || file.name,
    webkitRelativePath: file.webkitRelativePath || '',
  }));
