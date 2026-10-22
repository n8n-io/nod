import { readdir, readFile, stat } from 'node:fs/promises';
import { join } from 'node:path';
import type { Write, AppsWorld } from './world/apps.ts';
import type { Interaction, Session } from './session.ts';
import { approvalOrder, type Stack } from './stack.ts';
import type { World } from './scenario.ts';
import type { Visit } from './world/sites.ts';
import { browserSessionId } from '../../src/providers/agent-browser/index.ts';

export interface ToolCall {
  turnId?: string;
  browser?: string;
  name: string;
  input: any;
  output: string;
  isError: boolean;
  at: number;
  lead: string;
}

export interface ChatMessage {
  role: 'user' | 'assistant';
  text: string;
  at: number;
  turnId: string | null;
}

export interface Run {
  api: Session['api'];
  task: string;
  messages: ChatMessage[];
  replies: string[];
  final: string;
  said: string;
  tools: ToolCall[];
  turns: Array<{
    id: string;
    status: string;
    source: string;
    error: string | null;
    background: boolean;
    waiting_reason?: string | null;
    waiting?: boolean;
    startedAt?: number;
    finishedAt?: number;
  }>;
  prompts?: Array<{ turnId: string; instruction: string }>;
  interactions: Interaction[];
  userMessages: Array<{ at: number; text: string }>;
  writes: Write[];
  files: string[];
  schedules: Array<{
    title: string;
    prompt: string;
    cron: string | null;
    timeZone: string;
    enabled: boolean;
    kind: string;
    runAt: number | null;
  }>;
  scheduleRuns: Array<{ title: string; observation: any; turnId: string | null }>;
  memory: string;
  modelErrors: string[];
  approvals: Array<{ turnId: string; action: string; status: string; args: unknown }>;
  visits: Visit[];
  usage: { tokens: number; modelCalls: number; costUsd: number | null };
  firstReplySeconds: number | null;
  acknowledgement: { turnsWithTools: number; acknowledged: number };
  seconds: number;
  world: World;
  apps?: AppsWorld;
  read(path: string): Promise<Buffer | undefined>;
  text(path: string): Promise<string>;
  transcript(limit?: number): string;
  groundTruth(): string;
}

export function clip(value: string, limit: number) {
  return value.length <= limit
    ? value
    : `${value.slice(0, Math.floor(limit * 0.7))}\n…[${value.length - limit} characters omitted]…\n${value.slice(-Math.floor(limit * 0.25))}`;
}

export function requireBackgroundPrompts(turns: Run['turns'], prompts: Run['prompts'] = []) {
  const captured = new Set(prompts.map((prompt) => prompt.turnId));
  const missing = turns.filter(
    (turn) =>
      turn.background &&
      turn.status === 'succeeded' &&
      turn.startedAt !== undefined &&
      !captured.has(turn.id),
  );
  if (missing.length)
    throw new Error(
      `Prompt capture is missing for completed background turns: ${missing.map((turn) => turn.id).join(', ')}`,
    );
}

async function sessionEvents(sessionRoot: string) {
  const entries: any[] = [];
  for (const thread of await readdir(sessionRoot).catch(() => [] as string[])) {
    const files = await Promise.all(
      (await readdir(join(sessionRoot, thread)))
        .filter((name) => name.endsWith('.jsonl'))
        .map(async (name) => {
          const path = join(sessionRoot, thread, name);
          return { path, modified: (await stat(path)).mtimeMs };
        }),
    );
    const latest = files.sort((a, b) => b.modified - a.modified)[0];
    if (latest)
      for (const line of (await readFile(latest.path, 'utf8')).split('\n'))
        if (line.trim()) entries.push({ sessionId: thread, entry: JSON.parse(line) });
  }
  return entries;
}

