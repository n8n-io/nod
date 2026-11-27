import { spawn, type ChildProcess } from 'node:child_process';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createInterface } from 'node:readline';
import { fileURLToPath } from 'node:url';
import pg from 'pg';

type Part = { type: string; text?: string; name?: string; arguments?: Record<string, unknown> };
type Entry = { role: string; content: string | Part[]; stopReason?: string };
type OwnerRequest = { id: string; text: string };

export type NodMessage = {
  id: string;
  role: 'user' | 'assistant';
  text: string;
  turnId: string | null;
  reactions?: Array<{ actor: string; reaction: string }>;
};
export type NodTask = { id: string; status: string; title: string };
export type NodState = {
  threadId: string;
  messages: NodMessage[];
  tasks: NodTask[];
  bots: Array<{ id: string; name: string; job: string; status: string }>;
  turns: Array<{ id: string; status: string; error: string | null }>;
};

const self = fileURLToPath(import.meta.url);
const ownerId = 'local-development';

const gate = (directory: string, text: string) =>
  join(directory, 'gates', createHash('sha256').update(text).digest('hex').slice(0, 24));

const textOf = (entry: Entry) =>
  typeof entry.content === 'string'
    ? entry.content
    : entry.content.map((part) => part.text ?? '').join('\n');

const requestData = (text: string) => {
  const at = text.lastIndexOf('Request data (JSON):\n');
  if (at < 0) return undefined;
  try {
    return JSON.parse(
      text.slice(at + 'Request data (JSON):\n'.length).split('\n', 1)[0]!,
    ) as Record<string, unknown>;
  } catch {
    return undefined;
  }
};

