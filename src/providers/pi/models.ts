import { createHash, randomBytes } from 'node:crypto';
import { createServer, type RequestListener } from 'node:http';
import {
  getSupportedThinkingLevels,
  type Api,
  type Model,
  type CredentialStore,
} from '@earendil-works/pi-ai';
import { ModelRuntime, type ProviderModelConfig } from '@earendil-works/pi-coding-agent';
import { z } from 'zod';
import { decodeJwt } from 'jose';
import { openaiCodexProvider } from '@earendil-works/pi-ai/providers/openai-codex';
import { ModelAuthError } from '../../ports/models.ts';
import type {
  ModelAccess,
  ModelBackend,
  ModelCredential,
  ModelDefinition,
} from '../../ports/models.ts';
import type { ModelProvider, ModelMethod } from '../../shared/models.ts';
import { signInPage } from '../../shared/sign-in-page.ts';

const resource = 'https://api.openai.com/v1';
const random = () => randomBytes(32).toString('base64url');
const emailSchema = z.string().trim().max(320).email().optional().catch(undefined);
const codexCredentialSchema = z.object({
  type: z.literal('oauth'),
  access: z.string().min(1).max(32000),
  refresh: z.string().min(1).max(32000),
  expires: z.number().positive().finite(),
  accountId: z.string().min(1).max(1000),
  email: emailSchema,
});

function codexCredential(value: unknown) {
  const parsed = codexCredentialSchema.safeParse(value);
  if (!parsed.success) throw new ModelAuthError('Reconnect your ChatGPT account in Models.', true);
  try {
    const claims = decodeJwt(parsed.data.access);
    const profile = z
      .object({ email: emailSchema })
      .safeParse(claims['https://api.openai.com/profile']);
    return {
      ...parsed.data,
      email:
        emailSchema.parse(claims.email) ??
        (profile.success ? profile.data.email : undefined) ??
        parsed.data.email,
    };
  } catch {}
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
  const oauth = openaiCodexProvider().auth.oauth!;
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
    async signIn({ signal: requestedSignal }) {
      const controller = new AbortController();
      const signal = AbortSignal.any([requestedSignal, controller.signal]);
      if (signal.aborted) throw new ModelAuthError('ChatGPT sign-in was canceled.');
      const callbackHost = process.env.PI_OAUTH_CALLBACK_HOST;
      if (callbackHost && !['127.0.0.1', '::1'].includes(callbackHost))
        throw new ModelAuthError('ChatGPT sign-in requires a loopback callback host.');
      let resolveManual!: (value: string) => void;
      const manual = new Promise<string>((resolve) => {
        resolveManual = resolve;
      });
      let completeCallback: ((callback: URL) => void) | undefined;
      let authenticated!: Promise<ModelCredential>;
      const receive: RequestListener = (request, response) => {
        const send = (status: number) => {
          const page = signInPage(status === 200, random());
          response.writeHead(status, {
            ...page.headers,
            Connection: 'close',
          });
          response.end(page.html);
        };
        try {
          const callback = new URL(request.url ?? '/', 'http://localhost:1455');
          if (request.method !== 'GET' || callback.pathname !== '/auth/callback') {
            send(404);
            return;
          }
          if (!completeCallback) throw new Error();
          completeCallback(callback);
          void authenticated.then(
            () => send(200),
            () => send(400),
          );
        } catch {
          send(400);
        }
      };
      const servers = [createServer(receive), createServer(receive)];
      let closing: Promise<void> | undefined;
      const close = () =>
        (closing ??= Promise.all(
          servers.map(
            (server) =>
              new Promise<void>((resolve) => {
                const timeout = setTimeout(() => server.closeAllConnections(), 1000);
                timeout.unref();
                server.close(() => {
                  clearTimeout(timeout);
                  resolve();
                });
                server.closeIdleConnections();
              }),
          ),
        ).then(() => {}));
      try {
        for (const [index, host] of ['127.0.0.1', '::1'].entries()) {
          const server = servers[index];
          try {
            await new Promise<void>((resolve, reject) => {
              server.once('error', reject);
              server.listen(1455, host, () => {
                server.off('error', reject);
                resolve();
              });
            });
          } catch (error) {
            if (
              host === '::1' &&
              error instanceof Error &&
              'code' in error &&
              ['EADDRNOTAVAIL', 'EAFNOSUPPORT', 'EPROTONOSUPPORT'].includes(String(error.code))
            )
              continue;
            throw error;
          }
          server.on('error', () => controller.abort());
          if (signal.aborted) throw new ModelAuthError('ChatGPT sign-in was canceled.');
        }
      } catch (error) {
        await close();
        if (error instanceof ModelAuthError) throw error;
        throw new ModelAuthError(
          error instanceof Error && 'code' in error && error.code === 'EADDRINUSE'
            ? 'Port 1455 is already in use. Close the other Otto app or another sign-in, then try again.'
            : 'ChatGPT sign-in could not start. Try again.',
        );
      }
      let resolveReady!: (value: Awaited<ReturnType<ModelBackend['signIn']>>) => void;
      let rejectReady!: (error: Error) => void;
      const ready = new Promise<Awaited<ReturnType<ModelBackend['signIn']>>>((resolve, reject) => {
        resolveReady = resolve;
        rejectReady = reject;
      });
      let settled = false;
      let claimed = false;
      let failure: ModelAuthError | undefined;
      authenticated = oauth
        .login({
          signal,
          async prompt(prompt) {
            signal.throwIfAborted();
            if (prompt.type === 'select') return 'browser';
            if (prompt.type !== 'manual_code') throw new ModelAuthError('Use browser sign-in.');
            const cancellation = AbortSignal.any([
              signal,
              ...(prompt.signal ? [prompt.signal] : []),
            ]);
            return new Promise<string>((resolve, reject) => {
              const abort = () => reject(new ModelAuthError('ChatGPT sign-in was canceled.'));
              if (cancellation.aborted) return abort();
              cancellation.addEventListener('abort', abort, { once: true });
              void manual
                .then(resolve)
                .finally(() => cancellation.removeEventListener('abort', abort));
            });
          },
          notify(event) {
            if (signal.aborted || event.type !== 'auth_url') return;
            const url = new URL(event.url);
            const state = url.searchParams.get('state');
            const redirect = new URL(url.searchParams.get('redirect_uri')!);
            if (url.origin !== 'https://auth.openai.com' || !state) {
              controller.abort();
              return;
            }
            completeCallback = (callback) => {
              if (settled || claimed || signal.aborted)
                throw new ModelAuthError(
                  'This sign-in request has expired. Start a new connection.',
                );
              if (
                callback.origin !== redirect.origin ||
                callback.pathname !== redirect.pathname ||
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
                failure = new ModelAuthError(
                  'ChatGPT sign-in was declined. Start a new connection.',
                );
                controller.abort();
                throw failure;
              }
              if (
                callback.searchParams.getAll('code').length !== 1 ||
                !callback.searchParams.get('code')
              )
                throw new ModelAuthError('This sign-in callback is invalid.');
              claimed = true;
              resolveManual(callback.href);
            };
            resolveReady({ url: event.url, state, result, complete: completeCallback });
          },
        })
        .then(codexCredential)
        .catch(() => {
          if (failure) throw failure;
          throw new ModelAuthError(
            signal.aborted
              ? 'ChatGPT sign-in was canceled.'
              : 'ChatGPT sign-in failed. Start a new connection and check your account access.',
          );
        });
      const result = authenticated.finally(async () => {
        settled = true;
        await close();
      });
      void result.catch(rejectReady);
      return ready;
    },
    async catalog(provider: ModelProvider, method: ModelMethod, credential?: ModelCredential) {
      const subscription = method === 'subscription';
      const account = subscription && credential ? codexCredential(credential) : undefined;
      const local = (await runtime()).getModels(subscription ? 'openai-codex' : provider);
      if (!credential) return local.map(definition);
      const key = credential.type === 'api_key' ? credential.key : credential.access;
      const url = subscription
        ? 'https://chatgpt.com/backend-api/codex/models?client_version=0.155.1'
        : provider === 'openrouter'
          ? 'https://openrouter.ai/api/v1/models'
          : provider === 'anthropic'
            ? 'https://api.anthropic.com/v1/models?limit=1000'
            : `${resource}/models`;
      const headers: Record<string, string> =
        provider === 'anthropic'
          ? { 'x-api-key': key, 'anthropic-version': '2023-06-01' }
          : { Authorization: `Bearer ${key}` };
      if (account) headers['ChatGPT-Account-Id'] = account.accountId;
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
      const response = await request(url, {
        headers,
        signal: AbortSignal.timeout(15000),
        redirect: 'error',
      });
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
        return local
          .filter((m) => ids.has(m.id) && (!subscription || m.api === 'openai-codex-responses'))
          .map(definition);
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
        key_label: 'Otto',
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
      if (credential.type === 'api_key') return credential;
      const current = codexCredential(credential);
      try {
        const next = codexCredential(await oauth.refresh(current, AbortSignal.timeout(15000)));
        if (next.accountId !== current.accountId)
          throw new ModelAuthError('The ChatGPT account changed. Reconnect in Models.', true);
        return { ...next, email: next.email ?? current.email };
      } catch (error) {
        if (error instanceof ModelAuthError) throw error;
        const terminal =
          error instanceof Error &&
          /^OpenAI Codex token refresh failed \((400|401|403)\):/.test(error.message);
        throw new ModelAuthError(
          terminal
            ? 'Reconnect your ChatGPT account in Models.'
            : 'ChatGPT is temporarily unavailable. Try again.',
          terminal,
        );
      }
    },
  };
}

