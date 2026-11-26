import { createHash, randomUUID } from 'node:crypto';
import type { Pool, PoolClient } from 'pg';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type {
  ModelAccess,
  ModelBackend,
  ModelCredential,
  ModelDefinition,
} from '../ports/models.ts';
import {
  ModelAuthError,
  ModelCatalogError,
  ModelWorkspaceSelectionError,
} from '../ports/models.ts';
import { ModelRequestError } from '../ports/agent.ts';
import type { CredentialKeyStore } from '../ports/key-store.ts';
import type {
  ModelLane,
  ModelMethod,
  ModelChoice,
  ModelProvider,
  ModelRoute,
  ModelRoutes,
  ModelIssue,
  ModelSelection,
  ModelsResponse,
  WorkKind,
  WorkModel,
} from '../shared/models.ts';
import {
  apiKeyConnectionProviders,
  boundedPrice,
  modelProviderInfo,
  modelProviderNames,
  azureDeploymentPattern,
  bedrockRegionPattern,
  cloudflareAccountPattern,
  cloudflareGatewayPattern,
  lightestEffort,
  modelSource,
  openAIRegions,
  routeModel,
  supportsLongCacheWrites,
} from '../shared/models.ts';
import { signInPage } from '../shared/sign-in-page.ts';
import { appPages } from '../shared/app-links.ts';
import { modelKeyError } from '../shared/model-keys.ts';
import {
  agentModels,
  defaultEffort,
  defaultModel,
  memoryModels,
} from '../shared/model-defaults.ts';
import { createDatabaseModelStore, type ModelRecord, type ModelState } from './model-store.ts';
import { analyticsModel, snapshotAnalytics, type CaptureAnalytics } from './analytics.ts';
import type { SettingActor } from './analytics-settings.ts';
import { logFailure } from './failure-log.ts';
import { modelFailureReason } from '../shared/model-quota.ts';
import { createTextRedactor, redactSecretText } from './redaction.ts';
import { afterCommit } from './transaction.ts';

const keySchema = z
  .object({
    provider: z.enum(apiKeyConnectionProviders),
    key: z.string().trim().min(8).max(32000),
    region: z.string().trim().max(100).optional(),
    url: z.string().trim().max(2000).optional(),
    model: z.string().trim().max(200).optional(),
    deployment: z.string().trim().max(200).optional(),
    accountId: z.string().trim().max(100).optional(),
    gatewayId: z.string().trim().max(100).optional(),
    workspaceId: z.string().trim().max(100).optional(),
  })
  .strict();
