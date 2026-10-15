import { randomUUID, createHash } from 'node:crypto';
import type { Pool, PoolClient } from 'pg';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type {
  ModelAccess,
  ModelBackend,
  ModelCredential,
  ModelDefinition,
} from '../ports/models.ts';
import { ModelAuthError } from '../ports/models.ts';
import type { CredentialKeyStore } from '../ports/key-store.ts';
import type {
  ModelMethod,
  ModelProvider,
  ModelSelection,
  ModelsResponse,
} from '../shared/models.ts';
import { modelSource } from '../shared/models.ts';
import { signInPage } from '../shared/sign-in-page.ts';
import { agentModels, memoryModels } from '../shared/model-defaults.ts';
import { createAppGrantVault } from './vault-app-grants.ts';
import { transaction } from './transaction.ts';

const providerSchema = z.enum(['openai', 'anthropic', 'openrouter']);
const selectionSchema = z
  .object({
    connectionId: z.uuid(),
    modelId: z.string().min(1).max(200),
    effort: z.enum(['off', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max']),
  })
  .strict();
class ConnectionError extends Error {}
interface Row {
  id: string;
  provider: ModelProvider;
  method: ModelMethod;
  label: string;
  status: 'connected' | 'reconnect' | 'loading';
  models: ModelDefinition[];
  managed: boolean;
}

export function createModelService(options: {
  database: Pool;
  ownerId: string;
  keyStore: CredentialKeyStore;
  backend: ModelBackend;
  origin: string;
  local: boolean;
  bootstrap?: {
    provider: ModelProvider;
    model?: string;
    keys: Partial<Record<ModelProvider, string>>;
  };
  changed?(): void;
}) {
  const { database, ownerId, backend } = options;
  let vault: Awaited<ReturnType<typeof createAppGrantVault>>;
  let rows: Row[] = [];
  let selection: ModelSelection | null = null;
  let starting: Promise<unknown> = Promise.resolve();
  const pendingControllers = new Set<AbortController>();
  let closed = false;
  const secrets = new Set<string>();
  const observers = new Set<(values: string[]) => void>();
  const attempts = new Map<
    string,
    {
      provider: 'openai' | 'openrouter';
      state: string;
      controller: AbortController;
      complete?(callback: URL): void;
      connectionId?: string;
      secret: Record<string, unknown>;
      expires: number;
      timer: ReturnType<typeof setTimeout>;
      status: 'waiting' | 'completing' | 'connected' | 'failed';
      error?: string;
      completion?: Promise<void>;
    }
  >();
  async function cancel(state: string) {
    const attempt = attempts.get(state);
    if (!attempt) return;
    clearTimeout(attempt.timer);
    attempt.status = 'failed';
    attempt.controller.abort();
    await attempt.completion?.catch(() => {});
    if (attempts.get(state) === attempt) attempts.delete(state);
  }
  function active(attempt: NonNullable<ReturnType<typeof attempts.get>>) {
    if (
      closed ||
      attempt.controller.signal.aborted ||
      attempt.expires < Date.now() ||
      attempts.get(attempt.state) !== attempt
    )
      throw new ConnectionError('This sign-in request has expired. Start a new connection.');
  }
  function remember(value: ModelCredential) {
    const values = (value.type === 'api_key' ? [value.key] : [value.access, value.refresh]).filter(
      (secret) => !secrets.has(secret),
    );
    for (const secret of values) secrets.add(secret);
    if (values.length) for (const observer of observers) observer(values);
  }
  async function reload() {
    rows = (
      await database.query<Row>(
        'SELECT id,provider,method,label,status,models,managed FROM model_connections WHERE owner_id=$1 ORDER BY created_at,id',
        [ownerId],
      )
    ).rows;
    selection =
      (
        await database.query<{ selection: ModelSelection | null }>(
          'SELECT selection FROM model_settings WHERE owner_id=$1',
          [ownerId],
        )
      ).rows[0]?.selection ?? null;
    options.changed?.();
  }
  async function locked<T>(
    id: string,
    run: (client: PoolClient) => Promise<T>,
    signal?: AbortSignal,
  ) {
    const lock = createHash('sha256').update(`model:${ownerId}:${id}`).digest().readBigInt64BE();
    signal?.throwIfAborted();
    return transaction(async (client) => {
      await client.query('SELECT pg_advisory_xact_lock($1)', [lock.toString()]);
      const result = await run(client);
      signal?.throwIfAborted();
      return result;
    }, database);
  }
  async function credential(id: string, client: Pool | PoolClient = database) {
    const row = (
      await client.query<Row>(
        'SELECT provider,method,models,managed FROM model_connections WHERE id=$1 AND owner_id=$2',
        [id, ownerId],
      )
    ).rows[0];
    if (!row) return undefined;
    const key = row.managed ? options.bootstrap?.keys[row.provider] : undefined;
    const value = row.managed
      ? key
        ? { type: 'api_key' as const, key }
        : undefined
      : (JSON.parse((await vault.read(id, client)).value) as ModelCredential);
    if (!value) return undefined;
    if (
      value.type === 'oauth' &&
      (!value.accountId ||
        (row.method === 'subscription' &&
          row.models.some(
            (model) =>
              model.spec.api !== 'openai-codex-responses' ||
              model.spec.provider !== 'openai-codex' ||
              model.spec.baseUrl !== 'https://chatgpt.com/backend-api',
          )))
    )
      throw new ModelAuthError('Reconnect the selected ChatGPT account in Models.', true);
    remember(value);
    return value;
  }
  async function readLocked(id: string, client: PoolClient) {
    const row = (
      await client.query<Row>('SELECT status FROM model_connections WHERE id=$1 AND owner_id=$2', [
        id,
        ownerId,
      ])
    ).rows[0];
    if (!row) return {};
    if (row.status === 'reconnect')
      throw new ConnectionError('Reconnect the selected account in Models.');
    try {
      const current = await credential(id, client);
      if (current?.type !== 'oauth' || current.expires > Date.now() + 300000)
        return { value: current };
      const next = await backend.refresh(current);
      remember(next);
      await vault.put(id, JSON.stringify(next), client);
      return { value: next };
    } catch (error) {
      if (!(error instanceof ModelAuthError) || !error.requiresReconnect)
        throw new ConnectionError(
          error instanceof ModelAuthError
            ? error.message
            : 'The model service is temporarily unavailable. Try again.',
        );
      await client.query(
        "UPDATE model_connections SET status='reconnect' WHERE id=$1 AND owner_id=$2",
        [id, ownerId],
      );
      return { reconnect: true };
    }
  }
  async function read(id: string) {
    const result = await locked(id, (client) => readLocked(id, client));
    if (result.reconnect) {
      await reload();
      throw new ConnectionError('Reconnect the selected ChatGPT account in Models.');
    }
    return result.value;
  }
  async function catalog(provider: ModelProvider, method: ModelMethod, value?: ModelCredential) {
    try {
      return await backend.catalog(provider, method, value);
    } catch (error) {
      throw new ConnectionError(
        error instanceof ModelAuthError
          ? error.message
          : 'The model list could not be loaded. Try refreshing the connection.',
      );
    }
  }
  async function save(
    provider: ModelProvider,
    method: ModelMethod,
    value: ModelCredential,
    definitions: ModelDefinition[],
    id: string = randomUUID(),
    {
      managed = false,
      replace = false,
      status = 'connected',
      signal,
    }: { managed?: boolean; replace?: boolean; status?: Row['status']; signal?: AbortSignal } = {},
  ) {
    remember(value);
    if (!managed && !options.keyStore.configured)
      throw new ConnectionError(
        'Configure OTTO_VAULT_KEY in server settings before saving a connection.',
      );
    if (status === 'connected' && !definitions.length)
      throw new ConnectionError('This connection has no supported models.');
    await locked(
      id,
      async (client) => {
        const exists = (
          await client.query('SELECT id FROM model_connections WHERE id=$1 AND owner_id=$2', [
            id,
            ownerId,
          ])
        ).rows[0];
        if (replace && !exists)
          throw new ConnectionError('This model connection was removed. Start a new connection.');
        if (replace && value.type === 'oauth') {
          let previous: ModelCredential | undefined;
          try {
            previous = JSON.parse((await vault.read(id, client)).value) as ModelCredential;
          } catch {}
          if (
            previous?.type === 'oauth' &&
            previous.accountId &&
            previous.accountId !== value.accountId
          )
            throw new ConnectionError('Use Add connection for a different ChatGPT account.');
        }
        await client.query('SELECT owner_id FROM model_settings WHERE owner_id=$1 FOR UPDATE', [
          ownerId,
        ]);
        const count = (
          await client.query<{ count: number }>(
            'SELECT count(*)::int AS count FROM model_connections WHERE owner_id=$1',
            [ownerId],
          )
        ).rows[0].count;
        if (!exists && count >= 20)
          throw new ConnectionError('Remove an unused model connection before adding another.');
        if (!managed) await vault.put(id, JSON.stringify(value), client);
        const label =
          value.type === 'oauth'
            ? (value.email ?? 'ChatGPT account')
            : modelSource({ provider, method });
        await client.query(
          `INSERT INTO model_connections(id,owner_id,provider,method,label,models,managed,status) VALUES($1,$2,$3,$4,$5,$6,$7,$8)
        ON CONFLICT(id) DO UPDATE SET models=excluded.models,label=excluded.label,status=excluded.status WHERE model_connections.owner_id=excluded.owner_id`,
          [id, ownerId, provider, method, label, JSON.stringify(definitions), managed, status],
        );
        await selectDefault(client, provider, method, definitions, id, managed, status);
      },
      signal,
    );
    await reload();
    return id;
  }
  async function selectDefault(
    client: PoolClient,
    provider: ModelProvider,
    method: ModelMethod,
    definitions: ModelDefinition[],
    id: string,
    managed: boolean,
    status: Row['status'],
  ) {
    const preferredId =
      managed && options.bootstrap?.provider === provider
        ? (options.bootstrap.model ?? agentModels[provider])
        : agentModels[provider];
    const subscription = method === 'subscription';
    const preferred =
      (subscription && definitions.find((model) => model.choice.id === 'gpt-6-sol')) ||
      definitions.find((model) => model.choice.id === preferredId) ||
      (subscription ? definitions[0] : undefined);
    if (
      preferred &&
      status === 'connected' &&
      (!managed || options.bootstrap?.provider === provider)
    )
      await client.query(
        'UPDATE model_settings SET selection=$2,selection_set=true WHERE owner_id=$1 AND (NOT selection_set OR ($3 AND selection IS NULL))',
        [
          ownerId,
          JSON.stringify({
            connectionId: id,
            modelId: preferred.choice.id,
            effort: preferred.choice.efforts.includes('high')
              ? 'high'
              : preferred.choice.efforts[0],
          }),
          subscription,
        ],
      );
  }
  async function updateCatalog(id: string, signal?: AbortSignal) {
    await locked(
      id,
      async (client) => {
        const row = (
          await client.query<Row>(
            'SELECT provider,method,status,managed FROM model_connections WHERE id=$1 AND owner_id=$2',
            [id, ownerId],
          )
        ).rows[0];
        if (!row) throw new ConnectionError('This model connection is unavailable.');
        if (!row.managed && row.status === 'reconnect')
          throw new ConnectionError('Reconnect the selected account in Models.');
        const value = await credential(id, client);
        if (!value) throw new ConnectionError('This model connection is unavailable.');
        const definitions = await catalog(row.provider, row.method, value);
        if (!definitions.length)
          throw new ConnectionError('This connection has no supported models.');
        signal?.throwIfAborted();
        await client.query(
          "UPDATE model_connections SET models=$3,status='connected',label=COALESCE($4,label) WHERE id=$1 AND owner_id=$2",
          [id, ownerId, JSON.stringify(definitions), value.type === 'oauth' ? value.email : null],
        );
        await selectDefault(
          client,
          row.provider,
          row.method,
          definitions,
          id,
          row.managed,
          'connected',
        );
      },
      signal,
    );
    await reload();
  }
  async function refreshCatalog(id: string) {
    const row = rows.find((row) => row.id === id);
    if (!row) throw new ConnectionError('This model connection is unavailable.');
    if (!row.managed) await read(id);
    await updateCatalog(id);
  }
  function signInStatus(state: string) {
    const attempt = attempts.get(state);
    if (!attempt || closed || attempt.expires < Date.now())
      return { status: 'failed' as const, error: 'Sign-in expired. Start a new connection.' };
    return {
      status: attempt.status === 'completing' ? 'waiting' : attempt.status,
      ...(attempt.error ? { error: attempt.error } : {}),
    };
  }
  async function complete(callback: URL) {
    const state = callback.searchParams.get('state') ?? '';
    const attempt = attempts.get(state);
    if (!attempt || attempt.status !== 'waiting')
      throw new ConnectionError('This sign-in request has expired. Start a new connection.');
    active(attempt);
    attempt.status = 'completing';
    if (attempt.provider === 'openai') {
      try {
        attempt.complete!(callback);
      } catch (error) {
        await cancel(state);
        throw error;
      }
    } else {
      attempt.completion = finish(
        attempt,
        backend.exchange('openrouter', attempt.secret, callback),
      );
      attempt.completion.catch(() => {});
    }
    return attempt.completion;
  }
  async function finish(
    attempt: NonNullable<ReturnType<typeof attempts.get>>,
    result: Promise<ModelCredential>,
  ) {
    try {
      const value = await result;
      active(attempt);
      attempt.status = 'completing';
      const method = attempt.provider === 'openai' ? 'subscription' : 'oauth';
      const id = await save(attempt.provider, method, value, [], attempt.connectionId, {
        replace: !!attempt.connectionId,
        status: 'loading',
        signal: attempt.controller.signal,
      });
      attempt.connectionId = id;
      active(attempt);
      try {
        await updateCatalog(id, attempt.controller.signal);
      } catch (error) {
        active(attempt);
        attempt.error =
          error instanceof ConnectionError
            ? error.message
            : 'Account connected. Refresh the connection to load its models.';
      }
      active(attempt);
      attempt.status = 'connected';
    } catch (error) {
      attempt.status = 'failed';
      attempt.error =
        error instanceof ConnectionError || error instanceof ModelAuthError
          ? error.message
          : 'Sign-in failed. Start a new connection.';
      throw error;
    } finally {
      attempt.secret = {};
    }
  }
  async function completeCallback(callback: URL) {
    const attempt = attempts.get(callback.searchParams.get('state') ?? '');
    await (attempt?.completion &&
    attempt.status !== 'waiting' &&
    !closed &&
    attempt.expires >= Date.now()
      ? attempt.completion
      : complete(callback));
  }
  function start(provider: 'openai' | 'openrouter', connectionId?: string) {
    const result = starting.then(() => begin(provider, connectionId));
    starting = result.catch(() => {});
    return result;
  }
  async function begin(provider: 'openai' | 'openrouter', connectionId?: string) {
    if (closed) throw new ConnectionError('Model connections have stopped.');
    if (!options.keyStore.configured)
      throw new ConnectionError(
        'Configure OTTO_VAULT_KEY in server settings before saving a connection.',
      );
    if (provider === 'openai' && !options.local)
      throw new ConnectionError(
        'ChatGPT plan use is available in local Otto. Hosted use needs OpenAI access.',
      );
    await reload();
    const row = connectionId
      ? rows.find(
          (row) => row.id === connectionId && row.provider === provider && row.method !== 'api_key',
        )
      : undefined;
    if (connectionId && !row) throw new ConnectionError('This model connection is unavailable.');
    for (const [state, attempt] of attempts)
      if (
        attempt.expires < Date.now() ||
        (provider === 'openai' &&
          attempt.provider === provider &&
          (attempt.controller.signal.aborted || ['waiting', 'completing'].includes(attempt.status)))
      )
        await cancel(state);
    if (closed) throw new ConnectionError('Model connections have stopped.');
    const controller = new AbortController();
    pendingControllers.add(controller);
    let flow: Awaited<ReturnType<ModelBackend['signIn']>> | undefined;
    const timeout = setTimeout(() => controller.abort(), 15000);
    timeout.unref();
    try {
      const auth =
        provider === 'openai'
          ? await backend.signIn({ signal: controller.signal })
          : backend.authorize({
              provider,
              redirectUri: `${options.origin}/api/models/oauth/callback`,
            });
      flow = 'result' in auth ? auth : undefined;
      flow?.result.catch(() => {});
      controller.signal.throwIfAborted();
      const timer = setTimeout(() => {
        void cancel(auth.state);
      }, 600000);
      timer.unref();
      const attempt: NonNullable<ReturnType<typeof attempts.get>> = {
        provider,
        state: auth.state,
        controller,
        complete: flow?.complete,
        connectionId,
        secret: 'secret' in auth ? auth.secret : {},
        expires: Date.now() + 600000,
        timer,
        status: 'waiting',
      };
      attempts.set(auth.state, attempt);
      if (flow) {
        attempt.completion = finish(attempt, flow.result);
        attempt.completion.catch(() => {});
      }
      return { url: auth.url, attempt: auth.state };
    } catch (error) {
      controller.abort();
      await flow?.result.catch(() => {});
      throw error;
    } finally {
      clearTimeout(timeout);
      pendingControllers.delete(controller);
    }
  }
  const service = {
    get configured() {
      return (
        !!selection &&
        rows.some(
          (row) =>
            row.id === selection!.connectionId &&
            row.status === 'connected' &&
            row.models.some(
              (model) =>
                model.choice.id === selection!.modelId &&
                model.choice.efforts.includes(selection!.effort),
            ),
        )
      );
    },
    get current() {
      return {
        provider:
          rows.find((row) => row.id === selection?.connectionId)?.provider ?? 'unconfigured',
        name: selection?.modelId ?? 'Unconfigured',
        configured: service.configured,
      };
    },
    onSecrets(observer: (values: string[]) => void) {
      observers.add(observer);
      observer([...secrets]);
      return () => observers.delete(observer);
    },
    view(): ModelsResponse {
      return {
        connections: rows.map(({ id, provider, method, label, status, managed, models }) => ({
          id,
          provider,
          method,
          label,
          status,
          managed,
          models: models.map((model) => model.choice),
        })),
        selection,
        subscriptionAvailable: options.local,
      };
    },
    async initialize() {
      vault = await createAppGrantVault(database, { ownerId, keyStore: options.keyStore });
      await database.query(`CREATE TABLE IF NOT EXISTS model_connections (
        id uuid PRIMARY KEY,owner_id text NOT NULL,provider text NOT NULL,method text NOT NULL,label text NOT NULL,
        status text NOT NULL DEFAULT 'connected',models jsonb NOT NULL,managed boolean NOT NULL DEFAULT false,created_at timestamptz NOT NULL DEFAULT now()
      ); CREATE INDEX IF NOT EXISTS model_connections_owner ON model_connections(owner_id);
      CREATE TABLE IF NOT EXISTS model_settings(owner_id text PRIMARY KEY,selection jsonb,selection_set boolean NOT NULL DEFAULT false);
      ALTER TABLE model_settings DROP COLUMN IF EXISTS host_id;`);
      await database.query(
        'INSERT INTO model_settings(owner_id) VALUES($1) ON CONFLICT DO NOTHING',
        [ownerId],
      );
      await reload();
      for (const row of rows) {
        try {
          if (!(await credential(row.id)))
            await database.query(
              "UPDATE model_connections SET status='reconnect' WHERE id=$1 AND owner_id=$2",
              [row.id, ownerId],
            );
        } catch {
          await database.query(
            "UPDATE model_connections SET status='reconnect' WHERE id=$1 AND owner_id=$2",
            [row.id, ownerId],
          );
        }
      }
      await reload();
      const sources = Object.entries(options.bootstrap?.keys ?? {}).sort(
        ([a], [b]) =>
          Number(b === options.bootstrap?.provider) - Number(a === options.bootstrap?.provider),
      );
      for (const [provider, key] of sources) {
        if (!key) continue;
        const existing = rows.find((row) => row.provider === provider && row.managed);
        const value = { type: 'api_key' as const, key };
        let definitions: ModelDefinition[] | undefined;
        try {
          definitions = await catalog(provider as ModelProvider, 'api_key', value);
        } catch {}
        const connected = !!definitions?.length;
        await save(
          provider as ModelProvider,
          'api_key',
          value,
          connected ? definitions! : (existing?.models ?? []),
          existing?.id,
          { managed: true, status: connected ? 'connected' : 'reconnect' },
        );
      }
    },
    async addKey(provider: ModelProvider, key: string) {
      if (!options.keyStore.configured)
        throw new ConnectionError(
          'Configure OTTO_VAULT_KEY in server settings before saving a connection.',
        );
      const value: ModelCredential = { type: 'api_key', key };
      remember(value);
      return save(provider, 'api_key', value, await catalog(provider, 'api_key', value));
    },
    async select(input: ModelSelection) {
      const value = selectionSchema.parse(input);
      await locked(value.connectionId, async (client) => {
        const row = (
          await client.query<Row>(
            'SELECT status,models FROM model_connections WHERE id=$1 AND owner_id=$2',
            [value.connectionId, ownerId],
          )
        ).rows[0];
        const model =
          row?.status === 'connected' &&
          row.models.find((model) => model.choice.id === value.modelId);
        if (!model || !model.choice.efforts.includes(value.effort))
          throw new ConnectionError('Choose an available model and effort.');
        await client.query(
          'UPDATE model_settings SET selection=$2,selection_set=true WHERE owner_id=$1',
          [ownerId, JSON.stringify(value)],
        );
      });
      await reload();
    },
    async remove(id: string) {
      for (const [state, attempt] of attempts) if (attempt.connectionId === id) await cancel(state);
      await locked(id, async (client) => {
        const row = (
          await client.query<Row>(
            'SELECT managed FROM model_connections WHERE id=$1 AND owner_id=$2',
            [id, ownerId],
          )
        ).rows[0];
        if (row?.managed)
          throw new ConnectionError('This connection is managed in server settings.');
        await client.query('DELETE FROM model_connections WHERE id=$1 AND owner_id=$2', [
          id,
          ownerId,
        ]);
        await vault.remove(id, client);
        await client.query(
          "UPDATE model_settings SET selection=NULL WHERE owner_id=$1 AND selection->>'connectionId'=$2",
          [ownerId, id],
        );
      });
      await reload();
    },
    refreshCatalog,
    async resolve(auxiliary = false): Promise<ModelAccess> {
      const selected = selection && { ...selection };
      const row = rows.find(
        (row) => row.id === selected?.connectionId && row.status === 'connected',
      );
      if (!row || !selected)
        throw new ConnectionError('Connect a model service and choose a model in Models.');
      const definition =
        (auxiliary
          ? row.models.find((model) => model.choice.id === memoryModels[row.provider])
          : undefined) ?? row.models.find((model) => model.choice.id === selected.modelId);
      if (!definition || (!definition.choice.efforts.includes(selected.effort) && !auxiliary))
        throw new ConnectionError('The selected model is unavailable. Choose another model.');
      return {
        provider: row.provider,
        method: row.method,
        definition,
        effort: auxiliary
          ? (definition.choice.efforts.find((level) => ['off', 'low', 'medium'].includes(level)) ??
            definition.choice.efforts[0])
          : selected.effort,
        read: () => read(row.id),
      };
    },
    start,
    cancel,
    complete,
    signInStatus,
    register(app: FastifyInstance) {
      void app.register(async (routes) => {
        routes.setErrorHandler((error, _request, reply) =>
          reply.code(400).send({
            error:
              error instanceof ConnectionError || error instanceof ModelAuthError
                ? error.message
                : 'The model connection request failed. Check the service and try again.',
          }),
        );
        routes.get('/api/models', async () => service.view());
        routes.post('/api/models/keys', async (request) => {
          const input = z
            .object({ provider: providerSchema, key: z.string().trim().min(8).max(32000) })
            .strict()
            .parse(request.body);
          await service.addKey(input.provider, input.key);
          return service.view();
        });
        routes.put('/api/models/selection', async (request) => {
          await service.select(selectionSchema.parse(request.body));
          return service.view();
        });
        routes.delete<{ Params: { id: string } }>(
          '/api/models/connections/:id',
          async (request) => {
            await service.remove(z.uuid().parse(request.params.id));
            return service.view();
          },
        );
        routes.post<{ Params: { id: string } }>(
          '/api/models/connections/:id/refresh',
          async (request) => {
            await service.refreshCatalog(z.uuid().parse(request.params.id));
            return service.view();
          },
        );
        routes.post('/api/models/oauth', async (request) => {
          const input = z
            .object({
              provider: z.enum(['openai', 'openrouter']),
              connectionId: z.uuid().optional(),
            })
            .strict()
            .parse(request.body);
          return start(input.provider, input.connectionId);
        });
        routes.get<{ Params: { attempt: string } }>(
          '/api/models/oauth/status/:attempt',
          async (request, reply) => {
            reply.header('Cache-Control', 'no-store');
            return signInStatus(
              z
                .string()
                .regex(/^[A-Za-z0-9_-]{32,128}$/)
                .parse(request.params.attempt),
            );
          },
        );
        routes.delete<{ Params: { attempt: string } }>(
          '/api/models/oauth/:attempt',
          async (request) => {
            await cancel(
              z
                .string()
                .regex(/^[A-Za-z0-9_-]{32,128}$/)
                .parse(request.params.attempt),
            );
            return service.view();
          },
        );
        routes.post('/api/models/oauth/complete', async (request) => {
          const input = z
            .object({ url: z.url().max(64000) })
            .strict()
            .parse(request.body);
          await complete(new URL(input.url));
          return service.view();
        });
        routes.get('/api/models/oauth/callback', async (request, reply) => {
          let succeeded = false;
          try {
            await completeCallback(new URL(request.url, options.origin));
            succeeded = true;
          } catch {}
          const page = signInPage(succeeded, randomUUID());
          return reply
            .code(succeeded ? 200 : 400)
            .headers(page.headers)
            .send(page.html);
        });
      });
    },
    async close() {
      closed = true;
      for (const controller of pendingControllers) controller.abort();
      await starting;
      await Promise.all([...attempts.keys()].map(cancel));
      observers.clear();
      secrets.clear();
    },
  };
  return service;
}
