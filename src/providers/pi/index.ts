import { existsSync, statSync } from 'node:fs';
import { mkdir } from 'node:fs/promises';
import { resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { Type, type TObject } from '@sinclair/typebox';
import { InMemoryCredentialStore } from '@earendil-works/pi-ai';
import {
  createAgentSession,
  DefaultResourceLoader,
  ModelRuntime,
  SessionManager,
  SettingsManager,
  type ResourceLoader,
  type Skill,
  type ToolDefinition,
} from '@earendil-works/pi-coding-agent';
import type { Agent, AgentEvent } from '../../ports/agent.ts';
import type { PrivateObjectStore } from '../../ports/object-storage.ts';
import {
  closeInterruptedCalls,
  createPiCheckpoint,
  rebaseAt,
  rebaseSession,
} from './checkpoint.ts';
import { threadIdentity } from '../../ports/thread-identity.ts';
import { createPiUsageTracker, piUsageMetrics, usageId } from './usage.ts';
import { agentModels } from '../../shared/model-defaults.ts';
import { createSandbox, stageResources } from './sandbox.ts';

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
  skills: Skill[],
  extensions: ReturnType<ResourceLoader['getExtensions']>,
): ResourceLoader {
  return {
    getExtensions: () => extensions,
    getSkills: () => ({ skills, diagnostics: [] }),
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

export function createPiAgent(options: {
  provider: string;
  model?: string;
  apiKey?: string;
  sessionRoot: string;
  objectStore?: PrivateObjectStore;
  createSession?: typeof createAgentSession;
}): Agent {
  const active = new Map<
    Awaited<ReturnType<typeof createAgentSession>>['session'],
    () => Promise<void>
  >();
  let disposed = false;
  return {
    nativeTools: createSandbox({
      path: '/workspace',
      instructions: '',
      exec: async () => ({ exitCode: 1 }),
    }).map(({ name, description, parameters }) => ({
      name,
      description,
      parameters: structuredClone(parameters) as Record<string, unknown>,
    })),
    async open(input) {
      if (disposed) throw new Error('The agent service has stopped.');
      if (!options.apiKey)
        throw new Error('Configure the selected model provider to enable the assistant.');
      const directory = resolve(options.sessionRoot, threadIdentity(input.threadId));
      await mkdir(directory, { recursive: true, mode: 0o700 });
      const runtime = await ModelRuntime.create({
        credentials: new InMemoryCredentialStore(),
        modelsPath: null,
        refreshOnCreate: false,
        allowModelNetwork: false,
      });
      await runtime.setRuntimeApiKey(options.provider, options.apiKey);
      const modelId = options.model || agentModels[options.provider as keyof typeof agentModels];
      const model = runtime.getModel(options.provider, modelId);
      if (!model)
        throw new Error('The configured model is not present in the installed Pi catalog.');
      const durable = options.objectStore
        ? await createPiCheckpoint({
            store: options.objectStore,
            threadId: input.threadId,
            directory,
          })
        : undefined;
      let manager = durable?.manager ?? SessionManager.continueRecent(directory, directory);
      const file = durable ? undefined : manager.getSessionFile();
      if (file && existsSync(file) && statSync(file).size > rebaseAt)
        manager = rebaseSession(manager, SessionManager.create(directory, directory));
      closeInterruptedCalls(manager);
      const completedEvents: AgentEvent[] = [];
      const checkpoint = async () => {
        await durable?.checkpoint();
        for (const event of completedEvents.splice(0)) input.onEvent(event);
      };
      const completed = (event: AgentEvent) => {
        if (durable) completedEvents.push(event);
        else input.onEvent(event);
      };
      const tools: ToolDefinition[] = [
        ...createSandbox(input.workspace).map((definition): ToolDefinition => ({
          ...definition,
          execute: async (id, params, signal, onUpdate, context) => {
            await checkpoint();
            const result = await input.runTool(definition.name, params, () =>
              definition.execute(id, params, signal, onUpdate, context),
            );
            return { ...result, details: result.details ?? {} };
          },
        })),
        ...input.tools.map((tool): ToolDefinition => ({
          name: tool.name,
          label: tool.name.replaceAll('_', ' '),
          description: tool.description,
          parameters: tool.parameters as ToolDefinition['parameters'],
          executionMode: tool.parallel ? 'parallel' : 'sequential',
          execute: async (_id, args) => {
            await checkpoint();
            return { ...(await tool.execute(args as Record<string, unknown>)), details: {} };
          },
        })),
      ];
      const skills = await stageResources(input.workspace, input.skillsDir);
      const extensionLoader = new DefaultResourceLoader({
        cwd: input.workspace.path,
        agentDir: directory,
        additionalExtensionPaths: [
          fileURLToPath(import.meta.resolve('pi-web-access/dist/index.js')),
        ],
        noExtensions: true,
        noSkills: true,
        noPromptTemplates: true,
        noThemes: true,
        noContextFiles: true,
      });
      await extensionLoader.reload();
      const extensions = extensionLoader.getExtensions();
      if (extensions.errors.length) throw new Error('The Pi web extension could not be loaded.');
      for (const extension of extensions.extensions)
        for (const [name, registered] of extension.tools) {
          const search = name === 'web_search';
          extension.tools.set(name, {
            ...registered,
            definition: {
              ...registered.definition,
              ...(search
                ? {
                    description:
                      'Search the public web through the configured Pi provider. Use queries with 2-4 varied angles for broad research. Return source-linked results without a curator or a separate summary. Use includeContent only when full source text is needed.',
                    parameters: Type.Omit(registered.definition.parameters as TObject, [
                      'workflow',
                    ]),
                  }
                : {}),
              execute: async (id, params, signal, onUpdate, context) => {
                await checkpoint();
                const args = search
                  ? { ...(params as Record<string, unknown>), workflow: 'none' }
                  : params;
                const result = await input.runTool(name, args, () =>
                  registered.definition.execute(id, args, signal, onUpdate, context),
                );
                return { ...result, details: result.details ?? {} };
              },
            },
          });
        }
      const resumed = manager.buildSessionContext().messages.length > 0;
      const { session } = await (options.createSession ?? createAgentSession)({
        cwd: input.workspace.path,
        agentDir: directory,
        modelRuntime: runtime,
        model,
        thinkingLevel: 'high',
        tools: [
          ...tools.map((tool) => tool.name),
          ...extensions.extensions.flatMap((extension) => [...extension.tools.keys()]),
        ],
        customTools: tools,
        noTools: 'builtin',
        resourceLoader: resources(input.systemPrompt, skills, extensions),
        sessionManager: manager,
        settingsManager: SettingsManager.inMemory({
          compaction: { enabled: true },
          retry: { enabled: true, maxRetries: 5 },
          transport: 'sse',
        }),
      });
      if (disposed) {
        session.dispose();
        throw new Error('The agent service has stopped.');
      }

      const finishTurn = session.agent.finishTurn;
      session.agent.finishTurn = async (...args) => {
        const result = await finishTurn?.(...args);
        await checkpoint();
        return input.shouldStop() ? { action: 'end' as const } : (result ?? undefined);
      };
      if (durable) {
        const prepareNextTurn = session.agent.prepareNextTurnWithContext;
        session.agent.prepareNextTurnWithContext = async (...args) => {
          const result = await prepareNextTurn?.(...args);
          await checkpoint();
          return result;
        };
      }
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
          if (event.message.stopReason === 'error') input.onEvent({ type: 'error' });
          if (event.message.stopReason === 'stop') {
            const blocks = event.message.content.filter((item) => item.type === 'text');
            const finalBlocks = blocks.filter((item) => isFinalAnswer(item.textSignature));
            completed({
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
          completed({ type: 'message_end', ...(status ? { status } : {}) });
        }
      });
      const dispose = async () => {
        try {
          if (durable) await checkpoint();
        } finally {
          unsubscribe();
          session.dispose();
          active.delete(session);
        }
      };
      active.set(session, dispose);
      return {
        resumed,
        async prompt(text, images) {
          try {
            await session.prompt(text, { images, expandPromptTemplates: false });
          } finally {
            await checkpoint();
          }
        },
        async abort() {
          try {
            await session.abort();
          } finally {
            await checkpoint();
          }
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
