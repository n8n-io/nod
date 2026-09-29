import assert from 'node:assert/strict';
import test from 'node:test';
import Fastify from 'fastify';
import { registerLocalAccess } from '../src/server/access.ts';

test('OAuth return permits top-level Apps and onboarding navigation and keeps cross-site APIs blocked', async () => {
  const app = Fastify();
  registerLocalAccess(app, 4310);
  app.get('/apps', async () => 'Application shell');
  app.get('/onboarding', async () => 'Application shell');
  app.get('/goals', async () => 'Application shell');
  app.get('/schedule', async () => 'Application shell');
  app.get('/browser', async () => 'Application shell');
  app.get('/connected.html', async () => 'Window return page');
  app.get('/vault/:id', async () => 'Application shell');
  app.post('/api/credential-requests/:id/refresh', async () => ({ ok: true }));
  app.post('/apps', async () => ({ ok: true }));
  app.get('/api/apps', async () => []);
  app.post('/api/apps/gmail/connect', async () => ({ ok: true }));
  app.get('/api/apps/callback', async (_request, reply) =>
    reply.redirect('/onboarding?connection=connected'),
  );
  const headers = {
    host: 'localhost:4310',
    'sec-fetch-site': 'cross-site',
    'sec-fetch-mode': 'navigate',
    'sec-fetch-dest': 'document',
  };
  try {
    assert.equal(
      (
        await app.inject({
          method: 'POST',
          url: '/api/credential-requests/test-link/refresh',
          headers,
        })
      ).statusCode,
      403,
    );
    const callback = await app.inject({ url: '/api/apps/callback', headers });
    assert.equal(callback.statusCode, 302);
    assert.equal((await app.inject({ url: callback.headers.location!, headers })).statusCode, 200);
    for (const url of [
      '/onboarding?connection=connected',
      '/apps?connection=connected',
      '/goals',
      '/schedule',
      '/browser',
      '/vault/test-link',
      '/onboarding',
      '/connected.html',
    ]) {
      assert.equal((await app.inject({ url, headers })).statusCode, 200);
      assert.equal((await app.inject({ method: 'POST', url, headers })).statusCode, 403);
      assert.equal(
        (await app.inject({ url, headers: { ...headers, 'sec-fetch-dest': 'iframe' } })).statusCode,
        403,
      );
    }
    for (const url of ['/api/apps', '/api/apps/gmail/connect']) {
      assert.equal((await app.inject({ url, headers })).statusCode, 403);
      assert.equal((await app.inject({ method: 'POST', url, headers })).statusCode, 403);
    }
    for (const rejected of [
      { ...headers, 'sec-fetch-mode': 'cors' },
      { ...headers, 'sec-fetch-dest': 'iframe' },
      { ...headers, origin: 'https://attacker.example' },
      { ...headers, host: 'attacker.example:4310' },
    ]) {
      assert.equal((await app.inject({ url: '/apps', headers: rejected })).statusCode, 403);
    }
    assert.equal((await app.inject({ method: 'POST', url: '/apps', headers })).statusCode, 403);
  } finally {
    await app.close();
  }
});
