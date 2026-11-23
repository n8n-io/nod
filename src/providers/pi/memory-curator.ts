import {
  InMemoryCredentialStore,
  getSupportedThinkingLevels,
  type Api,
  type AssistantMessage,
  type Context,
  type Model,
} from '@earendil-works/pi-ai';
import { ModelRuntime } from '@earendil-works/pi-coding-agent';
import { retryAssistantCall } from '@earendil-works/pi-ai/utils/retry';
import { createPiModelRuntime, localModelSilenceMs } from './models.ts';
import type { ModelAccess } from '../../ports/models.ts';
import { lightestEffort, modelPricingSignature } from '../../shared/models.ts';
import type { MemoryCurator } from '../../ports/memory-curator.ts';
import { agentModels, memoryModels } from '../../shared/model-defaults.ts';
import { piUsageMetrics } from './usage.ts';
import { piModelTrace } from './traces.ts';
import type { ProviderUsageEvent } from '../../ports/provider-usage.ts';
import type { ModelTraces } from '../../ports/traces.ts';

const untraced = new Set([
  'access',
  'attention',
  'reflect',
  'remember',
  'recall',
  'review',
  'style',
  'skill',
  'classify',
  'check',
]);

const longCache = 55 * 60_000;
const recentInstructions = new Map<string, number>();

function keepInstructions(key: string) {
  const now = Date.now();
  const last = recentInstructions.get(key);
  recentInstructions.set(key, now);
  if (recentInstructions.size > 200)
    for (const [entry, at] of recentInstructions)
      if (now - at >= longCache) recentInstructions.delete(entry);
  return last !== undefined && now - last < longCache;
}

function uncachedInput(payload: unknown) {
  const request = payload as {
    messages?: Array<{ content?: unknown }>;
  } | null;
  if (!Array.isArray(request?.messages)) return undefined;
  return {
    ...request,
    messages: request.messages.map((message) =>
      Array.isArray(message.content)
        ? {
            ...message,
            content: message.content.map((block: Record<string, unknown>) => {
              const { cache_control: _, ...rest } = block;
              return rest;
            }),
          }
        : message,
    ),
  };
}

function json(text: string) {
  const parse = (body: string) => {
    const start = body.indexOf('{');
    try {
      return start < 0 ? null : JSON.parse(body.slice(start, body.lastIndexOf('}') + 1));
    } catch {
      return null;
    }
  };
  return parse(text) ?? parse(/```(?:json)?\s*([\s\S]*)```/.exec(text)?.[1] ?? '');
}

