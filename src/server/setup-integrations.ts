import { createHash, randomBytes, randomUUID } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import type { PoolClient } from 'pg';
import { z } from 'zod';
import {
  IntegrationAuthConfigurationError,
  IntegrationCatalogAccessDenied,
  IntegrationConnectionError,
  type IntegrationProvider,
  type IntegrationServiceInfo,
} from '../ports/integrations.ts';
import type { SetupJournal } from '../ports/setup.ts';
import type { AppSetupStatus, Connection } from '../shared/contracts.ts';
import { integrationServices, type IntegrationKeyStatus } from '../shared/integrations.ts';
import type { createIntegrationAccess } from './integration-access.ts';
import { IntegrationError, verifyIntegrationCompletion } from './integration-connection.ts';

const token = z.string().regex(/^[A-Za-z0-9_-]{43}$/);
const digest = z.string().regex(/^[a-f0-9]{64}$/);
const slug = z.string().regex(/^[a-z][a-z0-9_]{0,79}$/);
const account = z.string().min(1).max(200);
const key = z.string().trim().min(8).max(16384);
const hash = (value: string) => createHash('sha256').update(value).digest('hex');
const serviceSchema = z.object({
  slug,
  name: z.string().min(1).max(200),
  description: z.string().max(2000),
  logoUrl: z
    .url({ protocol: /^https$/ })
    .max(2048)
    .optional(),
  categories: z.array(z.string().max(80)).max(12).optional(),
});
const connectionSchema = z.object({
  id: z.uuid(),
  slug,
  providerId: z.string().regex(/^[a-z][a-z0-9-]{0,39}$/),
  configurationId: digest,
  state: z.enum(['starting', 'pending', 'claimed', 'connected', 'cancelled', 'uncertain']),
  callbackHash: digest,
  expiresAt: z.number().int().positive(),
  pendingAccountId: account.optional(),
  verificationSecret: z.string().max(16384).optional(),
  linkHash: digest.optional(),
  accountId: account.optional(),
  accountName: z.string().max(200).optional(),
  accountEmail: z.string().max(320).optional(),
});
const stateSchema = z.object({
  ownerId: z.string().min(1).max(200),
  mode: z.enum(['otto', 'own']),
  apiKey: key.optional(),
  keyId: z.uuid().optional(),
  sealed: z.boolean(),
  connections: z.array(connectionSchema).max(100),
});
type State = z.infer<typeof stateSchema>;
type Pending = z.infer<typeof connectionSchema>;
const transferSchema = z.object({
  ownerId: z.string().min(1).max(200),
  mode: z.enum(['otto', 'own']),
  apiKey: key.optional(),
  keyId: z.uuid().optional(),
  providerId: z.string().regex(/^[a-z][a-z0-9-]{0,39}$/),
  configurationId: digest.optional(),
  connections: z
    .array(
      connectionSchema.extend({
        state: z.literal('connected'),
        accountId: account,
        linkHash: digest,
      }),
    )
    .max(100),
});
export type SetupIntegrationTransfer = z.infer<typeof transferSchema>;

