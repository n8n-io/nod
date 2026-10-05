import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import test from 'node:test';
import { createTenantLifecycle } from '../src/lifecycle.ts';
import { bootstrap, boundedBody, type TenantIdentity } from '../src/protocol.ts';

function configuration(
  ownerId = randomUUID(),
  version = '1',
  expiresAt = Date.now() + 60_000,
  environment = 'development',
) {
  const suffix = createHash('sha256')
    .update(JSON.stringify(['otto-tenant-v1', environment, ownerId]))
    .digest('hex')
    .slice(0, 32);
  return {
    ownerId,
    env: {
      OTTO_OWNER_ID: ownerId,
      OTTO_ENVIRONMENT: environment,
      OTTO_MODE: 'tenant',
      OTTO_RUNTIME_GENERATION: version,
      OTTO_RUNTIME_SECRET: 's'.repeat(43),
      OTTO_RUNTIME_LEASE_EXPIRES: new Date(expiresAt).toISOString(),
      DATABASE_URL: `postgresql://sk_user_${suffix}:synthetic@db.example.test/otto`,
      PGBOSS_SCHEMA: `sk_jobs_${suffix}`,
    },
  };
}

function deferred<T = void>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason: Error) => void;
  const promise = new Promise<T>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
}

function fixture(
  hooks: {
    stopComputers?(identity: TenantIdentity): Promise<void>;
    stop?(): Promise<void>;
    leaseUpdated?(identity: TenantIdentity): Promise<void>;
  } = {},
) {
  let time = Date.UTC(2026, 8, 27, 12);
  let saved: TenantIdentity | undefined;
  let state: 'healthy' | 'stopped' = 'stopped';
  const calls: string[] = [];
  const leases: TenantIdentity[] = [];
  const lifecycle = createTenantLifecycle({
    environment: 'development',
    now: () => time,
    read: async () => saved && { ...saved },
    write: async (identity) => {
      saved = { ...identity };
      calls.push(identity.stopped ? 'stopped' : identity.revoking ? 'revoking' : 'active');
    },
    status: async () => state,
    start: async () => {
      state = 'healthy';
      calls.push('start');
    },
    stopComputers: async (identity) => {
      calls.push('stop-computers');
      await hooks.stopComputers?.(identity);
    },
    stop: async () => {
      calls.push('stop-tenant');
      await hooks.stop?.();
      state = 'stopped';
    },
    leaseUpdated: async (identity) => {
      leases.push({ ...identity });
      await hooks.leaseUpdated?.(identity);
    },
  });
  return {
    lifecycle,
    calls,
    leases,
    now: () => time,
    setTime: (value: number) => {
      time = value;
    },
    saved: () => saved && { ...saved },
    replaceSaved: (identity: TenantIdentity) => {
      saved = identity;
    },
    platformStopped: () => {
      state = 'stopped';
    },
  };
}

test('tenant bootstrap binds the SQL namespace, runtime identity and environment', async () => {
  const input = configuration();
  const result = await bootstrap(
    { ...input, env: { ...input.env, OTTO_BIND_HOST: '127.0.0.1' } },
    'development',
  );
  assert.equal(result.env.NODE_ENV, 'production');
  assert.equal(result.env.OTTO_ANALYTICS_ENABLED, 'false');
  assert.equal(result.env.OTTO_ANALYTICS_ENVIRONMENT, 'development');
  assert.equal(result.env.OTTO_DATA_ROOT, '/data');
  assert.equal(result.env.HOST, '0.0.0.0');
  assert.equal(result.env.OTTO_BIND_HOST, '0.0.0.0');
  assert.equal(result.identity.leaseExpiresAt, Date.parse(input.env.OTTO_RUNTIME_LEASE_EXPIRES));
  assert.equal(result.identity.revoking, false);
  assert.ok(!JSON.stringify(result.identity).includes('synthetic'));
  await assert.rejects(bootstrap(input, 'production'));
  await assert.rejects(bootstrap({ ...input, ownerId: randomUUID() }, 'development'));
  for (const change of [
    { OTTO_MODE: 'gateway' },
    { OTTO_RUNTIME_SECRET: 'short' },
    { OTTO_RUNTIME_GENERATION: '0' },
    { DATABASE_URL: 'postgresql://admin:synthetic@db.example.test/otto' },
    { PGBOSS_SCHEMA: 'public' },
    { OTTO_OWNER_ID: randomUUID() },
    { OTTO_ANALYTICS_ENABLED: 'yes' },
    { OTTO_ANALYTICS_ENVIRONMENT: 'private-account@example.test' },
  ])
    await assert.rejects(bootstrap({ ...input, env: { ...input.env, ...change } }, 'development'));
});

