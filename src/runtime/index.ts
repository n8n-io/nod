import { AsyncLocalStorage } from 'node:async_hooks';
import { randomUUID } from 'node:crypto';
import { mkdir } from 'node:fs/promises';
import { setTimeout as wait } from 'node:timers/promises';
import { relative, resolve, sep } from 'node:path';
import { Value } from '@sinclair/typebox/value';
import type {
  Agent,
  AgentImage,
  AgentSession,
  AgentTool,
  AgentToolResult,
  RuntimeContext,
  RuntimeObservation,
  RuntimeResult,
  SkillLibrary,
} from '../ports/agent.ts';
import type { Computer, Workspace } from '../ports/computer.ts';
import { BrowserActionError } from '../ports/computer.ts';
import { threadIdentity } from '../ports/thread-identity.ts';
import { firstInstruction, steeredInstruction, systemContext, systemPrompt } from './prompt.ts';
import { currentUserTime } from './time-context.ts';
import { ottoTools } from './tools.ts';
import type { Turn } from './turn.ts';
import type { ExecutionScope } from '../shared/execution.ts';
import { delimit } from './untrusted.ts';
import type { Task } from '../shared/contracts.ts';
import { taskSummary } from '../shared/task-status.ts';

const imageBytes = (5 * 1024 * 1024 * 3) / 4;
const inlineChars = 40_000;
const imageBudget = 16 * 1024 * 1024;
const imageTypes = new Set(['image/png', 'image/jpeg', 'image/webp']);
const parentTools = new Set([
  'sign_in',
  'pay',
  'browser_session',
  'ask_user',
  'send_message',
  'manage_apps',
  'task',
]);
const parallelTools = new Set([
  'delegate',
  'share_file',
  'create_audio',
  'skills',
  'apps',
  'manage_personal_context',
  'task',
  'react_to_message',
]);
const orderedTools = new Set(['apps', 'manage_personal_context']);
const admissions = new AsyncLocalStorage<{
  asked: boolean;
  admit(asks: boolean): Promise<void>;
}>();
const browserTools = new Set(['browser', 'browser_session', 'sign_in', 'pay']);
const handsOverBrowser = (name: string, params: unknown) =>
  name === 'ask_user' &&
  /\]\(\/browser\)/.test(String((params as { question?: unknown } | null)?.question));
