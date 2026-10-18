import assert from 'node:assert/strict';
import { createHash, createHmac, randomUUID } from 'node:crypto';
import { registerHooks } from 'node:module';
import test from 'node:test';
import { createTenantLifecycle } from '../src/lifecycle.ts';
import { createRuntimeLeaseAlarm } from '../src/lease-alarm.ts';
import { startContainer } from '../src/container-startup.ts';
import type { TenantIdentity } from '../src/protocol.ts';
import type { DeploymentInput } from '../../../src/ports/deployment.ts';

const stub = `export class DurableObject { constructor(ctx,env) { this.ctx=ctx;this.env=env; } }
export class WorkerEntrypoint {}`;
registerHooks({
  resolve(specifier, context, next) {
    if (specifier === 'cloudflare:workers')
      return { url: `data:text/javascript,${encodeURIComponent(stub)}`, shortCircuit: true };
    return next(specifier, context);
  },
});
const { default: worker, GatewayContainer, TenantContainer } = await import('../src/worker.ts');
const NativeRequest = Request;
Object.defineProperty(globalThis, 'Request', {
  configurable: true,
  value: class extends NativeRequest {
    constructor(input: RequestInfo | URL, init?: RequestInit) {
      super(
        input,
        init?.body
          ? ({
              ...init,
              method: init.method,
              headers: init.headers,
              body: init.body,
              signal: init.signal,
              duplex: 'half',
            } as RequestInit)
          : init,
      );
    }
  },
});

test('runtime status cannot release a lease while a timed-out SDK launch remains pending', async () => {
  let finish!: () => void;
  const container = { running: false };
  const instance = Object.assign(Object.create(TenantContainer.prototype), {
    ctx: {
      container,
      storage: { get: async () => ({ generation: '1' }) },
    },
    getState: async () => ({ status: 'stopped' }),
    startAndWaitForPorts: () =>
      new Promise<void>((resolve) => {
        finish = () => {
          container.running = true;
          resolve();
        };
      }),
  }) as InstanceType<typeof TenantContainer>;
  await assert.rejects(startContainer(instance, { timeoutMs: 10 }));
  await assert.rejects(instance.runtimeStatus());
  finish();
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal((await instance.runtimeStatus()).stopped, false);
  container.running = false;
  assert.deepEqual(await instance.runtimeStatus(), {
    generation: '1',
    stopped: true,
    status: 'stopped',
  });
});

function fixture() {
  const ownerId = randomUUID();
  const calls: Array<{ target: string; request?: Request; input?: unknown }> = [];
  const identity = {
    ownerId,
    environment: 'development',
    generation: '1',
    configurationHash: 'fixture',
    leaseExpiresAt: Date.now() + 60_000,
    revoking: false,
    stopped: false,
  };
  const id = (value: string) => ({ toString: () => value });
  const computers = (role: 'browser' | 'workspace') => ({
    idFromName: id,
    getByName(name: string) {
      return {
        async request(ownerId: string, generation: string, request: Request) {
          calls.push({ target: name, input: { ownerId, generation }, request });
          return new Response(role);
        },
        async stopComputer(ownerId: string, generation: string) {
          calls.push({ target: `stop:${name}`, input: { ownerId, generation } });
          return { stopped: true };
        },
      };
    },
  });
  const env = {
    OTTO_ENVIRONMENT: 'development',
    OTTO_PUBLIC_URL: 'https://otto.example.test',
    GATEWAY_ENV: '{}',
    GATEWAY: {
      idFromName: id,
      getByName(name: string) {
        assert.equal(name, 'gateway:development');
        return {
          async fetch(request: Request) {
            calls.push({ target: 'gateway', request });
            return new Response('gateway');
          },
          async deploymentClosed() {
            return false;
          },
        };
      },
    },
    TENANTS: {
      idFromName: id,
      idFromString: (value: string) => id(value),
      getByName(name: string) {
        return {
          async startRuntime(input: unknown) {
            calls.push({ target: name, input });
            return { ok: true, generation: '1' };
          },
          async stopRuntime(owner: string, generation: string) {
            calls.push({ target: name, input: { owner, generation } });
            return { ok: true, stopped: true };
          },
          async runtimeStatus() {
            return { generation: '1', stopped: false, status: 'healthy' };
          },
          async fetch(request: Request) {
            calls.push({ target: name, request });
            return new Response('tenant');
          },
        };
      },
      get() {
        return {
          async storageIdentity() {
            return identity;
          },
        };
      },
    },
    TENANT_FILES: {},
    BROWSER_COMPUTERS: computers('browser'),
    WORKSPACE_COMPUTERS: computers('workspace'),
  } as unknown as Parameters<typeof worker.fetch>[1];
  const gatewayContext = { containerId: 'gateway:development', className: 'GatewayContainer' };
  const tenantContext = {
    containerId: `tenant:development:${ownerId}`,
    className: 'TenantContainer',
  };
  return { env, calls, ownerId, identity, gatewayContext, tenantContext };
}

function signedRequest(
  ownerId: string,
  url: string,
  init: RequestInit = {},
  changes: Record<string, unknown> = {},
) {
  const target = new URL(url);
  const claims = {
    version: 1,
    ownerId,
    environment: 'development',
    generation: '1',
    nonce: randomUUID(),
    expiresAt: Date.now() + 30_000,
    method: init.method ?? 'GET',
    target: target.pathname + target.search,
    bodyHash: createHash('sha256')
      .update(typeof init.body === 'string' ? init.body : '')
      .digest('hex'),
    developer: false,
    kind: target.pathname.startsWith('/api/runtime/') ? 'wake' : 'user',
    ...changes,
  };
  const payload = Buffer.from(JSON.stringify(claims)).toString('base64url');
  const signature = createHmac('sha256', 'synthetic-runtime-secret')
    .update(payload)
    .digest('base64url');
  const headers = new Headers(init.headers);
  headers.set('x-otto-runtime', `${payload}.${signature}`);
  return new Request(url, { ...init, headers });
}

