import type { PoolClient } from 'pg';

type Query = Pick<PoolClient, 'query'>;

export const locksTable = 'CREATE TABLE IF NOT EXISTS nod_locks (key text PRIMARY KEY)';

export async function lockKey(client: Query, key: string) {
  while (!(await client.query('SELECT 1 FROM nod_locks WHERE key=$1 FOR UPDATE', [key])).rowCount)
    await client.query('INSERT INTO nod_locks(key) VALUES($1) ON CONFLICT DO NOTHING', [key]);
}

export async function lockSetup(client: Query, key: string) {
  await client.query('SAVEPOINT nod_locks');
  try {
    await client.query(locksTable);
    await client.query('RELEASE SAVEPOINT nod_locks');
  } catch (error) {
    if (!['23505', '42P07', '42710'].includes(String((error as { code?: unknown }).code)))
      throw error;
    await client.query('ROLLBACK TO SAVEPOINT nod_locks');
  }
  await lockKey(client, key);
}
