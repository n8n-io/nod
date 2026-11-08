import { randomUUID } from 'node:crypto';
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { SessionManager } from '@earendil-works/pi-coding-agent';
import { createSession } from './session.ts';
import { prepare } from './setup.ts';
import {
  appSource,
  loadEnvironment,
  parseModel,
  startStack,
  type Model,
  type Stack,
} from './stack.ts';
import { createApps } from './world/apps.ts';
import {
  askText,
  timeline,
  parseDate,
  type HistoryMessage,
  type LongMemEvalItem,
  type QuestionRun,
  type SetupName,
  type SetupRun,
} from './longmemeval-data.ts';

export interface LongMemEvalSpec {
  item: LongMemEvalItem;
  setups: SetupName[];
  model: string;
  outFile: string;
}

const hour = 3_600_000;
const minute = 60_000;
const nilId = '00000000-0000-0000-0000-000000000000';
const recentWindow = 30;
const load = <T>(path: string) => import(pathToFileURL(join(appSource, path)).href) as Promise<T>;
const sleep = (ms: number) => new Promise((done) => setTimeout(done, ms));
const nextTick = (at: number) => {
  const tick = Math.floor(at / hour) * hour + 7 * minute;
  return tick >= at ? tick : tick + hour;
};
const watermark = (at: number) => `${new Date(at).toISOString().replace('Z', '000Z')}/${nilId}`;

let terminate: (() => Promise<void>) | undefined;

async function seed(stack: Stack, ownerId: string, threadId: string, rows: HistoryMessage[]) {
  const ids: string[] = rows.map(() => randomUUID());
  if (!rows.length) return ids;
  await stack.pool.query(
    `INSERT INTO messages (id,owner_id,role,text,thread_id,created_at)
     SELECT id,$1,role,text,$2,at FROM unnest($3::uuid[],$4::text[],$5::text[],$6::timestamptz[]) AS t(id,role,text,at)`,
    [
      ownerId,
      threadId,
      ids,
      rows.map((row) => row.role),
      rows.map((row) => row.text),
      rows.map((row) => new Date(row.at).toISOString()),
    ],
  );
  return ids;
}

async function threadOf(stack: Stack) {
  const state = (await (await stack.request('/api/state')).json()) as { threadId: string };
  return state.threadId;
}

async function spent(stack: Stack, since?: Date) {
  const { rows } = await stack.pool.query(
    `SELECT coalesce(sum(coalesce(cost_usd,(details->>'estimateUsd')::float8,0)),0)::float AS cost, count(*)::int AS calls,
            coalesce(sum(coalesce((details->>'inputTokens')::bigint,0)+coalesce((details->>'outputTokens')::bigint,0)+coalesce((details->>'cacheReadTokens')::bigint,0)+coalesce((details->>'cacheWriteTokens')::bigint,0)),0)::float AS tokens,
            count(*) FILTER (WHERE details::text LIKE '%"compaction"%')::int AS compactions,
            count(*) FILTER (WHERE details->>'status'='succeeded' AND coalesce(cost_usd,(details->>'estimateUsd')::float8,0)=0)::int AS unpriced
     FROM model_usage WHERE $1::timestamptz IS NULL OR created_at>=$1`,
    [since ?? null],
  );
  return rows[0] as {
    cost: number;
    calls: number;
    tokens: number;
    compactions: number;
    unpriced: number;
  };
}

