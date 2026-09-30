import { randomUUID } from 'node:crypto';
import { mkdir } from 'node:fs/promises';
import { relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Value } from '@sinclair/typebox/value';
import type {
  Agent,
  AgentImage,
  AgentSession,
  AgentTool,
  AgentToolResult,
  RuntimeContext,
  RuntimeResult,
} from '../ports/agent.ts';
import type { Computer, Workspace } from '../ports/computer.ts';
import { BrowserActionError } from '../ports/computer.ts';
import { threadIdentity } from '../ports/thread-identity.ts';
import { browserErrorMessage } from '../shared/browser-errors.ts';
import { createBrowserFlows } from './browser-flows.ts';
import { requestsPrivateInput } from './communication.ts';
import { createObservationQueue } from './observations.ts';
import { firstInstruction, systemPrompt } from './prompt.ts';
import { currentUserTime } from './time-context.ts';
import { inspectToolCatalog, ottoTools } from './tools.ts';
import { privateInputNotice, type Turn } from './turn.ts';

const skillsDir = fileURLToPath(new URL('./skills', import.meta.url));
const holdMs = 30 * 60_000;
const imageBytes = 5 * 1024 * 1024;
const parallelTools = new Set(['share_file', 'create_audio']);
// Tools whose results never carry web, file, app or credential content. Any other tool marks the thread before it runs.
const trustedResultTools = new Set([
  'send_message',
  'ask_user',
  'react_to_message',
  'manage_apps',
  'share_file',
  'create_audio',
]);
const readOnlyTools: Record<string, true | string[]> = {
  read: true,
  find: true,
  ls: true,
  send_message: true,
  apps: true,
  web_search: true,
  fetch_content: true,
  source_check: true,
  get_search_content: true,
  browser: ['open', 'snapshot', 'scroll', 'screenshot'],
  browser_flow: ['list', 'get'],
  manage_apps: ['list'],
  manage_personal_context: [
    'profile_get',
    'notification_preferences_get',
    'history_search',
    'memory_list',
    'schedule_list',
    'goal_list',
  ],
};
const readOnlyRefusal =
  'This turn can only read. Use app reads, and browser open, snapshot or scroll.';

class ReadOnlyTurnError extends Error {}

function allowedReadOnly(name: string, params: unknown) {
  const rule = readOnlyTools[name];
  return rule === true || rule?.includes(String((params as { action?: unknown })?.action)) === true;
}

function textResult(value: unknown): AgentToolResult {
  return {
    content: [{ type: 'text', text: typeof value === 'string' ? value : JSON.stringify(value) }],
    details: {},
  };
}

function isToolResult(value: unknown): value is AgentToolResult {
  return Boolean(
    value && typeof value === 'object' && Array.isArray((value as AgentToolResult).content),
  );
}

