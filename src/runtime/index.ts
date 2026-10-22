import { AsyncLocalStorage } from 'node:async_hooks';
import { randomUUID } from 'node:crypto';
import { mkdir } from 'node:fs/promises';
import { setTimeout as wait } from 'node:timers/promises';
import { relative, resolve, sep } from 'node:path';
import { Value } from '@sinclair/typebox/value';
import type {
  Agent,
  AgentEvent,
  AgentImage,
  AgentSession,
  AgentTool,
  AgentToolResult,
  RuntimeContext,
  RuntimeObservation,
  RuntimeResult,
  SkillLibrary,
} from '../ports/agent.ts';
import { appConfirmation, ModelRequestError } from '../ports/agent.ts';
import type { Computer, Workspace } from '../ports/computer.ts';
import { BrowserActionError } from '../ports/computer.ts';
import { threadIdentity } from '../ports/thread-identity.ts';
import { firstInstruction, ownerContext, steeredInstruction, systemPrompt } from './prompt.ts';
import { untrustedBlock } from '../shared/untrusted.ts';
import { currentUserTime } from './time-context.ts';
import { connectedTools, nodTools } from './tools.ts';
import type { Turn } from './turn.ts';
import type { ExecutionScope } from '../shared/execution.ts';
import { delimit } from './untrusted.ts';
import type { Task } from '../shared/contracts.ts';

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
const orderedTools = new Set(['apps', 'manage_personal_context', 'skills']);
const admissions = new AsyncLocalStorage<{
  asked: boolean;
  admit(asks: boolean): Promise<void>;
}>();
const browserTools = new Set(['browser', 'browser_session', 'sign_in', 'pay']);
const browserLink = /\]\(\/browser\)/;
const handsOverBrowser = (name: string, params: unknown) =>
  name === 'ask_user' &&
  browserLink.test(String((params as { question?: unknown } | null)?.question));
const confirmationNotice = 'The confirmation question is in chat. Wait for the reply.';
const reportingTools = new Set(['ask_user', 'send_message', 'share_file', 'task']);
const dollars = (value: number) => `$${Number.isInteger(value) ? value : value.toFixed(2)}`;
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

function untilAborted<T>(work: Promise<T>, signal: AbortSignal): Promise<T> {
  work.catch(() => {});
  return new Promise<T>((resolve, reject) => {
    const abort = () => reject(signal.reason);
    if (signal.aborted) return abort();
    signal.addEventListener('abort', abort, { once: true });
    work.then(resolve, reject).finally(() => signal.removeEventListener('abort', abort));
  });
}