export async function createSetupIntegrations(options: {
  journal: SetupJournal;
  ownerId: string;
  baseUrl: string;
  access: ReturnType<typeof createIntegrationAccess>;
  managedProvider: IntegrationProvider;
  ownProvider: IntegrationProvider;
  changed?: () => void;
  secret?: (value: string) => void;
}) {
  const section = 'integrations';
  let closed = false;
  let operations = 0;
  let accessRequests = 0;
  let tail: Promise<unknown> = Promise.resolve();
  let services = new Map<string, IntegrationServiceInfo>();
  const secrets = new Set<string>();
  const secretListeners = new Set<(values: string[]) => void>();
  function secret(value: string) {
    secrets.add(value);
    options.secret?.(value);
    for (const listener of secretListeners) listener([value]);
  }
  const initial = (): State => ({
    ownerId: options.ownerId,
    mode: 'otto',
    sealed: false,
    connections: [],
  });
  function checked(value: unknown) {
    const state = stateSchema.parse(value ?? initial());
    if (
      state.ownerId !== options.ownerId ||
      (state.mode === 'own' && (!state.apiKey || !state.keyId))
    )
      throw new IntegrationError('This setup belongs to a different profile.', 409);
    return state;
  }
  const read = async () => checked(await options.journal.read<State>(section));
  const update = async (change: (state: State) => State) => {
    const result = await options.journal.update<State>(section, (value) => change(checked(value)));
    options.changed?.();
    return result;
  };
  const restored = await read();
  options.ownProvider.setApiKey?.(restored.apiKey);
  if (restored.apiKey) secret(restored.apiKey);
  await update((value) => ({
    ...value,
    connections: value.connections.map((row) =>
      ['starting', 'pending', 'claimed'].includes(row.state)
        ? { ...row, state: 'uncertain', verificationSecret: undefined }
        : row,
    ),
  }));
  function serialize<T>(operation: () => Promise<T>): Promise<T> {
    operations++;
    const result = tail.then(async () => {
      if (closed) throw new IntegrationError('Setup is closed.', 409);
      return operation();
    });
    tail = result.catch(() => {});
    return result.finally(() => {
      operations--;
    });
  }
  const providerFor = (state: Pick<State, 'mode'>) =>
    state.mode === 'own' ? options.ownProvider : options.managedProvider;
  function writable(state: State) {
    if (state.sealed) throw new IntegrationError('Otto is finishing setup.', 409);
  }
  const pending = (row: Pending) =>
    ['starting', 'pending', 'claimed'].includes(row.state) && row.expiresAt > Date.now();
  async function keyStatus(): Promise<IntegrationKeyStatus> {
    const state = await read();
    return {
      mode: state.mode,
      switchable: !state.sealed,
      keyWritable: !state.sealed,
      suffix: state.apiKey?.slice(-4) ?? null,
      managed:
        state.mode === 'own'
          ? options.access.observedStatus()
          : await options.access
              .status()
              .catch(() => ({ state: 'unavailable' as const, email: null })),
    };
  }
  async function catalog() {
    const state = await read();
    const provider = providerFor(state);
    const configurationId = provider.configurationId;
    const entries = provider.listServices
      ? z
          .array(serviceSchema)
          .max(5000)
          .parse(await provider.listServices())
      : (provider.supportedServices ?? []).map((name) => ({
          slug: name,
          ...(integrationServices[name] ?? { name, description: '' }),
        }));
    if (providerFor(await read()) !== provider || configurationId !== provider.configurationId)
      throw new IntegrationError('Your connection setup changed. Try again.', 409);
    services = new Map(entries.map((entry) => [entry.slug, entry]));
    return entries.map((entry): Connection => ({
      ...entry,
      status: 'disconnected',
      triggersEnabled: false,
      supportsTriggers: false,
    }));
  }
  const info = (name: string) =>
    services.get(name) ?? {
      slug: name,
      ...(integrationServices[name] ?? { name: name.replaceAll('_', ' '), description: '' }),
    };
  async function list(): Promise<Connection[]> {
    const state = await read();
    const provider = providerFor(state);
    const rows = state.connections.filter(
      (row) =>
        row.state === 'connected' &&
        row.providerId === provider.id &&
        row.configurationId === provider.configurationId,
    );
    const names = new Set([...Object.keys(integrationServices), ...rows.map((row) => row.slug)]);
    return [...names].flatMap((name) => {
      const accounts = rows.filter((row) => row.slug === name);
      return (accounts.length ? accounts : [undefined]).map((row): Connection => ({
        ...info(name),
        status: row ? 'connected' : provider.configured ? 'disconnected' : 'not_configured',
        ...(row
          ? {
              connectionId: row.id,
              accountId: row.accountId,
              accountName: row.accountName,
              accountEmail: row.accountEmail,
            }
          : {}),
        triggersEnabled: false,
        supportsTriggers: false,
      }));
    });
  }
  async function changeKey(value?: string) {
    return serialize(async () => {
      const state = await read();
      writable(state);
      if (options.access.active() || state.connections.some(pending))
        throw new IntegrationError('Finish or cancel the current sign-in first.', 409);
      if (value !== undefined) {
        if (!options.ownProvider.verifyApiKey || !(await options.ownProvider.verifyApiKey(value)))
          throw new IntegrationError(
            'That key didn’t work. Copy it again from Composio and paste it here.',
          );
      } else if ((await options.access.status()).state !== 'enabled')
        throw new IntegrationError(
          'Sign in with an approved Google account before switching to Easy Connect.',
        );
      if (state.apiKey === value && state.mode === (value ? 'own' : 'otto')) return keyStatus();
      const provider = providerFor(state);
      for (const row of state.connections.filter((row) => row.state === 'connected')) {
        await update((current) => ({
          ...current,
          connections: current.connections.map((entry) =>
            entry.id === row.id ? { ...entry, state: 'uncertain' } : entry,
          ),
        }));
        await provider.deleteAccount(row.accountId!, options.ownerId);
      }
      await update((current) => ({
        ...current,
        mode: value ? 'own' : 'otto',
        apiKey: value,
        keyId: value ? randomUUID() : undefined,
        connections: [],
      }));
      options.ownProvider.setApiKey?.(value);
      if (value) secret(value);
      services.clear();
      return keyStatus();
    });
  }
  async function connect(service: string) {
    return serialize(async () => {
      const state = await read();
      writable(state);
      const provider = providerFor(state);
      if (state.mode === 'otto' && (await options.access.status()).state !== 'enabled')
        throw new IntegrationError('Sign in with Google before connecting an app.', 403);
      if (!provider.configured) throw new IntegrationError('Add your Composio key first.', 409);
      if (
        !provider.supportedServices?.includes(service) &&
        !(await catalog()).some((entry) => entry.slug === service)
      )
        throw new IntegrationError('This app is unavailable with the configured provider.', 503);
      if (state.connections.some(pending))
        throw new IntegrationError('Finish or cancel the current app sign-in first.', 409);
      if (
        state.connections.filter((row) => row.slug === service && row.state === 'connected')
          .length >= 10
      )
        throw new IntegrationError('This service supports up to ten connected accounts.', 409);
      const configurationId = digest.parse(provider.configurationId);
      const nonce = randomBytes(32).toString('base64url');
      const callback = new URL('/api/apps/callback', options.baseUrl);
      callback.searchParams.set('state', nonce);
      const row: Pending = {
        id: randomUUID(),
        slug: service,
        providerId: provider.id,
        configurationId,
        state: 'starting',
        callbackHash: hash(nonce),
        expiresAt: Date.now() + 600_000,
      };
      await update((current) => ({
        ...current,
        connections: [...current.connections.filter((entry) => entry.state === 'connected'), row],
      }));
      let sessionId: string | undefined;
      try {
        const session = provider.authorize
          ? undefined
          : await provider.createSession(options.ownerId, {});
        sessionId = session?.id;
        const result = provider.authorize
          ? await provider.authorize(options.ownerId, service, callback.href)
          : await session!.authorize(service, callback.href);
        const destination = new URL(result.url);
        if (
          destination.protocol !== 'https:' ||
          destination.username ||
          destination.password ||
          provider.configurationId !== configurationId
        )
          throw new IntegrationError(
            'The connection provider returned an invalid sign-in link.',
            502,
          );
        await update((current) => ({
          ...current,
          connections: current.connections.map((entry) =>
            entry.id === row.id
              ? {
                  ...entry,
                  state: 'pending',
                  pendingAccountId: account.parse(result.accountId),
                  linkHash: hash(result.url),
                  verificationSecret: result.verificationSecret,
                }
              : entry,
          ),
        }));
        return { url: result.url, attempt: nonce };
      } catch (error) {
        await update((current) => ({
          ...current,
          connections: current.connections.map((entry) =>
            entry.id === row.id ? { ...entry, state: 'uncertain' } : entry,
          ),
        }));
        throw error;
      } finally {
        if (sessionId) await provider.deleteSession(sessionId).catch(() => {});
      }
    });
  }
  async function callback(query: unknown) {
    return serialize(async () => {
      const input = z.object({ state: token }).parse(query);
      const state = await read();
      writable(state);
      const row = state.connections.find((entry) => entry.callbackHash === hash(input.state));
      let outcome = 'expired';
      if (row?.state === 'pending' && pending(row)) {
        const provider = providerFor(state);
        if (row.providerId !== provider.id || row.configurationId !== provider.configurationId)
          throw new IntegrationError('Your connection setup changed. Start sign-in again.', 409);
        await update((current) => ({
          ...current,
          connections: current.connections.map((entry) =>
            entry.id === row.id ? { ...entry, state: 'claimed' } : entry,
          ),
        }));
        try {
          const parsed = await provider.parseCallback(query, {
            accountId: row.pendingAccountId!,
            verificationSecret: row.verificationSecret,
            service: row.slug,
          });
          if (!parsed.success) {
            outcome = 'cancelled';
            await update((current) => ({
              ...current,
              connections: current.connections.map((entry) =>
                entry.id === row.id
                  ? { ...entry, state: 'cancelled', verificationSecret: undefined }
                  : entry,
              ),
            }));
          } else {
            const result = await verifyIntegrationCompletion({
              parsed,
              provider,
              ownerId: options.ownerId,
              pending: {
                service: row.slug,
                callbackHash: row.callbackHash,
                accountId: row.pendingAccountId!,
                claimed: true,
                configurationId: row.configurationId,
                verifyOwner: true,
              },
            });
            await update((current) => ({
              ...current,
              connections: current.connections
                .filter(
                  (entry) => entry.id === row.id || entry.accountId !== result.query.accountId,
                )
                .map((entry) =>
                  entry.id === row.id
                    ? {
                        ...entry,
                        state: 'connected',
                        accountId: result.query.accountId,
                        accountName: result.remote.accountName,
                        accountEmail: result.remote.accountEmail,
                        verificationSecret: undefined,
                      }
                    : entry,
                ),
            }));
            outcome = 'connected';
          }
        } catch {
          outcome = 'failed';
          await update((current) => ({
            ...current,
            connections: current.connections.map((entry) =>
              entry.id === row.id
                ? { ...entry, state: 'uncertain', verificationSecret: undefined }
                : entry,
            ),
          }));
        }
      }
      const target = new URL('/connected.html', options.baseUrl);
      target.searchParams.set('connection', outcome);
      target.searchParams.set('attempt', input.state);
      if (row) target.searchParams.set('service', row.slug);
      return target.href;
    });
  }
  async function setupStatus(raw: unknown): Promise<AppSetupStatus> {
    const input = z
      .object({
        hashes: z.array(digest).min(1).max(100),
        connectionIds: z.array(z.uuid()).max(100).default([]),
        pairingUrl: z.url().max(16_000).optional(),
      })
      .strict()
      .parse(raw);
    const state = await read();
    const provider = providerFor(state);
    const rows = state.connections.filter(
      (row) =>
        row.linkHash &&
        input.hashes.includes(row.linkHash) &&
        row.providerId === provider.id &&
        row.configurationId === provider.configurationId,
    );
    const apps = await Promise.all(
      rows.filter(pending).map(async (row) => {
        const progress =
          input.pairingUrl && hash(input.pairingUrl) === row.linkHash
            ? await provider
                .connectionStatus?.(options.ownerId, input.pairingUrl)
                .catch(() => undefined)
            : undefined;
        return { hash: row.linkHash!, slug: row.slug, name: info(row.slug).name, ...progress };
      }),
    );
    return {
      completed: rows.filter((row) => row.state === 'connected').map((row) => row.linkHash!),
      apps,
    };
  }
  async function cancelPending() {
    return serialize(async () => {
      const state = await read();
      writable(state);
      await update((current) => ({
        ...current,
        connections: current.connections.map((row) =>
          row.state === 'pending'
            ? { ...row, state: 'cancelled', verificationSecret: undefined }
            : row,
        ),
      }));
      return { cancelled: true };
    });
  }
  async function disconnect(service: string, id: string) {
    return serialize(async () => {
      const state = await read();
      writable(state);
      const row = state.connections.find(
        (entry) => entry.id === id && entry.slug === service && entry.state === 'connected',
      );
      if (!row) throw new IntegrationError('This account is unavailable.', 404);
      const provider = providerFor(state);
      if (row.providerId !== provider.id || row.configurationId !== provider.configurationId)
        throw new IntegrationError('Your connection setup changed.', 409);
      await update((current) => ({
        ...current,
        connections: current.connections.map((entry) =>
          entry.id === id ? { ...entry, state: 'uncertain' } : entry,
        ),
      }));
      await provider.deleteAccount(row.accountId!, options.ownerId);
      await update((current) => ({
        ...current,
        connections: current.connections.filter((entry) => entry.id !== id),
      }));
      return { disconnected: true };
    });
  }
  return {
    onSecrets(listener: (values: string[]) => void) {
      secretListeners.add(listener);
      listener([...secrets]);
    },
    list,
    catalog,
    keyStatus,
    cancelPending,
    async busy() {
      return (
        operations > 0 ||
        accessRequests > 0 ||
        options.access.active() ||
        (await read()).connections.some(pending)
      );
    },
    async transfer(): Promise<SetupIntegrationTransfer> {
      return serialize(async () => {
        const state = await read();
        if (accessRequests > 0 || options.access.active() || state.connections.some(pending))
          throw new IntegrationError('Finish or cancel sign-in before continuing.', 409);
        const saved = await update((current) => ({ ...current, sealed: true }));
        const provider = providerFor(saved);
        return transferSchema.parse({
          ownerId: options.ownerId,
          mode: saved.mode,
          apiKey: saved.apiKey,
          keyId: saved.keyId,
          providerId: provider.id,
          configurationId: provider.configurationId,
          connections: saved.connections.filter((row) => row.state === 'connected'),
        });
      });
    },
    async close() {
      closed = true;
      await tail;
      await options.access.close();
    },
    register(app: FastifyInstance) {
      const accessWrites = new WeakSet<object>();
      app.addHook('onRequest', async (request, reply) => {
        if (!request.url.startsWith('/api/integrations/access') || request.method === 'GET') return;
        accessWrites.add(request);
        accessRequests++;
        if ((await read()).sealed)
          return reply.code(409).send({ error: 'Otto is finishing setup.' });
      });
      app.addHook('onResponse', async (request) => {
        if (accessWrites.delete(request)) accessRequests--;
      });
      options.access.register(app);
      app.register(async (routes) => {
        routes.setErrorHandler((error, _request, reply) => {
          const expected =
            error instanceof IntegrationError ||
            error instanceof IntegrationConnectionError ||
            error instanceof IntegrationAuthConfigurationError ||
            error instanceof IntegrationCatalogAccessDenied;
          return reply
            .code(
              error instanceof IntegrationError || error instanceof IntegrationConnectionError
                ? error.statusCode
                : error instanceof z.ZodError
                  ? 400
                  : 502,
            )
            .send({
              error: expected
                ? error.message
                : 'The connection provider could not complete this request.',
            });
        });
        routes.get('/api/integrations/key', keyStatus);
        routes.put('/api/integrations/key', async (request) =>
          changeKey(z.object({ key }).strict().parse(request.body).key),
        );
        routes.delete('/api/integrations/key', async () => changeKey());
        routes.get('/api/apps', list);
        routes.get('/api/apps/catalog', catalog);
        routes.post('/api/apps/setup-status', async (request) => setupStatus(request.body));
        routes.post('/api/apps/cancel', cancelPending);
        routes.post<{ Params: { slug: string } }>('/api/apps/:slug/connect', async (request) => {
          const input = z
            .object({
              returnTo: z.enum(['apps', 'onboarding', 'window']).default('window'),
              connectionId: z.uuid().optional(),
            })
            .strict()
            .parse(request.body ?? {});
          if (input.connectionId)
            throw new IntegrationError('Disconnect this account before connecting again.', 409);
          return connect(slug.parse(request.params.slug));
        });
        routes.get('/api/apps/callback', async (request, reply) =>
          reply
            .header('Cache-Control', 'no-store')
            .header('Referrer-Policy', 'no-referrer')
            .redirect(await callback(request.query)),
        );
        routes.post<{ Params: { slug: string; connectionId: string } }>(
          '/api/apps/:slug/accounts/:connectionId/disconnect',
          async (request) =>
            disconnect(
              slug.parse(request.params.slug),
              z.uuid().parse(request.params.connectionId),
            ),
        );
      });
    },
  };
}