test('tenant bootstrap preserves telemetry opt-out and isolates staging events despite production Node mode', async () => {
  for (const environment of ['production', 'staging']) {
    const input = configuration(randomUUID(), '1', Date.now() + 60_000, environment);
    const initial = await bootstrap(input, environment);
    assert.equal(initial.env.NODE_ENV, 'production');
    assert.equal(initial.env.OTTO_ANALYTICS_ENABLED, String(environment === 'production'));
    assert.equal(
      initial.env.OTTO_ANALYTICS_ENVIRONMENT,
      environment === 'production' ? 'production' : 'development',
    );
    const disabled = await bootstrap(
      { ...input, env: { ...input.env, OTTO_ANALYTICS_ENABLED: 'false' } },
      environment,
    );
    assert.equal(disabled.env.OTTO_ANALYTICS_ENABLED, 'false');
    const observed = await bootstrap(
      {
        ...input,
        env: {
          ...input.env,
          OTTO_ANALYTICS_ENABLED: 'true',
          OTTO_ANALYTICS_ENVIRONMENT: 'development',
        },
      },
      environment,
    );
    assert.equal(observed.env.OTTO_ANALYTICS_ENABLED, 'true');
    assert.equal(observed.env.OTTO_ANALYTICS_ENVIRONMENT, 'development');
    assert.notEqual(disabled.identity.configurationHash, observed.identity.configurationHash);
  }
});

test('tenant bootstrap binds its computer provider and forces the private E2B stop callback', async () => {
  const input = configuration();
  const external = await bootstrap(
    {
      ...input,
      env: {
        ...input.env,
        COMPUTER_PROVIDER: 'e2b',
        OTTO_COMPUTER_CONTROL_URL: 'https://foreign.example.test',
      },
    },
    'development',
  );
  assert.equal(external.identity.computerProvider, 'e2b');
  assert.equal(external.env.OTTO_COMPUTER_CONTROL_URL, 'http://otto.computer/v1/stopped');
  const legacy = await bootstrap(input, 'development');
  assert.equal(legacy.identity.computerProvider, 'cloudflare');
  assert.equal(legacy.env.OTTO_COMPUTER_CONTROL_URL, undefined);
  await assert.rejects(
    bootstrap({ ...input, env: { ...input.env, COMPUTER_PROVIDER: 'unknown' } }, 'development'),
  );
});

test('physical tenant termination does not confirm an unacknowledged remote computer stop', async () => {
  let saved: TenantIdentity | undefined;
  let state: 'stopped' | 'healthy' = 'stopped';
  let acknowledged = false;
  const calls: string[] = [];
  const lifecycle = createTenantLifecycle({
    environment: 'development',
    read: async () => saved,
    write: async (identity) => {
      saved = identity;
    },
    status: async () => state,
    start: async () => {
      state = 'healthy';
    },
    stop: async () => {
      state = 'stopped';
      calls.push('node-stopped');
    },
    confirmComputersStopped: async () => {
      calls.push('computer-inspected');
      if (!acknowledged) throw new Error('Remote stop is unconfirmed.');
    },
  });
  const input = configuration();
  await lifecycle.start({ ...input, env: { ...input.env, COMPUTER_PROVIDER: 'e2b' } });
  await assert.rejects(lifecycle.stop(input.ownerId, '1'));
  assert.equal(saved?.stopped, false);
  assert.equal(saved?.revoking, true);
  assert.deepEqual(calls, ['node-stopped', 'computer-inspected']);
  acknowledged = true;
  assert.equal((await lifecycle.stop(input.ownerId, '1')).stopped, true);
});

