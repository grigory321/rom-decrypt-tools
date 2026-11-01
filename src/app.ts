import { createRpcClient, type RpcPending } from './rpc-client.js';
import type { RpcClient } from './rpc-types.js';
import type { Progress } from './contracts.js';
import { t } from './i18n.js';
import { element } from './ui/elements.js';
import { createProgressIndicator } from './ui/progress-indicator.js';
import { initAudioWorkspace } from './ui/audio-workspace.js';
import { initContents } from './ui/contents.js';
import { initConverter } from './ui/converter.js';
import { initDialogs } from './ui/dialogs.js';
import { download } from './ui/download.js';
import { initFormatGuides } from './ui/format-guide.js';
import { initInterfaceMotion } from './ui/motion.js';
import { initInputModality } from './ui/input-modality.js';
import { createNotifications } from './ui/notifications.js';
import { initialLanguage, initShell } from './ui/shell.js';

const worker = new Worker(new URL('./worker.js', import.meta.url), {
  type: 'module',
});
const notifications = createNotifications((files) => {
  void audio.loadFiles(files);
});
let pendingRequests: readonly RpcPending[] = [];
let inputProgress: Progress | null = null;
const progressIndicator = createProgressIndicator('#progress-banner');

function updateBusy(requests: readonly RpcPending[] = pendingRequests) {
  pendingRequests = requests;
  const pending = requests.filter((request) => request.busy);
  const request = pending.at(-1) ?? inputProgress;
  element('#progress-banner').hidden = !request;
  if (!request) return;
  const text = [t(request.phase || 'working'), request.detail]
    .filter(Boolean)
    .join(' · ');
  progressIndicator.set(text, request.value);
}

const call: RpcClient = createRpcClient(worker, {
  onBusyChange: updateBusy,
  onError: notifications.showError,
});
const services = { call, download, showError: notifications.showError };
const audio = initAudioWorkspace({
  ...services,
  toast: notifications.toast,
  onImportProgress: (progress) => {
    inputProgress = progress;
    updateBusy();
  },
});
const shell = initShell({
  onLanguageChange: () => {
    audio.translate();
    updateBusy();
  },
  onWorkspaceChange: (mode) => {
    if (mode !== 'audio') audio.pause();
  },
});

initDialogs();
initFormatGuides();
initInterfaceMotion();
initInputModality();
initContents({
  ...services,
  onAudio: (files) => {
    shell.setMode('audio');
    void audio.loadFiles(files);
  },
});
initConverter(services);
shell.translate(initialLanguage());
shell.setMode('convert');
