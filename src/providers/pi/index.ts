import { constants, existsSync, statSync } from 'node:fs';
import { mkdir, open, unlink } from 'node:fs/promises';
import { basename, join, posix, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { Type, type TObject } from '@sinclair/typebox';
import { InMemoryCredentialStore } from '@earendil-works/pi-ai';
import {
  createAgentSession,
  createCodemodeExtension,
  DefaultResourceLoader,
  ModelRuntime,
  SessionManager,
  SettingsManager,
  type ResourceLoader,
  type ToolDefinition,
} from '@earendil-works/pi-coding-agent';
import { createPiModelRuntime } from './models.ts';
import type { ModelAccess } from '../../ports/models.ts';
import type { Agent, AgentEvent } from '../../ports/agent.ts';
import type { WorkspaceSession } from '../../ports/computer.ts';
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
import { createSandbox } from './sandbox.ts';

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
  systemContext: string | undefined,
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
    getAppendSystemPrompt: () => (systemContext ? [systemContext] : []),
    getAppendSystemPromptSources: () => [],
    extendResources: () => {},
    reload: async () => {},
  };
}

async function workspaceCodemodeOutput(
  result: Awaited<ReturnType<ToolDefinition['execute']>>,
  workspace: WorkspaceSession,
  writer: ToolDefinition,
  signal?: AbortSignal,
) {
  const details = result.details as { fullOutputPath?: unknown } | undefined;
  if (!details?.fullOutputPath) return result;
  const path = details.fullOutputPath;
  try {
    if (
      typeof path !== 'string' ||
      !/^pi-codemode-[a-f0-9]{16}\.txt$/.test(basename(path)) ||
      path !== join(tmpdir(), basename(path))
    )
      throw new Error();
    const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    let owned = false;
    try {
      const info = await file.stat();
      if (!info.isFile() || info.nlink !== 1 || (process.getuid && info.uid !== process.getuid()))
        throw new Error();
      owned = true;
      if (info.size > 16 * 1024 * 1024) throw new Error();
      const bytes = Buffer.alloc(info.size + 1);
      let length = 0;
      while (length < bytes.length) {
        const { bytesRead } = await file.read(bytes, length, bytes.length - length, length);
        if (!bytesRead) break;
        length += bytesRead;
      }
      if (length !== info.size) throw new Error();
      signal?.throwIfAborted();
      const output = posix.join(workspace.path, '.otto/outputs', `codemode-${randomUUID()}.txt`);
      await writer.execute(
        randomUUID(),
        { path: output, content: bytes.subarray(0, length).toString('utf8') },
        signal,
        undefined,
        undefined as never,
      );
      return {
        ...result,
        details: { ...details, fullOutputPath: output },
        content: result.content.map((item) =>
          item.type === 'text' ? { ...item, text: item.text.replaceAll(path, output) } : item,
        ),
      };
    } finally {
      try {
        await file.close();
      } finally {
        if (owned) await unlink(path);
      }
    }
  } catch {
    throw new Error('The full script output could not be saved in the workspace.');
  }
}

export function createPiAgent(options: {
  provider: string;
  resolve?: () => Promise<ModelAccess>;
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
                ? { ...event, costUsd: null, costSource: 'unavailable' }
                : event.type === 'provider_usage'
                  ? { ...event, usage: { ...event.usage, costUsd: null, pricing: 'unavailable' } }
                  : event,
            ),
        };
      }
      const directory = resolve(options.sessionRoot, threadIdentity(input.threadId));
      await mkdir(directory, { recursive: true, mode: 0o700 });
      const runtime = access
        ? (await createPiModelRuntime(access)).runtime
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
      const selectedModel = runtime.getModel(access?.provider || options.provider, modelId);
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
      const sandboxTools = createSandbox(input.workspace, input.timeZone);
      const tools: ToolDefinition[] = [
        ...sandboxTools.map((definition): ToolDefinition => ({
          ...definition,
          execute: async (id, params, signal, onUpdate, context) => {
            await checkpoint();
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
          parameters: tool.parameters as ToolDefinition['parameters'],
          exposure: 'model-only',
          executionMode: tool.parallel ? 'parallel' : 'sequential',
          execute: async (_id, args) => {
            await checkpoint();
            return { ...(await tool.execute(args as Record<string, unknown>)), details: {} };
          },
        })),
      ];
      const extensionLoader = new DefaultResourceLoader({
        cwd: input.workspace.path,
        agentDir: directory,
        additionalExtensionPaths: [
          fileURLToPath(import.meta.resolve('pi-web-access/dist/index.js')),
        ],
        extensionFactories: [createCodemodeExtension({ mode: 'on', models: false })],
        noExtensions: true,
        noSkills: true,
        noPromptTemplates: true,
        noThemes: true,
        noContextFiles: true,
      });
      await extensionLoader.reload();
      const extensions = extensionLoader.getExtensions();
      if (extensions.errors.length) throw new Error('The Pi extensions could not be loaded.');
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
                const result = await input.runTool(
                  name,
                  args,
                  async () => {
                    const output = await registered.definition.execute(
                      id,
                      args,
                      signal,
                      onUpdate,
                      context,
                    );
                    return name === 'codemode'
                      ? workspaceCodemodeOutput(
                          output,
                          input.workspace,
                          sandboxTools.find((tool) => tool.name === 'write')!,
                          signal,
                        )
                      : output;
                  },
                  { nested: id.includes('/') },
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
        thinkingLevel: access?.effort ?? 'high',
        tools: [
          ...tools.map((tool) => tool.name),
          ...extensions.extensions.flatMap((extension) => [...extension.tools.keys()]),
        ],
        customTools: tools,
        noTools: 'builtin',
        resourceLoader: resources(input.systemPrompt, input.systemContext, extensions),
        sessionManager: manager,
        settingsManager: SettingsManager.inMemory({
          compaction: { enabled: true },
          retry: { enabled: false, maxRetries: 0, provider: { maxRetries: 0 } },
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
        await checkpoint();
        if (input.shouldStop()) return { action: 'end' as const };
        if (
          input.nextMessages &&
          result?.action !== 'end' &&
          ['stop', 'toolUse'].includes(turn.message.stopReason)
        )
          for (const text of await input.nextMessages()) await session.steer(text);
        return result ?? undefined;
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
          if (images.length && !model.input.includes('image'))
            throw new Error(
              'The selected model cannot read images. Choose a model with image support.',
            );
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
