import type { ProgressReporter } from './contracts.js';
import type {
  RpcArguments,
  RpcClient,
  RpcError,
  RpcMethod,
  RpcResults,
} from './rpc-types.js';
import { parseRpcEnvelope, parseRpcResult } from './rpc-codec.js';

export interface RpcPending {
  busy: boolean;
  phase: string;
  value?: number | null;
  detail?: string;
}

interface PendingRequest extends RpcPending {
  method: RpcMethod;
  complete(value: unknown): void;
  fail(error: RpcError): void;
  onProgress?: ProgressReporter;
}

export function progressLabel(phase: string): string {
  const labels: Record<string, string> = {
    destination: 'chooseSaveLocation',
    prepare: 'working',
    'audio-init': 'preparingAudio',
    'audio-prepare': 'preparingAudio',
    scan: 'loading',
    index: 'loading',
    inflate: 'unpacking',
    decrypt: 'decrypting',
    verify: 'verifying',
    render: 'rendering',
    encode: 'encoding',
    zip: 'zipping',
    writing: 'writingFile',
  };
  return labels[phase] || 'working';
}

export function createRpcClient(
  worker: Worker,
  {
    onBusyChange = () => {},
    onError = () => {},
  }: {
    onBusyChange?: (requests: readonly RpcPending[]) => void;
    onError?: (error: RpcError) => void;
  } = {},
): RpcClient {
  const requests = new Map<number, PendingRequest>();
  const cancelledLoads = new Set<number>();
  let serial = 0;
  let failure: RpcError | null = null;
  const changed = () => onBusyChange([...requests.values()]);
  const failed = (error: RpcError) => {
    if (failure) return;
    failure = error;
    for (const request of requests.values()) request.fail(error);
    requests.clear();
    cancelledLoads.clear();
    changed();
    onError(error);
  };
  worker.onmessage = (event: MessageEvent<unknown>) => {
    let message: ReturnType<typeof parseRpcEnvelope>;
    try {
      message = parseRpcEnvelope(event.data);
    } catch {
      failed({ code: 'WORKER_MESSAGE', detail: 'Invalid worker response' });
      return;
    }
    if ('fatal' in message) {
      failed(message.fatal);
      return;
    }
    const request = requests.get(message.id);
    if (!request) {
      if (cancelledLoads.has(message.id) && !('progress' in message)) {
        cancelledLoads.delete(message.id);
        if ('result' in message) {
          try {
            const loaded = parseRpcResult('load', message.result);
            worker.postMessage({
              id: ++serial,
              type: 'remove',
              group: loaded.group,
            });
          } catch {
            failed({
              code: 'WORKER_MESSAGE',
              detail: 'Unable to release a cancelled import',
            });
          }
        }
      }
      return;
    }
    if ('progress' in message) {
      request.phase = progressLabel(message.progress.phase);
      request.value = message.progress.value;
      request.detail = message.progress.detail;
      request.onProgress?.(message.progress);
      changed();
      return;
    }
    requests.delete(message.id);
    changed();
    if ('error' in message) request.fail(message.error);
    else request.complete(message.result);
  };
  worker.onerror = (event) =>
    failed({ code: 'WORKER_FAILED', detail: event.message });
  worker.onmessageerror = () => failed({ code: 'WORKER_MESSAGE' });
  return function call<K extends RpcMethod>(
    type: K,
    data: RpcArguments[K],
    busy = true,
    onProgress?: ProgressReporter,
  ): Promise<RpcResults[K]> {
    return new Promise<RpcResults[K]>(
      (resolve, reject: (reason: unknown) => void) => {
        if (failure) {
          reject(failure);
          return;
        }
        if (type === 'cancelLoad') {
          for (const [id, request] of requests) {
            if (request.method !== 'load') continue;
            requests.delete(id);
            cancelledLoads.add(id);
            request.fail({ code: 'CANCELLED' });
          }
        }
        const id = ++serial;
        const initial: Partial<Record<RpcMethod, string>> = {
          load: 'loading',
          render: 'rendering',
          export: 'preparingAudio',
          zip: 'zipping',
        };
        requests.set(id, {
          method: type,
          busy,
          phase: initial[type] || 'working',
          onProgress,
          complete(value) {
            try {
              resolve(parseRpcResult(type, value));
            } catch (error) {
              reject(error);
            }
          },
          fail: reject,
        });
        changed();
        try {
          worker.postMessage({ id, type, ...data });
        } catch (error) {
          requests.delete(id);
          changed();
          const detail = error instanceof Error ? error.message : '';
          if (error instanceof Error && error.name === 'DataCloneError')
            reject({ code: 'FILE_TRANSFER', detail });
          else {
            const failure = { code: 'WORKER_FAILED', detail };
            failed(failure);
            reject(failure);
          }
        }
      },
    );
  };
}
