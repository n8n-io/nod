import type { PoolClient } from 'pg';

type Query = Pick<PoolClient, 'query'>;

export const locksTable = 'CREATE TABLE IF NOT EXISTS otto_locks (key text PRIMARY KEY)';

export async function lockKey(client: Query, key: string) {
  while (!(await client.query('SELECT 1 FROM otto_locks WHERE key=$1 FOR UPDATE', [key])).rowCount)
    await client.query('INSERT INTO otto_locks(key) VALUES($1) ON CONFLICT DO NOTHING', [key]);
}

export async function lockSetup(client: Query, key: string) {
  await client.query('SAVEPOINT otto_locks');
  try {
    await client.query(locksTable);
    await client.query('RELEASE SAVEPOINT otto_locks');
  } catch (error) {
    if (!['23505', '42P07'].includes(String((error as { code?: unknown }).code))) throw error;
    await client.query('ROLLBACK TO SAVEPOINT otto_locks');
  }
  await lockKey(client, key);
}
