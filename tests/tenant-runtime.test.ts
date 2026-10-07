import assert from 'node:assert/strict';
import { randomBytes, randomUUID } from 'node:crypto';
import test, { describe, type TestContext } from 'node:test';
import { setImmediate, setTimeout as delay } from 'node:timers/promises';
import { createTenantRuntimeHost } from '../src/server/runtime-host.ts';
import {
  createRuntimeVerifier,
  runtimeBodyHash,
  runtimeHeader,
  registerRuntimeAccess,
  signRuntimeRequest,
  type RuntimeClaims,
} from '../src/server/runtime-auth.ts';
import type { RuntimeConfiguration } from '../src/ports/runtime-transport.ts';
import {
  createTenantStore,
  tenantIdentifiers,
  TenantError,
  type TenantLease,
} from '../src/server/tenants.ts';
import Fastify from 'fastify';
import { createRuntimeLease } from '../src/server/runtime-lease.ts';
import { request as httpRequest } from 'node:http';
import {
  createTenantDrain,
  registerTenantDrain,
  registerWorkAdmission,
} from '../src/server/tenant-drain.ts';
import { createWorkAdmission, createWorkConsumers } from '../src/server/work-admission.ts';
import pg from 'pg';
import { PgBoss } from 'pg-boss';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { createLocalRuntimeTransport } from '../src/providers/runtime-host/local.ts';
import { registerLocalAccess } from '../src/server/access.ts';

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

describe('runtime host', () => {
  function deferred<T = void>() {
    let resolve!: (value: T | PromiseLike<T>) => void;
    let reject!: (reason?: unknown) => void;
    const promise = new Promise<T>((yes, no) => {
      resolve = yes;
      reject = no;
    });
    return { promise, resolve, reject };
  }

  function fixture(t: TestContext, heartbeatMs = 15_000) {
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
      operatorEnvironment: {
        DEV_INSPECTOR: 'false',
        OTTO_PUBLIC_URL: 'https://otto.example.test',
        OTTO_RUNTIME_URL: 'http://otto.runtime',
        OTTO_MASTER_KEY: 'synthetic-master-key',
        AUTH_SECRET: 'synthetic-auth-secret',
        GOOGLE_CLIENT_SECRET: 'synthetic-google-secret',
        UNLISTED_OPERATOR_SECRET: 'synthetic-unlisted-secret',
        DATABASE_URL: 'postgresql://operator:private@db.example.test/control',
        OPENAI_API_KEY: 'synthetic-server-provider-key',
        COMPUTER_PROVIDER: 'e2b',
        OBJECT_STORAGE_ROOT: '/private/otto-files',
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
    };
  }

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
      for (const key of [
        'OTTO_MASTER_KEY',
        'AUTH_SECRET',
        'GOOGLE_CLIENT_SECRET',
        'UNLISTED_OPERATOR_SECRET',
      ])
        assert.equal(configuration.environment[key], undefined);
      assert.equal(
        Object.values(configuration.environment).some((value) =>
          /synthetic-(master-key|auth-secret|google-secret|unlisted-secret)/.test(value),
        ),
        false,
      );
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
});

describe('runtime lease', () => {
  test('runtime lease tolerates bounded clock skew but fences expired work and cannot be resurrected', async (t) => {
    const now = Date.parse('2026-09-26T10:00:00Z');
    t.mock.timers.enable({ apis: ['Date', 'setTimeout'], now });
    let fences = 0;
    const lease = createRuntimeLease({
      expiresAt: new Date(now + 64_000).toISOString(),
      fence: () => {
        fences++;
      },
    });
    const app = Fastify();
    app.get('/api/fixture', async () => ({ ok: true }));
    lease.register(app);
    t.after(async () => {
      lease.close();
      await app.close();
    });
    assert.equal((await app.inject('/api/fixture')).statusCode, 200);
    assert.throws(() =>
      createRuntimeLease({ expiresAt: new Date(now + 65_001).toISOString(), fence: () => {} }),
    );
    t.mock.timers.tick(30_000);
    assert.equal(
      (
        await app.inject({
          method: 'POST',
          url: '/api/runtime/lease',
          payload: { expiresAt: new Date(now + 90_000).toISOString() },
        })
      ).statusCode,
      200,
    );
    t.mock.timers.tick(59_999);
    assert.equal(fences, 0);
    t.mock.timers.tick(1);
    assert.equal(fences, 1);
    assert.equal((await app.inject('/api/fixture')).statusCode, 503);
    assert.equal(
      (
        await app.inject({
          method: 'POST',
          url: '/api/runtime/lease',
          payload: { expiresAt: new Date(now + 120_000).toISOString() },
        })
      ).statusCode,
      503,
    );
    t.mock.timers.tick(60_000);
    assert.equal(fences, 1);
  });
});