test('a physically stopped E2B generation cannot restart while its previous computer evidence is delayed', async (t) => {
  for (const stoppedState of ['stopped', 'stopped_with_code'] as const) {
    await t.test(stoppedState, async () => {
      let saved: TenantIdentity | undefined;
      let state: 'healthy' | 'stopped' | 'stopped_with_code' = 'stopped';
      const starts: string[] = [];
      const evidenceRequested = deferred();
      const oldEvidence = deferred();
      const lifecycle = createTenantLifecycle({
        environment: 'development',
        read: async () => saved,
        write: async (identity) => {
          saved = { ...identity };
        },
        status: async () => state,
        start: async (env) => {
          starts.push(env.OTTO_RUNTIME_GENERATION);
          state = 'healthy';
        },
        stop: async () => {
          state = stoppedState;
        },
        confirmComputersStopped: async (identity) => {
          assert.equal(identity.generation, '1');
          evidenceRequested.resolve();
          await oldEvidence.promise;
        },
      });
      const original = configuration();
      const first = { ...original, env: { ...original.env, COMPUTER_PROVIDER: 'e2b' } };
      const next = { ...first, env: { ...first.env, OTTO_RUNTIME_GENERATION: '2' } };
      await lifecycle.start(first);
      await lifecycle.start(first);
      assert.deepEqual(starts, ['1', '1']);
      state = stoppedState;
      const before = structuredClone(saved);
      await assert.rejects(lifecycle.start(first), { status: 409 });
      await assert.rejects(lifecycle.start(next), { status: 409 });
      assert.deepEqual(saved, before);
      assert.deepEqual(starts, ['1', '1']);
      const stopped = lifecycle.stop(first.ownerId, '1');
      await evidenceRequested.promise;
      assert.equal(saved?.revoking, true);
      assert.equal(saved?.stopped, false);
      const replacement = lifecycle.start(next);
      assert.deepEqual(starts, ['1', '1']);
      oldEvidence.resolve();
      assert.deepEqual(await stopped, { ok: true, generation: '1', stopped: true });
      assert.deepEqual(await replacement, { ok: true, generation: '2' });
      assert.deepEqual(starts, ['1', '1', '2']);
      const current = structuredClone(saved);
      await assert.rejects(lifecycle.stop(first.ownerId, '1'), { status: 409 });
      await assert.rejects(lifecycle.start(first), { status: 409 });
      assert.deepEqual(saved, current);
    });
  }
});

test('tenant startup and replacement require one fixed identity and a confirmed stopped generation', async () => {
  let saved: TenantIdentity | undefined;
  let state: 'stopped' | 'healthy' | 'stopping' = 'stopped';
  let starts = 0;
  let stops = 0;
  let finishStop = true;
  const lifecycle = createTenantLifecycle({
    environment: 'development',
    read: async () => saved,
    write: async (identity) => {
      saved = { ...identity };
    },
    status: async () => state,
    start: async () => {
      starts++;
      state = 'healthy';
    },
    stop: async () => {
      stops++;
      state = finishStop ? 'stopped' : 'stopping';
    },
  });
  const first = configuration();
  await assert.rejects(lifecycle.identity());
  assert.deepEqual(await lifecycle.start(first), { ok: true, generation: '1' });
  assert.equal((await lifecycle.identity()).ownerId, first.ownerId);
  await lifecycle.start(first);
  assert.equal(starts, 2);
  const second = { ...first, env: { ...first.env, OTTO_RUNTIME_GENERATION: '2' } };
  await assert.rejects(lifecycle.start(second), { status: 409 });
  await assert.rejects(lifecycle.start(configuration()), { status: 409 });
  await assert.rejects(lifecycle.stop(first.ownerId, '2'), { status: 409 });
  await assert.rejects(lifecycle.stop(randomUUID(), '1'), { status: 409 });
  assert.equal(stops, 0);
  finishStop = false;
  await assert.rejects(lifecycle.stop(first.ownerId, '1'), { status: 503 });
  assert.equal(saved?.stopped, false);
  await assert.rejects(lifecycle.start(second), { status: 409 });
  finishStop = true;
  await lifecycle.stop(first.ownerId, '1');
  assert.equal(saved?.stopped, true);
  await assert.rejects(lifecycle.identity());
  await assert.rejects(lifecycle.start(first), { status: 409 });
  await lifecycle.start(second);
  assert.equal(saved?.generation, '2');
  await assert.rejects(lifecycle.stop(first.ownerId, '1'), { status: 409 });
  await assert.rejects(
    lifecycle.start({ ...second, env: { ...second.env, OTTO_RUNTIME_SECRET: 't'.repeat(43) } }),
    { status: 409 },
  );
});

