import { randomUUID } from 'node:crypto';
import { mkdir } from 'node:fs/promises';
import { relative, resolve, sep } from 'node:path';
import { Value } from '@sinclair/typebox/value';
import type {
  Agent,
  AgentImage,
  AgentSession,
  AgentTool,
  AgentToolResult,
  PromptSnapshot,
  RuntimeContext,
  RuntimeResult,
  SkillLibrary,
} from '../ports/agent.ts';
import type { Computer, Workspace } from '../ports/computer.ts';
import { BrowserActionError } from '../ports/computer.ts';
import { threadIdentity } from '../ports/thread-identity.ts';
import { browserErrorMessage } from '../shared/browser-errors.ts';
import { actionEffect } from '../shared/action-effect.ts';
import { conversation, createBrowserClaims } from './browser-claims.ts';
import { createBrowserFlows } from './browser-flows.ts';
import { requestsPrivateInput } from './communication.ts';
import { createObservationQueue } from './observations.ts';
import { firstInstruction, steeredInstruction, systemContext, systemPrompt } from './prompt.ts';
import { currentUserTime } from './time-context.ts';
import { inspectToolCatalog, ottoTools } from './tools.ts';
import { privateInputNotice, type Turn } from './turn.ts';
import { delimit, injectionFindings, resultText } from './untrusted.ts';

const holdMs = 30 * 60_000;
const imageBytes = 5 * 1024 * 1024;
const parallelTools = new Set([
  'share_file',
  'create_audio',
  'skills',
  'apps',
  'manage_personal_context',
]);
const mixedTools = new Set(['apps', 'manage_personal_context']);
const browserTools = new Set(['browser', 'browser_flow', 'browser_session', 'get_credential']);
const handsOverBrowser = (name: string, params: unknown) =>
  name === 'ask_user' &&
  /\]\(\/browser\)/.test(String((params as { question?: unknown } | null)?.question));
const trustedResultTools = new Set([
  'skills',
  'send_message',
  'ask_user',
  'react_to_message',
  'manage_apps',
  'share_file',
  'create_audio',
]);
const delimitedTools = new Set([
  'apps',
  'browser',
  'browser_flow',
  'web_search',
  'fetch_content',
  'get_search_content',
  'source_check',
  'codemode',
]);
const readOnlyTools: Record<string, true | string[]> = {
  skills: true,
  read: true,
  find: true,
  ls: true,
  send_message: true,
  apps: true,
  record_activity_check: true,
  web_search: true,
  fetch_content: true,
  source_check: true,
  get_search_content: true,
  browser: ['open', 'snapshot', 'scroll', 'screenshot', 'wait'],
  browser_flow: ['list', 'get'],
  manage_apps: ['list'],
  manage_personal_context: [
    'profile_get',
    'notification_preferences_get',
    'history_search',
    'memory_find',
    'memory_read',
    'schedule_list',
  ],
  task: ['list'],
};
const readOnlyRefusal =
  'This turn can only read. Use app reads, and browser open, snapshot or scroll.';

class ReadOnlyTurnError extends Error {}
class ActivityCheckError extends Error {}

function matchingConnection(value: unknown, connectionId: string): boolean {
  if (!value || typeof value !== 'object') return true;
  return Object.entries(value).every(([key, child]) =>
    key === 'connectionId' ? child === connectionId : matchingConnection(child, connectionId),
  );
}

function inspectedAppResult(value: unknown): boolean {
  const envelopes: unknown[] = [value];
  let inspected = false;
  while (envelopes.length) {
    let envelope = envelopes.pop();
    if (typeof envelope === 'string') {
      const text = envelope;
      try {
        envelope = JSON.parse(text);
      } catch {
        inspected ||= Boolean(text.trim());
        continue;
      }
    }
    if (Array.isArray(envelope)) {
      inspected = true;
      continue;
    }
    if (!envelope || typeof envelope !== 'object') continue;
    const result = envelope as Record<string, unknown>;
    if (
      result.successful === false ||
      result.success === false ||
      result.isError === true ||
      result.resultOmitted === true ||
      Boolean(result.error) ||
      'workspaceFile' in result ||
      ('bytes' in result && 'preview' in result) ||
      ['rejected', 'failed', 'error', 'unavailable', 'pending'].includes(String(result.status)) ||
      (result.truncated === true &&
        !['data', 'content', 'items', 'results', 'messages'].some((key) => key in result))
    )
      return false;
    if ('data' in result) envelopes.push(result.data);
    if ('content' in result)
      envelopes.push(...(Array.isArray(result.content) ? result.content : [result.content]));
    if (result.type === 'text') envelopes.push(result.text);
    if (!('data' in result) && !('content' in result) && result.type !== 'text')
      inspected ||= Object.keys(result).some(
        (key) => !['successful', 'success', 'status', 'isError', 'truncated'].includes(key),
      );
  }
  return inspected;
}

