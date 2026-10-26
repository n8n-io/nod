import type { Pool, PoolClient } from 'pg';

const committed = new WeakMap<object, Array<() => void>>();
const reverted = new WeakMap<object, Array<() => void>>();

export function afterCommit(client: object, callback: () => void) {
  const callbacks = committed.get(client);
  if (callbacks) callbacks.push(callback);
  else callback();
}

export function afterRollback(client: object, callback: () => void) {
  reverted.get(client)?.push(callback);
}

export async function transaction<T>(
  fn: (client: PoolClient) => Promise<T>,
  database: Pool,
  signal?: AbortSignal,
): Promise<T> {
  signal?.throwIfAborted();
  let onAbort = () => {};
  const client = await Promise.race([
    new Promise<never>((_resolve, reject) => {
      onAbort = () => reject(signal?.reason);
      signal?.addEventListener('abort', onAbort, { once: true });
    }),
    database.connect().then((client) => {
      if (signal?.aborted) {
        client.release(true);
        signal.throwIfAborted();
      }
      return client;
    }),
  ]).finally(() => signal?.removeEventListener('abort', onAbort));
  let stopped = false;
  const stop = () => {
    stopped = true;
    client.release(true);
  };
  signal?.addEventListener('abort', stop, { once: true });
  if (signal?.aborted) stop();
  const callbacks: Array<() => void> = [];
  const rollbackCallbacks: Array<() => void> = [];
  try {
    signal?.throwIfAborted();
    await client.query(
      signal ? "BEGIN; SET LOCAL client_connection_check_interval='100ms'" : 'BEGIN',
    );
    committed.set(client, callbacks);
    reverted.set(client, rollbackCallbacks);
    const value = await fn(client);
    signal?.throwIfAborted();
    await client.query('COMMIT');
    committed.delete(client);
    for (const callback of callbacks) {
      try {
        callback();
      } catch {}
    }
    return value;
  } catch (error) {
    if (!stopped)
      await client.query('ROLLBACK').then(
        () => {
          for (const callback of rollbackCallbacks) {
            try {
              callback();
            } catch {}
          }
        },
        () => {},
      );
    throw error;
  } finally {
    committed.delete(client);
    reverted.delete(client);
    signal?.removeEventListener('abort', stop);
    if (!stopped) client.release();
  }
}
