import type { Api, Model } from '@earendil-works/pi-ai';
import { z } from 'zod';
import { ModelAuthError, type ModelCredential } from '../../ports/models.ts';
import { ModelServiceError, modelErrorText, modelServiceError } from '../model-error.ts';
import {
  cloudflareAccountPattern,
  cloudflareGatewayPattern,
  modelProviderInfo,
  modelProviderNames,
  type OpenAIRegion,
  type ModelProvider,
} from '../../shared/models.ts';
import { openAIBaseUrl } from '../openai/api.ts';

const modelId = z
  .string()
  .min(1)
  .max(200)
  .regex(/^[a-zA-Z0-9@][a-zA-Z0-9_./:@+-]*$/)
  .refine((id) => id.split('/').every((part) => part !== '.' && part !== '..'));
const specialist =
  /(?:^|[-_/.:])(?:image|audio|tts|live|embed(?:ding)?s?|rerank|moderation|safeguard|guard|search|research|computer-use|voxtral)(?:[-_/.:]|$)/i;
const catalogEndpoints = {
  xai: 'https://api.x.ai/v1/models',
  groq: 'https://api.groq.com/openai/v1/models',
  cerebras: 'https://api.cerebras.ai/v1/models',
  deepseek: 'https://api.deepseek.com/models',
  moonshotai: 'https://api.moonshot.ai/v1/models',
  'moonshotai-cn': 'https://api.moonshot.cn/v1/models',
  together: 'https://api.together.xyz/v1/models',
  nvidia: 'https://integrate.api.nvidia.com/v1/models',
} as const;

export function openAIModels(region: OpenAIRegion = 'global'): Model<'openai-responses'>[] {
  const rate = region === 'global' ? 1 : 1.1;
  return [
    {
      id: 'gpt-6.2-sol',
      name: 'GPT-6.2 Sol',
      cost: { input: 2, output: 10, cacheRead: 0.1, cacheWrite: 2.5 },
    },
    {
      id: 'gpt-6.2-astra',
      name: 'GPT-6.2 Astra',
      cost: { input: 8, output: 40, cacheRead: 0.4, cacheWrite: 10 },
    },
  ].map((model) => ({
    ...model,
    provider: 'openai',
    api: 'openai-responses',
    baseUrl: openAIBaseUrl(region),
    reasoning: true,
    input: ['text', 'image'],
    contextWindow: 1_050_000,
    maxTokens: 128_000,
    cost: {
      input: model.cost.input * rate,
      output: model.cost.output * rate,
      cacheRead: model.cost.cacheRead * rate,
      cacheWrite: model.cost.cacheWrite * rate,
      tiers: [
        {
          inputTokensAbove: 272_000,
          input: model.cost.input * 2 * rate,
          output: model.cost.output * 1.5 * rate,
          cacheRead: model.cost.cacheRead * 2 * rate,
          cacheWrite: model.cost.cacheWrite * 2 * rate,
        },
      ],
    },
    thinkingLevelMap: {
      off: null,
      minimal: null,
      low: 'low',
      medium: 'medium',
      high: 'high',
      xhigh: 'xhigh',
      max: 'max',
    },
    compat: {
      supportsStrictMode: true,
      supportsOpenAIGrammarTools: true,
      supportsAdditionalTools: true,
      supportsToolSearch: true,
      supportsMidConvoSystemMessages: true,
      supportsExplicitPromptCacheMode: true,
      supportsMidConvoEffort: true,
    },
    inputLimits: {
      maxRequestBytes: 536_870_912,
      images: {
        maxPerRequest: 1500,
        resize: { maxWidth: 2000, maxHeight: 2000, maxBytes: 4_718_592, jpegQuality: 80 },
      },
    },
  }));
}

export const nativeAudioModel: Model<'openai-completions'> = {
  id: 'gpt-audio-1.5',
  name: 'GPT Audio 1.5',
  provider: 'openai',
  api: 'openai-completions',
  baseUrl: 'https://api.openai.com/v1',
  reasoning: false,
  input: ['text'],
  contextWindow: 128000,
  maxTokens: 16384,
  cost: { input: 2.5, output: 10, cacheRead: 0, cacheWrite: 0 },
  compat: { supportsStrictMode: false },
};

export const antLingModel: Model<'openai-completions'> = {
  id: 'Ling-3.1-flash',
  name: 'Ling 3.1 Flash',
  provider: 'ant-ling',
  api: 'openai-completions',
  baseUrl: 'https://api.ant-ling.com/v1',
  reasoning: true,
  input: ['text'],
  contextWindow: 262144,
  maxTokens: 32768,
  cost: { input: 0.075, output: 0.225, cacheRead: 0.015, cacheWrite: 0 },
  thinkingLevelMap: {
    off: 'disabled',
    minimal: null,
    low: null,
    medium: 'enabled',
    high: null,
    xhigh: null,
    max: null,
  },
  compat: {
    supportsStore: false,
    supportsDeveloperRole: false,
    supportsReasoningEffort: false,
    supportsStrictMode: false,
    maxTokensField: 'max_tokens',
    thinkingFormat: 'deepseek',
  },
};