test('storage identity is available during startup without blocking hydration on a ready port', async () => {
  let saved: TenantIdentity | undefined;
  const lifecycle = createTenantLifecycle({
    environment: 'development',
    read: async () => saved,
    write: async (identity) => {
      saved = identity;
    },
    status: async () => 'stopped',
    start: async () => {
      const identity = await lifecycle.identity();
      assert.equal(identity.ownerId, input.ownerId);
    },
    stop: async () => {},
  });
  const input = configuration();
  await lifecycle.start(input);
});

test('concurrent conflicting bootstrap calls cannot replace the admitted process', async () => {
  let saved: TenantIdentity | undefined;
  let state: 'stopped' | 'healthy' = 'stopped';
  const lifecycle = createTenantLifecycle({
    environment: 'development',
    read: async () => saved,
    write: async (identity) => {
      saved = identity;
    },
    status: async () => state,
    start: async () => {
      state = 'healthy';
    },
    stop: async () => {
      state = 'stopped';
    },
  });
  const first = configuration();
  const second = { ...first, env: { ...first.env, OTTO_RUNTIME_GENERATION: '2' } };
  const results = await Promise.allSettled([lifecycle.start(first), lifecycle.start(second)]);
  assert.equal(results.filter((result) => result.status === 'fulfilled').length, 1);
  assert.equal(saved?.generation, '1');
});

test('body limits apply to actual streamed bytes without trusting content length', async () => {
  const request = new Request('http://otto.runtime/runtime/start', {
    method: 'POST',
    body: new Uint8Array(12),
    headers: { 'content-length': '1' },
  });
  await assert.rejects(boundedBody(request, 10), { status: 413 });
});

test('tenant bootstrap accepts only a bounded future ISO lease with an injected clock', async () => {
  const now = Date.UTC(2026, 8, 27, 12);
  const input = configuration(undefined, '1', now + 65_000);
  assert.equal(
    (await bootstrap(input, 'development', () => now)).identity.leaseExpiresAt,
    now + 65_000,
  );
  for (const expiry of [
    String(now + 60_000),
    new Date(now).toISOString(),
    new Date(now - 1).toISOString(),
    new Date(now + 65_001).toISOString(),
    'invalid',
    '2026-09-27T12:01:00+00:00',
    '2026-09-31T12:01:00Z',
  ]) {
    await assert.rejects(
      bootstrap(
        { ...input, env: { ...input.env, OTTO_RUNTIME_LEASE_EXPIRES: expiry } },
        'development',
        () => now,
      ),
      { status: 400 },
    );
  }
  const withoutMilliseconds = {
    ...input,
    env: { ...input.env, OTTO_RUNTIME_LEASE_EXPIRES: '2026-09-27T12:01:00Z' },
  };
  assert.equal(
    (await bootstrap(withoutMilliseconds, 'development', () => now)).identity.leaseExpiresAt,
    now + 60_000,
  );
});

