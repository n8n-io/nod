import { randomBytes, randomUUID } from 'node:crypto';
import { createServer } from 'node:net';
import { copyFile, mkdir, mkdtemp, realpath } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import pg from 'pg';
import { createAgentSession } from '@earendil-works/pi-coding-agent';
import type { ModelEffort } from '../../src/shared/models.ts';
import { parse } from 'dotenv';
import { readFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import type { IntegrationProvider } from '../../src/ports/integrations.ts';
import { runProcess } from '../../src/providers/process.ts';
import { agentModels } from '../../src/shared/model-defaults.ts';
import { ChannelSetupFailure } from '../../src/ports/channel-settings.ts';
import { integrationDatabaseUrl } from '../../scripts/local-database.ts';
import { accessCookie, accessKey } from '../../src/server/access.ts';
import { createCapture, type Observation } from './capture.ts';
import { collectUsage, type Run } from './trace.ts';

const here = dirname(fileURLToPath(import.meta.url));
export const repository = resolve(here, '../..');
export const appSource = process.env.NOD_EVAL_SOURCE || repository;

export type Provider = 'openai' | 'anthropic' | 'openrouter';

export interface Model {
  provider: Provider;
  name: string;
  apiKey: string;
  effort?: ModelEffort;
}

export const keyVariables: Record<Provider, string> = {
  openai: 'OPENAI_API_KEY',
  anthropic: 'ANTHROPIC_API_KEY',
  openrouter: 'OPENROUTER_API_KEY',
};

export async function loadEnvironment() {
  return {
    ...parse(await readFile(join(repository, '.env'), 'utf8').catch(() => '')),
    ...process.env,
  } as Record<string, string | undefined>;
}

function selectModel(
  environment: Record<string, string | undefined>,
  provider: string = environment.LLM_PROVIDER || 'openai',
  name = environment.LLM_MODEL,
): Model {
  if (provider !== 'openai' && provider !== 'anthropic' && provider !== 'openrouter')
    throw new Error(
      'Choose the openai, anthropic or openrouter provider, for example openai/gpt-6.1-sol or openrouter/moonshotai/kimi-k3.',
    );
  const apiKey = environment[keyVariables[provider]];
  if (!apiKey) throw new Error(`Set ${keyVariables[provider]} to run ${provider} models.`);
  if (provider === 'openrouter' && !name)
    throw new Error('Name the OpenRouter model, for example openrouter/moonshotai/kimi-k3.');
  const model = name || agentModels[provider];
  if (!model) throw new Error(`Name the ${provider} model.`);
  return { provider, name: model, apiKey };
}

export async function approvalOrder(pool: pg.Pool) {
  const { rows } = await pool.query(
    "SELECT 1 FROM information_schema.columns WHERE table_schema=current_schema() AND table_name='approvals' AND column_name='created_at'",
  );
  return rows.length ? 'created_at' : 'expires_at';
}

async function freePort() {
  const probe = createServer();
  await new Promise<void>((done) => probe.listen(0, '127.0.0.1', done));
  const { port } = probe.address() as { port: number };
  await new Promise((done) => probe.close(done));
  return port;
}

export function parseModel(value: string, environment: Record<string, string | undefined>) {
  const [provider, ...rest] = value.split('/');
  return selectModel(environment, provider, rest.join('/') || undefined);
}

export interface Stack {
  proactivity: {
    view(): Promise<import('../../src/shared/proactivity.ts').ProactivityView>;
    control(input: Record<string, unknown>): Promise<unknown>;
    poll(): Promise<string | undefined>;
  };
  request(
    path: string,
    init?: RequestInit & { headers?: Record<string, string> },
  ): Promise<Response>;
  origin: string;
  directory: string;
  container: string;
  pool: pg.Pool;
  waiting(alias: string): string;
  bossSchema: string;
  sessionRoot: string;
  observations: Array<{ turnId: string; event: Observation }>;
  prompts: Array<{ turnId: string; sessionId: string; instruction: string }>;
  exec(command: string, timeoutMs?: number): Promise<{ exitCode: number; output: string }>;
  resetConversation(): Promise<void>;
  event(summary: string, sources?: string[]): Promise<string>;
  stop(): Promise<void>;
  finalUsage?: Run['usage'];
}

export function createStackRequest(baseUrl: string, cookie: string): Stack['request'] {
  const origin = new URL(baseUrl).origin;
  return (path, init) =>
    fetch(new URL(path, baseUrl), { ...init, headers: { ...init?.headers, origin, cookie } });
}

export async function startStack(options: {
  model: Model;
  integrations: IntegrationProvider;
  observations?: import('../../src/ports/proactivity.ts').ObservationProvider[];
  proactiveBaseline?: boolean;
  siteHosts: string[];
  siteUpstreamPort: number;
  hermetic: boolean;
  environment: Record<string, string | undefined>;
}): Promise<Stack> {
  const { model, environment } = options;
  const typesafe = environment.TYPESAFE_API_KEY?.trim();
  const suffix = randomUUID().replaceAll('-', '').slice(0, 12);
  const schema = `eval_${suffix}`;
  const bossSchema = `eval_boss_${suffix}`;
  const container = `nod-workspace-eval-${suffix}`;
  const browserContainer = `nod-browser-eval-${suffix}`;
  const directory = await realpath(await mkdtemp(join(tmpdir(), 'nod-eval-')));
  const workspaceRoot = join(directory, '.local', 'workspaces');
  const toolsRoot = join(directory, 'workspace-tools');
  process.umask(0);
  await mkdir(workspaceRoot, { recursive: true });
  await mkdir(toolsRoot);
  const baseDatabase = new URL(await integrationDatabaseUrl(repository, environment));
  if (!['127.0.0.1', 'localhost'].includes(baseDatabase.hostname))
    throw new Error('The evaluation requires a local PostgreSQL test database.');
  const admin = new pg.Pool({ connectionString: baseDatabase.href, max: 2 });
  await admin.query(`CREATE SCHEMA ${schema}`);
  const database = new URL(baseDatabase);
  database.searchParams.set('options', `-c search_path=${schema}`);
  process.env.DATABASE_URL = database.href;
  process.env.PGBOSS_SCHEMA = bossSchema;
  const port = await freePort();
  process.env.PORT = String(port);
  process.env.NOD_PUBLIC_URL = `http://localhost:${port}`;
  process.env.NOD_DATA_ROOT = join(directory, '.local');
  process.env.NODE_ENV = 'production';
  process.env.DEV_INSPECTOR = 'true';
  process.env[keyVariables[model.provider]] = model.apiKey;
  process.chdir(appSource);

  let containerStarted = false;
  let browserStarted = false;
  let application:
    | Awaited<ReturnType<(typeof import('../../src/server/composition.ts'))['createApplication']>>
    | undefined;
  let databasePool: pg.Pool | undefined;
  let finalUsage: Run['usage'] | undefined;
  async function stop() {
    let closed = false;
    let deadline: NodeJS.Timeout | undefined;
    await Promise.race([
      application?.app
        .close()
        .then(() => (closed = true))
        .catch(() => {}),
      new Promise((resolve) => (deadline = setTimeout(resolve, 15_000))),
    ]);
    clearTimeout(deadline);
    const closedBeforeRead = closed;
    if (databasePool) {
      finalUsage = await collectUsage(databasePool).catch(() => undefined);
      if (finalUsage && !closedBeforeRead) finalUsage.costUsd = null;
    }
    if (browserStarted) {
      const logs = await runProcess('docker', ['logs', '--tail', '200', browserContainer]).catch(
        () => undefined,
      );
      if (logs) process.stderr.write(`Browser container output:\n${logs.stdout}${logs.stderr}\n`);
      await runProcess('docker', ['rm', '-f', browserContainer]).catch(() => {});
    }
    if (containerStarted) await runProcess('docker', ['rm', '-f', container]).catch(() => {});
    await databasePool?.end().catch(() => {});
    await admin
      .query(`DROP SCHEMA IF EXISTS ${bossSchema} CASCADE; DROP SCHEMA IF EXISTS ${schema} CASCADE`)
      .catch(() => {});
    await admin.end().catch(() => {});
  }
  try {
    const workspaceImage = environment.NOD_EVAL_WORKSPACE_IMAGE || 'nod-eval-workspace';
    const browserImage = environment.NOD_EVAL_BROWSER_IMAGE || 'nod-eval-browser';
    for (const image of [workspaceImage, browserImage]) {
      const inspected = await runProcess('docker', [
        'image',
        'inspect',
        image,
        '--format',
        '{{.Id}}',
      ]);
      if (inspected.exitCode)
        throw new Error(
          `Docker image ${image} is missing. Run pnpm run eval:capability doctor --fix, or set NOD_EVAL_WORKSPACE_IMAGE and NOD_EVAL_BROWSER_IMAGE.`,
        );
    }
    const started = await runProcess('docker', [
      'run',
      '-d',
      '--name',
      container,
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
      workspaceImage,
      'sleep',
      'infinity',
    ]);
    if (started.exitCode) throw new Error('Could not start the isolated workspace container.');
    containerStarted = true;

    const worker = join(directory, 'browser-worker');
    await mkdir(join(worker, 'src', 'world'), { recursive: true });
    for (const name of ['browser-worker.ts', 'fixture-proxy.ts'])
      await copyFile(join(here, 'world', name), join(worker, 'src', 'world', name));
    const browser = await runProcess('docker', [
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
      '--add-host',
      'host.docker.internal:host-gateway',
      '--env',
      `EVAL_SITE_HOSTS=${(options.siteHosts.length ? options.siteHosts : ['unused.example.org']).join(',')}`,
      '--env',
      `EVAL_SITE_UPSTREAM=http://host.docker.internal:${options.siteUpstreamPort}`,
      '--env',
      `EVAL_SITE_HERMETIC=${options.hermetic ? '1' : '0'}`,
      '--mount',
      `type=bind,source=${worker},target=/app/evals,readonly`,
      '--mount',
      `type=bind,source=${join(appSource, 'src')},target=/app/src,readonly`,
      '--tmpfs',
      '/data:uid=1000,gid=1000,mode=700,size=536870912',
      '--tmpfs',
      '/tmp:size=268435456',
      '--tmpfs',
      '/home/node:uid=1000,gid=1000,mode=700,size=268435456',
      browserImage,
      'node',
      '--import',
      'tsx',
      '/app/evals/src/world/browser-worker.ts',
    ]);
    if (browser.exitCode) throw new Error('Could not start the isolated browser container.');
    browserStarted = true;
    let ready = false;
    for (let attempt = 0; attempt < 60 && !ready; attempt++) {
      const probe = await runProcess('docker', [
        'exec',
        browserContainer,
        'node',
        '-e',
        'const s=require("node:net").connect("/data/control.sock");s.on("connect",()=>{s.end();process.exit(0)});s.on("error",()=>process.exit(1))',
      ]);
      ready = probe.exitCode === 0;
      if (!ready) await new Promise((done) => setTimeout(done, 500));
    }
    if (!ready) throw new Error('The isolated browser did not become ready.');

    const load = <T>(path: string) =>
      import(pathToFileURL(join(appSource, path)).href) as Promise<T>;
    const [
      { createApplication },
      { pool },
      { createPiAgent },
      { createPiMemoryCurator },
      { activeThread, resetThread },
      { createContainerBrowserComputer },
      { createDockerWorkspace },
      { createPublicLinkPreviewProvider },
      { waitingTurnSql },
    ] = await Promise.all([
      load<typeof import('../../src/server/composition.ts')>('src/server/composition.ts'),
      load<typeof import('../../src/server/db.ts')>('src/server/db.ts'),
      load<typeof import('../../src/providers/pi/index.ts')>('src/providers/pi/index.ts'),
      load<typeof import('../../src/providers/pi/memory-curator.ts')>(
        'src/providers/pi/memory-curator.ts',
      ),
      load<typeof import('../../src/server/thread.ts')>('src/server/thread.ts'),
      load<typeof import('../../src/providers/container-browser/index.ts')>(
        'src/providers/container-browser/index.ts',
      ),
      load<typeof import('../../src/providers/docker/index.ts')>('src/providers/docker/index.ts'),
      load<typeof import('../../src/providers/public-web/link-preview.ts')>(
        'src/providers/public-web/link-preview.ts',
      ),
      load<{ waitingTurnSql?: (alias: string) => string }>('src/server/vault.ts'),
    ]);
    databasePool = pool;
    const vaultKey = randomBytes(32);
    const sessionRoot = join(directory, '.local', 'sessions');
    const computer = createContainerBrowserComputer({
      dataRoot: join(directory, '.local'),
      container: browserContainer,
    });
    const capture = createCapture(options.proactiveBaseline);
    const { observations, prompts } = capture;
    application = await createApplication(
      {
        observations: options.observations,
        observe: capture.observe,
        agent: capture.agent(
          createPiAgent({
            provider: model.provider,
            model: model.name,
            apiKey: model.apiKey,
            sessionRoot,
            ...(model.effort
              ? {
                  createSession: (input) =>
                    createAgentSession({ ...input, thinkingLevel: model.effort }),
                }
              : {}),
          }),
        ),
        computer,
        workspace: createDockerWorkspace({ container, workspaceRoot }),
        integrations: options.integrations,
        messagingSetup: {
          verifier: {
            verify: async () => {
              throw new ChannelSetupFailure('invalid_input');
            },
          },
          create: () => ({
            channels: (['telegram', 'whatsapp'] as const).map((id) => ({
              id,
              status: 'disabled' as const,
              missing: [],
              accountId: '',
              allowedSenderIds: [],
            })),
            receive: async () => ({ status: 404, body: { error: 'Channels are disabled.' } }),
            post: async () => {
              throw new Error('Channels are disabled.');
            },
            close: async () => {},
          }),
        },
        speech: {
          id: 'disabled',
          configured: false,
          synthesize: async () => {
            throw new Error('Speech is disabled in the evaluation.');
          },
        },
        keyStore: { id: 'isolated-memory', configured: true, getKey: async () => vaultKey },
        ...(existsSync(join(appSource, 'src/providers/openai/relevance.ts'))
          ? {
              relevance: (
                await load<{
                  createOpenAIRelevanceClassifier(options: { apiKey?: string }): unknown;
                }>('src/providers/openai/relevance.ts')
              ).createOpenAIRelevanceClassifier({ apiKey: environment.OPENAI_API_KEY }),
            }
          : {}),
        ...((typesafe || model.provider !== 'anthropic') &&
        existsSync(join(appSource, 'src/providers/decisions.ts'))
          ? {
              decisions: (
                await load<typeof import('../../src/providers/decisions.ts')>(
                  'src/providers/decisions.ts',
                )
              ).createDecisionModel({
                resolve: async () =>
                  typesafe
                    ? { provider: 'typesafe', key: typesafe }
                    : {
                        provider: model.provider === 'openrouter' ? 'openrouter' : 'openai',
                        key: model.apiKey,
                      },
              }),
            }
          : {}),
        memoryCurator: createPiMemoryCurator({ provider: model.provider, apiKey: model.apiKey }),
        onboardingCurator: createPiMemoryCurator({
          provider: model.provider,
          apiKey: model.apiKey,
          model: model.name,
          lightest: true,
        }),
        linkPreviews: createPublicLinkPreviewProvider(),
        model: { provider: model.provider, name: model.name, configured: true },
      },
      { heartbeat: false },
    );
    await application.app.listen({ host: '127.0.0.1', port });
    const baseUrl = `http://localhost:${port}`;
    const cookie = `${accessCookie(port)}=${await accessKey(join(directory, '.local'))}`;
    const engine = application.proactivity;
    return {
      get finalUsage() {
        return finalUsage;
      },
      proactivity: {
        view: () => engine.view(),
        control: (input) => engine.control(input),
        async poll() {
          await pool.query('UPDATE proactive_sources SET next_poll=clock_timestamp()');
          return engine.due();
        },
      },
      request: createStackRequest(baseUrl, cookie),
      waiting: (alias) => waitingTurnSql?.(alias) ?? `${alias}.status='waiting'`,
      origin: baseUrl,
      directory,
      container,
      pool,
      bossSchema,
      sessionRoot,
      observations,
      prompts,
      async exec(command, timeoutMs = 120_000) {
        const result = await runProcess(
          'docker',
          ['exec', '--user', 'node', '--workdir', '/workspace', container, 'bash', '-c', command],
          { timeoutMs },
        );
        return { exitCode: result.exitCode ?? 1, output: result.stdout + result.stderr };
      },
      async resetConversation() {
        const { previousThreadId } = await resetThread((await activeThread()).id);
        await computer.discard?.(previousThreadId).catch(() => {});
      },
      async event(summary, sources) {
        const eventId = `eval:${randomUUID()}`;
        const legacy = (
          await pool.query("SELECT to_regclass('notifications') IS NOT NULL AS found")
        ).rows[0].found;
        const observationSources: string[] = [...(sources ?? [])];
        if (!sources)
          for (const provider of options.observations ?? [])
            for (const source of await provider.sources())
              if (source.readable) observationSources.push(`${provider.id}:${source.id}`);
        if (!legacy && !sources && typeof application!.integrations.activitySources === 'function')
          for (const source of await application!.integrations.activitySources())
            if (source.active) observationSources.push(source.connectionId);
        const queued = legacy
          ? await (
              application!.triage.triageEvent as unknown as (
                summary: string,
                eventId: string,
                intent: string,
              ) => Promise<unknown>
            )(summary, eventId, 'inspect_message')
          : await application!.triage.triageEvent(
              summary,
              eventId,
              undefined,
              observationSources.length ? observationSources : undefined,
            );
        const turnId =
          typeof queued === 'string'
            ? queued
            : legacy
              ? ((
                  await pool.query('SELECT turn_id FROM notifications WHERE event_id=$1', [eventId])
                ).rows[0]?.turn_id as string | undefined)
              : undefined;
        if (!turnId) throw new Error('The incoming event did not queue a background turn.');
        return turnId;
      },
      stop,
    };
  } catch (error) {
    await stop();
    throw error;
  }
}
