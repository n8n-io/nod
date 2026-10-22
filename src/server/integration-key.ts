import { createHash, randomUUID } from 'node:crypto';
import type { Pool } from 'pg';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { IntegrationProvider, IntegrationService } from '../ports/integrations.ts';
import type { CredentialKeyStore } from '../ports/key-store.ts';
import type { IntegrationKeyStatus, IntegrationManagedAccess } from '../shared/integrations.ts';
import { pool } from './db.ts';
import { transaction } from './transaction.ts';
import { initializeIntegrationSchema, IntegrationError } from './integrations.ts';
import { createAppGrantVault } from './vault-app-grants.ts';

class IntegrationKeyError extends Error {}

const invalidKey = 'That key didn’t work. Copy it again from Composio and paste it here.';
const keyInput = z.object({ key: z.string().trim().min(8).max(16384) }).strict();

export interface LegacyIntegration {
  apiKey: string;
  authConfigs: Partial<Record<IntegrationService, string>>;
}

export function createIntegrationKeyService(options: {
  database?: Pool;
  ownerId: string;
  keyStore: CredentialKeyStore;
  provider: IntegrationProvider;
  fixed?: IntegrationKeyStatus['mode'];
  managed?: {
    status(): Promise<IntegrationManagedAccess>;
    observedStatus?(): IntegrationManagedAccess;
  };
}) {
  const { ownerId, provider, fixed } = options;
  const database = options.database ?? pool;
  let vault: Awaited<ReturnType<typeof createAppGrantVault>>;
  let own = fixed === 'own';
  let suffix: string | null = null;
  let pending: Promise<unknown> = Promise.resolve();
  const secrets: string[] = [];
  const observers = new Set<(values: string[]) => void>();
  async function savedId() {
    return (
      await database.query<{ vault_id: string | null }>(
        'SELECT vault_id FROM integration_keys WHERE owner_id=$1',
        [ownerId],
      )
    ).rows[0]?.vault_id;
  }
  function use(key?: string, authConfigs?: LegacyIntegration['authConfigs']) {
    if (key && !secrets.includes(key)) {
      secrets.push(key);
      for (const observer of observers) observer([key]);
    }
    provider.setApiKey!(key, authConfigs);
    own = Boolean(key);
    suffix = key?.slice(-4) ?? null;
  }
  async function status(): Promise<IntegrationKeyStatus> {
    return {
      mode: own ? 'own' : 'nod',
      switchable: !fixed && (options.keyStore.configured || own || Boolean(options.managed)),
      keyWritable: !fixed && options.keyStore.configured,
      suffix,
      managed: options.managed
        ? own
          ? (options.managed.observedStatus?.() ?? { state: 'sign_in_required', email: null })
          : await options.managed
              .status()
              .catch(() => ({ state: 'unavailable' as const, email: null }))
        : null,
    };
  }
  async function verify(key: string) {
    if (!options.keyStore.configured)
      throw new IntegrationKeyError('Configure NOD_VAULT_KEY before saving a key.');
    await options.keyStore.getKey().catch(() => {
      throw new IntegrationKeyError('nod couldn’t open its key store, so nothing changed.');
    });
    let valid: boolean;
    try {
      valid = await provider.verifyApiKey!(key);
    } catch {
      throw new IntegrationKeyError('Composio could not be reached. Try again.');
    }
    if (!valid) throw new IntegrationKeyError(invalidKey);
  }
  async function save(key: string) {
    const id = (await savedId()) ?? randomUUID();
    await transaction(async (client) => {
      const previous = (
        await client.query<{ auth_config_vault_id: string | null }>(
          'SELECT auth_config_vault_id FROM integration_keys WHERE owner_id=$1',
          [ownerId],
        )
      ).rows[0]?.auth_config_vault_id;
      await vault.put(id, key, client);
      await client.query(
        'INSERT INTO integration_keys(owner_id,vault_id) VALUES($1,$2) ON CONFLICT(owner_id) DO UPDATE SET vault_id=EXCLUDED.vault_id,auth_config_vault_id=NULL',
        [ownerId, id],
      );
      if (previous) await vault.remove(previous, client);
    }, database);
    use(key, {});
  }
  async function remove() {
    await transaction(async (client) => {
      const previous = (
        await client.query<{ vault_id: string | null; auth_config_vault_id: string | null }>(
          'SELECT vault_id,auth_config_vault_id FROM integration_keys WHERE owner_id=$1 FOR UPDATE',
          [ownerId],
        )
      ).rows[0];
      await client.query(
        'INSERT INTO integration_keys(owner_id,vault_id) VALUES($1,NULL) ON CONFLICT(owner_id) DO UPDATE SET vault_id=NULL,auth_config_vault_id=NULL',
        [ownerId],
      );
      if (previous?.auth_config_vault_id) await vault.remove(previous.auth_config_vault_id, client);
      if (previous?.vault_id) await vault.remove(previous.vault_id, client);
    }, database);
    use(undefined, {});
  }
  return {
    get mode() {
      return own ? 'own' : 'nod';
    },
    async initialize() {
      if (fixed) return;
      vault = await createAppGrantVault(database, { ownerId, keyStore: options.keyStore });
      await database.query(
        'CREATE TABLE IF NOT EXISTS integration_keys(owner_id text PRIMARY KEY, vault_id uuid); ALTER TABLE integration_keys ALTER COLUMN vault_id DROP NOT NULL; ALTER TABLE integration_keys ADD COLUMN IF NOT EXISTS auth_config_vault_id uuid',
      );
      const id = await savedId();
      if (!id) return;
      own = true;
      try {
        const configId = (
          await database.query<{ auth_config_vault_id: string | null }>(
            'SELECT auth_config_vault_id FROM integration_keys WHERE owner_id=$1',
            [ownerId],
          )
        ).rows[0]?.auth_config_vault_id;
        const configuration = configId ? JSON.parse((await vault.read(configId)).value) : undefined;
        use((await vault.read(id)).value, configuration);
      } catch {}
    },
    async importLegacy(input: LegacyIntegration) {
      if (fixed || !options.keyStore.configured) return false;
      const parsed = z
        .object({
          apiKey: z.string().min(1).max(16384),
          authConfigs: z.record(
            z.string().regex(/^[a-z][a-z0-9_]{0,79}$/),
            z.string().min(1).max(16384),
          ),
        })
        .strict()
        .parse(input);
      await initializeIntegrationSchema(database);
      const imported = await transaction(async (client) => {
        await client.query(
          'LOCK TABLE integration_keys, app_connections IN SHARE ROW EXCLUSIVE MODE',
        );
        const existing = (
          await client.query<{ vault_id: string | null; auth_config_vault_id: string | null }>(
            'SELECT vault_id,auth_config_vault_id FROM integration_keys WHERE owner_id=$1',
            [ownerId],
          )
        ).rows[0];
        if (existing) {
          if (!existing.vault_id) return false;
          try {
            if ((await vault.read(existing.vault_id, client)).value !== parsed.apiKey) return false;
            const configs = existing.auth_config_vault_id
              ? JSON.parse((await vault.read(existing.auth_config_vault_id, client)).value)
              : {};
            return (
              JSON.stringify(Object.entries(configs).sort()) ===
              JSON.stringify(Object.entries(parsed.authConfigs).sort())
            );
          } catch {
            return false;
          }
        }
        const configurationId = createHash('sha256')
          .update(`direct:${parsed.apiKey}`)
          .digest('hex');
        const bindings = await client.query(
          'SELECT 1 FROM app_connections WHERE owner_id=$1 AND configuration_id IS NOT NULL AND configuration_id<>$2 LIMIT 1',
          [ownerId, configurationId],
        );
        if (bindings.rowCount) {
          await client.query('INSERT INTO integration_keys(owner_id,vault_id) VALUES($1,NULL)', [
            ownerId,
          ]);
          return false;
        }
        if (options.managed) {
          const access = await options.managed.status().catch(() => undefined);
          if (!access || access.state === 'unavailable') return false;
          if (access.state !== 'sign_in_required') {
            await client.query('INSERT INTO integration_keys(owner_id,vault_id) VALUES($1,NULL)', [
              ownerId,
            ]);
            return false;
          }
        }
        const id = randomUUID();
        const configuration = Object.keys(parsed.authConfigs).length ? randomUUID() : null;
        await vault.put(id, parsed.apiKey, client);
        if (configuration)
          await vault.put(configuration, JSON.stringify(parsed.authConfigs), client);
        await client.query(
          'INSERT INTO integration_keys(owner_id,vault_id,auth_config_vault_id) VALUES($1,$2,$3)',
          [ownerId, id, configuration],
        );
        return true;
      }, database);
      if (imported) await this.initialize();
      return imported;
    },
    onSecrets(observer: (values: string[]) => void) {
      observers.add(observer);
      observer([...secrets]);
    },
    register(
      app: FastifyInstance,
      integrations: {
        changeProvider(
          revoke: boolean,
          swap: () => Promise<void>,
          skipRemoteRevocation?: () => Promise<boolean>,
        ): Promise<void>;
      },
    ) {
      function change(key?: string) {
        const result = pending.then(async () => {
          if (fixed)
            throw new IntegrationKeyError(
              'This installation sets its app connection in its settings.',
            );
          if (key !== undefined) await verify(key);
          else if (!options.managed || (await options.managed.status()).state !== 'enabled')
            throw new IntegrationKeyError(
              'Sign in with an approved Google account before switching to nod’s connection.',
            );
          let detached = false;
          await integrations.changeProvider(
            own !== (key !== undefined),
            () => (key === undefined ? remove() : save(key)),
            !own && key !== undefined && options.managed
              ? async () => {
                  const access = await options.managed!.status();
                  detached = access.state === 'revoked' || access.state === 'sign_in_required';
                  if (!detached && access.state !== 'enabled')
                    throw new IntegrationKeyError(
                      'nod couldn’t check your managed connection, so nothing changed. Try again.',
                    );
                  return detached;
                }
              : undefined,
          );
          return {
            ...(await status()),
            ...(detached
              ? {
                  warning:
                    'Your key is saved. Previous managed app permissions remain with their providers; remove them there if needed.',
                }
              : {}),
          };
        });
        pending = result.catch(() => {});
        return result;
      }
      void app.register(async (routes) => {
        routes.setErrorHandler((error, _request, reply) =>
          reply.code(400).send({
            error:
              error instanceof IntegrationKeyError || error instanceof IntegrationError
                ? error.message
                : 'The key could not be saved.',
          }),
        );
        routes.get('/api/integrations/key', async () => status());
        routes.put('/api/integrations/key', async (request) => {
          const input = keyInput.safeParse(request.body);
          if (!input.success) throw new IntegrationKeyError(invalidKey);
          return change(input.data.key);
        });
        routes.delete('/api/integrations/key', () => change());
      });
    },
  };
}