describe('tenant drain', () => {
  function gate() {
    let resolve!: () => void;
    const promise = new Promise<void>((done) => {
      resolve = done;
    });
    return { promise, resolve };
  }

  function fixture(
    computer?: { pause(): Promise<void>; resume(): Promise<void> },
    desktop = false,
  ) {
    const app = Fastify();
    const identity = {
      secret: randomBytes(32).toString('base64url'),
      ownerId: randomUUID(),
      environment: 'development',
      generation: '7',
    };
    const admission = createWorkAdmission();
    const consumers = createWorkConsumers();
    const drain = createTenantDrain({ admission, consumers, computer });
    if (desktop) {
      registerLocalAccess(app, 4310, { token: identity.secret });
      registerWorkAdmission(app, admission);
    } else {
      registerRuntimeAccess(app, identity);
      registerTenantDrain(app, { admission, drain, generation: identity.generation });
    }
    app.setErrorHandler((error, _request, reply) => {
      const status = (error as { statusCode?: number }).statusCode ?? 503;
      reply.code(status).send({ error: 'The request could not be completed.' });
    });
    app.post('/api/runtime/lease', async () => ({ ok: true }));
    const headers = (path: string, body: string, kind: RuntimeClaims['kind'] = 'user') =>
      desktop
        ? {
            host: '127.0.0.1:4310',
            'content-type': 'application/json',
            'x-otto-desktop-token': identity.secret,
          }
        : {
            'content-type': 'application/json',
            'x-otto-runtime': signRuntimeRequest({
              ...identity,
              method: 'POST',
              target: path,
              body: Buffer.from(body),
              developer: false,
              kind,
            }),
          };
    const request = (path: string, body: unknown = {}, kind: RuntimeClaims['kind'] = 'user') => {
      const payload = JSON.stringify(body);
      return app.inject({
        method: 'POST',
        url: path,
        payload,
        headers: headers(path, payload, kind),
      });
    };
    return { app, identity, admission, consumers, drain, headers, request };
  }

  test('desktop shutdown waits for admitted requests, refuses new ones and has no drain routes', async () => {
    const f = fixture(undefined, true);
    const started = gate();
    const finish = gate();
    let effects = 0;
    let closed = false;
    f.app.post('/api/work', async () => {
      effects++;
      started.resolve();
      await finish.promise;
      return { ok: true };
    });
    const input = {
      nonce: randomUUID(),
      targetRelease: '0'.repeat(40),
      deadline: Date.now() + 5000,
    };
    try {
      for (const url of ['/api/runtime/drain', '/api/runtime/resume'])
        assert.equal((await f.request(url, input)).statusCode, 404);
      const working = f.request('/api/work');
      await bounded(started.promise);
      f.admission.close();
      const closing = f.admission.drain(Date.now() + 5000).then(() => {
        closed = true;
      });
      assert.equal((await bounded(f.request('/api/work'))).statusCode, 503);
      assert.equal(closed, false);
      finish.resolve();
      assert.equal((await bounded(working)).statusCode, 200);
      await bounded(closing);
      assert.equal(effects, 1);
    } finally {
      finish.resolve();
      await f.app.close();
    }
  });

  test('signed deployment drain waits for admitted HTTP work, blocks new work and preserves lease renewal', async () => {
    const f = fixture();
    const started = gate();
    const finish = gate();
    let effects = 0;
    f.app.post('/api/work', async () => {
      effects++;
      started.resolve();
      await finish.promise;
      return { ok: true };
    });
    const input = {
      nonce: randomUUID(),
      targetRelease: 'b'.repeat(40),
      deadline: Date.now() + 1000,
    };
    try {
      const working = f.request('/api/work');
      await started.promise;
      const preparing = f.request('/api/runtime/drain', input, 'deployment');
      let received = false;
      void preparing.then(() => {
        received = true;
      });
      await delay(10);
      assert.equal(received, false);
      assert.equal(f.admission.pending, 1);
      assert.equal((await f.request('/api/work')).statusCode, 503);
      assert.equal(effects, 1);
      assert.equal((await f.request('/api/runtime/lease', {}, 'wake')).statusCode, 200);
      assert.equal((await f.request('/api/runtime/resume', input, 'user')).statusCode, 403);
      finish.resolve();
      assert.equal((await working).statusCode, 200);
      const receipt = await preparing;
      assert.equal(receipt.statusCode, 200, receipt.body);
      assert.deepEqual(receipt.json(), {
        ok: true,
        nonce: input.nonce,
        targetRelease: input.targetRelease,
        generation: '7',
        drained: true,
      });
      assert.equal(f.admission.pending, 0);
      assert.equal(
        (await f.request('/api/runtime/resume', { ...input, nonce: randomUUID() }, 'deployment'))
          .statusCode,
        409,
      );
      assert.equal((await f.request('/api/runtime/resume', input, 'deployment')).statusCode, 200);
      assert.equal((await f.request('/api/work')).statusCode, 200);
      assert.equal(effects, 2);
    } finally {
      finish.resolve();
      await f.app.close();
    }
  });

  test('a disconnected HTTP client cannot release work until its handler actually settles', async () => {
    const f = fixture();
    const started = gate();
    const finish = gate();
    const completed = gate();
    f.app.post('/api/work', async () => {
      started.resolve();
      await finish.promise;
      completed.resolve();
      return { ok: true };
    });
    try {
      const address = await f.app.listen({ host: '127.0.0.1', port: 0 });
      const request = httpRequest(address + '/api/work', {
        method: 'POST',
        headers: f.headers('/api/work', '{}'),
      });
      request.on('error', () => {});
      request.end('{}');
      await started.promise;
      request.destroy();
      await delay(5);
      assert.equal(f.admission.pending, 1);
      const input = {
        nonce: randomUUID(),
        targetRelease: 'd'.repeat(40),
        deadline: Date.now() + 20,
      };
      await assert.rejects(f.drain.prepare(input));
      assert.equal(f.admission.pending, 1);
      finish.resolve();
      await completed.promise;
      await delay(5);
      assert.equal(f.admission.pending, 0);
      await f.drain.resume(input);
    } finally {
      finish.resolve();
      await f.app.close();
    }
  });

  test(
    'a disconnected request cannot start its handler after a delayed pre-handler resumes',
    { timeout: 5000 },
    async () => {
      const f = fixture();
      const started = gate();
      const finish = gate();
      const completed = gate();
      const disconnected = gate();
      let handled = 0;
      f.app.addHook('onRequest', async (request, reply) => {
        if (request.url === '/api/work') reply.raw.once('close', disconnected.resolve);
      });
      f.app.addHook('preHandler', async (request) => {
        if (request.url !== '/api/work') return;
        started.resolve();
        await finish.promise;
        completed.resolve();
      });
      f.app.post('/api/work', async () => {
        handled++;
        return { ok: true };
      });
      let request: ReturnType<typeof httpRequest> | undefined;
      try {
        const address = await f.app.listen({ host: '127.0.0.1', port: 0 });
        request = httpRequest(address + '/api/work', {
          method: 'POST',
          headers: f.headers('/api/work', '{}'),
        });
        request.on('error', () => {});
        request.end('{}');
        await started.promise;
        assert.equal(f.admission.pending, 1);
        request.destroy();
        await disconnected.promise;
        const input = {
          nonce: randomUUID(),
          targetRelease: 'f'.repeat(40),
          deadline: Date.now() + 500,
        };
        assert.equal((await f.request('/api/runtime/drain', input, 'deployment')).statusCode, 200);
        assert.equal(f.admission.pending, 0);
        finish.resolve();
        await completed.promise;
        await delay(0);
        assert.equal(handled, 0);
        assert.equal(f.admission.pending, 0);
      } finally {
        finish.resolve();
        request?.destroy();
        await f.app.close();
      }
    },
  );

  test('uncertain computer pause and resume cannot emit a clean receipt or restart consumers', async () => {
    let starts = 0;
    const f = fixture({
      async pause() {
        throw new Error('Private pause uncertainty');
      },
      async resume() {
        throw new Error('Private retained fence');
      },
    });
    await f.consumers.register({ start: async () => `worker-${++starts}`, stop: async () => {} });
    const input = {
      nonce: randomUUID(),
      targetRelease: 'e'.repeat(40),
      deadline: Date.now() + 1000,
    };
    try {
      const response = await f.request('/api/runtime/drain', input, 'deployment');
      assert.equal(response.statusCode, 503);
      assert.equal(response.json().computerPaused, undefined);
      assert.equal((await f.request('/api/runtime/resume', input, 'deployment')).statusCode, 503);
      assert.equal(f.admission.paused, true);
      assert.equal(starts, 1);
    } finally {
      await f.app.close();
    }
  });
});

