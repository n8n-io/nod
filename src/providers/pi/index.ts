import { AsyncLocalStorage } from 'node:async_hooks';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { mkdir } from 'node:fs/promises';
import { isIP } from 'node:net';
import { join, resolve } from 'node:path';
import { createHmac, randomBytes, randomUUID } from 'node:crypto';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import {
  getSupportedThinkingLevels,
  InMemoryCredentialStore,
  isContextOverflow,
  type AssistantMessage,
} from '@earendil-works/pi-ai';
import { Agent as Connections, Dispatcher1Wrapper, buildConnector } from 'undici';
import { Compile } from 'typebox/compile';
import {
  compact,
  createAgentSession,
  createCodemodeExtension,
  createToolSearchExtension,
  DefaultResourceLoader,
  ModelRuntime,
  SessionManager,
  SettingsManager,
  type ExtensionAPI,
  type ResourceLoader,
  type ToolDefinition,
} from '@earendil-works/pi-coding-agent';
import {
  createPiModelRuntime,
  estimateModelTokens,
  localModelSilenceMs,
  modelContextBudget,
} from './models.ts';
import { audioContext, audioMessage, readsNativeAudio } from './audio.ts';
import { piModelTrace } from './traces.ts';
import type { ModelTraces } from '../../ports/traces.ts';
import type { ModelAccess } from '../../ports/models.ts';
import type { Agent } from '../../ports/agent.ts';
import {
  closeInterruptedCalls,
  completeAssistantMessage,
  dropFailedInput,
  keptImages,
  openLocalSession,
  removedImage,
} from './checkpoint.ts';
import { threadIdentity } from '../../ports/thread-identity.ts';
import { createPiUsageTracker, piUsageMetrics, usageId } from './usage.ts';
import { agentModels } from '../../shared/model-defaults.ts';
import { lightestEffort } from '../../shared/models.ts';
import { createSandbox, workspaceOutputs, writeWorkspaceFile } from './sandbox.ts';
import { untrustedBlock } from '../../shared/untrusted.ts';
import { isPublicAddress, publicLookup } from '../agent-browser/network.ts';

function isFinalAnswer(signature: string | undefined) {
  if (!signature?.startsWith('{')) return false;
  try {
    const value = JSON.parse(signature);
    return value?.v === 1 && value.phase === 'final_answer';
  } catch {
    return false;
  }
}

function thinkingTitles(text: string) {
  return [...text.matchAll(/(?:^|\n)[ \t]*\*\*([^*\n]{2,80})\*\*[ \t]*(?=\n)/g)].map((match) =>
    match[1]!.trim(),
  );
}

function resources(
  systemPrompt: string,
  extensions: ReturnType<ResourceLoader['getExtensions']>,
): ResourceLoader {
  return {
    getExtensions: () => extensions,
    getSkills: () => ({ skills: [], diagnostics: [] }),
    getPrompts: () => ({ prompts: [], diagnostics: [] }),
    getThemes: () => ({ themes: [], diagnostics: [] }),
    getAgentsFiles: () => ({ agentsFiles: [] }),
    getSystemPrompt: () => systemPrompt,
    getSystemPromptSource: () => undefined,
    getAppendSystemPrompt: () => [],
    getAppendSystemPromptSources: () => [],
    extendResources: () => {},
    reload: async () => {},
  };
}

const webExtension = fileURLToPath(import.meta.resolve('pi-web-access/dist/index.js'));
const hiddenWebParameters = new Set(['workflow', 'proxy']);
const webRequests = new AsyncLocalStorage<Dispatcher1Wrapper>();
let webConnections: Dispatcher1Wrapper | undefined;

function publicWebRequests() {
  if (webConnections) return webConnections;
  const connect = buildConnector({ lookup: publicLookup() });
  webConnections = new Dispatcher1Wrapper(
    new Connections({
      connect: (options, callback) => {
        const host = options.hostname.replace(/^\[|\]$/g, '');
        if (isIP(host) && !isPublicAddress(host))
          return callback(new Error('Private network destinations are blocked.'), null);
        connect(options, callback);
      },
    }),
  );
  const send = globalThis.fetch;
  globalThis.fetch = ((input, init) => {
    const dispatcher = webRequests.getStore();
    return send(input, dispatcher ? ({ ...init, dispatcher } as RequestInit) : init);
  }) as typeof fetch;
  return webConnections;
}

function visibleWebParameters(record: Record<string, unknown>) {
  return Object.fromEntries(
    Object.entries(record).filter(([key]) => !hiddenWebParameters.has(key)),
  );
}

function webParameters<T>(schema: T): T {
  const value = schema as { properties?: Record<string, unknown>; required?: string[] };
  if (!value.properties) return schema;
  return {
    ...value,
    properties: visibleWebParameters(value.properties),
    ...(value.required
      ? { required: value.required.filter((key) => !hiddenWebParameters.has(key)) }
      : {}),
  } as T;
}

const openSchema = { type: 'object', additionalProperties: true };

function validPatterns(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(validPatterns);
  if (!value || typeof value !== 'object') return value;
  return Object.fromEntries(
    Object.entries(value).flatMap(([key, item]) => {
      if (key === '$schema') return [];
      if (key === 'pattern' && typeof item === 'string')
        try {
          new RegExp(item, 'u');
        } catch {
          return [];
        }
      return [[key, validPatterns(item)]];
    }),
  );
}

function toolSchema(schema: unknown) {
  const cleaned = validPatterns(schema) as { type?: unknown } | undefined;
  if (cleaned?.type !== 'object') return openSchema;
  try {
    Compile(cleaned as Parameters<typeof Compile>[0]);
    return cleaned;
  } catch {
    return openSchema;
  }
}

const imageStep = 8;
const warmCache = 5 * 60_000;
const longCache = 55 * 60_000;

const warmIdle = 31 * 60_000;

const webAccess = {
  toolActivation: 'eager',
  workflow: 'none',
  githubClone: { enabled: false },
  githubPrIssue: { enabled: false },
  video: { enabled: false },
  allowBrowserCookies: false,
  proxy: null,
};

