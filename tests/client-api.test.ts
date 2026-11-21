import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import test from 'node:test';
import Fastify from 'fastify';
import { accessCookie, registerLocalAccess } from '../src/server/access.ts';
import { registerClientApi } from '../src/server/client-api.ts';

test('client capabilities require bearer auth without weakening host or origin controls', async (t) => {
  const key = randomBytes(32).toString('base64url');
  const app = Fastify({ trustProxy: false });
  t.after(() => app.close());
  registerLocalAccess(app, 4310, { key, origin: 'https://nod.example', bearer: true });
  registerClientApi(app, true);

  const authorized = { host: 'nod.example', authorization: `Bearer ${key}` };
  const response = await app.inject({
    url: '/api/client/capabilities',
    headers: authorized,
  });
  assert.equal(response.statusCode, 200);
  assert.deepEqual(response.json(), {
    contractVersion: 1,
    authentication: { mode: 'bearer' },
    features: { attachments: true },
  });
  assert.equal(response.body.includes(key), false);

  for (const headers of [
    { host: 'nod.example' },
    { host: 'nod.example', cookie: `${accessCookie(4310)}=${key}` },
    { host: 'nod.example', authorization: 'Bearer wrong' },
  ])
    assert.equal((await app.inject({ url: '/api/client/capabilities', headers })).statusCode, 401);

  for (const headers of [
    { ...authorized, host: 'attacker.example', 'x-forwarded-host': 'nod.example' },
    { ...authorized, origin: 'https://attacker.example' },
    { ...authorized, 'sec-fetch-site': 'cross-site' },
  ])
    assert.equal((await app.inject({ url: '/api/client/capabilities', headers })).statusCode, 403);
});

for (const desktop of [false, true])
  test(`discovery is unavailable with ${desktop ? 'desktop' : 'cookie-only'} authentication`, async (t) => {
    const key = randomBytes(32).toString('base64url');
    const app = Fastify();
    t.after(() => app.close());
    registerLocalAccess(app, 4310, { key, desktop });
    registerClientApi(app, false);
    const response = await app.inject({
      url: '/api/client/capabilities',
      headers: {
        host: '127.0.0.1:4310',
        cookie: `${accessCookie(4310)}=${key}`,
        'x-nod-desktop-token': key,
        authorization: 'Bearer unsupported',
      },
    });
    assert.equal(response.statusCode, 404);
  });
