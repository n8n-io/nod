import { mkdir } from 'node:fs/promises';
import { resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import { InMemoryCredentialStore } from '@earendil-works/pi-ai';
import {
  createAgentSession,
  createExtensionRuntime,
  ModelRuntime,
  SessionManager,
  SettingsManager,
  type ResourceLoader,
  type ToolDefinition,
} from '@earendil-works/pi-coding-agent';
import type { Agent, AgentEvent } from '../../ports/agent.ts';
import type { PrivateObjectStore } from '../../ports/object-storage.ts';
import { createPiCheckpoint } from './checkpoint.ts';
import { taskId } from '../../ports/task-identity.ts';
import { createPiUsageTracker, piUsageMetrics, usageId } from './usage.ts';
import { agentModels } from '../../shared/model-defaults.ts';

function isFinalAnswer(signature: string | undefined) {
  if (!signature?.startsWith('{')) return false;
  try {
    const value = JSON.parse(signature);
    return value?.v === 1 && value.phase === 'final_answer';
  } catch {
    return false;
  }
}

function resources(systemPrompt: string): ResourceLoader {
  return {
    getExtensions: () => ({ extensions: [], errors: [], runtime: createExtensionRuntime() }),
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
    async open(input) {
      if (disposed) throw new Error('The agent service has stopped.');
      if (!options.apiKey)
        throw new Error('Configure the selected model provider to enable the assistant.');
      const directory = resolve(options.sessionRoot, taskId(input.taskId));
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
            taskId: input.taskId,
            directory,
            fresh: input.fresh,
          })
        : undefined;
      const manager =
        durable?.manager ??
        (input.fresh
          ? SessionManager.create(directory, directory)
          : SessionManager.continueRecent(directory, directory));
      const completedEvents: AgentEvent[] = [];
      const checkpoint = async () => {
        await durable?.checkpoint();
        for (const event of completedEvents.splice(0)) input.onEvent(event);
      };
      const completed = (event: AgentEvent) => {
        if (durable) completedEvents.push(event);
        else input.onEvent(event);
      };
      const tools: ToolDefinition[] = input.tools.map((tool) => ({
        name: tool.name,
        label: tool.name.replaceAll('_', ' '),
        description: tool.description,
        parameters: tool.parameters as ToolDefinition['parameters'],
        executionMode: 'sequential',
        execute: async (id, args) => {
          const execute = async () => {
            await checkpoint();
            return { ...(await tool.execute(args as Record<string, unknown>)), details: {} };
          };
          const result = durable ? await durable.execute(id, tool.name, execute) : await execute();
          return { ...result, details: {} };
        },
      }));
      const resumed = manager.buildSessionContext().messages.length > 0;
      const { session } = await (options.createSession ?? createAgentSession)({
        cwd: directory,
        agentDir: directory,
        modelRuntime: runtime,
        model,
        thinkingLevel: 'low',
        tools: tools.map((tool) => tool.name),
        customTools: tools,
        noTools: 'builtin',
        resourceLoader: resources(input.systemPrompt),
        sessionManager: manager,
        settingsManager: SettingsManager.inMemory({
          compaction: { enabled: true },
          retry: { enabled: true, maxRetries: 2 },
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
              taskId: input.taskId,
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
              taskId: input.taskId,
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
            await session.prompt(text, { images });
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
