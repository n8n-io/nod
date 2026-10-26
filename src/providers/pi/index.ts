import { AsyncLocalStorage } from 'node:async_hooks';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { mkdir } from 'node:fs/promises';
import { isIP } from 'node:net';
import { join, resolve } from 'node:path';
import { createHmac, randomBytes, randomUUID } from 'node:crypto';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { InMemoryCredentialStore } from '@earendil-works/pi-ai';
import { Agent as Connections, Dispatcher1Wrapper, buildConnector } from 'undici';
import { Compile } from 'typebox/compile';
import {
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
import { createPiModelRuntime } from './models.ts';
import { piModelTrace } from './traces.ts';
import type { ModelTraces } from '../../ports/traces.ts';
import type { ModelAccess } from '../../ports/models.ts';
import type { Agent } from '../../ports/agent.ts';
import type { WorkspaceSession } from '../../ports/computer.ts';
import { closeInterruptedCalls, keptImages, openLocalSession, removedImage } from './checkpoint.ts';
import { threadIdentity } from '../../ports/thread-identity.ts';
import { createPiUsageTracker, piUsageMetrics, usageId } from './usage.ts';
import { agentModels } from '../../shared/model-defaults.ts';
import { createSandbox, workspaceOutputs } from './sandbox.ts';
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

const compactAt = 256_000;
const imageStep = 8;

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
  return {
    async open(input) {
      if (disposed) throw new Error('The agent service has stopped.');
      const access = await options.resolve?.();
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
      await mkdir(directory, { recursive: true, mode: 0o700 });
      const traces = options.traces;
      const connection = access
        ? await createPiModelRuntime(
            access,
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
          )
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
      const manager = ephemeral ? SessionManager.inMemory(directory) : openLocalSession(directory);
      closeInterruptedCalls(manager);
      const sandboxTools = input.restricted ? [] : createSandbox(input.workspace, input.timeZone);
      const tools: ToolDefinition[] = [
        ...sandboxTools.map((definition): ToolDefinition => ({
          ...definition,
          execute: async (id, params, signal, onUpdate, context) => {
            const result = await input.runTool(
              definition.name,
              params,
              () => definition.execute(id, params, signal, onUpdate, context),
              { nested: id.includes('/') },
            );
            return { ...result, details: result.details ?? {} };
          },
        })),
        ...input.tools.map((tool): ToolDefinition => ({
          name: tool.name,
          label: tool.name.replaceAll('_', ' '),
          description: tool.description,
          parameters: (tool.deferred
            ? toolSchema(tool.parameters)
            : tool.parameters) as ToolDefinition['parameters'],
          ...(tool.deferred
            ? {
                exposure: 'deferred' as const,
                namespace: {
                  name: tool.deferred.namespace,
                  description: tool.deferred.description,
                },
              }
            : { exposure: 'model-only' as const }),
          executionMode: tool.parallel ? 'parallel' : 'sequential',
          execute: async (id, args) => {
            return {
              ...(await tool.execute(args as Record<string, unknown>, {
                nested: id.includes('/'),
              })),
              details: {},
            };
          },
        })),
      ];
      const deferred = input.tools.some((tool) => tool.deferred);
      const extensionLoader = new DefaultResourceLoader({
        cwd: input.workspace.path,
        agentDir: directory,
        settingsManager: SettingsManager.inMemory({}, { projectTrusted: false }),
        additionalExtensionPaths: input.restricted ? [] : [webExtension],
        extensionFactories: [
          ...(input.restricted ? [] : [createCodemodeExtension()]),
          ...(deferred ? [createToolSearchExtension()] : []),
          recentImages,
          threadPromptCache(input.threadId),
          ownerContextCopies(input.ownerContext),
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
                  name,
                  args,
                  () =>
                    workspaceOutputs(
                      () =>
                        web
                          ? webRequests.run(connections, () =>
                              registered.definition.execute(id, args, signal, onUpdate, context),
                            )
                          : registered.definition.execute(id, args, signal, onUpdate, context),
                      input.workspace,
                      signal,
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
          ].flatMap((tool) => tool.promptGuidelines ?? []),
        ),
      ];
      if (guidelines.some((rule) => rule.includes('codemode')))
        guidelines.push(
          deferred
            ? 'Codemode scripts can call workspace, web and connected MCP server tools (mcp__ names, found with tool_search, searchTools or describeTool); call apps, browser and other Nod tools directly.'
            : 'Codemode scripts can call only workspace and web tools; call apps, browser and other Nod tools directly.',
        );
      const systemPrompt = guidelines.length
        ? `${input.systemPrompt}\n\nTool guidelines:\n${guidelines.map((rule) => `- ${rule}`).join('\n')}`
        : input.systemPrompt;
      const resumed = manager.buildSessionContext().messages.length > 0;
      const { session } = await (options.createSession ?? createAgentSession)({
        cwd: input.workspace.path,
        agentDir: directory,
        modelRuntime: runtime,
        model,
        thinkingLevel: access?.effort ?? 'high',
        tools: [
          ...tools.filter((tool) => tool.exposure !== 'deferred').map((tool) => tool.name),
          ...extensions.extensions.flatMap((extension) => [...extension.tools.keys()]),
        ],
        customTools: tools,
        noTools: 'builtin',
        resourceLoader: resources(systemPrompt, extensions),
        sessionManager: manager,
        settingsManager: SettingsManager.inMemory({
          compaction: {
            enabled: true,
            reserveTokens: Math.max(16_384, (model.contextWindow || 0) - compactAt),
            keepRecentTokens: Math.max(
              0,
              Math.round(Math.min(compactAt, (model.contextWindow || compactAt) - 16_384) / 3),
            ),
          },
          transport: 'sse',
          steeringMode: 'all',
        }),
      });
      if (disposed) {
        session.dispose();
        throw new Error('The agent service has stopped.');
      }

      const finishTurn = session.agent.finishTurn;
      session.agent.finishTurn = async (turn, signal) => {
        const result = await finishTurn?.(turn, signal);
        if (input.shouldStop()) return { action: 'end' as const };
        if (
          input.nextMessages &&
          result?.action !== 'end' &&
          ['stop', 'toolUse'].includes(turn.message.stopReason)
        )
          for (const message of await input.nextMessages())
            await session.steer(message.text, message.images);
        return result ?? undefined;
      };
      let textBlock: number | undefined;
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
        if (event.type === 'compaction_end') {
          input.onEvent({
            type: 'provider_usage',
            usage: {
              id: compaction?.id ?? randomUUID(),
              provider: model.provider,
              category: 'agent',
              operation: 'compaction',
              model: model.id,
              turnId: input.turnId,
              status: event.aborted ? 'cancelled' : event.errorMessage ? 'failed' : 'succeeded',
              durationMs: compaction ? performance.now() - compaction.started : 0,
              ...piUsageMetrics(event.result?.usage),
            },
          });
          compaction = undefined;
        }
        if (
          event.type === 'entry_appended' &&
          event.entry.type === 'usage' &&
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
          input.onEvent({ type: 'message_start' });
        }
        if (event.type === 'turn_start') input.onEvent({ type: 'turn_start' });
        if (event.type === 'message_update') {
          const update = event.assistantMessageEvent;
          if (update.type === 'text_start' || update.type === 'text_delta') {
            if (textBlock !== undefined && textBlock !== update.contentIndex) {
              input.onEvent({ type: 'message_end' });
              input.onEvent({ type: 'message_start' });
            }
            textBlock = update.contentIndex;
          }
          if (update.type === 'text_delta')
            input.onEvent({ type: 'text_delta', text: update.delta });
        }
        if (event.type === 'message_end' && event.message.role === 'assistant') {
          const usage = observeUsage(event.message);
          if (usage) input.onEvent(usage);
          if (event.message.stopReason === 'error')
            input.onEvent({
              type: 'error',
              message: event.message.errorMessage?.trim() || 'The provider gave no reason.',
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
          input.onEvent({ type: 'message_end', ...(status ? { status } : {}) });
        }
      });
      const dispose = async () => {
        unsubscribe();
        session.dispose();
        active.delete(session);
      };
      active.set(session, dispose);
      return {
        resumed,
        readsImages: model.input.includes('image'),
        async prompt(text, images) {
          const owner = input.ownerContext;
          const copy = manager.buildSessionContext().messages.findLast(isOwnerContext);
          if (owner && (copy as { content?: unknown } | undefined)?.content !== owner)
            await session.sendCustomMessage(
              { customType: ownerContextType, content: owner, display: false },
              { deliverAs: 'nextTurn' },
            );
          await session.prompt(text, { images, expandPromptTemplates: false });
        },
        async abort() {
          await session.abort();
        },
        dispose,
      };
    },
    async dispose() {
      disposed = true;
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
