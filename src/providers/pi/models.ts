import { createHash, randomBytes } from 'node:crypto';
import {
  getSupportedThinkingLevels,
  type Api,
  type Model,
  type CredentialStore,
} from '@earendil-works/pi-ai';
import { ModelRuntime, type ProviderModelConfig } from '@earendil-works/pi-coding-agent';
import { z } from 'zod';
import { createRemoteJWKSet, customFetch, jwtVerify } from 'jose';
import type {
  ModelAccess,
  ModelBackend,
  ModelCredential,
  ModelDefinition,
} from '../../ports/models.ts';
import type { ModelProvider, ModelMethod } from '../../shared/models.ts';

const resource = 'https://api.openai.com/v1';
const tokenUrl = 'https://auth.openai.com/api/accounts/oauth/token';
const planScope = 'chatgpt.tokens.use.direct';
const random = () => randomBytes(32).toString('base64url');
const tokenSchema = z.object({
  access_token: z.string().min(1).max(32000),
  refresh_token: z.string().min(1).max(32000).optional(),
  id_token: z.string().min(1).max(32000).optional(),
  expires_in: z.number().positive().max(31536000),
  scope: z.string().optional(),
  token_type: z.literal('Bearer'),
});

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
  const jwks = createRemoteJWKSet(new URL('https://auth.openai.com/.well-known/jwks.json'), {
    [customFetch]: request,
  });
  async function identity(token: string, clientId: string, nonce?: string) {
    const { payload } = await jwtVerify(token, jwks, {
      issuer: 'https://auth.openai.com',
      audience: clientId,
      algorithms: ['RS256'],
      requiredClaims: ['sub', 'exp'],
    });
    const claims = z
      .object({
        sub: z.string().min(1),
        nonce: z.string().optional(),
        email: z.string().optional(),
      })
      .parse(payload);
    if (nonce !== undefined && claims.nonce !== nonce) throw new Error('Invalid account identity.');
    return claims;
  }
  async function tokens(
    body: URLSearchParams,
    previous?: Extract<ModelCredential, { type: 'oauth' }>,
    nonce?: string,
  ): Promise<ModelCredential> {
    const result = tokenSchema.parse(
      await json(tokenUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body,
      }),
    );
    const clientId = body.get('client_id')!;
    const claims = result.id_token ? await identity(result.id_token, clientId, nonce) : undefined;
    if (!previous && !claims) throw new Error('The sign-in did not return an account identity.');
    if (previous && claims && claims.sub !== previous.subject)
      throw new Error('The signed-in account changed.');
    const scopes = result.scope?.split(/\s+/) ?? previous?.scopes ?? [];
    if (!scopes.includes(planScope))
      throw new Error('This account did not grant ChatGPT plan use.');
    const refresh = result.refresh_token ?? previous?.refresh;
    if (!refresh) throw new Error('The sign-in did not return a refresh token.');
    return {
      type: 'oauth',
      access: result.access_token,
      refresh,
      expires: Date.now() + result.expires_in * 1000,
      clientId,
      subject: claims?.sub ?? previous!.subject,
      idToken: result.id_token ?? previous!.idToken,
      scopes,
      email: claims?.email ?? previous?.email,
    };
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
  return {
    async catalog(provider: ModelProvider, method: ModelMethod, credential?: ModelCredential) {
      const local = (await runtime()).getModels(provider);
      if (!credential) return local.map(definition);
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
      if (provider === 'openrouter') {
        const account = z
          .object({
            data: z.object({
              is_management_key: z.boolean().optional(),
              is_provisioning_key: z.boolean().optional(),
            }),
          })
          .parse(await json('https://openrouter.ai/api/v1/key', { headers }));
        if (account.data.is_management_key || account.data.is_provisioning_key)
          throw new Error('Use an inference key for OpenRouter.');
      }
      const response = await request(url, { headers, signal: AbortSignal.timeout(15000) });
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
        const list = z
          .array(
            z.object({
              id: z.string().optional(),
              slug: z.string().optional(),
              visibility: z.string().optional(),
            }),
          )
          .max(5000)
          .parse(method === 'subscription' ? data.models : data.data);
        const ids = new Set(
          list.filter((m) => !m.visibility || m.visibility === 'list').map((m) => m.slug ?? m.id),
        );
        return local
          .filter(
            (m) => ids.has(m.id) && (method !== 'subscription' || m.api === 'openai-responses'),
          )
          .map(definition);
      }
      const list = z
        .array(
          z.object({
            id: z.string().max(200),
            name: z.string().max(300),
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
        )
        .max(5000)
        .parse(data.data);
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
            maxTokens: m.top_provider?.max_completion_tokens ?? known?.maxTokens ?? 8192,
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
    authorize({ provider, redirectUri, hostId, previous }) {
      const state = random();
      const verifier = random();
      const nonce = random();
      const challenge = createHash('sha256').update(verifier).digest('base64url');
      const saved = previous?.type === 'oauth' ? previous : undefined;
      const url = new URL(
        provider === 'openai'
          ? 'https://auth.openai.com/api/accounts/authorize'
          : 'https://openrouter.ai/auth',
      );
      url.search = new URLSearchParams(
        provider === 'openai'
          ? {
              client_id: saved?.clientId ?? 'dynamic_agent_client',
              agent_name_hint: 'Otto',
              ext_agent_host_id: hostId,
              response_type: 'code',
              redirect_uri: redirectUri,
              resource,
              scope: `openid profile email offline_access resource.invoke ${planScope}`,
              state,
              nonce,
              code_challenge: challenge,
              code_challenge_method: 'S256',
              ...(saved ? { id_token_hint: saved.idToken } : {}),
            }
          : {
              callback_url: redirectUri,
              state,
              code_challenge: challenge,
              code_challenge_method: 'S256',
              key_label: 'Otto',
            },
      ).toString();
      return {
        url: url.toString(),
        state,
        secret: { state, verifier, nonce, redirectUri, ...(saved ? { previous: saved } : {}) },
      };
    },
    async exchange(provider, secret, callback) {
      const s = z
        .object({
          state: z.string(),
          verifier: z.string(),
          nonce: z.string(),
          redirectUri: z.string(),
          previous: z.unknown().optional(),
        })
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
      const code = callback.searchParams.get('code')!;
      if (provider === 'openrouter') {
        const result = z.object({ key: z.string().min(1).max(32000) }).parse(
          await json('https://openrouter.ai/api/v1/auth/keys', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              code,
              code_verifier: s.verifier,
              code_challenge_method: 'S256',
            }),
          }),
        );
        return { type: 'api_key', key: result.key };
      }
      const previous = s.previous as Extract<ModelCredential, { type: 'oauth' }> | undefined;
      const clientId = previous?.clientId ?? callback.searchParams.get('client_id');
      if (
        !clientId ||
        clientId === 'dynamic_agent_client' ||
        callback.searchParams.getAll('client_id').length > 1
      )
        throw new Error('The account registration is incomplete.');
      return tokens(
        new URLSearchParams({
          grant_type: 'authorization_code',
          client_id: clientId,
          code,
          code_verifier: s.verifier,
          redirect_uri: s.redirectUri,
          resource,
        }),
        previous,
        s.nonce,
      );
    },
    async refresh(credential) {
      if (credential.type === 'api_key') return credential;
      return tokens(
        new URLSearchParams({
          grant_type: 'refresh_token',
          client_id: credential.clientId,
          refresh_token: credential.refresh,
          resource,
        }),
        credential,
      );
    },
  };
}