export function createPiMemoryCurator(options: {
  provider: string;
  resolve?: () => Promise<ModelAccess | undefined>;
  configured?: () => boolean;
  model?: string;
  lightest?: boolean;
  apiKey?: string;
  runtime?: ModelRuntime;
  traces?: ModelTraces;
  estimateAnthropicRequestUsd?: (model: Model<Api>, body: RequestInit['body']) => number | null;
}): MemoryCurator {
  let loaded: ReturnType<typeof load> | undefined;
  async function load(automatic: boolean) {
    const access = await options.resolve?.();
    if (options.resolve && !access) throw new Error('The selected model is unavailable.');
    if (access)
      await access.prepareRequest?.(
        access.textModel?.definition.choice.id ?? access.definition.choice.id,
        automatic,
      );
    if (access)
      return {
        ...(await createPiModelRuntime(access, { automatic })),
        effort: access.effort,
        subscription: access.method === 'subscription',
      };
    const runtime =
      options.runtime ??
      (await ModelRuntime.create({
        credentials: new InMemoryCredentialStore(),
        modelsPath: null,
        refreshOnCreate: false,
        allowModelNetwork: false,
      }));
    await runtime.setRuntimeApiKey(options.provider, options.apiKey!);
    const model = (
      options.model
        ? [options.model]
        : [
            memoryModels[options.provider as keyof typeof memoryModels],
            agentModels[options.provider as keyof typeof agentModels],
          ]
    ).flatMap((id) => (id ? (runtime.getModel(options.provider, id) ?? []) : []))[0];
    if (!model) throw new Error('The memory model is not present in the installed Pi catalog.');
    return {
      runtime,
      model,
      effort: options.lightest ? lightestEffort(getSupportedThinkingLevels(model)) : undefined,
      subscription: false,
      requestFacts: undefined,
    };
  }
  return {
    get id() {
      return options.provider;
    },
    get configured() {
      return options.configured?.() ?? Boolean(options.apiKey);
    },
    async curate(
      { task, instructions, input, responseSchema, images, automatic = true },
      signal,
      report,
    ) {
      signal?.throwIfAborted();
      const traceTurnId = crypto.randomUUID();
      const bounded =
        task === 'classify' || task === 'attention' || task === 'check' || task === 'activity';
      const turnBound =
        signal !== undefined && ['review', 'access', 'skill', 'remember'].includes(task);
      if (options.resolve) loaded = undefined;
      loaded ??= load(automatic).catch((error) => {
        loaded = undefined;
        throw error;
      });
      const { runtime, model, effort, subscription, requestFacts } = await loaded;
      const sessionId = ['opencode', 'opencode-go'].includes(model.provider)
        ? crypto.randomUUID()
        : undefined;
      let attempt = 0;
      const complete = async () => {
        attempt++;
        const context: Context = {
          systemPrompt: instructions,
          messages: [
            {
              role: 'user',
              content:
                task === 'vision'
                  ? [{ type: 'text', text: JSON.stringify(input) }, ...(images ?? [])]
                  : JSON.stringify(input),
              timestamp: Date.now(),
            },
          ],
        };
        const startedAt = new Date().toISOString();
        const started = performance.now();
        let reply: AssistantMessage | undefined;
        const estimate = options.estimateAnthropicRequestUsd;
        const dispatched: RequestInit['body'][] | undefined =
          estimate &&
          requestFacts &&
          !subscription &&
          task !== 'vision' &&
          model.provider === 'anthropic' &&
          model.api === 'anthropic-messages'
            ? []
            : undefined;
        try {
          reply = await runtime.completeSimple(model, context, {
            ...(dispatched
              ? {
                  fetch: (url: string | URL | Request, init?: RequestInit) => {
                    if (!init?.signal?.aborted) dispatched.push(init?.body);
                    return fetch(url, init);
                  },
                }
              : {}),
            ...(model.api === 'anthropic-messages'
              ? {
                  onPayload: uncachedInput,
                  ...(keepInstructions(`${model.provider}:${model.id}:${instructions}`)
                    ? { cacheRetention: 'long' as const }
                    : {}),
                }
              : {}),
            ...(responseSchema
              ? {
                  onPayload: (payload: unknown, target: Model<Api>) => {
                    if (target.api === 'anthropic-messages') return uncachedInput(payload);
                    if (
                      target.provider !== 'openai' ||
                      target.api !== 'openai-responses' ||
                      !/^gpt-(?:5|6)(?:[.-]|$)/.test(target.id)
                    )
                      return undefined;
                    const body = payload as { text?: Record<string, unknown> };
                    return {
                      ...body,
                      text: {
                        ...body.text,
                        format: {
                          type: 'json_schema',
                          name: 'response',
                          strict: true,
                          schema: responseSchema,
                        },
                      },
                    };
                  },
                }
              : {}),
            signal: turnBound
              ? signal
              : AbortSignal.any([
                  AbortSignal.timeout(bounded ? 10_000 : 45_000),
                  ...(signal ? [signal] : []),
                ]),
            maxTokens: bounded ? 512 : 8192,
            ...(sessionId ? { sessionId } : {}),
            ...(bounded ? { maxRetries: 0, timeoutMs: 10_000 } : {}),
            ...(turnBound && model.provider === 'compatible'
              ? { timeoutMs: localModelSilenceMs }
              : {}),
            reasoning: effort === 'off' ? undefined : effort,
          });
        } finally {
          const metrics = piUsageMetrics(reply?.usage);
          const target = reply && (runtime.getModel(reply.provider, reply.model) ?? model);
          const status: ProviderUsageEvent['status'] =
            reply?.stopReason === 'aborted' || (!reply && signal?.aborted)
              ? 'cancelled'
              : !reply || reply.stopReason === 'error'
                ? 'failed'
                : 'succeeded';
          let budgetEstimateUsd: number | null | undefined;
          if (status === 'cancelled' && dispatched && estimate) {
            budgetEstimateUsd = 0;
            for (const body of dispatched) {
              const cost = estimate(model, body);
              if (cost === null) {
                budgetEstimateUsd = null;
                break;
              }
              budgetEstimateUsd += cost;
            }
          }
          const usage = {
            id: crypto.randomUUID(),
            attempt,
            provider: reply?.provider ?? model.provider,
            model: reply?.model ?? model.id,
            durationMs: performance.now() - started,
            ...metrics,
            pricingSignature: modelPricingSignature(target?.cost, target?.api),
            status,
            costUsd: subscription ? null : (metrics.costUsd ?? null),
            ...(subscription ? { estimateUsd: metrics.costUsd ?? null } : {}),
            pricing: subscription ? ('unavailable' as const) : (metrics.pricing ?? 'unavailable'),
            ...(budgetEstimateUsd === undefined ? {} : { budgetEstimateUsd }),
          };
          report?.(usage);
        }
        const target = runtime.getModel(reply.provider, reply.model) ?? model;
        if (!untraced.has(task) && options.traces?.active())
          options.traces.record(
            piModelTrace(
              { model: target, context, message: reply, startedAt, request: requestFacts?.(reply) },
              { source: 'curator', task, session_id: traceTurnId, turn_id: traceTurnId },
            ),
          );
        return reply;
      };
      const reply = await retryAssistantCall(
        complete,
        { enabled: task !== 'vision' && !bounded, maxRetries: 2, baseDelayMs: 250 },
        signal,
      );
      if (
        reply.stopReason === 'error' ||
        reply.stopReason === 'aborted' ||
        reply.stopReason === 'length'
      ) {
        const label =
          task === 'vision'
            ? 'The image model is unavailable.'
            : task === 'classify' || task === 'attention' || task === 'activity'
              ? 'The classification model is unavailable.'
              : task === 'review' || task === 'access'
                ? 'The action review model is unavailable.'
                : task === 'check'
                  ? 'The selected model is unavailable.'
                  : 'The memory model is unavailable.';
        const detail =
          reply.stopReason === 'error' && reply.errorMessage
            ? ` The provider said: ${reply.errorMessage.trim().slice(0, 300)}`
            : reply.stopReason === 'length'
              ? ' The reply stopped at the token limit.'
              : '';
        const status = [...(reply.errorMessage ?? '').matchAll(/\(HTTP (\d{3})\)/g)].at(-1)?.[1];
        throw Object.assign(
          new Error(`${label} Task: ${task}. Model: ${model.provider}/${model.id}.${detail}`),
          status ? { providerStatus: Number(status) } : {},
        );
      }
      return json(
        reply.content.flatMap((block) => (block.type === 'text' ? [block.text] : [])).join(''),
      );
    },
  };
}