test('public ingress sends API requests only to the gateway and never dispatches container control', async () => {
  const { env, calls } = fixture();
  const ordinary = await worker.fetch(
    new Request('https://otto.example.test/api/state', {
      headers: { cookie: 'session=fixture' },
    }),
    env,
  );
  assert.equal(await ordinary.text(), 'gateway');
  assert.equal(calls[0].request?.headers.get('cookie'), 'session=fixture');
  for (const path of ['/runtime/start', '/runtime/stop', '/__otto/start'])
    assert.equal(
      (await worker.fetch(new Request(`https://otto.example.test${path}`), env)).status,
      404,
    );
  assert.equal(
    (await worker.fetch(new Request('https://foreign.example.test/api/state'), env)).status,
    403,
  );
  assert.equal(calls.length, 1);
});

test('runtime bootstrap requires the fixed trusted gateway and forwarding preserves signed targets', async () => {
  const { env, calls, ownerId, gatewayContext, tenantContext } = fixture();
  const outbound = GatewayContainer.outboundByHost!['otto.runtime'];
  for (const context of [tenantContext, { ...gatewayContext, containerId: 'other-gateway' }]) {
    const response = await outbound(
      new Request('http://otto.runtime/runtime/start', {
        method: 'POST',
        body: JSON.stringify({ ownerId, env: {} }),
      }),
      env,
      context,
    );
    assert.equal(response.status, 403);
  }
  assert.equal(calls.length, 0);
  const started = await outbound(
    new Request('http://otto.runtime/runtime/start', {
      method: 'POST',
      body: JSON.stringify({ ownerId, env: {} }),
    }),
    env,
    gatewayContext,
  );
  assert.equal(started.status, 200);
  const response = await outbound(
    new Request(`http://otto.runtime/${ownerId}/api/events?account=${ownerId}`, {
      headers: { 'x-otto-runtime': 'signed-fixture' },
    }),
    env,
    gatewayContext,
  );
  assert.equal(await response.text(), 'tenant');
  const forwarded = calls[1].request!;
  assert.equal(forwarded.url, `https://otto.example.test/api/events?account=${ownerId}`);
  assert.equal(forwarded.headers.get('host'), 'otto.example.test');
  assert.equal(forwarded.headers.get('x-otto-runtime'), 'signed-fixture');
});

test('tenant control permits only signed channel and analytics requests for the trusted owner', async () => {
  const { env, calls, ownerId, tenantContext } = fixture();
  const control = TenantContainer.outboundByHost!['otto.control'];
  const request = (path: string, owner = ownerId) =>
    new Request(`http://otto.control${path}`, {
      method: 'POST',
      body: '{"provider":"telegram","accountId":"123456"}',
      headers: {
        'content-type': 'application/json',
        'x-otto-owner': owner,
        'x-otto-runtime': 'signed-fixture',
        cookie: 'must-not-forward',
      },
    });
  assert.equal(
    (await control(request('/api/internal/channels/claim'), env, tenantContext)).status,
    200,
  );
  const forwarded = calls[0].request!;
  assert.equal(forwarded.headers.get('x-otto-owner'), ownerId);
  assert.equal(forwarded.headers.get('cookie'), null);
  assert.equal(forwarded.url, 'https://otto.example.test/api/internal/channels/claim');
  assert.equal(await forwarded.text(), '{"provider":"telegram","accountId":"123456"}');
  assert.equal((await control(request('/api/internal/analytics'), env, tenantContext)).status, 200);
  assert.equal(calls[1].request!.url, 'https://otto.example.test/api/internal/analytics');
  assert.equal(
    (await control(request('/api/internal/analytics', randomUUID()), env, tenantContext)).status,
    403,
  );
  for (const path of [
    '/runtime/start',
    '/api/runtime/wake',
    '/api/internal/channels/claim?owner=other',
  ])
    assert.equal((await control(request(path), env, tenantContext)).status, 403);
  assert.equal(
    (await control(request('/api/internal/channels/claim', randomUUID()), env, tenantContext))
      .status,
    403,
  );
  assert.equal(calls.length, 2);
});

function processFixture(
  role: 'gateway' | 'tenant',
  respond: (url: URL, request: Request) => Promise<Response> = async () => new Response('ready'),
) {
  let status = 'healthy';
  let starts = 0;
  let forwards = 0;
  let startupError: Error | undefined;
  const container = {
    running: true,
    getTcpPort(port: number) {
      assert.equal(port, 4310);
      return {
        async fetch(url: URL, request: Request) {
          forwards++;
          return respond(url, request);
        },
      };
    },
  };
  const { env, ownerId, identity, calls } = fixture();
  const persisted = new Map<string, unknown>();
  const storage = {
    get: async (key: string) => persisted.get(key),
    put: async (key: string, value: unknown) => {
      persisted.set(key, value);
    },
    delete: async (key: string) => persisted.delete(key),
    transaction: async <T>(operation: (value: unknown) => Promise<T>) => operation(storage),
  };
  const instance = Object.assign(
    Object.create(role === 'gateway' ? GatewayContainer.prototype : TenantContainer.prototype),
    {
      ctx: {
        container,
        storage,
        id: {
          toString: () =>
            role === 'gateway' ? 'gateway:development' : `tenant:development:${ownerId}`,
        },
      },
      env,
      defaultPort: 4310,
      lifecycle: {
        async identity() {
          return identity;
        },
      },
      async getState() {
        return { status };
      },
      async startAndWaitForPorts() {
        starts++;
        if (startupError) throw startupError;
        container.running = true;
        status = 'healthy';
      },
      renewActivityTimeout() {},
      async containerFetch() {
        assert.fail('HTTP must not enter the SDK response-error conversion path');
      },
    },
  ) as InstanceType<typeof GatewayContainer> | InstanceType<typeof TenantContainer>;
  const publicEnv = {
    ...env,
    GATEWAY: { getByName: () => instance },
  } as unknown as Parameters<typeof worker.fetch>[1];
  return {
    instance,
    container,
    publicEnv,
    env,
    calls,
    identity,
    persisted,
    ownerId,
    request: (url: string, init: RequestInit = {}) => signedRequest(ownerId, url, init),
    counts: () => ({ starts, forwards }),
    stop() {
      container.running = false;
      status = 'stopped';
    },
    failStartup() {
      startupError = new Error('synthetic private startup configuration');
    },
  };
}