export function assistantModelId(id: string) {
  return !specialist.test(id);
}

export function assistantModels(models: readonly Model<Api>[]) {
  return models.filter((model) => model.input.includes('text') && assistantModelId(model.id));
}

export function cloudflareCredential(provider: ModelProvider, credential: ModelCredential) {
  if (
    credential.type !== 'cloudflare' ||
    !credential.key ||
    !cloudflareAccountPattern.test(credential.accountId) ||
    (provider === 'cloudflare-ai-gateway' &&
      (!credential.gatewayId || !cloudflareGatewayPattern.test(credential.gatewayId)))
  )
    throw new Error('The selected Cloudflare connection is unavailable.');
  return credential;
}

export function discoveryCause(error: unknown, secrets: string[] = []) {
  if (Object(error).name === 'TimeoutError') return 'the request timed out';
  let cause = error;
  let detail = '';
  for (let depth = 0; depth < 4 && cause instanceof Error; depth++) {
    const code = (cause as Error & { code?: unknown }).code;
    if (
      typeof code === 'string' &&
      code.length <= 64 &&
      /^(?:E[A-Z_]+|UND_ERR_[A-Z_]+)$/.test(code)
    )
      return `the connection failed (${code})`;
    if (cause.message && cause.message !== 'fetch failed') detail = cause.message;
    cause = cause.cause;
  }
  const reason = modelErrorText(detail, secrets).trim();
  return error instanceof SyntaxError || Object(error).name === 'ZodError'
    ? 'it returned an invalid model list'
    : reason && reason !== '[redacted]'
      ? reason.slice(0, 2000)
      : 'the connection failed';
}

