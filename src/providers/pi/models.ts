import { createHash, randomBytes } from 'node:crypto';
import { createServer } from 'node:http';
import {
  getSupportedThinkingLevels,
  type Api,
  type Model,
  type CredentialStore,
} from '@earendil-works/pi-ai';
import { ModelRuntime, type ProviderModelConfig } from '@earendil-works/pi-coding-agent';
import { Agent, Dispatcher1Wrapper } from 'undici';
import { z } from 'zod';
import { createRemoteJWKSet, customFetch, jwtVerify } from 'jose';
import { ModelAuthError } from '../../ports/models.ts';
import type {
  ModelAccess,
  ModelBackend,
  ModelCredential,
  ModelDefinition,
} from '../../ports/models.ts';
import {
  bedrockRegionPattern,
  modelProviderNames,
  type ModelProvider,
  type ModelMethod,
} from '../../shared/models.ts';
import { signInPage } from '../../shared/sign-in-page.ts';
import type { PiModelCall } from './traces.ts';

const resource = 'https://api.openai.com/v1';
const issuer = 'https://auth.openai.com';
const callbackUrl = 'http://127.0.0.1:1455/auth/callback';
const registration = 'dynamic_agent_client';
const planScope = 'chatgpt.tokens.use.direct';
const random = () => randomBytes(32).toString('base64url');
const emailSchema = z.string().trim().max(320).email().optional().catch(undefined);
const chatgptCredentialSchema = z.object({
  type: z.literal('oauth'),
  access: z.string().min(1).max(32000),
  refresh: z.string().min(1).max(32000),
  expires: z.number().positive().finite(),
  accountId: z.string().min(1).max(1000),
  clientId: z.string().min(1).max(1000),
  idToken: z.string().min(1).max(32000),
  email: emailSchema,
});
const tokenSchema = z.object({
  access_token: z.string().min(1).max(32000),
  refresh_token: z.string().min(1).max(32000),
  id_token: z.string().min(1).max(32000).optional(),
  expires_in: z.number().positive().max(31536000),
  scope: z.string().max(2000),
});

class TokenRejected extends Error {
  constructor(
    readonly statusCode: number,
    readonly code?: string,
  ) {
    super('The ChatGPT token request was rejected.');
  }
}

function chatgptCredential(value: unknown) {
  const parsed = chatgptCredentialSchema.safeParse(value);
  if (!parsed.success)
    throw new ModelAuthError('Reconnect your ChatGPT account in Settings > Models.', true);
  return parsed.data;
}

function entries<T>(value: unknown, schema: z.ZodType<T>) {
  return z
    .array(z.unknown())
    .parse(value)
    .flatMap((item) => {
      const parsed = schema.safeParse(item);
      return parsed.success ? [parsed.data] : [];
    });
}

async function modelListRestricted(response: Response) {
  const reader = response.body?.getReader();
  if (!reader) return false;
  const chunks: Uint8Array[] = [];
  let bytes = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      bytes += value.length;
      if (bytes > 4096) return false;
      chunks.push(value);
    }
    const body = z
      .object({ error: z.union([z.string(), z.object({ message: z.string() })]) })
      .parse(JSON.parse(Buffer.concat(chunks).toString('utf8')));
    const message = typeof body.error === 'string' ? body.error : body.error.message;
    const scopes = [...message.matchAll(/\bMissing scopes:\s*([\s\S]*?)(?:\.(?=\s|$)|$)/g)];
    return scopes.length === 1 && scopes[0][1].trim() === 'api.model.read';
  } catch {
    return false;
  } finally {
    await reader.cancel().catch(() => {});
  }
}

const levels = ['minimal', 'low', 'medium', 'high', 'xhigh', 'max'] as const;
let endpointConnections: Dispatcher1Wrapper | undefined;
const keyless = 'nod-no-key';
const ollamaShowSchema = z.object({
  capabilities: z.array(z.string()).catch([]),
  model_info: z.record(z.string(), z.unknown()).catch({}),
  parameters: z.string().catch(''),
  thinking: z
    .object({ values: z.array(z.union([z.string(), z.boolean()])) })
    .optional()
    .catch(undefined),
});