function configureWebAccess(root: string) {
  process.env.PI_CODING_AGENT_DIR = root;
  const path = join(root, 'web-search.json');
  let saved = {};
  try {
    saved = JSON.parse(readFileSync(path, 'utf8'));
  } catch {
    saved = {};
  }
  mkdirSync(root, { recursive: true, mode: 0o700 });
  writeFileSync(path, JSON.stringify({ ...saved, ...webAccess }, null, 2) + '\n', { mode: 0o600 });
}

type ModelUsage = { input?: number; output?: number; cost?: { total?: number } };

const promptCacheSecret = randomBytes(32);

function threadPromptCache(threadId: string) {
  const key = createHmac('sha256', promptCacheSecret).update(threadId).digest('base64url');
  return (pi: ExtensionAPI) => {
    pi.on('before_provider_request', ({ payload }) => {
      const request = payload as { prompt_cache_key?: unknown } | null;
      if (request?.prompt_cache_key) return { ...request, prompt_cache_key: key };
    });
  };
}

type CachedBlock = { type: string; text?: string; cache_control?: unknown };
type CachedRequest = {
  system?: CachedBlock[] | string;
  tools?: Array<Record<string, unknown>>;
  messages?: Array<{ role: string; content: string | CachedBlock[] }>;
};

function stableRequestCache(
  cached: { owner?: string; stable?: string[] },
  retention: 'short' | 'long',
  moveOwnerFirst = false,
) {
  const durable = retention === 'long' ? { type: 'ephemeral', ttl: '1h' } : { type: 'ephemeral' };
  const short = { type: 'ephemeral' };
  return (pi: ExtensionAPI) => {
    pi.on('before_provider_request', ({ payload }) => {
      const request = payload as CachedRequest | null;
      if (!request || !Array.isArray(request.messages)) return;
      if (Array.isArray(request.system) && request.system.filter((b) => b.cache_control).length > 1)
        return;
      const prefixes = [...new Set(cached.stable ?? [])].sort((a, b) => a.length - b.length);
      const longest = prefixes.at(-1);
      const ordered = [...request.messages];
      if (moveOwnerFirst && cached.owner && longest) {
        const ownerAt = ordered.findIndex(
          (message) =>
            Array.isArray(message.content) &&
            message.content.length === 1 &&
            message.content[0]?.type === 'text' &&
            message.content[0].text === cached.owner,
        );
        const stableAt = ordered.findIndex(
          (message) =>
            Array.isArray(message.content) &&
            message.content.some(
              (block) =>
                block.type === 'text' &&
                typeof block.text === 'string' &&
                block.text.startsWith(longest),
            ),
        );
        if (
          stableAt >= 0 &&
          ownerAt === stableAt + 1 &&
          ordered[stableAt]?.role === 'user' &&
          ordered[ownerAt]?.role === 'user'
        ) {
          const [owner] = ordered.splice(ownerAt, 1);
          ordered.splice(stableAt, 0, owner!);
        }
      }
      const blocks = ordered.flatMap((message, at) =>
        Array.isArray(message.content)
          ? message.content.map((block, index) => ({ block, at, index }))
          : [],
      );
      const lastText = (match: (text: string) => boolean) =>
        blocks.findLast(({ block }) => block.type === 'text' && match(block.text ?? ''));
      const stable = longest
        ? lastText((text) => text.length > longest.length && text.startsWith(longest))
        : undefined;
      const found = cached.owner ? lastText((text) => text === cached.owner) : undefined;
      const owner =
        found &&
        stable &&
        (found.at < stable.at || (found.at === stable.at && found.index < stable.index))
          ? found
          : undefined;
      const messages = ordered.map((message, at) =>
        Array.isArray(message.content)
          ? {
              ...message,
              content: message.content.flatMap((block, index): CachedBlock[] => {
                const rolling = block.cache_control ? { cache_control: short } : {};
                if (owner?.at === at && owner.index === index)
                  return [{ ...block, cache_control: durable }];
                if (stable?.at === at && stable.index === index)
                  return [
                    ...prefixes.map((prefix, step) => ({
                      type: 'text',
                      text: prefix.slice(step ? prefixes[step - 1]!.length : 0),
                      cache_control: durable,
                    })),
                    {
                      ...block,
                      text: block.text!.slice(longest!.length),
                      ...(moveOwnerFirst ? { cache_control: short } : rolling),
                    },
                  ];
                return [{ ...block, ...rolling }];
              }),
            }
          : message,
      );
      return {
        ...request,
        ...(owner && Array.isArray(request.system)
          ? { system: request.system.map(({ cache_control: _, ...block }) => block) }
          : {}),
        ...(request.tools
          ? { tools: request.tools.map(({ cache_control: _, ...tool }) => tool) }
          : {}),
        messages,
      };
    });
  };
}

const ownerContextType = 'nod-owner-context';

function isOwnerContext(message: { role: string }) {
  return (
    message.role === 'custom' &&
    (message as { customType?: string }).customType === ownerContextType
  );
}

function ownerContextCopies(ownerContext: string | undefined) {
  return (pi: ExtensionAPI) => {
    pi.on('context', ({ messages }) => {
      if (!ownerContext || messages.some(isOwnerContext)) return;
      return {
        messages: [
          ...messages,
          {
            role: 'custom' as const,
            customType: ownerContextType,
            content: ownerContext,
            display: false,
            timestamp: Date.now(),
          },
        ],
      };
    });
    pi.on('session_before_compact', ({ preparation }) => {
      preparation.messagesToSummarize = preparation.messagesToSummarize.filter(
        (message) => !isOwnerContext(message),
      );
      preparation.turnPrefixMessages = preparation.turnPrefixMessages.filter(
        (message) => !isOwnerContext(message),
      );
    });
  };
}

