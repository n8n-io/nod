import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import test from 'node:test';
import type { DeploymentRequest } from '../../../src/ports/deployment.ts';
import { signDeploymentRequest } from '../../../src/server/deployment-auth.ts';
import { createGatewayDeployment } from '../src/deployment-gateway.ts';

function fixture() {
  const master = Buffer.alloc(32, 19);
  const values = new Map<string, unknown>();
  const requests: Request[] = [];
  const input: DeploymentRequest = {
    action: 'prepare',
    nonce: randomUUID(),
    targetRelease: 'a'.repeat(40),
    previousRelease: 'b'.repeat(40),
    deadline: Date.now() + 60_000,
  };
  const storage = {
    get: async (key: string) => structuredClone(values.get(key)),
    put: async (key: string, value: unknown) => {
      values.set(key, structuredClone(value));
    },
    delete: async (key: string) => values.delete(key),
    transaction: async <T>(operation: (value: unknown) => Promise<T>) => operation(storage),
  } as unknown as DurableObjectStorage;
  let reply = async (_request: Request) => Response.json({ ok: true, receipts: [] });
  const create = () =>
    createGatewayDeployment({
      storage,
      environment: 'development',
      gatewayEnvironment: JSON.stringify({
        OTTO_MASTER_KEY: master.toString('base64'),
        OTTO_RELEASE: input.previousRelease,
      }),
      forward: async (request) => {
        requests.push(request);
        return reply(request);
      },
    });
  const request = (requestId = randomUUID()) => {
    const body = Buffer.from(JSON.stringify(input));
    return new Request('https://otto.example.test/api/deployment', {
      method: 'POST',
      headers: {
        'x-otto-deployment': signDeploymentRequest({
          masterKey: master,
          environment: 'development',
          body,
          requestId,
        }),
      },
      body,
    });
  };
  return {
    master,
    values,
    requests,
    create,
    request,
    reply(value: typeof reply) {
      reply = value;
    },
  };
}

test('durable deployment request replay protection survives replacement and rejected auth cannot close admission', async () => {
  const f = fixture();
  const id = randomUUID();
  const first = f.request(id);
  const replay = new Request(first.clone());
  await f.create().handle(first);
  await assert.rejects(f.create().handle(replay));
  assert.equal(f.requests.length, 1);
  const fresh = fixture();
  const bad = fresh.request();
  bad.headers.set('x-otto-deployment', 'invalid');
  await assert.rejects(fresh.create().handle(bad));
  assert.equal(await fresh.create().closed(), false);
  assert.equal(fresh.requests.length, 0);
  assert.equal(fresh.values.size, 0);
});

test('gateway refuses malformed successful acknowledgements and keeps admission closed', async () => {
  for (const body of [
    { ok: true },
    { ok: true, receipts: [{ ownerId: randomUUID(), generation: '0' }] },
    { ok: true, receipts: [], extra: true },
  ]) {
    const f = fixture();
    f.reply(async () => Response.json(body));
    await assert.rejects(f.create().handle(f.request()));
    assert.equal(await f.create().closed(), true);
    assert.equal((f.values.get('deployment-barrier') as { phase: string }).phase, 'failed');
  }
});

test('account removal waits for no deployment, blocks a deployment while it runs and leaves no marker', async () => {
  const f = fixture();
  const ownerId = randomUUID();
  const removal = (dryRun = false) => {
    const body = Buffer.from(JSON.stringify({ ownerId, dryRun, release: true }));
    return new Request('https://otto.example.test/api/deprovision', {
      method: 'POST',
      headers: {
        'x-otto-deployment': signDeploymentRequest({
          masterKey: f.master,
          environment: 'development',
          body,
          capability: 'deprovision',
        }),
      },
      body,
    });
  };
  const gate = f.create();
  let during: unknown[] = [];
  f.reply(async () => {
    during = [
      await gate.deprovisioning(ownerId, false),
      await gate.deprovisioning(randomUUID(), false),
      await gate.handle(f.request()).then(
        () => 'accepted',
        (error: { status?: number }) => error.status,
      ),
    ];
    return Response.json({ ok: true, report: { dryRun: false } });
  });
  assert.deepEqual(await gate.deprovision(removal()), { ok: true, report: { dryRun: false } });
  assert.deepEqual(during, [true, false, 409]);
  assert.equal(f.values.has('deprovisioning'), false);
  assert.equal(await gate.closed(), false);
  f.reply(async () => {
    during = [await gate.deprovisioning(ownerId, true), await gate.deprovisioning(ownerId, false)];
    return Response.json({ ok: true, report: { dryRun: true } });
  });
  assert.deepEqual(await gate.deprovision(removal(true)), { ok: true, report: { dryRun: true } });
  assert.deepEqual(during, [true, false]);
  f.reply(async () => Response.json({ ok: true, receipts: [] }));
  await gate.handle(f.request());
  assert.equal(await gate.closed(), true);
  const forwarded = f.requests.length;
  await assert.rejects(gate.deprovision(removal()), { status: 409 });
  assert.equal(f.requests.length, forwarded);
});