function capturedTools(stack: Stack) {
  const tools: ToolCall[] = [];
  const started = new Map<string, ToolCall>();
  for (const { turnId, event } of stack.observations) {
    if (event.type === 'model_usage' || !event.execution?.parentRunId) continue;
    const id = `${event.execution?.runId ?? turnId}:${event.id}`;
    if (event.type === 'tool_start') {
      if (started.has(id)) continue;
      const call: ToolCall = {
        turnId,
        browser: event.execution?.browserId && browserSessionId(event.execution.browserId),
        name: event.name,
        input: event.input,
        output: '',
        isError: false,
        at: Date.parse(event.startedAt),
        lead: '',
      };
      started.set(id, call);
      tools.push(call);
    } else if (event.type === 'tool_end') {
      const call = started.get(id);
      if (call) {
        const output = event.output ?? event.error ?? '';
        call.output =
          output &&
          typeof output === 'object' &&
          'content' in output &&
          Array.isArray(output.content)
            ? output.content
                .map((block: any) => (block.type === 'text' ? block.text : `[${block.type}]`))
                .join('\n')
            : typeof output === 'string'
              ? output
              : JSON.stringify(output);
        call.isError = event.status !== 'succeeded';
      }
    }
  }
  return tools;
}

export async function collect(options: {
  task: string;
  stack: Stack;
  session: Session;
  world: World;
  visits: Visit[];
  seconds: number;
}): Promise<Run> {
  const { stack, session, world } = options;
  const tools = capturedTools(stack);
  const calls = new Map<string, ToolCall>();
  const prompts = [...stack.prompts];
  const currentTurns = new Map<string, string | undefined>();
  let turnsWithTools = 0;
  let acknowledged = 0;
  let waitingForFirst = false;
  let foreground = false;
  const modelErrors: string[] = [];
  for (const { sessionId, entry } of await sessionEvents(stack.sessionRoot)) {
    if (entry.type !== 'message') continue;
    const message = entry.message;
    if (message.role === 'user') {
      const text = (Array.isArray(message.content) ? message.content : [])
        .map((block: any) => (block.type === 'text' ? block.text : ''))
        .join('');
      foreground = /"mode":"conversation"/.test(text);
      waitingForFirst = foreground;
      const index = prompts.findIndex(
        (prompt) => prompt.sessionId === sessionId && prompt.instruction === text,
      );
      currentTurns.set(sessionId, index < 0 ? undefined : prompts.splice(index, 1)[0].turnId);
    }
    if (message.role === 'assistant') {
      if (waitingForFirst) {
        waitingForFirst = false;
        if ((message.content ?? []).some((block: any) => block.type === 'toolCall')) {
          turnsWithTools++;
          if (
            (message.content ?? []).some((block: any) => block.type === 'text' && block.text.trim())
          )
            acknowledged++;
        }
      }
      if (message.stopReason === 'error')
        modelErrors.push(String(message.errorMessage ?? 'model error'));
      const lead = (message.content ?? [])
        .filter((block: any) => block.type === 'text')
        .map((block: any) => block.text)
        .join('')
        .trim();
      for (const block of message.content ?? []) {
        if (block.type !== 'toolCall') continue;
        const id = `${sessionId}:${block.id}`;
        const call: ToolCall = {
          turnId: currentTurns.get(sessionId),
          browser: browserSessionId(sessionId),
          name: block.name,
          input: block.arguments,
          output: '',
          isError: false,
          at: Date.parse(entry.timestamp),
          lead,
        };
        calls.set(id, call);
        tools.push(call);
      }
    } else if (message.role === 'toolResult') {
      const call = calls.get(`${sessionId}:${message.toolCallId}`);
      if (call) {
        call.output = (message.content ?? [])
          .map((block: any) => (block.type === 'text' ? block.text : `[${block.type}]`))
          .join('\n');
        call.isError = message.isError === true;
      }
    }
  }
  const usage = (await stack.pool.query('SELECT cost_usd,details FROM model_usage')).rows;
  const tokens = usage.reduce(
    (total, row) =>
      total +
      ['inputTokens', 'outputTokens', 'cacheReadTokens', 'cacheWriteTokens'].reduce(
        (sum, key) => sum + (row.details[key] ?? 0),
        0,
      ),
    0,
  );
  const cost = usage.reduce((total, row) => total + (row.cost_usd ?? 0), 0);
  const costKnown = usage.length > 0 && usage.every((row) => row.cost_usd !== null);
  const messages = (
    await stack.pool.query(
      'SELECT role,text,turn_id,created_at FROM messages ORDER BY created_at, id',
    )
  ).rows.map((row): ChatMessage => ({
    role: row.role,
    text: row.text ?? '',
    at: new Date(row.created_at).getTime(),
    turnId: row.turn_id,
  }));
  const turns = (
    await stack.pool.query(
      `SELECT t.id,t.status,t.source,t.error,t.background,t.waiting_reason,t.started_at,t.finished_at,${stack.waiting('t')} AS waiting FROM turns t ORDER BY t.created_at, t.id`,
    )
  ).rows.map(({ started_at, finished_at, ...turn }) => ({
    ...turn,
    startedAt: started_at ? new Date(started_at).getTime() : undefined,
    finishedAt: finished_at ? new Date(finished_at).getTime() : undefined,
  }));
  requireBackgroundPrompts(turns, stack.prompts);
  tools.sort((a, b) => a.at - b.at);
  const schedules = (
    await stack.pool.query(
      'SELECT title,prompt,cron,time_zone,enabled,kind,run_at FROM schedules ORDER BY created_at',
    )
  ).rows.map((row) => ({
    title: row.title as string,
    prompt: row.prompt as string,
    cron: row.cron as string | null,
    timeZone: row.time_zone as string,
    enabled: row.enabled as boolean,
    kind: row.kind as string,
    runAt: row.run_at ? new Date(row.run_at).getTime() : null,
  }));
  const scheduleRuns = (
    await stack.pool.query(
      'SELECT title,observation,turn_id FROM schedule_runs ORDER BY created_at',
    )
  ).rows.map((row) => ({
    title: row.title as string,
    observation: row.observation,
    turnId: row.turn_id as string | null,
  }));
  const view = (await (await stack.request('/api/memory')).json()) as {
    notes?: Array<{ path: string; text: string; status: string }>;
    archive?: Array<{ path: string; text: string; reason: string }>;
    skills?: Array<{ name: string; description: string; body: string; updated: string }>;
  };
  const memory = JSON.stringify({
    notes: (view.notes ?? []).map(({ path, text, status }) => ({ path, text, status })),
    archive: (view.archive ?? []).map(({ path, text, reason }) => ({ path, text, reason })),
    ...(view.skills?.length
      ? {
          skills: view.skills.map(({ name, description, body, updated }) => ({
            name,
            description,
            body,
            updated,
          })),
        }
      : {}),
  });
  const approvals = (
    await stack.pool.query(
      `SELECT turn_id,action,status,args FROM approvals ORDER BY ${await approvalOrder(stack.pool)}`,
    )
  ).rows.map((row) => ({
    turnId: row.turn_id as string,
    action: row.action as string,
    status: row.status as string,
    args: row.args,
  }));
  const firstUser = messages.find((message) => message.role === 'user');
  const firstAnswer = messages.find(
    (message) => message.role === 'assistant' && message.text.trim(),
  );
  const firstReplySeconds =
    firstUser && firstAnswer ? Math.max(0, (firstAnswer.at - firstUser.at) / 1000) : null;
  const replies = messages
    .filter((m) => m.role === 'assistant' && m.text.trim())
    .map((m) => m.text);
  const files = await session.workspace.list();
  const filePath = (path: string) => path.replace(/^\/workspace\//, '');
  const sharedPaths = new Set(
    tools
      .filter((call) => call.name === 'share_file' && !call.isError)
      .map((call) => String(call.input?.path ?? '').replace(/^\.\//, ''))
      .filter((path) => /\.(md|txt|csv|tsv|json|html?|ics|ya?ml|xml)$/i.test(path))
      .map((path) =>
        path.startsWith('/workspace/') ? path : files.find((file) => file.endsWith(`/${path}`)),
      )
      .filter((path): path is string => Boolean(path)),
  );
  const sharedText = (
    await Promise.all(
      [...sharedPaths].map(async (path) => {
        const text = (await session.workspace.read(filePath(path)))?.toString('utf8');
        return text ? `--- ${path} ---\n${clip(text, 6000)}` : '';
      }),
    )
  ).filter(Boolean);
  const run: Run = {
    task: options.task,
    messages,
    replies,
    final: replies.at(-1) ?? '',
    said: replies.join('\n\n'),
    tools,
    turns,
    prompts: stack.prompts,
    interactions: session.interactions,
    userMessages: session.userMessages,
    writes: world.apps?.writes ?? [],
    files,
    schedules,
    scheduleRuns,
    memory,
    modelErrors,
    approvals,
    visits: options.visits,
    usage: { tokens, modelCalls: usage.length, costUsd: costKnown ? cost : null },
    firstReplySeconds,
    acknowledgement: { turnsWithTools, acknowledged },
    seconds: options.seconds,
    world,
    apps: world.apps,
    api: session.api,
    read: (path) => session.workspace.read(filePath(path)),
    async text(path) {
      return (await session.workspace.read(filePath(path)))?.toString('utf8') ?? '';
    },
    transcript(limit = 60_000) {
      const build = (outputCap: number) => {
        return [
          ...messages
            .filter((m) => m.text.trim())
            .map((m) => ({
              at: m.at,
              text: `${m.role === 'user' ? 'USER' : 'ASSISTANT'}: ${m.text}`,
            })),
          ...tools.map((call) => ({
            at: call.at,
            text: `TOOL ${call.name}${call.isError ? ' (error)' : ''}\n  input: ${clip(JSON.stringify(call.input), 1200)}\n  output: ${clip(call.output, outputCap)}`,
          })),
        ]
          .sort((a, b) => a.at - b.at)
          .map((item) => `[${new Date(item.at).toISOString()}] ${item.text}`)
          .join('\n\n');
      };
      for (const cap of [6000, 3000, 1500]) {
        const text = build(cap);
        if (text.length <= limit) return text;
      }
      return clip(build(800), limit);
    },
    groundTruth() {
      const failedTurns = turns.filter(
        (turn) => turn.status !== 'succeeded' && (turn.status !== 'waiting' || turn.waiting),
      );
      return [
        `Tool calls: ${tools.length} (${tools.filter((call) => call.isError).length} returned an error).`,
        `Assistant messages shown to the user: ${replies.length}.`,
        `Questions the assistant asked the user: ${session.interactions.filter((i) => i.kind === 'question').length}. Follow-up questions asked in chat that the simulated user answered afterwards: ${session.interactions.filter((i) => i.kind === 'chat').length}.`,
        `Changes made in connected apps: ${
          run.writes.length ? run.writes.map((w) => `${w.kind} via ${w.slug}`).join('; ') : 'none'
        }.`,
        `Workspace files: ${files.length ? files.join(', ') : 'none'}.`,
        ...(sharedText.length
          ? [`Text of files shared with the user:\n${sharedText.join('\n')}`]
          : []),
        `Actions the user approved or declined (the server runs these itself, so they never appear as tool calls): ${approvals.length ? approvals.map((item) => `${item.action} ${item.status} ${JSON.stringify(item.args).slice(0, 220)}`).join('; ') : 'none'}.`,
        `Saved memory: ${memory.slice(0, 700)}`,
        failedTurns.length
          ? `Turns that did not succeed: ${failedTurns.map((turn) => `${turn.status} (${turn.background ? 'background ' : ''}${turn.source}${turn.waiting_reason ? `, waiting for ${turn.waiting_reason}` : ''})${turn.error ? ` (${turn.error})` : ''}`).join('; ')}.`
          : 'Every turn finished.',
      ].join('\n');
    },
  };
  return run;
}
