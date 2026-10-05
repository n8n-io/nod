import { InMemoryCredentialStore } from '@earendil-works/pi-ai';
import { ModelRuntime } from '@earendil-works/pi-coding-agent';
import { createPiModelRuntime } from './models.ts';
import type { ModelAccess } from '../../ports/models.ts';
import type { MemoryCurator } from '../../ports/memory-curator.ts';
import { agentModels, memoryModels } from '../../shared/model-defaults.ts';

function json(text: string) {
  const body = /```(?:json)?\s*([\s\S]*?)```/.exec(text)?.[1] ?? text;
  const start = body.indexOf('{');
  try {
    return start < 0 ? null : JSON.parse(body.slice(start, body.lastIndexOf('}') + 1));
  } catch {
    return null;
  }
}

export function createPiMemoryCurator(options: {
  provider: string;
  resolve?: () => Promise<ModelAccess>;
  configured?: () => boolean;
  model?: string;
  apiKey?: string;
  runtime?: ModelRuntime;
}): MemoryCurator {
  let loaded: ReturnType<typeof load> | undefined;
  async function load() {
    const access = await options.resolve?.();
    if (access) return { ...(await createPiModelRuntime(access)), effort: access.effort };
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
    return { runtime, model, effort: undefined };
  }
  return {
    get id() {
      return options.provider;
    },
    get configured() {
      return options.configured?.() ?? Boolean(options.apiKey);
    },
    async curate({ instructions, input }, signal) {
      signal?.throwIfAborted();
      if (options.resolve) loaded = undefined;
      loaded ??= load().catch((error) => {
        loaded = undefined;
        throw error;
      });
      const { runtime, model, effort } = await loaded;
      const reply = await runtime.completeSimple(
        model,
        {
          systemPrompt: instructions,
          messages: [{ role: 'user', content: JSON.stringify(input), timestamp: Date.now() }],
        },
        {
          signal: AbortSignal.any([AbortSignal.timeout(45_000), ...(signal ? [signal] : [])]),
          maxTokens: 2048,
          maxRetries: 0,
          reasoning: effort === 'off' ? undefined : effort,
        },
      );
      if (reply.stopReason === 'error' || reply.stopReason === 'aborted')
        throw new Error('The memory model is unavailable.');
      return json(
        reply.content.flatMap((block) => (block.type === 'text' ? [block.text] : [])).join(''),
      );
    },
  };
}