function ollamaModel(show: z.infer<typeof ollamaShowSchema>) {
  const trained = Object.entries(show.model_info).find(
    ([key, value]) => key.endsWith('.context_length') && typeof value === 'number' && value > 0,
  )?.[1] as number | undefined;
  const configured = Number(/^num_ctx\s+(\d+)$/m.exec(show.parameters)?.[1]) || undefined;
  const contextWindow = Math.min(trained ?? Infinity, configured ?? Infinity);
  const values = show.thinking?.values;
  const named = levels.filter((level) => values?.includes(level));
  const thinkingLevelMap = !show.capabilities.includes('thinking')
    ? undefined
    : !values
      ? { off: 'none' }
      : named.length
        ? {
            off: values.includes(false) || values.includes('none') ? 'none' : null,
            ...Object.fromEntries(
              levels.map((level) => [level, named.includes(level) ? level : null]),
            ),
          }
        : values.includes(true)
          ? {
              off: 'none',
              ...Object.fromEntries(
                levels.map((level) => [level, level === 'high' ? 'high' : null]),
              ),
            }
          : undefined;
  return {
    usable: show.capabilities.includes('tools'),
    images: show.capabilities.includes('vision'),
    contextWindow: Number.isFinite(contextWindow) ? contextWindow : undefined,
    reasoning: !!thinkingLevelMap,
    thinkingLevelMap,
  };
}

const lmStudioModelSchema = z.object({
  key: z.string(),
  type: z.string(),
  max_context_length: z.number().int().positive().optional().catch(undefined),
  loaded_instances: z
    .array(z.object({ config: z.object({ context_length: z.number().int().positive() }) }))
    .catch([]),
  capabilities: z
    .object({
      vision: z.boolean().catch(false),
      trained_for_tool_use: z.boolean().optional().catch(undefined),
    })
    .catch({ vision: false }),
});

function lmStudioModel(model: z.infer<typeof lmStudioModelSchema>) {
  return {
    usable:
      ['llm', 'vlm'].includes(model.type) && model.capabilities.trained_for_tool_use !== false,
    images: model.capabilities.vision || model.type === 'vlm',
    contextWindow: model.loaded_instances[0]?.config.context_length ?? model.max_context_length,
    reasoning: false,
    thinkingLevelMap: undefined,
  };
}