async function ask(
  stack: Stack,
  item: LongMemEvalItem,
  setup: SetupName,
  deadline: number,
): Promise<{ run: SetupRun; prompt?: string }> {
  const started = new Date();
  const threadId = await threadOf(stack);
  const session = createSession({ stack, user: { approve: false }, deadline, stallSeconds: 1200 });
  let error: string | undefined;
  try {
    await session.say(askText(item));
  } catch (failure) {
    error = failure instanceof Error ? failure.message : String(failure);
  }
  const replies = await stack.pool.query(
    `SELECT m.text FROM messages m WHERE m.thread_id=$1 AND m.role='assistant' AND m.created_at>=$2 AND length(trim(m.text))>0 ORDER BY m.created_at,m.id`,
    [threadId, started],
  );
  const turns = new Set(
    (
      await stack.pool.query('SELECT id FROM turns WHERE thread_id=$1 AND created_at>=$2', [
        threadId,
        started,
      ])
    ).rows.map((row) => row.id as string),
  );
  const tools = stack.observations
    .filter(({ turnId, event }) => turns.has(turnId) && event.type === 'tool_start')
    .map(({ event }) => {
      const call = event as { name: string; input?: unknown };
      return { name: call.name, input: JSON.stringify(call.input ?? null).slice(0, 400) };
    });
  const usage = await spent(stack, started);
  const failures = await stack.pool.query(
    "SELECT error FROM turns WHERE thread_id=$1 AND created_at>=$2 AND status<>'succeeded'",
    [threadId, started],
  );
  const calls = await stack.pool.query(
    'SELECT details FROM model_usage WHERE created_at>=$1 ORDER BY created_at',
    [started],
  );
  const details = calls.rows.map((row) =>
    Object.fromEntries(
      Object.entries(row.details as Record<string, unknown>).filter(
        ([key, value]) => typeof value !== 'object' || value === null || key === 'error',
      ),
    ),
  );
  const first = details.find((call) => call.operation !== 'compaction');
  const run: SetupRun = {
    turnErrors: failures.rows.map((row) => String(row.error ?? 'unknown')),
    calls: details,
    ...(first ? { contextTokens: contextOf(first) } : {}),
    setup,
    reply: replies.rows.map((row) => row.text as string).join('\n\n'),
    tools,
    costUsd: usage.cost,
    unpricedCalls: usage.unpriced,
    modelCalls: usage.calls,
    tokens: usage.tokens,
    compactions: usage.compactions,
    seconds: (Date.now() - started.getTime()) / 1000,
    ...(error ? { error } : {}),
  };
  return {
    run,
    prompt: stack.prompts.find((entry) => turns.has(entry.turnId))?.instruction,
  };
}

const contextOf = (call: Record<string, unknown>) =>
  ['inputTokens', 'cacheReadTokens', 'cacheWriteTokens'].reduce(
    (sum, key) => sum + (Number(call[key]) || 0),
    0,
  );

async function countTokens(model: Model, input: Array<{ role: string; content: string }>) {
  if (model.provider !== 'openai') throw new Error('Token counting needs an OpenAI model.');
  for (let attempt = 0; ; attempt++) {
    const response = await fetch('https://api.openai.com/v1/responses/input_tokens', {
      method: 'POST',
      headers: { authorization: `Bearer ${model.apiKey}`, 'content-type': 'application/json' },
      body: JSON.stringify({ model: model.name, input }),
    });
    if (response.ok) return ((await response.json()) as { input_tokens: number }).input_tokens;
    if (attempt >= 5 || ![408, 429, 500, 502, 503, 504].includes(response.status))
      throw new Error(
        `Token counting failed (${response.status}): ${(await response.text()).slice(0, 200)}`,
      );
    await sleep(2 ** attempt * 1000);
  }
}

async function reflect(boss: { send: Function; getJobById: Function }, deadline: number) {
  const id = (await boss.send('memory-maintenance', {})) as string | null;
  if (!id) throw new Error('The memory job was not queued.');
  while (Date.now() < deadline) {
    const job = (await boss.getJobById('memory-maintenance', id)) as { state?: string } | null;
    if (job?.state === 'completed') return;
    if (job?.state === 'failed' || job?.state === 'cancelled')
      throw new Error(`The memory job ended as ${job.state}.`);
    await sleep(300);
  }
  throw new Error('The memory job did not finish before the case deadline.');
}