export async function createPiModelRuntime(access: ModelAccess) {
  const subscription = access.method === 'subscription';
  const provider = subscription ? 'openai-codex' : access.provider;
  if (
    subscription &&
    (access.definition.spec.provider !== provider ||
      access.definition.spec.api !== 'openai-codex-responses' ||
      access.definition.spec.baseUrl !== 'https://chatgpt.com/backend-api')
  )
    throw new ModelAuthError('Reconnect your ChatGPT account in Models.', true);
  const secrets = new Set<string>();
  const credentials: CredentialStore = {
    async read(providerId) {
      if (providerId !== provider) return undefined;
      const credential = await access.read();
      if (!credential) throw new Error('The selected model connection is unavailable.');
      const value = subscription ? codexCredential(credential) : credential;
      const key = value.type === 'api_key' ? value.key : value.access;
      for (const secret of value.type === 'api_key' ? [key] : [key, value.refresh, value.accountId])
        secrets.add(secret);
      return subscription ? { ...codexCredential(value), refresh: '' } : { type: 'api_key', key };
    },
    async list() {
      return [{ providerId: provider, type: subscription ? 'oauth' : 'api_key' }];
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
  runtime.registerProvider(provider, {
    models: [access.definition.spec as unknown as ProviderModelConfig],
  });
  await runtime.refresh({ allowNetwork: false });
  const stream = runtime.streamSimple.bind(runtime);
  runtime.streamSimple = (model, context, options) => {
    const events = stream(model, context, {
      ...options,
      maxRetries: 0,
      ...(subscription ? { transport: 'sse' as const } : {}),
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
    return events;
  };
  const model = runtime.getModel(provider, access.definition.choice.id);
  if (!model) throw new Error('The selected model is unavailable. Refresh the model list.');
  return { runtime, model };
}