test('E2B stop acknowledgement is owner and generation bound and required after physical shutdown', async () => {
  const current = processFixture('tenant');
  const instance = current.instance as InstanceType<typeof TenantContainer>;
  const identity: TenantIdentity = { ...current.identity, computerProvider: 'e2b' };
  current.persisted.set('identity', identity);
  current.stop();
  assert.equal((await instance.runtimeStatus()).stopped, false);
  await assert.rejects(instance.recordExternalComputerStopped('2'));
  assert.equal(current.persisted.has('external-computer-stopped'), false);
  await instance.recordExternalComputerStopped('1');
  assert.equal((await instance.runtimeStatus()).stopped, true);
  current.persisted.set('identity', { ...identity, generation: '2' });
  assert.equal((await instance.runtimeStatus()).stopped, false);
  current.persisted.set('identity', { ...identity, ownerId: randomUUID() });
  await assert.rejects(instance.recordExternalComputerStopped('1'));
  current.persisted.set('identity', { ...identity, computerProvider: 'cloudflare' });
  await assert.rejects(instance.recordExternalComputerStopped('1'));
});

test('E2B journal-loss inspection requires the exact pause receipt and never visits Cloudflare computers', async () => {
  const current = processFixture('tenant');
  const instance = current.instance as InstanceType<typeof TenantContainer>;
  const identity: TenantIdentity = { ...current.identity, computerProvider: 'e2b' };
  current.persisted.set('identity', identity);
  current.stop();
  Object.assign(instance, { deploymentStoppedIdentity: async () => true });
  for (const key of ['BROWSER_COMPUTERS', 'WORKSPACE_COMPUTERS'] as const)
    current.env[key] = {
      getByName: () => {
        assert.fail('E2B must not access Cloudflare computers.');
      },
    } as never;
  assert.equal(await instance.deploymentStopped(current.ownerId, '1'), false);
  const proof = {
    nonce: randomUUID(),
    targetRelease: 'a'.repeat(40),
    deadline: Date.now() + 60_000,
    generation: '1',
    computerPaused: true,
  };
  current.persisted.set('deployment-proof', { ...proof, generation: '2' });
  assert.equal(await instance.deploymentStopped(current.ownerId, '1'), false);
  current.persisted.set('deployment-proof', proof);
  assert.equal(await instance.deploymentStopped(current.ownerId, '1'), true);
  current.persisted.set('deployment-resume', proof);
  assert.equal(await instance.deploymentStopped(current.ownerId, '1'), false);
});

test('anonymous gateway startup and both TCP proxy failures return fixed errors', async () => {
  const unavailable = processFixture('gateway');
  unavailable.failStartup();
  const initial = await worker.fetch(
    new Request('https://otto.example.test/api/session'),
    unavailable.publicEnv,
  );
  assert.equal(initial.status, 503);
  assert.doesNotMatch(await initial.text(), /synthetic|startup|configuration/);
  for (const role of ['gateway', 'tenant'] as const) {
    const current = processFixture(role, async () => {
      throw new Error('synthetic private upstream credential');
    });
    const response = await current.instance.fetch(
      current.request('https://otto.example.test/api/events'),
    );
    assert.equal(response.status, 503);
    assert.equal(response.headers.get('cache-control'), 'no-store');
    assert.deepEqual(await response.json(), {
      error: 'This request could not be completed. Try again.',
    });
  }
});

test('persistent gateway maintenance denies work before startup while retaining only anonymous smoke paths', async () => {
  const current = processFixture('gateway');
  current.persisted.set('deployment-barrier', {
    nonce: randomUUID(),
    targetRelease: 'a'.repeat(40),
    previousRelease: 'b'.repeat(40),
    deadline: Date.now() + 60_000,
    phase: 'prepared',
    receipts: [],
  });
  for (const path of ['/api/tasks', '/api/settings', '/api/session?fresh=true'])
    assert.equal(
      (await current.instance.fetch(new Request(`https://otto.example.test${path}`))).status,
      503,
    );
  assert.equal(
    (
      await current.instance.fetch(
        new Request('https://otto.example.test/api/session', {
          headers: { cookie: 'fixture=private' },
        }),
      )
    ).status,
    503,
  );
  assert.equal(
    (
      await current.instance.fetch(
        new Request('https://otto.example.test/api/login', {
          method: 'POST',
          headers: { origin: 'https://foreign.example.test' },
        }),
      )
    ).status,
    403,
  );
  assert.deepEqual(current.counts(), { starts: 0, forwards: 0 });
  for (const path of ['/api/health', '/api/session', '/api/state'])
    assert.equal(
      (await current.instance.fetch(new Request(`https://otto.example.test${path}`))).status,
      200,
    );
  assert.deepEqual(current.counts(), { starts: 1, forwards: 3 });
  await (current.instance as InstanceType<typeof GatewayContainer>).wake();
  assert.deepEqual(current.counts(), { starts: 1, forwards: 3 });
});

