import { openVaultValue, sealVaultValue } from './vault-crypto.ts';
import type { Pool, PoolClient } from 'pg';
import { z } from 'zod';
import type { CredentialKeyStore } from '../ports/key-store.ts';

const seal = (key: Buffer, owner: string, id: string, value: string) =>
  sealVaultValue(key, ['nod-app-grant-v1', owner, id], value);
const open = (key: Buffer, owner: string, id: string, value: string) =>
  openVaultValue(key, ['nod-app-grant-v1', owner, id], value);

export async function createAppGrantVault(
  pool: Pool,
  options: { ownerId: string; keyStore: CredentialKeyStore },
) {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS vault_app_grants (
      id uuid PRIMARY KEY, owner_id text NOT NULL, ciphertext text NOT NULL,
      version integer NOT NULL DEFAULT 0, updated_at timestamptz NOT NULL DEFAULT now(),
      expires_at timestamptz
    );
    CREATE INDEX IF NOT EXISTS vault_app_grants_owner ON vault_app_grants(owner_id);
  `);
  await pool.query('DELETE FROM vault_app_grants WHERE expires_at<=now()');
  const owner = options.ownerId;
  const key = () => options.keyStore.getKey();
  async function put(
    id: string,
    value: string,
    client: Pool | PoolClient = pool,
    expiresAt: Date | null = null,
  ) {
    const validId = z.uuid().parse(id);
    const result = await client.query(
      `INSERT INTO vault_app_grants(id,owner_id,ciphertext,expires_at) VALUES($1,$2,$3,$4)
       ON CONFLICT(id) DO UPDATE SET ciphertext=excluded.ciphertext,
       version=vault_app_grants.version+1,updated_at=now(),expires_at=excluded.expires_at
       WHERE vault_app_grants.owner_id=excluded.owner_id RETURNING id`,
      [validId, owner, seal(await key(), owner, validId, value), expiresAt],
    );
    if (!result.rowCount) throw new Error('This app grant is unavailable.');
  }
  async function read(id: string, client: Pool | PoolClient = pool) {
    const validId = z.uuid().parse(id);
    const row = (
      await client.query<{ ciphertext: string; version: number }>(
        'SELECT ciphertext,version FROM vault_app_grants WHERE id=$1 AND owner_id=$2 AND (expires_at IS NULL OR expires_at>now())',
        [validId, owner],
      )
    ).rows[0];
    if (!row) throw new Error('This app grant is unavailable.');
    return { value: open(await key(), owner, validId, row.ciphertext), version: row.version };
  }
  async function readMany(ids: string[], client: Pool | PoolClient = pool) {
    const validIds = z.array(z.uuid()).parse(ids);
    const values = new Map<string, { value: string; version: number }>();
    if (!validIds.length) return values;
    const rows = (
      await client.query<{ id: string; ciphertext: string; version: number }>(
        'SELECT id,ciphertext,version FROM vault_app_grants WHERE id=ANY($1::uuid[]) AND owner_id=$2 AND (expires_at IS NULL OR expires_at>now())',
        [validIds, owner],
      )
    ).rows;
    if (!rows.length) return values;
    const secret = await key();
    for (const row of rows) {
      try {
        values.set(row.id, {
          value: open(secret, owner, row.id, row.ciphertext),
          version: row.version,
        });
      } catch {}
    }
    return values;
  }
  async function replace(id: string, version: number, value: string) {
    const validId = z.uuid().parse(id);
    const result = await pool.query(
      `UPDATE vault_app_grants SET ciphertext=$4,version=version+1,updated_at=now()
       WHERE id=$1 AND owner_id=$2 AND version=$3`,
      [validId, owner, version, seal(await key(), owner, validId, value)],
    );
    return Boolean(result.rowCount);
  }
  async function remove(id: string, client: Pool | PoolClient = pool) {
    await client.query('DELETE FROM vault_app_grants WHERE id=$1 AND owner_id=$2', [
      z.uuid().parse(id),
      owner,
    ]);
  }
  return { put, read, readMany, replace, remove };
}
