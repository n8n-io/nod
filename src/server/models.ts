import { randomUUID } from 'node:crypto';
import type { Pool } from 'pg';
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
import {
  azureDeploymentPattern,
  bedrockRegionPattern,
  lightestEffort,
  modelSource,
} from '../shared/models.ts';
import { signInPage } from '../shared/sign-in-page.ts';
import { agentModels, memoryModels } from '../shared/model-defaults.ts';
import { createDatabaseModelStore, type ModelRecord, type ModelState } from './model-store.ts';
import { analyticsModel, type CaptureAnalytics } from './analytics.ts';
import { logFailure } from './failure-log.ts';

const keySchema = z
  .object({
    provider: z.enum([
      'openai',
      'anthropic',
      'openrouter',
      'amazon-bedrock',
      'google-vertex',
      'azure',
    ]),
    key: z.string().trim().min(8).max(32000),
    region: z.string().trim().max(100).optional(),
    url: z.string().trim().max(2000).optional(),
    model: z.string().trim().max(200).optional(),
    deployment: z.string().trim().max(200).optional(),
  })
  .strict();
export const modelSelectionInput = z
  .object({
    connectionId: z.uuid(),
    modelId: z.string().min(1).max(200),
    effort: z.enum(['off', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max']),
  })
  .strict();
class ConnectionError extends Error {}

export function endpointAddress(address: string) {
  let url: URL;
  try {
    url = new URL(
      /^[a-z][a-z\d+.-]*:/i.test(address) && !/^[^/:]+:\d+(\/|$)/.test(address)
        ? address
        : `http://${address}`,
    );
  } catch {
    return undefined;
  }
  if (
    !['http:', 'https:'].includes(url.protocol) ||
    url.username ||
    url.password ||
    /[?#]/.test(url.href)
  )
    return undefined;
  return url.href.replace(/\/+$/, '');
}

export function azureAddress(address: string) {
  const value = address.trim();
  const url = endpointAddress(/^[a-z][a-z\d+.-]*:\/\//i.test(value) ? value : `https://${value}`);
  if (!url) return undefined;
  const { protocol, hostname, origin, pathname } = new URL(url);
  if (protocol !== 'https:' && !['localhost', '127.0.0.1', '[::1]'].includes(hostname))
    return undefined;
  return pathname === '/' || pathname === '/openai' ? `${origin}/openai/v1` : url;
}

function keyCredential(
  provider: ModelProvider,
  key: string,
  settings: { region?: string; url?: string; model?: string; deployment?: string },
): ModelCredential {
  if (provider === 'amazon-bedrock') {
    if (!settings.region || !bedrockRegionPattern.test(settings.region))
      throw new ConnectionError('Enter an AWS Region, such as us-east-1.');
    return { type: 'bedrock', key, region: settings.region };
  }
  if (provider !== 'azure') return { type: 'api_key', key };
  const url = settings.url && azureAddress(settings.url);
  if (!url)
    throw new ConnectionError(
      'Enter your Azure OpenAI endpoint, such as https://your-resource.openai.azure.com.',
    );
  const deployment = settings.deployment || settings.model;
  if (!settings.model || !deployment || !azureDeploymentPattern.test(deployment))
    throw new ConnectionError('Choose the model and enter its deployment name.');
  return { type: 'azure', url, key, model: settings.model, deployment };
}

function sameAccount(
  row: ModelRecord,
  provider: ModelProvider,
  method: ModelMethod,
  value: ModelCredential,
) {
  if (row.managed || row.provider !== provider || row.method !== method) return false;
  const saved = row.credential;
  if (value.type === 'oauth') return saved?.type === 'oauth' && saved.accountId === value.accountId;
  if (value.type === 'endpoint') return saved?.type === 'endpoint' && saved.url === value.url;
  return JSON.stringify(saved) === JSON.stringify(value);
}

function connectionLabel(provider: ModelProvider, method: ModelMethod, value: ModelCredential) {
  if (value.type === 'oauth') return value.email ?? 'ChatGPT account';
  if (value.type === 'endpoint') return new URL(value.url).host;
  if (value.type === 'bedrock') return value.region;
  if (value.type === 'azure') return value.deployment;
  return modelSource({ provider, method });
}

function usable(
  connections: Pick<ModelRecord, 'id' | 'status' | 'models'>[],
  selection: ModelSelection | null,
) {
  return (
    !!selection &&
    connections.some(
      (row) =>
        row.id === selection.connectionId &&
        row.status === 'connected' &&
        row.models.some(
          (model) =>
            model.choice.id === selection.modelId &&
            model.choice.efforts.includes(selection.effort),
        ),
    )
  );
}

function selectedConnectionWorks(state: ModelState) {
  return state.connections.some(
    (row) => row.id === state.selection?.connectionId && row.status === 'connected',
  );
}

function attention(row: Pick<ModelRecord, 'provider' | 'method' | 'managed' | 'status'>) {
  const name = `the ${modelSource(row)} connection`;
  return new ConnectionError(
    row.status === 'loading'
      ? `Load the models for ${name} in Settings > Models.`
      : row.managed
        ? `Refresh ${name} in Settings > Models.`
        : row.method === 'api_key'
          ? `Remove ${name} and add it again in Settings > Models.`
          : `Reconnect ${name} in Settings > Models.`,
  );
}

export function createModelService(options: {
  database: Pool;
  ownerId: string;
  keyStore: CredentialKeyStore;
  backend: ModelBackend;
  origin: string;
  bootstrap?: {
    provider: ModelProvider;
    model?: string;
    credentials: Partial<Record<ModelProvider, ModelCredential>>;
  };
  changed?(): void;
}) {
  const { backend } = options;
  const store = createDatabaseModelStore({
    database: options.database,
    ownerId: options.ownerId,
    keyStore: options.keyStore,
  });
  let analytics: CaptureAnalytics | undefined;
  function connectionChanged(
    provider: ModelProvider,
    method: ModelMethod,
    status: 'connected' | 'disconnected' | 'failed',
  ) {
    analytics?.({
      event: 'nod_model_connection_changed',
      properties: { provider, method, status },
    });
  }
  async function tracked<T>(provider: ModelProvider, method: ModelMethod, save: () => Promise<T>) {
    try {
      const result = await save();
      connectionChanged(provider, method, 'connected');
      return result;
    } catch (error) {
      connectionChanged(provider, method, 'failed');
      throw error;
    }
  }
  let rows: (ModelRecord & { keyEnding?: string })[] = [];
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
    const values = (
      value.type === 'oauth'
        ? [value.access, value.refresh, value.idToken]
        : value.key
          ? [value.key]
          : []
    ).filter((secret) => !secrets.has(secret));
    for (const secret of values) secrets.add(secret);
    if (values.length) for (const observer of observers) observer(values);
  }
  async function reload() {
    const state = await store.read();
    rows = state.connections.map(({ credential: saved, ...row }) => {
      const value = row.managed ? options.bootstrap?.credentials[row.provider] : saved;
      return value?.type === 'api_key' || value?.type === 'bedrock'
        ? { ...row, keyEnding: value.key.slice(-4) }
        : row;
    });
    selection = state.selection;
    options.changed?.();
  }
  function credential(row: ModelRecord | undefined) {
    if (!row) return undefined;
    const value = row.managed ? options.bootstrap?.credentials[row.provider] : row.credential;
    if (value) remember(value);
    return value;
  }
  function apiKeyConnection(provider: ModelProvider) {
    const candidates = rows.filter(
      (row) =>
        row.provider === provider &&
        (row.method === 'api_key' || (provider === 'openrouter' && row.method === 'oauth')) &&
        row.status === 'connected',
    );
    return (
      candidates.find((row) => row.id === selection?.connectionId) ??
      (candidates.length === 1 ? candidates[0] : undefined)
    );
  }
  function imageModel() {
    const connected = rows.filter((row) => row.status === 'connected');
    const selected = connected.find((row) => row.id === selection?.connectionId);
    for (const row of [
      ...(selected ? [selected] : []),
      ...connected.filter((row) => row !== selected),
    ]) {
      const models = row.models.filter((model) => model.choice.images);
      const definition =
        (row === selected && models.find((model) => model.choice.id === selection?.modelId)) ||
        models.find((model) => model.choice.id === memoryModels[row.provider]) ||
        models.find((model) => model.choice.id === agentModels[row.provider]) ||
        models[0];
      if (definition) return { row, definition };
    }
  }
  async function read(id: string) {
    const result = await store.change(async (state) => {
      const row = state.connections.find((item) => item.id === id);
      if (!row) return {};
      if (row.status === 'reconnect') throw attention(row);
      try {
        const current = credential(row);
        if (current?.type !== 'oauth' || current.expires > Date.now() + 300000)
          return { value: current };
        const next = await backend.refresh(current);
        remember(next);
        row.credential = next;
        return { value: next };
      } catch (error) {
        logFailure('model_refresh_failed', error instanceof Error ? (error.cause ?? error) : error);
        if (!(error instanceof ModelAuthError) || !error.requiresReconnect)
          throw new ConnectionError(
            error instanceof ModelAuthError
              ? error.message
              : 'The model service is temporarily unavailable. Try again.',
          );
        row.status = 'reconnect';
        return { reconnect: row };
      }
    });
    if (result.reconnect) {
      await reload();
      throw attention(result.reconnect);
    }
    return result.value;
  }
  async function needsReconnect(
    id: string,
    seen: { models: ModelDefinition[]; credential?: ModelCredential },
  ) {
    try {
      const flagged = await store.change((state) => {
        const row = state.connections.find((item) => item.id === id);
        if (
          !row ||
          row.managed ||
          row.status !== 'connected' ||
          JSON.stringify(row.models) !== JSON.stringify(seen.models) ||
          (seen.credential && JSON.stringify(row.credential) !== JSON.stringify(seen.credential))
        )
          return false;
        row.status = 'reconnect';
        return true;
      });
      if (flagged) await reload();
    } catch (error) {
      logFailure('model_reconnect_flag_failed', error);
    }
  }
  async function catalog(
    provider: ModelProvider,
    method: ModelMethod,
    value?: ModelCredential,
    rejected?: () => Promise<void>,
  ) {
    try {
      return await backend.catalog(provider, method, value);
    } catch (error) {
      if (error instanceof ModelAuthError && error.requiresReconnect) await rejected?.();
      throw new ConnectionError(
        error instanceof ModelAuthError
          ? error.message
          : 'The model list couldn’t be loaded. Try again.',
      );
    }
  }
  async function checkStorage() {
    if (!options.keyStore.configured)
      throw new ConnectionError(
        'Configure NOD_VAULT_KEY in server settings before saving a connection.',
      );
    try {
      await options.keyStore.getKey();
    } catch (cause) {
      throw new ConnectionError(
        'nod cannot open its credential storage. Check your server settings, then try again.',
        { cause },
      );
    }
  }
  async function save(
    provider: ModelProvider,
    method: ModelMethod,
    value: ModelCredential,
    definitions: ModelDefinition[],
    id?: string,
    {
      managed = false,
      replace = false,
      status = 'connected',
      signal,
    }: {
      managed?: boolean;
      replace?: boolean;
      status?: ModelRecord['status'];
      signal?: AbortSignal;
    } = {},
  ) {
    remember(value);
    if (!managed && !options.keyStore.configured)
      throw new ConnectionError(
        'Configure NOD_VAULT_KEY in server settings before saving a connection.',
      );
    if (status === 'connected' && !definitions.length)
      throw new ConnectionError('This connection has no supported models.');
    const saved = await store.change((state) => {
      const previous = state.connections.find((row) =>
        id ? row.id === id : !managed && sameAccount(row, provider, method, value),
      );
      if (replace && !previous)
        throw new ConnectionError('This model connection was removed. Start a new connection.');
      const duplicates = managed
        ? []
        : state.connections.filter(
            (row) => row !== previous && sameAccount(row, provider, method, value),
          );
      if (!previous && state.connections.length - duplicates.length >= 20)
        throw new ConnectionError('Remove an unused model connection before adding another.');
      const working = status === 'loading' && previous?.status === 'connected';
      const row: ModelRecord = {
        id: previous?.id ?? id ?? randomUUID(),
        provider,
        method,
        label: connectionLabel(provider, method, value),
        models: working ? previous.models : definitions,
        managed,
        status: working ? 'connected' : status,
        ...(!managed ? { credential: value } : {}),
      };
      state.connections = state.connections.flatMap((item) =>
        item === previous ? [row] : duplicates.includes(item) ? [] : [item],
      );
      if (!previous) state.connections.push(row);
      if (state.selection && duplicates.some((item) => item.id === state.selection!.connectionId))
        state.selection = { ...state.selection, connectionId: row.id };
      selectDefault(state, row);
      return row.id;
    }, signal);
    await reload();
    return saved;
  }
  function selectDefault(state: ModelState, row: ModelRecord) {
    const { provider, method, models: definitions, id, managed, status } = row;
    const preferredId =
      managed && options.bootstrap?.provider === provider
        ? (options.bootstrap.model ?? agentModels[provider])
        : agentModels[provider];
    const subscription = method === 'subscription';
    const preferred =
      (subscription && definitions.find((model) => model.choice.id === 'gpt-6-sol')) ||
      definitions.find((model) => model.choice.id === preferredId) ||
      (subscription || provider === 'compatible' || definitions.length === 1
        ? definitions[0]
        : undefined);
    if (
      preferred &&
      status === 'connected' &&
      (!managed || options.bootstrap?.provider === provider) &&
      (!state.selectionSet || (!managed && !selectedConnectionWorks(state)))
    ) {
      state.selection = {
        connectionId: id,
        modelId: preferred.choice.id,
        effort: preferred.choice.efforts.includes('high') ? 'high' : preferred.choice.efforts[0],
      };
      state.selectionSet = true;
    }
  }
  async function updateCatalog(id: string, signal?: AbortSignal) {
    signal?.throwIfAborted();
    const snapshot = (await store.read()).connections.find((item) => item.id === id);
    if (!snapshot) throw new ConnectionError('This model connection is unavailable.');
    if (!snapshot.managed && snapshot.status === 'reconnect') throw attention(snapshot);
    const value = credential(snapshot);
    if (!value) throw new ConnectionError('This model connection is unavailable.');
    const previous = JSON.stringify(snapshot);
    const definitions = await catalog(snapshot.provider, snapshot.method, value, () =>
      needsReconnect(id, snapshot),
    );
    if (!definitions.length) throw new ConnectionError('This connection has no supported models.');
    await store.change((state) => {
      const row = state.connections.find((item) => item.id === id);
      if (!row || JSON.stringify(row) !== previous)
        throw new ConnectionError('This model connection changed. Refresh its models again.');
      signal?.throwIfAborted();
      row.models = definitions;
      row.status = 'connected';
      row.label = connectionLabel(row.provider, row.method, value);
      selectDefault(state, row);
    }, signal);
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
    const method = attempt.provider === 'openai' ? 'subscription' : 'oauth';
    try {
      const value = await result;
      active(attempt);
      attempt.status = 'completing';
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
      connectionChanged(attempt.provider, method, 'connected');
    } catch (error) {
      logFailure('model_sign_in_failed', error instanceof Error ? (error.cause ?? error) : error);
      if (!attempt.controller.signal.aborted) connectionChanged(attempt.provider, method, 'failed');
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
    try {
      await checkStorage();
    } catch (error) {
      connectionChanged(provider, provider === 'openai' ? 'subscription' : 'oauth', 'failed');
      throw error;
    }
    const saved = await store.read();
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
          ? await backend.signIn({
              signal: controller.signal,
              hostId: saved.hostId,
              previous: saved.connections.find((item) => item.id === row?.id)?.credential,
            })
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
      return usable(rows, selection);
    },
    get current() {
      return {
        provider:
          rows.find((row) => row.id === selection?.connectionId)?.provider ?? 'unconfigured',
        name: selection?.modelId ?? 'Unconfigured',
        configured: service.configured,
        reconnect: rows.find((row) => row.id === selection?.connectionId)?.status === 'reconnect',
      };
    },
    onSecrets(observer: (values: string[]) => void) {
      observers.add(observer);
      observer([...secrets]);
      return () => observers.delete(observer);
    },
    view(): ModelsResponse {
      return {
        connections: rows.map(
          ({ id, provider, method, label, status, managed, models, keyEnding }) => ({
            id,
            provider,
            method,
            label,
            status,
            managed,
            models: models.map((model) => model.choice),
            ...(keyEnding ? { keyEnding } : {}),
          }),
        ),
        selection,
      };
    },
    async initialize() {
      await store.initialize();
      await store.change((state) => {
        for (const row of state.connections) {
          try {
            if (!credential(row)) row.status = 'reconnect';
          } catch {
            row.status = 'reconnect';
          }
        }
      });
      await reload();
      const sources = Object.entries(options.bootstrap?.credentials ?? {}).sort(
        ([a], [b]) =>
          Number(b === options.bootstrap?.provider) - Number(a === options.bootstrap?.provider),
      );
      for (const [provider, value] of sources) {
        if (!value) continue;
        const existing = rows.find((row) => row.provider === provider && row.managed);
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
    async addKey(
      provider: ModelProvider,
      key: string,
      settings: { region?: string; url?: string; model?: string; deployment?: string } = {},
    ) {
      const value = keyCredential(provider, key, settings);
      remember(value);
      return tracked(provider, 'api_key', async () => {
        await checkStorage();
        return save(provider, 'api_key', value, await catalog(provider, 'api_key', value));
      });
    },
    async addEndpoint(address: string, key?: string) {
      const url = endpointAddress(address);
      if (!url)
        throw new ConnectionError('Enter a server address such as http://localhost:11434/v1.');
      const value: ModelCredential = { type: 'endpoint', url, ...(key ? { key } : {}) };
      remember(value);
      return tracked('compatible', 'api_key', async () => {
        await checkStorage();
        const definitions = await backend.catalog('compatible', 'api_key', value).catch(() => {
          throw new ConnectionError(
            'nod couldn’t list this server’s models. Check the address, the API key and that the server is running.',
          );
        });
        if (!definitions.length)
          throw new ConnectionError(
            'This server has no models nod can use. nod needs models with tool support.',
          );
        return save('compatible', 'api_key', value, definitions);
      });
    },
    async select(input: ModelSelection) {
      const value = modelSelectionInput.parse(input);
      await store.change((state) => {
        const row = state.connections.find((item) => item.id === value.connectionId);
        const model =
          row?.status === 'connected' &&
          row.models.find((item) => item.choice.id === value.modelId);
        if (!model || !model.choice.efforts.includes(value.effort))
          throw new ConnectionError('Choose an available model and effort.');
        state.selection = value;
        state.selectionSet = true;
      });
      await reload();
    },
    async remove(id: string) {
      for (const [state, attempt] of attempts) if (attempt.connectionId === id) await cancel(state);
      const removed = await store.change((state) => {
        const row = state.connections.find((item) => item.id === id);
        if (row?.managed)
          throw new ConnectionError('This connection is managed in server settings.');
        state.connections = state.connections.filter((item) => item.id !== id);
        if (state.selection?.connectionId === id) state.selection = null;
        return row;
      });
      await reload();
      if (removed) connectionChanged(removed.provider, removed.method, 'disconnected');
    },
    analyticsConnections() {
      return rows.map((row) => {
        const selected = row.id === selection?.connectionId;
        return {
          provider: row.provider,
          method: row.method,
          selected,
          ...(selected && selection
            ? {
                ...analyticsModel(row.provider, selection.modelId),
                provider: row.provider,
                effort: selection.effort,
              }
            : {}),
        };
      });
    },
    refreshCatalog,
    hasApiKey(provider: ModelProvider) {
      return Boolean(apiKeyConnection(provider));
    },
    async apiKey(provider: ModelProvider) {
      const row = apiKeyConnection(provider);
      const value = row && (await read(row.id));
      return value?.type === 'api_key' ? value.key : undefined;
    },
    hasImageModel() {
      return Boolean(imageModel());
    },
    async resolveImage(): Promise<ModelAccess> {
      const candidate = imageModel();
      if (!candidate) throw new ConnectionError('Connect a model that accepts images in Models.');
      const { row, definition } = candidate;
      return {
        provider: row.provider,
        method: row.method,
        definition,
        effort: lightestEffort(definition.choice.efforts),
        read: () => read(row.id),
        needsReconnect: (credential) => needsReconnect(row.id, { models: row.models, credential }),
      };
    },
    async resolve(auxiliary = false): Promise<ModelAccess> {
      const selected = selection && { ...selection };
      const row = rows.find((row) => row.id === selected?.connectionId);
      if (!row || !selected)
        throw new ConnectionError('Open Settings > Models. Connect a service and choose a model.');
      if (row.status !== 'connected') throw attention(row);
      const definition =
        (auxiliary
          ? row.models.find((model) => model.choice.id === memoryModels[row.provider])
          : undefined) ?? row.models.find((model) => model.choice.id === selected.modelId);
      if (!definition || (!definition.choice.efforts.includes(selected.effort) && !auxiliary))
        throw new ConnectionError(
          'The selected model is unavailable. Choose another model in Settings > Models.',
        );
      return {
        provider: row.provider,
        method: row.method,
        definition,
        effort: auxiliary
          ? (definition.choice.efforts.find((level) => ['off', 'low', 'medium'].includes(level)) ??
            definition.choice.efforts[0])
          : selected.effort,
        read: () => read(row.id),
        needsReconnect: (credential) => needsReconnect(row.id, { models: row.models, credential }),
      };
    },
    start,
    cancel,
    complete,
    signInStatus,
    register(app: FastifyInstance, capture?: CaptureAnalytics) {
      analytics = capture;
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
          const { provider, key, ...settings } = keySchema.parse(request.body);
          await service.addKey(provider, key, settings);
          return service.view();
        });
        routes.get('/api/models/azure', async () => ({
          models: (await catalog('azure', 'api_key')).map(({ choice }) => ({
            id: choice.id,
            name: choice.name,
          })),
        }));
        routes.post('/api/models/endpoints', async (request) => {
          const input = z
            .object({
              url: z.string().trim().min(1).max(2000),
              key: z.string().trim().max(32000).optional(),
            })
            .strict()
            .parse(request.body);
          await service.addEndpoint(input.url, input.key || undefined);
          return service.view();
        });
        routes.put('/api/models/selection', async (request) => {
          await service.select(modelSelectionInput.parse(request.body));
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