export async function createPiModelRuntime(access: ModelAccess) {
  const credentials: CredentialStore = {
    async read(providerId) {
      if (providerId !== access.provider) return undefined;
      const credential = await access.read();
      if (!credential) throw new Error('The selected model connection is unavailable.');
      return {
        type: 'api_key',
        key: credential.type === 'api_key' ? credential.key : credential.access,
      };
    },
    async list() {
      return [{ providerId: access.provider, type: 'api_key' }];
    },
    async modify() {
      throw new Error('Model credentials are managed by Otto.');
    },
    async delete() {
      throw new Error('Model credentials are managed by Otto.');
    },
  };
  const runtime = await ModelRuntime.create({
    credentials,
    modelsPath: null,
    refreshOnCreate: false,
    allowModelNetwork: false,
  });
  runtime.registerProvider(access.provider, {
    models: [access.definition.spec as unknown as ProviderModelConfig],
  });
  await runtime.refresh({ allowNetwork: false });
  const stream = runtime.streamSimple.bind(runtime);
  runtime.streamSimple = (model, context, options) => {
    const events = stream(model, context, {
      ...options,
      maxRetries: 0,
      onPayload: async (payload, target) => {
        const changed = await options?.onPayload?.(payload, target);
        const body = (changed ?? payload) as Record<string, unknown>;
        if (access.provider === 'openrouter')
          body.provider = { require_parameters: true, allow_fallbacks: false };
        if (access.method === 'subscription') {
          for (const key of [
            'background',
            'conversation',
            'max_output_tokens',
            'max_tool_calls',
            'metadata',
            'moderation',
            'multi_agent',
            'prompt',
            'prompt_cache_retention',
            'safety_identifier',
            'temperature',
            'top_logprobs',
            'top_p',
            'truncation',
            'user',
            'previous_response_id',
          ])
            delete body[key];
          body.store = false;
          body.stream = true;
          if (Array.isArray(body.input))
            body.input = body.input.map((item) =>
              item.role === 'system' ? { ...item, role: 'developer' } : item,
            );
          if (Array.isArray(body.tools)) {
            const functions = body.tools.filter((tool) =>
              ['function', 'custom'].includes(tool.type),
            );
            body.tools = [
              ...body.tools.filter((tool) => !['function', 'custom'].includes(tool.type)),
              ...(functions.length
                ? [{ type: 'namespace', name: 'otto', description: 'Otto tools', tools: functions }]
                : []),
            ];
          }
        }
        return body;
      },
    });
    const push = events.push.bind(events);
    events.push = (event) => {
      if (event.type === 'error' && event.reason === 'error')
        event.error.errorMessage =
          'The model request failed. Check account access and limits in Models.';
      push(event);
    };
    return events;
  };
  const model = runtime.getModel(access.provider, access.definition.choice.id);
  if (!model) throw new Error('The selected model is unavailable. Refresh the model list.');
  return { runtime, model };
}