function recentImages(pi: ExtensionAPI) {
  pi.on('context', ({ messages }) => {
    const total = messages.reduce(
      (count, message) =>
        message.role === 'toolResult'
          ? count + message.content.filter((part) => part.type === 'image').length
          : count,
      0,
    );
    if (total <= keptImages + imageStep) return;
    const cut = Math.floor((total - keptImages) / imageStep) * imageStep;
    let seen = 0;
    return {
      messages: messages.map((message) =>
        message.role === 'toolResult' && message.content.some((part) => part.type === 'image')
          ? {
              ...message,
              content: message.content.map((part) =>
                part.type === 'image' && seen++ < cut
                  ? { type: 'text' as const, text: removedImage }
                  : part,
              ),
            }
          : message,
      ),
    };
  });
}

function completeAssistantMessages(pi: ExtensionAPI) {
  pi.on('message_end', ({ message }) => {
    if (message.role !== 'assistant') return;
    const complete = completeAssistantMessage(message);
    if (complete !== message) return { message: complete };
  });
}

const oversizedHistoryCheckpoint =
  'Older session context does not fit this model. It remains in the saved transcript. Use history_search for earlier messages and read workspace files for work results. Do not infer missing facts or repeat uncertain actions. Follow the current owner instruction and rules.';

const imageOutputExtensions: Record<string, string> = {
  'image/png': 'png',
  'image/jpeg': 'jpg',
  'image/jpg': 'jpg',
  'image/webp': 'webp',
  'image/gif': 'gif',
  'image/bmp': 'bmp',
};

function checkpointOversizedHistory(
  manager: SessionManager,
  budget: ReturnType<typeof modelContextBudget>,
  historyTokens: number,
  keepRecentTokens = budget.recent,
) {
  const entries = manager.buildContextEntries();
  const lastAnswer = entries.findLastIndex(
    (entry) =>
      entry.type === 'message' &&
      entry.message.role === 'assistant' &&
      ['stop', 'length'].includes(entry.message.stopReason),
  );
  const firstPending = entries
    .slice(lastAnswer + 1)
    .find(
      (entry) =>
        (entry.type === 'message' && entry.message.role === 'user') ||
        (entry.type === 'custom_message' && entry.customType === 'nod-audio-input'),
    );
  let recentTokens = 0;
  let firstKept: string | null = null;
  for (const entry of entries.toReversed()) {
    if (entry.type !== 'message') continue;
    recentTokens += estimateModelTokens(entry.message);
    if (recentTokens > keepRecentTokens) break;
    if (entry.message.role === 'user') firstKept = entry.id;
  }
  manager.appendCompaction(
    oversizedHistoryCheckpoint,
    entries.find((entry) => entry.id === firstKept || entry.id === firstPending?.id)?.id ?? null,
    historyTokens,
  );
}

