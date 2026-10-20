import type { Pool, PoolClient } from 'pg';

const committed = new WeakMap<object, Array<() => void>>();

export function afterCommit(client: object, callback: () => void) {
  const callbacks = committed.get(client);
  if (callbacks) callbacks.push(callback);
  else callback();
}

export async function transaction<T>(
  fn: (client: PoolClient) => Promise<T>,
  database: Pool,
): Promise<T> {
  const client = await database.connect();
  const callbacks: Array<() => void> = [];
  try {
    await client.query('BEGIN');
    committed.set(client, callbacks);
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
    await client.query('ROLLBACK').catch(() => {});
    throw error;
  } finally {
    committed.delete(client);
    client.release();
  }
}