function deploymentTenantFixture(
  outcomes: Array<'drained' | 'busy' | 'unsafe'> = ['drained', 'drained'],
  respond?: (url: URL, request: Request, input: DeploymentInput) => Promise<Response>,
) {
  const input: DeploymentInput = {
    nonce: randomUUID(),
    targetRelease: 'a'.repeat(40),
    deadline: Date.now() + 60_000,
  };
  let current!: ReturnType<typeof processFixture>;
  current = processFixture('tenant', async (url, request) => {
    if (respond) return respond(url, request, input);
    if (url.pathname === '/api/runtime/resume') return Response.json({ ok: true });
    assert.equal(url.pathname, '/api/runtime/drain');
    assert.deepEqual(await request.json(), input);
    return Response.json({
      ok: true,
      nonce: input.nonce,
      targetRelease: input.targetRelease,
      generation: '1',
      drained: true,
    });
  });
  const instance = current.instance as InstanceType<typeof TenantContainer>;
  const events: string[] = [];
  current.persisted.set('identity', current.identity);
  Object.assign(current.container, { monitor: () => new Promise<void>(() => {}) });
  Object.assign(instance, {
    lifecycle: {
      identity: async () => current.identity,
      stop: async (owner: string, version: string) => {
        assert.equal(owner, current.ownerId);
        assert.equal(version, '1');
        events.push('tenant-stop');
        current.stop();
        return { ok: true, generation: '1', stopped: true };
      },
    },
  });
  for (const [index, role] of (['browser', 'workspace'] as const).entries()) {
    const namespace =
      role === 'browser' ? current.env.BROWSER_COMPUTERS : current.env.WORKSPACE_COMPUTERS;
    Object.assign(namespace, {
      getByName: () => ({
        prepareDeploymentDrain: async (owner: string, version: string, raw: DeploymentInput) => {
          await instance.deploymentComputerIdentity(owner, version, raw);
          events.push(role);
          const status = outcomes[index];
          return status === 'drained'
            ? { status, generation: '1', clean: true, stopped: true }
            : { status, generation: '1' };
        },
      }),
    });
  }
  return {
    ...current,
    instance,
    input,
    events,
    pause: () =>
      instance.fetch(
        signedRequest(
          current.ownerId,
          'https://otto.example.test/api/runtime/drain',
          { method: 'POST', body: JSON.stringify(input) },
          { kind: 'deployment' },
        ),
      ),
  };
}

test('computer deployment drain requires a witnessed signed tenant pause and stops both roles before the tenant', async () => {
  const f = deploymentTenantFixture();
  await assert.rejects(f.instance.prepareDeploymentDrain(f.ownerId, '1', f.input));
  assert.deepEqual(f.events, []);
  assert.equal((await f.pause()).status, 200);
  assert.deepEqual(f.persisted.get('deployment-proof'), { ...f.input, generation: '1' });
  assert.deepEqual(await f.instance.prepareDeploymentDrain(f.ownerId, '1', f.input), {
    ok: true,
    generation: '1',
    clean: true,
    stopped: true,
  });
  assert.deepEqual(f.events, ['browser', 'workspace', 'tenant-stop']);
});

test('busy first role is resumable but partial drain and lost process witness remain unsafe', async () => {
  for (const outcomes of [
    ['busy', 'drained'],
    ['drained', 'busy'],
  ] as const) {
    const f = deploymentTenantFixture([...outcomes]);
    assert.equal((await f.pause()).status, 200);
    const result = await f.instance.prepareDeploymentDrain(f.ownerId, '1', f.input);
    assert.deepEqual(result, {
      ok: false,
      status: outcomes[0] === 'busy' ? 'busy' : 'unsafe',
      generation: '1',
    });
    assert.equal(f.events.includes('tenant-stop'), false);
  }
  const lost = deploymentTenantFixture();
  assert.equal((await lost.pause()).status, 200);
  lost.instance.onStop();
  await assert.rejects(lost.instance.prepareDeploymentDrain(lost.ownerId, '1', lost.input));
  assert.deepEqual(lost.events, []);
  assert.ok(lost.persisted.get('deployment-proof'));
});

test('failed drain acknowledgement retains an exact retryable resume attempt without computer authority', async () => {
  for (const lost of [false, true]) {
    const f = deploymentTenantFixture(undefined, async (url) => {
      if (url.pathname.endsWith('/drain')) {
        if (lost) throw new Error('Synthetic response loss');
        return new Response(null, { status: 503 });
      }
      return Response.json({ ok: true });
    });
    assert.equal((await f.pause()).status, 503);
    assert.deepEqual(f.persisted.get('deployment-attempt'), { ...f.input, generation: '1' });
    assert.equal(f.persisted.has('deployment-proof'), false);
    await assert.rejects(f.instance.deploymentComputerIdentity(f.ownerId, '1', f.input));
    const resume = (input = f.input) =>
      f.instance.fetch(
        signedRequest(
          f.ownerId,
          'https://otto.example.test/api/runtime/resume',
          { method: 'POST', body: JSON.stringify(input) },
          { kind: 'deployment' },
        ),
      );
    const before = f.counts().forwards;
    assert.equal((await resume({ ...f.input, nonce: randomUUID() })).status, 409);
    assert.equal(f.counts().forwards, before);
    assert.equal((await resume()).status, 200);
    assert.equal((await resume()).status, 200);
    assert.equal((await f.pause()).status, 409);
    assert.equal(f.persisted.has('deployment-proof'), false);
    assert.deepEqual(f.events, []);
  }
});

