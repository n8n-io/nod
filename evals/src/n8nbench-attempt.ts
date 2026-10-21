import { randomUUID } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { createSession } from './session.ts';
import { prepare } from './setup.ts';
import {
  appSource,
  approvalOrder,
  loadEnvironment,
  parseModel,
  startStack,
  type Stack,
} from './stack.ts';
import { createApps } from './world/apps.ts';
import { routeFixtureHosts } from './world/fixture-fetch.ts';
import { mainWorkflow, type BenchCase, type BenchRun, type ToolCall } from './n8nbench-data.ts';

export interface N8nBenchSpec {
  item: BenchCase;
  iteration: number;
  model: string;
  outFile: string;
  sidecar: string;
  n8nUrl: string;
  minutes: number;
  frame: string;
}

export const benchHost = 'n8n.otto-bench.example';
const load = <T>(path: string) => import(pathToFileURL(join(appSource, path)).href) as Promise<T>;
const clip = (value: unknown, size: number) => {
  const text = typeof value === 'string' ? value : JSON.stringify(value ?? null);
  return text.length > size ? `${text.slice(0, size)}…` : text;
};

const argsOf = (input: unknown): Record<string, unknown> => {
  const text = JSON.stringify(input ?? {});
  if (input && typeof input === 'object' && !Array.isArray(input) && text.length <= 3000)
    return input as Record<string, unknown>;
  return { preview: clip(text, 3000) };
};

let terminate: (() => Promise<void>) | undefined;

export async function sidecar<T>(base: string, path: string, body: unknown): Promise<T> {
  const response = await fetch(`${base}${path}`, { method: 'POST', body: JSON.stringify(body) });
  const text = await response.text();
  if (!response.ok) throw new Error(`The n8n sidecar ${path} failed: ${text.slice(0, 400)}`);
  return JSON.parse(text) as T;
}

async function connect(stack: Stack, token: string) {
  const official = await stack.request('/api/apps/n8n/connect', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ returnTo: 'apps', instanceUrl: `https://${benchHost}`, token }),
  });
  if (official.ok) return;
  const { ownerId } =
    await load<typeof import('../../src/server/config.ts')>('src/server/config.ts');
  const id = randomUUID();
  await stack.pool.query(
    `INSERT INTO discovered_connection_proposals (id,owner_id,service,name,paths)
     VALUES($1,$2,'n8n','n8n',$3)`,
    [
      id,
      ownerId,
      JSON.stringify([
        { kind: 'mcp', endpoint: `https://${benchHost}/mcp-server/http`, auth: 'bearer', id },
      ]),
    ],
  );
  const response = await stack.request(`/api/apps/discovery/${id}/complete`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ token, accountName: 'n8n' }),
  });
  if (!response.ok)
    throw new Error(
      `n8n did not connect (${response.status}): ${(await response.text()).slice(0, 300)}`,
    );
}

async function pendingConfirmation(stack: Stack, threadId: string) {
  const { rows } = await stack.pool.query(
    `SELECT a.confirmation_message_id FROM approvals a JOIN turns t ON t.id=a.turn_id
     WHERE t.thread_id=$1 AND a.status='pending' AND a.confirmation_message_id IS NOT NULL
     ORDER BY a.${await approvalOrder(stack.pool)} DESC LIMIT 1`,
    [threadId],
  );
  return rows[0]?.confirmation_message_id as string | undefined;
}

function toolCalls(stack: Stack): ToolCall[] {
  const ends = new Map<
    string,
    Extract<(typeof stack.observations)[number]['event'], { type: 'tool_end' }>
  >();
  for (const { event } of stack.observations)
    if (event.type === 'tool_end') ends.set(`${event.execution?.runId ?? ''}:${event.id}`, event);
  const calls: ToolCall[] = [];
  for (const { event } of stack.observations) {
    if (event.type !== 'tool_start') continue;
    const end = ends.get(`${event.execution?.runId ?? ''}:${event.id}`);
    const input = event.input as { action?: string; args?: { tool?: string; input?: unknown } };
    const mcp = event.name === 'apps' && input?.action === 'CONNECTED_MCP_CALL';
    calls.push({
      name: event.name,
      ...(mcp && input.args?.tool ? { tool: input.args.tool } : {}),
      input: mcp ? input.args?.input : event.input,
      ...(end?.output !== undefined ? { output: clip(end.output, 4000) } : {}),
      ...(end?.error ? { error: clip(end.error, 2000) } : {}),
      status: end?.status ?? 'unfinished',
      at: Date.parse(event.startedAt),
    });
  }
  return calls.sort((a, b) => a.at - b.at);
}

function transcriptOf(messages: BenchRun['messages'], tools: ToolCall[]) {
  const turns: Array<{ userMessage: string; steps: unknown[] }> = [];
  const users = messages.filter((message) => message.role === 'user');
  users.forEach((user, index) => {
    const end = users[index + 1]?.at ?? Infinity;
    const inWindow = <T extends { at: number }>(item: T) => item.at >= user.at && item.at < end;
    const steps = [
      ...messages
        .filter((message) => message.role === 'assistant' && inWindow(message))
        .map((message) => ({ at: message.at, step: { kind: 'agent-text', text: message.text } })),
      ...tools.filter(inWindow).map((call) => ({
        at: call.at,
        step: {
          kind: 'tool-call',
          toolName:
            call.tool ??
            (call.name === 'apps'
              ? `apps.${(call.input as { action?: string } | undefined)?.action}`
              : call.name),
          args: argsOf(call.input),
          ...(call.error ? { error: call.error } : { result: clip(call.output, 1500) }),
        },
      })),
    ]
      .sort((a, b) => a.at - b.at)
      .map((item) => item.step);
    turns.push({ userMessage: user.text, steps });
  });
  return turns;
}

