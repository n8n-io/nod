import { randomUUID } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import type { Pool } from 'pg';
import { z } from 'zod';
import type { IntegrationProvider } from '../ports/integrations.ts';
import type { CredentialKeyStore } from '../ports/key-store.ts';
import type { IntegrationKeyStatus } from '../shared/integrations.ts';
import { createAppGrantVault } from './vault-app-grants.ts';

const invalidKey = 'That key didn’t work. Copy it again from Composio and paste it here.';
const unreachable = 'Composio could not be reached. Try again.';
const publicErrors =
  /^(Configure OTTO_VAULT_KEY|The key is managed|That key didn’t work|Composio could not be reached)/;
const keyInput = z.object({ key: z.string().trim().min(8).max(16384) }).strict();

function parseKey(body: unknown) {
  const input = keyInput.safeParse(body);
  if (!input.success) throw new Error(invalidKey);
  return input.data.key;
}

async function verify(provider: IntegrationProvider, key: string) {
  let valid: boolean;
  try {
    valid = (await provider.verifyApiKey?.(key)) ?? true;
  } catch {
    throw new Error(unreachable);
  }
  if (!valid) throw new Error(invalidKey);
}

export function registerIntegrationKeyRoutes(
  app: FastifyInstance,
  provider: IntegrationProvider,
  service?: ReturnType<typeof createIntegrationKeyService>,
) {
  void app.register(async (routes) => {
    routes.setErrorHandler((error, _request, reply) =>
      reply.code(400).send({
        error:
          error instanceof Error && publicErrors.test(error.message)
            ? error.message
            : 'The key could not be saved.',
      }),
    );
    routes.post('/api/integrations/key/check', async (request) => {
      await verify(provider, parseKey(request.body));
      return { ok: true };
    });
    if (!service) return;
    routes.get('/api/integrations/key', async () => service.status());
    routes.put('/api/integrations/key', async (request) => {
      await service.save(parseKey(request.body));
      return { ok: true };
    });
    routes.delete('/api/integrations/key', async () => {
      await service.remove();
      return { ok: true };
    });
  });
}

export function createIntegrationKeyService(options: {
  database: Pool;
  ownerId: string;
  keyStore: CredentialKeyStore;
  provider: IntegrationProvider;
  changed?(): void;
}) {
  const { database, ownerId, provider } = options;
  let vault: Awaited<ReturnType<typeof createAppGrantVault>>;
  const secrets = new Set<string>();
  const observers = new Set<(values: string[]) => void>();
  let current: string | undefined;
  const environment = provider.configured;
  async function savedId() {
    return (
      await database.query<{ vault_id: string }>(
        'SELECT vault_id FROM integration_keys WHERE owner_id=$1',
        [ownerId],
      )
    ).rows[0]?.vault_id;
  }
  function apply(key?: string) {
    current = key;
    provider.setApiKey?.(key);
    if (key && !secrets.has(key)) {
      secrets.add(key);
      for (const observer of observers) observer([key]);
    }
    options.changed?.();
  }
  return {
    async initialize() {
      vault = await createAppGrantVault(database, { ownerId, keyStore: options.keyStore });
      await database.query(
        'CREATE TABLE IF NOT EXISTS integration_keys(owner_id text PRIMARY KEY, vault_id uuid NOT NULL)',
      );
      const id = await savedId();
      if (id && !environment) apply((await vault.read(id)).value);
    },
    onSecrets(observer: (values: string[]) => void) {
      observers.add(observer);
      observer([...secrets]);
      return () => observers.delete(observer);
    },
    status(): IntegrationKeyStatus {
      return {
        managed: environment,
        saved: !environment && Boolean(current),
        suffix: !environment && current ? current.slice(-4) : null,
      };
    },
    async save(key: string) {
      if (environment) throw new Error('The key is managed in server settings.');
      if (!options.keyStore.configured)
        throw new Error('Configure OTTO_VAULT_KEY in server settings before saving a key.');
      await verify(provider, key);
      const id = (await savedId()) ?? randomUUID();
      await vault.put(id, key);
      await database.query(
        'INSERT INTO integration_keys(owner_id,vault_id) VALUES($1,$2) ON CONFLICT DO NOTHING',
        [ownerId, id],
      );
      apply(key);
    },
    async remove() {
      if (environment) throw new Error('The key is managed in server settings.');
      const id = await savedId();
      if (id) {
        await vault.remove(id);
        await database.query('DELETE FROM integration_keys WHERE owner_id=$1', [ownerId]);
      }
      apply(undefined);
    },
    register(app: FastifyInstance) {
      registerIntegrationKeyRoutes(app, provider, this);
    },
  };
}
