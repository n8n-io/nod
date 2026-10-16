import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { lstatSync, mkdirSync, mkdtempSync, rmSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { registerHooks } from 'node:module';
import { setTimeout as delay } from 'node:timers/promises';
import test from 'node:test';
import type { ComputerState } from '../src/computer-lifecycle.ts';

const stub = `export class DurableObject { constructor(ctx,env) { this.ctx=ctx;this.env=env; } } export class WorkerEntrypoint {}`;
registerHooks({
  resolve(specifier, context, next) {
    if (specifier === 'cloudflare:workers')
      return { url: `data:text/javascript,${encodeURIComponent(stub)}`, shortCircuit: true };
    return next(specifier, context);
  },
});
const { BrowserComputerContainer, WorkspaceComputerContainer, computerName } =
  await import('../src/computer-container.ts');

function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

function nativeProcess() {
  const killed: number[] = [];
  return {
    killed,
    process: {
      pid: 1,
      isPty: false,
      stdin: new WritableStream(),
      stdout: new ReadableStream({
        start(controller) {
          controller.close();
        },
      }),
      stderr: new ReadableStream({
        start(controller) {
          controller.close();
        },
      }),
      exitCode: Promise.resolve(0),
      kill(signal: number) {
        killed.push(signal);
      },
      resize() {},
      async output() {
        throw new Error('Unused fixture');
      },
    } as ExecProcess,
  };
}

function fixture(
  role: 'browser' | 'workspace',
  phase: ComputerState['phase'] | undefined,
  checkpoint = false,
) {
  const ownerId = randomUUID();
  const data = new Uint8Array(1024);
  const state: ComputerState = {
    ownerId,
    environment: 'development',
    generation: '1',
    role,
    phase: phase ?? 'ready',
    stopped: false,
    ...(checkpoint
      ? {
          checkpoint: {
            format: 'otto-computer-tar-v1',
            id: randomUUID(),
            ownerId,
            environment: 'development',
            role,
            bytes: data.length,
            sha256: createHash('sha256').update(data).digest('hex'),
            etag: 'fixture',
          },
        }
      : {}),
  };
  const values = new Map<string, unknown>(phase ? [['computer', state]] : []);
  const events: string[] = [];
  const pending: Promise<unknown>[] = [];
  let authorizedGeneration = '1';
  let exec = async (_args: string[], _options: ContainerExecOptions): Promise<ExecProcess> =>
    nativeProcess().process;
  const storage = {
    get: async (key: string) => structuredClone(values.get(key)),
    put: async (key: string, value: unknown) => {
      values.set(key, structuredClone(value));
    },
    transaction: async <T>(operation: (storage: unknown) => Promise<T>) => operation(storage),
  };
  const container = {
    running: phase !== undefined,
    exec: (args: string[], options: ContainerExecOptions) => {
      events.push(`exec:${args.join(' ')}`);
      return exec(args, options);
    },
  };
  const namespace = { idFromName: (name: string) => ({ toString: () => name }) };
  const env = {
    OTTO_ENVIRONMENT: 'development',
    BROWSER_COMPUTERS: namespace,
    WORKSPACE_COMPUTERS: namespace,
    TENANTS: {
      getByName(name: string) {
        assert.equal(name, `tenant:development:${ownerId}`);
        return {
          async computerIdentity(owner: string, generation: string) {
            assert.equal(owner, ownerId);
            assert.equal(generation, authorizedGeneration);
          },
        };
      },
    },
    TENANT_FILES: {
      async get(key: string) {
        return {
          key,
          size: data.length,
          etag: 'fixture',
          body: new ReadableStream({
            start(controller) {
              controller.enqueue(data);
              controller.close();
            },
          }),
        };
      },
    },
  };
  const Computer = role === 'browser' ? BrowserComputerContainer : WorkspaceComputerContainer;
  const computer = Object.assign(Object.create(Computer.prototype), {
    role,
    env,
    ctx: {
      storage,
      container,
      id: { toString: () => computerName('development', ownerId, role) },
      waitUntil: (promise: Promise<unknown>) => pending.push(promise),
    },
    destroy: async () => {
      events.push('destroy');
      container.running = false;
    },
    startAndWaitForPorts: async () => {
      events.push('start');
      container.running = true;
    },
    renewActivityTimeout: () => {
      events.push('renew');
    },
  }) as InstanceType<typeof Computer>;
  return {
    computer,
    ownerId,
    events,
    container,
    generation: (value: string) => {
      authorizedGeneration = value;
    },
    state: () => structuredClone(values.get('computer')) as ComputerState,
    exec: (value: typeof exec) => {
      exec = value;
    },
    request: (path: string, init: RequestInit = {}) =>
      computer.request(
        ownerId,
        authorizedGeneration,
        new Request(`http://otto.computer${path}`, {
          ...init,
          headers: {
            ...Object.fromEntries(new Headers(init.headers)),
            'x-otto-generation': authorizedGeneration,
            'x-otto-computer-role': role,
          },
        }),
      ),
  };
}

test('both computer roles preserve the pinned image user for restore helpers and commands', async (t) => {
  for (const role of ['browser', 'workspace'] as const) {
    await t.test(role, async (t) => {
      const current = fixture(role, 'ready', true);
      const exit = deferred<number>();
      const calls: { args: string[]; options: ContainerExecOptions }[] = [];
      const command = nativeProcess().process;
      current.exec(async (args, options) => {
        calls.push({ args, options });
        return args.includes('/app/src/providers/container-browser/bridge.ts') ||
          args.includes('/opt/otto/workspace-command.py')
          ? { ...command, exitCode: exit.promise }
          : nativeProcess().process;
      });
      t.after(async () => {
        await current.computer.stopComputer(current.ownerId, '1');
        exit.resolve(137);
      });
      const response = await current.request('/v1/commands', {
        method: 'POST',
        body: JSON.stringify({
          id: randomUUID(),
          role,
          ...(role === 'workspace' ? { threadId: 'thread' } : {}),
        }),
      });
      assert.equal(response.status, 201);
      assert.equal(current.state().phase, 'dirty');
      const launched = calls.at(-1)!;
      assert.equal(launched.options.cwd, role === 'browser' ? '/app' : '/workspace/thread');
      if (role === 'workspace')
        assert.deepEqual(launched.args.slice(0, 5), [
          '/usr/bin/setpriv',
          '--no-new-privs',
          '--inh-caps=-all',
          '--ambient-caps=-all',
          '--',
        ]);
      for (const call of calls) assert.equal(Object.hasOwn(call.options, 'user'), false);
    });
  }
});

test('browser status never starts the computer and is live only while this controller runs it', async (t) => {
  const current = fixture('browser', 'ready', true);
  const live = async () => {
    const response = await current.request('/v1/status');
    return response.status === 200 && (await response.json<{ live: boolean }>()).live;
  };
  assert.equal(await live(), false);
  assert.equal(current.events.length, 0);
  const exit = deferred<number>();
  current.exec(async (args) =>
    args.includes('/app/src/providers/container-browser/bridge.ts')
      ? { ...nativeProcess().process, exitCode: exit.promise }
      : nativeProcess().process,
  );
  t.after(async () => {
    exit.resolve(137);
  });
  const created = await current.request('/v1/commands', {
    method: 'POST',
    body: JSON.stringify({ id: randomUUID(), role: 'browser' }),
  });
  assert.equal(created.status, 201);
  assert.equal(await live(), true);
  await current.computer.stopComputer(current.ownerId, '1');
  assert.equal(await live(), false);
});

test('connected CLI commands run capability-free as their own user in /var/tmp', async (t) => {
  const current = fixture('workspace', 'ready', true);
  const exit = deferred<number>();
  const calls: { args: string[]; options: ContainerExecOptions }[] = [];
  current.exec(async (args, options) => {
    calls.push({ args, options });
    return args.includes('/opt/otto/workspace-command.py')
      ? { ...nativeProcess().process, exitCode: exit.promise }
      : nativeProcess().process;
  });
  t.after(async () => {
    await current.computer.stopComputer(current.ownerId, '1');
    exit.resolve(137);
  });
  for (const body of [
    { connected: 20_000, session: true },
    { connected: true },
    { connected: 1002 },
    { connected: 60_000 },
  ]) {
    const refused = await current.request('/v1/commands', {
      method: 'POST',
      body: JSON.stringify({ id: randomUUID(), role: 'workspace', threadId: 'thread', ...body }),
    });
    assert.equal(refused.status, 400);
  }
  const response = await current.request('/v1/commands', {
    method: 'POST',
    body: JSON.stringify({
      id: randomUUID(),
      role: 'workspace',
      threadId: 'thread',
      connected: 31_234,
    }),
  });
  assert.equal(response.status, 201);
  const launched = calls.at(-1)!;
  assert.deepEqual(launched.args, [
    '/usr/bin/setpriv',
    '--no-new-privs',
    '--inh-caps=-all',
    '--ambient-caps=-all',
    '--',
    '/usr/bin/python3',
    '-I',
    '-u',
    '/opt/otto/workspace-command.py',
  ]);
  assert.deepEqual(
    { ...launched.options, signal: undefined },
    { user: '31234:1002', cwd: '/var/tmp', stdin: 'pipe', signal: undefined },
  );
  assert.equal(
    calls.some((call) => call.args.some((arg) => arg.includes('state/workspace/thread'))),
    false,
  );
  const helper = calls.find((call) => call.args.includes('state/tools'))!;
  assert.deepEqual(helper.args.slice(3), ['/home/node', 'state/workspace', 'state/tools']);
  const root = mkdtempSync(join(tmpdir(), 'otto-shared-directories-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const run = (...paths: string[]) =>
    spawnSync(helper.args[0]!, [...helper.args.slice(1, 3), root, ...paths]).status;
  mkdirSync(join(root, 'state', 'tools'), { recursive: true, mode: 0o700 });
  assert.equal(run('state/workspace', 'state/tools'), 0);
  for (const path of ['state', 'state/workspace', 'state/tools'])
    assert.equal(lstatSync(join(root, path)).mode & 0o777, 0o755);
  mkdirSync(join(root, 'private'), { mode: 0o700 });
  symlinkSync(join(root, 'private'), join(root, 'state', 'workspace', 'thread'));
  assert.notEqual(run('state/workspace/thread'), 0);
  assert.equal(lstatSync(join(root, 'private')).mode & 0o777, 0o700);
});

test('the same controller can launch a new generation after stopping an unused role', async (t) => {
  for (const role of ['browser', 'workspace'] as const) {
    await t.test(role, async (t) => {
      const current = fixture(role, undefined);
      assert.equal(current.state(), undefined);
      assert.deepEqual(await current.computer.stopComputer(current.ownerId, '1'), {
        stopped: true,
      });
      assert.equal(current.state().generation, '1');
      assert.equal(current.state().phase, 'ready');
      assert.equal(current.state().stopped, true);
      assert.deepEqual(current.events, ['destroy']);

      current.generation('2');
      const exit = deferred<number>();
      const command = nativeProcess();
      command.process = {
        ...command.process,
        exitCode: exit.promise,
        stdout: new ReadableStream({
          start(controller) {
            controller.enqueue(new TextEncoder().encode('synthetic generation two'));
            controller.close();
          },
        }),
      };
      current.exec(async (args) =>
        args.includes('/app/src/providers/container-browser/bridge.ts') ||
        args.includes('/opt/otto/workspace-command.py')
          ? command.process
          : nativeProcess().process,
      );
      t.after(async () => {
        await current.computer.stopComputer(current.ownerId, '2');
        exit.resolve(137);
      });
      const id = randomUUID();
      const created = await current.request('/v1/commands', {
        method: 'POST',
        body: JSON.stringify({ id, role, ...(role === 'workspace' ? { threadId: 'thread' } : {}) }),
      });
      assert.equal(created.status, 201);
      assert.deepEqual(await created.json(), { id });
      const output = await current.request(`/v1/commands/${id}/output`);
      assert.equal(output.status, 200);
      const reader = output.body!.getReader();
      t.after(() => reader.cancel().catch(() => {}));
      const first = await Promise.race([
        reader.read(),
        delay(500).then(() => assert.fail('The replacement command did not produce output')),
      ]);
      assert.equal(first.done, false);
      assert.deepEqual(JSON.parse(new TextDecoder().decode(first.value)), {
        type: 'stdout',
        data: Buffer.from('synthetic generation two').toString('base64'),
      });
      assert.equal(current.state().generation, '2');
      assert.equal(current.state().phase, 'dirty');
      assert.equal(current.state().stopped, false);
      assert.equal(current.container.running, true);
      assert.equal(current.events.filter((event) => event === 'start').length, 1);
      const saved = current.state();
      const events = [...current.events];
      await assert.rejects(current.computer.stopComputer(current.ownerId, '1'));
      assert.deepEqual(current.state(), saved);
      assert.deepEqual(current.events, events);
      assert.equal(current.container.running, true);
      assert.deepEqual(command.killed, []);
    });
  }
});