export function createAgentRuntime(dependencies: {
  agent: Agent;
  computer: Computer;
  workspace: Workspace;
  observationTimeoutMs?: number;
  withTool?<T>(turnId: string, toolCallId: string, toolName: string, action: () => T): T;
  redactError?(text: string): string;
}) {
  const { agent, computer } = dependencies;
  const activeThreads = new Map<string, { abort(): void; done: Promise<void> }>();
  let disposed = false;
  let disposal: Promise<void> | undefined;
  const completedDisposals = new Set<string>();

  async function runTurn(input: RuntimeContext): Promise<RuntimeResult> {
    if (disposed) throw new Error('The runtime has stopped.');
    threadIdentity(input.threadId);
    if (activeThreads.has(input.threadId))
      throw new Error('This thread already has an active turn.');
    const lifecycle = new AbortController();
    const context = { ...input, signal: AbortSignal.any([input.signal, lifecycle.signal]) };
    const { signal, threadId } = context;
    let finished!: () => void;
    const done = new Promise<void>((resolve) => {
      finished = resolve;
    });
    let session: AgentSession | undefined;
    let status: RuntimeResult['status'] = 'succeeded';
    let waitingFor: RuntimeResult['waitingFor'];
    let question: string | undefined;
    let stopped = false;
    let modelFailed = false;
    let modelIncomplete = false;
    let secureContinuation: string | undefined;
    let lastReply = '';
    let pendingReplies = Promise.resolve();
    const persistedStreams = new Set<string>();
    let streamId: string | undefined;
    let bufferedText = '';
    let streamedText = '';
    let streamSubmitted = false;
    let streamBlocked = false;
    const activeToolCalls = new Set<Promise<unknown>>();
    const observations = createObservationQueue({
      observe: context.observe,
      signal,
      timeoutMs: dependencies.observationTimeoutMs,
    });
    const observe = observations.record;
    const abortSession = () => {
      void Promise.resolve()
        .then(() => session?.abort())
        .catch(() => {});
    };
    const abort = () => {
      stopped = true;
      lifecycle.abort();
      abortSession();
    };
    activeThreads.set(threadId, { abort, done });
    signal.addEventListener('abort', abort, { once: true });

    const deliverReply = async (text: string, id?: string, replyToMessageId?: string) => {
      const trimmed = text.trim();
      if (!trimmed || trimmed === lastReply) return;
      await context.reply(trimmed, id, replyToMessageId);
      if (id) persistedStreams.add(id);
      lastReply = trimmed;
    };
    const reply = async (text: string, id?: string, replyToMessageId?: string) => {
      if (requestsPrivateInput(text)) {
        if (id) secureContinuation = privateInputNotice;
        return { status: 'withheld', message: privateInputNotice };
      }
      await deliverReply(text, id, replyToMessageId);
    };
    const pause = async (
      reason: 'question' | 'approval' | 'credentials',
      text?: string,
      { hold = false, post = true } = {},
    ) => {
      status = reason === 'credentials' ? 'waiting_credentials' : 'waiting_user';
      waitingFor = reason;
      if (text && reason !== 'credentials') question = text;
      if (hold) await computer.hold(threadId, Date.now() + holdMs);
      stopped = true;
      if (post && text) {
        if (context.waitForUser) await context.waitForUser(text);
        else await deliverReply(text);
      }
      abortSession();
    };
    const confirm = async (result: unknown) => {
      if (!(result && typeof result === 'object' && 'requiresConfirmation' in result))
        return result;
      if (!result.requiresConfirmation) return result;
      const text =
        'question' in result && typeof result.question === 'string' ? result.question : undefined;
      await pause('approval', text, { hold: true, post: false });
      return 'The confirmation question is in chat. Wait for the reply.';
    };

    const flushText = () => {
      if (bufferedText && requestsPrivateInput(streamedText + bufferedText)) streamBlocked = true;
      if (bufferedText && !stopped && !context.background && !streamBlocked) {
        context.delta(bufferedText, (streamId ??= randomUUID()));
        streamedText += bufferedText;
      }
      bufferedText = '';
    };
    const queueStreamReply = (text: string, id: string) => {
      streamSubmitted = true;
      pendingReplies = pendingReplies
        .then(async () => {
          await reply(text, id);
        })
        .finally(() => {
          if (!persistedStreams.delete(id)) context.delta('', id, true);
        });
      void pendingReplies.catch(() => {});
    };
    const completeStream = (persist = false) => {
      flushText();
      if (streamId && !context.background) {
        if (persist && !streamSubmitted && !streamBlocked && !stopped && streamedText.trim())
          queueStreamReply(streamedText, streamId);
        if (!streamSubmitted) context.delta('', streamId, true);
      }
      streamId = undefined;
      streamedText = '';
      streamSubmitted = false;
      streamBlocked = false;
    };

    let untrustedMarked = false;
    const guard = (
      name: string,
      params: unknown,
      execute: () => Promise<unknown>,
    ): Promise<AgentToolResult> => {
      const label = name.replaceAll('_', ' ');
      const pending = (async () => {
        signal.throwIfAborted();
        if (stopped || status !== 'succeeded')
          throw new Error('This execution segment has stopped.');
        const id = randomUUID();
        const started = performance.now();
        const end = (fields: {
          status: 'succeeded' | 'failed' | 'cancelled';
          output?: unknown;
          error?: string;
        }) =>
          observe({
            type: 'tool_end',
            id,
            name,
            ...fields,
            finishedAt: new Date().toISOString(),
            durationMs: performance.now() - started,
          });
        const personalAction = String((params as { action?: unknown })?.action);
        const memoryAction =
          name === 'manage_personal_context' && personalAction.startsWith('memory_');
        const untrustedResult =
          !trustedResultTools.has(name) &&
          !(name === 'manage_personal_context' && personalAction !== 'history_search');
        const observedInput = memoryAction
          ? { action: (params as { action?: unknown }).action, args: '[private memory omitted]' }
          : name === 'browser' &&
              params &&
              typeof params === 'object' &&
              (params as { action?: unknown }).action === 'fill'
            ? { ...params, text: '[redacted]' }
            : name === 'browser_flow' && params && typeof params === 'object'
              ? (params as { action?: unknown }).action === 'save'
                ? { action: 'save', flow: '[redacted]' }
                : { ...params, query: '[redacted]', inputs: '[redacted]' }
              : params;
        await observe({
          type: 'tool_start',
          id,
          name,
          input: observedInput,
          startedAt: new Date().toISOString(),
        });
        let result: AgentToolResult;
        try {
          signal.throwIfAborted();
          if (context.readOnly && !allowedReadOnly(name, params)) throw new ReadOnlyTurnError();
          await pendingReplies;
          signal.throwIfAborted();
          if (stopped || status !== 'succeeded')
            throw new Error('This execution segment has stopped.');
          if (untrustedResult && !untrustedMarked) {
            await context.markUntrustedContext?.();
            untrustedMarked = true;
          }
          await context.emit('tool_start', label);
          const output = await (dependencies.withTool
            ? dependencies.withTool(context.turnId, id, name, execute)
            : execute());
          signal.throwIfAborted();
          if (!stopped) await context.emit('tool_complete', label);
          result = isToolResult(output) ? output : textResult(output);
          await end({
            status: 'succeeded',
            ...(['get_credential', 'browser_flow'].includes(name) || memoryAction
              ? {}
              : { output }),
          });
        } catch (error) {
          if (!stopped) await context.emit('tool_failed', label).catch(() => {});
          const browserFailure =
            error instanceof BrowserActionError ? browserErrorMessage(error.code) : undefined;
          const failure = signal.aborted
            ? 'The action was cancelled.'
            : error instanceof ReadOnlyTurnError
              ? readOnlyRefusal
              : (dependencies.redactError ?? String)(
                  browserFailure ?? (error instanceof Error ? error.message : String(error)),
                );
          await end({ status: signal.aborted ? 'cancelled' : 'failed', error: failure });
          if (
            !signal.aborted &&
            !stopped &&
            status === 'succeeded' &&
            name === 'browser' &&
            (params as { action?: unknown }).action === 'click' &&
            error instanceof BrowserActionError &&
            error.code === 'browser_click_intercepted'
          )
            return textResult({ status: 'blocked', code: error.code, message: browserFailure });
          throw new Error(failure);
        }
        signal.throwIfAborted();
        return result;
      })();
      activeToolCalls.add(pending);
      void pending.finally(() => activeToolCalls.delete(pending)).catch(() => {});
      return pending;
    };
    try {
      signal.throwIfAborted();
      await mkdir(context.workspacePath, { recursive: true, mode: 0o700 });
      const workspace = dependencies.workspace.open(context);
      const turn: Turn = {
        context,
        computer,
        reply,
        pause,
        confirm,
      };
      const tools = ottoTools(turn, createBrowserFlows(workspace, computer, threadId, signal)).map(
        ({ name, description, parameters, execute }): AgentTool => ({
          name,
          description,
          parameters,
          parallel: parallelTools.has(name),
          execute: async (params) => {
            signal.throwIfAborted();
            if (stopped || status !== 'succeeded')
              throw new Error('This execution segment has stopped.');
            if (!Value.Check(parameters, params))
              throw new Error('The tool arguments do not match its schema.');
            return guard(name, params, () => execute(params));
          },
        }),
      );
      const system = systemPrompt(context, workspace);
      const inspectedSystem = systemPrompt({ ...context, memory: [] }, workspace);
      session = await agent.open({
        threadId,
        turnId: context.turnId,
        systemPrompt: system,
        tools,
        workspace,
        skillsDir,
        runTool: (name, params, run) => guard(name, params, run),
        shouldStop: () => stopped,
        onEvent: (event) => {
          if (event.type === 'model_usage') void observe(event);
          if (event.type === 'message_start') {
            completeStream();
            streamId = randomUUID();
          }
          if (event.type === 'message_end') {
            if (event.status === 'succeeded') modelFailed = modelIncomplete = false;
            if (event.status === 'incomplete') modelIncomplete = true;
            completeStream(
              !modelFailed && (event.status === undefined || event.status === 'succeeded'),
            );
          }
          if (event.type === 'error') modelFailed = true;
          if (event.type === 'final') modelFailed = modelIncomplete = false;
          if (stopped || context.background) return;
          if (event.type === 'text_delta') {
            streamId ??= randomUUID();
            bufferedText += event.text;
            if (/[.!?\n]\s*$/.test(bufferedText)) flushText();
          }
          if (event.type === 'final') queueStreamReply(event.text, streamId ?? randomUUID());
        },
      });
      signal.throwIfAborted();
      const resumed = session.resumed;
      if (context.attachments.length) {
        await context.markUntrustedContext?.();
        untrustedMarked = true;
      }
      const images: AgentImage[] = [];
      const omittedImages = new Set<string>();
      const root = resolve(context.workspacePath);
      for (const attachment of context.attachments) {
        if (!['image/png', 'image/jpeg', 'image/webp'].includes(attachment.mimeType)) continue;
        const path = resolve(attachment.path);
        if (!path.startsWith(root + sep) || !dependencies.workspace.readArtifact) continue;
        try {
          const bytes = Buffer.from(
            await dependencies.workspace.readArtifact(
              threadId,
              relative(root, path),
              imageBytes,
              'attachment',
            ),
          );
          signal.throwIfAborted();
          if (bytes.length > imageBytes) omittedImages.add(attachment.path);
          else
            images.push({
              type: 'image',
              data: bytes.toString('base64'),
              mimeType: attachment.mimeType,
            });
        } catch {
          signal.throwIfAborted();
          omittedImages.add(attachment.path);
        }
      }
      const sendPrompt = async (
        instruction: string,
        images: AgentImage[],
        reason: 'user' | 'secure_resume',
      ) => {
        const currentInstruction = `${currentUserTime(context.timeZone || 'Europe/Lisbon')}\n${instruction}`;
        void Promise.resolve()
          .then(() =>
            context.inspectPrompt?.({
              id: randomUUID(),
              system: inspectedSystem,
              instruction: currentInstruction,
              resumed: resumed || reason === 'secure_resume',
              imageCount: images.length,
              reason,
              createdAt: new Date().toISOString(),
            }),
          )
          .catch(() => {});
        await session!.prompt(currentInstruction, images);
        await pendingReplies;
      };
      await sendPrompt(firstInstruction(context, resumed, omittedImages), images, 'user');
      if (secureContinuation && !stopped) {
        const instruction = secureContinuation;
        secureContinuation = undefined;
        await sendPrompt(instruction, [], 'secure_resume');
        if (secureContinuation)
          throw new Error('The reply kept asking for private sign-in details.');
      }
      signal.throwIfAborted();
      if (modelFailed)
        throw new Error('The model request failed. Check the configured provider and model.');
      if (modelIncomplete && status === 'succeeded')
        throw new Error('The model response was incomplete. Say continue to try again.');
      if (stopped && status === 'succeeded') throw new Error('The turn was stopped.');
      return { status, ...(waitingFor ? { waitingFor } : {}), ...(question ? { question } : {}) };
    } finally {
      stopped = true;
      completeStream();
      signal.removeEventListener('abort', abort);
      try {
        await session?.dispose();
      } finally {
        await Promise.allSettled([...activeToolCalls]);
        await observations.flush();
        activeThreads.delete(threadId);
        finished();
      }
    }
  }

  return {
    runTurn,
    waitForThread: (threadId: string) => activeThreads.get(threadId)?.done ?? Promise.resolve(),
    inspectTools: () => [
      ...(agent.nativeTools ?? []).map((tool) => structuredClone(tool)),
      ...inspectToolCatalog(),
    ],
    status: () => ({
      browser: computer.status(),
      workspace: dependencies.workspace.status(),
      activeThreads: activeThreads.size,
    }),
    dispose: () => {
      disposed = true;
      disposal ??= (async () => {
        const pending = [...activeThreads.values()];
        for (const task of pending) task.abort();
        let failed = false;
        for (const [name, close] of [
          ['agent', () => agent.dispose()],
          ['turns', () => Promise.all(pending.map((task) => task.done))],
          ['computer', () => computer.dispose()],
          ['workspace', () => dependencies.workspace.dispose()],
        ] as const) {
          if (completedDisposals.has(name)) continue;
          try {
            await close();
            completedDisposals.add(name);
          } catch {
            failed = true;
          }
        }
        if (failed) throw new Error('Some runtime resources could not close.');
      })().catch((error) => {
        disposal = undefined;
        throw error;
      });
      return disposal;
    },
  };
}
