import { readdir, readFile, stat } from 'node:fs/promises';
import { join } from 'node:path';
import type { Write, AppsWorld } from './world/apps.ts';
import type { Interaction, Session } from './session.ts';
import type { Stack } from './stack.ts';
import type { World } from './scenario.ts';
import type { Visit } from './world/sites.ts';

export interface ToolCall {
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
  }>;
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
  approvals: Array<{ action: string; status: string; args: unknown }>;
  profile: { name: string; location: string; preferences: string } | undefined;
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
        if (line.trim()) entries.push(JSON.parse(line));
  }
  return entries;
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
  const calls = new Map<string, ToolCall>();
  const tools: ToolCall[] = [];
  let turnsWithTools = 0;
  let acknowledged = 0;
  let waitingForFirst = false;
  let foreground = false;
  const modelErrors: string[] = [];
  let tokens = 0;
  let modelCalls = 0;
  let cost = 0;
  let costKnown = false;
  for (const entry of await sessionEvents(stack.sessionRoot)) {
    if (entry.type !== 'message') continue;
    const message = entry.message;
    if (message.role === 'user') {
      const text = (Array.isArray(message.content) ? message.content : [])
        .map((block: any) => (block.type === 'text' ? block.text : ''))
        .join('');
      foreground = /"mode":"conversation"/.test(text);
      waitingForFirst = foreground;
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
      modelCalls++;
      if (message.stopReason === 'error')
        modelErrors.push(String(message.errorMessage ?? 'model error'));
      tokens += message.usage?.totalTokens ?? 0;
      if (typeof message.usage?.cost?.total === 'number') {
        cost += message.usage.cost.total;
        costKnown = true;
      }
      const lead = (message.content ?? [])
        .map((block: any) => (block.type === 'text' ? block.text : ''))
        .join('')
        .trim();
      for (const block of message.content ?? [])
        if (block.type === 'toolCall') {
          const call: ToolCall = {
            name: block.name,
            input: block.arguments,
            output: '',
            isError: false,
            at: Date.parse(entry.timestamp),
            lead,
          };
          calls.set(block.id, call);
          tools.push(call);
        }
    } else if (message.role === 'toolResult') {
      const call = calls.get(message.toolCallId);
      if (call) {
        call.output = (message.content ?? [])
          .map((block: any) => (block.type === 'text' ? block.text : `[${block.type}]`))
          .join('\n');
        call.isError = message.isError === true;
      }
    }
  }
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
      'SELECT id,status,source,error,background FROM turns ORDER BY created_at, id',
    )
  ).rows;
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
  const memory = await (await fetch(new URL('/api/memory', stack.baseUrl))).text();
  const approvals = (
    await stack.pool.query('SELECT action,status,args FROM approvals ORDER BY expires_at')
  ).rows.map((row) => ({
    action: row.action as string,
    status: row.status as string,
    args: row.args,
  }));
  const profileRow = (
    await stack.pool.query('SELECT data FROM profiles LIMIT 1').catch(() => ({ rows: [] as any[] }))
  ).rows[0]?.data as { name?: string; location?: string; preferences?: string } | undefined;
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
  const run: Run = {
    task: options.task,
    messages,
    replies,
    final: replies.at(-1) ?? '',
    said: replies.join('\n\n'),
    tools,
    turns,
    interactions: session.interactions,
    userMessages: session.userMessages,
    writes: world.apps?.writes ?? [],
    files,
    schedules,
    scheduleRuns,
    memory,
    modelErrors,
    approvals,
    profile: profileRow
      ? {
          name: profileRow.name ?? '',
          location: profileRow.location ?? '',
          preferences: profileRow.preferences ?? '',
        }
      : undefined,
    visits: options.visits,
    usage: { tokens, modelCalls, costUsd: costKnown ? cost : null },
    firstReplySeconds,
    acknowledgement: { turnsWithTools, acknowledged },
    seconds: options.seconds,
    world,
    apps: world.apps,
    read: (path) => session.workspace.read(filePath(path)),
    async text(path) {
      return (await session.workspace.read(filePath(path)))?.toString('utf8') ?? '';
    },
    transcript(limit = 60_000) {
      const build = (outputCap: number) => {
        const issued = new Map<string, number[]>();
        for (const call of tools) {
          const times = issued.get(call.lead) ?? [];
          if (call.lead && times.at(-1) !== call.at) issued.set(call.lead, [...times, call.at]);
        }
        return [
          ...messages
            .filter((m) => m.text.trim())
            .map((m) => {
              const issuedAt =
                m.role === 'assistant' ? issued.get(m.text.trim())?.shift() : undefined;
              return {
                at: issuedAt === undefined ? m.at : Math.min(m.at, issuedAt - 1),
                text: `${m.role === 'user' ? 'USER' : 'ASSISTANT'}: ${m.text}`,
              };
            }),
          ...tools.map((call) => ({
            at: call.at,
            text: `TOOL ${call.name}${call.isError ? ' (error)' : ''}\n  input: ${clip(JSON.stringify(call.input), 1200)}\n  output: ${clip(call.output, outputCap)}`,
          })),
        ]
          .sort((a, b) => a.at - b.at)
          .map((item) => item.text)
          .join('\n\n');
      };
      for (const cap of [6000, 3000, 1500]) {
        const text = build(cap);
        if (text.length <= limit) return text;
      }
      return clip(build(800), limit);
    },
    groundTruth() {
      const failedTurns = turns.filter((turn) => turn.status !== 'succeeded');
      return [
        `Tool calls: ${tools.length} (${tools.filter((call) => call.isError).length} returned an error).`,
        `Assistant messages shown to the user: ${replies.length}.`,
        `Questions the assistant asked the user: ${session.interactions.filter((i) => i.kind === 'question').length}. Follow-up questions asked in chat that the simulated user answered afterwards: ${session.interactions.filter((i) => i.kind === 'chat').length}.`,
        `Changes made in connected apps: ${
          run.writes.length ? run.writes.map((w) => `${w.kind} via ${w.slug}`).join('; ') : 'none'
        }.`,
        `Workspace files: ${files.length ? files.join(', ') : 'none'}.`,
        `Actions the user approved or declined (the server runs these itself, so they never appear as tool calls): ${approvals.length ? approvals.map((item) => `${item.action} ${item.status} ${JSON.stringify(item.args).slice(0, 220)}`).join('; ') : 'none'}.`,
        `Saved profile: ${profileRow ? `name "${profileRow.name ?? ''}", location "${profileRow.location ?? ''}", preferences "${String(profileRow.preferences ?? '').slice(0, 300)}"` : 'none'}. Saved memory: ${memory.slice(0, 700)}`,
        failedTurns.length
          ? `Turns that did not succeed: ${failedTurns.map((turn) => `${turn.status}${turn.error ? ` (${turn.error})` : ''}`).join('; ')}.`
          : 'Every turn finished.',
      ].join('\n');
    },
  };
  return run;
}