export function createPiModelBackend(options: { fetch?: typeof fetch } = {}): ModelBackend {
  const request = options.fetch ?? fetch;
  let catalogRuntime: Promise<ModelRuntime> | undefined;
  const runtime = () =>
    (catalogRuntime ??= ModelRuntime.create({
      modelsPath: null,
      refreshOnCreate: false,
      allowModelNetwork: false,
    }));
  async function jsonResponse(response: Response) {
    if (!response.ok)
      throw new Error(
        'The model service rejected the request. Check the connection and account access.',
      );
    return response.json();
  }
  async function json(url: string, init: RequestInit = {}) {
    return jsonResponse(await request(url, { ...init, signal: AbortSignal.timeout(15000) }));
  }
  const keys = createRemoteJWKSet(new URL(`${issuer}/.well-known/jwks.json`), {
    [customFetch]: request,
  });
  async function tokens(body: Record<string, string>, signal: AbortSignal) {
    const response = await request(`${issuer}/api/accounts/oauth/token`, {
      method: 'POST',
      headers: {
        Accept: 'application/json',
        'Content-Type': 'application/x-www-form-urlencoded',
      },
      body: new URLSearchParams({ ...body, resource }),
      redirect: 'error',
      signal,
    });
    if (!response.ok) {
      const code = z
        .object({ error: z.string().regex(/^[a-z_]{1,64}$/) })
        .safeParse(await response.json().catch(() => undefined)).data?.error;
      throw new TokenRejected(response.status, code);
    }
    const token = tokenSchema.parse(await response.json());
    if (!token.scope.split(/\s+/).includes(planScope))
      throw new ModelAuthError('Allow nod to use your ChatGPT plan, then try again.', true);
    return token;
  }
  function definition(model: Model<Api>): ModelDefinition {
    return {
      choice: {
        id: model.id,
        name: model.name,
        efforts: getSupportedThinkingLevels(model),
        images: model.input.includes('image'),
        contextWindow: model.contextWindow,
      },
      spec: JSON.parse(JSON.stringify(model)),
    };
  }
  async function endpointCatalog(credential?: ModelCredential) {
    if (credential?.type !== 'endpoint') throw new Error('Add the server address in Models.');
    const headers: Record<string, string> = credential.key
      ? { Authorization: `Bearer ${credential.key}` }
      : {};
    let found: { url: string; data: unknown[] } | undefined;
    for (const url of credential.url.endsWith('/v1')
      ? [credential.url]
      : [credential.url, `${credential.url}/v1`]) {
      const response = await request(`${url}/models`, {
        headers,
        redirect: 'error',
        signal: AbortSignal.timeout(15000),
      });
      const list = z
        .object({ data: z.array(z.unknown()) })
        .safeParse(response.ok ? await response.json().catch(() => undefined) : undefined);
      if (list.success) {
        found = { url, data: list.data.data };
        break;
      }
    }
    if (!found) throw new Error('The server’s model list could not be loaded.');
    const size = z.number().int().positive().optional().catch(undefined);
    const listed = entries(
      found.data,
      z.object({
        id: z.string().min(1).max(200),
        context_length: size,
        context_window: size,
        max_model_len: size,
      }),
    );
    const root = found.url.replace(/\/v1$/, '');
    const serverJson = (path: string, init: RequestInit = {}) =>
      request(`${root}${path}`, {
        ...init,
        headers: { ...headers, ...init.headers },
        redirect: 'error',
        signal: AbortSignal.timeout(15000),
      })
        .then((response) => (response.ok ? response.json() : undefined))
        .catch(() => undefined);
    const ollama = z
      .object({ version: z.string() })
      .safeParse(await serverJson('/api/version')).success;
    const studio = ollama
      ? undefined
      : z.object({ models: z.array(z.unknown()) }).safeParse(await serverJson('/api/v1/models'))
          .data?.models;
    const studioModels = studio ? entries(studio, lmStudioModelSchema) : [];
    const models = await Promise.all(
      listed.map(async (entry) => {
        const shown = ollama
          ? ollamaShowSchema.safeParse(
              await serverJson('/api/show', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ model: entry.id }),
              }),
            )
          : undefined;
        const studioModel = studioModels.find((model) => model.key === entry.id);
        const known = shown?.success
          ? ollamaModel(shown.data)
          : studioModel
            ? lmStudioModel(studioModel)
            : undefined;
        if (known && !known.usable) return [];
        const contextWindow =
          known?.contextWindow ??
          entry.context_length ??
          entry.context_window ??
          entry.max_model_len ??
          128_000;
        return [
          definition({
            id: entry.id,
            name: entry.id,
            api: 'openai-completions',
            provider: 'compatible',
            baseUrl: found.url,
            compat: {
              supportsStore: false,
              supportsDeveloperRole: false,
              maxTokensField: 'max_tokens',
            },
            reasoning: known?.reasoning ?? false,
            thinkingLevelMap: known?.thinkingLevelMap,
            input: known?.images ? ['text', 'image'] : ['text'],
            contextWindow,
            maxTokens: Math.min(32_768, Math.floor(contextWindow / 2)),
            cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
          } as Model<Api>),
        ];
      }),
    );
    return models.flat();
  }
  async function cloudResponse(url: string, init: RequestInit, rejected: string) {
    const response = await request(url, {
      ...init,
      redirect: 'error',
      signal: AbortSignal.timeout(15000),
    });
    if ([400, 401, 403, 404].includes(response.status)) {
      await response.body?.cancel();
      throw new ModelAuthError(rejected);
    }
    return response;
  }
  async function bedrockCatalog(local: readonly Model<Api>[], credential: ModelCredential) {
    if (credential.type !== 'bedrock' || !bedrockRegionPattern.test(credential.region))
      throw new Error('This model connection is unavailable.');
    const root = `https://bedrock.${credential.region}.amazonaws.com`;
    const list = async (path: string) =>
      jsonResponse(
        await cloudResponse(
          `${root}${path}`,
          { headers: { Authorization: `Bearer ${credential.key}` } },
          'Amazon Bedrock didn’t accept this key in that Region. Check both, and that the key can list models.',
        ),
      );
    const available = new Set(
      entries(
        (await list('/foundation-models?byInferenceType=ON_DEMAND&byOutputModality=TEXT'))
          .modelSummaries,
        z.object({ modelId: z.string() }),
      ).map((model) => model.modelId),
    );
    let page: string | undefined;
    do {
      const profiles = await list(
        `/inference-profiles?type=SYSTEM_DEFINED&maxResults=1000${page ? `&nextToken=${encodeURIComponent(page)}` : ''}`,
      );
      for (const profile of entries(
        profiles.inferenceProfileSummaries,
        z.object({ inferenceProfileId: z.string(), status: z.literal('ACTIVE') }),
      ))
        available.add(profile.inferenceProfileId);
      page =
        typeof profiles.nextToken === 'string' && profiles.nextToken !== page
          ? profiles.nextToken
          : undefined;
    } while (page);
    return local.filter((model) => available.has(model.id)).map(definition);
  }
  async function vertexCatalog(local: readonly Model<Api>[], credential: ModelCredential) {
    if (credential.type !== 'api_key' || !local.length)
      throw new Error('This model connection is unavailable.');
    const response = await request(
      `https://aiplatform.googleapis.com/v1/publishers/google/models/${local[0].id}:countTokens`,
      {
        method: 'POST',
        headers: { 'x-goog-api-key': credential.key, 'Content-Type': 'application/json' },
        body: JSON.stringify({ contents: [{ role: 'user', parts: [{ text: 'nod' }] }] }),
        redirect: 'error',
        signal: AbortSignal.timeout(15000),
      },
    );
    await response.body?.cancel();
    if ([400, 401, 403].includes(response.status))
      throw new ModelAuthError('Google Vertex AI didn’t accept this API key.');
    if (!response.ok && response.status !== 404)
      throw new Error('The model service is temporarily unavailable. Try again.');
    return local.map(definition);
  }
  async function azureCatalog(local: readonly Model<Api>[], credential: ModelCredential) {
    if (credential.type !== 'azure') throw new Error('This model connection is unavailable.');
    const model = local.find((item) => item.id === credential.model);
    if (!model) throw new Error('This model connection is unavailable.');
    await jsonResponse(
      await cloudResponse(
        `${credential.url}/models`,
        { headers: { 'api-key': credential.key } },
        'This Azure OpenAI endpoint didn’t accept the key. Check the endpoint and the key.',
      ),
    );
    return [definition({ ...model, baseUrl: credential.url })];
  }
  return {
    async signIn({ signal: requestedSignal, hostId, previous }) {
      const controller = new AbortController();
      const signal = AbortSignal.any([requestedSignal, controller.signal]);
      const canceled = () => new ModelAuthError('ChatGPT sign-in was canceled.');
      if (signal.aborted) throw canceled();
      const saved = chatgptCredentialSchema.safeParse(previous).data;
      const state = random();
      const nonce = random();
      const verifier = random();
      const url = new URL(`${issuer}/api/accounts/authorize`);
      url.search = new URLSearchParams({
        client_id: saved?.clientId ?? registration,
        ...(saved
          ? { id_token_hint: saved.idToken, ...(saved.email ? { login_hint: saved.email } : {}) }
          : { agent_name_hint: 'nod' }),
        ext_agent_host_id: `urn:uuid:${hostId}`,
        response_type: 'code',
        redirect_uri: callbackUrl,
        scope: `openid profile email offline_access resource.invoke ${planScope}`,
        resource,
        state,
        nonce,
        code_challenge: createHash('sha256').update(verifier).digest('base64url'),
        code_challenge_method: 'S256',
      }).toString();
      let settled = false;
      let claimed = false;
      let grant!: (value: { code: string; clientId: string }) => void;
      let refuse!: (error: Error) => void;
      const granted = new Promise<{ code: string; clientId: string }>((resolve, reject) => {
        grant = resolve;
        refuse = reject;
      });
      granted.catch(() => {});
      const abort = () => refuse(canceled());
      signal.addEventListener('abort', abort, { once: true });
      const expected = new URL(callbackUrl);
      const complete = (callback: URL) => {
        if (settled || claimed || signal.aborted)
          throw new ModelAuthError('This sign-in request has expired. Start a new connection.');
        if (
          callback.origin !== expected.origin ||
          callback.pathname !== expected.pathname ||
          callback.username ||
          callback.password ||
          callback.hash ||
          callback.searchParams.getAll('state').length !== 1 ||
          callback.searchParams.get('state') !== state
        )
          throw new ModelAuthError('This sign-in callback is invalid or was declined.');
        if (callback.searchParams.has('error')) {
          if (
            callback.searchParams.getAll('error').length !== 1 ||
            !callback.searchParams.get('error') ||
            callback.searchParams.has('code')
          )
            throw new ModelAuthError('This sign-in callback is invalid.');
          const declined = canceled();
          claimed = true;
          refuse(declined);
          throw declined;
        }
        const codes = callback.searchParams.getAll('code');
        const issued = callback.searchParams.getAll('client_id');
        const clientId = saved
          ? issued.length === 0 || (issued.length === 1 && issued[0] === saved.clientId)
            ? saved.clientId
            : undefined
          : issued.length === 1 && issued[0] && issued[0] !== registration
            ? issued[0]
            : undefined;
        if (codes.length !== 1 || !codes[0] || !clientId)
          throw new ModelAuthError('This sign-in callback is invalid.');
        claimed = true;
        grant({ code: codes[0], clientId });
      };
      let exchange!: Promise<ModelCredential>;
      const server = createServer((request, response) => {
        const send = (status: number) => {
          const page = signInPage(status === 200, random());
          response.writeHead(status, { ...page.headers, Connection: 'close' });
          response.end(page.html);
        };
        try {
          const callback = new URL(request.url ?? '/', callbackUrl);
          if (request.method !== 'GET' || callback.pathname !== expected.pathname) {
            send(404);
            return;
          }
          complete(callback);
          void exchange.then(
            () => send(200),
            () => send(400),
          );
        } catch {
          send(400);
        }
      });
      let closing: Promise<void> | undefined;
      const close = () =>
        (closing ??= new Promise<void>((resolve) => {
          const timeout = setTimeout(() => server.closeAllConnections(), 1000);
          timeout.unref();
          server.close(() => {
            clearTimeout(timeout);
            resolve();
          });
          server.closeIdleConnections();
        }));
      try {
        await new Promise<void>((resolve, reject) => {
          server.once('error', reject);
          server.listen(Number(expected.port), expected.hostname, () => {
            server.off('error', reject);
            resolve();
          });
        });
        server.on('error', () => controller.abort());
        if (signal.aborted) throw canceled();
      } catch (error) {
        signal.removeEventListener('abort', abort);
        await close();
        if (error instanceof ModelAuthError) throw error;
        throw new ModelAuthError(
          error instanceof Error && 'code' in error && error.code === 'EADDRINUSE'
            ? 'Port 1455 is already in use. Close the other nod app or another sign-in, then try again.'
            : 'ChatGPT sign-in couldn’t start. Try again.',
        );
      }
      exchange = (async (): Promise<ModelCredential> => {
        try {
          const { code, clientId } = await granted;
          const token = await tokens(
            {
              grant_type: 'authorization_code',
              client_id: clientId,
              code,
              code_verifier: verifier,
              redirect_uri: callbackUrl,
            },
            signal,
          );
          if (!token.id_token) throw new Error('Missing ID token.');
          const { payload } = await jwtVerify(token.id_token, keys, {
            issuer,
            audience: clientId,
            algorithms: ['RS256'],
            requiredClaims: ['sub', 'exp'],
          });
          if (payload.nonce !== nonce || typeof payload.sub !== 'string' || !payload.sub)
            throw new Error('Invalid ID token.');
          if (saved && payload.sub !== saved.accountId)
            throw new ModelAuthError(
              'That’s a different ChatGPT account. Add it as a new connection instead.',
            );
          return {
            type: 'oauth',
            access: token.access_token,
            refresh: token.refresh_token,
            expires: Date.now() + token.expires_in * 1000,
            accountId: payload.sub,
            clientId,
            idToken: token.id_token,
            email: emailSchema.parse(payload.email),
          };
        } catch (error) {
          if (error instanceof ModelAuthError) throw error;
          throw new ModelAuthError(
            signal.aborted
              ? 'ChatGPT sign-in was canceled.'
              : error instanceof TokenRejected && error.code === 'invalid_grant'
                ? 'OpenAI didn’t approve this connection. Use a ChatGPT Plus or Pro plan, or add an API key.'
                : 'ChatGPT sign-in didn’t finish. Try again.',
            false,
            { cause: error },
          );
        }
      })();
      const result = exchange.finally(async () => {
        settled = true;
        signal.removeEventListener('abort', abort);
        await close();
      });
      exchange.catch(() => {});
      result.catch(() => {});
      return { url: url.toString(), state, result, complete };
    },
    async catalog(provider: ModelProvider, method: ModelMethod, credential?: ModelCredential) {
      if (provider === 'compatible') return endpointCatalog(credential);
      const local = (await runtime()).getModels(provider);
      if (!credential) return local.map(definition);
      if (provider === 'amazon-bedrock') return bedrockCatalog(local, credential);
      if (provider === 'google-vertex') return vertexCatalog(local, credential);
      if (provider === 'azure') return azureCatalog(local, credential);
      if (credential.type !== 'api_key' && credential.type !== 'oauth')
        throw new Error('This model connection is unavailable.');
      if (method === 'subscription') chatgptCredential(credential);
      const key = credential.type === 'api_key' ? credential.key : credential.access;
      const url =
        provider === 'openrouter'
          ? 'https://openrouter.ai/api/v1/models'
          : provider === 'anthropic'
            ? 'https://api.anthropic.com/v1/models?limit=1000'
            : `${resource}/models`;
      const headers: Record<string, string> =
        provider === 'anthropic'
          ? { 'x-api-key': key, 'anthropic-version': '2023-06-01' }
          : { Authorization: `Bearer ${key}` };
      const accepted = async (response: Response) => {
        if (response.status !== 401) return response;
        await response.body?.cancel();
        throw method === 'subscription'
          ? new ModelAuthError('Reconnect your ChatGPT account in Settings > Models.', true)
          : new ModelAuthError(
              `${modelProviderNames[provider]} didn’t accept this API key. Check it and try again.`,
            );
      };
      if (provider === 'openrouter') {
        const account = z
          .object({
            data: z.object({
              is_management_key: z.boolean().optional(),
              is_provisioning_key: z.boolean().optional(),
            }),
          })
          .parse(
            await jsonResponse(
              await accepted(
                await request('https://openrouter.ai/api/v1/key', {
                  headers,
                  signal: AbortSignal.timeout(15000),
                }),
              ),
            ),
          );
        if (account.data.is_management_key || account.data.is_provisioning_key)
          throw new ModelAuthError('Use an inference key for OpenRouter.');
      }
      const response = await accepted(
        await request(url, {
          headers,
          signal: AbortSignal.timeout(15000),
          redirect: 'error',
        }),
      );
      if (
        provider === 'openai' &&
        method === 'api_key' &&
        credential.type === 'api_key' &&
        response.status === 403 &&
        (await modelListRestricted(response))
      )
        return local.map(definition);
      const data = await jsonResponse(response);
      if (provider !== 'openrouter') {
        const list = entries(
          method === 'subscription' ? data.models : data.data,
          z.object({
            id: z.string().optional(),
            slug: z.string().optional(),
            visibility: z.string().optional(),
          }),
        );
        const ids = new Set(
          list.filter((m) => !m.visibility || m.visibility === 'list').map((m) => m.slug ?? m.id),
        );
        return local.filter((m) => ids.has(m.id)).map(definition);
      }
      const list = entries(
        data.data,
        z.object({
          id: z.string(),
          name: z.string(),
          context_length: z.number().positive(),
          supported_parameters: z.array(z.string()),
          architecture: z.object({
            input_modalities: z.array(z.string()),
            output_modalities: z.array(z.string()),
          }),
          top_provider: z
            .object({ max_completion_tokens: z.number().nullable().optional() })
            .optional(),
          reasoning: z.object({ supported_efforts: z.array(z.string()).optional() }).optional(),
          pricing: z.object({
            prompt: z.coerce.number().finite(),
            completion: z.coerce.number().finite(),
            input_cache_read: z.coerce.number().nonnegative().finite().optional(),
            input_cache_write: z.coerce.number().nonnegative().finite().optional(),
          }),
        }),
      );
      return list
        .filter(
          (m) =>
            m.supported_parameters.includes('tools') &&
            m.architecture.input_modalities.includes('text') &&
            m.architecture.output_modalities.includes('text') &&
            !m.id.includes(':batch'),
        )
        .map((m) => {
          const known = local.find((model) => model.id === m.id);
          const reasoning =
            m.supported_parameters.includes('reasoning') ||
            m.supported_parameters.includes('reasoning_effort');
          const map = m.reasoning?.supported_efforts
            ? Object.fromEntries(
                ['off', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'].map((level) => [
                  level,
                  m.reasoning!.supported_efforts!.includes(level === 'off' ? 'none' : level)
                    ? level === 'off'
                      ? 'none'
                      : level
                    : null,
                ]),
              )
            : known?.thinkingLevelMap;
          return definition({
            ...known,
            id: m.id,
            name: m.name,
            api: known?.api ?? 'openai-completions',
            provider,
            baseUrl: known?.baseUrl ?? 'https://openrouter.ai/api/v1',
            compat: known?.compat ?? { thinkingFormat: 'openrouter' },
            reasoning,
            input: m.architecture.input_modalities.includes('image') ? ['text', 'image'] : ['text'],
            contextWindow: m.context_length,
            maxTokens:
              m.top_provider?.max_completion_tokens ??
              known?.maxTokens ??
              Math.min(32_768, Math.floor(m.context_length / 2)),
            cost: {
              input: m.pricing.prompt * 1000000,
              output: m.pricing.completion * 1000000,
              cacheRead:
                m.pricing.input_cache_read !== undefined
                  ? m.pricing.input_cache_read * 1000000
                  : (known?.cost.cacheRead ?? 0),
              cacheWrite:
                m.pricing.input_cache_write !== undefined
                  ? m.pricing.input_cache_write * 1000000
                  : (known?.cost.cacheWrite ?? 0),
            },
            thinkingLevelMap: map,
          } as Model<Api>);
        });
    },
    authorize({ redirectUri }) {
      const state = random();
      const verifier = random();
      const challenge = createHash('sha256').update(verifier).digest('base64url');
      const url = new URL('https://openrouter.ai/auth');
      url.search = new URLSearchParams({
        callback_url: redirectUri,
        state,
        code_challenge: challenge,
        code_challenge_method: 'S256',
        key_label: 'nod',
      }).toString();
      return { url: url.toString(), state, secret: { state, verifier, redirectUri } };
    },
    async exchange(_provider, secret, callback) {
      const s = z
        .object({ state: z.string(), verifier: z.string(), redirectUri: z.string() })
        .parse(secret);
      if (
        callback.searchParams.getAll('state').length !== 1 ||
        callback.searchParams.get('state') !== s.state ||
        callback.searchParams.has('error') ||
        callback.searchParams.getAll('code').length !== 1
      )
        throw new Error('This sign-in request is invalid or was declined.');
      const expected = new URL(s.redirectUri);
      if (callback.origin !== expected.origin || callback.pathname !== expected.pathname)
        throw new Error('Invalid sign-in callback.');
      const result = z.object({ key: z.string().min(1).max(32000) }).parse(
        await json('https://openrouter.ai/api/v1/auth/keys', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            code: callback.searchParams.get('code')!,
            code_verifier: s.verifier,
            code_challenge_method: 'S256',
          }),
        }),
      );
      return { type: 'api_key', key: result.key };
    },
    async refresh(credential) {
      if (credential.type !== 'oauth') return credential;
      const current = chatgptCredential(credential);
      try {
        const token = await tokens(
          {
            grant_type: 'refresh_token',
            client_id: current.clientId,
            refresh_token: current.refresh,
          },
          AbortSignal.timeout(15000),
        );
        return {
          ...current,
          access: token.access_token,
          refresh: token.refresh_token,
          expires: Date.now() + token.expires_in * 1000,
        };
      } catch (error) {
        if (error instanceof ModelAuthError) throw error;
        const terminal =
          error instanceof TokenRejected && [400, 401, 403].includes(error.statusCode);
        throw new ModelAuthError(
          terminal
            ? 'Reconnect your ChatGPT account in Settings > Models.'
            : 'ChatGPT is temporarily unavailable. Try again.',
          terminal,
          { cause: error },
        );
      }
    },
  };
}

