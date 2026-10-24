import {
  InMemoryCredentialStore,
  getSupportedThinkingLevels,
  type Context,
} from '@earendil-works/pi-ai';
import { ModelRuntime } from '@earendil-works/pi-coding-agent';
import { createPiModelRuntime } from './models.ts';
import type { ModelAccess } from '../../ports/models.ts';
import { lightestEffort } from '../../shared/models.ts';
import type { MemoryCurator } from '../../ports/memory-curator.ts';
import { agentModels, memoryModels } from '../../shared/model-defaults.ts';
import { piUsageMetrics } from './usage.ts';
import { piModelTrace } from './traces.ts';
import type { ModelTraces } from '../../ports/traces.ts';

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
  resolve?: () => Promise<ModelAccess>;
  configured?: () => boolean;
  model?: string;
  lightest?: boolean;
  apiKey?: string;
  runtime?: ModelRuntime;
  traces?: ModelTraces;
}): MemoryCurator {
  let loaded: ReturnType<typeof load> | undefined;
  async function load() {
    const access = await options.resolve?.();
    if (access)
      return {
        ...(await createPiModelRuntime(access)),
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
    };
  }
  return {
    get id() {
      return options.provider;
    },
    get configured() {
      return options.configured?.() ?? Boolean(options.apiKey);
    },
    async curate({ task, instructions, input, images }, signal, report) {
      signal?.throwIfAborted();
      if (options.resolve) loaded = undefined;
      loaded ??= load().catch((error) => {
        loaded = undefined;
        throw error;
      });
      const { runtime, model, effort, subscription } = await loaded;
      const complete = async () => {
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
        const reply = await runtime.completeSimple(model, context, {
          signal: AbortSignal.any([
            AbortSignal.timeout(task === 'analytics' ? 20_000 : 45_000),
            ...(signal ? [signal] : []),
          ]),
          maxTokens: task === 'analytics' ? 2048 : 8192,
          reasoning: effort === 'off' ? undefined : effort,
        });
        const durationMs = performance.now() - started;
        if (task !== 'access' && options.traces?.active())
          options.traces.record(
            piModelTrace(
              { model, context, message: reply, startedAt },
              { source: 'curator', task },
            ),
          );
        if (reply.usage?.totalTokens)
          report?.({
            id: crypto.randomUUID(),
            provider: model.provider,
            model: model.id,
            durationMs,
            ...piUsageMetrics(reply.usage),
            status:
              reply.stopReason === 'error'
                ? 'failed'
                : reply.stopReason === 'aborted'
                  ? 'cancelled'
                  : 'succeeded',
            costUsd: subscription ? null : (piUsageMetrics(reply.usage).costUsd ?? null),
            ...(subscription ? { estimateUsd: piUsageMetrics(reply.usage).costUsd ?? null } : {}),
            pricing: subscription ? 'unavailable' : piUsageMetrics(reply.usage).pricing,
          });
        return reply;
      };
      let reply = await complete();
      for (
        let attempt = 0;
        attempt < (task === 'analytics' || task === 'vision' ? 0 : 2) &&
        reply.stopReason === 'error' &&
        !signal?.aborted;
        attempt++
      )
        reply = await complete();
      if (
        reply.stopReason === 'error' ||
        reply.stopReason === 'aborted' ||
        reply.stopReason === 'length'
      )
        throw new Error(
          task === 'vision'
            ? 'The image model is unavailable.'
            : 'The memory model is unavailable.',
        );
      return json(
        reply.content.flatMap((block) => (block.type === 'text' ? [block.text] : [])).join(''),
      );
    },
  };
}
