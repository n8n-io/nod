import {
  InMemoryCredentialStore,
  getSupportedThinkingLevels,
  type AssistantMessage,
  type Context,
} from '@earendil-works/pi-ai';
import { ModelRuntime } from '@earendil-works/pi-coding-agent';
import { retryAssistantCall } from '@earendil-works/pi-ai/utils/retry';
import { createPiModelRuntime } from './models.ts';
import type { ModelAccess } from '../../ports/models.ts';
import { lightestEffort } from '../../shared/models.ts';
import type { MemoryCurator } from '../../ports/memory-curator.ts';
import { agentModels, memoryModels } from '../../shared/model-defaults.ts';
import { piUsageMetrics } from './usage.ts';
import { piModelTrace } from './traces.ts';
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
    async curate({ task, instructions, input, images, automatic = true }, signal, report) {
      signal?.throwIfAborted();
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
        try {
          reply = await runtime.completeSimple(model, context, {
            ...(model.api === 'anthropic-messages'
              ? {
                  onPayload: uncachedInput,
                  ...(keepInstructions(`${model.provider}:${model.id}:${instructions}`)
                    ? { cacheRetention: 'long' as const }
                    : {}),
                }
              : {}),
            signal: AbortSignal.any([
              AbortSignal.timeout(task === 'classify' ? 10_000 : 45_000),
              ...(signal ? [signal] : []),
            ]),
            maxTokens: task === 'classify' ? 512 : 8192,
            ...(sessionId ? { sessionId } : {}),
            ...(task === 'classify' ? { maxRetries: 0, timeoutMs: 10_000 } : {}),
            reasoning: effort === 'off' ? undefined : effort,
          });
        } finally {
          const metrics = piUsageMetrics(reply?.usage);
          report?.({
            id: crypto.randomUUID(),
            attempt,
            provider: reply?.provider ?? model.provider,
            model: reply?.model ?? model.id,
            durationMs: performance.now() - started,
            ...metrics,
            status:
              reply?.stopReason === 'aborted' || (!reply && signal?.aborted)
                ? 'cancelled'
                : !reply || reply.stopReason === 'error'
                  ? 'failed'
                  : 'succeeded',
            costUsd: subscription ? null : (metrics.costUsd ?? null),
            ...(subscription ? { estimateUsd: metrics.costUsd ?? null } : {}),
            pricing: subscription ? 'unavailable' : (metrics.pricing ?? 'unavailable'),
          });
        }
        const target = runtime.getModel(reply.provider, reply.model) ?? model;
        if (!untraced.has(task) && options.traces?.active())
          options.traces.record(
            piModelTrace(
              { model: target, context, message: reply, startedAt, request: requestFacts?.(reply) },
              { source: 'curator', task },
            ),
          );
        return reply;
      };
      const reply = await retryAssistantCall(
        complete,
        { enabled: task !== 'vision' && task !== 'classify', maxRetries: 2, baseDelayMs: 250 },
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
            : task === 'classify'
              ? 'The classification model is unavailable.'
              : task === 'review' || task === 'access'
                ? 'The action review model is unavailable.'
                : 'The memory model is unavailable.';
        const detail =
          reply.stopReason === 'error' && reply.errorMessage
            ? ` The provider said: ${reply.errorMessage.trim().slice(0, 300)}`
            : reply.stopReason === 'length'
              ? ' The reply stopped at the token limit.'
              : '';
        throw new Error(`${label} Task: ${task}. Model: ${model.provider}/${model.id}.${detail}`);
      }
      return json(
        reply.content.flatMap((block) => (block.type === 'text' ? [block.text] : [])).join(''),
      );
    },
  };
}