test('late drain acknowledgement cannot recreate computer authority after matching resume', async () => {
  const started = deferred();
  const finish = deferred();
  const f = deploymentTenantFixture(undefined, async (url, _request, input) => {
    if (url.pathname.endsWith('/resume')) return Response.json({ ok: true });
    started.resolve();
    await finish.promise;
    return Response.json({
      ok: true,
      nonce: input.nonce,
      targetRelease: input.targetRelease,
      generation: '1',
      drained: true,
    });
  });
  const drain = f.pause();
  await started.promise;
  assert.equal(
    (
      await f.instance.fetch(
        signedRequest(
          f.ownerId,
          'https://otto.example.test/api/runtime/resume',
          { method: 'POST', body: JSON.stringify(f.input) },
          { kind: 'deployment' },
        ),
      )
    ).status,
    200,
  );
  finish.resolve();
  assert.equal((await drain).status, 409);
  assert.equal(f.persisted.has('deployment-proof'), false);
  await assert.rejects(f.instance.prepareDeploymentDrain(f.ownerId, '1', f.input));
  assert.deepEqual(f.events, []);
});

test('stopped deployment inspection requires exact tenant identity and both role receipts without mutations', async () => {
  const f = processFixture('tenant');
  const instance = f.instance as InstanceType<typeof TenantContainer>;
  f.stop();
  let closed = true;
  const calls: string[] = [];
  Object.assign(f.env.GATEWAY, { getByName: () => ({ deploymentClosed: async () => closed }) });
  Object.assign(instance, {
    lifecycle: createTenantLifecycle({
      environment: 'development',
      read: async () => f.persisted.get('identity') as TenantIdentity | undefined,
      write: async () => assert.fail('Inspection must not write identity'),
      status: async () => (f.container.running ? 'healthy' : 'stopped'),
      start: async () => assert.fail('Inspection must not start'),
      stop: async () => assert.fail('Inspection must not stop'),
    }),
  });
  for (const role of ['browser', 'workspace'] as const) {
    const namespace = role === 'browser' ? f.env.BROWSER_COMPUTERS : f.env.WORKSPACE_COMPUTERS;
    Object.assign(namespace, {
      getByName: () => ({
        async inspectDeploymentStopped(owner: string, version: string | null) {
          assert.equal(owner, f.ownerId);
          assert.equal(await instance.deploymentStoppedIdentity(owner, version), true);
          calls.push(role);
          return true;
        },
      }),
    });
  }
  assert.equal(await instance.deploymentStopped(f.ownerId, null), true);
  assert.deepEqual(calls, ['browser', 'workspace']);
  assert.equal(f.persisted.size, 0);
  f.persisted.set('identity', f.identity);
  assert.equal(await instance.deploymentStopped(f.ownerId, null), false);
  assert.equal(await instance.deploymentStopped(f.ownerId, '2'), false);
  assert.equal(await instance.deploymentStopped(f.ownerId, '1'), true);
  f.container.running = true;
  assert.equal(await instance.deploymentStopped(f.ownerId, '1'), false);
  f.container.running = false;
  const pendingStart = deferred();
  Object.assign(instance, { startAndWaitForPorts: () => pendingStart.promise });
  await assert.rejects(startContainer(instance, { timeoutMs: 1 }));
  await assert.rejects(instance.deploymentStopped(f.ownerId, '1'));
  pendingStart.resolve();
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.equal(await instance.deploymentStopped(f.ownerId, '1'), true);
  closed = false;
  await assert.rejects(instance.deploymentStopped(f.ownerId, '1'));
  assert.deepEqual(f.persisted.get('identity'), f.identity);
});

test('tenant forwarding never starts a stopped actor or restarts one lost during dispatch', async () => {
  const stopped = processFixture('tenant');
  stopped.stop();
  assert.equal(
    (await stopped.instance.fetch(stopped.request('https://otto.example.test/api/state'))).status,
    503,
  );
  assert.deepEqual(stopped.counts(), { starts: 0, forwards: 0 });
  const lost = processFixture('tenant');
  Object.assign(lost.instance, {
    async getState() {
      lost.container.running = false;
      return { status: 'healthy' };
    },
  });
  assert.equal(
    (await lost.instance.fetch(lost.request('https://otto.example.test/api/state'))).status,
    503,
  );
  assert.deepEqual(lost.counts(), { starts: 0, forwards: 0 });
});

function deferred<T = void>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  const promise = new Promise<T>((yes) => {
    resolve = yes;
  });
  return { promise, resolve };
}

function leasedProcessFixture(respond: (url: URL, request: Request) => Promise<Response>) {
  const current = processFixture('tenant', respond);
  const instance = current.instance as InstanceType<typeof TenantContainer>;
  let saved: TenantIdentity = { ...current.identity, leaseExpiresAt: Date.now() + 40_000 };
  const scheduled: number[] = [];
  let stopFails = false;
  let lifecycle!: ReturnType<typeof createTenantLifecycle>;
  const leaseAlarm = createRuntimeLeaseAlarm({
    read: async () => ({ ...saved }),
    expire: () => lifecycle.expire(),
    clear: () => {
      scheduled.length = 0;
    },
    schedule: async (when) => {
      scheduled.push(when.getTime());
    },
  });
  lifecycle = createTenantLifecycle({
    environment: 'development',
    read: async () => ({ ...saved }),
    write: async (identity) => {
      saved = { ...identity };
    },
    status: async () => (current.container.running ? 'healthy' : 'stopped'),
    start: async () => {
      current.container.running = true;
    },
    stop: async () => {
      if (stopFails) throw new Error('synthetic private stop failure');
      current.stop();
    },
    leaseUpdated: () => leaseAlarm.update(),
  });
  Object.assign(instance, {
    lifecycle,
    leaseAlarm,
    ctx: { container: current.container, storage: { get: async () => ({ ...saved }) } },
  });
  const env = {
    ...current.env,
    TENANTS: { ...current.env.TENANTS, getByName: () => instance, get: () => instance },
  } as unknown as Parameters<typeof worker.fetch>[1];
  return {
    ...current,
    instance,
    env,
    lifecycle,
    scheduled,
    saved: () => ({ ...saved }),
    replace: (identity: TenantIdentity) => {
      saved = identity;
    },
    failStop: (value: boolean) => {
      stopFails = value;
    },
  };
}

