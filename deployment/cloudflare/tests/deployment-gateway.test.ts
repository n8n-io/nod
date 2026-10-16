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