async function run(spec: N8nBenchSpec): Promise<BenchRun> {
  const started = Date.now();
  const deadline = started + spec.minutes * 60_000;
  const conversationId = `${spec.item.slug}:${spec.iteration}:${randomUUID()}`;
  const environment = await loadEnvironment();
  const model = parseModel(spec.model, environment);
  const result: BenchRun = {
    slug: spec.item.slug,
    iteration: spec.iteration,
    workflowIds: [],
    messages: [],
    tools: [],
    transcript: [],
    costUsd: 0,
    tokens: 0,
    seconds: 0,
    turns: 0,
    failedTurns: [],
  };
  const member = await sidecar<{ userId: string; mcpApiKey: string }>(spec.sidecar, '/provision', {
    credentials: spec.item.definition.credentials ?? [],
  });
  result.userId = member.userId;
  const unroute = routeFixtureHosts([benchHost], spec.n8nUrl);
  let stack: Stack | undefined;
  terminate = async () => {
    await stack?.stop().catch(() => {});
    unroute();
  };
  try {
    stack = await startStack({
      model,
      integrations: createApps({ name: 'Alex Rivera', email: 'alex.rivera@example.com' }, {})
        .provider,
      siteHosts: [],
      siteUpstreamPort: 9,
      hermetic: true,
      environment,
    });
    await prepare(stack, {}, 'UTC');
    await connect(stack, member.mcpApiKey);
    const threadId = (await (await stack.request('/api/state')).json()).threadId as string;
    const session = createSession({ stack, user: { approve: false }, deadline, stallSeconds: 900 });
    const { conversation, messageBudget } = spec.item.definition;
    await sidecar(spec.sidecar, '/proxy/start', {
      id: conversationId,
      conversation,
      ...(messageBudget ? { messageBudget } : {}),
    });
    let text = `${spec.frame}${conversation[0].text}`;
    for (;;) {
      const sentAt = new Date();
      const replyTo = await pendingConfirmation(stack, threadId);
      const response = await stack.request('/api/messages', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ text, ...(replyTo ? { replyToMessageId: replyTo } : {}) }),
      });
      if (!response.ok)
        throw new Error(
          `Sending failed (${response.status}): ${(await response.text()).slice(0, 300)}`,
        );
      result.messages.push({ role: 'user', text, at: sentAt.getTime() });
      await session.settle();
      const { rows } = await stack.pool.query(
        `SELECT text,created_at FROM messages WHERE thread_id=$1 AND role='assistant' AND created_at>=$2
         AND length(trim(text))>0 ORDER BY created_at,id`,
        [threadId, sentAt],
      );
      const replies = rows.map((row) => ({
        role: 'assistant' as const,
        text: row.text as string,
        at: (row.created_at as Date).getTime(),
      }));
      result.messages.push(...replies);
      const decision = await sidecar<{ kind: string; message?: string }>(
        spec.sidecar,
        '/proxy/decide',
        { id: conversationId, assistantText: replies.map((reply) => reply.text).join('\n\n') },
      );
      if (decision.kind !== 'followUp' || !decision.message) break;
      text = decision.message;
    }
  } catch (failure) {
    result.error = failure instanceof Error ? failure.message : String(failure);
  }
  try {
    if (stack) {
      result.tools = toolCalls(stack);
      result.transcript = transcriptOf(result.messages, result.tools);
      const usage = await stack.pool.query(
        `SELECT coalesce(sum(cost_usd),0)::float AS cost,
         coalesce(sum(coalesce((details->>'inputTokens')::bigint,0)+coalesce((details->>'outputTokens')::bigint,0)+coalesce((details->>'cacheReadTokens')::bigint,0)+coalesce((details->>'cacheWriteTokens')::bigint,0)),0)::float AS tokens
         FROM model_usage`,
      );
      result.costUsd = usage.rows[0].cost;
      result.tokens = usage.rows[0].tokens;
      const turns = await stack.pool.query('SELECT status,error FROM turns');
      result.turns = turns.rowCount ?? 0;
      result.failedTurns = turns.rows
        .filter((row) => !['succeeded', 'waiting'].includes(row.status))
        .map((row) => `${row.status}: ${String(row.error ?? '').slice(0, 300)}`);
    }
    const workflows = await sidecar<
      Array<{ id: string; createdAt?: string; nodes?: unknown[]; settings?: unknown }>
    >(spec.sidecar, '/workflows', { userId: member.userId });
    result.workflowIds = workflows.map((workflow) => workflow.id);
    result.workflowId = mainWorkflow(workflows);
  } catch (failure) {
    result.error ??= failure instanceof Error ? failure.message : String(failure);
  }
  result.seconds = Math.round((Date.now() - started) / 1000);
  return result;
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  const spec = JSON.parse(await readFile(process.argv[2], 'utf8')) as N8nBenchSpec;
  const stop = async () => {
    await terminate?.();
    process.exit(1);
  };
  process.on('SIGTERM', stop);
  process.on('SIGINT', stop);
  const result = await run(spec);
  await terminate?.();
  await mkdir(dirname(spec.outFile), { recursive: true });
  await writeFile(spec.outFile, JSON.stringify(result, null, 2));
  process.exit(0);
}