test('tenant renewal persists only after acknowledgement and preserves the returned response', async () => {
  const f = fixture();
  const input = configuration(undefined, '1', f.now() + 40_000);
  await f.lifecycle.start(input);
  const original = f.saved()!;
  const acknowledge = deferred<{ accepted: boolean }>();
  const requested = deferred();
  f.setTime(f.now() + 10_000);
  const expiresAt = new Date(f.now() + 60_000).toISOString();
  const renewal = f.lifecycle.renew(input.ownerId, '1', expiresAt, async () => {
    requested.resolve();
    return acknowledge.promise;
  });
  await requested.promise;
  assert.deepEqual(await f.lifecycle.identity('1'), original);
  assert.equal(f.leases.length, 1);
  const response = { accepted: true };
  acknowledge.resolve(response);
  assert.equal(await renewal, response);
  assert.equal(f.saved()!.leaseExpiresAt, Date.parse(expiresAt));
  assert.equal(f.leases.at(-1)!.leaseExpiresAt, Date.parse(expiresAt));
  assert.equal(f.saved()!.configurationHash, original.configurationHash);
  const later = new Date(f.now() + 65_000).toISOString();
  await assert.rejects(
    f.lifecycle.renew(input.ownerId, '1', later, async () => {
      throw new Error('synthetic rejected acknowledgement');
    }),
  );
  assert.equal(f.saved()!.leaseExpiresAt, Date.parse(expiresAt));
});

test('tenant renewal and identity reject stale generations and invalid expiry before acknowledgement', async () => {
  const f = fixture();
  const input = configuration(undefined, '1', f.now() + 40_000);
  await f.lifecycle.start(input);
  let acknowledged = 0;
  const acknowledge = async () => {
    acknowledged++;
  };
  const future = new Date(f.now() + 60_000).toISOString();
  await assert.rejects(f.lifecycle.identity('2'), { status: 409 });
  await assert.rejects(f.lifecycle.identity('0'), { status: 400 });
  await assert.rejects(f.lifecycle.renew(randomUUID(), '1', future, acknowledge), { status: 409 });
  await assert.rejects(f.lifecycle.renew(input.ownerId, '2', future, acknowledge), { status: 409 });
  for (const expiry of [
    input.env.OTTO_RUNTIME_LEASE_EXPIRES,
    new Date(f.now() + 20_000).toISOString(),
    new Date(f.now()).toISOString(),
    new Date(f.now() + 65_001).toISOString(),
    String(f.now() + 60_000),
  ])
    await assert.rejects(f.lifecycle.renew(input.ownerId, '1', expiry, acknowledge));
  assert.equal(acknowledged, 0);
});

test('tenant stop persists revocation before awaiting computers and confirms tenant stop afterwards', async () => {
  const computers = deferred();
  const stopping = deferred();
  const f = fixture({
    stopComputers: async (identity) => {
      assert.equal(identity.revoking, true);
      assert.equal(f.saved()!.revoking, true);
      stopping.resolve();
      await computers.promise;
    },
  });
  const input = configuration(undefined, '1', f.now() + 60_000);
  await f.lifecycle.start(input);
  f.calls.length = 0;
  const stop = f.lifecycle.stop(input.ownerId, '1');
  await stopping.promise;
  assert.deepEqual(f.calls, ['revoking', 'stop-computers']);
  assert.equal(f.saved()!.stopped, false);
  await assert.rejects(f.lifecycle.identity('1'), { status: 503 });
  computers.resolve();
  assert.deepEqual(await stop, { ok: true, generation: '1', stopped: true });
  assert.deepEqual(f.calls, ['revoking', 'stop-computers', 'stop-tenant', 'stopped']);
  assert.equal(f.leases.at(-1)!.stopped, true);
});