function allowedReadOnly(name: string, params: unknown) {
  const rule = readOnlyTools[name];
  return rule === true || rule?.includes(String((params as { action?: unknown })?.action)) === true;
}

function readCall(name: string, params: unknown) {
  if (name !== 'apps') return allowedReadOnly(name, params);
  const { action, args } = params as { action?: unknown; args?: unknown };
  return (
    typeof action === 'string' &&
    actionEffect(
      action,
      args && typeof args === 'object' ? (args as Record<string, unknown>) : {},
    ) === 'read'
  );
}

function textResult(value: unknown): AgentToolResult {
  return {
    content: [{ type: 'text', text: typeof value === 'string' ? value : JSON.stringify(value) }],
    details: {},
  };
}

function isToolResult(value: unknown): value is AgentToolResult {
  const content = value && typeof value === 'object' && (value as AgentToolResult).content;
  return (
    Array.isArray(content) &&
    content.every((part: unknown) => {
      const item = part as Record<string, unknown> | null;
      return (
        (item?.type === 'text' && typeof item.text === 'string') ||
        (item?.type === 'image' &&
          typeof item.data === 'string' &&
          typeof item.mimeType === 'string')
      );
    })
  );
}

export function createAgentRuntime(dependencies: {
  agent: Agent;
  computer: Computer;
  workspace: Workspace;
  skills?: SkillLibrary;
  observationTimeoutMs?: number;
  withTool?<T>(turnId: string, toolCallId: string, toolName: string, action: () => T): T;
  redactError?(text: string): string;
}) {
  const { agent, computer } = dependencies;
  const activeTurns = new Map<string, { abort(): void; done: Promise<void> }>();
  const claims = createBrowserClaims(holdMs);
  let disposed = false;
  let disposal: Promise<void> | undefined;
  const completedDisposals = new Set<string>();

  async function runTurn(input: RuntimeContext): Promise<RuntimeResult> {
    if (disposed) throw new Error('The runtime has stopped.');
    threadIdentity(input.threadId);
    if (activeTurns.has(input.turnId)) throw new Error('This turn is already active.');
    const limits = input.limits;
    if (
      limits &&
      (!Number.isSafeInteger(limits.maxToolCalls) ||
        limits.maxToolCalls < 1 ||
        !Number.isSafeInteger(limits.timeoutMs) ||
        limits.timeoutMs < 1 ||
        limits.timeoutMs > 2_147_483_647)
    )
      throw new Error('Turn limits must be positive integers within the timer range.');
    const lifecycle = new AbortController();
    const context = { ...input, signal: AbortSignal.any([input.signal, lifecycle.signal]) };
    const { signal, threadId } = context;
    let finished!: () => void;
    const done = new Promise<void>((resolve) => {
      finished = resolve;
    });
    const owner = context.background ? context.turnId : conversation;
    let browserReady: Promise<void> | undefined;
    const takeBrowser = () => (browserReady ??= claims.take(threadId, owner, signal));
    let session: AgentSession | undefined;
    let status: RuntimeResult['status'] = 'succeeded';
    let waitingForUser = false;
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
    let toolCalls = 0;
    let inspectedApp = false;
    let checkRecording = false;
    let checkRecorded = false;
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
    activeTurns.set(context.turnId, { abort, done });
    signal.addEventListener('abort', abort, { once: true });
    const deadline = limits
      ? setTimeout(
          () => lifecycle.abort(new Error('The turn time limit was reached.')),
          limits.timeoutMs,
        )
      : undefined;
    const waitFor = <T>(pending: Promise<T>): Promise<T> => {
      if (!limits) return pending;
      return new Promise<T>((resolve, reject) => {
        const cancel = () => {
          signal.removeEventListener('abort', cancel);
          reject(signal.reason);
        };
        pending.then(
          (value) => {
            signal.removeEventListener('abort', cancel);
            resolve(value);
          },
          (error: unknown) => {
            signal.removeEventListener('abort', cancel);
            reject(error);
          },
        );
        signal.addEventListener('abort', cancel, { once: true });
        if (signal.aborted) cancel();
      });
    };

    const deliverReply = async (text: string, id?: string, replyToMessageId?: string) => {
      signal.throwIfAborted();
      if (context.activityCheck)
        throw new ActivityCheckError('Activity checks cannot send messages.');
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
      if (hold) await computer.hold(threadId, Date.now() + holdMs).catch(() => {});
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
      if (
        bufferedText &&
        !stopped &&
        !context.background &&
        !context.activityCheck &&
        !streamBlocked
      ) {
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
      if (streamId && !context.background && !context.activityCheck) {
        if (persist && !streamSubmitted && !streamBlocked && !stopped && streamedText.trim())
          queueStreamReply(streamedText, streamId);
        if (!streamSubmitted) context.delta('', streamId, true);
      }
      streamId = undefined;
      streamedText = '';
      streamSubmitted = false;
      streamBlocked = false;
    };

    const assertActive = (recording = false) => {
      signal.throwIfAborted();
      if (stopped || status !== 'succeeded' || checkRecorded || (checkRecording && !recording))
        throw new Error('This execution segment has stopped.');
    };
    let untrustedMarked = false;
    const guard = (
      name: string,
      params: unknown,
      execute: () => Promise<unknown>,
      { nested = false } = {},
    ): Promise<AgentToolResult> => {
      const label = name.replaceAll('_', ' ');
      const pending = waitFor(
        (async () => {
          assertActive();
          if (limits && toolCalls >= limits.maxToolCalls) {
            lifecycle.abort(new Error('The turn tool-call limit was reached.'));
            signal.throwIfAborted();
          }
          toolCalls++;
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
                ['fill', 'type', 'accept_dialog'].includes(
                  String((params as { action?: unknown }).action),
                )
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
          let reservedRecord = false;
          try {
            assertActive();
            if (context.activityCheck) {
              const args = params as {
                action?: string;
                args?: Record<string, unknown>;
                status?: string;
              };
              if (name === 'apps') {
                if (
                  !args.args ||
                  !matchingConnection(args.args, context.activityCheck.connectionId) ||
                  (args.action !== 'SEARCH_TOOLS' &&
                    args.args.connectionId !== context.activityCheck.connectionId)
                )
                  throw new ActivityCheckError(
                    'Activity checks can only read the selected account.',
                  );
              } else if (name === 'record_activity_check') {
                if (args.status === 'verified' && !inspectedApp)
                  throw new ActivityCheckError(
                    'A verified activity check needs a successful app read first.',
                  );
                checkRecording = true;
                reservedRecord = true;
              } else
                throw new ActivityCheckError('Activity checks can only read the selected app.');
            }
            if (context.readOnly && !allowedReadOnly(name, params)) throw new ReadOnlyTurnError();
            await waitFor(pendingReplies);
            assertActive(reservedRecord);
            if (untrustedResult && !untrustedMarked) {
              await waitFor(Promise.resolve(context.markUntrustedContext?.()));
              untrustedMarked = true;
            }
            await waitFor(context.emit('tool_start', label));
            const executeCurrent = () => {
              assertActive(reservedRecord);
              return execute();
            };
            const output = await waitFor(
              dependencies.withTool
                ? dependencies.withTool(context.turnId, id, name, executeCurrent)
                : executeCurrent(),
            );
            signal.throwIfAborted();
            if (
              context.activityCheck &&
              name === 'apps' &&
              (params as { action: string }).action !== 'SEARCH_TOOLS' &&
              inspectedAppResult(output)
            )
              inspectedApp = true;
            if (context.activityCheck && name === 'record_activity_check') checkRecorded = true;
            if (!stopped) await waitFor(context.emit('tool_complete', label));
            result = isToolResult(output) ? output : textResult(output);
            if (untrustedResult && !nested && !stopped) {
              const findings = injectionFindings(resultText(result));
              if (findings.length)
                await waitFor(Promise.resolve(context.flagInjection?.(findings)));
              if (delimitedTools.has(name)) result = delimit(name, result, findings);
            }
            await end({
              status: 'succeeded',
              ...(['get_credential', 'browser_flow'].includes(name) || memoryAction
                ? {}
                : { output }),
            });
          } catch (error) {
            if (reservedRecord) checkRecording = false;
            if (!stopped) await waitFor(context.emit('tool_failed', label)).catch(() => {});
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
        })(),
      );
      activeToolCalls.add(pending);
      void pending.finally(() => activeToolCalls.delete(pending)).catch(() => {});
      return pending;
    };
    try {
      signal.throwIfAborted();
      await waitFor(mkdir(context.workspacePath, { recursive: true, mode: 0o700 }));
      const workspace = dependencies.workspace.open(context);
      const browser: Computer = {
        ...computer,
        act: (id, action, actionSignal) =>
          computer.act(
            id,
            { ...action, timeZone: context.timeZone, locale: context.locale },
            actionSignal,
          ),
      };
      const turn: Turn = {
        context,
        computer: browser,
        reply,
        invite: (text) => deliverReply(text),
        pause,
        confirm,
      };
      let exclusive = Promise.resolve();
      const inTurn = (name: string, params: unknown, run: () => Promise<AgentToolResult>) => {
        if (!mixedTools.has(name) || readCall(name, params)) return run();
        const next = exclusive.then(run);
        exclusive = next.then(
          () => {},
          () => {},
        );
        return next;
      };
      const tools = ottoTools(
        turn,
        createBrowserFlows(workspace, browser, threadId, signal),
        dependencies.skills,
      ).map(({ name, description, parameters, execute }): AgentTool => ({
        name,
        description,
        parameters,
        parallel: parallelTools.has(name),
        execute: async (params) => {
          if (browserTools.has(name) || handsOverBrowser(name, params)) await takeBrowser();
          return inTurn(name, params, () =>
            guard(name, params, async () => {
              if (!Value.Check(parameters, params))
                throw new Error('The tool arguments do not match its schema.');
              return execute(params);
            }),
          );
        },
      }));
      const system = systemPrompt(workspace, dependencies.skills);
      const inspectedSystem = `${system}\n\n${systemContext({ ...context, memory: '' })}`;
      const instruct = (
        instruction: string,
        imageCount: number,
        reason: PromptSnapshot['reason'],
        resumed: boolean,
      ) => {
        const currentInstruction = `${currentUserTime(context.timeZone)}\n${instruction}`;
        void Promise.resolve()
          .then(() =>
            context.inspectPrompt?.({
              id: randomUUID(),
              system: inspectedSystem,
              instruction: currentInstruction,
              resumed,
              imageCount,
              reason,
              createdAt: new Date().toISOString(),
            }),
          )
          .catch(() => {});
        return currentInstruction;
      };
      const { takeMessages } = context;
      const opening = agent.open({
        threadId,
        turnId: context.turnId,
        systemPrompt: system,
        systemContext: systemContext(context),
        tools,
        workspace,
        timeZone: context.timeZone,
        background: Boolean(context.background),
        runTool: guard,
        shouldStop: () => stopped || checkRecorded,
        nextMessages:
          takeMessages &&
          (async () =>
            (await takeMessages()).map((message) =>
              instruct(steeredInstruction(message), 0, 'steer', true),
            )),
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
          if (stopped || context.background || context.activityCheck) return;
          if (event.type === 'text_delta') {
            streamId ??= randomUUID();
            bufferedText += event.text;
            if (/[.!?\n]\s*$/.test(bufferedText)) flushText();
          }
          if (event.type === 'final') queueStreamReply(event.text, streamId ?? randomUUID());
        },
      });
      void opening.then(
        (opened) => {
          if (limits && signal.aborted) {
            void Promise.resolve()
              .then(() => opened.abort())
              .catch(() => {});
            void Promise.resolve()
              .then(() => opened.dispose())
              .catch(() => {});
          }
        },
        () => {},
      );
      session = await waitFor(opening);
      signal.throwIfAborted();
      const resumed = session.resumed;
      if (context.attachments.length) {
        await waitFor(Promise.resolve(context.markUntrustedContext?.()));
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
            await waitFor(
              dependencies.workspace.readArtifact(
                threadId,
                relative(root, path),
                imageBytes,
                'attachment',
              ),
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
        const currentInstruction = instruct(
          instruction,
          images.length,
          reason,
          resumed || reason === 'secure_resume',
        );
        await waitFor(session!.prompt(currentInstruction, images));
        await waitFor(pendingReplies);
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
      if (context.activityCheck && !checkRecorded)
        throw new Error('The activity check did not record a result.');
      waitingForUser = status !== 'succeeded';
      return { status, ...(waitingFor ? { waitingFor } : {}), ...(question ? { question } : {}) };
    } finally {
      stopped = true;
      completeStream();
      signal.removeEventListener('abort', abort);
      try {
        await waitFor(Promise.resolve().then(() => session?.dispose())).catch((error: unknown) => {
          if (!signal.aborted) throw error;
        });
      } finally {
        clearTimeout(deadline);
        await Promise.allSettled([...activeToolCalls]);
        await observations.flush();
        activeTurns.delete(context.turnId);
        claims.release(threadId, owner, waitingForUser);
        finished();
      }
    }
  }

  return {
    runTurn,
    holdBrowserForUser: (threadId: string) => claims.holdForUser(threadId),
    inspectTools: () => [
      ...(agent.nativeTools ?? []).map((tool) => structuredClone(tool)),
      ...inspectToolCatalog(),
    ],
    status: () => ({
      browser: computer.status(),
      workspace: dependencies.workspace.status(),
      activeTurns: activeTurns.size,
    }),
    dispose: () => {
      disposed = true;
      disposal ??= (async () => {
        const pending = [...activeTurns.values()];
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