async function run(spec: LongMemEvalSpec): Promise<QuestionRun> {
  const { item } = spec;
  const started = Date.now();
  const deadline = started + 45 * minute;
  const environment = await loadEnvironment();
  const model = parseModel(spec.model, environment);
  const base = {
    questionId: item.question_id,
    type: item.question_type,
    abstention: item.question_id.endsWith('_abs'),
    setups: spec.setups,
  };
  let stack: Stack | undefined;
  let starting: Promise<Stack> | undefined;
  terminate = async () => {
    stack ??= await starting?.catch(() => undefined);
    await stack?.stop().catch(() => {});
  };
  try {
    const owner = { name: 'Alex Rivera', email: 'alex.rivera@riveradesign.example' };
    const apps = createApps(owner, {});
    stack = await (starting = startStack({
      model,
      integrations: apps.provider,
      siteHosts: [],
      siteUpstreamPort: 9,
      hermetic: true,
      environment,
    }));
    await prepare(stack, { apps }, 'UTC');
    const [
      { ownerId },
      { boss },
      { createMemoryService },
      { createPostgresObjectStore },
      { statusOf },
    ] = await Promise.all([
      load<typeof import('../../src/server/config.ts')>('src/server/config.ts'),
      load<typeof import('../../src/server/thread.ts')>('src/server/thread.ts'),
      load<typeof import('../../src/server/memory.ts')>('src/server/memory.ts'),
      load<typeof import('../../src/server/object-storage.ts')>('src/server/object-storage.ts'),
      load<typeof import('../../src/server/memory-tree.ts')>('src/server/memory-tree.ts'),
    ]);
    const memory = createMemoryService({
      pool: stack.pool,
      ownerId,
      store: createPostgresObjectStore({ database: stack.pool, ownerId }),
    });
    const history = timeline(item);
    const askAt = Math.max(parseDate(item.question_date), history.at(-1)!.at);
    await memory.edit((tree) => {
      tree.reflected = watermark(history[0].at - 1000);
      tree.retries = 0;
    });
    const firstThread = await threadOf(stack);
    const firstIds: string[] = [];
    let inserted = 0;
    let ticks = 0;
    for (let tick = nextTick(history[0].at + 10 * minute); tick <= askAt;) {
      let end = inserted;
      while (end < history.length && history[end].at <= tick - 10 * minute) end++;
      const fresh = history.slice(inserted, end);
      firstIds.push(...(await seed(stack, ownerId, firstThread, fresh)));
      inserted = end;
      if (fresh.some((row) => row.role === 'user')) {
        await reflect(boss, deadline);
        ticks++;
      }
      if (inserted === history.length) break;
      tick = nextTick(history[inserted].at + 10 * minute);
    }
    firstIds.push(...(await seed(stack, ownerId, firstThread, history.slice(inserted))));
    const learning = await spent(stack);
    const tree = await memory.load();
    const notes = tree.entries;
    const statusCount = (status: string) =>
      notes.filter((entry) => statusOf(entry) === status).length;
    const recent = history.slice(-recentWindow);
    const runs: SetupRun[] = [];
    const memoryAsk = spec.setups.includes('memory')
      ? await ask(stack, item, 'memory', deadline)
      : undefined;
    if (memoryAsk) runs.push(memoryAsk.run);
    if (spec.setups.includes('chat')) {
      if (runs.length) {
        await stack.request('/api/thread/stop', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: '{}',
        });
        await stack.resetConversation();
      }
      const threadId = await threadOf(stack);
      const warmStart = new Date();
      await createSession({
        stack,
        user: { approve: false },
        deadline,
        stallSeconds: 1200,
      }).say('Hi Nod.');
      const warmCalls = (
        await stack.pool.query(
          'SELECT details FROM model_usage WHERE created_at>=$1 ORDER BY created_at',
          [warmStart],
        )
      ).rows.map((row) => row.details as Record<string, unknown>);
      const warmLast = warmCalls.findLast((call) => call.operation !== 'compaction');
      if (!warmLast) throw new Error('The first chat turn recorded no model request.');
      const opening = contextOf(warmLast) + (Number(warmLast.outputTokens) || 0);
      const warmUsage = await spent(stack, warmStart);
      const ids = runs.length ? await seed(stack, ownerId, threadId, history) : firstIds;
      const [{ firstInstruction }, { currentUserTime }, { threadIdentity }] = await Promise.all([
        load<typeof import('../../src/runtime/prompt.ts')>('src/runtime/prompt.ts'),
        load<typeof import('../../src/runtime/time-context.ts')>('src/runtime/time-context.ts'),
        load<typeof import('../../src/ports/thread-identity.ts')>('src/ports/thread-identity.ts'),
      ]);
      const directory = resolve(stack.sessionRoot, threadIdentity(threadId));
      const transcript = SessionManager.continueRecent(directory, directory);
      const after = Date.now();
      const zero = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 };
      const rendered = history.map((row, index) => ({
        role: row.role,
        content:
          row.role === 'user'
            ? `${currentUserTime('UTC', new Date(row.at))}\n${firstInstruction(
                {
                  history: [],
                  channel: 'web',
                  notificationRule: '',
                  prompt: row.text,
                  attachments: [],
                  currentMessageId: ids[index],
                  tasks: [],
                } as unknown as Parameters<typeof firstInstruction>[0],
                true,
                new Set(),
              )}`
            : row.text,
      }));
      const last = history.findLastIndex((row) => row.role === 'assistant');
      const measured = opening + (await countTokens(model, rendered.slice(0, last + 1)));
      rendered.forEach((message, index) => {
        if (message.role === 'user')
          transcript.appendMessage({
            role: 'user',
            content: message.content,
            timestamp: after + index,
          });
        else {
          const tokens = index === last ? measured : 0;
          transcript.appendMessage({
            role: 'assistant',
            content: [{ type: 'text', text: message.content }],
            api: 'openai-responses',
            provider: model.provider,
            model: model.name,
            usage: {
              input: tokens,
              output: 0,
              cacheRead: 0,
              cacheWrite: 0,
              totalTokens: tokens,
              cost: zero,
            },
            stopReason: 'stop',
            timestamp: after + index,
          });
        }
      });
      const chat = await ask(stack, item, 'chat', deadline);
      runs.push({
        ...chat.run,
        costUsd: chat.run.costUsd + warmUsage.cost,
        unpricedCalls: chat.run.unpricedCalls + warmUsage.unpriced,
        modelCalls: chat.run.modelCalls + warmUsage.calls,
        historyTokens: measured,
      });
    }
    return {
      ...base,
      runs,
      learning: {
        ticks,
        costUsd: learning.cost,
        unpricedCalls: learning.unpriced,
        modelCalls: learning.calls,
        notes: notes.length,
        confirmed: statusCount('stated'),
        learned: statusCount('observed'),
        tentative: statusCount('tentative'),
        archived: tree.archive.length,
        watermark: tree.reflected ?? '',
        retries: tree.retries,
        entries: notes.map(
          (entry) => `${entry.area}/${entry.slug} [${statusOf(entry)}] ${entry.text}`,
        ),
      },
      evidenceInRecent: recent.some((row) => row.evidence),
      historyMessages: history.length,
      seconds: (Date.now() - started) / 1000,
    };
  } catch (failure) {
    return {
      ...base,
      runs: [],
      error: failure instanceof Error ? failure.message : String(failure),
      seconds: (Date.now() - started) / 1000,
    };
  } finally {
    await terminate?.();
  }
}

const specPath = process.argv[2];
if (specPath) {
  process.once(
    'SIGTERM',
    () => void (terminate?.() ?? Promise.resolve()).finally(() => process.exit(143)),
  );
  const spec = JSON.parse(await readFile(specPath, 'utf8')) as LongMemEvalSpec;
  const result = await run(spec);
  await mkdir(dirname(spec.outFile), { recursive: true });
  await writeFile(spec.outFile, JSON.stringify(result, null, 2));
  await rm(specPath, { force: true });
  process.exit(0);
}
