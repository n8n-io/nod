import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp, mkdir, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { PassThrough } from 'node:stream';
import { setTimeout as delay } from 'node:timers/promises';
import test from 'node:test';
import type { Computer } from '../src/ports/computer.ts';
import type {
  ComputerAllocation,
  ComputerAllocationStore,
} from '../src/ports/computer-allocation.ts';
import { createE2BAdapters } from '../src/providers/e2b/index.ts';
import { createE2BAllocation } from '../src/providers/e2b/allocation.ts';
import type { E2BClient, E2BSandbox } from '../src/providers/e2b/client.ts';
import { runBrowserBridge } from '../src/providers/container-browser/bridge.ts';
import { startContainerBrowserWorker } from '../src/providers/container-browser/worker.ts';
import { workspaceCommandProgram } from '../src/providers/docker/command.ts';

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

async function fixture() {
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
      let session: ReturnType<NonNullable<Computer['currentSession']>>;
      return {
        currentSession: () => session,
        status: () => 'Synthetic browser',
        act: async (id, input, signal) => {
          session = { taskId: id, lastActivityAt: new Date().toISOString() };
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
            candidates: [],
          };
        },
        screenshot: async () => Buffer.from('masked image'),
        signInScreenshot: async () => Buffer.from('private image'),
        injectCredentials: async (input) => {
          calls.push({ method: 'credentials', input });
          return { status: 'submitted' };
        },
        inspectLogin: async () => ({
          origin: 'https://example.test',
          url: 'https://example.test/login',
          fields: [],
          methods: [],
        }),
        selectLoginMethod: async () => {},
        hold: async () => {},
        close: async () => {},
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
  const f = await fixture();
  const first = f.create('owner-one');
  const second = f.create('owner-two');
  try {
    assert.equal(
      (await first.computer.act('task-one', { action: 'open', url: 'https://example.test/' })).text,
      'Synthetic page',
    );
    await first.computer.injectCredentials({
      taskId: 'task-one',
      origin: 'https://example.test',
      password: 'synthetic private value',
    });
    assert.equal((await first.computer.screenshot('task-one'))?.toString(), 'masked image');
    assert.equal((await first.computer.signInScreenshot!('task-one'))?.toString(), 'private image');
    const workspace = first.workspace.open({
      taskId: 'task-one',
      workspacePath: join(f.root, 'workspaces/task-one'),
      signal: new AbortController().signal,
    });
    assert.equal(await workspace.execute('printf "héllo"'), 'héllo');
    assert.equal(first.workspace.connectedCliAvailable, true);
    assert.deepEqual(
      await workspace.executeProgram?.(
        'python3',
        ['-c', 'import os;print(os.environ.get("FIXTURE_TOKEN")=="synthetic-private-token")'],
        { FIXTURE_TOKEN: 'synthetic-private-token' },
      ),
      { exitCode: 0, output: 'True\n' },
    );
    const connectedAbort = new AbortController();
    const connected = first.workspace.open({
      taskId: 'task-one',
      workspacePath: join(f.root, 'workspaces/task-one'),
      signal: connectedAbort.signal,
    });
    const stopped = connected.executeProgram!('python3', ['-c', 'import time;time.sleep(30)'], {
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
          request.role === 'connected' && request.command.includes('cd /home/otto-connected'),
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
    assert.equal(first.computer.currentSession!()?.taskId, 'task-one');
    assert.equal(second.computer.currentSession!()?.taskId, 'task-two');
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

test('E2B browser cancellation waits for terminal worker acknowledgement', async () => {
  const f = await fixture();
  const adapter = f.create('owner');
  let complete!: () => void;
  const drained = new Promise<void>((resolve) => {
    complete = resolve;
  });
  f.holdAction(() => drained);
  const abort = new AbortController();
  let finished = false;
  const operation = adapter.computer
    .act('task', { action: 'snapshot' }, abort.signal)
    .finally(() => {
      finished = true;
    });
  const rejected = assert.rejects(operation, /cancelled/);
  try {
    for (let attempt = 0; attempt < 400 && !f.calls.length && !finished; attempt++) await delay(5);
    assert.ok(
      f.calls.some((call) => call.method === 'act'),
      'The browser action reached the worker.',
    );
    abort.abort();
    await delay(20);
    assert.equal(finished, false);
    complete();
    await rejected;
  } finally {
    complete();
    await adapter.computer.dispose();
    await adapter.workspace.dispose();
    await f.close();
  }
});

test('E2B pause and resume retain allocation generation while unused roles allocate nothing', async () => {
  const f = await fixture();
  const first = f.create('owner');
  try {
    await first.computer.act('task', { action: 'snapshot' });
    const before = structuredClone(f.state.records.get('owner/computer')!);
    await first.computer.dispose();
    await first.workspace.dispose();
    assert.equal(f.state.records.size, 1);
    assert.equal(f.state.records.get('owner/computer')?.leaseId, null);
    assert.equal(f.pauses(), 1);
    const second = f.create('owner');
    await second.computer.act('task', { action: 'snapshot' });
    assert.equal(f.connections(), 1);
    assert.equal(f.state.records.get('owner/computer')?.resourceId, before.resourceId);
    assert.equal(f.state.records.get('owner/computer')?.generation, before.generation);
    await second.computer.dispose();
    await second.workspace.dispose();
  } finally {
    await f.close();
  }
});

test('disposing an unused E2B browser stops its status without allocating a sandbox', async () => {
  const f = await fixture();
  const adapter = f.create('unused-owner');
  try {
    await adapter.computer.dispose();
    assert.equal(adapter.computer.status(), 'Workspace browser is stopped.');
    assert.equal(adapter.computer.currentSession?.(), undefined);
    await assert.rejects(adapter.computer.act('task', { action: 'snapshot' }), /unavailable/);
    assert.equal(adapter.computer.status(), 'Workspace browser is stopped.');
    assert.equal(f.state.records.size, 0);
    assert.equal(f.requests.length, 0);
    await adapter.computer.dispose();
  } finally {
    await adapter.workspace.dispose();
    await f.close();
  }
});

test('E2B uncertain connections persist a fence and do not expose SDK errors', async () => {
  const f = await fixture();
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
      taskId: 'task',
      workspacePath: join(f.root, 'workspaces/task'),
      signal: new AbortController().signal,
    });
    await assert.rejects(workspace.execute('printf never'), /safely/);
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

test('E2B shell cancellation drains its TERM-resistant process group before returning', async () => {
  const f = await fixture();
  const adapter = f.create('owner');
  const abort = new AbortController();
  const workspace = adapter.workspace.open({
    taskId: 'task',
    workspacePath: join(f.root, 'workspaces/task'),
    signal: abort.signal,
  });
  const operation = workspace.execute(
    'python3 -c "import signal,time;signal.signal(signal.SIGTERM,signal.SIG_IGN);print(1,flush=True);time.sleep(60)"',
  );
  const rejected = assert.rejects(operation, /cancelled/);
  try {
    let ready = false;
    for (let attempt = 0; attempt < 400; attempt++) {
      ready = f.requests.some((request) => request.output.includes('"data": "MQo="'));
      if (ready) break;
      await delay(5);
    }
    assert.equal(ready, true);
    const start = Date.now();
    abort.abort();
    await rejected;
    assert.ok(Date.now() - start >= 1900);
    assert.equal(f.state.records.get('owner/computer')?.state, 'ready');
  } finally {
    await adapter.workspace.dispose();
    await adapter.computer.dispose();
    await f.close();
  }
});

test('E2B configuration and workspace paths reject traversal before allocating a sandbox', async () => {
  const f = await fixture();
  const adapter = f.create('owner');
  try {
    assert.throws(
      () =>
        adapter.workspace.open({
          taskId: '../foreign',
          workspacePath: '/tmp/foreign',
          signal: new AbortController().signal,
        }),
      /identifier/,
    );
    assert.throws(
      () =>
        adapter.workspace.open({
          taskId: 'task',
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

test('E2B failed pause retains ownership and allows a confirmed cleanup retry', async () => {
  const state = allocationStore();
  let pauses = 0;
  const sandbox: E2BSandbox = {
    id: 'synthetic',
    ready: async () => {},
    start: async () => {
      throw new Error();
    },
    keepAlive: async () => {},
    pause: async () => {
      if (++pauses === 1) throw new Error('synthetic raw failure');
      return true;
    },
  };
  const client: E2BClient = { create: async () => sandbox, connect: async () => sandbox };
  const allocation = createE2BAllocation({
    ownerId: 'owner',
    role: 'browser',
    templateId: 'browser',
    store: state.store,
    client,
  });
  await allocation.get();
  await assert.rejects(allocation.dispose(), /recovery/);
  assert.equal(state.records.get('owner/browser')?.state, 'uncertain');
  assert.ok(state.records.get('owner/browser')?.leaseId);
  await allocation.dispose();
  assert.equal(pauses, 2);
  assert.equal(state.records.get('owner/browser')?.state, 'ready');
  assert.equal(state.records.get('owner/browser')?.leaseId, null);
});

test('E2B missing terminal acknowledgement stays fenced after command transport exits', async () => {
  const f = await fixture();
  const adapter = f.create('owner');
  const workspace = adapter.workspace.open({
    taskId: 'task',
    workspacePath: join(f.root, 'workspaces/task'),
    signal: new AbortController().signal,
  });
  try {
    assert.equal(await workspace.execute('printf ready'), 'ready');
    f.loseAcknowledgement();
    await assert.rejects(workspace.execute('printf never'), /stop safely/);
    await delay(5);
    assert.equal(f.state.records.get('owner/computer')?.state, 'uncertain');
    await adapter.computer.dispose();
    await assert.rejects(Promise.resolve(adapter.workspace.dispose()), /recovery/);
    assert.ok(f.state.records.get('owner/computer')?.leaseId);
  } finally {
    await f.close();
  }
});

test('E2B heartbeat preserves active requests and idle pause restores the same owned sandbox', async () => {
  const state = allocationStore();
  let keepAlives = 0;
  let pauses = 0;
  let connects = 0;
  const sandbox: E2BSandbox = {
    id: 'synthetic-idle',
    ready: async () => {},
    start: async () => {
      throw new Error();
    },
    keepAlive: async () => {
      keepAlives++;
    },
    pause: async () => {
      pauses++;
      return true;
    },
  };
  const allocation = createE2BAllocation({
    ownerId: 'owner',
    role: 'browser',
    templateId: 'browser',
    store: state.store,
    client: {
      create: async () => sandbox,
      connect: async () => {
        connects++;
        return sandbox;
      },
    },
    leaseMs: 300,
    idlePauseMs: 50,
  });
  let active: Awaited<ReturnType<typeof allocation.acquire>> | undefined;
  try {
    active = await allocation.acquire();
    const original = structuredClone(state.records.get('owner/browser'));
    await delay(150);
    assert.equal(pauses, 0);
    assert.ok(keepAlives >= 2);
    active.release();
    await delay(200);
    assert.equal(pauses, 1);
    const before = keepAlives;
    await delay(150);
    assert.equal(keepAlives, before);
    active = await allocation.acquire();
    assert.equal(connects, 1);
    assert.equal(active.sandbox.id, original!.resourceId);
    assert.equal(state.records.get('owner/browser')?.generation, original!.generation);
    active.release();
    await allocation.dispose();
    assert.equal(state.records.get('owner/browser')?.leaseId, null);
  } finally {
    active?.release();
    await allocation.dispose();
  }
});

test('E2B runtime recycling holds new requests until existing commands have drained', async () => {
  const state = allocationStore();
  let pauses = 0;
  let connects = 0;
  const sandbox: E2BSandbox = {
    id: 'synthetic-recycle',
    ready: async () => {},
    start: async () => {
      throw new Error();
    },
    keepAlive: async () => {},
    pause: async () => {
      pauses++;
      return true;
    },
  };
  const allocation = createE2BAllocation({
    ownerId: 'owner',
    role: 'workspace',
    templateId: 'shell',
    store: state.store,
    client: {
      create: async () => sandbox,
      connect: async () => {
        connects++;
        return sandbox;
      },
    },
    leaseMs: 300,
    idlePauseMs: 10_000,
    maxActiveMs: 300,
  });
  const active = await allocation.acquire();
  let second: Awaited<ReturnType<typeof allocation.acquire>> | undefined;
  try {
    await delay(350);
    let acquired = false;
    const pending = allocation.acquire().then((value) => {
      acquired = true;
      return value;
    });
    await delay(350);
    assert.equal(acquired, false);
    assert.equal(pauses, 0);
    assert.equal(state.records.get('owner/workspace')?.state, 'ready');
    active.release();
    second = await pending;
    assert.equal(pauses, 1);
    assert.equal(connects, 1);
    second.release();
    await allocation.dispose();
  } finally {
    active.release();
    second?.release();
    await allocation.dispose();
  }
});

test('an already paused E2B sandbox is a confirmed cleanup result', async () => {
  const state = allocationStore();
  const sandbox: E2BSandbox = {
    id: 'already-paused',
    ready: async () => {},
    start: async () => {
      throw new Error();
    },
    keepAlive: async () => {},
    pause: async () => false,
  };
  const allocation = createE2BAllocation({
    ownerId: 'owner',
    role: 'browser',
    templateId: 'browser',
    store: state.store,
    client: { create: async () => sandbox, connect: async () => sandbox },
  });
  await allocation.get();
  await allocation.dispose();
  assert.equal(state.records.get('owner/browser')?.leaseId, null);
});

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

test('E2B onboarding preparation shares one protected allocation with concurrent tool startup', async () => {
  const f = await fixture();
  const adapter = f.create('owner');
  const checking = deferred();
  const verified = deferred();
  f.readiness(async () => {
    checking.resolve();
    await verified.promise;
  });
  try {
    const preparations = [adapter.prepare(), adapter.prepare(), adapter.prepare()];
    await checking.promise;
    assert.equal(f.state.records.size, 1);
    const pending = f.state.records.get('owner/computer')!;
    assert.equal(pending.state, 'allocating');
    assert.ok(pending.resourceId);
    assert.equal(f.requests.length, 0);
    const browser = adapter.computer.act('task', { action: 'snapshot' });
    const workspace = adapter.workspace.open({
      taskId: 'task',
      workspacePath: join(f.root, 'workspaces/task'),
      signal: new AbortController().signal,
    });
    const shell = workspace.execute('printf prepared');
    verified.resolve();
    await Promise.all([...preparations, browser]);
    assert.equal(await shell, 'prepared');
    await adapter.prepare();
    assert.equal(f.state.records.size, 1);
    assert.equal(f.metadata.length, 1);
    assert.equal(f.readinessChecks(), 1);
    assert.equal(new Set(f.requests.map((request) => request.resourceId)).size, 1);
    assert.equal(f.state.records.get('owner/computer')?.state, 'ready');
  } finally {
    verified.resolve();
    await adapter.dispose();
    await f.close();
  }
});

test('E2B failed readiness preserves the allocated ID and fences both tools without creating a replacement', async () => {
  const f = await fixture();
  const adapter = f.create('owner');
  f.readiness(async () => {
    throw new Error('synthetic private readiness failure');
  });
  try {
    await assert.rejects(adapter.prepare(), {
      message: 'The remote computer needs recovery before continuing.',
    });
    await delay(0);
    const failed = structuredClone(f.state.records.get('owner/computer'));
    assert.equal(failed?.state, 'uncertain');
    assert.ok(failed.resourceId);
    assert.ok(failed.leaseId);
    await assert.rejects(adapter.computer.act('task', { action: 'snapshot' }), /safely/);
    const workspace = adapter.workspace.open({
      taskId: 'task',
      workspacePath: join(f.root, 'workspaces/task'),
      signal: new AbortController().signal,
    });
    await assert.rejects(workspace.execute('printf never'), /safely/);
    const replacement = f.create('owner');
    await assert.rejects(replacement.prepare(), /recovery/);
    await assert.rejects(replacement.dispose(), /recovery/);
    assert.equal(f.metadata.length, 1);
    assert.equal(f.connections(), 0);
    assert.equal(f.requests.length, 0);
    assert.equal(f.state.records.get('owner/computer')?.resourceId, failed.resourceId);
    await assert.rejects(adapter.resume(), /recovery/);
  } finally {
    await assert.rejects(adapter.dispose(), /recovery/);
    await f.close();
  }
});

test('E2B combined allocation leaves every legacy role untouched and refuses silent migration', async () => {
  for (const role of ['browser', 'workspace'] as const) {
    const f = await fixture();
    const legacy: ComputerAllocation = {
      ownerId: 'owner',
      role,
      provider: 'e2b',
      templateId: 'legacy',
      resourceId: 'legacy-sandbox',
      generation: 'legacy-generation',
      version: 1,
      state: 'ready',
      leaseId: null,
      leaseExpiresAt: null,
    };
    f.state.records.set('owner/' + role, legacy);
    const adapter = f.create('owner');
    try {
      await assert.rejects(adapter.prepare(), /recovery/);
      await assert.rejects(adapter.computer.act('task', { action: 'snapshot' }), /safely/);
      assert.deepEqual([...f.state.records.values()], [legacy]);
      assert.equal(f.metadata.length, 0);
      assert.equal(f.connections(), 0);
      assert.equal(f.requests.length, 0);
    } finally {
      await assert.rejects(adapter.dispose(), /recovery/);
      await f.close();
    }
  }
});

test('E2B individual capability disposal retains the shared lease until its peer has drained', async () => {
  for (const first of ['browser', 'workspace'] as const) {
    const f = await fixture();
    const adapter = f.create('owner');
    const workspace = adapter.workspace.open({
      taskId: 'task',
      workspacePath: join(f.root, 'workspaces/task'),
      signal: new AbortController().signal,
    });
    try {
      await adapter.prepare();
      const original = structuredClone(f.state.records.get('owner/computer'));
      if (first === 'browser') {
        await adapter.computer.act('task', { action: 'snapshot' });
        await adapter.computer.dispose();
        assert.equal(await workspace.execute('printf retained'), 'retained');
      } else {
        assert.equal(await workspace.execute('printf retained'), 'retained');
        await adapter.workspace.dispose();
        assert.equal(
          (await adapter.computer.act('task', { action: 'snapshot' })).text,
          'Synthetic page',
        );
      }
      assert.equal(f.pauses(), 0);
      assert.equal(f.state.records.get('owner/computer')?.leaseId, original?.leaseId);
      await adapter.dispose();
      await adapter.dispose();
      assert.equal(f.pauses(), 1);
      assert.equal(f.state.records.get('owner/computer')?.leaseId, null);
      await assert.rejects(adapter.prepare(), /stopped/);
    } finally {
      await adapter.dispose();
      await f.close();
    }
  }
});

test('E2B deployment pause waits for browser quiescence and SDK pause before a same-ID reversible resume', async () => {
  const f = await fixture();
  const adapter = f.create('owner');
  const closing = deferred();
  const closed = deferred();
  const pausing = deferred();
  const paused = deferred();
  f.browserDisposal(async () => {
    closing.resolve();
    await closed.promise;
  });
  f.pauseAction(async () => {
    pausing.resolve();
    await paused.promise;
  });
  const workspace = adapter.workspace.open({
    taskId: 'task',
    workspacePath: join(f.root, 'workspaces/task'),
    signal: new AbortController().signal,
  });
  try {
    await adapter.computer.act('task', { action: 'snapshot' });
    assert.equal(await workspace.execute('printf initial'), 'initial');
    const original = structuredClone(f.state.records.get('owner/computer'));
    let finished = false;
    const receipt = adapter.pause().then(() => {
      finished = true;
    });
    await closing.promise;
    assert.equal(finished, false);
    assert.equal(f.pauses(), 0);
    const requests = f.requests.length;
    await assert.rejects(adapter.computer.act('task', { action: 'snapshot' }), /unavailable/);
    await assert.rejects(workspace.execute('printf forbidden'), /paused/);
    await assert.rejects(adapter.prepare(), /stopped/);
    assert.equal(f.requests.length, requests);
    closed.resolve();
    await pausing.promise;
    assert.equal(finished, false);
    assert.equal(f.state.records.get('owner/computer')?.leaseId, original?.leaseId);
    paused.resolve();
    await receipt;
    await adapter.pause();
    assert.equal(f.pauses(), 1);
    assert.equal(adapter.computer.currentSession?.(), undefined);
    assert.equal('quiesce' in adapter.computer, false);
    await adapter.resume();
    await adapter.resume();
    assert.equal(f.connections(), 0);
    assert.equal(
      (await adapter.computer.act('task', { action: 'snapshot' })).text,
      'Synthetic page',
    );
    assert.equal(await workspace.execute('printf resumed'), 'resumed');
    assert.equal(f.connections(), 1);
    assert.equal(f.readinessChecks(), 2);
    assert.equal(f.state.records.get('owner/computer')?.resourceId, original?.resourceId);
    assert.equal(f.state.records.get('owner/computer')?.generation, original?.generation);
  } finally {
    closed.resolve();
    paused.resolve();
    await adapter.dispose();
    await f.close();
  }
});

test('E2B deployment pause refuses a held browser without closing it and resumes normal admission', async () => {
  const f = await fixture();
  const adapter = f.create('owner');
  let closed = false;
  f.browserDisposal(async () => {
    closed = true;
  });
  try {
    await adapter.computer.act('task', { action: 'snapshot' });
    f.browserHeld(true);
    await assert.rejects(adapter.pause(), /busy/);
    assert.equal(f.pauses(), 0);
    assert.equal(closed, false);
    assert.equal(f.state.records.get('owner/computer')?.state, 'ready');
    await adapter.resume();
    f.browserHeld(false);
    await adapter.computer.act('task', { action: 'snapshot' });
    await adapter.pause();
    assert.equal(closed, true);
    assert.equal(f.pauses(), 1);
    await adapter.dispose();
    assert.equal(f.pauses(), 1);
    assert.equal(f.state.records.get('owner/computer')?.leaseId, null);
  } finally {
    await adapter.dispose();
    await f.close();
  }
});

test('E2B deployment pause does not cancel an accepted browser request or acknowledge it as drained', async () => {
  const f = await fixture();
  const adapter = f.create('owner');
  const started = deferred();
  const finished = deferred();
  f.action(async () => {
    started.resolve();
    await finished.promise;
  });
  try {
    const operation = adapter.computer.act('task', { action: 'snapshot' });
    await started.promise;
    await assert.rejects(adapter.pause(), /busy/);
    assert.equal(f.pauses(), 0);
    finished.resolve();
    assert.equal((await operation).text, 'Synthetic page');
    await adapter.resume();
    await adapter.pause();
    assert.equal(f.pauses(), 1);
  } finally {
    finished.resolve();
    await adapter.dispose();
    await f.close();
  }
});

test('E2B failed pause prevents resume and new execution until an acknowledged terminal cleanup retry', async () => {
  const f = await fixture();
  const adapter = f.create('owner');
  let fail = true;
  f.pauseAction(async () => {
    if (fail) throw new Error('synthetic private pause failure');
  });
  try {
    await adapter.prepare();
    const original = structuredClone(f.state.records.get('owner/computer'));
    await assert.rejects(adapter.pause(), {
      message: 'The remote computer needs recovery before continuing.',
    });
    await assert.rejects(adapter.resume(), /recovery/);
    await assert.rejects(adapter.prepare(), /stopped/);
    assert.equal(f.state.records.get('owner/computer')?.state, 'uncertain');
    assert.equal(f.state.records.get('owner/computer')?.leaseId, original?.leaseId);
    await assert.rejects(adapter.dispose(), /recovery/);
    assert.equal(f.state.records.get('owner/computer')?.leaseId, original?.leaseId);
    fail = false;
    await adapter.dispose();
    assert.equal(f.state.records.get('owner/computer')?.resourceId, original?.resourceId);
    assert.equal(f.state.records.get('owner/computer')?.leaseId, null);
    assert.equal(f.state.records.get('owner/computer')?.state, 'ready');
    assert.equal(f.requests.length, 0);
  } finally {
    fail = false;
    await adapter.dispose();
    await f.close();
  }
});

test('E2B dormant deployment pause refuses retained active or uncertain ownership without touching the provider', async () => {
  for (const retained of ['active', 'uncertain', 'allocating'] as const) {
    const f = await fixture();
    const original: ComputerAllocation = {
      ownerId: 'owner',
      role: 'computer',
      provider: 'e2b',
      templateId: 'computer',
      resourceId: 'retained-sandbox',
      generation: 'retained-generation',
      version: 1,
      state: retained === 'active' ? 'ready' : retained,
      leaseId: 'retained-lease',
      leaseExpiresAt: Date.now() - 1000,
    };
    f.state.records.set('owner/computer', original);
    const adapter = f.create('owner');
    try {
      await assert.rejects(adapter.pause(), /recovery/);
      await assert.rejects(adapter.resume(), /recovery/);
      assert.deepEqual(f.state.records.get('owner/computer'), original);
      assert.equal(f.metadata.length, 0);
      assert.equal(f.connections(), 0);
      assert.equal(f.pauses(), 0);
      assert.equal(f.requests.length, 0);
    } finally {
      await assert.rejects(adapter.dispose(), /recovery/);
      await f.close();
    }
  }
});

test('E2B deployment pause accepts only absent or previously acknowledged unleased allocations without starting them', async () => {
  const f = await fixture();
  const prepared = f.create('owner');
  try {
    await prepared.prepare();
    await prepared.dispose();
    const original = structuredClone(f.state.records.get('owner/computer'));
    const dormant = f.create('owner');
    const absent = f.create('other-owner');
    await Promise.all([dormant.pause(), absent.pause()]);
    await Promise.all([dormant.resume(), absent.resume()]);
    await Promise.all([dormant.dispose(), absent.dispose()]);
    assert.deepEqual(f.state.records.get('owner/computer'), original);
    assert.equal(f.state.records.size, 1);
    assert.equal(f.metadata.length, 1);
    assert.equal(f.connections(), 0);
    assert.equal(f.pauses(), 1);
  } finally {
    await f.close();
  }
});

test('E2B deployment pause leaves an accepted workspace command running and refuses a premature receipt', async () => {
  const f = await fixture();
  const adapter = f.create('owner');
  const workspace = adapter.workspace.open({
    taskId: 'task',
    workspacePath: join(f.root, 'workspaces/task'),
    signal: new AbortController().signal,
  });
  let operation: Promise<string> | undefined;
  try {
    operation = workspace.execute(
      'python3 -c "import time;print(1,flush=True);time.sleep(0.5);print(2)"',
    );
    let started = false;
    for (let attempt = 0; attempt < 400; attempt++) {
      started = f.requests.some((request) => request.output.includes('"data": "MQo="'));
      if (started) break;
      await delay(5);
    }
    assert.equal(started, true);
    await assert.rejects(adapter.pause(), /recovery/);
    assert.equal(f.pauses(), 0);
    assert.equal(await operation, '1\n2\n');
    assert.equal(f.state.records.get('owner/computer')?.state, 'ready');
    await adapter.resume();
    await adapter.pause();
    assert.equal(f.pauses(), 1);
  } finally {
    await operation;
    await adapter.dispose();
    await f.close();
  }
});

test('E2B readiness is revalidated after pause and failure never dispatches the waiting command', async () => {
  const f = await fixture();
  const adapter = f.create('owner');
  try {
    await adapter.prepare();
    const original = structuredClone(f.state.records.get('owner/computer'));
    await adapter.pause();
    await adapter.resume();
    f.readiness(async () => {
      throw new Error('synthetic changed computer protection');
    });
    await assert.rejects(adapter.computer.act('task', { action: 'snapshot' }), /safely/);
    await delay(0);
    assert.equal(f.connections(), 1);
    assert.equal(f.readinessChecks(), 2);
    assert.equal(f.requests.length, 0);
    assert.equal(f.state.records.get('owner/computer')?.resourceId, original?.resourceId);
    assert.equal(f.state.records.get('owner/computer')?.state, 'uncertain');
    await assert.rejects(adapter.resume(), /recovery/);
  } finally {
    await assert.rejects(adapter.dispose(), /recovery/);
    await f.close();
  }
});

test('one E2B transport failure fences an already accepted peer capability without a replacement or replay', async () => {
  const f = await fixture();
  const adapter = f.create('owner');
  f.holdAction(async () => {});
  const browser = adapter.computer.act('task', { action: 'snapshot' });
  const rejectedBrowser = assert.rejects(browser, /safely/);
  try {
    for (let attempt = 0; attempt < 400 && !f.calls.length; attempt++) await delay(5);
    assert.equal(f.calls.filter((call) => call.method === 'act').length, 1);
    f.drop();
    const workspace = adapter.workspace.open({
      taskId: 'task',
      workspacePath: join(f.root, 'workspaces/task'),
      signal: new AbortController().signal,
    });
    await assert.rejects(workspace.execute('printf never'), /safely/);
    await rejectedBrowser;
    await delay(0);
    assert.equal(f.state.records.get('owner/computer')?.state, 'uncertain');
    assert.equal(f.metadata.length, 1);
    assert.equal(f.connections(), 0);
    assert.equal(f.requests.filter((request) => request.role === 'browser').length, 1);
    await assert.rejects(adapter.computer.act('task', { action: 'snapshot' }), /unavailable/);
    await assert.rejects(workspace.execute('printf still-never'), /unavailable/);
    assert.equal(f.requests.length, 2);
  } finally {
    await assert.rejects(adapter.dispose(), /recovery/);
    await f.close();
  }
});