function scriptedReply(messages: Entry[]) {
  const finished = messages.findLastIndex(
    (entry) => entry.role === 'assistant' && entry.stopReason === 'stop',
  );
  const current = messages.slice(finished + 1);
  let task: { id: string } | undefined;
  let bot: { id: string; name: string } | undefined;
  let bots: Array<{ name: string }> = [];
  let note = '';
  let background = false;
  const pending: OwnerRequest[] = [];
  for (const entry of current) {
    if (entry.role !== 'user') continue;
    const data = requestData(textOf(entry));
    const text = data?.currentInstruction;
    const id = data?.messageId ?? data?.currentMessageId;
    if (data?.task && typeof data.task === 'object') task = data.task as { id: string };
    if (data?.bot && typeof data.bot === 'object') bot = data.bot as { id: string; name: string };
    if (Array.isArray(data?.bots)) bots = data.bots as Array<{ name: string }>;
    note = /Yours is (team\/[\w-]+\.md)/.exec(textOf(entry))?.[1] ?? note;
    if (data?.mode === 'background') background = true;
    if (typeof text === 'string') pending.push({ id: typeof id === 'string' ? id : '', text });
  }
  const calls = current.flatMap((entry) =>
    entry.role === 'assistant' && Array.isArray(entry.content)
      ? entry.content
          .filter((part) => part.type === 'toolCall')
          .map((part) => JSON.stringify(part.arguments ?? {}))
      : [],
  );
  const tool = (name: string, args: Record<string, unknown>) => ({
    name: 'codemode',
    arguments: { code: `await tools.${name}(${JSON.stringify(args)});` },
  });
  const said = pending.map((request) => request.text).join(' / ');
  const usedBotTool = calls.some((call) => call.includes('tools.bot('));
  if (bot && !task && !background && !said.startsWith('task:')) {
    const steer = /^steer: ([0-9a-f-]{36})$/.exec(said);
    if (steer)
      return calls.some((call) => call.includes('\\"reply\\"'))
        ? {
            text: `Steer: ${current
              .filter((entry) => entry.role === 'toolResult')
              .map(textOf)
              .join(' ')}`,
          }
        : { call: tool('task', { action: 'reply', ids: [steer[1]] }) };
    const direct = /^call: (\w+) (\{.*\})$/.exec(said);
    if (direct)
      return calls.some((call) => call.includes(`tools.${direct[1]}(`))
        ? {
            text: `Result: ${current
              .filter((entry) => entry.role === 'toolResult')
              .map(textOf)
              .join(' ')}`,
          }
        : {
            call: {
              name: 'codemode',
              arguments: {
                code: `try { console.log(JSON.stringify(await tools.${direct[1]}(${direct[2]}))); } catch (error) { console.log(String(error?.message ?? error)); }`,
              },
            },
          };
    const rename = /^rename yourself: (.+)$/.exec(said);
    if (rename && !usedBotTool)
      return { call: tool('bot', { action: 'update', id: bot.id, name: rename[1] }) };
    const schedule = /^schedule: (.+)$/.exec(said);
    if (schedule)
      return calls.some((call) => call.includes('schedule_create'))
        ? { text: `Scheduled ${schedule[1]}` }
        : {
            call: tool('nod', {
              action: 'schedule_create',
              args: {
                title: schedule[1],
                prompt: schedule[1],
                kind: 'once',
                runAt: new Date(Date.now() + 2_000).toISOString(),
                timeZone: 'UTC',
              },
            }),
          };
    return {
      hold: said.startsWith('hold:') ? said : undefined,
      text: `${bot.name}: ${said} | note ${note} | bots ${bots.map(({ name }) => name).join(',')}`,
    };
  }
  const make = /^make bot: (\w+) \| (.+)$/.exec(said);
  if (make)
    return usedBotTool
      ? { text: `Made ${make[1]} | note ${note}` }
      : {
          call: tool('bot', {
            action: 'create',
            name: make[1],
            job: make[2],
            model: { connectionId: randomUUID(), modelId: 'scripted', effort: 'medium' },
          }),
        };
  if (task) {
    const instruction = pending.map((request) => request.text).join(' / ');
    if (instruction.includes('pause-all') && !calls.some((call) => call.includes('schedule_pause')))
      return {
        call: {
          name: 'codemode',
          arguments: {
            code: `const ids = new Set();
const walk = (node) => {
  if (typeof node === 'string') {
    const start = node.search(/[[{]/);
    const end = Math.max(node.lastIndexOf(']'), node.lastIndexOf('}'));
    if (start >= 0 && end > start) {
      try { walk(JSON.parse(node.slice(start, end + 1))); } catch {}
    }
  } else if (Array.isArray(node)) node.forEach(walk);
  else if (node && typeof node === 'object') {
    if (typeof node.id === 'string' && String(node.title).startsWith('Synthetic')) ids.add(node.id);
    Object.values(node).forEach(walk);
  }
};
walk(await tools.nod({ action: 'schedule_list', args: {} }));
for (const id of ids) await tools.nod({ action: 'schedule_pause', args: { id } });`,
          },
        },
      };
    if (!calls.some((call) => call.includes('\\"action\\":\\"finish\\"')))
      return {
        hold: pending.find((request) => request.text.includes('hold:'))?.text,
        call: tool('task', {
          action: 'finish',
          id: task.id,
          status: 'done',
          result: `Done: ${instruction}`,
        }),
      };
    return { text: `Done: ${instruction}` };
  }
  if (background)
    return calls.some((call) => call.includes('send_message'))
      ? { text: '' }
      : {
          call: tool('send_message', {
            text: pending.map((request) => `Answer: ${request.text}`).join('\n'),
            intent: 'final',
          }),
        };
  const unacknowledged = pending.find(
    (request) =>
      request.id &&
      !calls.some((call) => call.includes('react_to_message') && call.includes(request.id)),
  );
  if (unacknowledged)
    return {
      hold: unacknowledged.text.startsWith('hold:') ? unacknowledged.text : undefined,
      call: tool('react_to_message', { messageId: unacknowledged.id, reaction: '👍' }),
    };
  const unstarted = pending.find(
    (request) =>
      request.text.startsWith('task:') &&
      !calls.some((call) => call.includes('\\"start\\"') && call.includes(request.id)),
  );
  if (unstarted)
    return {
      call: tool('task', {
        action: 'start',
        title: unstarted.text.slice(5).trim(),
        message: `Starting ${unstarted.text.slice(5).trim()}.`,
        doneWhen: 'The scripted work is done',
        now: 'Working',
        request: unstarted.id,
      }),
    };
  const answers = pending
    .filter((request) => !request.text.startsWith('task:'))
    .map((request) => `Answer: ${request.text}`);
  return {
    hold: pending.find(
      (request) => request.text.startsWith('task:') && request.text.includes('linger:'),
    )?.text,
    text: answers.join('\n'),
  };
}

