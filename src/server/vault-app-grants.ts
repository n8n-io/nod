import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';
import type { Pool, PoolClient } from 'pg';
import { z } from 'zod';
import type { CredentialKeyStore } from '../ports/key-store.ts';

function seal(key: Buffer, owner: string, id: string, value: string) {
  const nonce = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', key, nonce);
  cipher.setAAD(Buffer.from(JSON.stringify(['otto-app-grant-v1', owner, id])));
  const bytes = Buffer.concat([cipher.update(value), cipher.final()]);
  return Buffer.concat([nonce, cipher.getAuthTag(), bytes]).toString('base64');
}

function open(key: Buffer, owner: string, id: string, value: string, legacy = false) {
  const bytes = Buffer.from(value, 'base64');
  const decipher = createDecipheriv('aes-256-gcm', key, bytes.subarray(0, 12));
  decipher.setAAD(
    Buffer.from(JSON.stringify([legacy ? 'otto-discovered-v1' : 'otto-app-grant-v1', owner, id])),
  );
  decipher.setAuthTag(bytes.subarray(12, 28));
  return Buffer.concat([decipher.update(bytes.subarray(28)), decipher.final()]).toString();
}

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
    ALTER TABLE vault_app_grants ADD COLUMN IF NOT EXISTS expires_at timestamptz;
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
  async function read(id: string) {
    const validId = z.uuid().parse(id);
    const row = (
      await pool.query<{ ciphertext: string; version: number }>(
        'SELECT ciphertext,version FROM vault_app_grants WHERE id=$1 AND owner_id=$2 AND (expires_at IS NULL OR expires_at>now())',
        [validId, owner],
      )
    ).rows[0];
    if (!row) throw new Error('This app grant is unavailable.');
    return { value: open(await key(), owner, validId, row.ciphertext), version: row.version };
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
  async function adoptLegacy(id: string, ciphertext: string) {
    const validId = z.uuid().parse(id);
    const value = open(await key(), owner, validId, ciphertext, true);
    await pool.query(
      `INSERT INTO vault_app_grants(id,owner_id,ciphertext) VALUES($1,$2,$3)
       ON CONFLICT(id) DO NOTHING`,
      [validId, owner, seal(await key(), owner, validId, value)],
    );
    await read(validId);
  }
  async function adoptPlain(id: string, value: string, expiresAt: Date | null = null) {
    const validId = z.uuid().parse(id);
    await pool.query(
      `INSERT INTO vault_app_grants(id,owner_id,ciphertext,expires_at) VALUES($1,$2,$3,$4)
       ON CONFLICT(id) DO NOTHING`,
      [validId, owner, seal(await key(), owner, validId, value), expiresAt],
    );
    await read(validId);
  }
  return { put, read, replace, remove, adoptLegacy, adoptPlain };
}
