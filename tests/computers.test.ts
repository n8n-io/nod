import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { EventEmitter } from 'node:events';
import { mkdirSync } from 'node:fs';
import {
  cp,
  mkdir,
  mkdtemp,
  readFile,
  realpath,
  rm,
  stat,
  symlink,
  writeFile,
} from 'node:fs/promises';
import { createServer, type IncomingHttpHeaders, type ServerResponse } from 'node:http';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import { PassThrough } from 'node:stream';
import { setTimeout as delay } from 'node:timers/promises';
import test from 'node:test';
import { parseEnv } from 'node:util';
import { Sandbox } from 'e2b';
import pg from 'pg';
import { prepareE2BContext } from '../deployment/e2b/context.ts';
import { acceptanceSourceHash } from '../deployment/e2b/acceptance.ts';
import type { Computer, WorkspaceSession } from '../src/ports/computer.ts';
import type {
  ComputerAllocation,
  ComputerAllocationStore,
} from '../src/ports/computer-allocation.ts';
import { createComputerAllocationStore } from '../src/server/computer-allocations.ts';
import type { CommandProcess } from '../src/providers/command-process.ts';
import { createCloudflareAdapters } from '../src/providers/cloudflare-computer/index.ts';
import { launchCloudflareCommand } from '../src/providers/cloudflare-computer/transport.ts';
import { runBrowserBridge } from '../src/providers/container-browser/bridge.ts';
import { startContainerBrowserWorker } from '../src/providers/container-browser/worker.ts';
import { connectedUser, workspaceCommandProgram } from '../src/providers/docker/command.ts';
import { createE2BAllocation } from '../src/providers/e2b/allocation.ts';
import {
  createE2BClient,
  type E2BClient,
  type E2BCommandRole,
  type E2BSandbox,
} from '../src/providers/e2b/client.ts';
import { createE2BAdapters } from '../src/providers/e2b/index.ts';
import { createCloudflareRuntimeTransport } from '../src/providers/runtime-host/cloudflare.ts';
import { createComputerShutdownConfirmation } from '../src/providers/runtime-host/computer-shutdown.ts';
import { fakeComputer } from './runtime-fixtures.ts';

const { hostedEnvironment } = await import(
  new URL('../scripts/start-hosted.mjs', import.meta.url).href
);
const { webhookRoute, createWebhookRelay } = await import(
  new URL('../scripts/webhook-relay.mjs', import.meta.url).href
);
const { cloudflareLocalPlan } = await import(
  new URL('../scripts/start-cloudflare-local.mjs', import.meta.url).href
);

const refused = (error: unknown) => {
  assert.doesNotMatch(String(error), /synthetic|private|secret|detail/i);
  return true;
};

// E2B: provider keys stay server-side, sandboxes stay owned, uncertain transport stays fenced.

test('E2B SDK configuration keeps keys server-side and blocks public traffic', async (t) => {
  const calls: Array<{ action: string; args: unknown[] }> = [];
  const fake = {
    sandboxId: 'fixture-sandbox',
    commands: {
      async run(...args: unknown[]) {
        calls.push({ action: 'run', args });
        if (args[0] === 'python3 /opt/otto/computer-guard.py check')
          return { exitCode: 0, stdout: '{"ready":true}\n', stderr: '' };
        return {
          sendStdin: async () => {},
          closeStdin: async () => {},
          wait: async () => ({ exitCode: 0 }),
          disconnect: async () => {},
        };
      },
    },
  };
  t.mock.method(Sandbox, 'create', async (...args: unknown[]) => {
    calls.push({ action: 'create', args });
    return fake;
  });
  const client = createE2BClient({
    apiKey: 'synthetic-server-key',
    requestTimeoutMs: 1234,
    sandboxTimeoutMs: 60_000,
  });
  const sandbox = await client.create('computer-template', { role: 'computer' });
  assert.equal(sandbox.id, 'fixture-sandbox');
  const created = calls.find((call) => call.action === 'create')!.args[1] as Record<
    string,
    unknown
  >;
  assert.deepEqual(created.network, { allowPublicTraffic: false });
  assert.deepEqual(created.envs, {});
  await sandbox.ready();
  const checked = calls.find((call) => call.action === 'run')!.args[1] as Record<string, unknown>;
  assert.deepEqual(checked.envs, {});
  await sandbox.start({
    role: 'browser',
    command: 'fixed-command',
    stdout: () => {},
    stderr: () => {},
  });
  const started = calls.find((call) => call.args[0] === 'fixed-command')!.args[1] as Record<
    string,
    unknown
  >;
  assert.equal(started.user, 'otto-browser');
  assert.equal(started.timeoutMs, 0);
  assert.deepEqual(started.envs, {});
  assert.equal(JSON.stringify(started).includes('synthetic-server-key'), false);
  await sandbox.start({
    role: 'workspace',
    command: 'fixed-workspace',
    stdout: () => {},
    stderr: () => {},
  });
  const workspace = calls.find((call) => call.args[0] === 'fixed-workspace')!.args[1] as Record<
    string,
    unknown
  >;
  assert.equal(workspace.user, 'node');
  assert.deepEqual(workspace.envs, {});
  const beforeInvalid = calls.length;
  await assert.rejects(
    sandbox.start({
      role: 'root' as E2BCommandRole,
      command: 'forbidden',
      stdout: () => {},
      stderr: () => {},
    }),
    /invalid/,
  );
  assert.equal(calls.length, beforeInvalid);
  assert.equal('getHost' in sandbox, false);
  assert.equal('trafficAccessToken' in sandbox, false);
});

test('E2B readiness refuses missing, malformed or failed protected-computer proof without exposing provider detail', async (t) => {
  let result: unknown;
  let failure = false;
  const fake = {
    sandboxId: 'synthetic',
    commands: {
      async run() {
        if (failure) throw new Error('synthetic provider secret');
        return result;
      },
    },
  };
  t.mock.method(Sandbox, 'create', async () => fake);
  const sandbox = await createE2BClient({ apiKey: 'synthetic-key' }).create('computer', {});
  for (const value of [
    undefined,
    { exitCode: 1, stdout: '{"ready":true}\n', stderr: '' },
    { exitCode: 0, stdout: '{"ready":false}\n', stderr: '' },
    { exitCode: 0, stdout: '{"ready":true}\nextra', stderr: '' },
    { exitCode: 0, stdout: '{"ready":true}\n', stderr: 'synthetic private detail' },
  ]) {
    result = value;
    await assert.rejects(sandbox.ready(), refused);
  }
  failure = true;
  await assert.rejects(sandbox.ready(), refused);
});

