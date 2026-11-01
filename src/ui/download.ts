import type { DownloadedFile } from '../rpc-types.js';

export function download(result: DownloadedFile) {
  const url = URL.createObjectURL(result.blob),
    link = document.createElement('a');
  link.href = url;
  link.download = result.filename;
  document.body.append(link);
  link.click();
  link.remove();
  setTimeout(() => URL.revokeObjectURL(url), 6e4);
}
