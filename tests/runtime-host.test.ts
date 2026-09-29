import assert from 'node:assert/strict';
import { randomBytes, randomUUID } from 'node:crypto';
import test, { type TestContext } from 'node:test';
import { setImmediate } from 'node:timers/promises';
import { createTenantRuntimeHost } from '../src/server/runtime-host.ts';
import {
  createRuntimeVerifier,
  runtimeBodyHash,
  runtimeHeader,
} from '../src/server/runtime-auth.ts';
import type { RuntimeConfiguration } from '../src/ports/runtime-transport.ts';
import type { TenantLease } from '../src/server/tenants.ts';

function deferred<T = void>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
}

async function bounded<T>(promise: Promise<T>) {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_, reject) => {
        timer = setTimeout(
          () => reject(new Error('Fixture did not reach the expected boundary.')),
          2_000,
        );
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

function fixture(
  t: TestContext,
  heartbeatMs = 15_000,
  diagnostics: { enabled?: boolean; developers?: ReadonlySet<string> } = {},
  operatorEnvironment: Record<string, string | undefined> = {},
) {
  const masterKey = randomBytes(32);
  const leases = new Map<string, TenantLease>();
  const generations = new Map<string, number>();
  const actors = new Map<string, string>();
  const starts: RuntimeConfiguration[] = [];
  const stops: { ownerId: string; generation: string }[] = [];
  const releases: TenantLease[] = [];
  const requests: { ownerId: string; request: Request }[] = [];
  const hooks: {
    start?: (configuration: RuntimeConfiguration) => Promise<void>;
    stop?: (ownerId: string, generation: string) => Promise<void>;
    renew?: (lease: TenantLease) => Promise<TenantLease | undefined>;
    fetch?: (ownerId: string, request: Request) => Promise<Response>;
    prepare?: (ownerId: string, generation: string) => Promise<'stopped' | 'busy'>;
    stopped?: (ownerId: string, generation: string | null) => Promise<boolean>;
    status?: (ownerId: string) => Promise<{ generation: string | null; stopped: boolean }>;
    owners?: () => Promise<string[]>;
    deploymentClosed?: boolean;
    denyLease?: boolean;
  } = {};
  let closes = 0;
  let closedChecks = 0;
  const record = (ownerId: string) => ({
    ownerId,
    environment: 'development',
    role: `role_${ownerId}`,
    appSchema: 'app',
    jobsSchema: 'jobs',
    credentialVersion: 1,
  });
  const host = createTenantRuntimeHost({
    masterKey,
    environment: 'development',
    heartbeatMs,
    developerIds: diagnostics.developers,
    operatorEnvironment: {
      DEV_INSPECTOR: String(diagnostics.enabled ?? false),
      OTTO_PUBLIC_URL: 'https://otto.example.test',
      OTTO_RUNTIME_URL: 'http://otto.runtime',
      OTTO_MASTER_KEY: 'synthetic-master-key',
      AUTH_SECRET: 'synthetic-auth-secret',
      GOOGLE_CLIENT_SECRET: 'synthetic-google-secret',
      DATABASE_URL: 'postgresql://operator:private@db.example.test/control',
      OPENAI_API_KEY: 'synthetic-server-provider-key',
      COMPUTER_PROVIDER: 'e2b',
      OBJECT_STORAGE_ROOT: '/private/otto-files',
      ...operatorEnvironment,
    },
    tenants: {
      async listOwners() {
        return hooks.owners ? hooks.owners() : [...generations.keys()];
      },
      async provision(ownerId) {
        return record(ownerId);
      },
      async runtimeConfiguration(ownerId) {
        return {
          ...record(ownerId),
          databaseUrl: `postgresql://${ownerId}:synthetic@db.example.test/tenant`,
          poolMax: 4,
        };
      },
      async acquireLease(ownerId, holderId, duration = 60_000) {
        if (
          hooks.denyLease ||
          (leases.has(ownerId) && Date.parse(leases.get(ownerId)!.expiresAt) > Date.now())
        )
          return undefined;
        const generation = (generations.get(ownerId) ?? 0) + 1;
        generations.set(ownerId, generation);
        const lease = {
          ownerId,
          holderId,
          environment: 'development',
          generation: String(generation),
          expiresAt: new Date(Date.now() + duration).toISOString(),
        };
        leases.set(ownerId, lease);
        return lease;
      },
      async renewLease(lease) {
        if (hooks.renew) return hooks.renew(lease);
        return { ...lease, expiresAt: new Date(Date.now() + 60_000).toISOString() };
      },
      async releaseLease(lease) {
        releases.push(lease);
        if (leases.get(lease.ownerId)?.generation !== lease.generation) return false;
        leases.delete(lease.ownerId);
        return true;
      },
    },
    transport: {
      async deploymentClosed() {
        closedChecks++;
        return hooks.deploymentClosed ?? false;
      },
      async deploymentStopped(ownerId, generation) {
        return (await hooks.stopped?.(ownerId, generation)) ?? false;
      },
      async prepareDeployment(ownerId, generation) {
        const result = (await hooks.prepare?.(ownerId, generation)) ?? 'stopped';
        if (result === 'stopped') actors.delete(ownerId);
        return result;
      },
      async status(ownerId) {
        if (hooks.status) return hooks.status(ownerId);
        return { generation: actors.get(ownerId) ?? null, stopped: !actors.has(ownerId) };
      },
      async start(configuration) {
        starts.push(configuration);
        actors.set(configuration.ownerId, configuration.generation);
        await hooks.start?.(configuration);
      },
      async stop(ownerId, generation) {
        stops.push({ ownerId, generation });
        await hooks.stop?.(ownerId, generation);
        if (actors.get(ownerId) === generation) actors.delete(ownerId);
      },
      async fetch(ownerId, request) {
        requests.push({ ownerId, request });
        if (hooks.fetch) return hooks.fetch(ownerId, request);
        return Response.json({ ownerId });
      },
      async close() {
        closes++;
      },
    },
  });
  t.after(() => host.close().catch(() => {}));
  const request = (ownerId: string) =>
    host.fetch(ownerId, new Request('https://otto.example.test/api/state'), {
      developer: false,
    });
  return {
    host,
    leases,
    generations,
    actors,
    starts,
    stops,
    releases,
    requests,
    hooks,
    request,
    closes: () => closes,
    closedChecks: () => closedChecks,
  };
}

test('runtime diagnostics require both operator capture and an assigned developer owner', async (t) => {
  const developer = randomUUID();
  const ordinaryUser = randomUUID();
  const enabled = fixture(t, 15_000, { enabled: true, developers: new Set([developer]) });
  await enabled.request(developer);
  await enabled.request(ordinaryUser);
  assert.equal(enabled.starts[0].environment.DEV_INSPECTOR, 'true');
  assert.equal(enabled.starts[1].environment.DEV_INSPECTOR, 'false');
  const disabled = fixture(t, 15_000, { enabled: false, developers: new Set([developer]) });
  await disabled.request(developer);
  assert.equal(disabled.starts[0].environment.DEV_INSPECTOR, 'false');
});

test('runtime derives the Composio callback from the public origin for each fixed owner', async (t) => {
  const f = fixture(
    t,
    15_000,
    {},
    {
      OTTO_COMPOSIO_WEBHOOK_URL: 'https://foreign.example.test/callback',
    },
  );
  const owners = [randomUUID(), randomUUID()];
  for (const owner of owners) await f.request(owner);
  assert.equal(f.starts.length, owners.length);
  for (const [index, configuration] of f.starts.entries()) {
    assert.equal(configuration.ownerId, owners[index]);
    assert.equal(configuration.environment.OTTO_OWNER_ID, owners[index]);
    assert.equal(
      configuration.environment.OTTO_COMPOSIO_WEBHOOK_URL,
      'https://otto.example.test/api/webhooks/composio',
    );
    assert.equal(configuration.environment.OTTO_WEBHOOK_ORIGIN, undefined);
  }
});

test('runtime uses the explicit tunnel origin without forwarding raw webhook configuration', async (t) => {
  const f = fixture(
    t,
    15_000,
    {},
    {
      OTTO_PUBLIC_URL: 'http://localhost:4330',
      OTTO_WEBHOOK_ORIGIN: 'https://tunnel.example.test/',
    },
  );
  await f.request(randomUUID());
  assert.equal(
    f.starts[0].environment.OTTO_COMPOSIO_WEBHOOK_URL,
    'https://tunnel.example.test/api/webhooks/composio',
  );
  assert.equal(f.starts[0].environment.OTTO_PUBLIC_URL, 'http://localhost:4330');
  assert.equal(f.starts[0].environment.OTTO_WEBHOOK_ORIGIN, undefined);
});

test('runtime leaves local HTTP Composio callbacks unconfigured without an explicit tunnel', async (t) => {
  for (const origin of ['http://localhost:4330', 'http://127.0.0.1:4330', 'http://[::1]:4330']) {
    const f = fixture(t, 15_000, {}, { OTTO_PUBLIC_URL: origin });
    await f.request(randomUUID());
    assert.equal(f.starts[0].environment.OTTO_COMPOSIO_WEBHOOK_URL, undefined);
  }
});

test('runtime rejects malformed explicit webhook origins before tenant startup without exposing values', (t) => {
  for (const origin of [
    'private-invalid-origin',
    'http://localhost:4331',
    'http://private.example.test',
    'https://private.example.test/path',
    'https://private.example.test/?secret=private',
    'https://private.example.test/#private',
    'https://private-user:private-password@private.example.test',
  ])
    assert.throws(() => fixture(t, 15_000, {}, { OTTO_WEBHOOK_ORIGIN: origin }), {
      message: 'The webhook origin is invalid.',
    });
});

function deploymentInput() {
  return { nonce: randomUUID(), targetRelease: 'a'.repeat(40), deadline: Date.now() + 30_000 };
}

async function deploymentResponse(request: Request, generation = '1') {
  if (new URL(request.url).pathname === '/api/runtime/drain') {
    const input = (await request.json()) as ReturnType<typeof deploymentInput>;
    return Response.json({
      ok: true,
      nonce: input.nonce,
      targetRelease: input.targetRelease,
      generation,
      drained: true,
    });
  }
  return Response.json({ ok: true });
}

test('deployment drain blocks starts, preserves heartbeat and stops only after the tenant acknowledges natural drain', async (t) => {
  const f = fixture(t, 100);
  const owner = randomUUID();
  await f.request(owner);
  const draining = deferred();
  const drained = deferred();
  const renewed = deferred();
  let prepared = false;
  f.hooks.renew = async (lease) => {
    renewed.resolve();
    return { ...lease, expiresAt: new Date(Date.now() + 60_000).toISOString() };
  };
  f.hooks.fetch = async (_owner, request) => {
    if (new URL(request.url).pathname === '/api/runtime/drain') {
      draining.resolve();
      await drained.promise;
    }
    return deploymentResponse(request);
  };
  f.hooks.prepare = async () => {
    prepared = true;
    return 'stopped';
  };
  const input = deploymentInput();
  const operation = f.host.prepareDeployment!(input);
  await bounded(draining.promise);
  await assert.rejects(f.request(randomUUID()));
  await bounded(renewed.promise);
  assert.equal(prepared, false);
  assert.equal(f.stops.length, 0);
  drained.resolve();
  assert.deepEqual(await operation, [{ ownerId: owner, generation: '1' }]);
  assert.equal(prepared, true);
  assert.equal(f.releases.length, 1);
  assert.equal(f.starts.length, 1);
});

test('an untouched busy computer permits explicit abort while a partial completed owner restarts in a new generation', async (t) => {
  const f = fixture(t);
  const first = randomUUID();
  const second = randomUUID();
  await f.request(first);
  await f.request(second);
  f.hooks.fetch = async (_owner, request) => deploymentResponse(request);
  f.hooks.prepare = async (owner) => (owner === second ? 'busy' : 'stopped');
  const input = deploymentInput();
  await assert.rejects(f.host.prepareDeployment!(input), { status: 409 });
  assert.deepEqual(f.stops, [{ ownerId: first, generation: '1' }]);
  await assert.rejects(f.host.resumeDeployment!({ ...input, nonce: randomUUID() }));
  await f.host.resumeDeployment!(input);
  await f.request(first);
  await f.request(second);
  assert.equal(f.starts.filter((value) => value.ownerId === first).at(-1)!.generation, '2');
  assert.equal(f.starts.filter((value) => value.ownerId === second).length, 1);
  assert.ok(
    f.requests.some(
      ({ ownerId, request }) => ownerId === second && request.url.endsWith('/api/runtime/resume'),
    ),
  );
});

test('unknown computer preparation cannot be resumed or replaced by a different deployment', async (t) => {
  const f = fixture(t);
  await f.request(randomUUID());
  f.hooks.fetch = async (_owner, request) => deploymentResponse(request);
  f.hooks.prepare = async () => {
    throw new Error('Synthetic lost acknowledgement');
  };
  const input = deploymentInput();
  await assert.rejects(f.host.prepareDeployment!(input), {
    status: 503,
    message: 'The deployment operation could not be completed.',
  });
  await assert.rejects(f.host.resumeDeployment!(input));
  await assert.rejects(f.host.prepareDeployment!(deploymentInput()));
  await assert.rejects(f.request(randomUUID()));
  assert.equal(f.stops.length, 0);
  assert.equal(f.releases.length, 0);
});

test('preexisting pending starts join the deployment drain and do not admit their delayed user request', async (t) => {
  const f = fixture(t);
  const starting = deferred();
  const ready = deferred();
  f.hooks.start = async () => {
    starting.resolve();
    await ready.promise;
  };
  f.hooks.fetch = async (_owner, request) => deploymentResponse(request);
  const owner = randomUUID();
  const request = f.request(owner);
  const rejected = assert.rejects(request);
  await bounded(starting.promise);
  const operation = f.host.prepareDeployment!(deploymentInput());
  await setImmediate();
  assert.equal(f.requests.length, 0);
  ready.resolve();
  await rejected;
  assert.deepEqual(await operation, [{ ownerId: owner, generation: '1' }]);
});

test('persistent maintenance prevents gateway restore from acquiring or starting another tenant', async (t) => {
  const f = fixture(t);
  f.hooks.deploymentClosed = true;
  await assert.rejects(f.request(randomUUID()));
  assert.equal(f.leases.size, 0);
  assert.equal(f.starts.length, 0);
});

test('lost gateway journal recovers only after exact clean-stop inspection of every persisted owner', async (t) => {
  const f = fixture(t);
  const first = randomUUID();
  const unused = randomUUID();
  f.generations.set(first, 42);
  f.generations.set(unused, 0);
  f.hooks.deploymentClosed = true;
  f.hooks.status = async (ownerId) => ({
    generation: ownerId === first ? '42' : null,
    stopped: true,
  });
  const entered = deferred();
  const ready = deferred();
  const inspected: { ownerId: string; generation: string | null }[] = [];
  f.hooks.stopped = async (ownerId, generation) => {
    inspected.push({ ownerId, generation });
    if (ownerId === first) {
      entered.resolve();
      await ready.promise;
    }
    return true;
  };
  const input = { ...deploymentInput(), deadline: Date.now() - 1_000 };
  const recovery = f.host.resumeDeployment!(input);
  await bounded(entered.promise);
  await assert.rejects(f.request(first));
  ready.resolve();
  await recovery;
  await f.host.resumeDeployment!(input);
  assert.deepEqual(inspected, [
    { ownerId: first, generation: '42' },
    { ownerId: unused, generation: null },
  ]);
  assert.equal(f.starts.length, 0);
  assert.equal(f.stops.length, 0);
  assert.equal(f.leases.size, 0);
  assert.equal(f.releases.length, 0);
  assert.equal(f.requests.length, 0);
  f.hooks.deploymentClosed = false;
  f.hooks.status = undefined;
  await f.request(first);
  assert.equal(f.starts[0].generation, '43');
});

test('failed restart inspection stays paused and retries every owner without clearing a fence or acquiring a lease', async (t) => {
  const f = fixture(t);
  const owners = [randomUUID(), randomUUID()];
  f.hooks.owners = async () => owners;
  f.hooks.deploymentClosed = true;
  f.hooks.status = async () => ({ generation: '7', stopped: true });
  let clean = false;
  const inspected: string[] = [];
  f.hooks.stopped = async (ownerId) => {
    inspected.push(ownerId);
    return ownerId !== owners[1] || clean;
  };
  const input = deploymentInput();
  await assert.rejects(f.host.resumeDeployment!(input));
  await assert.rejects(f.host.resumeDeployment!({ ...input, nonce: randomUUID() }));
  await assert.rejects(f.host.prepareDeployment!(input));
  await assert.rejects(f.request(owners[0]));
  clean = true;
  await f.host.resumeDeployment!(input);
  assert.deepEqual(inspected, [...owners, ...owners]);
  assert.equal(f.starts.length, 0);
  assert.equal(f.stops.length, 0);
  assert.equal(f.releases.length, 0);
});

test('restart recovery refuses open maintenance, live tenants and inspection failures', async (t) => {
  for (const condition of ['open', 'running', 'unknown'] as const) {
    await t.test(condition, async (subtest) => {
      const f = fixture(subtest);
      const owner = randomUUID();
      f.hooks.owners = async () => [owner];
      f.hooks.deploymentClosed = condition !== 'open';
      f.hooks.status = async () => ({ generation: '2', stopped: condition !== 'running' });
      f.hooks.stopped = async () => {
        throw new Error('Synthetic unknown stop outcome.');
      };
      await assert.rejects(f.host.resumeDeployment!(deploymentInput()));
      await assert.rejects(f.request(owner));
      assert.equal(f.starts.length, 0);
      assert.equal(f.stops.length, 0);
      assert.equal(f.leases.size, 0);
    });
  }
});

test('runtime startup is shared per owner while different owners retain separate credentials and signatures', async (t) => {
  const f = fixture(t);
  const first = randomUUID();
  const second = randomUUID();
  const entered = deferred();
  const ready = deferred();
  f.hooks.start = async (configuration) => {
    if (configuration.ownerId === first) {
      entered.resolve();
      await ready.promise;
    }
  };
  const waiting = Array.from({ length: 8 }, () => f.request(first));
  try {
    await bounded(entered.promise);
    assert.equal((await f.request(second)).status, 200);
    assert.equal(f.starts.length, 2);
  } finally {
    ready.resolve();
  }
  assert.equal(
    (await Promise.all(waiting)).every((response) => response.status === 200),
    true,
  );
  assert.equal(f.starts.filter((start) => start.ownerId === first).length, 1);
  const [a, b] = f.starts;
  for (const key of [
    'OTTO_RUNTIME_SECRET',
    'OTTO_VAULT_KEY',
    'DATABASE_URL',
    'OTTO_TELEGRAM_WEBHOOK_URL',
  ])
    assert.notEqual(a.environment[key], b.environment[key]);
  for (const configuration of f.starts) {
    assert.equal(configuration.environment.OTTO_OWNER_ID, configuration.ownerId);
    assert.equal(configuration.environment.OTTO_CONTROL_URL, 'http://otto.control');
    assert.equal(configuration.environment.OPENAI_API_KEY, 'synthetic-server-provider-key');
    assert.equal(configuration.environment.DEV_INSPECTOR, 'false');
    assert.equal(
      configuration.environment.OBJECT_STORAGE_ROOT,
      `/private/otto-files/${configuration.ownerId}`,
    );
    for (const key of ['OTTO_MASTER_KEY', 'AUTH_SECRET', 'GOOGLE_CLIENT_SECRET'])
      assert.equal(configuration.environment[key], undefined);
    assert.ok(configuration.environment.DATABASE_URL.includes(configuration.ownerId));
  }
  const body = JSON.stringify({ text: 'synthetic task' });
  await f.host.fetch(
    first,
    new Request('https://otto.example.test/api/messages?cursor=one%2Ftwo', {
      method: 'POST',
      body,
      headers: {
        cookie: 'private-cookie',
        authorization: 'Bearer private',
        host: 'untrusted.test',
        'x-otto-account': second,
        [runtimeHeader]: 'forged',
        'content-type': 'application/json',
      },
    }),
    { developer: true },
  );
  const forwarded = f.requests.at(-1)!;
  for (const name of ['cookie', 'authorization', 'host', 'x-otto-account'])
    assert.equal(forwarded.request.headers.get(name), null);
  const context = {
    secret: a.environment.OTTO_RUNTIME_SECRET,
    ownerId: first,
    environment: 'development',
    generation: a.generation,
  };
  const claims = createRuntimeVerifier(context).verify(
    forwarded.request.headers.get(runtimeHeader),
    'POST',
    '/api/messages?cursor=one%2Ftwo',
  );
  assert.equal(claims?.bodyHash, runtimeBodyHash(Buffer.from(body)));
  assert.equal(claims?.developer, true);
  assert.equal(claims?.kind, 'user');
  assert.equal(await forwarded.request.text(), body);
  assert.equal(
    createRuntimeVerifier({
      ...context,
      ownerId: second,
      secret: b.environment.OTTO_RUNTIME_SECRET,
    }).verify(
      forwarded.request.headers.get(runtimeHeader),
      'POST',
      '/api/messages?cursor=one%2Ftwo',
    ),
    null,
  );
});

test('an unavailable lease never starts or addresses an actor', async (t) => {
  const f = fixture(t);
  f.hooks.denyLease = true;
  await assert.rejects(f.request(randomUUID()), /restarting/);
  assert.equal(f.starts.length, 0);
  assert.equal(f.requests.length, 0);
});

test('failed startup cleans up only its generation and a retry obtains a new lease', async (t) => {
  const f = fixture(t);
  const owner = randomUUID();
  f.actors.set(owner, 'previous');
  f.hooks.start = async () => {
    throw new Error('private transport detail');
  };
  await assert.rejects(f.request(owner), (error) => {
    assert.equal(
      (error as Error).message,
      'The account runtime could not start. Try again shortly.',
    );
    return true;
  });
  assert.deepEqual(
    f.stops.map((stop) => stop.generation),
    ['previous', '1'],
  );
  assert.equal(f.releases.length, 1);
  assert.equal(f.leases.has(owner), false);
  f.hooks.start = undefined;
  assert.equal((await f.request(owner)).status, 200);
  assert.equal(f.starts.at(-1)!.generation, '2');
});

test('shutdown waits for startup, rejects late readiness and closes once', async (t) => {
  const f = fixture(t);
  const owner = randomUUID();
  const entered = deferred();
  const ready = deferred();
  f.hooks.start = async () => {
    entered.resolve();
    await ready.promise;
  };
  const request = assert.rejects(f.request(owner), /could not start/);
  await bounded(entered.promise);
  const closing = f.host.close();
  const again = f.host.close();
  await setImmediate();
  assert.equal(f.closes(), 0);
  ready.resolve();
  await Promise.all([request, closing, again]);
  assert.equal(f.requests.length, 0);
  assert.equal(f.stops.length, 1);
  assert.equal(f.releases.length, 1);
  assert.equal(f.closes(), 1);
  await assert.rejects(f.request(owner), /unavailable/);
});

test('a request body that finishes after shutdown cannot reach a stopped actor', async (t) => {
  const f = fixture(t);
  const owner = randomUUID();
  await f.request(owner);
  const entered = deferred();
  const body = deferred<ArrayBuffer>();
  const request = new Request('https://otto.example.test/api/messages', {
    method: 'POST',
    body: '{}',
  });
  request.arrayBuffer = () => {
    entered.resolve();
    return body.promise;
  };
  const result = assert.rejects(f.host.fetch(owner, request, { developer: false }), /unavailable/);
  await bounded(entered.promise);
  await f.host.close();
  body.resolve(new ArrayBuffer(0));
  await result;
  assert.equal(f.requests.length, 1);
  assert.equal(f.closes(), 1);
});

test('shutdown drains in-flight renewal and never sends a lease heartbeat after transport closes', async (t) => {
  const f = fixture(t, 100);
  const owner = randomUUID();
  const entered = deferred();
  const renewal = deferred<TenantLease>();
  f.hooks.renew = async () => {
    entered.resolve();
    return renewal.promise;
  };
  await f.request(owner);
  await bounded(entered.promise);
  const closing = f.host.close();
  await setImmediate();
  assert.equal(f.closes(), 0);
  renewal.resolve({
    ...f.leases.get(owner)!,
    expiresAt: new Date(Date.now() + 60_000).toISOString(),
  });
  await closing;
  assert.equal(f.requests.length, 1);
  assert.equal(f.releases.length, 1);
  assert.equal(f.stops.length, 1);
  assert.equal(f.closes(), 1);
});

test('lease loss retains ownership until stop succeeds and concurrent retries create one replacement', async (t) => {
  const f = fixture(t, 100);
  const owner = randomUUID();
  const failedStop = deferred();
  f.hooks.renew = async () => undefined;
  f.hooks.stop = async () => {
    failedStop.resolve();
    throw new Error('private stop detail');
  };
  await f.request(owner);
  await bounded(failedStop.promise);
  await setImmediate();
  assert.equal(f.releases.length, 0);
  assert.ok(f.leases.has(owner));
  f.hooks.stop = undefined;
  f.hooks.renew = undefined;
  assert.ok(
    (await Promise.all(Array.from({ length: 8 }, () => f.request(owner)))).every(
      (response) => response.ok,
    ),
  );
  assert.equal(f.starts.length, 2);
  assert.equal(f.releases.length, 1);
  assert.equal(f.starts[1].generation, '2');
});

test('ready runtimes serve admitted requests without a deployment status round trip', async (t) => {
  const f = fixture(t);
  const owner = randomUUID();
  await f.request(owner);
  assert.equal(f.closedChecks(), 1);
  await f.request(owner);
  await f.host.fetch(owner, new Request('https://otto.example.test/api/webhooks/composio'), {
    developer: false,
    kind: 'webhook',
  });
  await f.host.warm!(owner);
  assert.equal(f.closedChecks(), 1);
  assert.equal(f.requests.length, 3);
  f.hooks.deploymentClosed = true;
  await assert.rejects(
    f.host.fetch(owner, new Request('http://otto.runtime/api/runtime/wake', { method: 'POST' }), {
      developer: false,
      kind: 'wake',
    }),
  );
  await assert.rejects(f.host.warm!(randomUUID()));
  assert.equal(f.closedChecks(), 3);
  assert.equal(f.requests.length, 3);
  assert.equal(f.starts.length, 1);
  assert.equal(f.leases.size, 1);
});

test('an in-process drain rejects ready runtimes before any tenant request', async (t) => {
  const f = fixture(t);
  const owner = randomUUID();
  await f.request(owner);
  const drained = deferred<Response>();
  f.hooks.fetch = async (_owner, request) =>
    new URL(request.url).pathname === '/api/runtime/drain'
      ? drained.promise
      : Response.json({ ok: true });
  const operation = f.host.prepareDeployment!(deploymentInput());
  await setImmediate();
  await assert.rejects(f.request(owner));
  await assert.rejects(f.host.warm!(owner));
  assert.equal(f.requests.length, 2);
  assert.equal(new URL(f.requests[1].request.url).pathname, '/api/runtime/drain');
  drained.reject(new Error('Synthetic drain stop.'));
  await assert.rejects(operation);
});

test('session warm-up shares one runtime start with the first request', async (t) => {
  const f = fixture(t);
  const owner = randomUUID();
  const entered = deferred();
  const ready = deferred();
  f.hooks.start = async () => {
    entered.resolve();
    await ready.promise;
  };
  const warming = f.host.warm!(owner);
  await bounded(entered.promise);
  const request = f.request(owner);
  const repeated = f.host.warm!(owner);
  ready.resolve();
  await Promise.all([warming, request, repeated]);
  await f.host.warm!(owner);
  assert.equal(f.starts.length, 1);
  assert.equal(f.leases.size, 1);
  assert.equal(f.requests.length, 1);
});