type ImportOptions = {
  ownerId: string;
  managedProvider: IntegrationProvider;
  ownProvider: IntegrationProvider;
};

function checkedTransfer(input: unknown, options: ImportOptions) {
  const value = transferSchema.parse(input);
  if (
    value.ownerId !== options.ownerId ||
    (value.mode === 'own' && (!value.apiKey || !value.keyId)) ||
    (value.mode === 'otto' && (value.apiKey || value.keyId))
  )
    throw new IntegrationError('This setup belongs to a different profile.', 409);
  const provider = value.mode === 'own' ? options.ownProvider : options.managedProvider;
  if (provider.id !== value.providerId || provider.configurationId !== value.configurationId)
    throw new IntegrationError('The connection provider changed during setup.', 409);
  for (const row of value.connections)
    if (row.providerId !== provider.id || row.configurationId !== provider.configurationId)
      throw new IntegrationError('This app belongs to a different connection setup.', 409);
  return { value, provider };
}

export async function validateSetupIntegrations(input: unknown, options: ImportOptions) {
  const parsed = transferSchema.parse(input);
  if (parsed.ownerId !== options.ownerId)
    throw new IntegrationError('This setup belongs to a different profile.', 409);
  if (parsed.mode === 'own') options.ownProvider.setApiKey?.(parsed.apiKey);
  const { value, provider } = checkedTransfer(parsed, options);
  const connections = [];
  for (const row of value.connections) {
    const remote = await provider.inspectAccount(row.accountId, options.ownerId, {
      verifyOwner: true,
    });
    checkedTransfer(value, options);
    if (!remote.active || remote.service !== row.slug)
      throw new IntegrationError('This app connection is no longer available.', 409);
    connections.push({
      ...row,
      accountName: remote.accountName ?? row.accountName,
      accountEmail: remote.accountEmail ?? row.accountEmail,
    });
  }
  return transferSchema.parse({ ...value, connections });
}