describe('work admission', () => {
  const input = (duration = 1000) => ({
    nonce: randomUUID(),
    targetRelease: 'a'.repeat(40),
    deadline: Date.now() + duration,
  });

  test('a consumer stop failure never yields a successful deployment receipt', async () => {
    const admission = createWorkAdmission();
    const consumers = createWorkConsumers();
    await consumers.register({
      start: async () => 'worker',
      stop: async () => {
        throw new Error('private stop detail');
      },
    });
    const drain = createTenantDrain({ admission, consumers });
    await assert.rejects(drain.prepare(input()));
    assert.equal(admission.paused, true);
    assert.equal(drain.active(), true);
    await assert.rejects(consumers.resume());
    await assert.rejects(consumers.close());
  });
});

describe('tenant store', () => {
  test('tenant namespaces are opaque, deterministic, environment-bound and restricted to UUID owners', () => {
    const ownerId = randomUUID();
    const names = tenantIdentifiers(ownerId, 'development');
    assert.deepEqual(names, tenantIdentifiers(ownerId.toUpperCase(), 'development'));
    assert.notDeepEqual(names, tenantIdentifiers(ownerId, 'production'));
    assert.notDeepEqual(names, tenantIdentifiers(randomUUID(), 'development'));
    for (const value of Object.values(names)) {
      assert.match(value, /^sk_(user|app|jobs)_[a-f0-9]{32}$/);
      assert.ok(!value.includes(ownerId));
    }
    for (const value of ['local-development', 'alice@example.test', "'; DROP SCHEMA public; --"])
      assert.throws(() => tenantIdentifiers(value, 'development'), TenantError);
    assert.throws(() => tenantIdentifiers(ownerId, '../production'), TenantError);
  });

  test(
    'dedicated tenant logins isolate schemas, queues, provisioning, credentials and runtime leases',
    { skip: !process.env.TEST_DATABASE_URL, timeout: 60_000 },
    async (t) => {
      const fixtureId = randomUUID().replaceAll('-', '').slice(0, 20);
      const databaseName = `test_tenants_${fixtureId}`;
      const provisionerRole = `test_provisioner_${fixtureId}`;
      const provisionerPassword = randomBytes(32).toString('base64url');
      const root = new pg.Pool({
        connectionString: process.env.TEST_DATABASE_URL,
        max: 2,
        connectionTimeoutMillis: 5_000,
      });
      const runtimePools: pg.Pool[] = [];
      const queues: PgBoss[] = [];
      const tenantRoles = new Set<string>();
      let created = false;
      let provisionerCreated = false;
      let admin: pg.Pool | undefined;
      t.after(async () => {
        try {
          for (const queue of queues)
            await queue.stop({ graceful: true, timeout: 1000 }).catch(() => {});
          await Promise.all(runtimePools.map((pool) => pool.end()));
          await admin?.end();
          if (created) {
            const deadline = Date.now() + 5_000;
            while (
              (
                await root.query('SELECT 1 FROM pg_stat_activity WHERE datname=$1 LIMIT 1', [
                  databaseName,
                ])
              ).rowCount
            ) {
              assert.ok(Date.now() < deadline, 'Fixture database connections did not close.');
              await delay(10);
            }
            await root.query(`DROP DATABASE "${databaseName}"`);
          }
          for (const role of tenantRoles) await root.query(`DROP ROLE IF EXISTS "${role}"`);
          if (provisionerCreated) await root.query(`DROP ROLE "${provisionerRole}"`);
        } finally {
          await root.end();
        }
      });
      await root.query(
        `CREATE ROLE "${provisionerRole}" LOGIN CREATEROLE NOCREATEDB NOSUPERUSER NOBYPASSRLS PASSWORD '${provisionerPassword}'`,
      );
      provisionerCreated = true;
      await root.query(`CREATE DATABASE "${databaseName}" OWNER "${provisionerRole}"`);
      created = true;
      const url = new URL(process.env.TEST_DATABASE_URL!);
      url.username = provisionerRole;
      url.password = provisionerPassword;
      url.pathname = `/${databaseName}`;
      url.searchParams.delete('options');
      admin = new pg.Pool({ connectionString: url.href, max: 4 });
      await admin.query('CREATE SCHEMA auth_fixture');
      await admin.query('CREATE TABLE auth_fixture.sessions(secret text)');
      await admin.query('CREATE TABLE public.fixture_shared(secret text)');
      await admin.query('GRANT SELECT ON public.fixture_shared TO PUBLIC');
      const secret = randomBytes(32);
      const options = {
        admin,
        databaseUrl: url.href,
        environment: `test-${fixtureId}`,
        getSecret: () => secret,
        maxTenants: 3,
      };
      const store = createTenantStore(options);
      await Promise.all([store.initialize(), store.initialize()]);
      const ownerA = randomUUID();
      const ownerB = randomUUID();
      for (const ownerId of [ownerA, ownerB])
        tenantRoles.add(tenantIdentifiers(ownerId, options.environment).role);
      tenantRoles.add(tenantIdentifiers(ownerA, `other-${fixtureId}`).role);
      const results = await Promise.all([
        store.provision(ownerA),
        store.provision(ownerA.toUpperCase()),
        store.provision(ownerB),
      ]);
      assert.deepEqual(results[0], results[1]);
      const [tenantA, , tenantB] = results;
      const otherEnvironment = createTenantStore({ ...options, environment: `other-${fixtureId}` });
      const tenantOther = await otherEnvironment.provision(ownerA);
      assert.notEqual(tenantA.role, tenantOther.role);
      assert.deepEqual((await store.listOwners()).sort(), [ownerA, ownerB].sort());
      assert.deepEqual(await otherEnvironment.listOwners(), [ownerA]);
      assert.equal(await store.get(randomUUID()), undefined);
      await assert.rejects(store.runtimeConfiguration(randomUUID()), { code: 'not_found' });
      const overflowOwner = randomUUID();
      await assert.rejects(store.provision(overflowOwner), { code: 'capacity_reached' });
      const overflowNames = tenantIdentifiers(overflowOwner, options.environment);
      assert.equal(
        (await admin.query('SELECT 1 FROM pg_roles WHERE rolname=$1', [overflowNames.role]))
          .rowCount,
        0,
      );
      const [configA, configB, configOther] = await Promise.all([
        store.runtimeConfiguration(ownerA),
        store.runtimeConfiguration(ownerB),
        otherEnvironment.runtimeConfiguration(ownerA),
      ]);
      assert.equal(configA.poolMax, 4);
      const passwordA = new URL(configA.databaseUrl).password;
      assert.equal(passwordA.length, 43);
      assert.ok(passwordA !== new URL(configB.databaseUrl).password);
      assert.ok(passwordA !== new URL(configOther.databaseUrl).password);
      assert.ok(
        passwordA === new URL((await store.runtimeConfiguration(ownerA)).databaseUrl).password,
      );
      assert.ok(!JSON.stringify(tenantA).includes(passwordA));
      const poolA = new pg.Pool({ connectionString: configA.databaseUrl, max: 2 });
      const poolB = new pg.Pool({ connectionString: configB.databaseUrl, max: 2 });
      runtimePools.push(poolA, poolB);

      await t.test(
        'roles can migrate only their own schema and cannot select a different owner or auth registry',
        async () => {
          for (const [pool, tenant] of [
            [poolA, tenantA],
            [poolB, tenantB],
          ] as const) {
            const current = await pool.query(
              'SELECT current_user AS role,current_schema() AS schema',
            );
            assert.equal(current.rows[0].role, tenant.role);
            assert.equal(current.rows[0].schema, tenant.appSchema);
            await pool.query(
              'CREATE TABLE fixture_records(id integer PRIMARY KEY,content text NOT NULL)',
            );
            await pool.query('INSERT INTO fixture_records VALUES(1,$1)', [
              `Fixture for ${tenant.ownerId}`,
            ]);
          }
          const denied = (action: () => Promise<unknown>) =>
            assert.rejects(action, { code: '42501' });
          await denied(() => poolA.query(`SELECT * FROM "${tenantB.appSchema}".fixture_records`));
          await denied(() => poolB.query(`SELECT * FROM "${tenantA.appSchema}".fixture_records`));
          await denied(() => poolA.query(`SET ROLE "${tenantB.role}"`));
          await denied(() => poolA.query(`SET ROLE "${decodeURIComponent(url.username)}"`));
          await denied(() => poolA.query('SELECT * FROM otto_control.tenants'));
          await denied(() => poolA.query('SELECT * FROM auth_fixture.sessions'));
          await denied(() => poolA.query('SELECT * FROM public.fixture_shared'));
          await denied(() => poolA.query('CREATE SCHEMA fixture_escape'));
          await denied(() => poolA.query('CREATE ROLE fixture_escape'));
          await denied(() => poolA.query('CREATE TEMP TABLE fixture_escape(id integer)'));
          await denied(() => poolA.query(`GRANT "${tenantB.role}" TO "${tenantA.role}"`));
          await denied(() =>
            poolA.query(`GRANT USAGE ON SCHEMA "${tenantB.appSchema}" TO "${tenantA.role}"`),
          );
          await denied(() =>
            poolA.query(
              `GRANT SELECT ON "${tenantB.appSchema}".fixture_records TO "${tenantA.role}"`,
            ),
          );
          await denied(() =>
            poolA.query(
              `ALTER DEFAULT PRIVILEGES FOR ROLE "${tenantB.role}" GRANT SELECT ON TABLES TO PUBLIC`,
            ),
          );
          await poolA.query(`CREATE FUNCTION fixture_attempt() RETURNS text
          LANGUAGE plpgsql SECURITY DEFINER SET search_path TO "${tenantB.appSchema}"
          AS $body$ BEGIN RETURN (SELECT content FROM fixture_records LIMIT 1); END $body$`);
          await assert.rejects(() => poolA.query('SELECT fixture_attempt()'), {
            code: '42P01',
          });
          await poolA.query('DROP FUNCTION fixture_attempt()');
          await denied(() =>
            poolA.query(
              `CREATE TABLE fixture_reference(id integer REFERENCES "${tenantB.appSchema}".fixture_records(id))`,
            ),
          );
          const connection = await poolA.connect();
          try {
            await connection.query(`SET search_path TO "${tenantB.appSchema}"`);
            await denied(() =>
              connection.query(`SELECT * FROM "${tenantB.appSchema}".fixture_records`),
            );
            await connection.query('RESET search_path');
          } finally {
            connection.release();
          }
          assert.equal(
            (await poolA.query('SELECT content FROM fixture_records')).rows[0].content,
            `Fixture for ${ownerA}`,
          );
          assert.equal(
            (await poolB.query('SELECT content FROM fixture_records')).rows[0].content,
            `Fixture for ${ownerB}`,
          );
        },
      );

      await t.test(
        'identically named pg-boss queues stay inside each login’s private jobs schema',
        async () => {
          for (const config of [configA, configB]) {
            const queue = new PgBoss({
              connectionString: config.databaseUrl,
              schema: config.jobsSchema,
              createSchema: false,
              max: 2,
              schedule: false,
              supervise: false,
            });
            queues.push(queue);
            await queue.start();
            await queue.createQueue('fixture-task');
            await queue.send('fixture-task', { owner: config.ownerId });
          }
          for (const [index, owner] of [ownerA, ownerB].entries()) {
            const jobs = await queues[index].fetch<{ owner: string }>('fixture-task');
            assert.equal(jobs.length, 1);
            assert.equal(jobs[0].data.owner, owner);
          }
          await assert.rejects(poolA.query(`SELECT * FROM "${tenantB.jobsSchema}".job`), {
            code: '42501',
          });
        },
      );

      await t.test(
        'leases serialize runtimes and fence expired owners and stale cleanup',
        async () => {
          assert.equal(await store.currentLease(ownerA), undefined);
          const first = await store.acquireLease(ownerA, randomUUID());
          assert.ok(first);
          assert.deepEqual(await store.currentLease(ownerA), first);
          assert.equal(await otherEnvironment.currentLease(ownerA), undefined);
          assert.equal(await store.acquireLease(ownerA, randomUUID()), undefined);
          const renewed = await store.renewLease(first);
          assert.equal(renewed?.generation, first.generation);
          assert.equal(await store.releaseLease({ ...first, holderId: randomUUID() }), false);
          await admin!.query(
            "UPDATE otto_control.tenants SET lease_expires=clock_timestamp()-interval '1 second' WHERE owner_id=$1 AND environment=$2",
            [ownerA, options.environment],
          );
          assert.equal(await store.renewLease(first), undefined);
          assert.equal(await store.currentLease(ownerA), undefined);
          const contenders = await Promise.all([
            store.acquireLease(ownerA, randomUUID()),
            store.acquireLease(ownerA, randomUUID()),
          ]);
          assert.equal(contenders.filter(Boolean).length, 1);
          const second = contenders.find(Boolean)!;
          assert.equal(BigInt(second.generation), BigInt(first.generation) + 1n);
          assert.equal(await store.releaseLease(first), false);
          assert.equal(await store.renewLease(first), undefined);
          await assert.rejects(otherEnvironment.renewLease(second), { code: 'invalid_identity' });
          assert.equal(await store.releaseLease(second), true);
          const third = await store.acquireLease(ownerA, second.holderId);
          assert.ok(third);
          assert.equal(BigInt(third.generation), BigInt(second.generation) + 1n);
          assert.equal(await store.releaseLease(second), false);
          assert.equal(await store.releaseLease(third), true);
          assert.equal(await store.currentLease(ownerA), undefined);
        },
      );

      await t.test(
        'unsafe role changes fail closed without returning runtime credentials',
        async () => {
          await root.query(`ALTER ROLE "${tenantA.role}" CREATEDB`);
          try {
            await assert.rejects(store.runtimeConfiguration(ownerA), { code: 'isolation_failed' });
            await assert.rejects(store.provision(ownerA), { code: 'isolation_failed' });
          } finally {
            await root.query(`ALTER ROLE "${tenantA.role}" NOCREATEDB`);
          }
          assert.equal((await store.runtimeConfiguration(ownerA)).ownerId, ownerA);
        },
      );
      const closingConnection = await admin.connect();
      closingConnection.release();
      const closeConnection = closingConnection.end.bind(closingConnection);
      t.mock.method(closingConnection, 'end', (callback?: () => void) => {
        setTimeout(() => closeConnection(callback ?? (() => {})), 100);
      });
    },
  );
});

