import assert from 'node:assert/strict';
import { randomBytes, randomUUID } from 'node:crypto';
import test, { type TestContext } from 'node:test';
import { setImmediate } from 'node:timers/promises';
import type { DeploymentRequest } from '../../../src/ports/deployment.ts';
import {
  deploymentHeader,
  deploymentPath,
  signDeploymentRequest,
} from '../../../src/server/deployment-auth.ts';
import { createDeploymentControl } from '../../../src/server/deployment-control.ts';
import { createTenantRuntimeHost } from '../../../src/server/runtime-host.ts';
import type { DeploymentState } from '../src/deployment-barrier.ts';
import { createGatewayDeployment } from '../src/deployment-gateway.ts';

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((yes) => {
    resolve = yes;
  });
  return { promise, resolve };
}

function fixture(t: TestContext) {
  const masterKey = randomBytes(32);
  const release = 'a'.repeat(40);
  const environment = 'production';
  const ownerId = randomUUID();
  const values = new Map<string, unknown>();
  const actions: string[] = [];
  const provisioned: string[] = [];
  const starts: string[] = [];
  const hooks: {
    beforeResume?: () => Promise<void>;
    afterResume?: () => Promise<void>;
    beforeCommit?: () => Promise<void>;
  } = {};
  let gateway: ReturnType<typeof createGatewayDeployment>;
  const record = {
    ownerId,
    environment,
    role: 'synthetic_role',
    appSchema: 'synthetic_app',
    jobsSchema: 'synthetic_jobs',
    credentialVersion: 1,
  };
  const host = createTenantRuntimeHost({
    masterKey,
    environment,
    operatorEnvironment: {},
    tenants: {
      listOwners: async () => [],
      provision: async (owner) => {
        provisioned.push(owner);
        return record;
      },
      runtimeConfiguration: async () => ({
        ...record,
        databaseUrl: 'postgresql://synthetic:synthetic@db.example.test/tenant',
        poolMax: 1,
      }),
      acquireLease: async (owner, holderId) => ({
        ownerId: owner,
        holderId,
        environment,
        generation: '1',
        expiresAt: new Date(Date.now() + 60_000).toISOString(),
      }),
      renewLease: async (lease) => lease,
      releaseLease: async () => true,
    },
    transport: {
      deploymentClosed: async () => gateway.closed(),
      deploymentStopped: async () => true,
      prepareDeployment: async () => 'stopped',
      status: async () => ({ generation: null, stopped: true }),
      start: async ({ ownerId: owner }) => {
        starts.push(owner);
      },
      stop: async () => {},
      fetch: async () => Response.json({ apps: [] }),
      close: async () => {},
    },
  });
  t.after(() => host.close());
  const nodeControl = createDeploymentControl({ masterKey, environment, release, runtimes: host });
  const storage = {
    get: async (key: string) => structuredClone(values.get(key)),
    put: async (key: string, value: unknown) => {
      if (key === 'deployment-barrier' && (value as DeploymentState).phase === 'complete')
        await hooks.beforeCommit?.();
      values.set(key, structuredClone(value));
    },
    transaction: async <T>(operation: (value: unknown) => Promise<T>) => operation(storage),
  } as unknown as DurableObjectStorage;
  gateway = createGatewayDeployment({
    storage,
    environment,
    requireInitialization: true,
    gatewayEnvironment: JSON.stringify({
      OTTO_MASTER_KEY: Buffer.from(masterKey).toString('base64'),
      OTTO_RELEASE: release,
    }),
    forward: async (request) => {
      const body = new Uint8Array(await request.arrayBuffer());
      const input = JSON.parse(Buffer.from(body).toString()) as DeploymentRequest;
      actions.push(input.action);
      if (input.action === 'complete') {
        assert.equal(await gateway.closed(), true);
        await hooks.beforeResume?.();
      }
      const result = await nodeControl(
        request.headers.get(deploymentHeader),
        request.method,
        new URL(request.url).pathname,
        body,
      );
      if (input.action === 'complete') await hooks.afterResume?.();
      return Response.json(result);
    },
  });
  const input: DeploymentRequest = {
    action: 'prepare',
    nonce: randomUUID(),
    previousRelease: release,
    targetRelease: release,
    deadline: Date.now() + 60_000,
  };
  const signed = (changes: Partial<DeploymentRequest> = {}) => {
    const body = Buffer.from(JSON.stringify({ ...input, ...changes }));
    const token = signDeploymentRequest({ masterKey, environment, body });
    return { body, token };
  };
  const control = (changes: Partial<DeploymentRequest> = {}) => {
    const { body, token } = signed(changes);
    return gateway.handle(
      new Request(`https://otto.example.test${deploymentPath}`, {
        method: 'POST',
        headers: { [deploymentHeader]: token },
        body,
      }),
    );
  };
  return {
    input,
    hooks,
    gateway,
    actions,
    provisioned,
    starts,
    control,
    state: () => values.get('deployment-barrier') as DeploymentState,
    request: () =>
      host.fetch(ownerId, new Request('https://otto.example.test/api/apps'), {
        developer: false,
      }),
    nodeControl: (changes: Partial<DeploymentRequest>) => {
      const { body, token } = signed(changes);
      return nodeControl(token, 'POST', deploymentPath, body);
    },
  };
}

