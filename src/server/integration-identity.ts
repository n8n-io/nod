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
      if (result.rows[0]) return result.rows[0].public_key;
      const table = await pool.query<{ present: boolean }>(
        "SELECT to_regclass('app_connections') IS NOT NULL AS present",
      );
      if (
        table.rows[0]?.present &&
        (
          await pool.query(
            "SELECT 1 FROM app_connections WHERE owner_id=$1 AND provider_id='composio' AND (account_id IS NOT NULL OR pending_account_id IS NOT NULL) LIMIT 1",
            [ownerId],
          )
        ).rowCount
      )
        throw new Error('nod’s saved app identity is missing. Restore its app data to reconnect.');
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