describe('local runtime host', () => {
  test(
    'two real local tenant processes retain private settings across a graceful gateway restart',
    {
      skip: !process.env.TEST_DATABASE_URL,
      timeout: 90_000,
    },
    async (t) => {
      const suffix = randomUUID().replaceAll('-', '').slice(0, 20);
      const database = `test_runtime_${suffix}`;
      const directory = await mkdtemp(join(tmpdir(), 'otto-runtime-'));
      const root = new pg.Pool({ connectionString: process.env.TEST_DATABASE_URL, max: 2 });
      const ownerA = randomUUID();
      const ownerB = randomUUID();
      const environment = 'fixture';
      const secret = randomBytes(32);
      const url = new URL(process.env.TEST_DATABASE_URL!);
      url.pathname = `/${database}`;
      url.searchParams.delete('options');
      let admin: pg.Pool | undefined;
      let host: ReturnType<typeof createTenantRuntimeHost> | undefined;
      let created = false;
      t.after(async () => {
        await host?.close().catch(() => {});
        await admin?.end();
        if (created) {
          const deadline = Date.now() + 5000;
          while (
            (
              await root.query('SELECT 1 FROM pg_stat_activity WHERE datname=$1 LIMIT 1', [
                database,
              ])
            ).rowCount
          ) {
            assert.ok(Date.now() < deadline, 'Fixture database connections did not close.');
            await delay(10);
          }
          await root.query(`DROP DATABASE "${database}"`);
        }
        for (const owner of [ownerA, ownerB])
          await root.query(`DROP ROLE IF EXISTS "${tenantIdentifiers(owner, environment).role}"`);
        await root.end();
        await rm(directory, { recursive: true, force: true });
      });
      await root.query(`CREATE DATABASE "${database}"`);
      created = true;
      admin = new pg.Pool({ connectionString: url.href, max: 4 });
      const tenants = createTenantStore({
        admin,
        databaseUrl: url.href,
        environment,
        getSecret: () => secret,
      });
      await tenants.initialize();
      const create = () =>
        createTenantRuntimeHost({
          tenants,
          masterKey: secret,
          environment,
          transport: createLocalRuntimeTransport({
            root: directory,
            entrypoint: 'src/server/index.ts',
            cwd: resolve('.'),
          }),
          operatorEnvironment: {
            OTTO_PUBLIC_URL: 'http://localhost:4330',
            COMPUTER_PROVIDER: 'e2b',
            E2B_API_KEY: 'synthetic-unused-key',
            E2B_COMPUTER_TEMPLATE: 'synthetic-computer',
          },
        });
      host = create();
      async function request(owner: string, method: string, body?: unknown) {
        const response = await host!.fetch(
          owner,
          new Request('http://otto.test/api/preferences', {
            method,
            headers: { 'content-type': 'application/json' },
            ...(body ? { body: JSON.stringify(body) } : {}),
          }),
          { developer: false },
        );
        assert.equal(response.status, 200);
        return (await response.json()) as { notificationRule: string; quietHoursEnabled: boolean };
      }
      await Promise.all([
        request(ownerA, 'PATCH', { notificationRule: 'fixture A', quietHoursEnabled: false }),
        request(ownerB, 'PATCH', { notificationRule: 'fixture B', quietHoursEnabled: true }),
      ]);
      assert.equal((await request(ownerA, 'GET')).notificationRule, 'fixture A');
      assert.equal((await request(ownerB, 'GET')).notificationRule, 'fixture B');
      const previous = await tenants.currentLease(ownerA);
      await host.close();
      assert.equal(await tenants.currentLease(ownerA), undefined);
      host = create();
      const restored = await request(ownerA, 'GET');
      assert.equal(restored.notificationRule, 'fixture A');
      assert.equal(restored.quietHoursEnabled, false);
      assert.equal((await request(ownerB, 'GET')).notificationRule, 'fixture B');
      assert.ok(
        BigInt((await tenants.currentLease(ownerA))!.generation) > BigInt(previous!.generation),
      );
    },
  );
});