test('failed computer stop retains revocation and blocks replacement even when the tenant platform stopped', async () => {
  let fails = true;
  const f = fixture({
    stopComputers: async () => {
      if (fails) throw new Error('synthetic stop failure');
    },
  });
  const input = configuration(undefined, '1', f.now() + 60_000);
  await f.lifecycle.start(input);
  await assert.rejects(f.lifecycle.stop(input.ownerId, '1'));
  assert.equal(f.saved()!.revoking, true);
  assert.equal(f.saved()!.stopped, false);
  assert.equal(f.calls.includes('stop-tenant'), false);
  await assert.rejects(f.lifecycle.identity(), { status: 503 });
  f.platformStopped();
  const replacement = { ...input, env: { ...input.env, OTTO_RUNTIME_GENERATION: '2' } };
  await assert.rejects(f.lifecycle.start(replacement), { status: 409 });
  await assert.rejects(f.lifecycle.start(input), { status: 409 });
  fails = false;
  await f.lifecycle.stop(input.ownerId, '1');
  await f.lifecycle.start(replacement);
  assert.equal(f.saved()!.generation, '2');
  assert.equal(f.saved()!.revoking, false);
});

test('late renewal acknowledgement cannot undo stop or a replacement generation', async (t) => {
  for (const replace of [false, true])
    await t.test(replace ? 'replacement' : 'stop', async () => {
      const f = fixture();
      const input = configuration(undefined, '1', f.now() + 40_000);
      await f.lifecycle.start(input);
      const acknowledged = deferred();
      const requested = deferred();
      const renewal = f.lifecycle.renew(
        input.ownerId,
        '1',
        new Date(f.now() + 60_000).toISOString(),
        async () => {
          requested.resolve();
          await acknowledged.promise;
        },
      );
      const rejected = assert.rejects(renewal, { status: 409 });
      await requested.promise;
      await f.lifecycle.stop(input.ownerId, '1');
      if (replace) await f.lifecycle.start(configuration(input.ownerId, '2', f.now() + 65_000));
      const before = f.saved();
      acknowledged.resolve();
      await rejected;
      assert.deepEqual(f.saved(), before);
    });
});

test('gateway death expires identity immediately and fences a pending renewal before alarm cleanup', async () => {
  const f = fixture();
  const input = configuration(undefined, '1', f.now() + 40_000);
  await f.lifecycle.start(input);
  const acknowledged = deferred();
  const requested = deferred();
  const renewal = f.lifecycle.renew(
    input.ownerId,
    '1',
    new Date(f.now() + 60_000).toISOString(),
    async () => {
      requested.resolve();
      await acknowledged.promise;
    },
  );
  const rejected = assert.rejects(renewal, { status: 409 });
  await requested.promise;
  f.setTime(f.now() + 40_000);
  await assert.rejects(f.lifecycle.identity(), { status: 503 });
  assert.equal(f.saved()!.stopped, false);
  assert.equal(f.calls.includes('stop-computers'), false);
  acknowledged.resolve();
  await rejected;
  f.calls.length = 0;
  await f.lifecycle.expire();
  assert.deepEqual(f.calls, ['revoking', 'stop-computers', 'stop-tenant', 'stopped']);
  assert.equal(f.saved()!.stopped, true);
});

test('expiry cleanup cannot be undone by a delayed renewal and remains retryable on stop failure', async () => {
  let fails = true;
  const f = fixture({
    stop: async () => {
      if (fails) throw new Error('synthetic tenant stop failure');
    },
  });
  const input = configuration(undefined, '1', f.now() + 40_000);
  await f.lifecycle.start(input);
  await f.lifecycle.expire();
  assert.equal(f.calls.includes('stop-computers'), false);
  const acknowledge = deferred();
  const requested = deferred();
  const renewal = f.lifecycle.renew(
    input.ownerId,
    '1',
    new Date(f.now() + 60_000).toISOString(),
    async () => {
      requested.resolve();
      await acknowledge.promise;
    },
  );
  const rejected = assert.rejects(renewal, { status: 409 });
  await requested.promise;
  f.setTime(f.now() + 40_000);
  await assert.rejects(f.lifecycle.expire());
  assert.equal(f.saved()!.revoking, true);
  assert.equal(f.saved()!.stopped, false);
  acknowledge.resolve();
  await rejected;
  fails = false;
  await f.lifecycle.expire();
  assert.equal(f.saved()!.stopped, true);
});

