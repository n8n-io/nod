import assert from 'node:assert/strict';
import { Buffer } from 'node:buffer';
import { randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import test from 'node:test';
import { createComputerCommands } from '../src/computer-commands.ts';
import { RuntimeControlError } from '../src/protocol.ts';
import { launchCloudflareCommand } from '../../../src/providers/cloudflare-computer/transport.ts';

function deferred<T = void>() {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((done, fail) => {
    resolve = done;
    reject = fail;
  });
  return { promise, resolve, reject };
}

function processFixture() {
  const exited = deferred<number>();
  const input: Uint8Array[] = [];
  const signals: number[] = [];
  let stdout!: ReadableStreamDefaultController<Uint8Array>;
  let stderr!: ReadableStreamDefaultController<Uint8Array>;
  let beforeInput = async (_bytes: Uint8Array) => {};
  let inputClosed = false;
  const process: ExecProcess = {
    pid: 1,
    isPty: false,
    stdin: new WritableStream<Uint8Array>({
      async write(value) {
        await beforeInput(value);
        input.push(value.slice());
      },
      async close() {
        inputClosed = true;
      },
    }),
    stdout: new ReadableStream<Uint8Array>({
      start(controller) {
        stdout = controller;
      },
    }),
    stderr: new ReadableStream<Uint8Array>({
      start(controller) {
        stderr = controller;
      },
    }),
    exitCode: exited.promise,
    output: async () => {
      throw new Error('Unused synthetic operation');
    },
    kill(signal = 15) {
      signals.push(signal);
    },
    resize() {},
  };
  return {
    process,
    input,
    signals,
    stdout: (bytes: Uint8Array) => stdout.enqueue(bytes),
    stderr: (bytes: Uint8Array) => stderr.enqueue(bytes),
    beforeInput(value: typeof beforeInput) {
      beforeInput = value;
    },
    inputClosed: () => inputClosed,
    finish(code = 0) {
      try {
        stdout.close();
      } catch {}
      try {
        stderr.close();
      } catch {}
      exited.resolve(code);
    },
  };
}

function fixture(overrides: Partial<Parameters<typeof createComputerCommands>[0]> = {}) {
  const processes: ReturnType<typeof processFixture>[] = [];
  const launches: Array<{
    id: string;
    generation: string;
    threadId?: string;
    session?: boolean;
  }> = [];
  const completed: Array<{ id: string; generation: string; code: number }> = [];
  const uncertain: Array<{ id: string; generation: string }> = [];
  let allowed = true;
  const role = overrides.role ?? 'workspace';
  const registry = createComputerCommands({
    role,
    async authorize() {
      if (!allowed) throw new RuntimeControlError(403);
    },
    async launch(input) {
      launches.push(input);
      const process = processFixture();
      processes.push(process);
      return process.process;
    },
    async completed(input) {
      completed.push(input);
    },
    async uncertain(input) {
      uncertain.push(input);
    },
    live: () => false,
    ...overrides,
  });
  const request = (path: string, init: RequestInit = {}, version = '1') =>
    registry.fetch(
      new Request('http://otto.computer' + path, {
        ...init,
        headers: { ...init.headers, 'x-otto-generation': version },
      }),
    );
  return {
    registry,
    processes,
    launches,
    completed,
    uncertain,
    request,
    create: (id: string = randomUUID(), version = '1') =>
      request(
        '/v1/commands',
        {
          method: 'POST',
          body: JSON.stringify({ id, role, ...(role === 'workspace' && { threadId: 'thread' }) }),
        },
        version,
      ),
    revoke() {
      allowed = false;
    },
    async close() {
      await registry.stop();
      for (const process of processes) process.finish();
    },
  };
}

async function eventual(check: () => boolean) {
  for (let attempt = 0; attempt < 100; attempt++) {
    if (check()) return;
    await delay(5);
  }
  assert.equal(check(), true);
}

async function create(f: ReturnType<typeof fixture>, version = '1') {
  const id = randomUUID();
  const response = await f.create(id, version);
  assert.equal(response.status, 201);
  assert.deepEqual(await response.json(), { id });
  return id;
}

function attachClient(f: ReturnType<typeof fixture>) {
  const process = launchCloudflareCommand({
    role: 'workspace',
    generation: '1',
    threadId: 'thread',
    fetch: (input, init) => f.registry.fetch(new Request(input, init)) as Promise<Response>,
    onUncertain() {},
  });
  const stdout: Buffer[] = [];
  const stderr: Buffer[] = [];
  process.stdout.on('data', (value: Buffer) => stdout.push(value));
  process.stderr.on('data', (value: Buffer) => stderr.push(value));
  const terminal = new Promise<{ code?: number | null; error?: string }>((resolve) => {
    process.on('error', (error: Error) => resolve({ error: error.message }));
    process.on('close', (code: number | null) => resolve({ code }));
  });
  return { process, terminal, stdout, stderr };
}

test('computer command creation validates identities, role, thread and generation before launch', async () => {
  for (const role of ['browser', 'workspace'] as const) {
    const f = fixture({ role });
    try {
      const valid = { id: randomUUID(), role, ...(role === 'workspace' && { threadId: 'thread' }) };
      for (const body of [
        { ...valid, id: '../private' },
        { ...valid, role: role === 'browser' ? 'workspace' : 'browser' },
        { ...valid, threadId: role === 'browser' ? 'thread' : undefined },
        { ...valid, threadId: '../private' },
        { ...valid, arbitrary: 'private synthetic value' },
        { ...valid, session: role === 'browser' },
        { ...valid, session: 'private' },
        null,
        [],
      ]) {
        const response = await f.request('/v1/commands', {
          method: 'POST',
          body: JSON.stringify(body),
        });
        assert.equal(response.status, 400);
        assert.doesNotMatch(await response.text(), /private/);
      }
      for (const version of ['', '01']) {
        assert.equal((await f.create(randomUUID(), version)).status, 400);
      }
      assert.equal(f.launches.length, 0);
      const id = await create(f);
      assert.deepEqual(f.launches, [
        { id, generation: '1', threadId: role === 'workspace' ? 'thread' : undefined },
      ]);
      assert.equal((await f.create(id)).status, 409);
      if (role === 'workspace') {
        const g = fixture({ role });
        try {
          const session = randomUUID();
          const response = await g.request('/v1/commands', {
            method: 'POST',
            body: JSON.stringify({ ...valid, id: session, session: true }),
          });
          assert.equal(response.status, 201);
          assert.deepEqual(g.launches, [
            { id: session, generation: '1', threadId: 'thread', session: true },
          ]);
        } finally {
          await g.close();
        }
      }
      assert.equal((await f.request(`/v1/commands/${id}/output`, {}, '2')).status, 404);
      assert.equal((await f.request(`/v1/commands/${randomUUID()}/output`)).status, 404);
    } finally {
      await f.close();
    }
  }
});

test('native command streams interoperate with the client and preserve binary input, cancellation and output', async () => {
  const f = fixture();
  const client = attachClient(f);
  try {
    client.process.stdin.write(Buffer.from([0, 255, 128]));
    client.process.stdin.write(Buffer.from('cancel\n'));
    client.process.stdin.end();
    await eventual(() => f.processes[0]?.inputClosed() ?? false);
    assert.deepEqual(
      Buffer.concat(f.processes[0].input),
      Buffer.from([0, 255, 128, 99, 97, 110, 99, 101, 108, 10]),
    );
    const output = Buffer.alloc(70_003, 173);
    f.processes[0].stdout(output);
    f.processes[0].stderr(Buffer.from('synthetic stderr'));
    f.processes[0].finish(17);
    assert.deepEqual(await client.terminal, { code: 17 });
    assert.deepEqual(Buffer.concat(client.stdout), output);
    assert.equal(Buffer.concat(client.stderr).toString(), 'synthetic stderr');
  } finally {
    await f.close();
  }
});

test('signal acknowledgement never substitutes for process exit or durable checkpoint completion', async () => {
  const checkpoint = deferred();
  const checkpointEntered = deferred();
  const f = fixture({
    async completed() {
      checkpointEntered.resolve();
      await checkpoint.promise;
    },
  });
  try {
    const id = await create(f);
    const response = await f.request(`/v1/commands/${id}/output`);
    const reader = response.body!.getReader();
    let finished = false;
    const read = reader.read().then((value) => {
      finished = true;
      return value;
    });
    assert.equal(
      (
        await f.request(`/v1/commands/${id}/kill`, {
          method: 'POST',
          body: JSON.stringify({ signal: 'SIGTERM' }),
        })
      ).status,
      204,
    );
    assert.deepEqual(f.processes[0].signals, [15]);
    await delay(5);
    assert.equal(finished, false);
    assert.equal(f.registry.active, 1);
    f.processes[0].finish(143);
    await checkpointEntered.promise;
    assert.equal(finished, false);
    assert.equal(f.registry.active, 1);
    assert.equal(
      (await f.request(`/v1/commands/${id}/input`, { method: 'POST', body: 'too late' })).status,
      409,
    );
    assert.equal(f.processes[0].input.length, 0);
    assert.equal(f.registry.uncertain, false);
    assert.equal(
      (
        await f.request(`/v1/commands/${id}/kill`, {
          method: 'POST',
          body: JSON.stringify({ signal: 'SIGKILL' }),
        })
      ).status,
      204,
    );
    assert.deepEqual(f.processes[0].signals, [15]);
    checkpoint.resolve();
    const frame = await read;
    assert.deepEqual(JSON.parse(Buffer.from(frame.value!).toString()), { type: 'exit', code: 143 });
    assert.equal((await reader.read()).done, true);
    reader.releaseLock();
    await eventual(() => f.registry.active === 0);
  } finally {
    checkpoint.resolve();
    await f.close();
  }
});

test('blocked input preserves ordering but cannot block a kill signal', async () => {
  const f = fixture();
  const entered = deferred();
  const release = deferred();
  try {
    const id = await create(f);
    f.processes[0].beforeInput(async () => {
      entered.resolve();
      await release.promise;
    });
    const first = f.request(`/v1/commands/${id}/input`, { method: 'POST', body: 'first' });
    await entered.promise;
    const second = f.request(`/v1/commands/${id}/input`, { method: 'POST', body: 'second' });
    const signal = f.request(`/v1/commands/${id}/kill`, {
      method: 'POST',
      body: JSON.stringify({ signal: 'SIGTERM' }),
    });
    await eventual(() => f.processes[0].signals.length === 1);
    assert.equal((await signal).status, 204);
    assert.equal(f.processes[0].input.length, 0);
    release.resolve();
    assert.equal((await first).status, 204);
    assert.equal((await second).status, 204);
    assert.deepEqual(
      f.processes[0].input.map((value) => Buffer.from(value).toString()),
      ['first', 'second'],
    );
  } finally {
    release.resolve();
    await f.close();
  }
});

test('authorization expiry fences a silent command without needing another client request', async () => {
  const f = fixture({ authorizationIntervalMs: 10 });
  const client = attachClient(f);
  try {
    client.process.stdin.end();
    await eventual(() => f.processes[0]?.inputClosed() ?? false);
    f.revoke();
    assert.ok((await client.terminal).error);
    assert.equal(f.registry.uncertain, true);
    assert.deepEqual(f.processes[0].signals, [9]);
    assert.equal(f.completed.length, 0);
    assert.equal(f.uncertain.length, 1);
  } finally {
    await f.close();
  }
});

test('uncertainty during a checkpoint suppresses exit and stop waits for its durable fence', async () => {
  const checkpointEntered = deferred();
  const checkpoint = deferred();
  const fenceEntered = deferred();
  const fence = deferred();
  const f = fixture({
    authorizationIntervalMs: 10,
    async completed() {
      checkpointEntered.resolve();
      await checkpoint.promise;
    },
    async uncertain() {
      fenceEntered.resolve();
      await fence.promise;
    },
  });
  const client = attachClient(f);
  try {
    client.process.stdin.end();
    await eventual(() => f.processes[0]?.inputClosed() ?? false);
    f.processes[0].finish();
    await checkpointEntered.promise;
    f.revoke();
    await fenceEntered.promise;
    checkpoint.resolve();
    assert.ok((await client.terminal).error);
    let stopped = false;
    const stopping = f.registry.stop().then(() => {
      stopped = true;
    });
    await delay(5);
    assert.equal(stopped, false);
    fence.resolve();
    await stopping;
    assert.equal(f.registry.uncertain, true);
  } finally {
    checkpoint.resolve();
    fence.resolve();
    await f.close();
  }
});

test('commands run side by side and stay active until their entire output stream closes', async () => {
  for (const role of ['browser', 'workspace'] as const) {
    const f = fixture({
      role,
      async launch() {
        const native = processFixture();
        native.finish();
        return native.process;
      },
    });
    try {
      const ids = [];
      for (let index = 0; index < 3; index++) ids.push(await create(f));
      await delay(5);
      assert.equal(f.registry.active, 3);
      const output = await f.request(`/v1/commands/${ids[0]}/output`);
      assert.deepEqual(JSON.parse(await output.text()), { type: 'exit', code: 0 });
      assert.equal(f.registry.active, 2);
      for (const id of ids.slice(1)) {
        const remaining = await f.request(`/v1/commands/${id}/output`);
        await remaining.text();
      }
      assert.equal(f.registry.active, 0);
    } finally {
      await f.close();
    }
  }
});
