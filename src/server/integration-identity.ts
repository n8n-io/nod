import type { Pool } from 'pg';
import type { IntegrationIdentityCheckpoint } from '../ports/integration-identity.ts';
import { lockSetup } from './locks.ts';
import { transaction } from './transaction.ts';

export function createIntegrationIdentityCheckpoint(
  pool: Pool,
  ownerId: string,
): IntegrationIdentityCheckpoint {
  let initialized: Promise<unknown> | undefined;
  async function ready() {
    initialized ??= transaction(async (client) => {
      await lockSetup(client, 'integration-identities');
      await client.query(
        'CREATE TABLE IF NOT EXISTS integration_identities (owner_id text PRIMARY KEY, public_key text NOT NULL)',
      );
    }, pool).catch((error: unknown) => {
      initialized = undefined;
      throw error;
    });
    await initialized;
  }
  return {
    async read() {
      await ready();
      const result = await pool.query<{ public_key: string }>(
        'SELECT public_key FROM integration_identities WHERE owner_id=$1',
        [ownerId],
      );
      return result.rows[0]?.public_key;
    },
    async commit(publicKey) {
      await ready();
      const result = await pool.query(
        `INSERT INTO integration_identities(owner_id,public_key) VALUES($1,$2)
         ON CONFLICT(owner_id) DO UPDATE SET public_key=excluded.public_key
         WHERE integration_identities.public_key=excluded.public_key RETURNING public_key`,
        [ownerId, publicKey],
      );
      if (result.rowCount !== 1)
        throw new Error('nod’s saved app identity changed. Restore its app data to reconnect.');
    },
  };
}