test('trusted gateway renewal extends persisted tenant authority only after the exact Node acknowledgement', async (t) => {
  let time = Date.UTC(2026, 8, 27, 12);
  t.mock.method(Date, 'now', () => time);
  const acknowledged = deferred<Response>();
  const received = deferred();
  let body = '';
  let signature = '';
  const current = leasedProcessFixture(async (_url, request) => {
    body = await request.text();
    signature = request.headers.get('x-otto-runtime')!;
    received.resolve();
    return acknowledged.promise;
  });
  const original = current.saved().leaseExpiresAt;
  time += 20_000;
  const expiry = time + 60_000;
  const raw = ` { "expiresAt" : "${new Date(expiry).toISOString()}" } `;
  const request = signedRequest(
    current.ownerId,
    `http://otto.runtime/${current.ownerId}/api/runtime/lease`,
    { method: 'POST', body: raw },
    { target: '/api/runtime/lease', kind: 'wake' },
  );
  const header = request.headers.get('x-otto-runtime');
  const outbound = GatewayContainer.outboundByHost!['otto.runtime'];
  const renewal = Promise.resolve(
    outbound(request, current.env, {
      className: 'GatewayContainer',
      containerId: 'gateway:development',
    }),
  );
  await Promise.race([
    received.promise,
    renewal.then((response) =>
      assert.fail(`The renewal finished before forwarding: ${response.status}`),
    ),
  ]);
  assert.equal(current.saved().leaseExpiresAt, original);
  assert.equal(body, raw);
  assert.equal(signature, header);
  acknowledged.resolve(Response.json({ ok: true }));
  assert.equal((await renewal).status, 200);
  assert.equal(current.saved().leaseExpiresAt, expiry);
});

test('tenant routing rejects bounded invalid claims and stale generations before contacting Node', async () => {
  const current = leasedProcessFixture(async () => new Response('must not execute'));
  const url = 'https://otto.example.test/api/state';
  for (const change of [
    { ownerId: randomUUID() },
    { environment: 'production' },
    { method: 'POST' },
    { target: '/api/other' },
    { nonce: 'invalid' },
    { expiresAt: Date.now() - 1 },
    { expiresAt: Date.now() + 36_000 },
    { generation: '0' },
  ])
    assert.equal(
      (await current.instance.fetch(signedRequest(current.ownerId, url, {}, change))).status,
      401,
    );
  assert.equal(
    (await current.instance.fetch(signedRequest(current.ownerId, url, {}, { generation: '2' })))
      .status,
    409,
  );
  for (const header of ['invalid', 'x'.repeat(16_385)]) {
    assert.equal(
      (await current.instance.fetch(new Request(url, { headers: { 'x-otto-runtime': header } })))
        .status,
      401,
    );
  }
  const renewal = 'https://otto.example.test/api/runtime/lease';
  for (const [url, init, changes] of [
    [renewal, {}, {}],
    [renewal + '?other=true', { method: 'POST' }, {}],
    [renewal, { method: 'POST' }, { kind: 'user' }],
  ] as const)
    assert.equal(
      (await current.instance.fetch(signedRequest(current.ownerId, url, init, changes))).status,
      401,
    );
  assert.deepEqual(current.counts(), { starts: 0, forwards: 0 });
});

test('rejected or oversized Node acknowledgements never extend persisted lease authority', async (t) => {
  for (const [name, response] of [
    ['rejected', () => new Response('synthetic private error', { status: 401 })],
    ['malformed', () => new Response('synthetic private error')],
    ['wrong acknowledgement', () => Response.json({ ok: false })],
    ['extra fields', () => Response.json({ ok: true, private: 'value' })],
    ['oversized', () => new Response('x'.repeat(1025))],
  ] as const)
    await t.test(name, async () => {
      const current = leasedProcessFixture(async () => response());
      const original = current.saved().leaseExpiresAt;
      const request = current.request('https://otto.example.test/api/runtime/lease', {
        method: 'POST',
        body: JSON.stringify({ expiresAt: new Date(Date.now() + 60_000).toISOString() }),
      });
      const failed = await current.instance.fetch(request);
      assert.equal(failed.status, 503);
      assert.equal(current.saved().leaseExpiresAt, original);
    });
});

test('renewal request bounds and exact schema apply before forwarding its signed bytes', async () => {
  const current = leasedProcessFixture(async () => Response.json({ ok: true }));
  for (const body of [
    'x'.repeat(1025),
    '{',
    JSON.stringify({
      expiresAt: new Date(Date.now() + 60_000).toISOString(),
      ownerId: randomUUID(),
    }),
  ]) {
    const response = await current.instance.fetch(
      current.request('https://otto.example.test/api/runtime/lease', { method: 'POST', body }),
    );
    assert.equal(response.status, body.length > 1024 ? 413 : 400);
  }
  assert.deepEqual(current.counts(), { starts: 0, forwards: 0 });
});

