import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { registerHooks } from 'node:module';
import test from 'node:test';
import type { ComputerState } from '../src/computer-lifecycle.ts';
import { retireUnusedComputer } from '../src/computer-retirement.ts';

type Options = Parameters<typeof retireUnusedComputer>[0];

function fixture(role: 'browser' | 'workspace' = 'browser') {
  const identity = { ownerId: randomUUID(), environment: 'development', generation: '4', role };
  const original: ComputerState = {
    ...identity,
    generation: '3',
    phase: 'uncertain',
    stopped: true,
    commands: [],
  };
  const values = new Map<string, unknown>([['computer', structuredClone(original)]]);
  let authorization: (() => void) | undefined;
  let inactive = true;
  let stopped = true;
  let now = 1000;
  let writes = 0;
  let serial: Promise<unknown> = Promise.resolve();
  const options: Options = {
    identity,
    deployment: { nonce: randomUUID(), targetRelease: 'a'.repeat(40), deadline: 10_000 },
    now: () => now,
    read: async <T>(key: string) => structuredClone(values.get(key)) as T | undefined,
    transaction(operation) {
      const result = serial.then(async () => {
        const draft = structuredClone(values);
        const storage = {
          get: async (key: string) => structuredClone(draft.get(key)),
          list: async ({ prefix, limit }: { prefix: string; limit: number }) =>
            new Map([...draft].filter(([key]) => key.startsWith(prefix)).slice(0, limit)),
          put: async (entries: Record<string, unknown>) => {
            for (const [key, value] of Object.entries(entries))
              draft.set(key, structuredClone(value));
            writes++;
          },
        };
        const result = await operation(storage as unknown as Parameters<typeof operation>[0]);
        values.clear();
        for (const [key, value] of draft) values.set(key, value);
        return result;
      });
      serial = result.catch(() => {});
      return result;
    },
    async authorize() {
      authorization?.();
    },
    inactive: () => inactive,
    physicallyStopped: async () => stopped,
  };
  return {
    options,
    original,
    values,
    archiveKey: `computer-retirement:${identity.generation}`,
    writes: () => writes,
    run: () => retireUnusedComputer(options),
    authorization(value: () => void) {
      authorization = value;
    },
    setInactive(value: boolean) {
      inactive = value;
    },
    setStopped(value: boolean) {
      stopped = value;
    },
    expire() {
      now = options.deployment.deadline;
    },
  };
}

test('unused retirement atomically retains the exact uncertainty record and a stopped replacement', async () => {
  for (const role of ['browser', 'workspace'] as const) {
    const f = fixture(role);
    f.values.set('unrelated-evidence', { retained: true });
    assert.equal(await f.run(), true);
    const replacement = { ...f.options.identity, phase: 'ready', stopped: true };
    assert.deepEqual(f.values.get('computer'), replacement);
    assert.deepEqual(f.values.get(f.archiveKey), {
      format: 'otto-unused-computer-retirement-v1',
      deployment: f.options.deployment,
      original: f.original,
      replacement,
    });
    assert.deepEqual(f.values.get('unrelated-evidence'), { retained: true });
    assert.equal(f.writes(), 1);
    const retained = structuredClone(f.values);
    assert.equal(await f.run(), false);
    assert.deepEqual(f.values, retained);
    assert.equal(f.writes(), 1);
  }
});

test('identity, generation, legacy command and checkpoint ambiguity keep the original fence', async () => {
  const changes: Array<Record<string, unknown>> = [
    { ownerId: randomUUID() },
    { environment: 'production' },
    { role: 'workspace' },
    { generation: '4', stopped: null },
    { generation: '5' },
    { stopped: false },
    { commands: [randomUUID()] },
    { commands: null },
    { checkpoint: {} },
    { previousCheckpoint: {} },
    { unknown: true },
  ];
  for (const change of changes) {
    const f = fixture();
    f.values.set('computer', { ...f.original, ...change });
    const before = structuredClone(f.values);
    await assert.rejects(f.run(), { status: 503 });
    assert.deepEqual(f.values, before);
  }
});

test('active controllers, missing physical proof, expiry and revoked authority refuse before mutation', async () => {
  for (const condition of ['active', 'physical', 'deadline', 'authority']) {
    const f = fixture();
    if (condition === 'active') f.setInactive(false);
    if (condition === 'physical') f.setStopped(false);
    if (condition === 'deadline') f.expire();
    if (condition === 'authority')
      f.authorization(() => {
        throw new Error('synthetic revoked authority');
      });
    const before = structuredClone(f.values);
    await assert.rejects(f.run(), { status: 503 });
    assert.deepEqual(f.values, before);
  }
});

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