async function waitForGate(path: string, signal?: AbortSignal) {
  while (!existsSync(path)) {
    if (signal?.aborted) return false;
    await new Promise((done) => setTimeout(done, 50));
  }
  return true;
}

async function serve() {
  const directory = process.env.NOD_E2E_DIRECTORY!;
  const port = Number(process.env.PORT);
  process.env.NOD_DATA_ROOT = join(directory, '.local');
  process.env.NOD_PUBLIC_URL = `http://localhost:${port}`;
  process.env.NOD_ANALYTICS_ENABLED = 'false';
  const [
    { createApplication },
    { createPiAgent },
    { createAgentSession },
    { createAssistantMessageEventStream },
    { fauxAssistantMessage, fauxToolCall },
    { createIntegrationFixture },
    { accessKey },
    { fakeComputer, fakeWorkspace },
    { createModelTraces },
    { capturePiModelCall },
  ] = await Promise.all([
    import('../src/server/composition.ts'),
    import('../src/providers/pi/index.ts'),
    import('@earendil-works/pi-coding-agent'),
    import('@earendil-works/pi-ai'),
    import('@earendil-works/pi-ai/providers/faux'),
    import('../scripts/e2e-fixtures.ts'),
    import('../src/server/access.ts'),
    import('./runtime-fixtures.ts'),
    import('../src/server/traces.ts'),
    import('../src/providers/pi/traces.ts'),
  ]);
  const workspacePath = join(directory, 'workspace');
  await mkdir(workspacePath, { recursive: true });
  const key = randomBytes(32);
  const unavailable = async () => {
    throw new Error('Speech is not part of the scripted harness.');
  };
  const integration = createIntegrationFixture(`http://localhost:${port}`, () => {});
  const checker = {
    id: 'scripted-checker',
    configured: true,
    async curate(request: { task: string; input: object }) {
      const input = request.input as {
        action?: { name?: string };
        userMessages?: Array<{ text: string; canAuthorize?: boolean }>;
      };
      if (request.task !== 'review' || !input.action) return undefined;
      const said = input.userMessages ?? [];
      const asks = {
        NOD_schedule_pause: /^pause my synthetic/i,
        NOD_bot_create: /^make bot:/i,
        NOD_bot_update: /^rename yourself:/i,
        NOD_schedule_create: /^schedule:/i,
      }[input.action.name ?? ''];
      const index = asks
        ? said.findLastIndex((message) => message.canAuthorize !== false && asks.test(message.text))
        : -1;
      return index >= 0
        ? { run: true, source: `message:${index}`, because: said[index]!.text, terms: [] }
        : { run: false };
    },
  };
  const traces = createModelTraces();
  const application = await createApplication(
    {
      traces,
      agent: createPiAgent({
        traces,
        provider: 'openai',
        apiKey: 'scripted',
        sessionRoot: join(directory, '.local', 'sessions'),
        createSession: async (options) => {
          const result = await createAgentSession(options);
          result.session.agent.streamFunction = (model, request, streamOptions) => {
            const startedAt = new Date().toISOString();
            const stream = createAssistantMessageEventStream();
            void (async () => {
              const next = scriptedReply(request.messages as Entry[]);
              const signal = (streamOptions as { signal?: AbortSignal } | undefined)?.signal;
              if (next.hold && !(await waitForGate(gate(directory, next.hold), signal))) {
                const aborted = fauxAssistantMessage('', { stopReason: 'aborted' });
                stream.push({ type: 'error', reason: 'aborted', error: aborted });
                return;
              }
              const message = next.call
                ? fauxAssistantMessage([fauxToolCall(next.call.name, next.call.arguments)], {
                    stopReason: 'toolUse',
                  })
                : fauxAssistantMessage(next.text!, { stopReason: 'stop' });
              capturePiModelCall(
                traces,
                { model, context: request, message, startedAt },
                { source: 'agent' },
              );
              stream.push({ type: 'start', partial: message });
              stream.push({
                type: 'done',
                reason: next.call ? 'toolUse' : 'stop',
                message,
              });
            })();
            return stream;
          };
          return result;
        },
      }),
      computer: fakeComputer(),
      workspace: fakeWorkspace({
        open: () => ({
          path: workspacePath,
          instructions: 'Scripted workspace.',
          exec: async () => ({ exitCode: 0 }),
        }),
      }),
      integrations: integration.provider,
      speech: { id: 'disabled', configured: false, synthesize: unavailable },
      keyStore: { id: 'scripted', configured: true, getKey: async () => key },
      model: { provider: 'openai', name: 'scripted', configured: true },
      ...(process.env.NOD_E2E_CHECKER === '1' ? { onboardingCurator: checker } : {}),
    },
    { heartbeat: false },
  );
  await application.app.listen({ host: '127.0.0.1', port });
  console.log(JSON.stringify({ ready: true, key: await accessKey(process.env.NOD_DATA_ROOT) }));
}

