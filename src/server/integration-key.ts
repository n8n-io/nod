import { randomUUID } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { IntegrationProvider } from '../ports/integrations.ts';
import type { CredentialKeyStore } from '../ports/key-store.ts';
import type { IntegrationKeyStatus, IntegrationManagedAccess } from '../shared/integrations.ts';
import { pool } from './db.ts';
import { transaction } from './transaction.ts';
import { IntegrationError } from './integrations.ts';
import { createAppGrantVault } from './vault-app-grants.ts';

class IntegrationKeyError extends Error {}

const invalidKey = 'That key didn’t work. Copy it again from Composio and paste it here.';
const keyInput = z.object({ key: z.string().trim().min(8).max(16384) }).strict();

export function createIntegrationKeyService(options: {
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
  let vault: Awaited<ReturnType<typeof createAppGrantVault>>;
  let own = fixed === 'own';
  let suffix: string | null = null;
  let pending: Promise<unknown> = Promise.resolve();
  const secrets: string[] = [];
  const observers = new Set<(values: string[]) => void>();
  async function savedId() {
    return (
      await pool.query<{ vault_id: string }>(
        'SELECT vault_id FROM integration_keys WHERE owner_id=$1',
        [ownerId],
      )
    ).rows[0]?.vault_id;
  }
  function use(key?: string) {
    if (key && !secrets.includes(key)) {
      secrets.push(key);
      for (const observer of observers) observer([key]);
    }
    provider.setApiKey!(key);
    own = Boolean(key);
    suffix = key?.slice(-4) ?? null;
  }
  async function status(): Promise<IntegrationKeyStatus> {
    return {
      mode: own ? 'own' : 'otto',
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
      throw new IntegrationKeyError('Configure OTTO_VAULT_KEY before saving a key.');
    await options.keyStore.getKey().catch(() => {
      throw new IntegrationKeyError('Otto couldn’t open its key store, so nothing changed.');
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
      await vault.put(id, key, client);
      await client.query(
        'INSERT INTO integration_keys(owner_id,vault_id) VALUES($1,$2) ON CONFLICT DO NOTHING',
        [ownerId, id],
      );
    }, pool);
    use(key);
  }
  async function remove() {
    const id = await savedId();
    if (id)
      await transaction(async (client) => {
        await client.query('DELETE FROM integration_keys WHERE owner_id=$1', [ownerId]);
        await vault.remove(id, client);
      }, pool);
    use();
  }
  return {
    get mode() {
      return own ? 'own' : 'otto';
    },
    async initialize() {
      if (fixed) return;
      vault = await createAppGrantVault(pool, { ownerId, keyStore: options.keyStore });
      await pool.query(
        'CREATE TABLE IF NOT EXISTS integration_keys(owner_id text PRIMARY KEY, vault_id uuid NOT NULL)',
      );
      const id = await savedId();
      if (!id) return;
      own = true;
      try {
        use((await vault.read(id)).value);
      } catch {}
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
              'Sign in with an approved Google account before switching to Otto’s connection.',
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
                      'Otto couldn’t check your managed connection, so nothing changed. Try again.',
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