function controllerFixture(role: 'browser' | 'workspace') {
  const f = fixture(role);
  f.options.deployment.deadline = Date.now() + 60_000;
  let inspect: () => Promise<unknown> = async () => null;
  let sdkStatus = 'stopped';
  const namespace = { idFromName: (name: string) => ({ toString: () => name }) };
  const identity = f.options.identity;
  const storage = {
    get: f.options.read,
    transaction: f.options.transaction,
  };
  const native = {
    running: false,
    inspect: () => inspect(),
    exec: () => assert.fail('Retirement must not execute a process'),
  };
  const Computer = role === 'browser' ? BrowserComputerContainer : WorkspaceComputerContainer;
  const computer = Object.assign(Object.create(Computer.prototype), {
    role,
    env: {
      OTTO_ENVIRONMENT: identity.environment,
      BROWSER_COMPUTERS: namespace,
      WORKSPACE_COMPUTERS: namespace,
      TENANTS: {
        getByName: () => ({
          async deploymentComputerIdentity(owner: string, version: string) {
            assert.equal(owner, identity.ownerId);
            assert.equal(version, identity.generation);
          },
          async deploymentUnusedComputerIdentity() {},
          async computerIdentity() {},
        }),
      },
    },
    ctx: {
      storage,
      container: native,
      id: { toString: () => computerName(identity.environment, identity.ownerId, role) },
    },
    getState: async () => ({ status: sdkStatus }),
    destroy: () => assert.fail('Retirement must not destroy a container'),
    startAndWaitForPorts: () => assert.fail('Retirement must not start a container'),
  }) as InstanceType<typeof Computer>;
  return {
    ...f,
    computer,
    native,
    drain: () =>
      computer.prepareDeploymentDrain(identity.ownerId, identity.generation, f.options.deployment),
    inspect(value: () => Promise<unknown>) {
      inspect = value;
    },
    sdk(value: string) {
      sdkStatus = value;
    },
  };
}

test('both controller roles retire only through deployment drain and keep ordinary launch closed', async () => {
  for (const role of ['browser', 'workspace'] as const) {
    const f = controllerFixture(role);
    assert.deepEqual(await f.drain(), {
      status: 'drained',
      generation: '4',
      clean: true,
      stopped: true,
    });
    assert.deepEqual(
      (f.values.get(f.archiveKey) as { original: ComputerState }).original,
      f.original,
    );
    assert.deepEqual(await f.drain(), {
      status: 'drained',
      generation: '4',
      clean: true,
      stopped: true,
    });
    const response = await f.computer.request(
      f.options.identity.ownerId,
      '4',
      new Request('http://otto.computer/v1/commands', {
        method: 'POST',
        headers: { 'x-otto-generation': '4', 'x-otto-computer-role': role },
        body: JSON.stringify({
          id: randomUUID(),
          role,
          ...(role === 'workspace' && { threadId: 'synthetic' }),
        }),
      }),
    );
    assert.equal(response.status, 503);
    assert.equal(
      [...f.values.keys()].some((key) => key.startsWith('command:')),
      false,
    );
    assert.equal((f.values.get('computer') as ComputerState).stopped, true);
  }
});

test('controller retirement rejects unknown native absence and nonterminal SDK state', async () => {
  for (const condition of ['undefined', 'present', 'rejection', 'healthy', 'native-running']) {
    const f = controllerFixture('browser');
    if (condition === 'undefined') f.inspect(async () => undefined);
    if (condition === 'present') f.inspect(async () => ({}));
    if (condition === 'rejection')
      f.inspect(async () => {
        throw new Error('synthetic inspect failure');
      });
    if (condition === 'healthy') f.sdk('healthy');
    if (condition === 'native-running') f.native.running = true;
    await assert.rejects(f.drain());
    assert.deepEqual(f.values.get('computer'), f.original);
    assert.equal(f.values.has(f.archiveKey), false);
  }
});

test('a controller selection already awaiting storage cannot enter during retirement', async () => {
  const f = controllerFixture('browser');
  const context = (f.computer as unknown as { ctx: { storage: { get: Options['read'] } } }).ctx;
  const read = context.storage.get;
  let releaseSelection!: () => void;
  let selected!: () => void;
  const selecting = new Promise<void>((resolve) => {
    selected = resolve;
  });
  const blocked = new Promise<void>((resolve) => {
    releaseSelection = resolve;
  });
  let first = true;
  context.storage.get = async <T>(key: string) => {
    if (key === 'computer' && first) {
      first = false;
      selected();
      await blocked;
    }
    return read<T>(key);
  };
  let releaseInspect!: () => void;
  let inspected!: () => void;
  const inspecting = new Promise<void>((resolve) => {
    inspected = resolve;
  });
  const inspection = new Promise<void>((resolve) => {
    releaseInspect = resolve;
  });
  f.inspect(async () => {
    inspected();
    await inspection;
    return null;
  });
  const request = f.computer.request(
    f.options.identity.ownerId,
    '4',
    new Request('http://otto.computer/v1/commands', {
      method: 'POST',
      headers: { 'x-otto-generation': '4', 'x-otto-computer-role': 'browser' },
      body: JSON.stringify({ id: randomUUID(), role: 'browser' }),
    }),
  );
  await selecting;
  const drain = f.drain();
  await inspecting;
  releaseSelection();
  assert.equal((await request).status, 503);
  releaseInspect();
  assert.equal((await drain).status, 'drained');
  assert.equal(f.values.has(f.archiveKey), true);
});