test('concurrent renewals never roll expiry backward and idempotent startup preserves the latest lease', async () => {
  const f = fixture();
  const input = configuration(undefined, '1', f.now() + 40_000);
  await f.lifecycle.start(input);
  const acknowledge = deferred();
  const requested = deferred();
  const older = f.lifecycle.renew(
    input.ownerId,
    '1',
    new Date(f.now() + 55_000).toISOString(),
    async () => {
      requested.resolve();
      await acknowledge.promise;
    },
  );
  const rejected = assert.rejects(older, { status: 409 });
  await requested.promise;
  const nextExpiry = f.now() + 60_000;
  await f.lifecycle.renew(input.ownerId, '1', new Date(nextExpiry).toISOString(), async () => {});
  acknowledge.resolve();
  await rejected;
  await f.lifecycle.start(input);
  assert.equal(f.saved()!.leaseExpiresAt, nextExpiry);
  f.setTime(nextExpiry);
  await assert.rejects(f.lifecycle.identity());
  await assert.rejects(f.lifecycle.start(input));
});

test('legacy records require confirmed stop before a fresh generation restores authority', async () => {
  const f = fixture();
  const input = configuration(undefined, '1', f.now() + 60_000);
  await f.lifecycle.start(input);
  const { leaseExpiresAt: _expiry, revoking: _revoking, ...legacy } = f.saved()!;
  f.replaceSaved(legacy as TenantIdentity);
  await assert.rejects(f.lifecycle.identity(), { status: 503 });
  await assert.rejects(f.lifecycle.start(input), { status: 409 });
  let acknowledged = false;
  await assert.rejects(
    f.lifecycle.renew(input.ownerId, '1', new Date(f.now() + 65_000).toISOString(), async () => {
      acknowledged = true;
    }),
    { status: 409 },
  );
  assert.equal(acknowledged, false);
  await f.lifecycle.stop(input.ownerId, '1');
  assert.equal(f.saved()!.revoking, true);
  assert.equal(f.saved()!.stopped, true);
  await f.lifecycle.start(configuration(input.ownerId, '2', f.now() + 60_000));
  assert.equal((await f.lifecycle.identity('2')).revoking, false);
});

test('read-only tenant stop inspection serializes behind cleanup without adopting or changing a lease', async () => {
  const entered = deferred();
  const finish = deferred();
  const f = fixture({
    stop: async () => {
      entered.resolve();
      await finish.promise;
    },
  });
  const input = configuration(randomUUID(), '1', f.now() + 60_000);
  await f.lifecycle.start(input);
  const stop = f.lifecycle.stop(input.ownerId, '1');
  await entered.promise;
  let inspected = false;
  const proof = f.lifecycle.inspectStopped(input.ownerId, '1', async () => {
    inspected = true;
    return true;
  });
  await Promise.resolve();
  assert.equal(inspected, false);
  finish.resolve();
  await stop;
  const before = { state: f.saved(), calls: [...f.calls], leases: [...f.leases] };
  assert.equal(await proof, true);
  assert.equal(await f.lifecycle.inspectStopped(input.ownerId, '2', async () => true), false);
  assert.equal(await f.lifecycle.inspectStopped(randomUUID(), '1', async () => true), false);
  assert.equal(await f.lifecycle.inspectStopped(input.ownerId, null, async () => true), false);
  assert.deepEqual({ state: f.saved(), calls: f.calls, leases: f.leases }, before);
  const fresh = fixture();
  assert.equal(await fresh.lifecycle.inspectStopped(randomUUID(), null, async () => true), true);
  assert.deepEqual(fresh.calls, []);
});