const confirmationNotice = 'The confirmation question is in chat. Wait for the reply.';
const delimitedTools = new Set([
  'apps',
  'delegate',
  'browser',
  'web_search',
  'fetch_content',
  'get_search_content',
  'source_check',
  'codemode',
]);
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
  redactError?(text: string): string;
  observe?(turnId: string, event: RuntimeObservation): void;
}) {
  const { agent, computer, skills } = dependencies;
  const activeTurns = new Map<string, { abort(): void; done: Promise<void> }>();
  let disposed = false;
  let disposal: Promise<void> | undefined;
  const completedDisposals = new Set<string>();

  async function runTurn(input: RuntimeContext): Promise<RuntimeResult> {
    if (disposed) throw new Error('The runtime has stopped.');
    threadIdentity(input.threadId);
    if (activeTurns.has(input.turnId)) throw new Error('This turn is already active.');
    const lifecycle = new AbortController();
    const context = { ...input, signal: AbortSignal.any([input.signal, lifecycle.signal]) };
    const { signal, threadId } = context;
    const sessionId = threadIdentity(context.sessionId);
    const browserId = sessionId;
    const execution: ExecutionScope = {
      threadId,
      sessionId,
      turnId: context.turnId,
      runId: context.turnId,
      browserId,
    };
    let finished!: () => void;
    const done = new Promise<void>((resolve) => {
      finished = resolve;
    });
    let browsed = false;
    let session: AgentSession | undefined;
    let status: RuntimeResult['status'] = 'succeeded';
    let waitingForUser = false;
    let waitingFor: RuntimeResult['waitingFor'];
    let question: string | undefined;
    let stopped = false;
    let modelFailed = false;
    let modelIncomplete = false;
    let completed = false;
    let lastReply = '';
    let pendingReplies = Promise.resolve();
    const persistedStreams = new Set<string>();
    let streamId: string | undefined;
    let bufferedText = '';
    let streamedText = '';
    let streamSubmitted = false;
    const activeToolCalls = new Set<Promise<unknown>>();
    const observe = (event: RuntimeObservation) => {
      if (signal.aborted && !(event.type === 'tool_end' && event.status === 'cancelled')) return;
      try {
        dependencies.observe?.(context.turnId, event);
      } catch {}
    };
    const children = new Set<AgentSession>();
    const abortSession = () => {
      for (const child of [session, ...children])
        void Promise.resolve()
          .then(() => child?.abort())
          .catch(() => {});
    };
    const abort = () => {
      stopped = true;
      lifecycle.abort();
      abortSession();
    };
    activeTurns.set(context.turnId, { abort, done });
    signal.addEventListener('abort', abort, { once: true });

    let taskResult = '';
    let reportedTaskResult = '';
    const deliverReply = async (text: string, id?: string, replyToMessageId?: string) => {
      signal.throwIfAborted();
      const trimmed = text.trim();
      if (!trimmed || trimmed === lastReply) return;
      await context.reply(trimmed, id, replyToMessageId);
      if (id) persistedStreams.add(id);
      lastReply = trimmed;
    };
    const reply = deliverReply;
    const pause = async (
      reason: 'question' | 'approval' | 'credentials',
      text?: string,
      { post = true } = {},
    ) => {
      status = reason === 'credentials' ? 'waiting_credentials' : 'waiting_user';
      waitingFor = reason;
      if (text && reason !== 'credentials') question = text;
      if (browsed) await computer.hold(browserId, true).catch(() => {});
      stopped = true;
      if (post && text) {
        if (context.waitForUser)
          await context.waitForUser(text, /\]\(\/browser\)/.test(text) ? browserId : undefined);
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
      const gate = admissions.getStore();
      if (gate) gate.asked = true;
      await pause('approval', text, { post: false });
      return confirmationNotice;
    };

    const flushText = () => {
      if (bufferedText && !stopped && !context.background) {
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
        if (persist && !streamSubmitted && !stopped && streamedText.trim())
          queueStreamReply(streamedText, streamId);
        if (!streamSubmitted) context.delta('', streamId, true);
      }
      streamId = undefined;
      streamedText = '';
      streamSubmitted = false;
    };

    const spill = async (text: string) => {
      if (text.length <= inlineChars) return text;
      const name = `${randomUUID()}-error.txt`;
      try {
        await dependencies.workspace.writeArtifact(threadId, name, Buffer.from(text), signal);
        return `${text.slice(0, 2000)}\nThe full error is saved in the workspace file ${context.taskContext ? `/workspace/${threadId}/${name}` : name}. Read it there.`;
      } catch {
        return text.slice(0, inlineChars);
      }
    };
    const assertActive = () => {
      signal.throwIfAborted();
      if (stopped || status !== 'succeeded') throw new Error('This execution segment has stopped.');
    };
    const guard = (
      name: string,
      params: unknown,
      execute: () => Promise<unknown>,
      { nested = false, execution: source = execution } = {},
    ): Promise<AgentToolResult> => {
      const label = name.replaceAll('_', ' ');
      const pending = (async () => {
        assertActive();
        const id = randomUUID();
        const started = performance.now();
        const end = (fields: {
          status: 'succeeded' | 'failed' | 'cancelled';
          output?: unknown;
          error?: string;
        }) =>
          observe({
            execution: source,
            type: 'tool_end',
            id,
            name,
            ...fields,
            finishedAt: new Date().toISOString(),
            durationMs: performance.now() - started,
          });
        observe({
          execution: source,
          type: 'tool_start',
          id,
          name,
          input: params,
          startedAt: new Date().toISOString(),
        });
        const catalogResult =
          name === 'manage_apps' && (params as { action?: unknown })?.action === 'discover';
        let result: AgentToolResult;
        try {
          assertActive();
          await pendingReplies;
          assertActive();
          await context.emit('tool_start', label, { execution: source, callId: id });
          assertActive();
          const output = await execute();
          signal.throwIfAborted();
          if (!stopped)
            await context.emit('tool_complete', label, { execution: source, callId: id });
          result = isToolResult(output) ? output : textResult(output);
          if (
            !nested &&
            output !== confirmationNotice &&
            (delimitedTools.has(name) || catalogResult)
          )
            result = delimit(name, result);
          end({ status: 'succeeded', output });
        } catch (error) {
          if (!stopped)
            await context
              .emit('tool_failed', label, { execution: source, callId: id })
              .catch(() => {});
          const browserFailure = error instanceof BrowserActionError ? error.message : undefined;
          const failure = signal.aborted
            ? 'The action was cancelled.'
            : await spill(
                (dependencies.redactError ?? String)(
                  browserFailure ?? (error instanceof Error ? error.message : String(error)),
                ),
              );
          end({ status: signal.aborted ? 'cancelled' : 'failed', error: failure });
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
      const rootWorkspace = dependencies.workspace.open(context);
      let workspace = rootWorkspace;
      if (context.taskContext) {
        const path = `${rootWorkspace.path}/tasks/${context.taskContext.id}`;
        const created = await rootWorkspace.exec(
          `mkdir -p '${path}/drafts' '${path}/outputs' '${rootWorkspace.path}/shared'`,
          { signal },
        );
        if (created.exitCode) throw new Error('The task folder could not be created.');
        workspace = { ...rootWorkspace, path };
      }
      const browser: Computer = {
        ...computer,
        act: (id, action, actionSignal) =>
          computer.act(
            id,
            { ...action, timeZone: context.timeZone, locale: context.locale },
            actionSignal,
          ),
      };
      let decided = Promise.resolve(false);
      const admission = () => {
        const earlier = decided;
        let decide!: (asks: boolean) => void;
        const own = new Promise<boolean>((resolve) => {
          decide = resolve;
        });
        decided = Promise.all([earlier, own]).then(([before, asks]) => before || asks);
        const gate = {
          asked: false,
          admit: async (asks: boolean) => {
            if (!asks) decide(false);
            if (await earlier)
              throw new Error("This turn is waiting for the owner's answer. Ask again after it.");
          },
        };
        return { gate, settle: () => decide(gate.asked) };
      };
      const bind = (turn: Turn, take: () => Promise<unknown>) =>
        ottoTools(turn, skills).map(({ name, description, parameters, execute }): AgentTool => ({
          name,
          description,
          parameters,
          parallel: parallelTools.has(name),
          execute: async (params) => {
            assertActive();
            if (browserTools.has(name) || handsOverBrowser(name, params)) await take();
            assertActive();
            const admitted = orderedTools.has(name) ? admission() : undefined;
            const run = () =>
              guard(
                name,
                params,
                async () => {
                  if (!Value.Check(parameters, params)) {
                    const error = Value.Errors(parameters, params).First();
                    throw new Error(
                      `Invalid ${name} arguments${error ? ` at ${error.path || '/'}: ${error.message}` : ''}.`,
                    );
                  }
                  if (handsOverBrowser(name, params))
                    await computer.currentPage(turn.execution.browserId).catch(() => {
                      throw new Error(
                        'Open the page in your browser before handing it to the user.',
                      );
                    });
                  return execute(params);
                },
                { execution: turn.execution },
              );
            return admitted ? admissions.run(admitted.gate, run).finally(admitted.settle) : run();
          },
        }));
      const system = systemPrompt(
        workspace,
        dependencies.skills,
        context.taskContext,
        context.background,
      );
      const task = context.task;
      const shared = {
        context: {
          ...context,
          task: task
            ? async (input: unknown) => {
                const result = await task(input);
                const action = (input as { action?: string }).action;
                if (
                  context.channel === 'telegram' &&
                  (action === 'update' || action === 'finish') &&
                  result &&
                  typeof result === 'object' &&
                  'id' in result &&
                  'status' in result
                ) {
                  const updated = result as Task;
                  await deliverReply(
                    taskSummary(updated),
                    undefined,
                    updated.messageId ?? undefined,
                  );
                  if (action === 'finish') reportedTaskResult = updated.result.trim();
                }
                return result;
              }
            : undefined,
          integration: (action: string, args: Record<string, unknown>, callSignal?: AbortSignal) =>
            context.integration(action, args, callSignal, admissions.getStore()?.admit),
          manage: (action: string, args: Record<string, unknown>) =>
            context.manage(action, args, admissions.getStore()?.admit),
        },
        computer: browser,
        reply,
        invite: (text: string) => deliverReply(text),
        pause,
        confirm,
      };
      const delegate = async (title: string, instruction: string) => {
        assertActive();
        const runId = randomUUID();
        const childBrowser = runId;
        const source: ExecutionScope = {
          ...execution,
          runId,
          parentRunId: execution.runId,
          browserId: childBrowser,
        };
        const childPath = `${workspace.path}/.otto/runs/${runId}`;
        if ((await workspace.exec(`mkdir -p -- '${childPath}'`, { signal })).exitCode)
          throw new Error('The subagent workspace could not be opened.');
        assertActive();
        let browsed = false;
        let answer = '';
        let failed = false;
        let incomplete = false;
        let completed = false;
        await context.emit('agent_start', title, { execution: source });
        let child: AgentSession | undefined;
        try {
          child = await agent.open({
            ...source,
            ephemeral: true,
            systemPrompt: system,
            systemContext: systemContext(context),
            tools: bind({ ...shared, execution: source }, async () => {
              browsed = true;
            }).filter((tool) => !parentTools.has(tool.name)),
            workspace: { ...workspace, path: childPath },
            timeZone: context.timeZone,
            runTool: (name, params, run, options) =>
              guard(name, params, run, { ...options, execution: source }),
            shouldStop: () => stopped,
            onEvent: (event) => {
              if (event.type === 'final') answer = event.text;
              if (event.type === 'error') failed = true;
              if (event.type === 'message_end' && event.status === 'incomplete') incomplete = true;
              if (
                event.type === 'final' ||
                (event.type === 'message_end' && event.status === 'succeeded')
              )
                failed = incomplete = false;
            },
          });
          children.add(child);
          assertActive();
          await child.prompt(
            `${currentUserTime(context.timeZone)}\nYou are a subagent doing one part of the owner's request: ${title}\n${instruction}\nYour working directory is ${childPath}. Write new files there. The shared workspace is ${workspace.path}. Give complete file paths in your answer. Return any question or browser blocker to the parent agent. Do not hand your browser to the owner. Your final answer goes back to the parent agent, so include every result it needs.`,
            [],
          );
          if (failed) throw new Error('The subagent model request failed.');
          if (incomplete) throw new Error('The subagent response was incomplete.');
          assertActive();
          completed = true;
        } finally {
          if (child) children.delete(child);
          await Promise.resolve()
            .then(() => child?.dispose())
            .catch(() => {});
          if (browsed) await computer.discard(childBrowser).catch(() => {});
          await context
            .emit(
              completed ? 'agent_complete' : stopped ? 'agent_cancelled' : 'agent_failed',
              title,
              { execution: source },
            )
            .catch(() => {});
        }
        signal.throwIfAborted();
        return answer || 'The subagent finished without an answer.';
      };
      const followUps: string[] = [];
      const followUp = (text: string) => {
        const trimmed = text.trim();
        if (!trimmed) throw new Error('Write the follow-up line.');
        if (followUps.length) return 'A follow-up is already queued.';
        followUps.push(trimmed);
        return 'Queued. It goes out as its own message right after your reply; do not repeat it.';
      };
      const tools = bind(
        {
          ...shared,
          execution,
          delegate,
          ...(!context.background || context.taskContext ? { followUp } : {}),
        },
        async () => {
          if (!browsed) await computer.hold(browserId, false).catch(() => {});
          browsed = true;
        },
      );
      const instruct = (instruction: string) =>
        `${currentUserTime(context.timeZone)}\n${instruction}`;
      const { takeMessages } = context;
      const root = resolve(context.workspacePath);
      const inline = async (
        attachments: RuntimeContext['attachments'],
        budget = { left: imageBudget },
      ) => {
        const images: AgentImage[] = [];
        const omitted = new Set<string>();
        for (const attachment of attachments) {
          if (!imageTypes.has(attachment.mimeType)) continue;
          const path = resolve(attachment.path);
          if (!path.startsWith(root + sep)) continue;
          const limit = Math.min(imageBytes, budget.left);
          try {
            const bytes =
              session?.readsImages !== false && limit > 0
                ? Buffer.from(
                    await dependencies.workspace.readArtifact(
                      threadId,
                      relative(root, path),
                      limit,
                      'attachment',
                    ),
                  )
                : undefined;
            signal.throwIfAborted();
            if (!bytes || bytes.length > limit) omitted.add(attachment.path);
            else {
              budget.left -= bytes.length;
              images.push({
                type: 'image',
                data: bytes.toString('base64'),
                mimeType: attachment.mimeType,
              });
            }
          } catch {
            signal.throwIfAborted();
            omitted.add(attachment.path);
          }
        }
        return { images, omitted };
      };
      await context.emit('agent_start', 'Main agent', { execution });
      const opening = agent.open({
        ...execution,
        systemPrompt: system,
        systemContext: systemContext(context),
        tools,
        workspace,
        timeZone: context.timeZone,
        runTool: guard,
        shouldStop: () => stopped,
        nextMessages:
          takeMessages &&
          (async () => {
            const budget = { left: imageBudget };
            const messages = [];
            for (const message of await takeMessages()) {
              const { images, omitted } = await inline(message.attachments, budget);
              messages.push({ text: instruct(steeredInstruction(message, omitted)), images });
            }
            return messages;
          }),
        onEvent: (event) => {
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
          if (event.type === 'final') {
            modelFailed = modelIncomplete = false;
            if (context.taskContext) taskResult = event.text;
          }
          if (stopped || context.background) return;
          if (event.type === 'text_delta') {
            streamId ??= randomUUID();
            bufferedText += event.text;
            if (/[.!?\n]\s*$/.test(bufferedText)) flushText();
          }
          if (event.type === 'final') queueStreamReply(event.text, streamId ?? randomUUID());
        },
      });
      session = await opening;
      signal.throwIfAborted();
      const resumed = session.resumed;
      const { images, omitted } = await inline(context.attachments);
      await session!.prompt(instruct(firstInstruction(context, resumed, omitted)), images);
      await pendingReplies;
      signal.throwIfAborted();
      if (modelFailed)
        throw new Error('The model request failed. Check the configured provider and model.');
      if (modelIncomplete && status === 'succeeded')
        throw new Error('The model response was incomplete. Say continue to try again.');
      if (stopped && status === 'succeeded') throw new Error('The turn was stopped.');
      let result =
        context.taskContext &&
        taskResult &&
        taskResult.trim() !== lastReply &&
        taskResult.trim() !== reportedTaskResult
          ? taskResult
          : undefined;
      if (status === 'succeeded' && followUps.length) {
        if (result) {
          await deliverReply(result);
          result = undefined;
        }
        for (const text of followUps) {
          await wait(1200, undefined, { signal });
          await deliverReply(text);
        }
      }
      waitingForUser = status !== 'succeeded';
      completed = true;
      return {
        status,
        ...(result ? { result } : {}),
        ...(waitingFor ? { waitingFor } : {}),
        ...(question ? { question } : {}),
      };
    } finally {
      stopped = true;
      completeStream();
      signal.removeEventListener('abort', abort);
      try {
        await Promise.resolve()
          .then(() => session?.dispose())
          .catch((error: unknown) => {
            if (!signal.aborted) throw error;
          });
      } finally {
        await Promise.allSettled([...activeToolCalls]);
        activeTurns.delete(context.turnId);
        await context
          .emit(
            waitingForUser ? 'agent_waiting' : !completed ? 'agent_failed' : 'agent_complete',
            'Main agent',
            { execution },
          )
          .catch(() => {});
        if (sessionId !== threadId && !waitingForUser && (browsed || context.resumed))
          await computer.discard(browserId).catch(() => {});
        finished();
      }
    }
  }

  return {
    runTurn,
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
