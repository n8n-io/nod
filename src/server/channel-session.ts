import { randomUUID } from 'node:crypto';
import type { Pool } from 'pg';
import { z } from 'zod';
import type { ChannelSessionStore } from '../ports/channel-session.ts';
import type { CredentialKeyStore } from '../ports/key-store.ts';
import { openVaultValue, sealVaultValue } from './vault-crypto.ts';
import { transaction } from './transaction.ts';

const slotSchema = z.string().min(1).max(1024);
const entriesSchema = z.record(
  slotSchema,
  z
    .string()
    .max(1024 * 1024)
    .nullable(),
);

export function createChannelSessionStore(options: {
  pool: Pool;
  ownerId: string;
  keyStore: CredentialKeyStore;
}): ChannelSessionStore {
  const owner = z.string().min(1).max(200).parse(options.ownerId);
  let initialized: Promise<unknown> | undefined;
  let key: Promise<Buffer> | undefined;
  const binding = (slot: string) => ['nod', 'channel-session', owner, 'whatsapp', slot];
  function encryptionKey() {
    if (!options.keyStore.configured) throw new Error('Secure channel storage is unavailable.');
    key ??= options.keyStore.getKey().catch((error) => {
      key = undefined;
      throw error;
    });
    return key;
  }
  return {
    async open() {
      const encryption = await encryptionKey();
      initialized ??= options.pool
        .query(
          `
        CREATE TABLE IF NOT EXISTS channel_sessions(owner_id text PRIMARY KEY,revision uuid NOT NULL);
        CREATE TABLE IF NOT EXISTS channel_session_keys(owner_id text NOT NULL REFERENCES channel_sessions(owner_id),slot text NOT NULL,ciphertext text NOT NULL,PRIMARY KEY(owner_id,slot));
      `,
        )
        .catch((error) => {
          initialized = undefined;
          throw error;
        });
      await initialized;
      const revision = randomUUID();
      await options.pool.query(
        `INSERT INTO channel_sessions(owner_id,revision) VALUES($1,$2)
        ON CONFLICT(owner_id) DO UPDATE SET revision=EXCLUDED.revision`,
        [owner, revision],
      );
      let closed = false;
      let pending = Promise.resolve();
      const check = () => {
        if (closed) throw new Error('This channel session is closed.');
      };
      const exclusive = <T>(work: () => Promise<T>) => {
        const result = pending.then(work);
        pending = result.then(
          () => {},
          () => {},
        );
        return result;
      };
      return {
        async get(slot) {
          check();
          slotSchema.parse(slot);
          const result = await options.pool.query<{ ciphertext: string }>(
            `SELECT k.ciphertext FROM channel_session_keys k JOIN channel_sessions s ON s.owner_id=k.owner_id
              WHERE k.owner_id=$1 AND k.slot=$2 AND s.revision=$3`,
            [owner, slot, revision],
          );
          check();
          const ciphertext = result.rows[0]?.ciphertext;
          return ciphertext === undefined
            ? undefined
            : openVaultValue(encryption, binding(slot), ciphertext);
        },
        async set(input) {
          check();
          const entries = Object.entries(entriesSchema.parse(input));
          if (entries.length > 10_000) throw new Error('Channel session storage is full.');
          let batchBytes = 0;
          for (const [, value] of entries) {
            if (value === null) continue;
            const bytes = Buffer.byteLength(value);
            batchBytes += 4 * Math.ceil((bytes + 28) / 3);
            if (bytes > 1024 * 1024 || batchBytes > 32 * 1024 * 1024)
              throw new Error('Channel session storage is full.');
          }
          await exclusive(() =>
            transaction(async (client) => {
              check();
              const active = await client.query(
                'SELECT 1 FROM channel_sessions WHERE owner_id=$1 AND revision=$2 FOR UPDATE',
                [owner, revision],
              );
              if (!active.rowCount) throw new Error('This channel session has changed.');
              const sealed = entries.map(
                ([slot, value]) =>
                  [
                    slot,
                    value === null ? null : sealVaultValue(encryption, binding(slot), value),
                  ] as const,
              );
              for (const [slot, ciphertext] of sealed) {
                if (ciphertext === null)
                  await client.query(
                    'DELETE FROM channel_session_keys WHERE owner_id=$1 AND slot=$2',
                    [owner, slot],
                  );
                else
                  await client.query(
                    `INSERT INTO channel_session_keys(owner_id,slot,ciphertext) VALUES($1,$2,$3)
                ON CONFLICT(owner_id,slot) DO UPDATE SET ciphertext=EXCLUDED.ciphertext`,
                    [owner, slot, ciphertext],
                  );
              }
              const stored = (
                await client.query<{ count: number; bytes: string }>(
                  'SELECT count(*)::int AS count,COALESCE(sum(octet_length(ciphertext)),0)::text AS bytes FROM channel_session_keys WHERE owner_id=$1',
                  [owner],
                )
              ).rows[0];
              if (stored.count > 10_000 || Number(stored.bytes) > 32 * 1024 * 1024)
                throw new Error('Channel session storage is full.');
              check();
            }, options.pool),
          );
        },
        async clear() {
          check();
          await exclusive(() =>
            transaction(async (client) => {
              check();
              const active = await client.query(
                'UPDATE channel_sessions SET revision=$3 WHERE owner_id=$1 AND revision=$2 RETURNING owner_id',
                [owner, revision, randomUUID()],
              );
              if (!active.rowCount) throw new Error('This channel session has changed.');
              await client.query('DELETE FROM channel_session_keys WHERE owner_id=$1', [owner]);
            }, options.pool),
          );
          closed = true;
        },
        async close() {
          if (closed) return;
          closed = true;
          await pending;
          await options.pool.query(
            'UPDATE channel_sessions SET revision=$3 WHERE owner_id=$1 AND revision=$2',
            [owner, revision, randomUUID()],
          );
        },
      };
    },
  };
}
