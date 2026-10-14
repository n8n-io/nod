import type { Pool, PoolClient } from 'pg';

export async function transaction<T>(
  fn: (client: PoolClient) => Promise<T>,
  database: Pool,
): Promise<T> {
  const client = await database.connect();
  try {
    await client.query('BEGIN');
    const value = await fn(client);
    await client.query('COMMIT');
    return value;
  } catch (error) {
    await client.query('ROLLBACK').catch(() => {});
    throw error;
  } finally {
    client.release();
  }
}