async function freePort() {
  const probe = createServer();
  await new Promise<void>((done) => probe.listen(0, '127.0.0.1', done));
  const { port } = probe.address() as { port: number };
  await new Promise((done) => probe.close(done));
  return port;
}

export async function startNod(options: { checker?: boolean; nodeEnv?: string } = {}) {
  const base = new URL(process.env.TEST_DATABASE_URL!);
  const suffix = randomUUID().replaceAll('-', '').slice(0, 16);
  const schema = `e2e_${suffix}`;
  const bossSchema = `e2e_boss_${suffix}`;
  const admin = new pg.Pool({ connectionString: base.href, max: 2 });
  await admin.query(`CREATE SCHEMA ${schema}`);
  const database = new URL(base);
  database.searchParams.set('options', `-c search_path=${schema}`);
  const pool = new pg.Pool({ connectionString: database.href, max: 3 });
  const directory = await realpath(await mkdtemp(join(tmpdir(), 'nod-e2e-')));
  await mkdir(join(directory, 'gates'), { recursive: true });
  const port = await freePort();
  const url = `http://localhost:${port}`;
  let child: ChildProcess | undefined;
  let key = '';
  const output: string[] = [];

  async function boot() {
    child = spawn(process.execPath, ['--import', import.meta.resolve('tsx'), self], {
      cwd: directory,
      env: {
        PATH: process.env.PATH,
        HOME: directory,
        TMPDIR: tmpdir(),
        NOD_E2E_SERVE: '1',
        NOD_E2E_DIRECTORY: directory,
        DATABASE_URL: database.href,
        PGBOSS_SCHEMA: bossSchema,
        PORT: String(port),
        NODE_ENV: options.nodeEnv ?? 'test',
        ...(options.checker ? { NOD_E2E_CHECKER: '1' } : {}),
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    child.stderr!.on('data', (chunk) => output.push(String(chunk)));
    const lines = createInterface({ input: child.stdout! });
    key = await new Promise<string>((resolve, reject) => {
      child!.once('exit', (code) =>
        reject(new Error(`Nod exited with ${code} before it was ready:\n${output.join('')}`)),
      );
      lines.on('line', (line) => {
        output.push(line);
        try {
          const value = JSON.parse(line) as { ready?: boolean; key?: string };
          if (value.ready && value.key) resolve(value.key);
        } catch {}
      });
    });
  }

  async function call<T>(method: string, path: string, body?: unknown): Promise<T> {
    const response = await fetch(url + path, {
      method,
      headers: {
        cookie: `nod-access-${port}=${key}`,
        origin: url,
        ...(body === undefined ? {} : { 'content-type': 'application/json' }),
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const text = await response.text();
    if (!response.ok) throw new Error(`${method} ${path} failed with ${response.status}: ${text}`);
    return (text ? JSON.parse(text) : undefined) as T;
  }

  const state = () => call<NodState>('GET', '/api/state');
  const query = async <T extends pg.QueryResultRow>(sql: string, values: unknown[] = []) =>
    (await pool.query<T>(sql, values)).rows;

  async function close() {
    if (child && child.exitCode === null && child.signalCode === null) {
      const exited = new Promise((done) => child!.once('exit', done));
      child.kill('SIGTERM');
      await exited;
    }
    await pool.end();
    await admin.query(`DROP SCHEMA IF EXISTS ${bossSchema} CASCADE`);
    await admin.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);
    await admin.end();
    if (!process.env.NOD_E2E_KEEP) await rm(directory, { recursive: true, force: true });
  }

  try {
    await boot();
    await call('PATCH', '/api/account', { onboardingCompleted: true });
  } catch (error) {
    await close().catch(() => {});
    throw error;
  }

  const nod = {
    url,
    api: call,
    query,
    state,
    async send(text: string, options: { replyTo?: string; botId?: string } = {}) {
      const { threadId } = await state();
      return call<{ turnId: string; messageId: string }>('POST', '/api/messages', {
        text,
        threadId,
        clientMessageId: randomUUID(),
        ...(options.replyTo ? { replyToMessageId: options.replyTo } : {}),
        ...(options.botId ? { botId: options.botId } : {}),
      });
    },
    async release(text: string) {
      await writeFile(gate(directory, text), '');
    },
    async running(text: string) {
      await nod.until(
        async () =>
          (
            await query(
              "SELECT 1 FROM turns u JOIN messages m ON m.id=u.message_id OR m.turn_id=u.id WHERE u.status='running' AND m.text=$1",
              [text],
            )
          ).length > 0,
      );
    },
    async until(ready: () => Promise<boolean>, seconds = 30) {
      const deadline = Date.now() + seconds * 1000;
      while (!(await ready())) {
        if (Date.now() > deadline) throw new Error(`Timed out after ${seconds} s.`);
        await new Promise((done) => setTimeout(done, 100));
      }
    },
    async settle(seconds = 30) {
      await nod.until(
        async () =>
          (await query("SELECT 1 FROM turns WHERE status IN ('queued','running') LIMIT 1"))
            .length === 0,
        seconds,
      );
    },
    stopAll: () => call('POST', '/api/thread/stop', {}),
    stopBot: (botId: string) => call('POST', '/api/thread/stop', { botId }),
    stopTask: (id: string) => call('POST', `/api/tasks/${id}/stop`, {}),
    async crash() {
      const exited = new Promise((done) => child!.once('exit', done));
      child!.kill('SIGKILL');
      await exited;
    },
    async restart() {
      await boot();
    },
    close,
    directory,
    async violations(expected: { failed?: number } = {}) {
      const problems: string[] = [];
      const stuck = await query<{ id: string; status: string }>(
        "SELECT id,status FROM turns WHERE status IN ('queued','running')",
      );
      if (stuck.length) problems.push(`${stuck.length} turns are still ${stuck[0]!.status}`);
      const open = await query<{ title: string }>("SELECT title FROM tasks WHERE state='open'");
      for (const task of open) problems.push(`task "${task.title}" is still open`);
      const failed = await query<{ id: string; error: string }>(
        "SELECT id,error FROM turns WHERE status='failed'",
      );
      if (failed.length !== (expected.failed ?? 0))
        problems.push(
          `${failed.length} turns failed: ${failed.map((row) => row.error).join('; ')}`,
        );
      const unbound = await query<{ title: string; source: string; prompt: string }>(
        `SELECT t.title,m.text AS source,u.prompt FROM tasks t
         JOIN messages m ON m.id=t.source_message_id
         JOIN LATERAL (SELECT prompt FROM turns WHERE task_id=t.id AND source='task' ORDER BY created_at LIMIT 1) u ON true
         WHERE u.prompt<>m.text OR m.text NOT LIKE '%' || t.title || '%'`,
      );
      for (const task of unbound)
        problems.push(`task "${task.title}" started from "${task.prompt}" for "${task.source}"`);
      const unanswered = await query<{ text: string }>(
        `SELECT m.text FROM messages m WHERE m.role='user' AND m.owner_id=$1 AND m.hidden_at IS NULL
           AND m.assistant_reaction IS NULL
           AND NOT EXISTS (SELECT 1 FROM tasks t WHERE t.source_message_id=m.id)
           AND NOT EXISTS (SELECT 1 FROM turns u WHERE (u.message_id=m.id OR u.id=m.turn_id)
             AND EXISTS (SELECT 1 FROM messages a WHERE a.turn_id=u.id AND a.role='assistant'))`,
        [ownerId],
      );
      for (const message of unanswered) problems.push(`no answer to "${message.text}"`);
      const repeated = await query<{ message_id: string; count: number }>(
        `SELECT message_id,count(*)::int AS count FROM turns
         WHERE message_id IS NOT NULL AND source='user' GROUP BY message_id HAVING count(*)>1`,
      );
      if (repeated.length) problems.push(`${repeated.length} owner messages ran more than once`);
      return problems;
    },
  };
  return nod;
}

if (process.env.NOD_E2E_SERVE === '1' && import.meta.main) await serve();