test('late Node acknowledgement cannot extend a revoked or replaced tenant generation', async () => {
  const acknowledged = deferred<Response>();
  const received = deferred();
  const current = leasedProcessFixture(async () => {
    received.resolve();
    return acknowledged.promise;
  });
  const renewal = current.instance.fetch(
    current.request('https://otto.example.test/api/runtime/lease', {
      method: 'POST',
      body: JSON.stringify({ expiresAt: new Date(Date.now() + 60_000).toISOString() }),
    }),
  );
  await Promise.race([
    received.promise,
    renewal.then((response) =>
      assert.fail(`The renewal finished before forwarding: ${response.status}`),
    ),
  ]);
  await current.lifecycle.stop(current.ownerId, '1');
  current.replace({
    ...current.saved(),
    generation: '2',
    stopped: false,
    revoking: false,
    leaseExpiresAt: Date.now() + 45_000,
  });
  const replaced = current.saved();
  acknowledged.resolve(Response.json({ ok: true }));
  assert.equal((await renewal).status, 409);
  assert.deepEqual(current.saved(), replaced);
});

test('expired cleanup retries while revocation permits only exact-generation computer teardown', async (t) => {
  let time = Date.UTC(2026, 8, 27, 12);
  t.mock.method(Date, 'now', () => time);
  const current = leasedProcessFixture(async () => Response.json({ ok: true }));
  assert.equal((await current.instance.storageIdentity('1')).ownerId, current.ownerId);
  await assert.rejects(current.instance.storageIdentity('2'), { status: 409 });
  await assert.rejects(current.instance.computerIdentity(current.ownerId, '1', true), {
    status: 403,
  });
  current.failStop(true);
  time = current.saved().leaseExpiresAt;
  await current.instance.expireRuntimeLease();
  assert.equal(current.saved().revoking, true);
  assert.equal(current.saved().stopped, false);
  assert.deepEqual(current.scheduled, [time + 5000]);
  await assert.rejects(current.instance.computerIdentity(current.ownerId, '1', false), {
    status: 503,
  });
  assert.equal(
    (await current.instance.computerIdentity(current.ownerId, '1', true)).generation,
    '1',
  );
  await assert.rejects(current.instance.computerIdentity(randomUUID(), '1', true), { status: 403 });
  await assert.rejects(current.instance.computerIdentity(current.ownerId, '2', true), {
    status: 403,
  });
  current.replace({ ...current.saved(), environment: 'production' });
  await assert.rejects(current.instance.computerIdentity(current.ownerId, '1', true), {
    status: 403,
  });
  current.replace({ ...current.saved(), environment: 'development' });
  current.failStop(false);
  time += 5000;
  await current.instance.expireRuntimeLease();
  assert.equal(current.saved().stopped, true);
  assert.deepEqual(current.scheduled, []);
});

test('computer routing derives owner and environment from the exact calling tenant and admits only fixed roles', async () => {
  const current = leasedProcessFixture(async () => new Response('tenant'));
  const outbound = TenantContainer.outboundByHost!['otto.computer'];
  const context = {
    className: 'TenantContainer',
    containerId: `tenant:development:${current.ownerId}`,
  };
  const foreign = randomUUID();
  const request = (role: string, version = '1') =>
    new Request('http://otto.computer/v1/commands', {
      method: 'POST',
      headers: {
        'x-otto-generation': version,
        'x-otto-computer-role': role,
        'x-otto-owner': foreign,
        'x-otto-environment': 'production',
        'x-otto-container': `computer:production:${foreign}:${role}`,
      },
      body: JSON.stringify({ id: randomUUID(), role }),
    });
  for (const role of ['browser', 'workspace']) {
    const response = await outbound(request(role), current.env, context);
    assert.equal(response.status, 200);
    assert.equal(await response.text(), role);
    const call = current.calls.at(-1)!;
    assert.equal(call.target, `computer:development:${current.ownerId}:${role}`);
    assert.deepEqual(call.input, { ownerId: current.ownerId, generation: '1' });
  }
  const admitted = current.calls.length;
  for (const className of [
    'GatewayContainer',
    'BrowserComputerContainer',
    'WorkspaceComputerContainer',
  ])
    assert.equal(
      (await outbound(request('browser'), current.env, { ...context, className })).status,
      403,
    );
  assert.equal(
    (
      await outbound(request('browser'), current.env, {
        ...context,
        containerId: `tenant:development:${foreign}`,
      })
    ).status,
    403,
  );
  assert.equal(
    (
      await outbound(
        request('browser'),
        {
          ...current.env,
          OTTO_ENVIRONMENT: 'production',
        },
        context,
      )
    ).status,
    403,
  );
  assert.equal((await outbound(request('browser', '2'), current.env, context)).status, 409);
  for (const version of ['', '0', '01', '1e2', '2'.repeat(20)])
    assert.equal((await outbound(request('browser', version), current.env, context)).status, 400);
  for (const role of ['', 'Browser', 'shell', '../workspace'])
    assert.equal((await outbound(request(role), current.env, context)).status, 400);
  current.replace({ ...current.saved(), revoking: true });
  assert.equal((await outbound(request('browser'), current.env, context)).status, 503);
  assert.equal(current.calls.length, admitted);
});