export async function createPiModelRuntime(
  access: ModelAccess,
  trace?: (call: PiModelCall) => void,
) {
  const subscription = access.method === 'subscription';
  const provider = access.provider;
  const reconnect = async (credential?: ModelCredential) => {
    await access.needsReconnect?.(credential);
    return new ModelAuthError('Reconnect your ChatGPT account in Settings > Models.', true);
  };
  if (
    subscription &&
    (provider !== 'openai' ||
      access.definition.spec.provider !== provider ||
      access.definition.spec.api !== 'openai-responses' ||
      access.definition.spec.baseUrl !== resource)
  )
    throw await reconnect();
  const secrets = new Set<string>();
  const credentials: CredentialStore = {
    async read(providerId): ReturnType<CredentialStore['read']> {
      if (providerId !== provider) return undefined;
      const credential = await access.read();
      if (!credential) throw new Error('The selected model connection is unavailable.');
      if (subscription) {
        const parsed = chatgptCredentialSchema.safeParse(credential);
        if (!parsed.success) throw await reconnect(credential);
        const value = parsed.data;
        for (const secret of [value.access, value.refresh, value.idToken]) secrets.add(secret);
        return { type: 'oauth', access: value.access, refresh: '', expires: value.expires };
      }
      if (credential.type === 'oauth')
        throw new Error('The selected model connection is unavailable.');
      if (credential.key) secrets.add(credential.key);
      if (credential.type === 'bedrock')
        return { type: 'api_key', key: credential.key, env: { AWS_REGION: credential.region } };
      if (credential.type === 'azure')
        return {
          type: 'api_key',
          key: credential.key,
          env: {
            AZURE_OPENAI_BASE_URL: credential.url,
            AZURE_OPENAI_API_VERSION: 'v1',
            AZURE_OPENAI_DEPLOYMENT_NAME_MAP: `${access.definition.choice.id}=${credential.deployment}`,
          },
        };
      return { type: 'api_key', key: credential.key || keyless };
    },
    async list() {
      return [{ providerId: provider, type: subscription ? 'oauth' : 'api_key' }];
    },
    async modify() {
      throw new Error('Model credentials are managed by nod.');
    },
    async delete() {
      throw new Error('Model credentials are managed by nod.');
    },
  };
  const runtime = await ModelRuntime.create({
    credentials,
    modelsPath: null,
    refreshOnCreate: false,
    allowModelNetwork: false,
  });
  runtime.registerProvider(provider, {
    models: [access.definition.spec as unknown as ProviderModelConfig],
  });
  await runtime.refresh({ allowNetwork: false });
  const stream = runtime.streamSimple.bind(runtime);
  runtime.streamSimple = (model, context, options) => {
    const events = stream(model, context, {
      ...options,
      maxRetries: 0,
      ...(access.provider === 'compatible'
        ? {
            fetch: (input: string | URL | Request, init?: RequestInit) => {
              const headers = new Headers(init?.headers);
              if (headers.get('authorization') === `Bearer ${keyless}`)
                headers.delete('authorization');
              return fetch(input, {
                ...init,
                headers,
                redirect: 'error',
                dispatcher: (endpointConnections ??= new Dispatcher1Wrapper(
                  new Agent({ headersTimeout: 0, bodyTimeout: 0 }),
                )),
              } as RequestInit);
            },
          }
        : {}),
      onPayload: async (payload, target) => {
        const changed = await options?.onPayload?.(payload, target);
        const body = (changed ?? payload) as Record<string, unknown>;
        if (access.provider === 'openrouter')
          body.provider = { require_parameters: true, allow_fallbacks: false };

        return body;
      },
    });
    const push = events.push.bind(events);
    events.push = (event) => {
      if (event.type === 'error')
        Object.assign(
          event.error,
          JSON.parse(
            JSON.stringify(event.error, (_key, value) => {
              if (typeof value !== 'string') return value;
              for (const secret of secrets) value = value.replaceAll(secret, '[redacted]');
              return value;
            }),
          ),
        );
      push(event);
    };
    if (trace) {
      const startedAt = new Date().toISOString();
      void events
        .result()
        .then((message) => trace({ model, context, message, startedAt }))
        .catch(() => {});
    }
    return events;
  };
  const model = runtime.getModel(provider, access.definition.choice.id);
  if (!model) throw new Error('The selected model is unavailable. Refresh the model list.');
  return { runtime, model };
}
