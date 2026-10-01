import { spawn, type ChildProcess } from 'node:child_process';
import { randomBytes, randomUUID } from 'node:crypto';
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
  operatorPage,
  type Audit,
} from './e2e-fixtures.ts';
import { runProcess } from '../src/providers/process.ts';
import { agentModels } from '../src/shared/model-defaults.ts';
import { createFixtureMessagingSetup } from './e2e-channels.ts';
import { workspaceNetwork } from './e2e-workspace.ts';
import { integrationDatabaseUrl } from './local-database.ts';

const repository = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const environment = {
  ...parse(await readFile(join(repository, '.env'), 'utf8').catch(() => '')),
  ...process.env,
};
const configuredPort = environment.OTTO_E2E_PORT ?? '4320';
const port = Number(configuredPort);
if (!/^\d{1,5}$/.test(configuredPort) || port < 1 || port > 65_535)
  throw new Error('OTTO_E2E_PORT must be an integer between 1 and 65535.');
const baseUrl = `http://localhost:${port}`;
const provider = environment.LLM_PROVIDER || 'openai';
const model = environment.LLM_MODEL || agentModels[provider as keyof typeof agentModels];
const apiKey =
  provider === 'anthropic' ? environment.ANTHROPIC_API_KEY : environment.OPENAI_API_KEY;
if (!apiKey)
  throw new Error('Configure the selected real model key before starting the acceptance harness.');
const suffix = randomUUID().replaceAll('-', '').slice(0, 16);
const schema = `e2e_${suffix}`;
const bossSchema = `e2e_boss_${suffix}`;
const container = `otto-workspace-e2e-${suffix}`;
const browserContainer = `otto-browser-e2e-${suffix}`;
const directory = await realpath(await mkdtemp(join(tmpdir(), 'otto-e2e-')));
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
process.env.NODE_ENV = 'production';
process.env.DEV_INSPECTOR = 'true';
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
  const image = environment.OTTO_E2E_WORKSPACE_IMAGE
    ? await runProcess('docker', [
        'image',
        'inspect',
        environment.OTTO_E2E_WORKSPACE_IMAGE,
        '--format',
        '{{.Id}}',
      ])
    : await runProcess('docker', ['inspect', 'otto-workspace', '--format', '{{.Image}}']);
  const network = await runProcess('docker', [
    'inspect',
    'otto-workspace',
    '--format',
    '{{json .NetworkSettings.Networks}}',
  ]);
  if (image.exitCode || network.exitCode) throw new Error('Start the Otto Docker workspace first.');
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
    'inspect',
    'otto-browser',
    '--format',
    '{{.Image}}',
  ]);
  if (browserImage.exitCode) throw new Error('Start the Otto browser container first.');
  const fixtureScripts = join(directory, 'browser-fixtures');
  await mkdir(fixtureScripts);
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
        };
        if (
          [
            'fixture_manual_submit',
            'fixture_identifier_submit',
            'fixture_password_submit',
            'fixture_otp_submit',
            'fixture_portal_view',
            'fixture_price_view',
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
    { createOpenAIRelevanceClassifier },
    { createPublicLinkPreviewProvider },
    { events },
  ] = await Promise.all([
    import('../src/server/composition.ts'),
    import('../src/server/db.ts'),
    import('../src/providers/pi/index.ts'),
    import('../src/providers/container-browser/index.ts'),
    import('../src/providers/docker/index.ts'),
    import('../src/providers/openai/relevance.ts'),
    import('../src/providers/public-web/link-preview.ts'),
    import('../src/server/events.ts'),
  ]);
  databasePool = pool;
  const integration = createIntegrationFixture(baseUrl, audit);
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
      transcribe: unavailable,
      synthesize: unavailable,
    },
    keyStore: { id: 'isolated-memory', configured: true, getKey: async () => vaultKey },
    relevance: createOpenAIRelevanceClassifier({ apiKey: environment.OPENAI_API_KEY }),
    linkPreviews: createPublicLinkPreviewProvider(),
    model: { provider, name: model, configured: true },
  });
  const { app } = application;
  integration.register(app);
  app.addContentTypeParser(
    'application/x-www-form-urlencoded',
    { parseAs: 'string', bodyLimit: 8192 },
    (_request, _body, done) => done(null, {}),
  );
  app.get('/e2e', async (_request, reply) => reply.type('text/html').send(operatorPage()));
  app.get('/e2e/status', async () => ({
    fixture: true,
    model: { provider, name: model },
    fixtureLogin,
    fixtureHotel,
    fixtureFlight,
    timeline,
    writes: integration.writes,
  }));
  const expected = new Map<string, string>();
  app.post('/e2e/expected-run', async (request, reply) => {
    const value = request.body as { scheduleId?: string; dueAt?: string };
    if (
      !value ||
      !/^[a-f0-9-]{36}$/.test(value.scheduleId || '') ||
      !Number.isFinite(Date.parse(value.dueAt || ''))
    )
      return reply.code(400).send({ error: 'Provide a schedule ID and an absolute ISO due time.' });
    expected.set(value.scheduleId!, new Date(value.dueAt!).toISOString());
    audit('schedule_expected', {
      scheduleId: value.scheduleId!,
      dueAt: expected.get(value.scheduleId!)!,
    });
    return { ok: true };
  });
  app.addHook('onRequest', async (request) => {
    if (request.method === 'POST' && request.url.split('?')[0] === '/api/messages')
      audit('chat_request_received', { requestId: request.id });
  });
  app.addHook('onSend', async (request, _reply, payload) => {
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
    evidence:
      'Real app, Pi model, Chrome, Vault and thread workspace; synthetic connected apps, sign-in website and channel setup. Speech and channel delivery disabled.',
  };
  await writeFile(join(directory, 'manifest.json'), JSON.stringify(manifest, null, 2), {
    mode: 0o600,
  });
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
