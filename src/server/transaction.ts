import type { Pool, PoolClient } from 'pg';

const committed = new WeakMap<object, Array<() => void>>();
const rolledBack = new WeakMap<object, Array<() => Promise<void>>>();

export function afterCommit(client: object, callback: () => void) {
  const callbacks = committed.get(client);
  if (callbacks) callbacks.push(callback);
  else callback();
}

export function afterRollback(client: object, callback: () => Promise<void>) {
  rolledBack.get(client)?.push(callback);
}

export async function transaction<T>(
  fn: (client: PoolClient) => Promise<T>,
  database: Pool,
): Promise<T> {
  const client = await database.connect();
  const callbacks: Array<() => void> = [];
  const rollbackCallbacks: Array<() => Promise<void>> = [];
  try {
    await client.query('BEGIN');
    committed.set(client, callbacks);
    rolledBack.set(client, rollbackCallbacks);
    const value = await fn(client);
    await client.query('COMMIT');
    committed.delete(client);
    for (const callback of callbacks) {
      try {
        callback();
      } catch {}
    }
    return value;
  } catch (error) {
    try {
      await client.query('ROLLBACK');
      for (const callback of rollbackCallbacks) {
        try {
          await callback();
        } catch {}
      }
    } catch {}
    throw error;
  } finally {
    committed.delete(client);
    rolledBack.delete(client);
    client.release();
  }
}