export async function importSetupIntegrations(
  client: PoolClient,
  input: unknown,
  options: ImportOptions & { putKey(id: string, key: string, client: PoolClient): Promise<void> },
) {
  const { value, provider } = checkedTransfer(input, options);
  const savedKey = (
    await client.query<{ vault_id: string }>(
      'SELECT vault_id FROM integration_keys WHERE owner_id=$1 FOR UPDATE',
      [options.ownerId],
    )
  ).rows[0];
  if (savedKey && savedKey.vault_id !== value.keyId)
    throw new IntegrationError('This profile already has a different Composio key.', 409);
  for (const row of value.connections) {
    const existing = (
      await client.query<{
        id: string;
        owner_id: string;
        account_id: string;
        provider_id: string;
        configuration_id: string;
        slug: string;
        revoked: boolean;
      }>(
        'SELECT id,owner_id,account_id,provider_id,configuration_id,slug,revoked FROM app_connections WHERE id=$1 OR (owner_id=$2 AND provider_id=$3 AND account_id=$4) FOR UPDATE',
        [row.id, options.ownerId, provider.id, row.accountId],
      )
    ).rows;
    if (
      existing.some(
        (entry) =>
          entry.id !== row.id ||
          entry.owner_id !== options.ownerId ||
          entry.account_id !== row.accountId ||
          entry.provider_id !== provider.id ||
          entry.configuration_id !== provider.configurationId ||
          entry.slug !== row.slug ||
          entry.revoked,
      )
    )
      throw new IntegrationError('This app connection changed before setup finished.', 409);
    await client.query(
      `INSERT INTO app_connections
      (id,owner_id,slug,account_id,provider_id,configuration_id,account_name,account_email,account_active,account_checked_at,watch_requested)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,true,now(),false) ON CONFLICT(id) DO NOTHING`,
      [
        row.id,
        options.ownerId,
        row.slug,
        row.accountId,
        provider.id,
        provider.configurationId,
        row.accountName ?? null,
        row.accountEmail ?? null,
      ],
    );
    await client.query(
      'INSERT INTO app_setup_completions(owner_id,link_hash) VALUES($1,$2) ON CONFLICT DO NOTHING',
      [options.ownerId, row.linkHash],
    );
  }
  if (value.apiKey && value.keyId && !savedKey) {
    await options.putKey(value.keyId, value.apiKey, client);
    await client.query('INSERT INTO integration_keys(owner_id,vault_id) VALUES($1,$2)', [
      options.ownerId,
      value.keyId,
    ]);
  }
}