test('template contexts reject symlinked source and do not copy unrelated local files', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'otto-template-source-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  for (const directory of ['src/providers/container-browser', 'deployment/e2b'])
    await mkdir(join(root, directory), { recursive: true });
  await Promise.all([
    writeFile(
      join(root, 'Dockerfile.browser'),
      'FROM node:24.21.0-bookworm-slim\nCOPY src /app/src\n',
    ),
    writeFile(join(root, 'package.json'), '{}'),
    writeFile(join(root, 'pnpm-lock.yaml'), 'lockfileVersion: 9.0\n'),
    writeFile(join(root, 'pnpm-workspace.yaml'), 'packages: []\n'),
    writeFile(
      join(root, 'src/providers/container-browser/worker.ts'),
      "import './dependency.ts';\n",
    ),
    writeFile(
      join(root, 'src/providers/container-browser/dependency.ts'),
      'export const ready = true;\n',
    ),
    writeFile(join(root, 'src/providers/container-browser/bridge.ts'), 'export {};\n'),
    writeFile(
      join(root, 'src/providers/container-browser/chromium.sh'),
      '#!/bin/sh\nexec /usr/bin/chromium "$@" 2>/dev/null\n',
    ),
    writeFile(
      join(root, 'src/providers/container-browser/xvfb.sh'),
      '#!/bin/sh\nexec /usr/bin/Xvfb "$@"\n',
    ),
    writeFile(join(root, 'deployment/e2b/browser-ready.ts'), 'export {};\n'),
    writeFile(
      join(root, 'src/providers/container-browser/.env'),
      'UNRELATED=synthetic-private-fixture\n',
    ),
  ]);
  const context = await prepareE2BContext({ role: 'browser', root });
  t.after(context.close);
  assert.equal(
    await readFile(join(context.path, 'src/providers/container-browser/dependency.ts'), 'utf8'),
    'export const ready = true;\n',
  );
  await assert.rejects(stat(join(context.path, 'src/providers/container-browser/.env')));
  assert.equal((await stat(join(context.path, 'src'))).mode & 0o777, 0o755 & ~process.umask());
  await rm(join(root, 'src/providers/container-browser/dependency.ts'));
  await symlink(
    join(root, 'src/providers/container-browser/.env'),
    join(root, 'src/providers/container-browser/dependency.ts'),
  );
  await assert.rejects(prepareE2BContext({ role: 'browser', root }), /approved context/);
  await rm(join(root, 'src/providers/container-browser/chromium.sh'));
  await symlink(
    join(root, 'src/providers/container-browser/.env'),
    join(root, 'src/providers/container-browser/chromium.sh'),
  );
  await assert.rejects(prepareE2BContext({ role: 'browser', root }), /approved context/);
});

test('computer acceptance fingerprints launch assets and rejects substituted files', async (t) => {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'otto-acceptance-source-')));
  t.after(() => rm(root, { recursive: true, force: true }));
  for (const path of [
    'src',
    'deployment/e2b',
    'package.json',
    'pnpm-lock.yaml',
    'pnpm-workspace.yaml',
  ])
    await cp(new URL(`../${path}`, import.meta.url), join(root, path), { recursive: true });
  const before = await acceptanceSourceHash(root);
  const launcher = join(root, 'src/providers/container-browser/chromium.sh');
  await writeFile(launcher, (await readFile(launcher, 'utf8')) + '\n');
  assert.notEqual(await acceptanceSourceHash(root), before);
  await rm(launcher);
  await symlink(join(root, 'package.json'), launcher);
  await assert.rejects(acceptanceSourceHash(root));
});

function initial(ownerId: string): ComputerAllocation {
  return {
    ownerId,
    role: 'browser',
    provider: 'e2b',
    templateId: 'synthetic-browser',
    resourceId: null,
    generation: randomUUID(),
    version: 1,
    state: 'allocating',
    leaseId: randomUUID(),
    leaseExpiresAt: Date.now() + 90_000,
  };
}

test(
  'computer allocations persist owner and role boundaries, CAS writes and immutable resource identity',
  { skip: !process.env.TEST_DATABASE_URL },
  async (t) => {
    const schema = `test_allocations_${randomUUID().replaceAll('-', '')}`;
    const admin = new pg.Pool({ connectionString: process.env.TEST_DATABASE_URL, max: 1 });
    const database = new pg.Pool({
      connectionString: process.env.TEST_DATABASE_URL,
      options: `-c search_path=${schema}`,
      max: 4,
    });
    t.after(async () => {
      await database.end();
      await admin.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);
      await admin.end();
    });
    await admin.query(`CREATE SCHEMA ${schema}`);
    const ownerId = randomUUID();
    const otherOwner = randomUUID();
    const store = createComputerAllocationStore({ database, ownerId });
    const other = createComputerAllocationStore({ database, ownerId: otherOwner });
    await Promise.all([store.initialize(), other.initialize()]);
    assert.equal(await store.read(ownerId, 'browser'), undefined);
    const first = initial(ownerId);
    const competing = { ...first, generation: randomUUID(), leaseId: randomUUID() };
    const created = await Promise.all([
      store.compareAndSwap(null, first),
      store.compareAndSwap(null, competing),
    ]);
    assert.equal(created.filter(Boolean).length, 1);
    const accepted = created[0] ? first : competing;
    assert.deepEqual(await store.read(ownerId, 'browser'), accepted);
    assert.equal(await other.read(otherOwner, 'browser'), undefined);
    const otherValue = initial(otherOwner);
    assert.equal(await other.compareAndSwap(null, otherValue), true);
    const workspace = { ...initial(ownerId), role: 'workspace' as const };
    assert.equal(await store.compareAndSwap(null, workspace), true);
    const ready = { ...accepted, version: 2, state: 'ready' as const, resourceId: 'sandbox-a' };
    assert.equal(await store.compareAndSwap(1, ready), true);
    assert.equal(await store.compareAndSwap(1, { ...ready, resourceId: 'sandbox-b' }), false);
    for (const change of [
      { provider: 'other' },
      { templateId: 'other-template' },
      { generation: randomUUID() },
      { resourceId: 'sandbox-b' },
      { resourceId: null, state: 'uncertain' as const },
    ])
      assert.equal(await store.compareAndSwap(2, { ...ready, version: 3, ...change }), false);
    const released = { ...ready, version: 3, leaseId: null, leaseExpiresAt: null };
    assert.equal(await store.compareAndSwap(2, released), true);
    const restart = createComputerAllocationStore({ database, ownerId });
    assert.deepEqual(await restart.read(ownerId, 'browser'), released);
    const reacquire = {
      ...released,
      version: 4,
      leaseId: randomUUID(),
      leaseExpiresAt: Date.now() + 90_000,
    };
    const claimed = await Promise.all([
      restart.compareAndSwap(3, reacquire),
      store.compareAndSwap(3, { ...reacquire, leaseId: randomUUID() }),
    ]);
    assert.equal(claimed.filter(Boolean).length, 1);
    const live = (await store.read(ownerId, 'browser'))!;
    const uncertain = { ...live, version: 5, state: 'uncertain' as const, leaseExpiresAt: 1 };
    assert.equal(await store.compareAndSwap(4, uncertain), true);
    assert.deepEqual(await restart.read(ownerId, 'browser'), uncertain);
    assert.equal(await restart.compareAndSwap(null, initial(ownerId)), false);
    const recovered = {
      ...uncertain,
      version: 6,
      state: 'ready' as const,
      leaseId: null,
      leaseExpiresAt: null,
    };
    assert.equal(await restart.compareAndSwap(5, recovered), true);
    assert.deepEqual(await store.read(ownerId, 'browser'), recovered);
    assert.deepEqual(await store.read(ownerId, 'workspace'), workspace);
    assert.deepEqual(await other.read(otherOwner, 'browser'), otherValue);
    await assert.rejects(store.compareAndSwap(1, { ...otherValue, version: 2 }), {
      code: 'invalid_allocation',
    });
  },
);

async function execute(session: WorkspaceSession, command: string) {
  const chunks: Buffer[] = [];
  const { exitCode } = await session.exec(command, { onData: (chunk) => chunks.push(chunk) });
  const output = Buffer.concat(chunks).toString('utf8');
  if (exitCode) throw new Error(`Workspace command exited with ${exitCode}: ${output}`);
  return output;
}

