import type { Pool, PoolClient } from 'pg';
import type { ModelCredential, ModelDefinition } from '../ports/models.ts';
import type { CredentialKeyStore } from '../ports/key-store.ts';
import type { ModelMethod, ModelProvider, ModelSelection } from '../shared/models.ts';
import { createAppGrantVault } from './vault-app-grants.ts';
import { lockKey, locksTable } from './locks.ts';
import { transaction } from './transaction.ts';

export interface ModelRecord {
  id: string;
  provider: ModelProvider;
  method: ModelMethod;
  label: string;
  status: 'connected' | 'reconnect' | 'loading';
  models: ModelDefinition[];
  managed: boolean;
  credential?: ModelCredential;
}

export interface ModelState {
  connections: ModelRecord[];
  selection: ModelSelection | null;
  selectionSet: boolean;
  hostId: string;
}

interface ModelStore {
  initialize(): Promise<void>;
  read(): Promise<ModelState>;
  change<T>(run: (state: ModelState) => Promise<T> | T, signal?: AbortSignal): Promise<T>;
}

export function createDatabaseModelStore(options: {
  database: Pool;
  ownerId: string;
  keyStore: CredentialKeyStore;
}) {
  const { database, ownerId } = options;
  let vault: Awaited<ReturnType<typeof createAppGrantVault>>;
  async function read(client: Pool | PoolClient = database): Promise<ModelState> {
    const connections = (
      await client.query<ModelRecord>(
        'SELECT id,provider,method,label,status,models,managed FROM model_connections WHERE owner_id=$1 ORDER BY created_at,id',
        [ownerId],
      )
    ).rows;
    const credentials = await vault.readMany(
      connections.filter((row) => !row.managed).map((row) => row.id),
      client,
    );
    for (const row of connections) {
      const saved = credentials.get(row.id);
      if (!saved) continue;
      try {
        row.credential = JSON.parse(saved.value) as ModelCredential;
      } catch {}
    }
    const settings = (
      await client.query<{
        selection: ModelSelection | null;
        selection_set: boolean;
        host_id: string;
      }>('SELECT selection,selection_set,host_id FROM model_settings WHERE owner_id=$1', [ownerId])
    ).rows[0];
    return {
      connections,
      selection: settings?.selection ?? null,
      selectionSet: settings?.selection_set ?? false,
      hostId: settings.host_id,
    };
  }
  return {
    async initialize() {
      vault = await createAppGrantVault(database, { ownerId, keyStore: options.keyStore });
      await database.query(`${locksTable};
        CREATE TABLE IF NOT EXISTS model_connections (
          id uuid PRIMARY KEY,owner_id text NOT NULL,provider text NOT NULL,method text NOT NULL,label text NOT NULL,
          status text NOT NULL DEFAULT 'connected',models jsonb NOT NULL,managed boolean NOT NULL DEFAULT false,created_at timestamptz NOT NULL DEFAULT now()
        ); CREATE INDEX IF NOT EXISTS model_connections_owner ON model_connections(owner_id);
        CREATE TABLE IF NOT EXISTS model_settings(owner_id text PRIMARY KEY,selection jsonb,selection_set boolean NOT NULL DEFAULT false);
        ALTER TABLE model_settings ADD COLUMN IF NOT EXISTS host_id uuid NOT NULL DEFAULT gen_random_uuid();`);
      await database.query(
        'INSERT INTO model_settings(owner_id) VALUES($1) ON CONFLICT DO NOTHING',
        [ownerId],
      );
    },
    read,
    async change<T>(run: (state: ModelState) => Promise<T> | T, signal?: AbortSignal) {
      signal?.throwIfAborted();
      return transaction(async (client) => {
        await lockKey(client, `models:${ownerId}`);
        const state = await read(client);
        const previous = structuredClone(state);
        const result = await run(state);
        signal?.throwIfAborted();
        for (const row of previous.connections) {
          if (state.connections.some((next) => next.id === row.id)) continue;
          await client.query('DELETE FROM model_connections WHERE id=$1 AND owner_id=$2', [
            row.id,
            ownerId,
          ]);
          await vault.remove(row.id, client);
        }
        for (const row of state.connections) {
          const before = previous.connections.find((item) => item.id === row.id);
          if (JSON.stringify(before) === JSON.stringify(row)) continue;
          if (
            !row.managed &&
            row.credential &&
            JSON.stringify(before?.credential) !== JSON.stringify(row.credential)
          )
            await vault.put(row.id, JSON.stringify(row.credential), client);
          const saved = await client.query(
            `INSERT INTO model_connections(id,owner_id,provider,method,label,models,managed,status) VALUES($1,$2,$3,$4,$5,$6,$7,$8)
             ON CONFLICT(id) DO UPDATE SET models=excluded.models,label=excluded.label,status=excluded.status
             WHERE model_connections.owner_id=excluded.owner_id RETURNING id`,
            [
              row.id,
              ownerId,
              row.provider,
              row.method,
              row.label,
              JSON.stringify(row.models),
              row.managed,
              row.status,
            ],
          );
          if (!saved.rowCount) throw new Error('This model connection is unavailable.');
        }
        if (
          JSON.stringify(state.selection) !== JSON.stringify(previous.selection) ||
          state.selectionSet !== previous.selectionSet
        )
          await client.query(
            'UPDATE model_settings SET selection=$2,selection_set=$3 WHERE owner_id=$1',
            [ownerId, JSON.stringify(state.selection), state.selectionSet],
          );
        signal?.throwIfAborted();
        return result;
      }, database);
    },
  } satisfies ModelStore;
}
