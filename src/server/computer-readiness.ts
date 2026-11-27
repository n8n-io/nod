type Waiter = { resolve(): void; reject(error: Error): void };

export type ComputerUpdate = { ready: true } | { error: { code?: string; message: string } };

export function createComputerReadiness() {
  let state: ComputerUpdate | undefined;
  const waiters = new Set<Waiter>();
  const failure = (error: { code?: string; message: string }) =>
    Object.assign(new Error(`Nod’s private computer is unavailable. ${error.message}`), {
      code: error.code,
    });
  return {
    available: () => Boolean(state && 'ready' in state),
    update(next: ComputerUpdate) {
      state = next;
      for (const waiter of [...waiters]) {
        waiters.delete(waiter);
        if ('error' in next) waiter.reject(failure(next.error));
        else waiter.resolve();
      }
    },
    ready(signal?: AbortSignal): Promise<void> {
      if (signal?.aborted) return Promise.reject(signal.reason);
      if (state && 'ready' in state) return Promise.resolve();
      if (state && 'error' in state) return Promise.reject(failure(state.error));
      return new Promise<void>((resolve, reject) => {
        const abort = () => {
          waiters.delete(waiter);
          reject(signal!.reason);
        };
        const waiter: Waiter = {
          resolve: () => {
            signal?.removeEventListener('abort', abort);
            resolve();
          },
          reject: (error) => {
            signal?.removeEventListener('abort', abort);
            reject(error);
          },
        };
        signal?.addEventListener('abort', abort, { once: true });
        waiters.add(waiter);
      });
    },
  };
}