function allocationStore() {
  const records = new Map<string, ComputerAllocation>();
  const store: ComputerAllocationStore = {
    read: async (owner, role) => structuredClone(records.get(owner + '/' + role)),
    async compareAndSwap(version, next) {
      const key = next.ownerId + '/' + next.role;
      if ((records.get(key)?.version ?? null) !== version) return false;
      records.set(key, structuredClone(next));
      return true;
    },
  };
  return { store, records };
}

async function sealedCli(home: string) {
  const cli = { id: randomUUID(), command: 'fixturecli', source: { npm: 'fixturecli' } };
  const prefix = join(home, `otto-cli-${cli.id}`);
  await mkdir(join(prefix, 'bin'), { recursive: true });
  await writeFile(join(prefix, 'bin', 'fixturecli'), '#!/bin/sh\nexec "$@"\n', { mode: 0o755 });
  await writeFile(join(prefix, '.installed'), '');
  return cli;
}

async function e2bFixture() {
  const root = await mkdtemp('/tmp/otto-e2b-');
  const socketPath = join(root, 'control.sock');
  const calls: Array<{ method: string; input?: unknown }> = [];
  let holdAction: (() => Promise<void>) | undefined;
  let action: (() => Promise<void>) | undefined;
  let browserHeld = false;
  let browserDisposal: (() => Promise<void>) | undefined;
  const worker = await startContainerBrowserWorker({
    socketPath,
    createComputer: () => {
      return {
        ...fakeComputer(),
        act: async (_id, input, signal) => {
          calls.push({ method: 'act', input });
          await action?.();
          if (holdAction) {
            await new Promise<void>((resolve) =>
              signal?.addEventListener('abort', () => resolve(), { once: true }),
            );
            await holdAction();
            throw new Error('cancelled');
          }
          return {
            text: 'Synthetic page',
            url: input.url ?? 'https://example.test/',
          };
        },
        screenshot: async () => Buffer.from('masked image'),
        injectCredentials: async (input) => {
          calls.push({ method: 'credentials', input });
          return { status: 'submitted' };
        },
        currentPage: async () => ({
          origin: 'https://example.test',
          url: 'https://example.test/login',
        }),
        dispose: async () => {
          await browserDisposal?.();
        },
        canCheckpoint: () => !browserHeld,
      } satisfies Computer & { canCheckpoint(): boolean };
    },
  });
  const requests: Array<{
    role: string;
    resourceId: string;
    command: string;
    frames: string[];
    output: string;
  }> = [];
  const metadata: Array<Record<string, string>> = [];
  const sandboxes = new Map<string, E2BSandbox>();
  let pauseCount = 0;
  let connectCount = 0;
  let readinessCount = 0;
  let readiness: (() => Promise<void>) | undefined;
  let pauseAction: (() => Promise<void>) | undefined;
  let drop = false;
  let missingAcknowledgement = false;
  const client: E2BClient = {
    async create(templateId, values) {
      metadata.push(values);
      const id = templateId + '-' + (sandboxes.size + 1);
      const sandbox: E2BSandbox = {
        id,
        ready: async () => {
          readinessCount++;
          await readiness?.();
        },
        keepAlive: async () => {},
        pause: async () => {
          pauseCount++;
          await pauseAction?.();
          return true;
        },
        async start(input) {
          const request = {
            role: input.role,
            resourceId: id,
            command: input.command,
            frames: [] as string[],
            output: '',
          };
          requests.push(request);
          if (drop) throw new Error('Synthetic secret must not reach the caller');
          if (missingAcknowledgement)
            return {
              sendStdin: async () => {},
              closeStdin: async () => {},
              wait: async () => ({ exitCode: 0 }),
              disconnect: async () => {},
            };
          if (input.role === 'browser') {
            const stdin = new PassThrough();
            const stdout = new PassThrough();
            stdout.on('data', (value: Buffer) => input.stdout(value.toString()));
            const result = runBrowserBridge({ input: stdin, output: stdout, socketPath });
            return {
              sendStdin: async (data) => {
                request.frames.push(Buffer.from(data).toString());
                stdin.write(data);
              },
              closeStdin: async () => {
                stdin.end();
              },
              wait: async () => ({ exitCode: await result }),
              disconnect: async () => {},
            };
          }
          const task =
            input.command.match(/(?:mkdir -p|cd) \/workspace\/([a-zA-Z0-9_-]+)/)?.[1] ??
            (input.role === 'connected' ? 'connected' : undefined);
          assert.ok(task);
          const directory = join(root, id, task);
          await mkdir(directory, { recursive: true });
          const child = spawn('python3', ['-u', '-c', workspaceCommandProgram], {
            cwd: directory,
            env: { PATH: process.env.PATH },
          });
          child.stdout.on('data', (value: Buffer) => {
            request.output += value.toString();
            input.stdout(value.toString());
          });
          child.stderr.on('data', (value: Buffer) => input.stderr(value.toString()));
          const result = new Promise<{ exitCode: number }>((resolve) =>
            child.on('close', (code) => resolve({ exitCode: code ?? -1 })),
          );
          return {
            sendStdin: async (data) => {
              request.frames.push(Buffer.from(data).toString());
              child.stdin.write(data);
            },
            closeStdin: async () => {
              child.stdin.end();
            },
            wait: () => result,
            disconnect: async () => {},
          };
        },
      };
      sandboxes.set(id, sandbox);
      return sandbox;
    },
    async connect(id) {
      connectCount++;
      return sandboxes.get(id)!;
    },
  };
  const state = allocationStore();
  const create = (ownerId: string) =>
    createE2BAdapters({
      apiKey: 'synthetic-key',
      ownerId,
      templateId: 'computer',
      workspaceRoot: join(root, 'workspaces'),
      allocations: state.store,
      client,
    });
  return {
    root,
    calls,
    requests,
    metadata,
    state,
    create,
    pauses: () => pauseCount,
    connections: () => connectCount,
    readinessChecks: () => readinessCount,
    readiness: (value: () => Promise<void>) => {
      readiness = value;
    },
    pauseAction: (value: () => Promise<void>) => {
      pauseAction = value;
    },
    action: (value: () => Promise<void>) => {
      action = value;
    },
    browserHeld: (value: boolean) => {
      browserHeld = value;
    },
    browserDisposal: (value: () => Promise<void>) => {
      browserDisposal = value;
    },
    drop: () => {
      drop = true;
    },
    loseAcknowledgement: () => {
      missingAcknowledgement = true;
    },
    holdAction: (value: () => Promise<void>) => {
      holdAction = value;
    },
    close: async () => {
      await worker.close();
      await rm(root, { recursive: true, force: true });
    },
  };
}

