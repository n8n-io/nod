import { randomUUID } from 'node:crypto';
import type { PoolClient } from 'pg';
import { z } from 'zod';
import type { CredentialKeyStore } from '../ports/key-store.ts';
import type { ModelBackend } from '../ports/models.ts';
import type { SetupJournal } from '../ports/setup.ts';
import { createModelService, endpointAddress } from './models.ts';
import type { ModelState, ModelStore } from './model-store.ts';
import { lockKey } from './locks.ts';
import { openVaultValue, sealVaultValue } from './vault-crypto.ts';

const effort = z.enum(['off', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max']);
const credential = z.discriminatedUnion('type', [
  z.object({ type: z.literal('api_key'), key: z.string().min(1).max(32000) }).strict(),
  z
    .object({
      type: z.literal('endpoint'),
      url: z
        .string()
        .max(2000)
        .refine((value) => endpointAddress(value) === value),
      key: z.string().min(1).max(32000).optional(),
    })
    .strict(),
  z
    .object({
      type: z.literal('oauth'),
      access: z.string().min(1).max(32000),
      refresh: z.string().min(1).max(32000),
      expires: z.number().positive().finite(),
      accountId: z.string().min(1).max(1000),
      email: z.email().max(320).optional(),
    })
    .strict(),
]);
const selection = z
  .object({ connectionId: z.uuid(), modelId: z.string().min(1).max(200), effort })
  .strict();
const transferSchema = z
  .object({
    version: z.literal(1),
    id: z.uuid(),
    ownerId: z.string().min(1).max(200),
    revision: z.number().int().nonnegative(),
    connections: z
      .array(
        z
          .object({
            id: z.uuid(),
            provider: z.enum(['openai', 'anthropic', 'openrouter', 'compatible']),
            method: z.enum(['api_key', 'subscription', 'oauth']),
            label: z.string().min(1).max(2000),
            status: z.enum(['connected', 'reconnect', 'loading']),
            models: z
              .array(
                z
                  .object({
                    choice: z
                      .object({
                        id: z.string().min(1).max(200),
                        name: z.string().min(1).max(1000),
                        efforts: z.array(effort).min(1).max(7),
                        images: z.boolean(),
                        contextWindow: z.number().positive().finite(),
                      })
                      .strict(),
                    spec: z.record(z.string(), z.unknown()),
                  })
                  .strict(),
              )
              .max(10000),
            managed: z.literal(false),
            credential,
          })
          .strict(),
      )
      .max(20),
    selection: selection.nullable(),
    selectionSet: z.boolean(),
  })
  .strict()
  .superRefine((value, ctx) => {
    const ids = new Set(value.connections.map((row) => row.id));
    if (
      ids.size !== value.connections.length ||
      (value.selection && !ids.has(value.selection.connectionId))
    )
      ctx.addIssue({ code: 'custom', message: 'Invalid model connections.' });
    for (const row of value.connections) {
      const valid =
        row.credential.type === 'oauth'
          ? row.provider === 'openai' && row.method === 'subscription'
          : row.credential.type === 'endpoint'
            ? row.provider === 'compatible' && row.method === 'api_key'
            : row.provider !== 'compatible' &&
              (row.method === 'api_key' ||
                (row.provider === 'openrouter' && row.method === 'oauth'));
      if (!valid) ctx.addIssue({ code: 'custom', message: 'Invalid model credential.' });
    }
  });

export type SetupModelTransfer = z.infer<typeof transferSchema>;

export function validateSetupModels(value: unknown, ownerId: string): SetupModelTransfer {
  const parsed = transferSchema.safeParse(value);
  if (!parsed.success || parsed.data.ownerId !== ownerId)
    throw new Error('The saved model setup does not belong to this profile or is invalid.');
  return parsed.data;
}

export function createSetupModels(options: {
  journal: SetupJournal;
  ownerId: string;
  backend: ModelBackend;
  origin: string;
  keyStore: CredentialKeyStore;
  changed?(): void;
}) {
  const { journal, ownerId } = options;
  let pending: Promise<unknown> = Promise.resolve();
  let pendingWrites = 0;
  let frozen = false;
  const initial = (): SetupModelTransfer => ({
    version: 1,
    id: randomUUID(),
    ownerId,
    revision: 0,
    connections: [],
    selection: null,
    selectionSet: false,
  });
  const load = async () => validateSetupModels(await journal.read('models'), ownerId);
  const store: ModelStore = {
    async initialize() {
      await journal.update<SetupModelTransfer>('models', (current) =>
        current ? validateSetupModels(current, ownerId) : initial(),
      );
    },
    async read() {
      await pending;
      return load();
    },
    change<T>(run: (state: ModelState) => Promise<T> | T, signal?: AbortSignal) {
      pendingWrites++;
      const operation = pending.then(async () => {
        if (frozen)
          throw new Error('Model setup has finished. Open Otto to change its connections.');
        signal?.throwIfAborted();
        const previous = await load();
        const state = structuredClone(previous);
        const result = await run(state);
        signal?.throwIfAborted();
        if (JSON.stringify(previous) !== JSON.stringify(state)) {
          state.revision++;
          const next = validateSetupModels(state, ownerId);
          await journal.update<SetupModelTransfer>('models', (current) => {
            signal?.throwIfAborted();
            const latest = validateSetupModels(current, ownerId);
            if (latest.id !== previous.id || latest.revision !== previous.revision)
              throw new Error('Model setup changed. Try again.');
            return next;
          });
        }
        return result;
      });
      const completed = operation.finally(() => pendingWrites--);
      pending = completed.catch(() => {});
      return completed;
    },
  };
  const service = createModelService({ ...options, store });
  const busy = service.busy;
  return Object.assign(service, {
    busy() {
      return pendingWrites > 0 || busy();
    },
    async transfer() {
      await service.close();
      frozen = true;
      await pending;
      return load();
    },
  });
}

export async function importSetupModels(
  client: PoolClient,
  options: { ownerId: string; keyStore: CredentialKeyStore; transfer: unknown },
) {
  const { ownerId, keyStore } = options;
  const state = validateSetupModels(options.transfer, ownerId);
  await lockKey(client, `models:${ownerId}`);
  const existing = (
    await client.query<{ id: string }>('SELECT id FROM model_connections WHERE owner_id=$1', [
      ownerId,
    ])
  ).rows;
  if (
    existing.length +
      state.connections.filter((row) => !existing.some((item) => item.id === row.id)).length >
    20
  )
    throw new Error('There are too many saved model connections.');
  const key = state.connections.length ? await keyStore.getKey() : undefined;
  for (const row of state.connections) {
    const found = (
      await client.query<{
        owner_id: string;
        provider: string;
        method: string;
        managed: boolean;
        ciphertext: string | null;
      }>(
        `SELECT m.owner_id,m.provider,m.method,m.managed,v.ciphertext FROM model_connections m
       LEFT JOIN vault_app_grants v ON v.id=m.id AND v.owner_id=m.owner_id WHERE m.id=$1`,
        [row.id],
      )
    ).rows[0];
    const value = JSON.stringify(row.credential);
    const context = ['otto-app-grant-v1', ownerId, row.id];
    if (found) {
      if (
        found.owner_id !== ownerId ||
        found.provider !== row.provider ||
        found.method !== row.method ||
        found.managed ||
        !found.ciphertext ||
        openVaultValue(key!, context, found.ciphertext) !== value
      )
        throw new Error(
          'This model connection has changed since setup. Its newer credentials were kept.',
        );
      continue;
    }
    const grant = await client.query(
      `INSERT INTO vault_app_grants(id,owner_id,ciphertext) VALUES($1,$2,$3)
       ON CONFLICT DO NOTHING RETURNING id`,
      [row.id, ownerId, sealVaultValue(key!, context, value)],
    );
    if (!grant.rowCount)
      throw new Error('This model connection is already owned by another setup.');
    await client.query(
      `INSERT INTO model_connections(id,owner_id,provider,method,label,status,models,managed)
       VALUES($1,$2,$3,$4,$5,$6,$7,false)`,
      [
        row.id,
        ownerId,
        row.provider,
        row.method,
        row.label,
        row.status,
        JSON.stringify(row.models),
      ],
    );
  }
  if (state.selection)
    await client.query(
      `UPDATE model_settings SET selection=$2,selection_set=$3
       WHERE owner_id=$1 AND NOT selection_set`,
      [ownerId, JSON.stringify(state.selection), state.selectionSet],
    );
  return { id: state.id, revision: state.revision, connections: state.connections.length };
}