test('private storage requires the current calling tenant generation before accessing its owner prefix', async () => {
  const current = leasedProcessFixture(async () => new Response('tenant'));
  const keys: string[] = [];
  Object.assign(current.env, {
    TENANT_FILES: {
      async get(key: string) {
        keys.push(key);
        return null;
      },
    },
  });
  const outbound = TenantContainer.outboundByHost!['otto.storage'];
  const context = {
    className: 'TenantContainer',
    containerId: `tenant:development:${current.ownerId}`,
  };
  const object = randomUUID();
  const request = (version?: string) =>
    new Request(`http://otto.storage/v1/objects/artifacts%2F${object}`, {
      headers: {
        ...(version === undefined ? {} : { 'x-otto-generation': version }),
        'x-otto-owner': randomUUID(),
        'x-otto-environment': 'production',
      },
    });
  assert.equal((await outbound(request('1'), current.env, context)).status, 404);
  assert.deepEqual(keys, [`development/${current.ownerId}/artifacts/${object}`]);
  assert.equal((await outbound(request('2'), current.env, context)).status, 409);
  assert.equal((await outbound(request(), current.env, context)).status, 400);
  for (const version of ['0', '01'])
    assert.equal((await outbound(request(version), current.env, context)).status, 400);
  assert.equal(
    (
      await outbound(request('1'), current.env, {
        ...context,
        className: 'WorkspaceComputerContainer',
      })
    ).status,
    403,
  );
  assert.equal(
    (
      await outbound(request('1'), current.env, {
        ...context,
        containerId: `tenant:development:${randomUUID()}`,
      })
    ).status,
    403,
  );
  current.replace({ ...current.saved(), leaseExpiresAt: Date.now() - 1 });
  assert.equal((await outbound(request('1'), current.env, context)).status, 503);
  assert.equal(keys.length, 1);
});

function initializedTenantFixture(stops: {
  browser(): { stopped: boolean } | Promise<{ stopped: boolean }>;
  workspace(): { stopped: boolean } | Promise<{ stopped: boolean }>;
}) {
  const { env, ownerId, identity } = fixture();
  const values = new Map<string, unknown>([['identity', { ...identity }]]);
  const container = { running: false };
  const events: string[] = [];
  const context = {
    id: { toString: () => `tenant:development:${ownerId}` },
    container,
    blockConcurrencyWhile: async () => {},
    storage: {
      kv: { get: () => undefined },
      sql: { exec: () => [] },
      get: async (key: string) => structuredClone(values.get(key)),
      put: async (key: string, value: unknown) => {
        values.set(key, structuredClone(value));
      },
    },
  };
  const namespace = (role: 'browser' | 'workspace') => ({
    getByName(name: string) {
      assert.equal(name, `computer:development:${ownerId}:${role}`);
      return {
        stopComputer(owner: string, generation: string) {
          events.push(role);
          assert.equal(owner, ownerId);
          assert.equal(generation, '1');
          assert.equal((values.get('identity') as TenantIdentity).revoking, true);
          return stops[role]();
        },
      };
    },
  });
  Object.assign(env, {
    BROWSER_COMPUTERS: namespace('browser'),
    WORKSPACE_COMPUTERS: namespace('workspace'),
  });
  const instance = new TenantContainer(
    context as unknown as ConstructorParameters<typeof TenantContainer>[0],
    env,
  );
  container.running = true;
  Object.assign(instance, {
    getState: async () => ({ status: container.running ? 'healthy' : 'stopped' }),
    stop: async () => {
      events.push('tenant');
      container.running = false;
    },
    deleteSchedules: () => {},
    schedule: async () => {},
  });
  return {
    instance,
    ownerId,
    events,
    identity: () => structuredClone(values.get('identity')) as TenantIdentity,
  };
}

test('tenant stop waits for both fixed computer roles to confirm termination', async () => {
  const browser = deferred<{ stopped: boolean }>();
  const workspace = deferred<{ stopped: boolean }>();
  const entered = deferred();
  const current = initializedTenantFixture({
    browser: () => browser.promise,
    workspace: () => {
      entered.resolve();
      return workspace.promise;
    },
  });
  const stopping = current.instance.stopRuntime(current.ownerId, '1');
  await entered.promise;
  assert.deepEqual(current.events, ['browser', 'workspace']);
  assert.equal(current.identity().revoking, true);
  assert.equal(current.identity().stopped, false);
  browser.resolve({ stopped: true });
  await browser.promise;
  assert.deepEqual(current.events, ['browser', 'workspace']);
  workspace.resolve({ stopped: true });
  assert.deepEqual(await stopping, { ok: true, generation: '1', stopped: true });
  assert.deepEqual(current.events, ['browser', 'workspace', 'tenant']);
  assert.equal(current.identity().stopped, true);
});

test('unconfirmed or failed computer stops attempt both roles and retain tenant revocation', async (t) => {
  for (const [name, stop] of [
    ['unconfirmed', () => ({ stopped: false })],
    ['rejected', () => Promise.reject(new Error('synthetic private computer error'))],
    [
      'synchronous failure',
      () => {
        throw new Error('synthetic private RPC error');
      },
    ],
  ] as const) {
    await t.test(name, async () => {
      const workspace = deferred<{ stopped: boolean }>();
      const entered = deferred();
      const current = initializedTenantFixture({
        browser: stop,
        workspace: () => {
          entered.resolve();
          return workspace.promise;
        },
      });
      const stopping = current.instance.stopRuntime(current.ownerId, '1');
      const rejected = assert.rejects(stopping, { status: 503 });
      await Promise.race([
        entered.promise,
        rejected.then(() => assert.fail('The second computer stop was not attempted')),
      ]);
      assert.deepEqual(current.events, ['browser', 'workspace']);
      workspace.resolve({ stopped: true });
      await rejected;
      assert.deepEqual(current.events, ['browser', 'workspace']);
      assert.equal(current.identity().revoking, true);
      assert.equal(current.identity().stopped, false);
      await assert.rejects(current.instance.storageIdentity('1'), { status: 503 });
    });
  }
});