test('E2B shares one owned sandbox across private browser and supervised workspace capabilities', async () => {
  const f = await e2bFixture();
  const first = f.create('owner-one');
  const second = f.create('owner-two');
  try {
    assert.equal(
      (await first.computer.act('task-one', { action: 'open', url: 'https://example.test/' })).text,
      'Synthetic page',
    );
    await first.computer.injectCredentials({
      threadId: 'task-one',
      origin: 'https://example.test',
      password: 'synthetic private value',
    });
    assert.equal((await first.computer.screenshot('task-one'))?.toString(), 'masked image');
    const workspace = first.workspace.open({
      threadId: 'task-one',
      workspacePath: join(f.root, 'workspaces/task-one'),
      signal: new AbortController().signal,
    });
    assert.equal(await execute(workspace, 'printf "héllo"'), 'héllo');
    assert.equal(first.workspace.connectedCliAvailable, true);
    const cli = await sealedCli(join(f.root, 'computer-1', 'connected'));
    assert.deepEqual(
      await workspace.runConnectedCli?.(
        cli,
        ['sh', '-c', '[ "$FIXTURE_TOKEN" = synthetic-private-token ] && echo True'],
        { FIXTURE_TOKEN: 'synthetic-private-token' },
      ),
      { exitCode: 0, output: 'True\n' },
    );
    const connectedAbort = new AbortController();
    const connected = first.workspace.open({
      threadId: 'task-one',
      workspacePath: join(f.root, 'workspaces/task-one'),
      signal: connectedAbort.signal,
    });
    const stopped = connected.runConnectedCli!(cli, ['sleep', '30'], {
      FIXTURE_TOKEN: 'synthetic-private-token',
    });
    setTimeout(() => connectedAbort.abort(), 50);
    await assert.rejects(stopped, /cancelled/);
    await second.computer.act('task-two', { action: 'snapshot' });
    assert.equal(f.state.records.size, 2);
    const rows = [...f.state.records.values()];
    assert.equal(new Set(rows.map((row) => row.resourceId)).size, 2);
    assert.ok(rows.every((row) => row.role === 'computer'));
    const owned = f.requests.filter((request) => request.resourceId === rows[0].resourceId);
    assert.deepEqual(
      new Set(owned.map((request) => request.role)),
      new Set(['browser', 'workspace', 'connected']),
    );
    assert.ok(
      owned.some(
        (request) =>
          request.role === 'connected' &&
          request.command.startsWith(
            `cd /var/tmp && exec /usr/bin/setpriv --reuid=${connectedUser(cli)} --regid=1002 `,
          ),
      ),
    );
    assert.equal(
      f.metadata.some((value) => JSON.stringify(value).includes('owner-one')),
      false,
    );
    assert.equal(
      f.requests.some((request) => request.command.includes('synthetic private value')),
      false,
    );
    assert.equal(
      f.requests.some((request) => request.command.includes('printf')),
      false,
    );
    assert.equal(
      f.requests.some((request) => request.command.includes('synthetic-private-token')),
      false,
    );
    assert.equal(
      f.requests.some((request) =>
        request.frames.some((frame) => frame.includes('synthetic private value')),
      ),
      true,
    );
  } finally {
    await Promise.all([
      first.computer.dispose(),
      first.workspace.dispose(),
      second.computer.dispose(),
      second.workspace.dispose(),
    ]);
    await f.close();
  }
});

test('E2B uncertain connections persist a fence and do not expose SDK errors', async () => {
  const f = await e2bFixture();
  const adapter = f.create('owner');
  try {
    await adapter.computer.act('task', { action: 'snapshot' });
    f.drop();
    await assert.rejects(
      adapter.computer.screenshot('task'),
      (error: Error) => !error.message.includes('Synthetic secret'),
    );
    await assert.rejects(adapter.computer.act('task', { action: 'snapshot' }), /unavailable/);
    await delay(5);
    assert.equal(f.state.records.get('owner/computer')?.state, 'uncertain');
    const replacement = f.create('owner');
    await assert.rejects(replacement.computer.act('task', { action: 'snapshot' }), /safely/);
    assert.equal(f.connections(), 0);
    await assert.rejects(replacement.dispose(), /recovery/);
    const workspace = adapter.workspace.open({
      threadId: 'task',
      workspacePath: join(f.root, 'workspaces/task'),
      signal: new AbortController().signal,
    });
    await assert.rejects(execute(workspace, 'printf never'), /safely/);
    await assert.rejects(adapter.prepare(), /recovery/);
  } finally {
    try {
      await assert.rejects(adapter.dispose(), /recovery/);
    } finally {
      await f.close();
    }
  }
});

test('E2B allocation refuses competing leases and fences failed lease renewal', async () => {
  const state = allocationStore();
  let rejectUpdates = false;
  const store: ComputerAllocationStore = {
    ...state.store,
    compareAndSwap: (version, next) =>
      rejectUpdates ? Promise.resolve(false) : state.store.compareAndSwap(version, next),
  };
  const sandbox: E2BSandbox = {
    id: 'synthetic',
    ready: async () => {},
    start: async () => {
      throw new Error();
    },
    keepAlive: async () => {},
    pause: async () => true,
  };
  const client: E2BClient = { create: async () => sandbox, connect: async () => sandbox };
  const options = {
    ownerId: 'owner',
    role: 'browser' as const,
    templateId: 'browser',
    store,
    client,
    leaseMs: 300,
  };
  const first = createE2BAllocation(options);
  const second = createE2BAllocation(options);
  const results = await Promise.allSettled([first.get(), second.get()]);
  assert.equal(results.filter((result) => result.status === 'fulfilled').length, 1);
  const winner = results[0].status === 'fulfilled' ? first : second;
  let fenced = false;
  winner.onFence(() => {
    fenced = true;
  });
  rejectUpdates = true;
  await delay(150);
  assert.equal(fenced, true);
  await assert.rejects(winner.get(), /recovery/);
  await Promise.allSettled([first.dispose(), second.dispose()]);
});

test('E2B configuration and workspace paths reject traversal before allocating a sandbox', async () => {
  const f = await e2bFixture();
  const adapter = f.create('owner');
  try {
    assert.throws(
      () =>
        adapter.workspace.open({
          threadId: '../foreign',
          workspacePath: '/tmp/foreign',
          signal: new AbortController().signal,
        }),
      /identifier/,
    );
    assert.throws(
      () =>
        adapter.workspace.open({
          threadId: 'task',
          workspacePath: '/tmp/foreign',
          signal: new AbortController().signal,
        }),
      /configured root/,
    );
    await assert.rejects(adapter.workspace.readArtifact!('task', '../../foreign', 128), /within/);
    assert.equal(f.state.records.size, 0);
  } finally {
    await adapter.workspace.dispose();
    await adapter.computer.dispose();
    await f.close();
  }
});

// Cloudflare computers: owner namespaces, drain on disposal and a fenced HTTP command transport.

const publicError = 'The remote computer connection did not finish safely.';

function deferred<T = void>() {
  let resolve!: (value?: T | PromiseLike<T>) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<T>((yes, no) => {
    resolve = yes as typeof resolve;
    reject = no;
  });
  return { promise, resolve, reject };
}

function frame(type: 'stdout' | 'stderr', data: Uint8Array | string) {
  return JSON.stringify({ type, data: Buffer.from(data).toString('base64') }) + '\n';
}

function launch(options: Partial<Parameters<typeof launchCloudflareCommand>[0]> = {}) {
  let uncertain = 0;
  const errors: Error[] = [];
  const inputErrors: Error[] = [];
  const closes: Array<number | null> = [];
  const stdout: Buffer[] = [];
  const stderr: Buffer[] = [];
  const completed = deferred<'error' | 'close'>();
  const process = launchCloudflareCommand({
    role: 'browser',
    generation: '17',
    ...options,
    onUncertain: () => {
      uncertain++;
      options.onUncertain?.();
    },
  });
  process.on('error', (error) => {
    errors.push(error);
    completed.resolve('error');
  });
  process.on('close', (code) => {
    closes.push(code);
    completed.resolve('close');
  });
  process.stdin.on('error', (error) => inputErrors.push(error));
  process.stdout.on('data', (bytes: Buffer) => stdout.push(bytes));
  process.stderr.on('data', (bytes: Buffer) => stderr.push(bytes));
  return {
    process,
    errors,
    inputErrors,
    closes,
    stdout,
    stderr,
    completed: completed.promise,
    uncertain: () => uncertain,
  };
}