export function createAgentRuntime(dependencies: {
  agent: Agent;
  computer: Computer;
  workspace: Workspace;
  skills?: SkillLibrary;
  redactError?(text: string): string;
  observe?(turnId: string, event: RuntimeObservation): void;
  pageVisited?(url: string, subagent: boolean): void;
  analyzeImages?(
    images: AgentImage[],
    request: string,
    signal: AbortSignal,
    execution: ExecutionScope & { onEvent(event: AgentEvent): void },
  ): Promise<string | undefined>;
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
    let waitingMessage: string | undefined;
    const sites = new Map<string, string>();
    let stopped = false;
    let modelError: string | undefined;
    let modelIncomplete = false;
    let completed = false;
    let lastReply = '';
    let checkInSpent = context.checkIn?.spentUsd ?? 0;
    let checkInBlocked = false;
    let checkInStrikes = 0;
    let checkInStopped = false;
    const overBudget = () =>
      context.checkIn !== undefined && checkInSpent >= context.checkIn.budgetUsd;
    const countUsage = (event: AgentEvent) => {
      const usage =
        event.type === 'model_usage'
          ? event
          : event.type === 'provider_usage'
            ? event.usage
            : undefined;
      if (usage) checkInSpent += usage.costUsd ?? usage.estimateUsd ?? 0;
    };
    let pendingReplies = Promise.resolve();
    const persistedStreams = new Set<string>();
    let streamId: string | undefined;
    let bufferedText = '';
    let streamedText = '';
    let streamSubmitted = false;
    let speakNext = !context.taskContext;
    let replyOwed = false;
    let answered = false;
    let lastNote = '';
    let reported = false;
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
    const speaks = !context.background || Boolean(context.taskContext);
    const deliverReply = async (text: string, id?: string, replyToMessageId?: string) => {
      signal.throwIfAborted();
      const trimmed = text.trim();
      if (!trimmed || trimmed === lastReply) return;
      await context.reply(trimmed, id, replyToMessageId);
      if (id) persistedStreams.add(id);
      lastReply = trimmed;
      replyOwed = false;
    };
    const reply = deliverReply;
    const pause = async (reason: 'question' | 'approval' | 'credentials', message?: string) => {
      status = reason === 'credentials' ? 'waiting_credentials' : 'waiting_user';
      waitingFor = reason;
      waitingMessage = message;
      if (browsed) await computer.hold(browserId, true).catch(() => {});
      stopped = true;
      abortSession();
    };
    const confirm = async (result: unknown) => {
      if (!(result && typeof result === 'object' && appConfirmation in result)) return result;
      const gate = admissions.getStore();
      if (gate) gate.asked = true;
      await pause('approval');
      return confirmationNotice;
    };

    const flushText = () => {
      if (bufferedText && !stopped && speaks) {
        if (speakNext || replyOwed) context.delta(bufferedText, (streamId ??= randomUUID()));
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
    const completeStream = () => {
      flushText();
      if (streamId && speaks && !streamSubmitted) context.delta('', streamId, true);
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
        if (overBudget() && !reportingTools.has(name)) {
          if (source === execution) checkInBlocked = true;
          throw new Error(
            `This work has used ${dollars(checkInSpent)} since the owner's last message, past the ${dollars(context.checkIn!.budgetUsd)} check-in. Do no more work now. Call ask_user to say in a line what is done and what is left, and ask whether to keep going.`,
          );
        }
        const id = randomUUID();
        const started = performance.now();
        const event = () => ({
          execution: source,
          callId: id,
          ...(browserTools.has(name) && sites.has(source.browserId)
            ? { site: sites.get(source.browserId) }
            : {}),
        });
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
          await untilAborted(pendingReplies, signal);
          assertActive();
          await context.emit('tool_start', label, event());
          assertActive();
          const output = await untilAborted(execute(), signal);
          signal.throwIfAborted();
          if (
            name === 'send_message' ||
            (name === 'task' && (params as { action?: unknown } | null)?.action === 'start')
          )
            reported = true;
          if (!stopped) await context.emit('tool_complete', label, event());
          result = isToolResult(output) ? output : textResult(output);
          if (
            !nested &&
            output !== confirmationNotice &&
            (delimitedTools.has(name) || name.startsWith('mcp__') || catalogResult)
          )
            result = delimit(name, result);
          end({ status: 'succeeded', output });
        } catch (error) {
          if (!stopped) await context.emit('tool_failed', label, event()).catch(() => {});
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
      const bind = (turn: Turn, take: () => Promise<unknown>): AgentTool[] =>
        [...nodTools(turn, skills), ...connectedTools(turn)].map((tool): AgentTool => {
          const { name, description, parameters, execute } = tool;
          const deferred = (tool as Partial<Pick<AgentTool, 'deferred'>>).deferred;
          return {
            name,
            description,
            parameters,
            ...(deferred ? { deferred } : {}),
            parallel: Boolean(deferred) || parallelTools.has(name),
            execute: async (params, options) => {
              assertActive();
              if (browserTools.has(name) || handsOverBrowser(name, params)) await take();
              assertActive();
              const admitted = deferred || orderedTools.has(name) ? admission() : undefined;
              const run = () =>
                guard(
                  name,
                  params,
                  async () => {
                    if (!deferred && !Value.Check(parameters, params)) {
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
                  { execution: turn.execution, nested: Boolean(options?.nested) },
                );
              return admitted ? admissions.run(admitted.gate, run).finally(admitted.settle) : run();
            },
          };
        });
      const system = systemPrompt(
        workspace,
        dependencies.skills,
        context.taskContext,
        context.background,
      );
      const shared = {
        context: {
          ...context,
          integration: (action: string, args: Record<string, unknown>, callSignal?: AbortSignal) =>
            context.integration(action, args, callSignal, admissions.getStore()?.admit),
          manage: (action: string, args: Record<string, unknown>) =>
            context.manage(action, args, admissions.getStore()?.admit),
        },
        computer: browser,
        pageVisited: dependencies.pageVisited,
        reply,
        pause,
        confirm,
        visited: (browserId: string, url: string) => {
          const host = URL.parse(url)?.host;
          if (host) sites.set(browserId, host);
        },
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
        const childPath = `${workspace.path}/.nod/runs/${runId}`;
        if ((await workspace.exec(`mkdir -p -- '${childPath}'`, { signal })).exitCode)
          throw new Error('The subagent workspace could not be opened.');
        assertActive();
        let browsed = false;
        let answer = '';
        let failure: string | undefined;
        let incomplete = false;
        let completed = false;
        await context.emit('agent_start', title, { execution: source });
        let child: AgentSession | undefined;
        try {
          child = await agent.open({
            ...source,
            ephemeral: true,
            systemPrompt: system,
            ownerContext: ownerContext(context),
            tools: bind({ ...shared, execution: source }, async () => {
              browsed = true;
            }).filter((tool) => !parentTools.has(tool.name)),
            workspace: { ...workspace, path: childPath },
            timeZone: context.timeZone,
            runTool: (name, params, run, options) =>
              guard(name, params, run, { ...options, execution: source }),
            shouldStop: () => stopped || overBudget(),
            onEvent: (event) => {
              countUsage(event);
              if (event.type === 'final') answer = event.text;
              if (event.type === 'error') failure = event.message;
              if (event.type === 'message_end' && event.status === 'incomplete') incomplete = true;
              if (
                event.type === 'final' ||
                (event.type === 'message_end' && event.status === 'succeeded')
              ) {
                failure = undefined;
                incomplete = false;
              }
            },
          });
          children.add(child);
          assertActive();
          await child.prompt(
            `${currentUserTime(context.timeZone)}\nYou are a subagent doing one part of the owner's request: ${title}\n${instruction}\nYour working directory is ${childPath}. Write new files there. The shared workspace is ${workspace.path}. Give complete file paths in your answer. Return any question or browser blocker to the parent agent. Do not hand your browser to the owner. Your final answer goes back to the parent agent, so include every result it needs.`,
            [],
          );
          if (failure) throw new Error(`The subagent model request failed: ${failure}`);
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
          ...(speaks ? { followUp } : {}),
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
        request: string,
        budget = { left: imageBudget },
      ) => {
        const images: AgentImage[] = [];
        const paths: string[] = [];
        const omitted = new Set<string>();
        for (const attachment of attachments) {
          if (!imageTypes.has(attachment.mimeType)) continue;
          const path = resolve(attachment.path);
          if (!path.startsWith(root + sep)) continue;
          const limit = Math.min(imageBytes, budget.left);
          try {
            const bytes =
              (session?.readsImages !== false || dependencies.analyzeImages) && limit > 0
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
              paths.push(attachment.path);
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
        if (session?.readsImages === false) {
          let description: string | undefined;
          if (images.length && dependencies.analyzeImages && !overBudget()) {
            try {
              description = await untilAborted(
                dependencies.analyzeImages(images, request, signal, {
                  ...execution,
                  onEvent: countUsage,
                }),
                signal,
              );
            } catch {
              signal.throwIfAborted();
            }
          }
          for (const path of paths) omitted.add(path);
          return {
            images: [],
            omitted,
            analysis: description
              ? untrustedBlock(
                  'image analysis',
                  JSON.stringify({ files: paths.map((path) => relative(root, path)), description }),
                )
              : undefined,
          };
        }
        return { images, omitted };
      };
      await context.emit('agent_start', 'Main agent', { execution });
      const opening = agent.open({
        ...execution,
        systemPrompt: system,
        ownerContext: ownerContext(context),
        tools,
        workspace,
        timeZone: context.timeZone,
        runTool: guard,
        shouldStop: () => {
          if (stopped) return true;
          if (checkInBlocked) checkInStrikes++;
          checkInBlocked = false;
          return (checkInStopped = checkInStrikes >= 2);
        },
        nextMessages:
          takeMessages &&
          (async () => {
            const budget = { left: imageBudget };
            const messages = [];
            const incoming = await takeMessages();
            if (incoming.length) {
              checkInSpent = checkInStrikes = 0;
              replyOwed = true;
            }
            for (const message of incoming) {
              const { images, omitted, analysis } = await inline(
                message.attachments,
                message.text,
                budget,
              );
              messages.push({
                text: instruct(steeredInstruction(message, omitted, analysis)),
                images,
              });
            }
            if (messages.length) {
              pendingReplies = pendingReplies.then(() =>
                context.emit('steered', '', { execution }).catch(() => {}),
              );
              void pendingReplies.catch(() => {});
            }
            return messages;
          }),
        onEvent: (event) => {
          countUsage(event);
          if (event.type === 'message_start') {
            completeStream();
            streamId = randomUUID();
          }
          if (event.type === 'message_end') {
            if (event.status === 'succeeded') {
              modelError = undefined;
              modelIncomplete = false;
            }
            if (event.status === 'incomplete') modelIncomplete = true;
            flushText();
            const text = streamSubmitted || stopped ? '' : streamedText.trim();
            if (
              text &&
              !modelError &&
              (event.status === undefined || event.status === 'succeeded')
            ) {
              if (speakNext || replyOwed) {
                queueStreamReply(text, streamId ?? randomUUID());
                lastNote = '';
                replyOwed = false;
              } else {
                lastNote = text;
                const step = (dependencies.redactError ?? String)(text.split('\n')[0]!).replace(
                  /\s+/g,
                  ' ',
                );
                pendingReplies = pendingReplies.then(() =>
                  context.emit('step', step, { execution }).catch(() => {}),
                );
                void pendingReplies.catch(() => {});
              }
            }
            speakNext = false;
            completeStream();
          }
          if (event.type === 'error') modelError = event.message;
          if (event.type === 'final') {
            modelError = undefined;
            modelIncomplete = false;
            if (context.taskContext) taskResult = event.text;
            answered ||= Boolean(event.text.trim());
          }
          if (stopped || !speaks) return;
          if (event.type === 'text_delta') {
            streamId ??= randomUUID();
            bufferedText += event.text;
            if (/[.!?\n]\s*$/.test(bufferedText)) flushText();
          }
          if (event.type === 'final') {
            pendingReplies = pendingReplies.then(() =>
              context.emit('final', '', { execution }).catch(() => {}),
            );
            queueStreamReply(event.text, streamId ?? randomUUID());
          }
        },
      });
      session = await opening;
      signal.throwIfAborted();
      const resumed = session.resumed;
      const { images, omitted, analysis } = await inline(context.attachments, context.prompt);
      await session!.prompt(
        instruct(firstInstruction(context, resumed, omitted, analysis)),
        images,
      );
      await pendingReplies;
      signal.throwIfAborted();
      if (checkInStopped && status === 'succeeded')
        throw new Error(
          `Paused at the ${dollars(context.checkIn!.budgetUsd)} check-in. Reply to keep going.`,
        );
      if (modelError)
        throw new ModelRequestError(
          `The model request failed: ${(dependencies.redactError ?? String)(modelError)}`,
        );
      if (modelIncomplete && status === 'succeeded')
        throw new Error('The model response was incomplete. Say continue to try again.');
      if (stopped && status === 'succeeded') throw new Error('The turn was stopped.');
      if (status === 'succeeded' && !answered && !reported && lastNote)
        await deliverReply(lastNote);
      let result =
        context.taskContext && taskResult && taskResult.trim() !== lastReply
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
        ...(waitingMessage ? { message: waitingMessage } : {}),
        ...(waitingMessage && browserLink.test(waitingMessage)
          ? { handoffBrowserId: browserId }
          : {}),
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
          await computer.clear(browserId).catch(() => {});
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