export function createPiAgent(options: {
  provider: string;
  resolve?: () => Promise<ModelAccess>;
  model?: string;
  apiKey?: string;
  sessionRoot: string;
  configRoot?: string;
  createSession?: typeof createAgentSession;
  traces?: ModelTraces;
}): Agent {
  configureWebAccess(options.configRoot ?? join(tmpdir(), 'nod-pi'));
  const active = new Map<
    Awaited<ReturnType<typeof createAgentSession>>['session'],
    () => Promise<void>
  >();
  let disposed = false;
  const warming = new Map<string, () => Promise<void>>();
  return {
    async open(input) {
      if (disposed) throw new Error('The agent service has stopped.');
      const access = await options.resolve?.();
      if (input.automatic) await access?.prepareRequest?.(access.definition.choice.id, true);
      if (!access && !options.apiKey)
        throw new Error('Configure the selected model provider to enable the assistant.');
      if (access?.method === 'subscription') {
        const observe = input.onEvent;
        input = {
          ...input,
          onEvent: (event) =>
            observe(
              event.type === 'model_usage'
                ? {
                    ...event,
                    costUsd: null,
                    estimateUsd: event.costUsd,
                    costSource: 'unavailable',
                  }
                : event.type === 'provider_usage'
                  ? {
                      ...event,
                      usage: {
                        ...event.usage,
                        costUsd: null,
                        estimateUsd: event.usage.costUsd,
                        pricing: 'unavailable',
                      },
                    }
                  : event,
            ),
        };
      }
      const sessionId = input.sessionId;
      const ephemeral = input.ephemeral === true;
      const directory = resolve(options.sessionRoot, threadIdentity(sessionId));
      await warming.get(directory)?.();
      await mkdir(directory, { recursive: true, mode: 0o700 });
      const traces = options.traces;
      const connection = access
        ? await createPiModelRuntime(access, {
            automatic: input.automatic,
            trace:
              traces &&
              ((call) => {
                if (traces.active())
                  traces.record(
                    piModelTrace(
                      call,
                      {
                        source: 'agent',
                        session_id: input.sessionId,
                        turn_id: input.turnId,
                        run_id: input.runId,
                        ...(input.parentRunId ? { parent_run_id: input.parentRunId } : {}),
                      },
                      input.ownerContext,
                    ),
                  );
              }),
            readAudio: input.readAudio,
            reportCacheUsage: (usage) =>
              input.onEvent({
                type: 'provider_usage',
                usage: { ...usage, turnId: input.turnId },
              }),
          })
        : undefined;
      const runtime = connection
        ? connection.runtime
        : await ModelRuntime.create({
            credentials: new InMemoryCredentialStore(),
            modelsPath: null,
            refreshOnCreate: false,
            allowModelNetwork: false,
          });
      if (!access) await runtime.setRuntimeApiKey(options.provider, options.apiKey!);
      const modelId =
        access?.definition.choice.id ||
        options.model ||
        agentModels[options.provider as keyof typeof agentModels];
      const selectedModel =
        connection?.model ?? (modelId ? runtime.getModel(options.provider, modelId) : undefined);
      if (!selectedModel)
        throw new Error('The configured model is not present in the installed Pi catalog.');
      const model =
        selectedModel.provider === 'openai' &&
        selectedModel.api === 'openai-responses' &&
        selectedModel.id === agentModels.openai
          ? {
              ...selectedModel,
              samplingParams: {
                ...selectedModel.samplingParams,
                text: {
                  ...(selectedModel.samplingParams?.text as Record<string, unknown> | undefined),
                  verbosity: 'low',
                },
              },
            }
          : selectedModel;
      const budget = modelContextBudget({
        ...model,
        contextWindow: Math.min(
          model.contextWindow,
          connection?.textModel?.contextWindow ?? model.contextWindow,
        ),
      });
      if (budget.compact && input.compactInstructions)
        input = { ...input, ...input.compactInstructions };
      const boundedOutput = async (
        name: string,
        run: () => ReturnType<ToolDefinition['execute']>,
        signal?: AbortSignal,
        nested = false,
      ) => {
        const result = await run();
        if (nested) return result;
        const text = result.content
          .filter((part) => part.type === 'text')
          .map((part) => part.text)
          .join('\n');
        const images = result.content.filter((part) => part.type === 'image');
        if (!text && !images.length) return result;
        const history = manager.buildSessionContext().messages;
        const lastCompleted = history.findLastIndex(
          (message) =>
            message.role === 'assistant' && ['stop', 'length'].includes(message.stopReason),
        );
        const pending = history.slice(lastCompleted + 1);
        const lastAssistant = pending.findLastIndex((message) => message.role === 'assistant');
        const ownerCopy = input.ownerContext ? history.findLastIndex(isOwnerContext) : -1;
        const active = history.filter(
          (message, index) => message.role !== 'system' && index !== ownerCopy,
        );
        const assistant = pending[lastAssistant];
        const remainingCalls = Math.max(
          1,
          (assistant?.role === 'assistant'
            ? assistant.content.filter((part) => part.type === 'toolCall').length
            : 1) -
            pending.slice(lastAssistant + 1).filter((message) => message.role === 'toolResult')
              .length,
        );
        const overheadTokens = requestOverheadTokens();
        const pointerTokens = Math.max(
          0,
          Math.floor(
            (budget.window - overheadTokens - estimateModelTokens(active)) / remainingCalls,
          ),
        );
        if (
          text.length <= Math.floor(budget.window / 2) &&
          estimateModelTokens(text) + (images.length ? estimateModelTokens(images) : 0) <=
            pointerTokens
        )
          return result;
        signal?.throwIfAborted();
        if (input.shouldStop()) throw new Error('The turn was stopped.');
        const directory = `${input.workspace.path}/.nod/outputs`;
        const stem = `.nod/outputs/${randomBytes(12).toString('base64url')}`;
        const textFile = `${stem}.txt`;
        if (
          (
            await input.workspace.exec(`mkdir -p -- '${directory.replaceAll("'", "'\\''")}'`, {
              signal,
            })
          ).exitCode
        )
          throw new Error('The full tool output could not be saved.');
        let file = textFile;
        if (images.length) {
          const savedContent = [];
          for (const [index, part] of result.content.entries()) {
            const mimeType =
              part.type === 'image' ? part.mimeType.toLowerCase().split(';')[0]!.trim() : '';
            const partFile =
              part.type === 'image'
                ? `${stem}-${index}.${imageOutputExtensions[mimeType] ?? 'bin'}`
                : `${stem}-${index}.txt`;
            await writeWorkspaceFile(
              input.workspace,
              `${input.workspace.path}/${partFile}`,
              part.type === 'image' ? Buffer.from(part.data, 'base64') : Buffer.from(part.text),
              signal,
            );
            savedContent.push(
              part.type === 'image'
                ? { type: 'image', path: partFile, mimeType: part.mimeType }
                : { type: 'text', path: partFile },
            );
          }
          file = `${stem}.json`;
          await writeWorkspaceFile(
            input.workspace,
            `${input.workspace.path}/${file}`,
            Buffer.from(JSON.stringify({ content: savedContent })),
            signal,
          );
        } else
          await writeWorkspaceFile(
            input.workspace,
            `${input.workspace.path}/${textFile}`,
            Buffer.from(text),
            signal,
          );
        let preview = text.slice(0, 1000);
        const reference = (excerpt: string) =>
          JSON.stringify(
            excerpt
              ? { workspaceFile: file, characters: text.length, preview: excerpt }
              : { workspaceFile: file },
          );
        let saved = reference(preview);
        let pointer = result.isError ? saved : untrustedBlock(name, saved);
        while (preview && estimateModelTokens(pointer) > pointerTokens) {
          preview = preview.slice(0, Math.floor(preview.length / 2));
          saved = reference(preview);
          pointer = result.isError ? saved : untrustedBlock(name, saved);
        }
        return {
          ...result,
          content: [{ type: 'text' as const, text: pointer }],
        };
      };
      let idle = false;
      let activation: ExtensionAPI | undefined;
      const manager = ephemeral ? SessionManager.inMemory(directory) : openLocalSession(directory);
      dropFailedInput(manager);
      closeInterruptedCalls(manager);
      const prior = manager.buildSessionContext().messages;
      const last = prior.findLast((message) => message.role === 'assistant');
      const priorTokens = input.restartable === true ? estimateModelTokens(prior) : 0;
      const restart =
        input.restartable === true &&
        prior.length > 0 &&
        (!last || Date.now() - last.timestamp >= warmCache || priorTokens > budget.recent);
      const cached: { owner?: string; stable?: string[] } = { owner: input.ownerContext };
      const keepCache =
        restart &&
        model.api === 'anthropic-messages' &&
        last !== undefined &&
        Date.now() - last.timestamp < longCache;
      const scheduleCache = model.api === 'anthropic-messages' ? input.scheduleCache : undefined;
      if (keepCache || scheduleCache === 'long') {
        const stream = runtime.streamSimple.bind(runtime);
        runtime.streamSimple = (target, context, options) =>
          stream(target, context, { ...options, cacheRetention: 'long' });
      }
      if (restart)
        manager.appendCompaction(
          'Earlier checks are saved outside this context. Use the current request and fresh source reads.',
          null,
          priorTokens,
        );
      const historyTokens = estimateModelTokens(manager.buildSessionContext().messages);
      if (budget.compact && historyTokens > budget.window / 2)
        checkpointOversizedHistory(manager, budget, historyTokens);
      const sandboxTools = input.restricted ? [] : createSandbox(input.workspace, input.timeZone);
      const tools: ToolDefinition[] = [
        ...sandboxTools.map((definition): ToolDefinition => ({
          ...definition,
          execute: async (id, params, signal, onUpdate, context) => {
            const result = await input.runTool(
              definition.name,
              params,
              () =>
                id.includes('/')
                  ? definition.execute(id, params, signal, onUpdate, context)
                  : boundedOutput(
                      definition.name,
                      () => definition.execute(id, params, signal, onUpdate, context),
                      signal,
                    ),
              { nested: id.includes('/') },
            );
            return { ...result, details: result.details ?? {} };
          },
        })),
        ...input.tools.map((tool): ToolDefinition => ({
          name: tool.name === 'browser' ? 'nod_browser' : tool.name,
          label: tool.name.replaceAll('_', ' '),
          description: tool.description,
          parameters: (tool.name === 'send_message'
            ? {
                ...tool.parameters,
                properties: { ...(tool.parameters.properties as object), presentation: openSchema },
              }
            : tool.deferred
              ? toolSchema(tool.parameters)
              : tool.parameters) as ToolDefinition['parameters'],
          ...((!input.restricted && !tool.eager) || tool.deferred || budget.compact
            ? {
                exposure: 'deferred' as const,
                namespace: tool.deferred
                  ? { name: tool.deferred.namespace, description: tool.deferred.description }
                  : {
                      name: 'nod',
                      description: 'Nod tools for apps, browsers, files, memory and tasks.',
                    },
              }
            : { exposure: 'direct' as const }),
          executionMode: tool.parallel ? 'parallel' : 'sequential',
          execute: async (id, args, signal) => {
            const active = activation?.getActiveTools() ?? [];
            const missing = (budget.compact ? [] : (tool.companions ?? [])).filter(
              (name) => !active.includes(name) && input.tools.some((item) => item.name === name),
            );
            if (missing.length) activation?.setActiveTools([...active, ...missing]);
            return {
              ...(await boundedOutput(
                tool.name,
                () =>
                  tool
                    .execute(args as Record<string, unknown>, { nested: id.includes('/') })
                    .then((result) => ({ ...result, details: result.details ?? {} })),
                signal,
                id.includes('/'),
              )),
              details: {},
            };
          },
        })),
      ];
      const deferred =
        !input.restricted || budget.compact || input.tools.some((tool) => tool.deferred);
      const settings = SettingsManager.inMemory({
        compaction: {
          enabled: true,
          reserveTokens: budget.reserve,
          keepRecentTokens: budget.recent,
        },
        transport: 'sse',
        steeringMode: 'all',
        cacheWarming: input.keepWarm ? 'idle' : 'streaming',
        ...(access?.provider === 'compatible' ? { httpIdleTimeoutMs: localModelSilenceMs } : {}),
      });
      const extensionLoader = new DefaultResourceLoader({
        cwd: input.workspace.path,
        agentDir: directory,
        settingsManager: SettingsManager.inMemory({}, { projectTrusted: false }),
        additionalExtensionPaths: input.restricted ? [] : [webExtension],
        extensionFactories: [
          (pi: ExtensionAPI) => {
            activation = pi;
          },
          ...(input.restricted
            ? []
            : [createCodemodeExtension({ inlineBudget: 0, models: false })]),
          ...(deferred
            ? [
                (pi: ExtensionAPI) =>
                  createToolSearchExtension()({
                    ...pi,
                    registerTool: (tool) =>
                      pi.registerTool({
                        ...tool,
                        name: 'nod_tool_search',
                        description: tool.description.replaceAll('tool_search', 'nod_tool_search'),
                        execute: async (id, params, signal, update, context) => {
                          if (budget.compact)
                            pi.setActiveTools([
                              ...sandboxTools.map((tool) => tool.name),
                              'nod_tool_search',
                            ]);
                          const result = await tool.execute(
                            id,
                            budget.compact
                              ? ({ ...(params as object), limit: 1 } as typeof params)
                              : params,
                            signal,
                            update,
                            context,
                          );
                          const loaded = (result.details as { loaded?: string[] } | undefined)
                            ?.loaded;
                          return budget.compact && loaded?.length
                            ? {
                                ...result,
                                content: [
                                  { type: 'text' as const, text: `Loaded: ${loaded.join(', ')}` },
                                ],
                              }
                            : result;
                        },
                      }),
                  }),
              ]
            : []),
          recentImages,
          audioContext(manager, readsNativeAudio(model) && Boolean(input.readAudio)),
          threadPromptCache(input.threadId),
          ...(keepCache || scheduleCache
            ? [
                stableRequestCache(
                  cached,
                  keepCache ? 'long' : scheduleCache!,
                  Boolean(scheduleCache),
                ),
              ]
            : []),
          ownerContextCopies(input.ownerContext),
          (pi: ExtensionAPI) =>
            pi.on('session_before_compact', async ({ preparation, reason, signal }) => {
              if (
                reason === 'threshold' &&
                !budget.compact &&
                session.agent.state.isStreaming &&
                preparation.tokensBefore + budget.output + budget.margin <= budget.window &&
                preparation.tokensBefore <= budget.window - budget.reserve + budget.recent
              ) {
                compaction = undefined;
                return { cancel: true };
              }
              const target = session.model ?? model;
              try {
                return {
                  compaction: await compact(
                    preparation,
                    target,
                    undefined,
                    undefined,
                    undefined,
                    signal,
                    lightestEffort(getSupportedThinkingLevels(target)),
                    session.agent.streamFunction,
                    undefined,
                    settings.getRetrySettings(),
                  ),
                };
              } catch (error) {
                const message = error instanceof Error ? error.message : String(error);
                if (
                  signal.aborted ||
                  !isContextOverflow({
                    stopReason: 'error',
                    errorMessage: message,
                    provider: target.provider,
                  } as AssistantMessage)
                )
                  throw error;
                const entries = manager.buildSessionProjection().entries;
                const cut = entries.findIndex(
                  (entry) => entry.sourceEntry.id === preparation.firstKeptEntryId,
                );
                const lastAnswer = entries.findLastIndex((entry) =>
                  entry.messages.some(
                    (message) =>
                      message.role === 'assistant' &&
                      ['stop', 'length'].includes(message.stopReason),
                  ),
                );
                const firstPending = entries.findIndex(
                  (entry, index) =>
                    index > lastAnswer &&
                    entry.messages.some(
                      (message) =>
                        message.role === 'user' ||
                        (message.role === 'custom' && message.customType === 'nod-audio-input'),
                    ),
                );
                return {
                  compaction: {
                    summary: oversizedHistoryCheckpoint,
                    firstKeptEntryId:
                      firstPending >= 0 && firstPending < cut
                        ? entries[firstPending]!.sourceEntry.id
                        : preparation.firstKeptEntryId,
                    tokensBefore: preparation.tokensBefore,
                  },
                };
              }
            }),
          (pi: ExtensionAPI) =>
            pi.on('cache_warming_decision', async () => {
              try {
                await access?.prepareRequest?.(connection?.textModel?.id ?? model.id, true);
              } catch {
                return { action: 'stop' as const };
              }
              return idle && !(await input.keepWarm?.().catch(() => false))
                ? { action: 'stop' as const }
                : undefined;
            }),
          completeAssistantMessages,
        ],
        noExtensions: true,
        noSkills: true,
        noPromptTemplates: true,
        noThemes: true,
        noContextFiles: true,
      });
      await extensionLoader.reload();
      const extensions = extensionLoader.getExtensions();
      if (extensions.errors.length) throw new Error('The Pi extensions could not be loaded.');
      const connections = publicWebRequests();
      for (const extension of extensions.extensions) {
        const web = extension.path === webExtension;
        for (const [name, registered] of extension.tools) {
          const search = name === 'web_search';
          extension.tools.set(name, {
            ...registered,
            definition: {
              ...registered.definition,
              ...((!input.restricted || budget.compact) &&
              !['nod_tool_search', 'codemode'].includes(name)
                ? { exposure: 'deferred' as const, namespace: { name: web ? 'web' : 'workspace' } }
                : {}),
              ...(web
                ? {
                    parameters: webParameters(registered.definition.parameters),
                    executionMode: 'parallel' as const,
                  }
                : {}),
              ...(search
                ? {
                    description:
                      'Search the public web through the configured Pi provider. Use queries with 2-4 varied angles for broad research. Return source-linked results without a curator or a separate summary. Use includeContent only when full source text is needed.',
                  }
                : {}),
              execute: async (id, params, signal, onUpdate, context) => {
                const args = web
                  ? {
                      ...visibleWebParameters(params as Record<string, unknown>),
                      ...(search ? { workflow: 'none' } : {}),
                    }
                  : params;
                const result = await input.runTool(
                  name === 'nod_tool_search' ? 'tool_search' : name,
                  args,
                  () =>
                    boundedOutput(
                      name,
                      () =>
                        workspaceOutputs(
                          () =>
                            web
                              ? webRequests.run(connections, () =>
                                  registered.definition.execute(
                                    id,
                                    args,
                                    signal,
                                    onUpdate,
                                    context,
                                  ),
                                )
                              : registered.definition.execute(id, args, signal, onUpdate, context),
                          input.workspace,
                          signal,
                        ),
                      signal,
                      id.includes('/'),
                    ),
                  { nested: id.includes('/') },
                );
                const usage = (result as { usage?: ModelUsage }).usage;
                if (usage)
                  input.onEvent({
                    type: 'provider_usage',
                    usage: {
                      id: randomUUID(),
                      provider: 'codemode',
                      category: 'agent',
                      operation: 'models',
                      turnId: input.turnId,
                      status: 'succeeded',
                      durationMs: 0,
                      inputTokens: usage.input,
                      outputTokens: usage.output,
                      costUsd: Number.isFinite(usage.cost?.total) ? usage.cost!.total : null,
                      pricing: Number.isFinite(usage.cost?.total) ? 'sdk_estimate' : 'unavailable',
                    },
                  });
                return { ...result, details: result.details ?? {} };
              },
            },
          });
        }
      }
      const guidelines = [
        ...new Set(
          [
            ...tools,
            ...extensions.extensions.flatMap((extension) =>
              [...extension.tools.values()].map((tool) => tool.definition),
            ),
          ]
            .filter((tool) => !budget.compact || tool.exposure !== 'deferred')
            .flatMap((tool) => tool.promptGuidelines ?? []),
        ),
      ];
      if (guidelines.some((rule) => rule.includes('codemode')))
        guidelines.push(
          'Codemode can call workspace, web, app and Nod tools. Every call keeps its normal validation, owner authority, approval and stop checks. Read schemas with searchTools or describeTool when needed. Await every call and inspect its result. Use direct tool calls when you need images.',
        );
      if (input.tools.some((tool) => tool.name === 'browser'))
        guidelines.push(
          'Use nod_browser for browser calls. In older procedures, browser means this tool.',
        );
      if (deferred) guidelines.push('Use nod_tool_search to load deferred tools.');
      const systemPrompt = guidelines.length
        ? `${input.systemPrompt}\n\nTool guidelines:\n${guidelines.map((rule) => `- ${rule}`).join('\n')}`
        : input.systemPrompt;
      const resumed = !restart && manager.buildSessionContext().messages.length > 0;
      const { session } = await (options.createSession ?? createAgentSession)({
        cwd: input.workspace.path,
        agentDir: directory,
        modelRuntime: runtime,
        model: { ...model, contextWindow: budget.window },
        thinkingLevel: access?.effort ?? 'high',
        tools: [
          ...tools
            .filter((tool) => budget.compact || tool.exposure !== 'deferred')
            .map((tool) => `+${tool.name}`),
          ...extensions.extensions.flatMap((extension) =>
            [...extension.tools.entries()]
              .filter(([, tool]) => budget.compact || tool.definition.exposure !== 'deferred')
              .map(([name]) => `+${name}`),
          ),
        ],
        customTools: tools,
        noTools: 'builtin',
        resourceLoader: resources(systemPrompt, extensions),
        sessionManager: manager,
        settingsManager: settings,
      });
      if (budget.compact)
        session.setActiveToolsByName([...sandboxTools.map((tool) => tool.name), 'nod_tool_search']);
      const requestOverheadTokens = () =>
        estimateModelTokens({
          systemPrompt,
          ownerContext: input.ownerContext,
          tools: session.getActiveToolNames().flatMap((name) => {
            const tool = session.getToolDefinition(name);
            return tool
              ? [{ name: tool.name, description: tool.description, parameters: tool.parameters }]
              : [];
          }),
        }) +
        budget.margin +
        128;
      if (disposed) {
        session.dispose();
        throw new Error('The agent service has stopped.');
      }

      const finishTurn = session.agent.finishTurn;
      session.agent.finishTurn = async (turn, signal) => {
        const result = await finishTurn?.(turn, signal);
        if (
          input.shouldStop(
            turn.toolResults.map((result) => ({
              name: result.toolName,
              ...(result.isError
                ? {
                    error: result.content
                      .flatMap((part) => (part.type === 'text' ? [part.text] : []))
                      .join('\n'),
                  }
                : {}),
            })),
          )
        )
          return { action: 'end' as const };
        if (
          input.nextMessages &&
          result?.action !== 'end' &&
          ['stop', 'toolUse'].includes(turn.message.stopReason)
        )
          for (const message of await input.nextMessages()) {
            if (message.audio && readsNativeAudio(model))
              await session.sendCustomMessage(
                audioMessage(message.text, message.images, message.audio),
                { deliverAs: 'steer' },
              );
            else await session.steer(message.text, message.images);
          }
        return result ?? undefined;
      };
      let textBlock: number | undefined;
      let thinking = { index: -1, text: '', scanned: 0 };
      let compaction: { id: string; started: number } | undefined;
      const auxiliarySeen = new Set(manager.getEntries().map((entry) => entry.id));
      const observeUsage = createPiUsageTracker({
        sessionId: manager.getSessionId(),
        provider: model.provider,
        model: model.id,
        history: manager
          .getEntries()
          .flatMap((entry) =>
            entry.type === 'message' && entry.message.role === 'assistant' ? [entry.message] : [],
          ),
      });
      const unsubscribe = session.subscribe((event) => {
        if (event.type === 'compaction_start')
          compaction = { id: randomUUID(), started: performance.now() };
        if (event.type === 'compaction_end' && compaction) {
          const target = readsNativeAudio(model) ? (connection?.textModel ?? model) : model;
          input.onEvent({
            type: 'provider_usage',
            usage: {
              id: compaction.id,
              provider: target.provider,
              category: 'agent',
              operation: 'compaction',
              model: target.id,
              turnId: input.turnId,
              status: event.aborted ? 'cancelled' : event.errorMessage ? 'failed' : 'succeeded',
              durationMs: performance.now() - compaction.started,
              ...piUsageMetrics(event.result?.usage),
            },
          });
          compaction = undefined;
        }
        if (
          event.type === 'entry_appended' &&
          event.entry.type === 'usage' &&
          (!connection || event.entry.kind !== 'cache_warm') &&
          !auxiliarySeen.has(event.entry.id)
        ) {
          auxiliarySeen.add(event.entry.id);
          input.onEvent({
            type: 'provider_usage',
            usage: {
              id: usageId(manager.getSessionId(), event.entry.id),
              provider: event.entry.provider,
              category: 'agent',
              operation: event.entry.kind === 'cache_warm' ? 'cache_warm' : 'auxiliary',
              model: event.entry.model,
              turnId: input.turnId,
              status: 'succeeded',
              durationMs: 0,
              ...piUsageMetrics(event.entry.usage),
            },
          });
        }
        if (event.type === 'message_start' && event.message.role === 'assistant') {
          textBlock = undefined;
          thinking = { index: -1, text: '', scanned: 0 };
          input.onEvent({ type: 'message_start' });
        }
        if (event.type === 'turn_start') input.onEvent({ type: 'turn_start' });
        if (event.type === 'auto_retry_start')
          input.onEvent({
            type: 'retry',
            model: (session.model ?? model).name,
            attempt: event.attempt,
            attempts: event.maxAttempts,
          });
        if (event.type === 'message_update') {
          const update = event.assistantMessageEvent;
          if (update.type === 'text_start' || update.type === 'text_delta') {
            if (textBlock !== undefined && textBlock !== update.contentIndex) {
              input.onEvent({ type: 'message_end' });
              input.onEvent({ type: 'message_start' });
            }
            textBlock = update.contentIndex;
          }
          if (update.type === 'toolcall_start' && textBlock !== undefined) {
            input.onEvent({ type: 'message_end' });
            input.onEvent({ type: 'message_start' });
            textBlock = undefined;
          }
          if (update.type === 'text_delta')
            input.onEvent({ type: 'text_delta', text: update.delta });
          if (update.type === 'thinking_delta' || update.type === 'thinking_end') {
            if (thinking.index !== update.contentIndex)
              thinking = { index: update.contentIndex, text: '', scanned: 0 };
            thinking.text =
              update.type === 'thinking_end' ? `${update.content}\n` : thinking.text + update.delta;
            const end = thinking.text.lastIndexOf('\n') + 1;
            if (end > thinking.scanned) {
              for (const title of thinkingTitles(thinking.text.slice(thinking.scanned, end)))
                input.onEvent({ type: 'thinking', title });
              thinking.scanned = end;
            }
          }
        }
        if (event.type === 'message_end' && event.message.role === 'assistant') {
          const usage = observeUsage(event.message);
          if (usage) input.onEvent(usage);
          if (event.message.stopReason === 'error')
            input.onEvent({
              type: 'error',
              message: `${event.message.provider} / ${event.message.model}: ${event.message.errorMessage?.trim() || 'The provider gave no reason.'}`,
            });
          if (event.message.stopReason === 'stop') {
            const blocks = event.message.content.filter((item) => item.type === 'text');
            const finalBlocks = blocks.filter((item) => isFinalAnswer(item.textSignature));
            input.onEvent({
              type: 'final',
              text: (finalBlocks.length ? finalBlocks : blocks).map((item) => item.text).join('\n'),
            });
          }
          const status = ['stop', 'toolUse'].includes(event.message.stopReason)
            ? 'succeeded'
            : event.message.stopReason === 'length'
              ? 'incomplete'
              : event.message.stopReason === 'error'
                ? 'failed'
                : event.message.stopReason === 'aborted'
                  ? 'cancelled'
                  : undefined;
          const tokens = event.message.usage;
          const contextExhausted =
            status === 'incomplete' &&
            tokens.input + tokens.cacheRead + tokens.cacheWrite + tokens.output >=
              budget.window - budget.margin;
          input.onEvent({
            type: 'message_end',
            ...(status ? { status } : {}),
            ...(contextExhausted ? { contextExhausted: true } : {}),
          });
        }
      });
      const close = async () => {
        unsubscribe();
        session.dispose();
        active.delete(session);
      };
      const dispose = async () => {
        if (disposed || !input.keepWarm || session.cacheWarmingStatus?.state === 'inactive')
          return close();
        idle = true;
        const release = async () => {
          clearTimeout(timer);
          if (warming.get(directory) === release) warming.delete(directory);
          await close();
        };
        const timer = setTimeout(() => void release(), warmIdle);
        timer.unref?.();
        warming.set(directory, release);
      };
      active.set(session, dispose);
      return {
        resumed,
        readsImages: model.input.includes('image'),
        readsAudio: readsNativeAudio(model) && Boolean(input.readAudio),
        contextWindow: budget.window,
        async prompt(text, images, audio, stablePrefixes) {
          cached.stable = stablePrefixes;
          if (
            budget.compact &&
            Math.ceil(Buffer.byteLength(text) / 3) + budget.output + budget.margin > budget.window
          )
            throw new Error(
              `This request does not fit the model's ${budget.window}-token context. Use a model with a larger context or a shorter request.`,
            );
          const overheadTokens = requestOverheadTokens();
          const incomingTokens = estimateModelTokens({ text, images, audio });
          const currentHistory = manager.buildSessionContext().messages;
          const lastCompleted = currentHistory.findLastIndex(
            (message) =>
              message.role === 'assistant' && ['stop', 'length'].includes(message.stopReason),
          );
          const unfinished = currentHistory.slice(lastCompleted + 1);
          if (
            unfinished.some(
              (message) =>
                message.role === 'user' ||
                (message.role === 'custom' && message.customType === 'nod-audio-input'),
            ) &&
            estimateModelTokens(unfinished) + incomingTokens + overheadTokens >= budget.window
          )
            throw new Error(
              `The unfinished request does not fit this model's ${budget.window}-token context. Use a model with a larger context or reset the conversation.`,
            );
          if (
            !budget.compact &&
            currentHistory.length > 0 &&
            estimateModelTokens(currentHistory) + incomingTokens + overheadTokens >= budget.window
          ) {
            try {
              await session.compact();
            } catch (error) {
              const message = error instanceof Error ? error.message : String(error);
              if (
                message !== 'Nothing to compact (session too small)' &&
                message !== 'Already compacted' &&
                !isContextOverflow({
                  stopReason: 'error',
                  errorMessage: message,
                  provider: model.provider,
                } as AssistantMessage)
              )
                throw error;
            }
            const remaining = estimateModelTokens(manager.buildSessionContext().messages);
            if (remaining + incomingTokens + overheadTokens >= budget.window) {
              checkpointOversizedHistory(
                manager,
                budget,
                remaining,
                Math.min(
                  budget.recent,
                  Math.max(
                    0,
                    budget.window -
                      incomingTokens -
                      overheadTokens -
                      estimateModelTokens(oversizedHistoryCheckpoint),
                  ),
                ),
              );
              session.refreshContext();
              if (
                estimateModelTokens(manager.buildSessionContext().messages) +
                  incomingTokens +
                  overheadTokens >=
                budget.window
              )
                throw new Error(
                  `This request does not fit this model's ${budget.window}-token context after reducing saved history. Use a model with a larger context or a shorter request.`,
                );
            }
          }
          const owner = input.ownerContext;
          const copy = manager.buildSessionContext().messages.findLast(isOwnerContext);
          if (owner && (copy as { content?: unknown } | undefined)?.content !== owner)
            await session.sendCustomMessage(
              { customType: ownerContextType, content: owner, display: false },
              prior.length ? undefined : { deliverAs: 'nextTurn' },
            );
          if (audio && readsNativeAudio(model))
            await session.sendCustomMessage(audioMessage(text, images, audio), {
              triggerTurn: true,
            });
          else await session.prompt(text, { images, expandPromptTemplates: false });
          if (dropFailedInput(manager)) session.refreshContext();
        },
        async abort() {
          await session.abort();
        },
        dispose,
      };
    },
    async dispose() {
      disposed = true;
      await Promise.allSettled([...warming.values()].map((release) => release()));
      const results = await Promise.allSettled(
        [...active].map(async ([session, dispose]) => {
          try {
            await session.abort();
          } finally {
            await dispose();
          }
        }),
      );
      if (results.some((result) => result.status === 'rejected'))
        throw new Error('The agent service could not finish cleaning up its sessions.');
    },
  };
}