async function httpFixture(options: { create?: Promise<void>; firstInput?: Promise<void> } = {}) {
  const calls: Array<{
    method: string;
    path: string;
    headers: IncomingHttpHeaders;
    body: Buffer;
  }> = [];
  const output = deferred<ServerResponse>();
  const created = deferred();
  const firstInput = deferred();
  const ended = deferred();
  const killed = deferred();
  let inputs = 0;
  const server = createServer((request, response) => {
    void (async () => {
      const bytes: Buffer[] = [];
      for await (const chunk of request) bytes.push(Buffer.from(chunk));
      const body = Buffer.concat(bytes);
      const path = request.url!;
      calls.push({ method: request.method!, path, headers: request.headers, body });
      if (path === '/v1/commands') {
        created.resolve();
        await options.create;
        response.writeHead(201, { 'content-type': 'application/json' });
        response.end(JSON.stringify({ id: JSON.parse(body.toString()).id }));
      } else if (path.endsWith('/output')) {
        response.writeHead(200, { 'content-type': 'application/x-ndjson' });
        response.flushHeaders();
        output.resolve(response);
      } else {
        if (path.endsWith('/input')) {
          if (++inputs === 1) {
            firstInput.resolve();
            await options.firstInput;
          }
        }
        response.writeHead(204).end();
        if (path.endsWith('/end')) ended.resolve();
        if (path.endsWith('/kill')) killed.resolve();
      }
    })().catch(() => response.destroy());
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  assert.ok(address && typeof address === 'object');
  return {
    origin: `http://127.0.0.1:${address.port}`,
    calls,
    output: output.promise,
    created: created.promise,
    firstInput: firstInput.promise,
    ended: ended.promise,
    killed: killed.promise,
    async close() {
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}

type FetchStep = (request: Request) => Response | Promise<Response>;

function fetchFixture(
  options: {
    create?: FetchStep;
    input?: FetchStep;
    end?: FetchStep;
    kill?: FetchStep;
    output?: FetchStep;
  } = {},
) {
  const calls: Request[] = [];
  const request: typeof fetch = async (input, init) => {
    const value = new Request(input, init);
    calls.push(value);
    const path = new URL(value.url).pathname;
    if (path === '/v1/commands') {
      if (options.create) return options.create(value);
      return Response.json({ id: (await value.json()).id }, { status: 201 });
    }
    const operation = path.split('/').at(-1)! as 'input' | 'end' | 'kill' | 'output';
    if (options[operation]) return options[operation]!(value);
    if (operation === 'output') return new Response('{"type":"exit","code":0}\n', { status: 200 });
    return new Response(null, { status: 204 });
  };
  return { fetch: request, calls };
}

const ownerA = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const ownerB = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const namespace = (owner: string) =>
  `sk-${createHash('sha256').update(owner).digest('hex').slice(0, 24)}`;

async function cloudflareFixture() {
  const root = await mkdtemp('/tmp/otto-cloudflare-adapters-');
  const socketPath = join(root, 'control.sock');
  const calls: Array<{ namespace: string; method: string; input?: unknown }> = [];
  const launches: Array<{
    owner: string;
    role: string;
    generation: string;
    threadId?: string;
    connected?: number;
    session?: boolean;
    frames: string[];
  }> = [];
  let hold:
    { entered: ReturnType<typeof deferred>; release: ReturnType<typeof deferred> } | undefined;
  let failedDisposals = 0;
  let brokenRole: 'browser' | 'workspace' | undefined;
  const worker = await startContainerBrowserWorker({
    socketPath,
    dataRoot: root,
    createComputer: (directory) => {
      const selected = basename(directory);
      return {
        ...fakeComputer(),
        act: async (_threadId, input, signal) => {
          calls.push({ namespace: selected, method: 'act', input });
          if (hold) {
            const waiting = hold;
            waiting.entered.resolve();
            await new Promise<void>((resolve) =>
              signal?.addEventListener('abort', () => resolve(), { once: true }),
            );
            await waiting.release.promise;
            throw new Error('Synthetic cancellation');
          }
          return { text: selected, url: input.url ?? 'https://example.test/' };
        },
        screenshot: async () => Buffer.from(selected),
        injectCredentials: async (input) => {
          calls.push({ namespace: selected, method: 'credentials', input });
          return { status: 'submitted' };
        },
        currentPage: async () => ({ origin: 'https://example.test', url: 'https://example.test/' }),
        hold: async (threadId, until) => {
          calls.push({ namespace: selected, method: 'hold', input: { threadId, until } });
        },
        dispose: async () => {
          calls.push({ namespace: selected, method: 'dispose' });
          if (failedDisposals > 0) {
            failedDisposals--;
            throw new Error('Synthetic private cleanup failure');
          }
        },
      } satisfies Computer;
    },
  });
  const options = (ownerId: string) => ({
    ownerId,
    generation: '17',
    workspaceRoot: join(root, 'roots', ownerId),
    drainTimeoutMs: 500,
    launch: ((input) => {
      const record = {
        owner: ownerId,
        role: input.role,
        generation: input.generation,
        threadId: input.threadId,
        connected: input.connected,
        session: input.session,
        frames: [] as string[],
      };
      launches.push(record);
      if (brokenRole === input.role) {
        const child = Object.assign(new EventEmitter(), {
          stdin: new PassThrough(),
          stdout: new PassThrough(),
          stderr: new PassThrough(),
          kill: () => true,
        });
        queueMicrotask(() => {
          input.onUncertain();
          child.emit('error', new Error('Synthetic private transport detail'));
        });
        return child as CommandProcess;
      }
      if (input.role === 'workspace') {
        assert.ok(input.threadId);
        const directory = join(root, 'workspaces', ownerId, input.threadId);
        mkdirSync(directory, { recursive: true });
        const child = spawn('python3', ['-u', '-c', workspaceCommandProgram], {
          cwd: directory,
          env: { PATH: process.env.PATH },
          stdio: 'pipe',
        });
        const write = child.stdin.write.bind(child.stdin);
        child.stdin.write = ((chunk: Buffer | string, ...args: unknown[]) => {
          record.frames.push(chunk.toString());
          return Reflect.apply(write, child.stdin, [chunk, ...args]);
        }) as typeof child.stdin.write;
        return child;
      }
      const child = Object.assign(new EventEmitter(), {
        stdin: new PassThrough(),
        stdout: new PassThrough(),
        stderr: new PassThrough(),
        kill() {
          this.stdin.destroy();
          return true;
        },
      });
      child.stdin.on('data', (chunk: Buffer) => record.frames.push(chunk.toString()));
      void runBrowserBridge({ input: child.stdin, output: child.stdout, socketPath }).then(
        (code) => {
          child.stdout.end();
          child.stderr.end();
          child.emit('close', code);
        },
      );
      return child as CommandProcess;
    }) satisfies NonNullable<Parameters<typeof createCloudflareAdapters>[0]['launch']>,
  });
  return {
    root,
    calls,
    launches,
    options,
    hold() {
      hold = { entered: deferred(), release: deferred() };
      return hold;
    },
    failDisposal() {
      failedDisposals++;
    },
    breakRole(role?: 'browser' | 'workspace') {
      brokenRole = role;
    },
    async close() {
      hold?.release.resolve();
      await worker.close();
      await rm(root, { recursive: true, force: true });
    },
  };
}

test('Cloudflare adapters bind owner namespaces and generations while keeping browser and workspace traffic separate', async () => {
  const f = await cloudflareFixture();
  const input = f.options(ownerA);
  const a = createCloudflareAdapters(input);
  const b = createCloudflareAdapters(f.options(ownerB));
  input.ownerId = ownerB;
  input.generation = '99';
  try {
    assert.equal(
      (await a.computer.act('same-task', { action: 'open', url: 'https://example.test/' })).text,
      namespace(ownerA),
    );
    assert.equal(
      (await b.computer.act('same-task', { action: 'snapshot' })).text,
      namespace(ownerB),
    );
    await a.computer.injectCredentials({
      threadId: 'same-task',
      origin: 'https://example.test',
      password: 'synthetic-browser-only',
    });
    const session = (adapters: typeof a, owner: string) =>
      adapters.workspace.open({
        threadId: 'same-task',
        workspacePath: join(f.root, 'roots', owner, 'same-task'),
        signal: new AbortController().signal,
      });
    await execute(session(a, ownerA), 'printf owner-a > retained');
    assert.equal(
      await execute(session(b, ownerB), 'test ! -e retained && printf owner-b'),
      'owner-b',
    );
    assert.equal(await execute(session(a, ownerA), 'cat retained'), 'owner-a');
    assert.ok(f.launches.every((call) => call.generation === '17'));
    assert.ok(
      f.launches
        .filter((call) => call.role === 'workspace')
        .every(
          (call) =>
            call.threadId === 'same-task' &&
            !call.frames.join('').includes('synthetic-browser-only'),
        ),
    );
    assert.equal(
      f.calls.find((call) => call.method === 'credentials')?.namespace,
      namespace(ownerA),
    );
    assert.throws(
      () =>
        a.workspace.open({
          threadId: 'same-task',
          workspacePath: join(f.root, 'roots', ownerB, 'same-task'),
          signal: new AbortController().signal,
        }),
      /configured root/,
    );
  } finally {
    await Promise.all([
      a.computer.dispose(),
      b.computer.dispose(),
      a.workspace.dispose(),
      b.workspace.dispose(),
    ]);
    await f.close();
  }
});

test('Cloudflare connected CLI commands use the connected path with one secret and a private home', async () => {
  const f = await cloudflareFixture();
  const adapters = createCloudflareAdapters(f.options(ownerA));
  try {
    assert.equal(adapters.workspace.connectedCliAvailable, true);
    const session = adapters.workspace.open({
      threadId: 'same-task',
      workspacePath: join(f.root, 'roots', ownerA, 'same-task'),
      signal: new AbortController().signal,
    });
    const cli = await sealedCli(join(f.root, 'workspaces', ownerA, 'same-task'));
    const result = await session.runConnectedCli!(
      cli,
      [
        'sh',
        '-c',
        'printf "%s %s %s" "$SYNTHETIC_API_KEY" "$([ "$(pwd -P)" = "$(cd "$HOME" && pwd -P)" ] && echo True)" "$([ "$XDG_CONFIG_HOME" = "$HOME/.config" ] && echo True)"',
      ],
      { SYNTHETIC_API_KEY: 'synthetic-connected-value' },
      5,
    );
    assert.deepEqual(result, { exitCode: 0, output: 'synthetic-connected-value True True' });
    await execute(session, 'printf model');
    assert.deepEqual(
      f.launches.map((launch) => [launch.connected, launch.session]),
      [
        [connectedUser(cli), undefined],
        [undefined, undefined],
      ],
    );
    assert.ok(f.launches[0]!.frames.join('').includes('synthetic-connected-value'));
    assert.equal(f.launches[1]!.frames.join('').includes('synthetic-connected-value'), false);
  } finally {
    await adapters.workspace.dispose();
    await f.close();
  }
});

test('Cloudflare browser holds reach a running browser only and never start one', async () => {
  const f = await cloudflareFixture();
  let live = true;
  const statuses: Request[] = [];
  const adapters = createCloudflareAdapters({
    ...f.options(ownerA),
    fetch: async (input, init) => {
      statuses.push(new Request(input, init));
      return Response.json({ live });
    },
  });
  try {
    await adapters.computer.hold('same-task', Date.now() + 60_000);
    assert.equal(statuses.length + f.launches.length, 0);
    await adapters.computer.act('same-task', { action: 'open', url: 'https://example.test/' });
    await adapters.computer.hold('same-task', 123);
    live = false;
    await adapters.computer.hold('same-task', null);
    assert.deepEqual(
      f.calls.filter((call) => call.method === 'hold').map((call) => call.input),
      [{ threadId: 'same-task', until: 123 }],
    );
    assert.equal(f.launches.length, 2);
    assert.deepEqual(
      statuses.map((request) => [
        request.method,
        request.url,
        request.headers.get('x-otto-generation'),
        request.headers.get('x-otto-computer-role'),
      ]),
      Array(2).fill(['GET', 'http://otto.computer/v1/status', '17', 'browser']),
    );
  } finally {
    await adapters.computer.dispose();
    await f.close();
  }
});

test('browser disposal drains cancelled work and failed cleanup remains retryable', async () => {
  const f = await cloudflareFixture();
  const adapters = createCloudflareAdapters(f.options(ownerA));
  const held = f.hold();
  const rejected = assert.rejects(
    adapters.computer.act('task', { action: 'snapshot' }),
    /cancelled/,
  );
  try {
    await held.entered.promise;
    f.failDisposal();
    let settled = false;
    const first = assert.rejects(adapters.computer.dispose(), /could not complete/).finally(() => {
      settled = true;
    });
    await delay(20);
    assert.equal(settled, false);
    held.release.resolve();
    await rejected;
    await first;
    await adapters.computer.dispose();
    const launches = f.launches.length;
    await assert.rejects(adapters.computer.act('later', { action: 'snapshot' }), /unavailable/);
    assert.equal(f.launches.length, launches);
    assert.equal(f.calls.filter((call) => call.method === 'dispose').length, 2);
  } finally {
    held.release.resolve();
    await adapters.workspace.dispose();
    await f.close();
  }
});

test('Cloudflare browser recovers only after an acknowledged explicit reopen', async () => {
  const f = await cloudflareFixture();
  const adapters = createCloudflareAdapters(f.options(ownerA));
  try {
    await adapters.computer.act('task', { action: 'snapshot' });
    f.breakRole('browser');
    await assert.rejects(
      adapters.computer.act('task', { action: 'click', selector: '#submit' }),
      /did not finish safely/,
    );
    f.breakRole();
    const launches = f.launches.length;
    await assert.rejects(adapters.computer.act('task', { action: 'snapshot' }), /unavailable/);
    assert.equal(f.launches.length, launches);
    assert.equal(
      (await adapters.computer.act('task', { action: 'open', url: 'https://example.test/' })).text,
      namespace(ownerA),
    );
    assert.deepEqual(
      f.calls.map(({ method }) => method),
      ['act', 'dispose', 'act'],
    );
  } finally {
    f.breakRole();
    await Promise.all([adapters.computer.dispose(), adapters.workspace.dispose()]);
    await f.close();
  }
});

test(
  'Cloudflare command transport preserves bytes and serializes input across delayed creation',
  { timeout: 5000 },
  async () => {
    const creation = deferred();
    const input = deferred();
    const fixture = await httpFixture({ create: creation.promise, firstInput: input.promise });
    try {
      const command = launch({
        role: 'workspace',
        threadId: 'task-123',
        origin: fixture.origin,
      });
      command.process.stdin.write('héllo ');
      command.process.stdin.write(Buffer.from('🌍'));
      command.process.stdin.end(Buffer.from([0, 255, 10]));
      await fixture.created;
      assert.equal(fixture.calls.length, 1);
      creation.resolve();
      const output = await fixture.output;
      await fixture.firstInput;
      assert.equal(fixture.calls.filter((call) => call.path.endsWith('/input')).length, 1);
      assert.equal(
        fixture.calls.some((call) => call.path.endsWith('/end')),
        false,
      );
      input.resolve();
      await fixture.ended;
      const unicode = Buffer.from('olá 🌍');
      output.write(frame('stdout', unicode.subarray(0, 6)));
      output.write(frame('stdout', unicode.subarray(6)));
      output.write(frame('stderr', 'aviso'));
      output.end('{"type":"exit","code":7}\n');
      assert.equal(await command.completed, 'close');
      assert.deepEqual(command.closes, [7]);
      assert.deepEqual(command.errors, []);
      assert.equal(command.uncertain(), 0);
      assert.deepEqual(Buffer.concat(command.stdout), unicode);
      assert.equal(Buffer.concat(command.stderr).toString(), 'aviso');
      assert.deepEqual(
        Buffer.concat(
          fixture.calls.filter((call) => call.path.endsWith('/input')).map((call) => call.body),
        ),
        Buffer.concat([Buffer.from('héllo 🌍'), Buffer.from([0, 255, 10])]),
      );
      const created = JSON.parse(fixture.calls[0].body.toString());
      assert.deepEqual(Object.keys(created).sort(), ['id', 'role', 'threadId']);
      assert.match(created.id, /^[0-9a-f-]{36}$/);
      assert.equal(created.role, 'workspace');
      assert.equal(created.threadId, 'task-123');
      assert.ok(fixture.calls.every((call) => call.headers['x-otto-generation'] === '17'));
      assert.ok(fixture.calls.slice(1).every((call) => call.path.includes(created.id)));
      assert.equal(command.process.stdin.destroyed, true);
    } finally {
      creation.resolve();
      input.resolve();
      await fixture.close();
    }
  },
);

test(
  'Cloudflare rejects malformed, oversized, missing and trailing output without a clean close',
  { timeout: 10000 },
  async (t) => {
    const cases: Array<[string, () => Response]> = [
      ['malformed JSON', () => new Response('synthetic private contents\n')],
      ['invalid UTF-8', () => new Response(new Uint8Array([255, 10]))],
      ['oversized line', () => new Response('x'.repeat(22_001))],
      ['oversized chunk', () => new Response(frame('stdout', Buffer.alloc(16 * 1024 + 1)))],
      ['invalid base64', () => new Response('{"type":"stdout","data":"secret!"}\n')],
      ['noncanonical base64', () => new Response('{"type":"stdout","data":"YR=="}\n')],
      ['extra fields', () => new Response('{"type":"exit","code":0,"private":"value"}\n')],
      ['noninteger exit', () => new Response('{"type":"exit","code":1.5}\n')],
      ['missing exit', () => new Response(frame('stdout', 'partial'))],
      ['missing newline', () => new Response('{"type":"exit","code":0}')],
      ['trailing bytes', () => new Response('{"type":"exit","code":0}\nprivate')],
      [
        'trailing frame',
        () => new Response('{"type":"exit","code":0}\n' + frame('stdout', 'late')),
      ],
      ['failed HTTP', () => new Response('synthetic private contents', { status: 503 })],
      [
        'lost stream',
        () =>
          new Response(
            new ReadableStream({
              start(controller) {
                controller.error(new Error('synthetic secret'));
              },
            }),
          ),
      ],
    ];
    for (const [name, response] of cases) {
      await t.test(name, async () => {
        const fixture = fetchFixture({ output: response });
        const command = launch({ fetch: fixture.fetch });
        assert.equal(await command.completed, 'error');
        await delay(0);
        assert.equal(command.uncertain(), 1);
        assert.deepEqual(
          command.errors.map((error) => error.message),
          [publicError],
        );
        assert.deepEqual(command.closes, []);
        assert.equal(command.process.stdin.destroyed, true);
        assert.equal(fixture.calls.length, 2);
      });
    }
  },
);

test(
  'Cloudflare normalizes creation and control failures without retries',
  { timeout: 10000 },
  async (t) => {
    for (const name of [
      'creation throw',
      'creation status',
      'creation identity',
      'creation limit',
      'input',
      'end',
      'kill',
    ] as const) {
      await t.test(name, async () => {
        const output = deferred<Response>();
        const fixture = fetchFixture({
          create:
            name === 'creation throw'
              ? () => {
                  throw new Error('synthetic server secret');
                }
              : name === 'creation status'
                ? () => Response.json({ id: 'private' })
                : name === 'creation identity'
                  ? () => Response.json({ id: 'wrong' }, { status: 201 })
                  : name === 'creation limit'
                    ? () => new Response('x'.repeat(1025), { status: 201 })
                    : undefined,
          output: () => output.promise,
          input:
            name === 'input' ? () => new Response('synthetic secret', { status: 500 }) : undefined,
          end: name === 'end' ? () => new Response('synthetic secret', { status: 200 }) : undefined,
          kill:
            name === 'kill'
              ? () => {
                  throw new Error('synthetic server secret');
                }
              : undefined,
        });
        const command = launch({
          fetch: fixture.fetch,
          onUncertain: () => {
            throw new Error('synthetic callback secret');
          },
        });
        const callbacks: Array<string | undefined> = [];
        if (name === 'input')
          command.process.stdin.write('private input', (error) => callbacks.push(error?.message));
        if (name === 'end') command.process.stdin.end();
        if (name === 'kill') command.process.kill('SIGKILL');
        assert.equal(await command.completed, 'error');
        output.resolve(new Response('{"type":"exit","code":0}\n'));
        await delay(0);
        assert.deepEqual(
          command.errors.map((error) => error.message),
          [publicError],
        );
        assert.deepEqual(command.closes, []);
        assert.equal(command.uncertain(), 1);
        if (name === 'input') assert.deepEqual(callbacks, [publicError]);
        for (const path of new Set(fixture.calls.map((call) => new URL(call.url).pathname)))
          assert.equal(
            fixture.calls.filter((call) => new URL(call.url).pathname === path).length,
            1,
          );
      });
    }
  },
);

test('Cloudflare rejects unsupported origins, identities and task paths before contacting transport', () => {
  const invalid: Array<Partial<Parameters<typeof launchCloudflareCommand>[0]>> = [
    { origin: 'https://otto.computer' },
    { origin: 'http://otto.computer:8080' },
    { origin: 'http://example.test' },
    { origin: 'http://user:password@localhost' },
    { origin: 'http://localhost/path' },
    { origin: 'http://localhost/?secret=value' },
    { origin: 'http://localhost/#private' },
    { generation: '0' },
    { generation: '-1' },
    { generation: '01' },
    { role: 'workspace' },
    { role: 'workspace', threadId: '../private' },
  ];
  for (const value of invalid) {
    assert.throws(
      () =>
        launchCloudflareCommand({ role: 'browser', generation: '1', onUncertain() {}, ...value }),
      { message: 'The remote computer configuration is invalid.' },
    );
  }
});

// Runtime host: clean-stop receipts and shutdown confirmation.

test('clean-stop inspection refuses stale, malformed, oversized and failed receipts without exposing their content', async () => {
  const ownerId = randomUUID();
  for (const response of [
    () => Response.json({ generation: '13', stopped: true }),
    () => Response.json({ generation: '12', stopped: true, foreign: 'synthetic-private-value' }),
    () => Response.json({ generation: '12', stopped: true }, { status: 503 }),
    () => new Response('x'.repeat(4097)),
    () => new Response(new Uint8Array([0xff])),
    () => new Response('not-json'),
  ]) {
    const transport = createCloudflareRuntimeTransport({ fetch: async () => response() });
    await assert.rejects(transport.deploymentStopped!(ownerId, '12'), refused);
  }
  const transport = createCloudflareRuntimeTransport({
    fetch: async () => Response.json({ generation: '12', stopped: false }),
  });
  assert.equal(await transport.deploymentStopped!(ownerId, '12'), false);
});

test('deployment preparation keeps busy distinct from unsafe and requires bounded exact-generation clean stop acknowledgement', async () => {
  const ownerId = randomUUID();
  const input = {
    nonce: randomUUID(),
    targetRelease: 'a'.repeat(40),
    deadline: Date.now() + 30_000,
  };
  for (const [status, value, expected] of [
    [200, { ok: true, generation: '3', clean: true, stopped: true }, 'stopped'],
    [409, { ok: false, generation: '3', status: 'busy' }, 'busy'],
    [409, { ok: false, generation: '3', status: 'unsafe' }, undefined],
    [200, { ok: true, generation: '4', clean: true, stopped: true }, undefined],
    [200, { ok: true, generation: '3', clean: false, stopped: true }, undefined],
  ] as const) {
    const transport = createCloudflareRuntimeTransport({
      fetch: async (url, options) => {
        assert.equal(url, 'http://otto.runtime/runtime/prepare-deployment');
        assert.deepEqual(JSON.parse(String(options?.body)), { ownerId, generation: '3', ...input });
        return Response.json(value, { status });
      },
    });
    const result = transport.prepareDeployment!(ownerId, '3', input);
    if (expected) assert.equal(await result, expected);
    else await assert.rejects(result);
  }
});

test('computer shutdown refuses configurable remote destinations, invalid generations and unconfirmed results', async () => {
  for (const change of [
    { endpoint: 'https://example.test/v1/stopped' },
    { generation: '0' },
    { generation: '01' },
    { generation: 'bad' },
  ])
    assert.throws(() =>
      createComputerShutdownConfirmation({
        endpoint: 'http://otto.computer/v1/stopped',
        generation: '1',
        ...change,
      }),
    );
  for (const response of [
    () => Response.json({ ok: false }),
    () => Response.json({ ok: true, private: 'detail' }),
    () => Response.json({ private: 'detail' }, { status: 503 }),
    () => {
      throw new Error('secret provider failure');
    },
  ]) {
    const confirm = createComputerShutdownConfirmation({
      endpoint: 'http://otto.computer/v1/stopped',
      generation: '1',
      fetch: (async () => response()) as typeof fetch,
    });
    await assert.rejects(confirm(), refused);
  }
});

// Hosted development: no provider keys in the local plan and a narrow webhook relay.

const values = () => ({
  DATABASE_URL: 'postgresql://fixture:synthetic@localhost:54331/hosted',
  OTTO_MASTER_KEY: randomBytes(32).toString('base64'),
  BETTER_AUTH_SECRET: 'synthetic-auth-secret-with-32-characters',
  GOOGLE_CLIENT_ID: 'synthetic-client',
  GOOGLE_CLIENT_SECRET: 'synthetic-google-secret',
});

test('local Cloudflare uses development bindings and private runtime configuration without provider keys at image build', () => {
  const input = {
    ...values(),
    COMPUTER_PROVIDER: 'cloudflare',
    CLOUDFLARE_API_TOKEN: 'private-deployment-token',
    GOOGLE_CLIENT_SECRET: "synthetic's # quoted \\\\ value\nnext line",
    OTTO_IMAGE_RELEASE: 'untrusted-image-release',
  };
  const environment = hostedEnvironment(input, {
    root: '/fixture',
    inherited: { PATH: '/bin', OPENAI_API_KEY: 'inherited-secret' },
  });
  const config = {
    main: 'src/worker.ts',
    assets: { directory: '../../dist/web' },
    account_id: 'production-account',
    env: {
      development: {
        name: 'development',
        containers: [
          { class_name: 'GatewayContainer', image: './Dockerfile', image_build_context: '../..' },
          { class_name: 'TenantContainer', image: './Dockerfile', image_build_context: '../..' },
          {
            class_name: 'BrowserComputerContainer',
            image: './Dockerfile.browser',
            image_build_context: '../..',
          },
          {
            class_name: 'WorkspaceComputerContainer',
            image: './Dockerfile.workspace',
            image_build_context: '../..',
          },
        ],
        r2_buckets: [{ binding: 'TENANT_FILES', bucket_name: 'development-files' }],
      },
      production: {
        name: 'production',
        containers: [],
        r2_buckets: [{ bucket_name: 'production-files' }],
      },
    },
  };
  const localRelease = 'a'.repeat(40);
  const plan = cloudflareLocalPlan(environment, config, '/fixture', localRelease);
  assert.equal(plan.config.account_id, undefined);
  assert.equal(plan.config.env, undefined);
  assert.equal(plan.config.containers[0].image_vars.OTTO_RELEASE, localRelease);
  assert.equal(plan.config.containers[1].image_vars.OTTO_RELEASE, localRelease);
  assert.equal(plan.config.containers[2].image_vars, undefined);
  assert.equal(plan.config.containers[3].image_vars, undefined);
  assert.doesNotMatch(JSON.stringify(plan.config), /synthetic|secret|production/);
  const privateValues = JSON.parse(plan.secret);
  const encodedValues = parseEnv(plan.devVars).GATEWAY_ENV;
  assert.ok(encodedValues);
  assert.deepEqual(JSON.parse(encodedValues), privateValues);
  assert.equal(privateValues.GOOGLE_CLIENT_SECRET, input.GOOGLE_CLIENT_SECRET);
  assert.equal(privateValues.DATABASE_URL, input.DATABASE_URL);
  assert.equal(privateValues.OTTO_RELEASE, localRelease);
  assert.equal(privateValues.OTTO_IMAGE_RELEASE, undefined);
  for (const key of ['CLOUDFLARE_API_TOKEN', 'DOTENV_CONFIG_PATH', 'PATH', 'OPENAI_API_KEY'])
    assert.equal(privateValues[key], undefined);
  assert.deepEqual(plan.environment, { PATH: '/bin' });
  assert.throws(() =>
    cloudflareLocalPlan({ ...environment, OTTO_ENVIRONMENT: 'production' }, config),
  );
  assert.throws(() =>
    cloudflareLocalPlan({ ...environment, OTTO_PUBLIC_URL: 'https://otto.example.test' }, config),
  );
});

test('webhook relay allowlist excludes application, authentication, encoded and normalized paths', () => {
  const token = 'a'.repeat(43);
  for (const path of [
    '/api/session',
    '/api/login',
    '/api/internal/channels/claim',
    '/api/state',
    '/',
    '/api/%77ebhooks/composio',
    '/api/webhooks/composio/../composio',
    '//api/webhooks/composio',
    '/api/webhooks/composio#private',
    '/api/webhooks/telegram/not-a-token',
  ])
    assert.equal(webhookRoute('POST', path), false, path);
  assert.equal(webhookRoute('POST', '/api/webhooks/composio'), true);
  assert.equal(webhookRoute('GET', '/api/webhooks/composio'), false);
  assert.equal(webhookRoute('POST', `/api/webhooks/telegram/${token}`), true);
  assert.equal(webhookRoute('GET', `/api/webhooks/telegram/${token}`), false);
  assert.equal(webhookRoute('GET', `/api/webhooks/whatsapp/${token}?hub.challenge=123`), true);
  for (const target of [
    'https://public.example.test',
    'http://localhost:4320',
    'http://localhost:4318',
    'http://localhost:4330/private',
    'http://user:secret@localhost:4330',
  ])
    assert.throws(() => createWebhookRelay({ target }));
});
