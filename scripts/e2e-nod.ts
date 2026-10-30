import { spawn, type ChildProcess } from 'node:child_process';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import {
  appendFile,
  chmod,
  copyFile,
  mkdir,
  mkdtemp,
  readFile,
  realpath,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import pg from 'pg';
import { parse } from 'dotenv';
import {
  createIntegrationFixture,
  fixtureLogin,
  fixtureHotel,
  fixtureFlight,
  registerOperatorPage,
  operatorAccess,
  type Audit,
  type IntegrationFixtureData,
} from './e2e-fixtures.ts';
import { runProcess } from '../src/providers/process.ts';
import { agentModels } from '../src/shared/model-defaults.ts';
import { createFixtureMessagingSetup } from './e2e-channels.ts';
import { workspaceNetwork } from './e2e-workspace.ts';
import { integrationDatabaseUrl } from './local-database.ts';
import { accessCookie, accessKey } from '../src/server/access.ts';

function profileNotes(profile: Record<string, unknown>) {
  return Object.entries(profile).flatMap(([field, value]) => {
    if (typeof value !== 'string') return [];
    const area = field === 'preferences' ? ('preferences' as const) : ('about' as const);
    const label = area === 'about' ? `${field[0]!.toUpperCase()}${field.slice(1)}: ` : '';
    const budget = 120 - label.length;
    const notes: string[] = [];
    let current = '';
    const push = (unit: string) => {
      if (current && current.length + unit.length + 1 > budget) {
        notes.push(current);
        current = '';
      }
      current = current ? `${current} ${unit}` : unit;
    };
    for (const sentence of value.split(/\n+|(?<=[.!?])\s+/)) {
      const flat = sentence.replace(/[\s\p{Cc}]+/gu, ' ').trim();
      if (flat.length <= budget) {
        if (flat) push(flat);
      } else
        for (const word of flat.split(' '))
          for (let start = 0; start < word.length; start += budget)
            push(word.slice(start, start + budget));
    }
    if (current) notes.push(current);
    return notes.map((text) => ({ area, text: label + text }));
  });
}

const repository = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const environment = {
  ...parse(await readFile(join(repository, '.env'), 'utf8').catch(() => '')),
  ...process.env,
};
const configuredPort = environment.NOD_E2E_PORT ?? '4320';
const port = Number(configuredPort);
if (!/^\d{1,5}$/.test(configuredPort) || port < 1 || port > 65_535)
  throw new Error('NOD_E2E_PORT must be an integer between 1 and 65535.');
const baseUrl = `http://localhost:${port}`;
const scenario = environment.NOD_E2E_SCENARIO;
const eventMode = environment.NOD_E2E_EVENT === 'true';
if (eventMode && !scenario) throw new Error('An inbox event needs a synthetic scenario.');
if (
  scenario &&
  ![
    'health-results-base',
    'health-results-appointment',
    'health-results-base-v2',
    'health-results-appointment-v2',
  ].includes(scenario)
)
  throw new Error('Choose an available synthetic scenario.');
const fixtureData: IntegrationFixtureData | undefined = scenario
  ? await (async () => {
      const data = JSON.parse(
        await readFile(join(repository, 'scripts', 'fixtures', `${scenario}.json`), 'utf8'),
      ) as IntegrationFixtureData;
      return {
        ...data,
        attachments: await Promise.all(
          data.attachments.map(async (file) => ({
            ...file,
            bytes: await readFile(join(repository, 'scripts', 'fixtures', file.name)),
          })),
        ),
      };
    })()
  : undefined;
const sourceFiles = fixtureData?.attachments.map(({ bytes, ...file }) => ({
  ...file,
  size: bytes.byteLength,
  sha256: createHash('sha256').update(bytes).digest('hex'),
}));
const provider = environment.LLM_PROVIDER || 'openai';
const model = environment.LLM_MODEL || agentModels[provider as keyof typeof agentModels];
const apiKey =
  provider === 'anthropic' ? environment.ANTHROPIC_API_KEY : environment.OPENAI_API_KEY;
if (!apiKey)
  throw new Error('Configure the selected real model key before starting the acceptance harness.');
const suffix = randomUUID().replaceAll('-', '').slice(0, 16);
const operatorToken = randomBytes(32).toString('base64url');
const schema = `e2e_${suffix}`;
const bossSchema = `e2e_boss_${suffix}`;
const container = `nod-workspace-e2e-${suffix}`;
const browserContainer = `nod-browser-e2e-${suffix}`;
const directory = await realpath(await mkdtemp(join(tmpdir(), 'nod-e2e-')));
const workspaceRoot = join(directory, '.local', 'workspaces');
const toolsRoot = join(directory, 'workspace-tools');
await mkdir(workspaceRoot, { recursive: true });
await mkdir(toolsRoot);
await chmod(workspaceRoot, 0o777);
await chmod(toolsRoot, 0o777);
const baseDatabase = new URL(await integrationDatabaseUrl(repository, environment));
if (!['127.0.0.1', 'localhost'].includes(baseDatabase.hostname))
  throw new Error('The harness requires a local PostgreSQL test database.');
const admin = new pg.Pool({ connectionString: baseDatabase.href, max: 2 });
await admin.query(`CREATE SCHEMA ${schema}`);
const database = new URL(baseDatabase);
database.searchParams.set('options', `-c search_path=${schema}`);
process.env.DATABASE_URL = database.href;
process.env.PGBOSS_SCHEMA = bossSchema;
process.env.PORT = String(port);
process.env.NOD_DATA_ROOT = join(directory, '.local');
const access = await accessKey(process.env.NOD_DATA_ROOT);
process.env.NOD_PUBLIC_URL = baseUrl;
process.env.NODE_ENV = 'production';
if (provider === 'anthropic') process.env.ANTHROPIC_API_KEY = apiKey;
else process.env.OPENAI_API_KEY = apiKey;
process.chdir(directory);
const logPath = join(directory, 'timings.jsonl');
await writeFile(logPath, '', { mode: 0o600 });
const timeline: Array<Record<string, unknown>> = [];
let logQueue = Promise.resolve();
const audit: Audit = (kind, fields = {}) => {
  const event = { at: new Date().toISOString(), kind, ...fields };
  timeline.push(event);
  if (timeline.length > 10_000) timeline.shift();
  logQueue = logQueue.then(() => appendFile(logPath, JSON.stringify(event) + '\n')).catch(() => {});
};
const integration = createIntegrationFixture(baseUrl, audit, {
  signup: !scenario,
  data: fixtureData,
  eventToken: eventMode ? operatorToken : undefined,
});
const signupAttempted = { base: false, alternate: false };
const signupReleased = { base: false, alternate: false };
let application:
  | Awaited<ReturnType<(typeof import('../src/server/composition.ts'))['createApplication']>>
  | undefined;
let databasePool: pg.Pool | undefined;
let browserLogs: ChildProcess | undefined;
let browserContainerStarted = false;
let poll: ReturnType<typeof setInterval> | undefined;
let containerStarted = false;
let stopping = false;
async function shutdown(exitCode = 0) {
  if (stopping) return;
  stopping = true;
  clearInterval(poll);
  await application?.app.close().catch(() => {});
  browserLogs?.kill('SIGTERM');
  if (browserContainerStarted)
    await runProcess('docker', ['rm', '-f', browserContainer]).catch(() => {});
  await databasePool?.end().catch(() => {});
  if (containerStarted) await runProcess('docker', ['rm', '-f', container]).catch(() => {});
  await admin
    .query(`DROP SCHEMA IF EXISTS ${bossSchema} CASCADE; DROP SCHEMA IF EXISTS ${schema} CASCADE`)
    .catch(() => {});
  await admin.end();
  audit('harness_stopped');
  await logQueue;
  process.exit(exitCode);
}
process.on('SIGINT', () => void shutdown());
process.on('SIGTERM', () => void shutdown());
try {
  const image = environment.NOD_E2E_WORKSPACE_IMAGE
    ? await runProcess('docker', [
        'image',
        'inspect',
        environment.NOD_E2E_WORKSPACE_IMAGE,
        '--format',
        '{{.Id}}',
      ])
    : await runProcess('docker', ['inspect', 'nod-workspace', '--format', '{{.Image}}']);
  const network = await runProcess('docker', [
    'inspect',
    'nod-workspace',
    '--format',
    '{{json .NetworkSettings.Networks}}',
  ]);
  if (image.exitCode || network.exitCode) throw new Error('Start the Nod Docker workspace first.');
  const networkName = workspaceNetwork(network.stdout);
  const started = await runProcess('docker', [
    'run',
    '-d',
    '--name',
    container,
    '--network',
    networkName,
    '--init',
    '--cap-drop',
    'ALL',
    '--security-opt',
    'no-new-privileges',
    '--pids-limit',
    '4096',
    '--memory',
    '8g',
    '--cpus',
    '4',
    '--user',
    'node',
    '--mount',
    `type=bind,source=${workspaceRoot},target=/workspace`,
    '--mount',
    `type=bind,source=${toolsRoot},target=/home/node`,
    '--tmpfs',
    '/tmp:size=268435456',
    image.stdout.trim(),
    'sleep',
    'infinity',
  ]);
  if (started.exitCode) throw new Error('Could not start the isolated workspace container.');
  containerStarted = true;
  const browserImage = await runProcess('docker', [
    'image',
    'inspect',
    'nod-eval-browser',
    '--format',
    '{{.Id}}',
  ]);
  if (browserImage.exitCode)
    throw new Error(
      'Docker image nod-eval-browser is missing. Run pnpm run eval:capability doctor --fix.',
    );
  const fixtureScripts = join(directory, 'browser-fixtures');
  await mkdir(fixtureScripts);
  const signupOperatorPath = join(fixtureScripts, 'signup-operator.json');
  await writeFile(signupOperatorPath, JSON.stringify(signupReleased), { mode: 0o644 });
  for (const name of ['e2e-browser.ts', 'e2e-fixtures.ts', 'e2e-channels.ts'])
    await copyFile(join(repository, 'scripts', name), join(fixtureScripts, name));
  const browserStarted = await runProcess('docker', [
    'run',
    '-d',
    '--name',
    browserContainer,
    '--init',
    '--cap-drop',
    'ALL',
    '--security-opt',
    'no-new-privileges',
    '--read-only',
    '--pids-limit',
    '1024',
    '--memory',
    '8g',
    '--cpus',
    '4',
    '--shm-size',
    '256m',
    '--user',
    'node',
    '--mount',
    `type=bind,source=${fixtureScripts},target=/app/scripts,readonly`,
    '--mount',
    `type=bind,source=${join(repository, 'src')},target=/app/src,readonly`,
    '--tmpfs',
    '/data:uid=1000,gid=1000,mode=700,size=536870912',
    '--tmpfs',
    '/tmp:size=268435456',
    '--tmpfs',
    '/home/node:uid=1000,gid=1000,mode=700,size=268435456',
    browserImage.stdout.trim(),
    'node',
    '--import',
    'tsx',
    '/app/scripts/e2e-browser.ts',
  ]);
  if (browserStarted.exitCode) throw new Error('Could not start the isolated browser container.');
  browserContainerStarted = true;
  let ready = false;
  for (let attempt = 0; attempt < 30; attempt++) {
    const result = await runProcess('docker', [
      'exec',
      browserContainer,
      'node',
      '-e',
      'const s=require("node:net").connect("/data/control.sock");s.on("connect",()=>{s.end();process.exit(0)});s.on("error",()=>process.exit(1))',
    ]);
    if (result.exitCode === 0) {
      ready = true;
      break;
    }
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  if (!ready) throw new Error('The isolated browser did not become ready.');
  browserLogs = spawn('docker', ['logs', '--follow', browserContainer], {
    stdio: ['ignore', 'pipe', 'ignore'],
  });
  let browserLogLine = '';
  browserLogs.stdout!.setEncoding('utf8');
  browserLogs.stdout!.on('data', (chunk: string) => {
    browserLogLine += chunk;
    if (browserLogLine.length > 65_536) {
      browserLogLine = '';
      return;
    }
    let end: number;
    while ((end = browserLogLine.indexOf('\n')) >= 0) {
      const line = browserLogLine.slice(0, end);
      browserLogLine = browserLogLine.slice(end + 1);
      try {
        const event = JSON.parse(line) as {
          kind: string;
          accepted?: boolean;
          offer?: string;
          price?: number;
          alternate?: boolean;
          sent?: boolean;
        };
        if (event.kind === 'fixture_signup_code_sent' && event.sent === true)
          integration.signupCodeSent(event.alternate === true);
        if (event.kind === 'fixture_signup_human')
          signupAttempted[event.alternate === true ? 'alternate' : 'base'] = true;
        if (
          [
            'fixture_manual_submit',
            'fixture_identifier_submit',
            'fixture_password_submit',
            'fixture_otp_submit',
            'fixture_portal_view',
            'fixture_price_view',
            'fixture_signup_identifier',
            'fixture_signup_code_sent',
            'fixture_signup_email',
            'fixture_signup_human',
            'fixture_signup_submit',
            'fixture_signup_account',
            'fixture_order',
          ].includes(event.kind)
        )
          audit(
            event.kind,
            Object.fromEntries(Object.entries(event).filter(([key]) => key !== 'kind')) as Record<
              string,
              string | number | boolean | null
            >,
          );
      } catch {}
    }
  });
  const [
    { createApplication },
    { pool },
    { createPiAgent },
    { createContainerBrowserComputer },
    { createDockerWorkspace },
    { createPublicLinkPreviewProvider },
    { events },
  ] = await Promise.all([
    import('../src/server/composition.ts'),
    import('../src/server/db.ts'),
    import('../src/providers/pi/index.ts'),
    import('../src/providers/container-browser/index.ts'),
    import('../src/providers/docker/index.ts'),
    import('../src/providers/public-web/link-preview.ts'),
    import('../src/server/events.ts'),
  ]);
  databasePool = pool;
  const vaultKey = randomBytes(32);
  const unavailable = async () => {
    throw new Error('Speech is disabled in this acceptance harness.');
  };
  application = await createApplication({
    agent: createPiAgent({
      provider,
      model,
      apiKey,
      sessionRoot: join(directory, '.local', 'sessions'),
    }),
    computer: createContainerBrowserComputer({
      dataRoot: join(directory, '.local'),
      container: browserContainer,
    }),
    workspace: createDockerWorkspace({ container, workspaceRoot }),
    integrations: integration.provider,
    messagingSetup: createFixtureMessagingSetup(),
    speech: {
      id: 'disabled',
      configured: false,
      synthesize: unavailable,
    },
    keyStore: { id: 'isolated-memory', configured: true, getKey: async () => vaultKey },
    linkPreviews: createPublicLinkPreviewProvider(),
    model: { provider, name: model, configured: true },
  });
  const { app } = application;
  if (fixtureData) {
    await application.triage.updatePreferences({ timeZone: 'Europe/Lisbon' });
    for (const note of profileNotes(fixtureData.profile ?? {})) await application.memory.add(note);
    for (const schedule of fixtureData.schedules ?? [])
      await application.personal.manage('schedule_create', schedule);
  }
  const operator = operatorAccess(operatorToken);
  integration.register(app);
  app.addContentTypeParser(
    'application/x-www-form-urlencoded',
    { parseAs: 'string', bodyLimit: 8192 },
    (_request, _body, done) => done(null, {}),
  );
  registerOperatorPage(app, operatorToken, fixtureData);
  app.get('/e2e/status', operator, async () => ({
    fixture: true,
    model: { provider, name: model },
    fixtureLogin,
    fixtureHotel,
    fixtureFlight,
    scenario: fixtureData
      ? { id: fixtureData.id, accountEmail: fixtureData.accountEmail, sourceFiles }
      : null,
    timeline,
    writes: integration.writes,
  }));
  app.get('/e2e/evidence', operator, async (_request, reply) => {
    if (!fixtureData) return reply.code(404).send({ error: 'No scenario was selected.' });
    const [messages, turns, artifacts, schedules, runs] = await Promise.all([
      pool.query(
        "SELECT id,thread_id,turn_id,role,text,attachments,created_at FROM messages WHERE owner_id='local-development' ORDER BY created_at,id",
      ),
      pool.query(
        "SELECT id,thread_id,status,source,prompt,error,created_at,started_at,finished_at FROM turns WHERE owner_id='local-development' ORDER BY created_at,id",
      ),
      pool.query(
        "SELECT id,name,mime_type,size,created_at FROM artifacts WHERE owner_id='local-development' ORDER BY created_at,id",
      ),
      pool.query(
        "SELECT id,title,prompt,kind,run_at,time_zone,enabled,next_run_at FROM schedules WHERE owner_id='local-development' ORDER BY created_at,id",
      ),
      pool.query(
        "SELECT id,schedule_id,turn_id,scheduled_for,created_at FROM schedule_runs WHERE owner_id='local-development' ORDER BY created_at,id",
      ),
    ]);
    return {
      fixture: true,
      scenario: fixtureData.id,
      sourceFiles,
      calendarEvents: fixtureData.calendarEvents,
      messages: messages.rows,
      turns: turns.rows,
      artifacts: artifacts.rows,
      schedules: schedules.rows,
      runs: runs.rows,
      writes: integration.writes,
    };
  });
  app.post('/e2e/inbox-arrival', operator, async (request, reply) => {
    if (!eventMode) return reply.code(404).send({ error: 'Inbox events are not enabled.' });
    const value = request.body as { connectionId?: unknown } | undefined;
    if (
      value?.connectionId !== undefined &&
      (typeof value.connectionId !== 'string' ||
        !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value.connectionId))
    )
      return reply.code(400).send({ error: 'Provide an owned Gmail connection ID.' });
    await application!.integrations.syncWatches();
    const rows = await pool.query<{ account_id: string }>(
      "SELECT account_id FROM app_connections WHERE owner_id='local-development' AND slug='gmail' AND provider_id='synthetic-apps' AND account_active AND NOT revoked AND triggers_enabled AND trigger_id IS NOT NULL AND ($1::uuid IS NULL OR id=$1)",
      [value?.connectionId ?? null],
    );
    if (rows.rowCount !== 1)
      return reply
        .code(409)
        .send({ error: 'Choose one connected synthetic Gmail account with updates enabled.' });
    const event = integration.releaseInbox(rows.rows[0]!.account_id);
    const response = await app.inject({
      method: 'POST',
      url: '/api/webhooks/synthetic-apps',
      headers: {
        host: new URL(baseUrl).host,
        origin: baseUrl,
        cookie: `${accessCookie(port)}=${access}`,
        'content-type': 'application/json',
        'x-fixture-signature': operatorToken,
      },
      payload: event,
    });
    return reply
      .code(response.statusCode)
      .send({ ...response.json<Record<string, unknown>>(), messageId: event.data.message_id });
  });
  app.post<{ Params: { variant: string } }>(
    '/e2e/signup/:variant',
    operator,
    async (request, reply) => {
      const variant = request.params.variant;
      if (variant !== 'base' && variant !== 'alternate')
        return reply.code(400).send({ error: 'Choose a signup case.' });
      const { activeThread } = await import('../src/server/thread.ts');
      const thread = await activeThread(pool);
      const latest = await pool.query(
        "SELECT status,waiting_reason FROM turns WHERE owner_id='local-development' AND thread_id=$1 AND NOT background ORDER BY created_at DESC,id DESC LIMIT 1",
        [thread.id],
      );
      const running = await pool.query(
        "SELECT 1 FROM turns WHERE owner_id='local-development' AND thread_id=$1 AND status='running' LIMIT 1",
        [thread.id],
      );
      if (
        !signupAttempted[variant] ||
        latest.rows[0]?.status !== 'waiting' ||
        latest.rows[0]?.waiting_reason !== 'question' ||
        running.rowCount
      )
        return reply
          .code(409)
          .send({ error: 'Wait for the agent to hand over the verification step.' });
      signupReleased[variant] = true;
      await writeFile(signupOperatorPath, JSON.stringify(signupReleased), { mode: 0o644 });
      audit('fixture_signup_operator_release', {
        alternate: variant === 'alternate',
        released: true,
      });
      return { ok: true };
    },
  );
  const expected = new Map<string, string>();
  app.post('/e2e/expected-run', operator, async (request, reply) => {
    const value = request.body as { scheduleId?: unknown; dueAt?: unknown } | undefined;
    if (
      typeof value?.scheduleId !== 'string' ||
      !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value.scheduleId) ||
      typeof value.dueAt !== 'string' ||
      !Number.isFinite(Date.parse(value.dueAt))
    )
      return reply.code(400).send({ error: 'Provide a schedule ID and an absolute ISO due time.' });
    const scheduleId = value.scheduleId.toLowerCase();
    const dueAt = new Date(value.dueAt).toISOString();
    expected.set(scheduleId, dueAt);
    audit('schedule_expected', {
      scheduleId,
      dueAt,
    });
    return { ok: true };
  });
  app.addHook('onRequest', async (request) => {
    if (request.method === 'POST' && request.url.split('?')[0] === '/api/messages')
      audit('chat_request_received', { requestId: request.id });
  });
  app.addHook('onSend', async (request, _reply, payload) => {
    if (request.method === 'POST' && request.url.split('?')[0] === '/api/browser-handoff') {
      const input = request.body as { type?: unknown } | undefined;
      audit('fixture_browser_handoff', {
        accepted: _reply.statusCode === 200,
        clicked: input?.type === 'click',
        typed: input?.type === 'type',
        scrolled: input?.type === 'scroll',
        key: input?.type === 'key',
      });
    }
    if (
      request.method === 'POST' &&
      request.url.split('?')[0] === '/api/messages' &&
      typeof payload === 'string'
    ) {
      try {
        const result = JSON.parse(payload);
        if (typeof result.turnId === 'string')
          audit('chat_request_accepted', {
            requestId: request.id,
            threadId: result.threadId,
            turnId: result.turnId,
          });
      } catch {}
    }
    return payload;
  });
  const streams = new Set<string>();
  events.on(
    'event',
    (event: {
      type?: string;
      threadId?: string;
      turnId?: string;
      streamId?: string;
      text?: string;
    }) => {
      if (event.type !== 'delta' || !event.turnId || !event.text) return;
      const key = `${event.turnId}:${event.streamId || 'default'}`;
      if (streams.has(key)) return;
      streams.add(key);
      audit('first_visible_delta', {
        threadId: event.threadId ?? '',
        turnId: event.turnId,
        streamId: event.streamId || '',
      });
    },
  );
  const states = new Map<string, string>();
  const eventIds = new Set<string>();
  const messageIds = new Set<string>();
  const jobs = new Set<string>();
  let polling = false;
  const sample = async () => {
    if (polling || stopping) return;
    polling = true;
    try {
      const turns = await pool.query(
        'SELECT id,thread_id,status,source,created_at,started_at,finished_at FROM turns ORDER BY created_at',
      );
      for (const turn of turns.rows) {
        if (states.get(turn.id) === turn.status) continue;
        states.set(turn.id, turn.status);
        audit('turn_state', {
          threadId: turn.thread_id,
          turnId: turn.id,
          status: turn.status,
          source: turn.source,
          createdAt: turn.created_at.toISOString(),
          startedAt: turn.started_at?.toISOString() ?? null,
          finishedAt: turn.finished_at?.toISOString() ?? null,
        });
      }
      const turnEvents = await pool.query(
        'SELECT id,turn_id,type,created_at FROM turn_events ORDER BY created_at',
      );
      for (const event of turnEvents.rows) {
        if (eventIds.has(event.id)) continue;
        eventIds.add(event.id);
        audit('turn_event', {
          turnId: event.turn_id,
          type: event.type,
          createdAt: event.created_at.toISOString(),
        });
      }
      const messages = await pool.query(
        "SELECT id,thread_id,turn_id,created_at FROM messages WHERE role='assistant' ORDER BY created_at",
      );
      for (const message of messages.rows) {
        if (messageIds.has(message.id)) continue;
        messageIds.add(message.id);
        audit('assistant_message_saved', {
          threadId: message.thread_id,
          turnId: message.turn_id,
          messageId: message.id,
          createdAt: message.created_at.toISOString(),
        });
      }
      const scheduled = await pool.query(
        `SELECT id,data,start_after,started_on FROM ${bossSchema}.job WHERE name='scheduled-task' AND started_on IS NOT NULL`,
      );
      for (const job of scheduled.rows) {
        if (jobs.has(job.id)) continue;
        jobs.add(job.id);
        const dueAt = expected.get(job.data.scheduleId);
        audit('scheduled_job_started', {
          jobId: job.id,
          scheduleId: job.data.scheduleId,
          dueAt: dueAt || null,
          queuedFor: job.start_after.toISOString(),
          startedAt: job.started_on.toISOString(),
          latenessMs: dueAt ? job.started_on.getTime() - Date.parse(dueAt) : null,
        });
      }
    } catch {
      audit('timing_sample_failed');
    } finally {
      polling = false;
    }
  };
  poll = setInterval(() => void sample(), 250);
  await app.register((await import('@fastify/static')).default, {
    root: join(repository, 'dist/web'),
    index: 'index.html',
    wildcard: true,
  });
  app.setNotFoundHandler((request, reply) =>
    request.url.startsWith('/api/')
      ? reply.code(404).send({ error: 'Route not found.' })
      : reply.sendFile('index.html'),
  );
  await app.listen({ host: '127.0.0.1', port });
  const manifest = {
    baseUrl,
    operatorUrl: `${baseUrl}/e2e`,
    fixtureLogin,
    directory,
    schema,
    bossSchema,
    container,
    timings: logPath,
    model: { provider, name: model },
    scenario: fixtureData
      ? { id: fixtureData.id, accountEmail: fixtureData.accountEmail, sourceFiles }
      : null,
    eventMode,
    evidence:
      'Real app, Pi model, Chrome, Vault and thread workspace; synthetic connected apps, sign-in website and channel setup. Speech and channel delivery disabled.',
  };
  await writeFile(
    join(directory, 'manifest.json'),
    JSON.stringify(
      { ...manifest, operatorToken, accessUrl: `${baseUrl}/#access=${access}` },
      null,
      2,
    ),
    {
      mode: 0o600,
    },
  );
  audit('harness_ready');
  process.stdout.write(JSON.stringify(manifest, null, 2) + '\n');
} catch (error) {
  if (error instanceof Error && /^[A-Za-z .-]+$/.test(error.message))
    process.stderr.write(`${error.name}: ${error.message}\n`);
  process.stderr.write(
    'The isolated acceptance harness could not start. Check local Docker, PostgreSQL, build output and model configuration.\n',
  );
  await shutdown(1);
}