test('same-release bootstrap resumes the existing Node host before opening durable admission', async (t) => {
  const f = fixture(t);
  const waiting = deferred();
  const entered = deferred();
  f.hooks.beforeResume = async () => {
    entered.resolve();
    await waiting.promise;
  };
  assert.equal(await f.gateway.closed(), true);
  await f.control();
  await f.control({ action: 'activate' });
  await assert.rejects(f.request());
  assert.equal(f.provisioned.length, 0);
  const completing = f.control({ action: 'complete' });
  await Promise.race([entered.promise, setImmediate()]);
  assert.deepEqual(f.actions, ['prepare', 'complete']);
  assert.equal(f.state().phase, 'activating');
  assert.equal(await f.gateway.closed(), true);
  await assert.rejects(f.request());
  assert.equal(f.provisioned.length, 0);
  waiting.resolve();
  assert.equal((await completing).state?.phase, 'complete');
  assert.equal(await f.gateway.closed(), false);
  assert.equal((await f.request()).status, 200);
  assert.equal(f.provisioned.length, 1);
  assert.equal(f.starts.length, 1);
  await f.control({ action: 'complete' });
  assert.deepEqual(f.actions, ['prepare', 'complete']);
  assert.equal((await f.request()).status, 200);
  assert.equal(f.starts.length, 1);
});

test('failed bootstrap resume keeps admission closed and only the exact operation can retry', async (t) => {
  const f = fixture(t);
  await f.control();
  await f.control({ action: 'activate' });
  f.hooks.beforeResume = async () => {
    throw new Error('Synthetic unavailable runtime');
  };
  await assert.rejects(f.control({ action: 'complete' }));
  assert.equal(f.state().phase, 'activating');
  assert.equal(await f.gateway.closed(), true);
  await assert.rejects(f.request());
  assert.equal(f.provisioned.length, 0);
  await assert.rejects(f.control({ action: 'complete', nonce: randomUUID() }), { status: 409 });
  assert.deepEqual(f.actions, ['prepare', 'complete']);
  f.hooks.beforeResume = undefined;
  await f.control({ action: 'complete' });
  await f.control({ action: 'complete' });
  assert.equal(await f.gateway.closed(), false);
  assert.deepEqual(f.actions, ['prepare', 'complete', 'complete']);
  assert.equal((await f.request()).status, 200);
  assert.equal(f.provisioned.length, 1);
});

test('lost bootstrap resume acknowledgement retains the barrier and exact retry is safe after Node resumed', async (t) => {
  const f = fixture(t);
  await f.control();
  await f.control({ action: 'activate' });
  f.hooks.afterResume = async () => {
    throw new Error('Synthetic acknowledgement lost');
  };
  await assert.rejects(f.control({ action: 'complete' }));
  assert.equal(f.state().phase, 'activating');
  assert.equal(await f.gateway.closed(), true);
  await assert.rejects(f.request());
  assert.equal(f.provisioned.length, 0);
  f.hooks.afterResume = undefined;
  await f.control({ action: 'complete' });
  assert.equal(await f.gateway.closed(), false);
  assert.equal((await f.request()).status, 200);
  assert.equal(f.starts.length, 1);
  assert.deepEqual(f.actions, ['prepare', 'complete', 'complete']);
});

test('Node completion cannot resume a different release or an unrelated bootstrap operation', async (t) => {
  const f = fixture(t);
  await f.control();
  await f.control({ action: 'activate' });
  for (const changes of [
    { targetRelease: 'b'.repeat(40) },
    { previousRelease: 'b'.repeat(40) },
    { nonce: randomUUID() },
    { deadline: f.input.deadline + 1 },
  ]) {
    await assert.rejects(f.nodeControl({ action: 'complete', ...changes }), { status: 409 });
    await assert.rejects(f.request());
    assert.equal(f.provisioned.length, 0);
  }
  await f.control({ action: 'complete' });
  assert.equal((await f.request()).status, 200);
});

test('failed durable completion keeps admission closed after resume and exact retry commits once', async (t) => {
  const f = fixture(t);
  await f.control();
  await f.control({ action: 'activate' });
  f.hooks.beforeCommit = async () => {
    throw new Error('Synthetic storage write failed');
  };
  await assert.rejects(f.control({ action: 'complete' }));
  assert.equal(f.state().phase, 'activating');
  assert.equal(await f.gateway.closed(), true);
  await assert.rejects(f.request());
  assert.equal(f.provisioned.length, 0);
  f.hooks.beforeCommit = undefined;
  await f.control({ action: 'complete' });
  await f.control({ action: 'complete' });
  assert.equal(await f.gateway.closed(), false);
  assert.equal((await f.request()).status, 200);
  assert.equal(f.starts.length, 1);
  assert.deepEqual(f.actions, ['prepare', 'complete', 'complete']);
});