export async function receiveLegacyIntegration(options: {
  ownerId: string;
  parent: {
    on(event: 'message', listener: (event: { data: unknown }) => void): unknown;
    removeListener(event: 'message', listener: (event: { data: unknown }) => void): unknown;
    postMessage(message: unknown): void;
  };
  timeout?: number;
}) {
  const nonce = randomUUID();
  const envelope = z
    .object({
      type: z.literal('nod-legacy-integration'),
      ownerId: z.literal(options.ownerId),
      nonce: z.literal(nonce),
      receipt: z.string().regex(/^[a-f0-9]{64}$/),
      apiKey: z.string().min(1).max(16384),
      authConfigs: z.record(
        z.string().regex(/^[a-z][a-z0-9_]{0,79}$/),
        z.string().min(1).max(16384),
      ),
    })
    .strict();
  const message = await new Promise<z.infer<typeof envelope>>((resolve, reject) => {
    const timer = setTimeout(() => {
      options.parent.removeListener('message', receive);
      reject(new Error('nod could not restore its saved app connection.'));
    }, options.timeout ?? 30000);
    function receive(event: { data: unknown }) {
      const parsed = envelope.safeParse(event.data);
      if (!parsed.success) return;
      clearTimeout(timer);
      options.parent.removeListener('message', receive);
      resolve(parsed.data);
    }
    options.parent.on('message', receive);
    options.parent.postMessage({
      type: 'nod-legacy-integration-request',
      ownerId: options.ownerId,
      nonce,
    });
  });
  return {
    input: { apiKey: message.apiKey, authConfigs: message.authConfigs },
    acknowledge: () =>
      new Promise<void>((resolve) => {
        const timer = setTimeout(() => {
          options.parent.removeListener('message', receive);
          resolve();
        }, options.timeout ?? 30000);
        function receive(event: { data: unknown }) {
          const result = event.data as Record<string, unknown> | null;
          if (
            (result?.type !== 'nod-legacy-integration-cleaned' &&
              result?.type !== 'nod-legacy-integration-cleanup-deferred') ||
            result.ownerId !== options.ownerId ||
            result.nonce !== nonce ||
            result.receipt !== message.receipt
          )
            return;
          clearTimeout(timer);
          options.parent.removeListener('message', receive);
          resolve();
        }
        options.parent.on('message', receive);
        options.parent.postMessage({
          type: 'nod-legacy-integration-ack',
          ownerId: options.ownerId,
          nonce,
          receipt: message.receipt,
        });
      }),
  };
}
