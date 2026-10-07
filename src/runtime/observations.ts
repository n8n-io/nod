import type { PromptSnapshot, RuntimeObservation } from '../ports/agent.ts';

export function createObservationQueue<T extends RuntimeObservation | PromptSnapshot>(options: {
  observe?: (event: T) => Promise<void>;
  signal: AbortSignal;
  timeoutMs?: number;
}) {
  let pending = Promise.resolve();
  let disabled = false;
  const timeoutMs = Math.min(1000, Math.max(1, options.timeoutMs || 1000));
  const invoke = (event: T) => Promise.resolve().then(() => options.observe?.(event));
  const bestEffort = (event: T) => {
    if (
      'type' in event &&
      (event.type === 'model_usage' || (event.type === 'tool_end' && event.status === 'cancelled'))
    )
      void invoke(event).catch(() => {});
  };
  const write = (event: T) =>
    new Promise<void>((resolve) => {
      if (disabled || !options.observe) return resolve();
      if (options.signal.aborted) {
        bestEffort(event);
        return resolve();
      }
      let settled = false;
      const finish = () => {
        if (settled) return;
        settled = true;
        clearTimeout(deadline);
        options.signal.removeEventListener('abort', finish);
        resolve();
      };
      const deadline = setTimeout(() => {
        disabled = true;
        finish();
      }, timeoutMs);
      options.signal.addEventListener('abort', finish, { once: true });
      if (options.signal.aborted) return finish();
      invoke(event).then(finish, finish);
    });
  return {
    record(event: T) {
      if (disabled || !options.observe) return Promise.resolve();
      if (options.signal.aborted) {
        bestEffort(event);
        return Promise.resolve();
      }
      pending = pending.then(() => write(event));
      return pending;
    },
    flush: () => pending,
  };
}