export async function nativeCatalog(
  provider: ModelProvider,
  local: Model<Api>[],
  credential: ModelCredential,
  request: typeof fetch,
): Promise<Model<Api>[]> {
  const failed = (cause = 'it returned an invalid model list') =>
    new Error(`${modelProviderNames[provider]} couldn’t load its models: ${cause}. Try again.`);
  const read = async (url: string | URL, headers: Record<string, string>) => {
    const secrets = [
      String(url),
      ...Object.values(headers).map((value) => value.replace(/^Bearer /, '')),
    ];
    const response = await request(url, {
      headers,
      redirect: 'error',
      signal: AbortSignal.timeout(15000),
    }).catch((error: unknown) => {
      throw failed(discoveryCause(error, secrets));
    });
    if (!response.ok) {
      const error = await modelServiceError(
        response,
        `${modelProviderNames[provider]} model discovery`,
        secrets,
      );
      if (
        response.status === 401 ||
        response.status === 403 ||
        (provider === 'google' && response.status === 400) ||
        (provider === 'cloudflare-ai-gateway' && response.status === 404)
      )
        throw new ModelAuthError(error.message);
      throw error;
    }
    return (await response.json().catch((error: unknown) => {
      throw failed(discoveryCause(error, secrets));
    })) as unknown;
  };
  const parse = <T>(schema: z.ZodType<T>, value: unknown) => {
    const result = schema.safeParse(value);
    if (!result.success) throw failed();
    return result.data;
  };
  const list = <T>(value: unknown, schema: z.ZodType<T>) =>
    parse(z.array(z.unknown()).max(10000), value).flatMap((entry) => {
      const result = schema.safeParse(entry);
      return result.success ? [result.data] : [];
    });
  const select = (ids: Iterable<string>) => {
    const accepted = new Set(ids);
    return local.filter((model) => accepted.has(model.id));
  };

  if (provider === 'cloudflare-workers-ai' || provider === 'cloudflare-ai-gateway') {
    const value = cloudflareCredential(provider, credential);
    const headers = { Authorization: `Bearer ${value.key}` };
    const base = `https://api.cloudflare.com/client/v4/accounts/${value.accountId}`;
    if (provider === 'cloudflare-ai-gateway') {
      const gateway = parse(
        z.object({ success: z.literal(true), result: z.object({ id: z.string() }) }),
        await read(`${base}/ai-gateway/gateways/${value.gatewayId}`, headers),
      );
      if (gateway.result.id !== value.gatewayId) throw failed();
      return local;
    }
    const ids = new Set<string>();
    for (let page = 1; page <= 100; page++) {
      const data = parse(
        z.object({
          success: z.literal(true),
          result: z.array(z.unknown()).max(1000),
          result_info: z
            .object({ total_pages: z.number().int().nonnegative().max(100).optional() })
            .optional(),
        }),
        await read(`${base}/ai/models/search?per_page=100&page=${page}`, headers),
      );
      for (const model of list(data.result, z.object({ name: modelId }))) ids.add(model.name);
      if (
        data.result_info?.total_pages !== undefined
          ? page >= data.result_info.total_pages
          : data.result.length < 100
      )
        return select(ids);
    }
    throw failed();
  }

  if (credential.type !== 'api_key' || !credential.key)
    throw new Error('The selected model connection is unavailable.');
  const headers = { Authorization: `Bearer ${credential.key}` };
  if (modelProviderInfo[provider].catalog === 'bundled') return local;

  if (provider === 'google') {
    const tokens = new Set<string>();
    const ids = new Set<string>();
    let token: string | undefined;
    for (let page = 0; page < 100; page++) {
      const url = new URL('https://generativelanguage.googleapis.com/v1beta/models');
      url.searchParams.set('pageSize', '1000');
      if (token) url.searchParams.set('pageToken', token);
      const data = parse(
        z.object({
          models: z.array(z.unknown()).max(1000).default([]),
          nextPageToken: z.string().max(10000).optional(),
        }),
        await read(url, { 'x-goog-api-key': credential.key }),
      );
      for (const model of list(
        data.models,
        z.object({ name: z.string().max(210), supportedGenerationMethods: z.array(z.string()) }),
      )) {
        if (
          model.name.startsWith('models/') &&
          model.supportedGenerationMethods.includes('generateContent')
        )
          ids.add(model.name.slice('models/'.length));
      }
      token = data.nextPageToken;
      if (!token) return select(ids);
      if (tokens.has(token)) throw failed();
      tokens.add(token);
    }
    throw failed();
  }

  if (provider === 'mistral') {
    const data = parse(
      z.object({ data: z.array(z.unknown()).max(10000) }),
      await read('https://api.mistral.ai/v1/models', headers),
    );
    const models = list(
      data.data,
      z.object({
        id: modelId,
        archived: z.boolean().optional(),
        capabilities: z.object({
          completion_chat: z.boolean(),
          function_calling: z.boolean(),
          vision: z.boolean().optional(),
        }),
      }),
    ).filter(
      (model) =>
        !model.archived &&
        model.capabilities.completion_chat &&
        model.capabilities.function_calling,
    );
    const vision = new Map(models.map((model) => [model.id, model.capabilities.vision]));
    return select(models.map((model) => model.id)).map((model) => {
      const supportsImages = vision.get(model.id);
      if (supportsImages === undefined) return model;
      return {
        ...model,
        input: supportsImages
          ? [...new Set([...model.input, 'image' as const])]
          : model.input.filter((input) => input !== 'image'),
      };
    });
  }

  if (provider === 'radius') {
    const data = parse(
      z.object({
        baseUrl: z.literal('https://radius.pi.dev/v1'),
        models: z.array(z.unknown()).max(1000),
      }),
      await read('https://radius.pi.dev/v1/config', headers),
    );
    const models = list(
      data.models,
      z.object({
        id: modelId,
        name: z.string().min(1).max(200),
        reasoning: z.boolean(),
        input: z
          .array(z.enum(['text', 'image']))
          .min(1)
          .max(2),
        cost: z.object({
          input: z.number().nonnegative().finite(),
          output: z.number().nonnegative().finite(),
          cacheRead: z.number().nonnegative().finite(),
          cacheWrite: z.number().nonnegative().finite(),
        }),
        contextWindow: z.number().int().positive().max(100000000),
        maxTokens: z.number().int().positive().max(100000000),
        thinkingLevelMap: z
          .partialRecord(
            z.enum(['off', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max']),
            z.string().max(50).nullable(),
          )
          .optional(),
      }),
    ).map((model) => ({
      ...local.find((known) => known.id === model.id),
      ...model,
      api: 'pi-messages' as const,
      provider,
      baseUrl: data.baseUrl,
    }));
    return assistantModels([...new Map(models.map((model) => [model.id, model])).values()]);
  }

  if (Object.hasOwn(catalogEndpoints, provider)) {
    const data = await read(catalogEndpoints[provider as keyof typeof catalogEndpoints], headers);
    const models =
      provider === 'together' ? data : parse(z.object({ data: z.array(z.unknown()) }), data).data;
    return select(
      list(models, z.object({ id: modelId, active: z.boolean().optional() }))
        .filter((model) => model.active !== false)
        .map((model) => model.id),
    );
  }
  throw new Error('This model provider is unavailable.');
}
