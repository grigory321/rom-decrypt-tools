export function cooperativeYield(checkCurrent: () => void = () => {}) {
  let started = performance.now();
  let operations = 0;
  return async () => {
    checkCurrent();
    if (++operations < 16 && performance.now() - started < 12) return;
    operations = 0;
    await new Promise<void>((resolve) => {
      if (typeof MessageChannel !== 'function') {
        setTimeout(resolve, 0);
        return;
      }
      const channel = new MessageChannel();
      channel.port1.onmessage = () => {
        channel.port1.close();
        channel.port2.close();
        resolve();
      };
      channel.port2.postMessage(null);
    });
    started = performance.now();
    checkCurrent();
  };
}