export const modelSelectionInput = z
  .object({
    connectionId: z.uuid(),
    modelId: z.string().min(1).max(200),
    effort: z.enum(['off', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max']),
  })
  .strict();
class ConnectionError extends ModelRequestError {}

const rates = {
  input: z.number().finite(),
  output: z.number().finite(),
  cacheRead: z.number().finite().optional(),
  cacheWrite: z.number().finite().optional(),
};
const modelRates = z.object({
  ...rates,
  tiers: z.array(z.object({ ...rates, inputTokensAbove: z.number().nonnegative() })).optional(),
});

function modelPricing(model: ModelDefinition): ModelChoice['pricing'] {
  if (model.spec.provider === 'compatible') return undefined;
  if (model.choice.id === 'openrouter/auto') return 'variable';
  const cost = modelRates.safeParse(model.spec.cost).data;
  if (!cost) return undefined;
  const { tiers, ...rates } = cost;
  if ([rates, ...(tiers ?? [])].some((rate) => Object.values(rate).some((value) => value < 0)))
    return 'variable';
  return {
    ...rates,
    ...(tiers?.length ? { tiers } : {}),
    ...(supportsLongCacheWrites(model.spec.api) ? { longCacheWrites: true } : {}),
  };
}

const auxiliaryEffort = (efforts: ModelChoice['efforts']) =>
  efforts.find((level) => ['off', 'low', 'medium'].includes(level)) ?? efforts[0];

export const modelRouteInput = z.union([modelSelectionInput, z.literal('light'), z.null()]);
export const modelBackupsInput = z.array(modelSelectionInput).max(3);

export interface WorkOrigin {
  kind: WorkKind;
  task?: ModelSelection | null;
  schedule?: ModelSelection | null;
}

const workNames = {
  task: 'This task',
  schedule: 'This schedule',
  lane: { schedule: 'Schedules', background: 'Work Nod starts on its own' },
} as const;

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

function azureAddress(address: string) {
  const value = address.trim();
  const url = endpointAddress(/^[a-z][a-z\d+.-]*:\/\//i.test(value) ? value : `https://${value}`);
  if (!url) return undefined;
  const { protocol, hostname, origin, pathname } = new URL(url);
  if (protocol !== 'https:' && !['localhost', '127.0.0.1', '[::1]'].includes(hostname))
    return undefined;
  return pathname === '/' || pathname === '/openai' ? `${origin}/openai/v1` : url;
}

export function modelKeyCredential(
  provider: ModelProvider,
  key: string,
  settings: {
    region?: string;
    url?: string;
    model?: string;
    deployment?: string;
    accountId?: string;
    gatewayId?: string;
    workspaceId?: string;
  },
): ModelCredential {
  if (provider === 'openai') {
    const region = settings.region || 'global';
    if (!Object.hasOwn(openAIRegions, region))
      throw new ConnectionError('Choose an OpenAI API region.');
    return {
      type: 'api_key',
      key,
      ...(region !== 'global' ? { region: region as keyof typeof openAIRegions } : {}),
    };
  }
  if (provider === 'anthropic') {
    const workspaceId = settings.workspaceId?.trim();
    if (workspaceId && (workspaceId.length > 100 || !/^[\x21-\x7e]+$/.test(workspaceId)))
      throw new ConnectionError('Enter a Workspace ID from the Claude Console.');
    return { type: 'api_key', key, ...(workspaceId ? { workspaceId } : {}) };
  }
  if (provider === 'amazon-bedrock') {
    if (!settings.region || !bedrockRegionPattern.test(settings.region))
      throw new ConnectionError('Enter an AWS Region, such as us-east-1.');
    return { type: 'bedrock', key, region: settings.region };
  }
  if (provider === 'cloudflare-workers-ai' || provider === 'cloudflare-ai-gateway') {
    if (!settings.accountId || !cloudflareAccountPattern.test(settings.accountId))
      throw new ConnectionError('Enter your 32-character Cloudflare account ID.');
    if (
      provider === 'cloudflare-ai-gateway' &&
      (!settings.gatewayId || !cloudflareGatewayPattern.test(settings.gatewayId))
    )
      throw new ConnectionError('Enter your Cloudflare AI Gateway ID.');
    return {
      type: 'cloudflare',
      key,
      accountId: settings.accountId.toLowerCase(),
      ...(provider === 'cloudflare-ai-gateway' ? { gatewayId: settings.gatewayId } : {}),
    };
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
  if (provider === 'openai' && value.type === 'api_key' && value.region)
    return `OpenAI · ${openAIRegions[value.region]}`;
  if (provider === 'anthropic' && value.type === 'api_key' && value.workspaceId)
    return value.workspaceId;
  if (value.type === 'oauth') return value.email ?? 'ChatGPT account';
  if (value.type === 'endpoint') return new URL(value.url).host;
  if (value.type === 'bedrock') return value.region;
  if (value.type === 'azure') return value.deployment;
  if (value.type === 'cloudflare') return value.gatewayId ?? value.accountId;
  return modelSource({ provider, method });
}

function textCompanion(row: Pick<ModelRecord, 'provider' | 'method' | 'models'>) {
  const candidates = row.models.filter(
    (model) =>
      !model.choice.audio &&
      model.choice.efforts.length > 0 &&
      Array.isArray(model.spec.input) &&
      model.spec.input.includes('text'),
  );
  const choice = defaultModel(
    row.provider,
    candidates.map((model) => model.choice),
    row.method,
  );
  return candidates.find((model) => model.choice.id === choice?.id);
}

function missingTextCompanion() {
  return new ConnectionError(
    `This audio model needs a text model on the same connection. Refresh its models or choose another model in ${appPages['/settings/models']}.`,
  );
}

function usable(
  connections: Pick<ModelRecord, 'id' | 'provider' | 'method' | 'status' | 'models'>[],
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
            model.choice.efforts.includes(selection.effort) &&
            (!model.choice.audio || Boolean(textCompanion(row))),
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
      ? `Load the models for ${name} in ${appPages['/settings/models']}.`
      : row.managed
        ? `Refresh ${name} in ${appPages['/settings/models']}.`
        : row.method === 'api_key'
          ? `Remove ${name} and add it again in ${appPages['/settings/models']}.`
          : `Reconnect ${name} in ${appPages['/settings/models']}.`,
  );
}

const credentialTag = (value: ModelCredential | undefined) =>
  value &&
  createHash('sha256')
    .update(JSON.stringify(value.type === 'oauth' ? [value.accountId, value.clientId] : value))
    .digest('hex');
const failureWindow = (failures: number) =>
  Math.min(120_000 * 3 ** Math.max(0, failures - 1), 6 * 3_600_000);
function failures(row: Pick<ModelRecord, 'requestFailures'> | undefined, tag: string | undefined) {
  return Object.entries(row?.requestFailures ?? {}).filter(
    ([, failure]) => tag && failure.credentialTag === tag,
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
  let requestBudget: ModelAccess['reserve'];
  const reserve: NonNullable<ModelAccess['reserve']> = async (maximumUsd) => {
    if (!requestBudget) throw new Error('The model request budget is not configured.');
    return requestBudget(maximumUsd);
  };
  function connectionChanged(
    provider: ModelProvider,
    method: ModelMethod,
    status: 'connected' | 'disconnected' | 'failed',
    capture = analytics,
  ) {
    if (provider === 'elevenlabs') return;
    capture?.({
      event: 'model_connection_changed',
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
  let rows: (ModelRecord & {
    credentialTag?: string;
    keyEnding?: string;
    issue?: ModelIssue;
    issues?: Record<string, ModelIssue>;
    retry?: Record<string, number>;
  })[] = [];
  let selectionCheck: (() => Promise<unknown>) | undefined;
  let checked: string | undefined;
  let pendingCheck: Promise<unknown> | undefined;
  let checkIssue: ModelIssue | undefined;
  let initialized = false;
  let selection: ModelSelection | null = null;
  let routes: ModelRoutes = {};
  let backups: ModelSelection[] = [];
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
      cancelled?: { reason: string; phase: string };
    }
  >();
  function signInFailure(attempt: NonNullable<ReturnType<typeof attempts.get>>, error: unknown) {
    return {
      provider: attempt.provider,
      reason: attempt.cancelled?.reason ?? Object(error).reason,
      phase: attempt.cancelled?.phase ?? attempt.status,
      elapsedMs: Date.now() - (attempt.expires - 600000),
    };
  }
  async function cancel(state: string, reason = 'cancelled') {
    const attempt = attempts.get(state);
    if (!attempt) return;
    clearTimeout(attempt.timer);
    if (attempt.status === 'waiting' || attempt.status === 'completing') {
      attempt.cancelled ??= { reason, phase: attempt.status };
      if (!attempt.completion)
        logFailure('model_sign_in_failed', undefined, signInFailure(attempt, undefined));
    }
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
    ).filter((secret) => typeof secret === 'string' && secret.length > 0 && !secrets.has(secret));
    for (const secret of values) secrets.add(secret);
    if (values.length) for (const observer of observers) observer(values);
  }
  async function reload() {
    const state = await store.read();
    rows = state.connections.map(({ credential: saved, ...row }) => {
      const value = row.managed ? options.bootstrap?.credentials[row.provider] : saved;
      const tag = credentialTag(value);
      const failed = failures(row, tag).sort(([, a], [, b]) => b.retryAt - a.retryAt);
      return {
        ...row,
        credentialTag: tag,
        ...(value &&
        typeof value === 'object' &&
        'key' in value &&
        typeof value.key === 'string' &&
        value.key.length > 4
          ? { keyEnding: value.key.slice(-4) }
          : {}),
        ...(failed.length
          ? {
              issue: { reason: failed[0]![1].reason },
              issues: Object.fromEntries(failed.map(([id, item]) => [id, { reason: item.reason }])),
              retry: Object.fromEntries(failed.map(([id, item]) => [id, item.retryAt])),
            }
          : {}),
      };
    });
    selection = state.selection;
    routes = state.routes;
    backups = state.backups;
    checkSelection(state);
    options.changed?.();
  }
  function checkSelection(state: ModelState) {
    const row = state.connections.find((item) => item.id === state.selection?.connectionId);
    if (!selectionCheck || !row || row.status !== 'connected' || closed) return;
    const key = `${row.id}:${state.selection!.modelId}:${credentialTag(credential(row))}`;
    if (key === checked) return;
    checked = key;
    checkIssue = undefined;
    const saved = credential(row);
    const port = saved?.type === 'endpoint' ? new URL(saved.url).port : undefined;
    const check = selectionCheck()
      .catch((error: unknown) => {
        if (
          pendingCheck === check &&
          !(Object(error).providerStatus === 429 && Object(error).providerRetryable)
        )
          checkIssue = {
            reason: createTextRedactor([...secrets])(
              modelFailureReason(error instanceof Error ? error.message : String(error)),
            )
              .replace(/\s+/g, ' ')
              .trim()
              .slice(0, 300),
          };
        logFailure('model_check_failed', error, {
          provider: row.provider,
          ...(port === undefined
            ? {}
            : { serverKind: port === '11434' ? 'ollama' : port === '1234' ? 'lmstudio' : 'other' }),
          status: Object(error).providerStatus,
        });
      })
      .finally(() => {
        if (pendingCheck !== check) return;
        pendingCheck = undefined;
        options.changed?.();
      });
    pendingCheck = check;
  }
  function requested(row: ModelRecord | undefined, modelId: string | undefined) {
    const chosen = row?.models.find((model) => model.choice.id === modelId);
    if (!row || !chosen) return [];
    const companion = chosen.choice.audio ? textCompanion(row)?.choice.id : undefined;
    return companion ? [chosen.choice.id, companion] : [chosen.choice.id];
  }
  function credential(row: ModelRecord | undefined) {
    if (!row) return undefined;
    const value = row.managed ? options.bootstrap?.credentials[row.provider] : row.credential;
    if (value) remember(value);
    return value;
  }
  function requestAccess(
    row: ModelRecord,
  ): Pick<ModelAccess, 'read' | 'prepareRequest' | 'reserve'> {
    return {
      read: () => read(row.id),
      reserve,
      async prepareRequest(modelId, automatic) {
        const tag = credentialTag(await read(row.id));
        const failure = new Map(
          failures(
            rows.find((item) => item.id === row.id),
            tag,
          ),
        ).get(modelId);
        if (automatic && failure && Date.now() < failure.retryAt)
          throw new ConnectionError(
            `${modelProviderNames[row.provider]} failed the last request to ${modelId} (${failure.reason}). Automatic requests to this model are paused until a request succeeds. Check this connection in ${appPages['/settings/models']} or ask again to make a new request.`,
          );
        return async (error, status) => {
          if (!tag || closed) return;
          if (
            !error &&
            row.id === selection?.connectionId &&
            requested(row, selection.modelId).includes(modelId) &&
            checkIssue &&
            rows.find((item) => item.id === row.id)?.credentialTag === tag
          ) {
            checkIssue = undefined;
            options.changed?.();
          }
          const recorded = failures(
            rows.find((item) => item.id === row.id),
            tag,
          );
          if (!error && !recorded.some(([id]) => id === modelId)) return;
          try {
            await store.change((state) => {
              const saved = state.connections.find((item) => item.id === row.id);
              if (!saved || credentialTag(credential(saved)) !== tag) return;
              const current = new Map(failures(saved, tag));
              if (!error) {
                if (current.delete(modelId))
                  for (const item of current.values())
                    item.retryAt = Math.min(item.retryAt, Date.now());
                saved.requestFailures = Object.fromEntries(current);
                return;
              }
              const previous = current.get(modelId);
              const count =
                previous && Date.now() < previous.retryAt
                  ? previous.failures
                  : (previous?.failures ?? 0) + 1;
              saved.requestFailures = Object.fromEntries(current);
              saved.requestFailures[modelId] = {
                credentialTag: tag,
                failures: count,
                retryAt: Date.now() + failureWindow(count),
                reason: redactSecretText(modelFailureReason(error))
                  .replace(/\s*\[request phase: [^\]]*\]\s*$/, '')
                  .replace(/\s+/g, ' ')
                  .trim()
                  .slice(0, 300),
              };
              if (status === 401 && !saved.managed && saved.status === 'connected')
                saved.status = 'reconnect';
            });
            await reload();
          } catch (error) {
            logFailure('model_failure_save_failed', error);
          }
        };
      },
    };
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
  function usableBackups(connectionId: string | undefined, modelId: string) {
    const seen = new Set([`${connectionId}:${modelId}`]);
    return backups.flatMap((item) => {
      const row = rows.find((candidate) => candidate.id === item.connectionId);
      const definition =
        row?.status === 'connected'
          ? row.models.find(
              (model) =>
                model.choice.id === item.modelId &&
                !model.choice.audio &&
                model.choice.efforts.length > 0,
            )
          : undefined;
      const key = `${item.connectionId}:${item.modelId}`;
      if (!row || !definition || seen.has(key)) return [];
      seen.add(key);
      return [{ row, definition, item }];
    });
  }
  function classificationModel(otherConnections = false) {
    const selected = selection && { ...selection };
    const current = rows.find((row) => row.id === selected?.connectionId);
    const main = current?.models.find((model) => model.choice.id === selected?.modelId);
    const price = main && modelPricing(main);
    if (
      current?.provider === 'openrouter' &&
      price &&
      price !== 'variable' &&
      price.input + price.output === 0
    )
      return undefined;
    const candidates = [
      current,
      ...(otherConnections ? rows.filter((row) => row !== current) : []),
    ];
    for (const row of candidates) {
      if (!row || row.status !== 'connected') continue;
      const definition = row.models.find(
        (model) => model.choice.id === memoryModels[row.provider] && !model.choice.audio,
      );
      if (!definition) continue;
      if (otherConnections) {
        if (row === current) return { row, definition };
        const peers = candidates.filter(
          (candidate) =>
            candidate?.status === 'connected' &&
            candidate.provider === row.provider &&
            candidate.models.some(
              (model) =>
                model.choice.id === memoryModels[candidate.provider] && !model.choice.audio,
            ),
        );
        if (peers.length === 1) return { row, definition };
        continue;
      }
      const main = row.models.find((model) => model.choice.id === selected?.modelId);
      if (!main) continue;
      const price = modelPricing(definition);
      const mainPrice = modelPricing(main);
      if (
        !price ||
        price === 'variable' ||
        price.input + price.output <= 0 ||
        !mainPrice ||
        mainPrice === 'variable' ||
        mainPrice.input + mainPrice.output <= 0 ||
        price.input > mainPrice.input ||
        price.output > mainPrice.output
      )
        continue;
      return { row, definition };
    }
  }
  async function settle(client: PoolClient | undefined, apply: () => void) {
    if (!client) return reload();
    afterCommit(client, () => {
      apply();
      options.changed?.();
      void reload().catch((error: unknown) => logFailure('model_settings_reload_failed', error));
    });
  }
  function chosen(auxiliary: boolean, choice: ModelSelection | null) {
    const selected = auxiliary ? selection && { ...selection } : choice && { ...choice };
    const row = rows.find((row) => row.id === selected?.connectionId);
    if (!row || !selected)
      throw new ConnectionError(
        `Open ${appPages['/settings/models']}. Connect a service and choose a model.`,
      );
    if (row.status !== 'connected') throw attention(row);
    const definition =
      (auxiliary
        ? row.models.find((model) => model.choice.id === memoryModels[row.provider])
        : undefined) ?? row.models.find((model) => model.choice.id === selected.modelId);
    if (!definition || (!definition.choice.efforts.includes(selected.effort) && !auxiliary))
      throw new ConnectionError(
        `The selected model is unavailable on this connection (${row.provider} / ${selected.modelId}). Reload its models or choose another model in ${appPages['/settings/models']}.`,
      );
    const companion = definition.choice.audio ? textCompanion(row) : undefined;
    if (definition.choice.audio && !companion) throw missingTextCompanion();
    return { selected, row, definition, companion };
  }
  function unpricedPreparationModel() {
    try {
      const background = service.workModel({ kind: 'background' }).selection;
      for (const auxiliary of [false, true]) {
        const { definition, companion } = chosen(auxiliary, background);
        const target = companion ?? definition;
        if (!boundedPrice(modelPricing(target))) return target.choice.name;
      }
    } catch {
      return;
    }
  }
  function lightModel(): ModelSelection | null {
    const candidate = classificationModel();
    if (!candidate) return null;
    const { row, definition } = candidate;
    if (row.id === selection?.connectionId && definition.choice.id === selection.modelId)
      return null;
    return {
      connectionId: row.id,
      modelId: definition.choice.id,
      effort: defaultEffort(definition.choice),
    };
  }
  function textChoice(
    connections: ModelRecord[],
    value: ModelSelection,
  ): { row: ModelRecord; definition: ModelDefinition } {
    const row = connections.find((item) => item.id === value.connectionId);
    const definition =
      row?.status === 'connected' &&
      row.models.find((item) => item.choice.id === value.modelId && !item.choice.audio);
    if (!row || !definition || !definition.choice.efforts.includes(value.effort))
      throw Object.assign(new ConnectionError('Choose an available text model and effort.'), {
        statusCode: 400,
      });
    return { row, definition };
  }
  function routeState(value: ModelRoute | null | undefined) {
    return value === 'light' ? 'light' : value ? 'configured' : 'default';
  }
  function unavailable(work: WorkModel, kind: WorkKind, row: ModelRecord | undefined) {
    const name =
      work.follows === 'task' || work.follows === 'schedule'
        ? workNames[work.follows]
        : kind === 'chat'
          ? 'This work'
          : workNames.lane[kind];
    const place =
      work.follows === 'task' || work.follows === 'schedule'
        ? 'choose another model for it in Scheduled'
        : `choose another model in ${appPages['/settings/models']}`;
    if (row && row.status !== 'connected') {
      const reason = attention(row).message;
      return new ConnectionError(
        `${name} uses a model on a connection that needs attention. ${reason}`,
      );
    }
    return new ConnectionError(
      `${name} uses ${row ? `${row.provider} / ` : ''}${work.selection.modelId}, which is no longer available. Reload its models or ${place}.`,
    );
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
    if (value) remember(value);
    try {
      return await backend.catalog(provider, method, value);
    } catch (error) {
      if (error instanceof ModelAuthError && error.requiresReconnect) await rejected?.();
      let keyPattern: RegExp | undefined;
      let variants: string[] = [];
      if (value?.type === 'endpoint' && value.key) {
        variants = [
          ...new Set([
            value.key,
            encodeURIComponent(value.key),
            JSON.stringify(value.key).slice(1, -1),
          ]),
        ].sort((left, right) => right.length - left.length);
        keyPattern = new RegExp(
          variants.map((key) => key.replace(/[.*+?^$()|[\]{}\\]/g, '\\$&')).join('|'),
          'g',
        );
      }
      const text = createTextRedactor([
        ...secrets,
        value?.type === 'endpoint' ? value.url : '',
        ...variants,
      ]);
      const redact = (message: string) => {
        const safe = text(message);
        return keyPattern ? safe.replace(keyPattern, '[redacted]') : safe;
      };
      throw new ConnectionError(
        error instanceof ModelCatalogError
          ? new ModelCatalogError(
              error.failures.map((failure) => ({ ...failure, detail: redact(failure.detail) })),
            ).message
          : redact(error instanceof Error ? error.message : String(error)).slice(0, 2000),
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
        'Nod cannot open its credential storage. Check your server settings, then try again.',
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
    if (status === 'connected' && !definitions.length && !modelProviderInfo[provider].speechOnly)
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
      if (!previous && state.connections.length - duplicates.length >= 80)
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
        requestFailures: previous?.requestFailures,
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
    const choices = definitions.map((model) => model.choice);
    const selected = state.selection;
    const choice = choices.find((model) => model.id === selected?.modelId);
    if (
      selected?.connectionId === id &&
      choice?.efforts.length &&
      !choice.efforts.includes(selected.effort)
    )
      selected.effort = lightestEffort(choice.efforts);
    for (const route of Object.values(state.routes)) {
      if (!route || route === 'light' || route.connectionId !== id) continue;
      const routed = choices.find((model) => model.id === route.modelId);
      if (routed?.efforts.length && !routed.efforts.includes(route.effort))
        route.effort = lightestEffort(routed.efforts);
    }
    const configuredModel =
      managed && options.bootstrap?.provider === provider ? options.bootstrap.model : undefined;
    const preferred = configuredModel
      ? choices.find((model) => model.id === configuredModel)
      : defaultModel(provider, choices, method);
    if (
      preferred &&
      status === 'connected' &&
      (!managed || options.bootstrap?.provider === provider) &&
      (!state.selectionSet || (!managed && !selectedConnectionWorks(state)))
    ) {
      state.selection = {
        connectionId: id,
        modelId: preferred.id,
        effort: defaultEffort(preferred),
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
    if (!definitions.length && !modelProviderInfo[snapshot.provider].speechOnly)
      throw new ConnectionError('This connection has no supported models.');
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
        await cancel(state, Object(Object(error).cause).reason ?? 'callback_rejected');
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
      const cause = error instanceof Error ? (error.cause ?? error) : error;
      logFailure('model_sign_in_failed', cause, signInFailure(attempt, cause));
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
    return attempt?.provider;
  }
  function start(provider: 'openai' | 'openrouter', connectionId?: string) {
    const capture = snapshotAnalytics(analytics);
    const result = starting
      .then(() => begin(provider, connectionId))
      .catch((error) => {
        if (!closed && capture)
          connectionChanged(
            provider,
            provider === 'openai' ? 'subscription' : 'oauth',
            'failed',
            capture,
          );
        throw error;
      });
    starting = result.catch(() => {});
    return result;
  }
  async function begin(provider: 'openai' | 'openrouter', connectionId?: string) {
    if (closed) throw new ConnectionError('Model connections have stopped.');
    await checkStorage();
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
        await cancel(state, attempt.expires < Date.now() ? 'timeout' : 'superseded');
    if (closed) throw new ConnectionError('Model connections have stopped.');
    const controller = new AbortController();
    pendingControllers.add(controller);
    let flow: Awaited<ReturnType<ModelBackend['signIn']>> | undefined;
    const started = Date.now();
    let timedOut = false;
    const timeout = setTimeout(() => {
      timedOut = true;
      controller.abort();
    }, 15000);
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
        void cancel(auth.state, 'timeout');
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
      const cause = error instanceof Error ? (error.cause ?? error) : error;
      logFailure('model_sign_in_failed', cause, {
        provider,
        reason: timedOut ? 'timeout' : closed ? 'shutdown' : Object(cause).reason,
        phase: 'start',
        elapsedMs: Date.now() - started,
      });
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
      const row = rows.find((item) => item.id === selection?.connectionId);
      const chosen = row?.models.find((model) => model.choice.id === selection?.modelId);
      return {
        provider: row?.provider ?? 'unconfigured',
        name: selection?.modelId ?? 'Unconfigured',
        label: chosen?.choice.name ?? selection?.modelId,
        configured: service.configured,
        reconnect: row?.status === 'reconnect',
        checking: Boolean(pendingCheck),
        issue: selection ? (service.issue(selection) ?? checkIssue) : undefined,
      };
    },
    issue(choice: Pick<ModelSelection, 'connectionId' | 'modelId'>) {
      const row = rows.find((item) => item.id === choice.connectionId);
      return requested(row, choice.modelId)
        .map((id) => row?.issues?.[id])
        .find(Boolean);
    },
    paused(origin: WorkOrigin) {
      try {
        const { selection: work } = service.workModel(origin);
        const paused = (choice: ModelSelection) => {
          const row = rows.find((item) => item.id === choice.connectionId);
          return requested(row, choice.modelId).some((id) => (row?.retry?.[id] ?? 0) > Date.now());
        };
        const usable = (choice: ModelSelection) => {
          try {
            return Boolean(chosen(false, choice));
          } catch {
            return false;
          }
        };
        return (
          paused(work) &&
          (!usable(work) ||
            usableBackups(work.connectionId, work.modelId).every(({ item }) => paused(item)))
        );
      } catch {
        return false;
      }
    },
    async automaticRequestsAllowed(origin: WorkOrigin, auxiliary = false) {
      try {
        const work = service.workModel(origin);
        const takes = async (access: ModelAccess) => {
          try {
            await access.prepareRequest?.(
              access.textModel?.definition.choice.id ?? access.definition.choice.id,
              true,
            );
            return true;
          } catch {
            return false;
          }
        };
        for (const access of await service.candidates(work.selection))
          if (await takes(access)) return !auxiliary || (await takes(await service.resolve(true)));
        return false;
      } catch {
        return false;
      }
    },
    light: lightModel,
    unpricedPreparationModel,
    pricingThresholds() {
      return rows.flatMap(({ models }) =>
        models.flatMap((model) => {
          const pricing = modelPricing(model);
          return pricing && pricing !== 'variable'
            ? (pricing.tiers?.map((tier) => tier.inputTokensAbove) ?? [])
            : [];
        }),
      );
    },
    priceOf(choice: ModelSelection | null | undefined) {
      const row = rows.find((row) => row.id === choice?.connectionId);
      const definition = row?.models.find((model) => model.choice.id === choice?.modelId);
      return (
        definition && {
          modelId: definition.choice.id,
          pricing: modelPricing(definition),
          audio: definition.choice.audio,
          plan: row?.method === 'subscription',
        }
      );
    },
    pricing(kind: WorkKind, own: ModelSelection | null = null) {
      return service.priceOf(
        routeModel({ connections: rows, selection, routes, light: lightModel() }, kind, {
          schedule: own,
        })?.selection,
      );
    },
    describe(choice: ModelSelection) {
      const row = rows.find((item) => item.id === choice.connectionId);
      return {
        provider: row?.provider ?? 'unconfigured',
        name: choice.modelId,
        label:
          row?.models.find((model) => model.choice.id === choice.modelId)?.choice.name ??
          choice.modelId,
        configured: usable(rows, choice),
      };
    },
    validateChoice(value: ModelSelection) {
      const choice = modelSelectionInput.parse(value);
      textChoice(rows, choice);
      return choice;
    },
    workModel(origin: WorkOrigin): WorkModel {
      const work = routeModel(
        { connections: rows, selection, routes, light: lightModel() },
        origin.kind,
        origin,
      );
      if (!work)
        throw new ConnectionError(
          `Open ${appPages['/settings/models']}. Connect a service and choose a model.`,
        );
      if (work.follows === 'chat' || work.follows === 'light') return work;
      const row = rows.find((item) => item.id === work.selection.connectionId);
      const definition = row?.models.find((model) => model.choice.id === work.selection.modelId);
      if (row?.status !== 'connected' || !definition || definition.choice.audio)
        throw unavailable(work, origin.kind, row);
      if (definition.choice.efforts.includes(work.selection.effort)) return work;
      return {
        ...work,
        selection: { ...work.selection, effort: defaultEffort(definition.choice) },
      };
    },
    async candidates(
      choice: ModelSelection | null = selection,
      auxiliary = false,
    ): Promise<ModelAccess[]> {
      const primary = await service.resolve(auxiliary, choice);
      return [
        primary,
        ...usableBackups(primary.connectionId, primary.definition.choice.id).map(
          ({ row, definition, item }): ModelAccess => ({
            connectionId: row.id,
            provider: row.provider,
            method: row.method,
            definition,
            effort: auxiliary
              ? auxiliaryEffort(definition.choice.efforts)
              : definition.choice.efforts.includes(item.effort)
                ? item.effort
                : defaultEffort(definition.choice),
            ...requestAccess(row),
            needsReconnect: (credential) =>
              needsReconnect(row.id, { models: row.models, credential }),
          }),
        ),
      ];
    },
    async setBackups(value: ModelSelection[]) {
      const list = modelBackupsInput.parse(value);
      await store.change((state) => {
        const key = (choice: ModelSelection) =>
          `${choice.connectionId}:${choice.modelId}:${choice.effort}`;
        const saved = new Set(state.backups.map(key));
        const seen = new Set<string>();
        state.backups = list.filter((choice) => {
          if (!saved.has(key(choice))) textChoice(state.connections, choice);
          const model = `${choice.connectionId}:${choice.modelId}`;
          if (seen.has(model)) return false;
          seen.add(model);
          return true;
        });
      });
      await reload();
    },
    async setRoute(
      lane: ModelLane,
      value: ModelRoute | null,
      actor: SettingActor = 'owner',
      client?: PoolClient,
    ) {
      const route = modelRouteInput.parse(value);
      const capture = snapshotAnalytics(analytics);
      const changed = await store.change(
        (state) => {
          if (route && route !== 'light') textChoice(state.connections, route);
          const before = JSON.stringify(state.routes[lane] ?? null);
          state.routes = { ...state.routes, [lane]: route };
          return { changed: before !== JSON.stringify(route), routes: state.routes };
        },
        undefined,
        client,
      );
      if (changed.changed)
        capture?.({
          event: 'setting_changed',
          properties: {
            setting: lane === 'schedule' ? 'model_route_schedule' : 'model_route_background',
            actor,
            state: routeState(route),
          },
        });
      await settle(client, () => {
        routes = changed.routes;
      });
    },
    onSecrets(observer: (values: string[]) => void) {
      observers.add(observer);
      observer([...secrets]);
      return () => observers.delete(observer);
    },
    view(): ModelsResponse {
      const unpriced = unpricedPreparationModel();
      const selectionIssue = service.current.issue;
      return {
        connections: rows.map(
          ({ id, provider, method, label, status, managed, models, keyEnding, issue }) => ({
            id,
            provider,
            method,
            label,
            status,
            managed,
            ...(issue ? { issue } : {}),
            models: models.map((model) => ({
              ...model.choice,
              pricing: modelPricing(model),
              ...(model.choice.audio
                ? { textModelName: textCompanion({ provider, method, models })?.choice.name }
                : {}),
            })),
            ...(keyEnding ? { keyEnding } : {}),
          }),
        ),
        selection,
        ...(selectionIssue ? { selectionIssue } : {}),
        routes,
        backups,
        light: lightModel(),
        ...(unpriced ? { unpricedPreparationModel: unpriced } : {}),
      };
    },
    async initialize() {
      await store.initialize();
      initialized = true;
      await store.change((state) => {
        state.connections = state.connections.filter(
          (row) => !row.managed || options.bootstrap?.credentials[row.provider],
        );
        if (!state.connections.some((row) => row.id === state.selection?.connectionId))
          state.selection = null;
        state.backups = state.backups.filter((choice) =>
          state.connections.some((row) => row.id === choice.connectionId),
        );
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
        const connected =
          definitions !== undefined &&
          (definitions.length > 0 ||
            modelProviderInfo[provider as ModelProvider].speechOnly === true);
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
      settings: {
        region?: string;
        url?: string;
        model?: string;
        deployment?: string;
        accountId?: string;
        gatewayId?: string;
        workspaceId?: string;
      } = {},
    ) {
      key = key.trim();
      const error = modelKeyError(provider, key);
      if (error) throw new ConnectionError(error);
      const value = modelKeyCredential(provider, key, settings);
      remember(value);
      return tracked(provider, 'api_key', async () => {
        await checkStorage();
        if (backend.connectKey) {
          const connected = await backend.connectKey(provider, value).catch((error) => {
            if (error instanceof ModelWorkspaceSelectionError) throw error;
            throw new ConnectionError(
              createTextRedactor([...secrets])(
                error instanceof Error ? error.message : String(error),
              ).slice(0, 2000),
            );
          });
          return save(provider, 'api_key', connected.credential, connected.models);
        }
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
        const definitions = await catalog('compatible', 'api_key', value);
        if (!definitions.length)
          throw new ConnectionError(
            'This server has no models Nod can use. Nod needs models with tool support.',
          );
        return save('compatible', 'api_key', value, definitions);
      });
    },
    async select(input: ModelSelection, actor: SettingActor = 'owner', client?: PoolClient) {
      const value = modelSelectionInput.parse(input);
      checked = undefined;
      const capture = snapshotAnalytics(analytics);
      const changed = await store.change(
        (state) => {
          const row = state.connections.find((item) => item.id === value.connectionId);
          const model =
            row?.status === 'connected' &&
            row.models.find((item) => item.choice.id === value.modelId);
          if (!row || !model || !model.choice.efforts.includes(value.effort))
            throw new ConnectionError('Choose an available model and effort.');
          if (model.choice.audio && !textCompanion(row)) throw missingTextCompanion();
          const changed = {
            model:
              state.selection?.connectionId !== value.connectionId ||
              state.selection?.modelId !== value.modelId,
            effort: state.selection?.effort !== value.effort,
          };
          state.selection = value;
          state.selectionSet = true;
          return changed;
        },
        undefined,
        client,
      );
      const apply = () => {
        selection = value;
      };
      if (changed.model)
        capture?.({
          event: 'setting_changed',
          properties: { setting: 'model_selection', actor, state: 'configured' },
        });
      if (changed.effort)
        capture?.({
          event: 'setting_changed',
          properties: { setting: 'model_effort', actor, state: value.effort },
        });
      await settle(client, apply);
    },
    async remove(id: string) {
      const capture = snapshotAnalytics(analytics);
      for (const [state, attempt] of attempts)
        if (attempt.connectionId === id) await cancel(state, 'connection_removed');
      const removed = await store.change((state) => {
        const row = state.connections.find((item) => item.id === id);
        if (row?.managed)
          throw new ConnectionError('This connection is managed in server settings.');
        state.connections = state.connections.filter((item) => item.id !== id);
        const selectionCleared = state.selection?.connectionId === id;
        if (selectionCleared) state.selection = null;
        state.routes = Object.fromEntries(
          Object.entries(state.routes).filter(
            ([, route]) => route === 'light' || route?.connectionId !== id,
          ),
        );
        state.backups = state.backups.filter((choice) => choice.connectionId !== id);
        return { row, selectionCleared };
      });
      if (removed.selectionCleared)
        for (const setting of ['model_selection', 'model_effort'] as const)
          capture?.({
            event: 'setting_changed',
            properties: { setting, actor: 'owner', state: 'cleared' },
          });
      await reload();
      if (removed.row && capture)
        connectionChanged(removed.row.provider, removed.row.method, 'disconnected', capture);
    },
    analyticsConnections() {
      return rows.flatMap((row) => {
        const provider = row.provider;
        if (provider === 'elevenlabs') return [];
        const selected = row.id === selection?.connectionId;
        return [
          {
            provider,
            method: row.method,
            selected,
            ...(selected && selection
              ? {
                  ...analyticsModel(provider, selection.modelId),
                  provider,
                  effort: selection.effort,
                }
              : {}),
          },
        ];
      });
    },
    refreshCatalog,
    hasApiKey(provider: ModelProvider) {
      return Boolean(apiKeyConnection(provider));
    },
    async apiCredential(provider: ModelProvider) {
      const row = apiKeyConnection(provider);
      const value = row && (await read(row.id));
      return value?.type === 'api_key' ? value : undefined;
    },
    async apiKey(provider: ModelProvider) {
      return (await service.apiCredential(provider))?.key;
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
        ...requestAccess(row),
        needsReconnect: (credential) => needsReconnect(row.id, { models: row.models, credential }),
      };
    },
    hasClassificationModel(otherConnections = false) {
      return Boolean(classificationModel(otherConnections));
    },
    async resolveClassification(otherConnections = false): Promise<ModelAccess | undefined> {
      const candidate = classificationModel(otherConnections);
      if (!candidate) return undefined;
      const { row, definition } = candidate;
      return {
        provider: row.provider,
        method: row.method,
        definition,
        effort: lightestEffort(definition.choice.efforts),
        ...requestAccess(row),
        needsReconnect: (credential) => needsReconnect(row.id, { models: row.models, credential }),
      };
    },
    reserve,
    setRequestBudget(reserve: NonNullable<ModelAccess['reserve']>) {
      requestBudget = reserve;
    },
    async setSelectionCheck(check: () => Promise<unknown>) {
      selectionCheck = check;
      if (initialized)
        await store
          .read()
          .then(checkSelection, (error: unknown) => logFailure('model_check_failed', error));
    },
    async resolve(
      auxiliary = false,
      choice: ModelSelection | null = selection,
    ): Promise<ModelAccess> {
      const { selected, row, definition, companion } = chosen(auxiliary, choice);
      return {
        connectionId: row.id,
        provider: row.provider,
        method: row.method,
        definition,
        effort: auxiliary ? auxiliaryEffort(definition.choice.efforts) : selected.effort,
        ...(companion
          ? {
              textModel: {
                definition: companion,
                effort: auxiliary
                  ? lightestEffort(companion.choice.efforts)
                  : defaultEffort(companion.choice),
              },
            }
          : {}),
        ...requestAccess(row),
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
        routes.setErrorHandler((error, _request, reply) => {
          if (error instanceof z.ZodError)
            return reply.code(400).send({ error: 'Check the supplied values.' });
          if (!(error instanceof ConnectionError || error instanceof ModelAuthError)) throw error;
          return reply.code(400).send({
            error: error.message,
            ...(error instanceof ModelWorkspaceSelectionError
              ? { workspaces: error.workspaces }
              : {}),
          });
        });
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
        routes.put('/api/models/backups', async (request) => {
          const input = z.object({ backups: modelBackupsInput }).strict().parse(request.body);
          await service.setBackups(input.backups);
          return service.view();
        });
        routes.put('/api/models/routes', async (request) => {
          const input = z
            .object({ lane: z.enum(['schedule', 'background']), route: modelRouteInput })
            .strict()
            .parse(request.body);
          await service.setRoute(input.lane, input.route);
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
              'client_cancelled',
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
          let provider: 'ChatGPT' | 'OpenRouter' | undefined;
          try {
            const connected = await completeCallback(new URL(request.url, options.origin));
            provider = connected === 'openai' ? 'ChatGPT' : 'OpenRouter';
            succeeded = true;
          } catch {}
          const page = signInPage(succeeded, randomUUID(), provider);
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
      await Promise.all([...attempts.keys()].map((state) => cancel(state, 'shutdown')));
      observers.clear();
      secrets.clear();
    },
  };
  return service;
}
