import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { getEventListeners } from 'node:events';
import {
  createHash,
  generateKeyPairSync,
  createPublicKey,
  randomBytes,
  randomUUID,
  verify,
  webcrypto,
} from 'node:crypto';
import { chmod, copyFile, mkdir, mkdtemp, readdir, rm, stat, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test, { type TestContext } from 'node:test';
import type { Connection as AppConnection } from '../src/shared/contracts.ts';
import { setTimeout as delay } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import {
  APIConnectionError,
  APIConnectionTimeoutError,
  APIUserAbortError,
  APIError,
  type RequestOptions,
} from '@composio/client';
import { Composio } from '@composio/core';
import Fastify from 'fastify';
import { JSDOM } from 'jsdom';
import pg from 'pg';
import type { Agent, AgentEvent, AgentToolResult, RuntimeContext } from '../src/ports/agent.ts';
import { type DiscoveredOAuthState } from '../src/ports/discovered.ts';
import {
  IntegrationCatalogAccessDenied,
  IntegrationConnectionError,
  IntegrationPermissionError,
  type IntegrationFile,
  type IntegrationProvider,
  type IntegrationService,
  type IntegrationSession,
} from '../src/ports/integrations.ts';
import { createComposioProvider } from '../src/providers/composio/integrations.ts';
import { createComposioProxy } from '../src/providers/composio/proxy.ts';
import { createIntegrationIdentityCheckpoint } from '../src/server/integration-identity.ts';
import { createIntegrationBrowser } from '../src/server/integration-browser.ts';
import { createDiscoveredTransport, safeRemoteFetch } from '../src/providers/discovered/remote.ts';
import { createAgentRuntime } from '../src/runtime/index.ts';
import { createDiscoveredConnections } from '../src/server/discovered-connections.ts';
import { registerLocalAccess } from '../src/server/access.ts';
import { createIntegrations, initializeIntegrationSchema } from '../src/server/integrations.ts';
import { cachedIcons } from '../src/server/link-previews.ts';
import { createErrorRedactor } from '../src/server/redaction.ts';
import { createLedger } from '../src/server/ledger.ts';
import { usagePdf } from '../src/server/usage-report.ts';
import type { TrustEntry } from '../src/shared/trust.ts';
import { createAppGrantVault } from '../src/server/vault-app-grants.ts';
import { createWorkAdmission } from '../src/server/work-admission.ts';
import { integrationServiceIds, integrationServices } from '../src/shared/integrations.ts';
import { connectedGmail } from '../src/shared/onboarding.ts';
import { fileBytes } from '../src/shared/files.ts';
import { connectionGroups } from '../src/web/lib/secondary-pages.ts';
import { fakeComputer, fakeExecution, fakeWorkspace } from './runtime-fixtures.ts';

const fixtureIdentityCheckpoint = {
  read: async () => undefined,
  commit: async () => {},
};
const installationKey = randomBytes(32);
const installationKeyStore = {
  id: 'fixture',
  configured: true,
  getKey: async () => Buffer.from(installationKey),
};

function eagerConnectionBrowser(): import('../src/ports/integrations.ts').IntegrationConnectionBrowser {
  const urls = new Set<string>();
  const key = generateKeyPairSync('ec', { namedCurve: 'prime256v1' }).publicKey.export({
    format: 'jwk',
  });
  return {
    async open(_id, _origin, start) {
      const url = await start(key, 'http://127.0.0.1:54321', {
        returnPath: '/' + randomBytes(32).toString('base64url'),
      });
      urls.add(url);
      return url;
    },
    owns: (url) => urls.has(url),
    remote: (url) => (urls.has(url) ? url : undefined),
    finish() {},
    async close() {},
  };
}

function fakeProvider(session: IntegrationSession): IntegrationProvider {
  return {
    id: 'fixture',
    configured: true,
    webhooksConfigured: true,
    supportsSubscriptions: ['gmail', 'googlecalendar'],
    createSession: async () => session,
    deleteSession: async () => {},
    inspectAccount: async () => ({ active: true, service: 'gmail' }),
    deleteAccount: async () => {},
    subscribe: async () => ({ id: 'ti-fixture' }),
    unsubscribe: async () => {},
    parseCallback: (raw) => {
      const query = raw as Record<string, string>;
      return { state: query.state, accountId: query.account_ref, success: query.outcome === 'ok' };
    },
    matchesSubscription: (service, trigger) =>
      service === 'gmail' && trigger === 'fixture-inbox-update',
    verifyWebhook: async (body, headers) => {
      if (headers['x-fixture-valid'] !== 'yes') throw new Error('Fixture rejected the signature.');
      return JSON.parse(String(body));
    },
  };
}

test(
  'installation identity checkpoints prevent replacement after file loss and recover interrupted first initialization',
  { skip: !process.env.TEST_DATABASE_URL },
  async (t) => {
    const schema = `identity_${randomUUID().replaceAll('-', '')}`;
    const admin = new pg.Pool({ connectionString: process.env.TEST_DATABASE_URL });
    await admin.query(`CREATE SCHEMA ${schema}`);
    const pool = new pg.Pool({
      connectionString: process.env.TEST_DATABASE_URL,
      options: `-c search_path=${schema}`,
    });
    const root = await mkdtemp(join(tmpdir(), 'nod-identity-checkpoint-'));
    t.after(async () => {
      await pool.end();
      await admin.query(`DROP SCHEMA ${schema} CASCADE`);
      await admin.end();
      await rm(root, { recursive: true, force: true });
    });
    function options(ownerId: string) {
      return {
        dataRoot: join(root, ownerId),
        ownerId,
        keyStore: installationKeyStore,
        checkpoint: createIntegrationIdentityCheckpoint(pool, ownerId),
        request: (async () =>
          assert.fail('Identity setup must not make a request.')) as typeof fetch,
      };
    }
    await t.test('concurrent first starts publish one owner-bound key', async () => {
      const proxies = [
        createComposioProxy(options('concurrent-owner')),
        createComposioProxy(options('concurrent-owner')),
        createComposioProxy(options('another-owner')),
      ];
      await Promise.all(proxies.map((proxy) => proxy.initialize()));
      assert.equal(proxies[0].userId, proxies[1].userId);
      assert.notEqual(proxies[0].userId, proxies[2].userId);
      const checkpoint = createIntegrationIdentityCheckpoint(pool, 'concurrent-owner');
      const key = await checkpoint.read();
      assert.ok(key);
      const otherKey = await createIntegrationIdentityCheckpoint(pool, 'another-owner').read();
      assert.ok(otherKey);
      await assert.rejects(checkpoint.commit(otherKey), /identity changed/);
      assert.equal(await checkpoint.read(), key);
      const restarted = createComposioProxy(options('concurrent-owner'));
      await restarted.initialize();
      assert.equal(restarted.userId, proxies[0].userId);
    });
    for (const lost of ['files', 'directory', 'profile']) {
      await t.test(`established identity fails closed after losing its ${lost}`, async () => {
        const saved = options(`lost-${lost}`);
        const proxy = createComposioProxy(saved);
        await proxy.initialize();
        const publicKey = await saved.checkpoint.read();
        const directory = join(saved.dataRoot, 'integration-identity');
        if (lost === 'files') {
          for (const entry of await readdir(directory)) await rm(join(directory, entry));
        } else {
          await rm(lost === 'directory' ? directory : saved.dataRoot, { recursive: true });
        }
        const restarted = createComposioProxy({
          ...saved,
          checkpoint: createIntegrationIdentityCheckpoint(pool, saved.ownerId),
          keyStore: {
            ...installationKeyStore,
            getKey: async () =>
              assert.fail('A missing established identity must not generate a key.'),
          },
        });
        await assert.rejects(restarted.initialize(), /identity is missing/);
        assert.throws(() => restarted.userId);
        assert.equal(await saved.checkpoint.read(), publicKey);
        if (lost === 'files') assert.deepEqual(await readdir(directory), []);
        else await assert.rejects(stat(directory), { code: 'ENOENT' });
      });
    }
    await t.test('apps connected before app identities existed still start', async () => {
      await initializeIntegrationSchema(pool);
      await pool.query(
        "INSERT INTO app_connections(owner_id,slug,provider_id,account_id,pending_account_id) VALUES ('connected-before','gmail','composio','synthetic-account',NULL), ('pending-before','gmail','composio',NULL,'synthetic-pending')",
      );
      for (const owner of ['connected-before', 'pending-before']) {
        const saved = options(owner);
        const proxy = createComposioProxy(saved);
        await proxy.initialize();
        assert.match(proxy.userId, /^nod_[a-f0-9]{64}$/);
        assert.ok(await saved.checkpoint.read());
      }
    });
  },
);

test(
  'managed integration SDK requests keep their deadline and cancellation through the response body',
  { timeout: 45_000 },
  async (t) => {
    const { createServer } = await import('node:http');
    const root = await mkdtemp(join(tmpdir(), 'nod-integration-response-'));
    let receiving = () => {};
    let release = () => {};
    let requests = 0;
    let complete = false;
    let originalResponse: Response | undefined;
    let requestSignal: AbortSignal | undefined;
    let mode: 'body' | 'headers' | 'success' | 'error' | 'reset' | 'empty' = 'body';
    const received: Record<string, unknown>[] = [];
    const cloneCalls = new WeakMap<Response, number>();
    const payload = 'x'.repeat(4 * 1024 * 1024);
    const server = createServer(async (request, response) => {
      const chunks: Buffer[] = [];
      for await (const chunk of request) chunks.push(Buffer.from(chunk));
      response.setHeader('content-type', 'application/json');
      if (request.url === '/v2/access/enroll') {
        response.end(
          JSON.stringify({
            state: 'enabled',
            userId:
              'nod_' +
              createHash('sha256')
                .update(Buffer.from(String(request.headers['x-nod-public-key']), 'base64url'))
                .digest('hex'),
          }),
        );
        return;
      }
      assert.equal(request.url, '/v2/api/v3.1/tool_router/session/fixture-session/execute');
      requests++;
      received.push(JSON.parse(Buffer.concat(chunks).toString()));
      const body =
        '{"data":{"messages":[]},"error":null,"log_id":"fixture-log","result_type":"completed"}';
      if (mode === 'reset') {
        request.socket.destroy();
        receiving();
        return;
      }
      if (mode === 'empty') {
        response.writeHead(204);
        response.end();
        return;
      }
      if (mode === 'headers') {
        release = () => {
          if (!response.destroyed && !response.writableEnded) response.end(body);
        };
        receiving();
        return;
      }
      if (mode === 'success') {
        response.end(body);
        return;
      }
      if (mode === 'error') {
        response.statusCode = 503;
        response.setHeader('retry-after-ms', '0');
      }
      if (complete) {
        response.setHeader('x-fixture-response', 'preserved');
        response.write('{"data":{"payload":"');
        for (let offset = 0; offset < payload.length; offset += 65_536)
          response.write(payload.slice(offset, offset + 65_536));
        response.end('"},"error":null,"log_id":"fixture-log","result_type":"completed"}');
        return;
      }
      response.write('{"data":');
      release = () => {
        if (!response.destroyed && !response.writableEnded)
          response.end(
            '{"messages":[]},"error":null,"log_id":"fixture-log","result_type":"completed"}',
          );
      };
      receiving();
    });
    t.after(async () => {
      release();
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
      await rm(root, { recursive: true, force: true });
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const origin = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
    const request = globalThis.fetch;
    const proxy = createComposioProxy({
      dataRoot: root,
      ownerId: 'fixture-owner',
      keyStore: installationKeyStore,
      checkpoint: fixtureIdentityCheckpoint,
      url: 'https://proxy.example.test',
      request: async (input, init) => {
        assert.ok(init?.signal);
        requestSignal = init.signal;
        const response = await request(new URL(new URL(String(input)).pathname, origin), init);
        const clone = response.clone.bind(response);
        cloneCalls.set(response, 0);
        t.mock.method(response, 'clone', () => {
          cloneCalls.set(response, (cloneCalls.get(response) ?? 0) + 1);
          return clone();
        });
        originalResponse = response;
        return response;
      },
    });
    await proxy.initialize();
    const sdk = proxy.client.getClient();
    const execute = (options: RequestOptions = {}, client = sdk) =>
      client.toolRouter.session.execute(
        'fixture-session',
        { tool_slug: 'GMAIL_SEND_EMAIL', arguments: {} },
        { timeout: 5000, ...options },
      );
    const arrival = () =>
      new Promise<void>((resolve) => {
        receiving = resolve;
      });
    const bounded = <T>(work: PromiseLike<T>) =>
      Promise.race([
        work,
        delay(5000).then(() => assert.fail('The SDK fixture did not reach its boundary.')),
      ]);
    await t.test('raw response headers arrive before the producer finishes its body', async () => {
      const started = new Promise<void>((resolve) => {
        receiving = resolve;
      });
      const pending = proxy.client
        .getClient()
        .toolRouter.session.execute(
          'fixture-session',
          { tool_slug: 'GMAIL_FETCH_EMAILS', arguments: {} },
          { timeout: 5000 },
        );
      const headers = pending.asResponse();
      headers.catch(() => {});
      try {
        await Promise.race([
          started,
          headers.then(() => assert.fail('The partial response was not held.')),
          delay(2000).then(() => assert.fail('The fixture did not send response headers.')),
        ]);
        const response = await Promise.race([
          headers,
          delay(1000).then(() => assert.fail('Response headers waited for the complete body.')),
        ]);
        assert.equal(response, originalResponse);
        assert.equal(response.bodyUsed, false);
        assert.equal(cloneCalls.get(response), 0);
      } finally {
        release();
        await pending.catch(() => {});
      }
      assert.ok(originalResponse);
      assert.equal(cloneCalls.get(originalResponse), 1);
    });
    await t.test('chunked response data and metadata stay available', async () => {
      complete = true;
      try {
        const { data, response } = await proxy.client
          .getClient()
          .toolRouter.session.execute('fixture-session', {
            tool_slug: 'GMAIL_FETCH_EMAILS',
            arguments: {},
          })
          .withResponse();
        assert.ok(data.result_type === 'completed');
        assert.equal(cloneCalls.get(response), 1);
        assert.deepEqual(data.data, { payload });
        assert.equal(response.headers.get('x-fixture-response'), 'preserved');
        assert.equal(response.status, 200);
        assert.equal(
          response.url,
          `${origin}/v2/api/v3.1/tool_router/session/fixture-session/execute`,
        );
        assert.deepEqual((await response.json()).data, { payload });
        assert.equal(requests, 2);
      } finally {
        complete = false;
      }
    });
    for (const mode of ['timeout', 'abort'] as const) {
      await t.test(mode, async () => {
        const controller = new AbortController();
        const started = new Promise<void>((resolve) => {
          receiving = resolve;
        });
        const before = requests;
        const pending = proxy.client
          .getClient()
          .toolRouter.session.execute(
            'fixture-session',
            { tool_slug: 'GMAIL_SEND_EMAIL', arguments: {} },
            { timeout: mode === 'timeout' ? 200 : 10_000, signal: controller.signal },
          )
          .then(
            () => undefined,
            (error: unknown) => error,
          );
        try {
          await Promise.race([
            started,
            pending.then(() => assert.fail('The app request ended before response headers.')),
            delay(2_000).then(() => assert.fail('The fixture did not send response headers.')),
          ]);
          await delay(20);
          if (mode === 'abort') controller.abort();
          const error = await Promise.race([
            pending,
            delay(2_000).then(() => assert.fail('The app request did not end.')),
          ]);
          assert.ok(error instanceof Error);
          assert.equal(
            error.constructor.name,
            mode === 'timeout' ? 'APIConnectionTimeoutError' : 'APIUserAbortError',
          );
          assert.equal(requests, before + 1);
        } finally {
          release();
          await pending;
        }
      });
    }
    for (const stopped of ['timeout', 'abort'] as const)
      for (const parse of [false, true])
        await t.test(
          `raw response ${stopped} ${parse ? 'with delayed parsing' : 'without parsing'}`,
          async () => {
            mode = 'body';
            const owner = new AbortController();
            const started = arrival();
            const pending = execute({ timeout: 1000, signal: owner.signal });
            const headers = pending.asResponse();
            headers.catch(() => {});
            try {
              await bounded(Promise.race([started, headers.then(() => {})]));
              const response = await bounded(headers);
              assert.equal(response, originalResponse);
              assert.equal(cloneCalls.get(response), 0);
              assert.ok(requestSignal);
              const signal = requestSignal;
              const ended = new Promise<void>((resolve) => {
                if (signal.aborted) resolve();
                else signal.addEventListener('abort', () => resolve(), { once: true });
              });
              if (stopped === 'abort') owner.abort();
              await bounded(ended);
              assert.equal(getEventListeners(owner.signal, 'abort').length, 0);
              if (parse)
                await assert.rejects(
                  pending,
                  stopped === 'timeout' ? APIConnectionTimeoutError : APIUserAbortError,
                );
              assert.equal(cloneCalls.get(response), 0);
              await assert.rejects(response.text());
            } finally {
              owner.abort();
              release();
              await headers.catch(() => {});
            }
          },
        );
    for (const stopped of ['timeout', 'abort'] as const)
      await t.test(`raw and parsed ${stopped} before response headers`, async () => {
        mode = 'headers';
        const owner = new AbortController();
        const started = arrival();
        const pending = execute({ timeout: 1000, signal: owner.signal });
        const rawFailure = pending.asResponse().then(
          () => assert.fail('The response headers were not held.'),
          (error: unknown) => error,
        );
        const parsedFailure = pending.then(
          () => assert.fail('The response headers were not held.'),
          (error: unknown) => error,
        );
        try {
          await bounded(
            Promise.race([
              started,
              rawFailure.then((error) => {
                throw error;
              }),
            ]),
          );
          if (stopped === 'abort') owner.abort();
          const error = await bounded(rawFailure);
          assert.ok(
            error instanceof
              (stopped === 'timeout' ? APIConnectionTimeoutError : APIUserAbortError),
          );
          assert.equal(await bounded(parsedFailure), error);
          assert.equal(getEventListeners(owner.signal, 'abort').length, 0);
        } finally {
          owner.abort();
          release();
          await rawFailure;
          await parsedFailure;
        }
      });
    for (const outcome of ['success', 'error'] as const)
      await t.test(
        `the raw response remains readable after parsed ${outcome} and deadline`,
        async () => {
          mode = outcome;
          const owner = new AbortController();
          const started = arrival();
          const pending = execute({ timeout: 1000, signal: owner.signal });
          const headers = pending.asResponse();
          headers.catch(() => {});
          try {
            if (outcome === 'error') await bounded(Promise.race([started, headers.then(() => {})]));
            const response = await bounded(headers);
            assert.equal(response, originalResponse);
            assert.equal(response.status, outcome === 'success' ? 200 : 503);
            release();
            if (outcome === 'error')
              await assert.rejects(
                pending,
                (error: unknown) => error instanceof APIError && error.status === 503,
              );
            else assert.equal((await pending.withResponse()).response, response);
            assert.equal(getEventListeners(owner.signal, 'abort').length, 0);
            await delay(1100);
            owner.abort();
            assert.equal(response.bodyUsed, false);
            assert.deepEqual((await response.json()).data, { messages: [] });
          } finally {
            owner.abort();
            release();
            await headers.catch(() => {});
          }
        },
      );
    for (const outcome of ['error', 'reset'] as const)
      for (const override of ['request', 'client'] as const)
        await t.test(`${outcome} sends once with a ${override} retry override`, async () => {
          mode = outcome;
          const before = requests;
          const started = arrival();
          const owner = new AbortController();
          const client = override === 'client' ? sdk.withOptions({ maxRetries: 4 }) : sdk;
          const pending = execute(
            { signal: owner.signal, ...(override === 'request' ? { maxRetries: 4 } : {}) },
            client,
          );
          const failure = assert.rejects(pending, (error: unknown) =>
            outcome === 'error'
              ? error instanceof APIError && error.status === 503
              : error instanceof APIConnectionError,
          );
          try {
            await bounded(Promise.race([started, failure]));
            release();
            await bounded(failure);
            assert.equal(requests, before + 1);
            assert.equal(getEventListeners(owner.signal, 'abort').length, 0);
          } finally {
            owner.abort();
            release();
            await failure;
          }
        });
    await t.test(
      'request fields and caller signal are captured before the caller can change them',
      async () => {
        mode = 'success';
        const first = new AbortController();
        const second = new AbortController();
        let initialLogs = 0;
        let laterLogs = 0;
        const record = () => {
          initialLogs++;
        };
        const later = () => {
          laterLogs++;
        };
        const client = sdk.withOptions({
          timeout: 5000,
          logLevel: 'debug',
          logger: { debug: record, info: record, warn: record, error: record },
        });
        const body = { tool_slug: 'GMAIL_SEND_EMAIL', arguments: { value: 'before' } };
        const options: Parameters<typeof sdk.request>[0] = {
          method: 'post',
          path: '/api/v3.1/tool_router/session/fixture-session/execute',
          body,
          signal: first.signal,
        };
        const pending = client.request(options);
        options.signal = second.signal;
        body.arguments.value = 'after';
        client.timeout = 1;
        client.baseURL = 'https://changed.example.test';
        client.logger = { debug: later, info: later, warn: later, error: later };
        client.logLevel = 'error';
        await pending;
        assert.deepEqual(received.at(-1), {
          tool_slug: 'GMAIL_SEND_EMAIL',
          arguments: { value: 'before' },
        });
        assert.ok(initialLogs > 0);
        assert.equal(laterLogs, 0);
        assert.equal(getEventListeners(first.signal, 'abort').length, 0);
        assert.equal(getEventListeners(second.signal, 'abort').length, 0);
      },
    );
    await t.test('derived mutable timeout applies to the next request', async () => {
      mode = 'body';
      const owner = new AbortController();
      const client = sdk.withOptions({ timeout: 10000 });
      client.timeout = 1000;
      const started = arrival();
      const pending = client.toolRouter.session.execute(
        'fixture-session',
        { tool_slug: 'GMAIL_SEND_EMAIL', arguments: {} },
        { signal: owner.signal },
      );
      const headers = pending.asResponse();
      headers.catch(() => {});
      try {
        await bounded(Promise.race([started, headers.then(() => {})]));
        await bounded(headers);
        await assert.rejects(bounded(pending), APIConnectionTimeoutError);
        assert.equal(getEventListeners(owner.signal, 'abort').length, 0);
      } finally {
        owner.abort();
        release();
        await headers.catch(() => {});
      }
    });
    await t.test('an already-aborted caller sends no request', async () => {
      const before = requests;
      const owner = new AbortController();
      owner.abort();
      const pending = execute({ signal: owner.signal });
      await assert.rejects(pending.asResponse(), APIUserAbortError);
      await assert.rejects(pending, APIUserAbortError);
      assert.equal(requests, before);
      assert.equal(getEventListeners(owner.signal, 'abort').length, 0);
    });
    await t.test('an empty raw response releases the caller listener without parsing', async () => {
      mode = 'empty';
      const owner = new AbortController();
      const pending = execute({ signal: owner.signal });
      const response = await pending.asResponse();
      assert.equal(response, originalResponse);
      assert.equal(response.status, 204);
      assert.equal(response.body, null);
      assert.equal(getEventListeners(owner.signal, 'abort').length, 0);
    });
  },
);

test('managed integration requests bind SDK calls to a private persisted installation and never retry execution', async (t) => {
  t.mock.method(globalThis, 'fetch', async () => {
    throw new Error('Unexpected external request in the managed integration fixture.');
  });
  const root = await mkdtemp(join(tmpdir(), 'nod-integration-proxy-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const calls: Array<{ path: string; body: Record<string, unknown>; key: string }> = [];
  let failExecution = false;
  let uploadResponse = 'nod-file.synthetic-owned-capability';
  let uploadName = 'synthetic.bin';
  let failUpload = false;
  let pairingStatus: unknown = { pairingConfirmed: false };
  let expectedToolkit = 'gmail';
  let expectedReconnectAccountId: string | undefined;
  let expectedUser = '';
  let expectedCallback: Record<string, unknown> = {
    type: 'loopback',
    host: 'localhost',
    port: 4310,
  };
  const request: typeof fetch = async (input, init) => {
    const value = new Request(input, init);
    const url = new URL(value.url);
    const bytes = Buffer.from(await value.arrayBuffer());
    const key = value.headers.get('x-nod-public-key')!;
    const bodyHash = createHash('sha256').update(bytes).digest('hex');
    const signedHash =
      url.pathname === '/v2/files/upload' ? value.headers.get('x-nod-content-sha256') : bodyHash;
    assert.equal(signedHash, bodyHash);
    const canonical = [
      'nod-composio-v1',
      value.method,
      url.origin,
      `${url.pathname}${url.search}`,
      value.headers.get('x-nod-timestamp'),
      value.headers.get('x-nod-request-id'),
      signedHash,
    ].join('\n');
    assert.ok(
      verify(
        null,
        Buffer.from(canonical),
        createPublicKey({ key: { kty: 'OKP', crv: 'Ed25519', x: key }, format: 'jwk' }),
        Buffer.from(value.headers.get('x-nod-signature')!, 'base64url'),
      ),
    );
    assert.equal(value.headers.has('x-api-key'), false);
    assert.equal(value.headers.has('x-user-api-key'), false);
    assert.equal(value.headers.has('authorization'), false);
    assert.equal(value.redirect, 'error');
    const body = bytes.length ? JSON.parse(bytes.toString()) : {};
    assert.equal('authConfigId' in body, false);
    assert.equal('auth_configs' in body, false);
    assert.equal('authConfigs' in body, false);
    calls.push({ path: url.pathname, body, key });
    if (url.pathname === '/v2/access/enroll')
      return Response.json({
        state: 'enabled',
        userId: 'nod_' + createHash('sha256').update(Buffer.from(key, 'base64url')).digest('hex'),
      });
    if (url.pathname === '/v2/api/v3.1/connected_accounts/ca_fixture_existing') {
      assert.equal(value.method, 'GET');
      return Response.json({
        id: 'ca_fixture_existing',
        user_id: expectedUser,
        toolkit: { slug: 'gmail' },
        auth_config: { id: 'broker-original-gmail', is_disabled: false },
      });
    }
    if (url.pathname === '/v2/api/v3.1/toolkits') {
      assert.equal(url.searchParams.get('type'), 'native');
      return Response.json({
        items: [
          {
            slug: 'custom_native',
            name: 'Custom Native',
            type: 'native',
            meta: { description: 'Synthetic custom configuration' },
            auth_schemes: ['OAUTH2'],
            composio_managed_auth_schemes: [],
          },
        ],
        next_cursor: null,
      });
    }
    assert.equal(url.pathname.endsWith('/auth_configs'), false);
    if (url.pathname === '/v2/api/v3.1/tools/execute/proxy')
      return Response.json({ status: 200, data: { messages: [] }, headers: {} });
    if (url.pathname === '/v2/api/v3.1/tool_router/session') {
      assert.deepEqual(
        Object.keys(body).filter(
          (field) =>
            ![
              'user_id',
              'toolkits',
              'connected_accounts',
              'auth_configs',
              'tools',
              'tags',
              'multi_account',
              'manage_connections',
              'workbench',
              'sandbox',
              'premium_usage',
              'search',
              'execute',
              'preload',
              'expected_config_version',
              'config_version',
            ].includes(field),
        ),
        [],
      );
      assert.equal(body.user_id, expectedUser);
      assert.equal(body.manage_connections.enable, false);
      assert.equal(body.workbench.enable, false);
      return Response.json({
        session_id: 'trs_fixture_proxy',
        mcp: { type: 'http', url: 'https://proxy.example.test/unsupported-mcp' },
        config: {
          user_id: expectedUser,
          toolkits: { enabled: ['gmail'] },
          connected_accounts: {},
        },
        config_version: 1,
      });
    }
    if (url.pathname.endsWith('/execute')) {
      if (failExecution) return Response.json({ error: 'Synthetic timeout' }, { status: 503 });
      return Response.json({
        data: { labels: [] },
        error: null,
        log_id: 'fixture-log',
        result_type: 'completed',
      });
    }
    if (url.pathname === '/v2/files/upload') {
      assert.deepEqual(body, {
        sessionId: 'trs_fixture_proxy',
        action: 'GMAIL_SEND_EMAIL',
        accountId: 'ca_fixture_proxy',
        name: 'synthetic.bin',
        mimeType: 'application/octet-stream',
        data: 'AP/+CkGA',
      });
      if (failUpload) return Response.json({ error: 'upload_failed' }, { status: 503 });
      return Response.json({
        name: uploadName,
        mimetype: 'application/octet-stream',
        s3key: uploadResponse,
      });
    }
    if (url.pathname === '/v2/connect/start') {
      assert.equal(body.toolkit, expectedToolkit);
      assert.equal('authConfigId' in body, false);
      assert.equal(body.reconnectAccountId, expectedReconnectAccountId);
      assert.deepEqual(body.callback, expectedCallback);
      assert.equal('callbackUrl' in body, false);
      assert.match(String(body.challenge), /^[A-Za-z0-9_-]{43}$/);
      return Response.json({
        redirectUrl: 'https://proxy.example.test/v2/connect/pair?ticket=synthetic',
        transactionId: body.transactionId,
      });
    }
    if (url.pathname === '/v2/connect/status') {
      assert.equal(value.method, 'POST');
      assert.deepEqual(body, { ticket: 'synthetic' });
      return Response.json(pairingStatus);
    }
    if (url.pathname === '/v2/connect/complete') {
      assert.equal(body.completionToken, 'synthetic-completion');
      assert.equal(
        body.challenge,
        calls.find((call) => call.path === '/v2/connect/start')!.body.challenge,
      );
      return Response.json({
        connectedAccountId: 'ca_fixture_proxy',
        toolkit: 'gmail',
        status: 'ACTIVE',
      });
    }
    throw new Error(`Unexpected fixture route: ${url.pathname}`);
  };
  const options = {
    dataRoot: root,
    ownerId: 'fixture-owner',
    keyStore: installationKeyStore,
    checkpoint: fixtureIdentityCheckpoint,
    url: 'https://proxy.example.test',
    request,
    browser: eagerConnectionBrowser(),
  };
  const proxy = createComposioProxy(options);
  const concurrent = createComposioProxy(options);
  await Promise.all([proxy.initialize(), concurrent.initialize()]);
  assert.equal(proxy.userId, concurrent.userId);
  const restarted = createComposioProxy(options);
  await restarted.initialize();
  assert.equal(proxy.configurationId, restarted.configurationId);
  expectedUser = proxy.userId;
  const directory = join(root, 'integration-identity');
  const entries = (await readdir(directory)).filter((name) => name.endsWith('.encrypted'));
  assert.equal(entries.length, 1);
  if (process.platform !== 'win32')
    assert.equal((await stat(join(directory, entries[0]))).mode & 0o077, 0);
  const other = createComposioProxy({
    ...options,
    ownerId: 'another-owner',
  });
  await other.initialize();
  assert.notEqual(proxy.userId, other.userId);
  const provider = createComposioProvider({
    proxy,
  });
  const state = randomBytes(32).toString('base64url');
  assert.equal(typeof provider.authorize, 'function');
  const beforeAuthorization = calls.length;
  const directAttempt = await provider.authorize!(
    'fixture-owner',
    'gmail',
    `http://localhost:4310/api/apps/callback?state=${state}`,
  );
  assert.equal(directAttempt.accountId, `pending_${state}`);
  assert.deepEqual(
    calls.slice(beforeAuthorization).map((call) => call.path),
    ['/v2/access/enroll', '/v2/connect/start'],
  );
  const afterAuthorization = calls.length;
  await assert.rejects(
    provider.authorize!(
      'another-owner',
      'gmail',
      `http://localhost:4310/api/apps/callback?state=${state}`,
    ),
    /owner/,
  );
  assert.equal(calls.length, afterAuthorization);
  assert.deepEqual(await provider.connectionStatus!('fixture-owner', directAttempt.url), {
    pairingConfirmed: false,
  });
  pairingStatus = { pairingConfirmed: true };
  assert.deepEqual(await provider.connectionStatus!('fixture-owner', directAttempt.url), {
    pairingConfirmed: true,
  });
  assert.deepEqual(
    calls.slice(afterAuthorization).map((call) => call.path),
    ['/v2/connect/status', '/v2/connect/status'],
  );
  const beforeInvalidPairing = calls.length;
  await assert.rejects(provider.connectionStatus!('another-owner', directAttempt.url), /owner/);
  for (const url of [
    'https://other.example.test/v2/connect/pair?ticket=synthetic',
    'https://proxy.example.test/v2/connect/complete?ticket=synthetic',
    'https://user@proxy.example.test/v2/connect/pair?ticket=synthetic',
    `${directAttempt.url}#fragment`,
    `${directAttempt.url}&ticket=another`,
    `${directAttempt.url}&unrelated=1`,
    'https://proxy.example.test/v2/connect/pair?ticket=',
  ])
    await assert.rejects(provider.connectionStatus!('fixture-owner', url), /link is invalid/);
  assert.equal(calls.length, beforeInvalidPairing);
  pairingStatus = { pairingConfirmed: 'true' };
  await assert.rejects(provider.connectionStatus!('fixture-owner', directAttempt.url));
  for (const invalid of [
    { pairingConfirmed: false, signInRequired: 'true' },
    { pairingConfirmed: false, signInRequired: true, arbitrary: true },
  ]) {
    pairingStatus = invalid;
    await assert.rejects(provider.connectionStatus!('fixture-owner', directAttempt.url));
  }
  const abortedPairing = calls.length;
  await assert.rejects(
    provider.connectionStatus!(
      'fixture-owner',
      directAttempt.url,
      AbortSignal.abort(new Error('Pairing cancelled.')),
    ),
    /Pairing cancelled/,
  );
  assert.equal(calls.length, abortedPairing);
  expectedToolkit = 'custom_native';
  const beforeCustomAuthorization = calls.length;
  await provider.authorize!(
    'fixture-owner',
    expectedToolkit,
    `http://localhost:4310/api/apps/callback?state=${state}`,
  );
  assert.deepEqual(
    calls.slice(beforeCustomAuthorization).map((call) => call.path),
    ['/v2/connect/start'],
  );
  expectedToolkit = 'gmail';
  const beforeCatalog = calls.length;
  const catalog = await provider.listServices!();
  assert.ok(catalog.some((service) => service.slug === 'gmail'));
  assert.equal(
    catalog.some((service) => service.slug === 'custom_native'),
    false,
  );
  assert.deepEqual(
    calls.slice(beforeCatalog).map((call) => call.path),
    ['/v2/api/v3.1/toolkits'],
  );
  expectedReconnectAccountId = 'ca_fixture_existing';
  const beforeReconnect = calls.length;
  const reconnectAttempt = await provider.reconnectAccount!(
    'fixture-owner',
    'gmail',
    expectedReconnectAccountId,
    `http://localhost:4310/api/apps/callback?state=${state}`,
  );
  assert.deepEqual(
    calls.slice(beforeReconnect).map((call) => call.path),
    ['/v2/api/v3.1/connected_accounts/ca_fixture_existing', '/v2/connect/start'],
  );
  assert.equal(reconnectAttempt.accountId, `pending_${state}`);
  assert.equal(reconnectAttempt.authConfigId, 'broker-original-gmail');
  assert.ok(reconnectAttempt.verificationSecret);
  expectedReconnectAccountId = undefined;
  const session = await provider.createSession('fixture-owner', {});
  const attempt = directAttempt;
  assert.equal(attempt.accountId, `pending_${state}`);
  assert.equal('pairingCode' in attempt, false);
  assert.ok(attempt.verificationSecret);
  const completed = await provider.parseCallback(
    { state, completion_token: 'synthetic-completion' },
    {
      accountId: attempt.accountId,
      verificationSecret: attempt.verificationSecret,
      service: 'gmail',
    },
  );
  assert.equal(completed.accountId, 'ca_fixture_proxy');
  assert.equal(completed.pendingAccountId, attempt.accountId);
  for (const [callbackUrl, callback] of [
    [
      `http://127.0.0.1/api/apps/callback?state=${state}`,
      { type: 'loopback', host: 'ipv4', port: 80 },
    ],
    [
      `http://[::1]:65535/api/apps/callback?state=${state}`,
      { type: 'loopback', host: 'ipv6', port: 65535 },
    ],
    [
      `https://nod.customer.example/api/apps/callback?state=${state}`,
      {
        type: 'https',
        url: `https://nod.customer.example/api/apps/callback?state=${state}`,
      },
    ],
  ] as const) {
    expectedCallback = callback;
    const connected = await session.authorize('gmail', callbackUrl);
    assert.equal(connected.accountId, `pending_${state}`);
    assert.equal('pairingCode' in connected, false);
  }
  const completedCalls = calls.length;
  for (const callbackUrl of [
    'relative/callback',
    `http://remote.example/api/apps/callback?state=${state}`,
    `http://localhost:0/api/apps/callback?state=${state}`,
    `http://localhost:4310/api/integrations/callback?state=${state}`,
    `http://localhost:4310/api/apps/callback/?state=${state}`,
    `http://localhost:4310/api/apps/callback?state=${state}#fragment`,
    `http://user:password@localhost:4310/api/apps/callback?state=${state}`,
    `http://localhost:4310/api/apps/callback?state=${state}&state=${state}`,
    `http://localhost:4310/api/apps/callback?state=${state}&redirect=synthetic`,
    'http://localhost:4310/api/apps/callback',
    'http://localhost:4310/api/apps/callback?state=short',
    `https://nod.customer.example/api/apps/callback?state=${state}&state=${state}`,
    `https://user@nod.customer.example/api/apps/callback?state=${state}`,
    ...[
      'localhost',
      'localhost.',
      'app.localhost',
      '127.0.0.1',
      '127.1',
      '2130706433',
      '[::1]',
      '[2001:db8::1]',
      '192.0.2.1',
      'server',
    ].map((host) => `https://${host}/api/apps/callback?state=${state}`),
  ]) {
    await assert.rejects(session.authorize('gmail', callbackUrl), callbackUrl);
  }
  assert.equal(calls.length, completedCalls);
  await assert.rejects(async () =>
    provider.parseCallback({ state, completion_token: 'synthetic-completion' }),
  );
  await assert.rejects(provider.createSession('another-owner', {}));
  await assert.rejects(
    proxy.client
      .getClient()
      .post('https://untrusted.example.test/api/v3.1/tool_router/session', { body: {} }),
  );
  await assert.rejects(
    proxy.client
      .getClient()
      .withOptions({ baseURL: 'https://untrusted.example.test' })
      .get('/v2/api/v3.1/toolkits'),
  );
  assert.equal(calls.length, completedCalls);
  const file = {
    name: 'synthetic.bin',
    mimeType: 'application/octet-stream',
    bytes: Uint8Array.from([0, 255, 254, 10, 65, 128]),
  };
  await assert.rejects(session.upload!('GMAIL_SEND_EMAIL', file));
  assert.equal(calls.length, completedCalls);
  assert.deepEqual(await session.upload!('GMAIL_SEND_EMAIL', file, undefined, 'ca_fixture_proxy'), {
    name: file.name,
    mimetype: file.mimeType,
    s3key: uploadResponse,
  });
  assert.equal(calls.length, completedCalls + 1);
  uploadName = 'another-file.bin';
  await assert.rejects(session.upload!('GMAIL_SEND_EMAIL', file, undefined, 'ca_fixture_proxy'));
  uploadName = file.name;
  uploadResponse = 'raw-project-file-key';
  await assert.rejects(session.upload!('GMAIL_SEND_EMAIL', file, undefined, 'ca_fixture_proxy'));
  failUpload = true;
  const beforeUploadFailure = calls.length;
  await assert.rejects(session.upload!('GMAIL_SEND_EMAIL', file, undefined, 'ca_fixture_proxy'));
  assert.equal(calls.length, beforeUploadFailure + 1);
  const beforeInvalidUpload = calls.length;
  await assert.rejects(
    session.upload!(
      'GMAIL_SEND_EMAIL',
      file,
      AbortSignal.abort(new Error('Stopped')),
      'ca_fixture_proxy',
    ),
    /Stopped/,
  );
  await assert.rejects(
    session.upload!(
      'GMAIL_SEND_EMAIL',
      { ...file, bytes: new Uint8Array(15 * 1024 * 1024 + 1) },
      undefined,
      'ca_fixture_proxy',
    ),
  );
  assert.equal(calls.length, beforeInvalidUpload);
  assert.deepEqual(await session.execute('GMAIL_LIST_LABELS', {}, 'ca_fixture_proxy'), {
    data: { labels: [] },
    error: null,
    logId: 'fixture-log',
    resultType: 'completed',
  });
  failExecution = true;
  const before = calls.length;
  await assert.rejects(session.execute('GMAIL_LIST_LABELS', {}, 'ca_fixture_proxy'));
  assert.equal(calls.length, before + 1);
  assert.equal(new Set(calls.map((call) => call.key)).size, 1);
  assert.deepEqual(
    await provider.inboxSnippets!('ca_fixture_proxy', new AbortController().signal),
    [],
  );
  assert.equal(calls.at(-1)!.path, '/v2/api/v3.1/tools/execute/proxy');
  assert.equal(calls.at(-1)!.key, calls[0].key);
  await proxy.client
    .getClient()
    .withOptions({
      defaultHeaders: {
        authorization: 'Bearer synthetic-disallowed',
        'x-api-key': 'synthetic-disallowed',
      },
    })
    .get('/v2/api/v3.1/toolkits?type=native');
  await chmod(root, 0o755);
  const existingRoot = createComposioProxy(options);
  await existingRoot.initialize();
  assert.equal(existingRoot.userId, proxy.userId);
  const rootAlias = join(root, 'trusted-data-root');
  await symlink(root, rootAlias);
  const linkedRoot = createComposioProxy({
    ...options,
    dataRoot: rootAlias,
  });
  await linkedRoot.initialize();
  assert.equal(linkedRoot.userId, proxy.userId);
  for (const variant of [
    'symbolic key',
    'symbolic directory',
    'permissive directory',
    'permissive key',
    'nonregular key',
    'writable data root',
    'symbolic writable data root',
  ]) {
    await t.test(
      `installation identity rejects ${variant}`,
      {
        skip:
          process.platform === 'win32' &&
          [
            'permissive directory',
            'permissive key',
            'writable data root',
            'symbolic writable data root',
          ].includes(variant),
      },
      async () => {
        const dataRoot = join(root, variant.replaceAll(' ', '-'));
        const unsafeDirectory = join(dataRoot, 'integration-identity');
        const source = join(directory, entries[0]);
        const target = join(unsafeDirectory, entries[0]);
        if (variant === 'symbolic writable data root') {
          const writable = join(root, 'writable-target');
          await mkdir(writable);
          await chmod(writable, 0o777);
          await symlink(writable, dataRoot);
        } else {
          await mkdir(dataRoot, { mode: 0o700 });
          if (variant === 'symbolic directory') {
            await symlink(directory, unsafeDirectory);
          } else {
            await mkdir(unsafeDirectory, { mode: 0o700 });
            if (variant === 'symbolic key') await symlink(source, target);
            else if (variant === 'nonregular key') await mkdir(target);
            else {
              await copyFile(source, target);
              await chmod(target, variant === 'permissive key' ? 0o644 : 0o600);
            }
            if (variant === 'permissive directory') await chmod(unsafeDirectory, 0o755);
          }
          if (variant === 'writable data root') await chmod(dataRoot, 0o777);
        }
        const invalid = createComposioProxy({
          ...options,
          dataRoot,
        });
        await assert.rejects(invalid.initialize());
        assert.throws(() => invalid.userId);
      },
    );
  }
});

test('hosted app connection bridge keeps browser proof on the configured origin', async (t) => {
  for (const [origin, service] of [
    ['https://nod.customer.example', 'gmail'],
    ['https://apps.customer.example:8443', 'slack'],
    ['http://localhost:7310', 'outlook'],
  ]) {
    await t.test(origin, async (t) => {
      const root = await mkdtemp(join(tmpdir(), 'nod-hosted-bridge-'));
      t.after(() => rm(root, { recursive: true, force: true }));
      const browser = createIntegrationBrowser({ origin });
      t.after(() => browser.close());
      const app = Fastify();
      t.after(() => app.close());
      registerLocalAccess(app, 4310, { key: 'synthetic-owner-key', origin });
      browser.registerRoutes(app);
      const brokerOrigin = 'https://proxy.example.test';
      const calls: Array<{ path: string; body: Record<string, unknown> }> = [];
      const proxy = createComposioProxy({
        dataRoot: root,
        ownerId: 'hosted-fixture-owner',
        keyStore: installationKeyStore,
        checkpoint: fixtureIdentityCheckpoint,
        browser,
        url: brokerOrigin,
        request: async (input, init) => {
          const request = new Request(input, init);
          const path = new URL(request.url).pathname;
          const body = JSON.parse(await request.text());
          calls.push({ path, body });
          if (path === '/v2/access/enroll')
            return Response.json({ state: 'enabled', userId: proxy.userId });
          assert.equal(path, '/v2/connect/start');
          assert.equal(body.toolkit, service);
          assert.equal('native' in body, false);
          return Response.json({
            redirectUrl: brokerOrigin + '/v2/connect/pair?ticket=synthetic-hosted',
            transactionId: body.transactionId,
          });
        },
      });
      const state = randomBytes(32).toString('base64url');
      const callback = `${origin}/api/apps/callback?state=${state}`;
      const attempt = await proxy.authorize(service, callback);
      const url = new URL(attempt.url);
      assert.equal(url.origin, origin);
      assert.match(url.pathname, /^\/api\/apps\/connect\/[A-Za-z0-9_-]{43}$/);
      assert.equal(browser.owns(attempt.url), true);
      assert.equal(browser.remote(attempt.url), undefined);
      const headers = { host: url.host };
      assert.equal(
        (await app.inject({ url: url.pathname, headers: { host: 'attacker.example.test' } }))
          .statusCode,
        403,
      );
      assert.equal(
        (
          await app.inject({
            url: url.pathname,
            headers: { ...headers, origin: 'https://attacker.example.test' },
          })
        ).statusCode,
        403,
      );
      assert.equal(
        (
          await app.inject({
            url: `/api/apps/connect/${randomBytes(32).toString('base64url')}`,
            headers,
          })
        ).statusCode,
        403,
      );
      const bootstrap = await app.inject({
        url: url.pathname,
        headers: {
          ...headers,
          'sec-fetch-site': 'cross-site',
          'sec-fetch-mode': 'navigate',
          'sec-fetch-dest': 'document',
        },
      });
      assert.equal(bootstrap.statusCode, 200, bootstrap.body);
      assert.equal(bootstrap.headers['cache-control'], 'no-store');
      assert.match(String(bootstrap.headers['content-security-policy']), /frame-ancestors 'none'/);
      const { bridgeKey } = JSON.parse(
        bootstrap.body.match(/const \{brokerOrigin,id,expiresAt,bridgeKey\}=(.+);/)![1],
      );
      assert.equal((await app.inject({ url: url.pathname, headers })).statusCode, 403);
      const key = generateKeyPairSync('ec', { namedCurve: 'prime256v1' }).publicKey.export({
        format: 'jwk',
      });
      const post = (extra: Record<string, string>, payload = { browserKey: key }) =>
        app.inject({
          method: 'POST',
          url: url.pathname,
          headers: { ...headers, 'content-type': 'application/json', ...extra },
          payload,
        });
      for (const extra of [
        {},
        { origin },
        { origin: 'https://attacker.example.test', 'x-nod-bridge': bridgeKey },
        { origin, 'x-nod-bridge': bridgeKey, 'sec-fetch-site': 'cross-site' },
      ] as Array<Record<string, string>>)
        assert.equal((await post(extra)).statusCode, 403);
      assert.equal(calls.length, 0);
      const started = await post({ origin, 'x-nod-bridge': bridgeKey });
      assert.equal(started.statusCode, 200, started.body);
      assert.equal(started.json().id, state);
      assert.deepEqual(
        calls.map((call) => call.path),
        ['/v2/access/enroll', '/v2/connect/start'],
      );
      const sent = calls.at(-1)!.body;
      assert.equal(sent.transactionId, state);
      assert.deepEqual(sent.browserKey, key);
      assert.deepEqual(
        sent.uiOrigin,
        origin.startsWith('https:')
          ? { type: 'https', url: origin }
          : { type: 'loopback', host: 'localhost', port: 7310 },
      );
      assert.deepEqual(
        sent.callback,
        origin.startsWith('https:')
          ? { type: 'https', url: callback }
          : { type: 'loopback', host: 'localhost', port: 7310 },
      );
      assert.equal(
        browser.remote(attempt.url),
        brokerOrigin + '/v2/connect/pair?ticket=synthetic-hosted',
      );
      assert.equal((await post({ origin, 'x-nod-bridge': bridgeKey })).statusCode, 403);
      assert.equal(calls.length, 2);
      browser.finish(state);
      assert.equal(browser.owns(attempt.url), false);
      assert.equal(browser.remote(attempt.url), undefined);
      assert.equal((await app.inject({ url: url.pathname, headers })).statusCode, 403);
      assert.equal((await post({ origin, 'x-nod-bridge': bridgeKey })).statusCode, 403);
    });
  }
});

test('hosted connection attempts fail closed after expiry or invalid startup', async (t) => {
  const origin = 'https://nod.customer.example';
  const brokerOrigin = 'https://proxy.example.test';
  const browser = createIntegrationBrowser({ origin });
  t.after(() => browser.close());
  const app = Fastify();
  t.after(() => app.close());
  registerLocalAccess(app, 4310, { key: 'synthetic-owner-key', origin });
  browser.registerRoutes(app);
  const key = generateKeyPairSync('ec', { namedCurve: 'prime256v1' }).publicKey.export({
    format: 'jwk',
  });
  for (const variant of [
    'expired',
    'broker-failure',
    'foreign-broker',
    'invalid-key',
    'cancelled-start',
  ]) {
    await t.test(variant, async () => {
      const id = randomBytes(32).toString('base64url');
      let starts = 0;
      let markStarted = () => {};
      let releaseStart = () => {};
      const didStart = new Promise<void>((resolve) => {
        markStarted = resolve;
      });
      const continueStart = new Promise<void>((resolve) => {
        releaseStart = resolve;
      });
      const url = new URL(
        await browser.open(id, brokerOrigin, async () => {
          starts++;
          if (variant === 'cancelled-start') {
            markStarted();
            await continueStart;
          }
          if (variant === 'broker-failure') throw new Error('Synthetic broker failure.');
          return variant === 'foreign-broker'
            ? 'https://attacker.example.test/v2/connect/pair?ticket=synthetic'
            : brokerOrigin + '/v2/connect/pair?ticket=synthetic';
        }),
      );
      const headers = { host: url.host };
      const bootstrap = await app.inject({ url: url.pathname, headers });
      assert.equal(bootstrap.statusCode, 200);
      const { bridgeKey } = JSON.parse(
        bootstrap.body.match(/const \{brokerOrigin,id,expiresAt,bridgeKey\}=(.+);/)![1],
      );
      let restoreClock = () => {};
      if (variant === 'expired') {
        const expired = Date.now() + 11 * 60_000;
        const clock = t.mock.method(Date, 'now', () => expired);
        restoreClock = () => clock.mock.restore();
      }
      try {
        const pending = Promise.resolve(
          app.inject({
            method: 'POST',
            url: url.pathname,
            headers: { ...headers, origin, 'x-nod-bridge': bridgeKey },
            payload: { browserKey: variant === 'invalid-key' ? { ...key, crv: 'P-384' } : key },
          }),
        );
        if (variant === 'cancelled-start') {
          await didStart;
          browser.finish(id);
          releaseStart();
        }
        const started = await pending;
        assert.equal(started.statusCode, variant === 'expired' ? 403 : 400, started.body);
        assert.equal(starts, ['expired', 'invalid-key'].includes(variant) ? 0 : 1);
        assert.equal(browser.owns(url.href), false);
        assert.equal(browser.remote(url.href), undefined);
        assert.equal((await app.inject({ url: url.pathname, headers })).statusCode, 403);
      } finally {
        restoreClock();
      }
    });
  }
});

test('hosted connection proof signs only the opened broker popup challenge for its exact attempt', async (t) => {
  for (const variant of ['valid', 'expires-before-sign', 'expires-during-sign']) {
    await t.test(variant, async (t) => {
      const origin = 'https://nod.customer.example';
      const brokerOrigin = 'https://proxy.example.test';
      const id = randomBytes(32).toString('base64url');
      const browser = createIntegrationBrowser({ origin });
      t.after(() => browser.close());
      const app = Fastify();
      t.after(() => app.close());
      registerLocalAccess(app, 4310, { key: 'synthetic-owner-key', origin });
      browser.registerRoutes(app);
      let browserKey: unknown;
      const url = await browser.open(id, brokerOrigin, async (key, uiOrigin, native) => {
        browserKey = key;
        assert.equal(uiOrigin, origin);
        assert.equal(native, undefined);
        return brokerOrigin + '/v2/connect/pair?ticket=synthetic-proof';
      });
      const bootstrap = await app.inject({
        url: new URL(url).pathname,
        headers: { host: new URL(origin).host },
      });
      assert.equal(bootstrap.statusCode, 200, bootstrap.body);
      const proofs: Array<{ message: Record<string, unknown>; origin: string }> = [];
      const popup = {
        closed: false,
        location: {
          href: '',
          replace(value: string) {
            this.href = value;
          },
        },
        postMessage(message: Record<string, unknown>, targetOrigin: string) {
          proofs.push({ message, origin: targetOrigin });
        },
        close() {
          this.closed = true;
        },
      };
      let signing = false;
      let releaseSign = () => {};
      const signGate = new Promise<void>((resolve) => {
        releaseSign = resolve;
      });
      const browserCrypto = {
        subtle: {
          generateKey: webcrypto.subtle.generateKey.bind(webcrypto.subtle),
          exportKey: webcrypto.subtle.exportKey.bind(webcrypto.subtle),
          async sign(...args: Parameters<typeof webcrypto.subtle.sign>) {
            signing = true;
            if (variant === 'expires-during-sign') await signGate;
            return webcrypto.subtle.sign(...args);
          },
        },
      };
      const dom = new JSDOM(bootstrap.body, {
        url,
        runScripts: 'dangerously',
        beforeParse(window) {
          Object.defineProperty(window, 'crypto', { value: browserCrypto });
          Object.defineProperty(window, 'TextEncoder', { value: TextEncoder });
          window.open = () => popup as unknown as Window;
          window.fetch = async (input, init) => {
            const response = await app.inject({
              method: 'POST',
              url: new URL(String(input), origin).pathname,
              headers: {
                ...Object.fromEntries(new Headers(init?.headers).entries()),
                host: new URL(origin).host,
                origin,
              },
              payload: String(init?.body),
            });
            return new Response(response.body, { status: response.statusCode });
          };
        },
      });
      t.after(() => dom.window.close());
      const until = async (predicate: () => boolean) => {
        for (let attempt = 0; attempt < 100 && !predicate(); attempt++) await delay(10);
        assert.ok(predicate(), 'The browser protocol did not reach the expected step.');
      };
      (dom.window.document.getElementById('connect') as HTMLButtonElement).click();
      await until(() => browserKey !== undefined && popup.location.href.startsWith(brokerOrigin));
      const challenge = [
        'nod-proxy-connect-v2',
        id,
        origin,
        'a'.repeat(64),
        randomBytes(32).toString('base64url'),
      ].join('\n');
      const message = { type: 'nod:proxy-connect:challenge', id, challenge };
      const dispatch = (data: unknown, source: unknown = popup, from = brokerOrigin) =>
        dom.window.dispatchEvent(
          new dom.window.MessageEvent('message', { data, source: source as Window, origin: from }),
        );
      dispatch(message, popup, 'https://attacker.example.test');
      dispatch(message, null);
      dispatch({ ...message, id: randomBytes(32).toString('base64url') });
      dispatch({
        ...message,
        challenge: challenge.replace(origin, 'https://attacker.example.test'),
      });
      dispatch({
        ...message,
        challenge: challenge.replace(id, randomBytes(32).toString('base64url')),
      });
      dispatch({ ...message, challenge: challenge.replace('a'.repeat(64), 'not-a-hash') });
      await delay(25);
      assert.equal(proofs.length, 0);
      assert.equal(signing, false);
      const expire = () => {
        const expired = Date.now() + 11 * 60_000;
        Object.defineProperty(dom.window.Date, 'now', { value: () => expired });
      };
      if (variant === 'expires-before-sign') expire();
      dispatch(message);
      if (variant === 'expires-during-sign') {
        await until(() => signing);
        expire();
        releaseSign();
      }
      if (variant !== 'valid') {
        await until(() => popup.closed);
        assert.equal(proofs.length, 0);
        return;
      }
      await until(() => proofs.length === 1);
      assert.equal(proofs[0].origin, brokerOrigin);
      assert.equal(proofs[0].message.type, 'nod:proxy-connect:proof');
      assert.equal(proofs[0].message.id, id);
      const signature = Buffer.from(String(proofs[0].message.signature), 'base64url');
      assert.equal(signature.length, 64);
      assert.ok(
        verify(
          'sha256',
          Buffer.from(challenge),
          {
            key: createPublicKey({
              key: browserKey as import('node:crypto').JsonWebKey,
              format: 'jwk',
            }),
            dsaEncoding: 'ieee-p1363',
          },
          signature,
        ),
      );
      dispatch(message);
      await delay(25);
      assert.equal(proofs.length, 1);
    });
  }
});

test('connection bridge binds a single browser bootstrap to one installation attempt and closes on completion', async (t) => {
  const browser = createIntegrationBrowser();
  t.after(() => browser.close());
  const id = randomBytes(32).toString('base64url');
  const brokerOrigin = 'https://proxy.example.test';
  const key = generateKeyPairSync('ec', { namedCurve: 'prime256v1' }).publicKey.export({
    format: 'jwk',
  });
  let calls = 0;
  let returnPath = '';
  const url = await browser.open(id, brokerOrigin, async (browserKey, origin, native) => {
    calls++;
    assert.deepEqual(browserKey, key);
    assert.equal(origin, new URL(url).origin);
    assert.ok(native);
    returnPath = native.returnPath;
    assert.match(returnPath, /^\/[A-Za-z0-9_-]{43}$/);
    return `${brokerOrigin}/v2/connect/pair?ticket=fixture`;
  });
  const origin = new URL(url).origin;
  assert.equal(browser.owns(url), true);
  assert.equal(browser.remote(url), undefined);
  assert.equal(
    (await fetch(url, { headers: { origin: 'https://untrusted.example.test' } })).status,
    403,
  );
  assert.equal((await fetch(`${origin}/${randomBytes(32).toString('base64url')}`)).status, 403);
  const bootstrap = await fetch(url);
  assert.equal(bootstrap.status, 200);
  assert.equal(bootstrap.headers.get('cache-control'), 'no-store');
  assert.match(bootstrap.headers.get('content-security-policy')!, /frame-ancestors 'none'/);
  const html = await bootstrap.text();
  const bridgeKey = JSON.parse(html.match(/const bridgeKey=("[^"]+");/)![1]);
  assert.equal((await fetch(url)).status, 403);
  const post = (headers: Record<string, string>) =>
    fetch(`${origin}/start`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...headers },
      body: JSON.stringify({
        browserKey: { ...key, alg: 'ES256', ext: true, key_ops: ['verify'] },
      }),
    });
  for (const headers of [
    {},
    { origin },
    { origin: 'https://attacker.example.test', 'x-nod-bridge': bridgeKey },
    { origin, 'x-nod-bridge': bridgeKey, 'sec-fetch-site': 'cross-site' },
  ] as Array<Record<string, string>>)
    assert.equal((await post(headers)).status, 403);
  assert.equal(calls, 0);
  const started = await post({ origin, 'x-nod-bridge': bridgeKey });
  assert.equal(started.status, 200);
  assert.equal((await started.json()).id, id);
  assert.equal(calls, 1);
  assert.equal(browser.remote(url), `${brokerOrigin}/v2/connect/pair?ticket=fixture`);
  assert.equal((await post({ origin, 'x-nod-bridge': bridgeKey })).status, 403);
  assert.equal(
    (await fetch(origin + returnPath, { headers: { origin: 'https://attacker.example.test' } }))
      .status,
    403,
  );
  const continuation = await fetch(origin + returnPath, { headers: { origin: brokerOrigin } });
  assert.equal(continuation.status, 200);
  assert.ok((await continuation.text()).includes(id));
  assert.equal((await fetch(origin + returnPath)).status, 403);
  browser.finish(id);
  assert.equal(browser.owns(url), false);
  assert.equal(browser.remote(url), undefined);
  await assert.rejects(fetch(url));
  const failedUrl = await browser.open(randomBytes(32).toString('base64url'), brokerOrigin, () =>
    Promise.reject(new Error('Synthetic broker outage.')),
  );
  const failedOrigin = new URL(failedUrl).origin;
  const failedKey = JSON.parse(
    (await (await fetch(failedUrl)).text()).match(/const bridgeKey=("[^"]+");/)![1],
  );
  const failed = await fetch(`${failedOrigin}/start`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      origin: failedOrigin,
      'x-nod-bridge': failedKey,
    },
    body: JSON.stringify({ browserKey: key }),
  });
  assert.equal(failed.status, 400);
  await failed.text();
  assert.equal(browser.owns(failedUrl), false);
  let starting = () => {};
  let fail = (_error: Error) => {};
  const pending = new Promise<void>((resolve) => {
    starting = resolve;
  });
  const abandonedUrl = await browser.open(
    randomBytes(32).toString('base64url'),
    brokerOrigin,
    () => {
      starting();
      return new Promise<string>((_resolve, reject) => {
        fail = reject;
      });
    },
  );
  const abandonedOrigin = new URL(abandonedUrl).origin;
  const abandonedKey = JSON.parse(
    (await (await fetch(abandonedUrl)).text()).match(/const bridgeKey=("[^"]+");/)![1],
  );
  const leaving = new AbortController();
  const abandoned = fetch(`${abandonedOrigin}/start`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      origin: abandonedOrigin,
      'x-nod-bridge': abandonedKey,
    },
    body: JSON.stringify({ browserKey: key }),
    signal: leaving.signal,
  });
  await pending;
  leaving.abort();
  await assert.rejects(abandoned);
  await new Promise((resolve) => setTimeout(resolve, 50));
  fail(new Error('Synthetic broker outage.'));
  await new Promise((resolve) => setTimeout(resolve, 50));
  assert.equal(browser.owns(abandonedUrl), false);
  await browser.close();
  await assert.rejects(
    browser.open(randomBytes(32).toString('base64url'), brokerOrigin, async () => ''),
  );
});

for (const desktop of [false, true]) {
  test(
    `default proxy routing preserves encrypted identity and account access after ${desktop ? 'desktop' : 'server'} restart`,
    { skip: !process.env.TEST_DATABASE_URL },
    async (t) => {
      const root = await mkdtemp(join(tmpdir(), 'nod-default-proxy-'));
      t.after(() => rm(root, { recursive: true, force: true }));
      const db = await hostedDatabase();
      t.after(() => db.close());
      const schema = (await db.pool.query('SELECT current_schema() AS name')).rows[0].name;
      const databaseUrl = new URL(process.env.TEST_DATABASE_URL!);
      databaseUrl.searchParams.set('options', `-c search_path=${schema}`);
      for (const phase of ['initial', 'restart']) {
        const result = spawnSync(
          process.execPath,
          [
            '--experimental-transform-types',
            fileURLToPath(new URL('./fixtures/composio-defaults.mts', import.meta.url)),
          ],
          {
            input: JSON.stringify({ phase }),
            encoding: 'utf8',
            timeout: 45_000,
            maxBuffer: 1024 * 1024,
            env: {
              PATH: process.env.PATH,
              USER: 'nod-test',
              LANG: 'C.UTF-8',
              TZ: 'UTC',
              NODE_ENV: 'test',
              CI: 'true',
              DOTENV_CONFIG_PATH: '/dev/null',
              NOD_DATA_ROOT: root,
              PI_CODING_AGENT_DIR: join(root, 'pi'),
              NOD_VAULT_KEY: Buffer.alloc(32, 11).toString('base64'),
              NOD_ANALYTICS_ENABLED: 'false',
              DATABASE_URL: databaseUrl.href,
              PORT: '4310',
              NOD_PUBLIC_URL: desktop ? 'http://127.0.0.1:4310' : 'http://localhost:4310',
              ...(desktop
                ? {
                    NOD_DESKTOP: 'true',
                    NOD_DESKTOP_OWNER_ID: '11111111-1111-4111-8111-111111111111',
                    NOD_DESKTOP_AUTH_TOKEN: Buffer.alloc(32, 12).toString('base64url'),
                  }
                : {}),
            },
          },
        );
        assert.ifError(result.error);
        assert.equal(result.status, 0, result.stdout + result.stderr);
        const receipt = JSON.parse(result.stdout.trim().split('\n').at(-1)!);
        assert.equal(receipt.connected, true);
        assert.equal(receipt.executions, 1);
        assert.equal(receipt.foreignDenied, 2);
      }
    },
  );
}

test('managed authorization bounds streamed response bytes before parsing and cancels oversized bodies', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'nod-integration-limit-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  for (const variant of ['streamed', 'declared', 'misreported', 'utf8-overflow']) {
    await t.test(variant, async () => {
      let pulled = 0;
      let cancelled = false;
      let calls = 0;
      let total = 0;
      const proxy = createComposioProxy({
        keyStore: installationKeyStore,
        checkpoint: fixtureIdentityCheckpoint,
        dataRoot: root,
        ownerId: 'response-limit-owner',
        url: 'https://proxy.example.test',
        request: async (_input, init) => {
          calls++;
          const { transactionId } = JSON.parse(String(init?.body));
          const bytes = Buffer.from(
            JSON.stringify({
              redirectUrl: 'https://proxy.example.test/v1/connect/pair?ticket=synthetic',
              transactionId,
              padding:
                variant === 'utf8-split'
                  ? 'é'
                  : variant === 'utf8-overflow'
                    ? 'é'.repeat(20_000)
                    : 'x'.repeat(50_000),
            }),
          );
          const size = variant === 'utf8-split' ? 1 : 1024;
          total = Math.ceil(bytes.length / size);
          return new Response(
            new ReadableStream<Uint8Array>(
              {
                pull(controller) {
                  if (pulled === total) return controller.close();
                  controller.enqueue(bytes.subarray(pulled * size, ++pulled * size));
                },
                cancel() {
                  cancelled = true;
                },
              },
              { highWaterMark: 0 },
            ),
            {
              headers:
                variant === 'declared'
                  ? { 'Content-Length': String(bytes.length) }
                  : variant === 'misreported'
                    ? { 'Content-Length': '20' }
                    : {},
            },
          );
        },
      });
      await proxy.initialize();
      const result = proxy.client.getClient().get('/api/v3.1/toolkits?type=native');
      await assert.rejects(result);
      assert.equal(cancelled, true);
      assert.ok(pulled < total);
      if (variant === 'declared') assert.equal(pulled, 0);
      assert.equal(calls, 1);
    });
  }
});

test(
  'integration provider changes replace owned connections only after verified consent',
  { skip: !process.env.TEST_DATABASE_URL },
  async (t) => {
    t.mock.timers.enable({ apis: ['setInterval'] });
    for (const variant of [
      'success',
      'single-connection',
      'watch-disabled',
      'two-accounts',
      'restart',
      'expired-claim-restart',
      'cancel',
      'authorize-failure',
      'wrong-email',
      'wrong-owner',
      'unknown-identity',
      'foreign-target',
      'superseded',
      'restart-during-callback',
      'claim-during-start',
      'concurrent',
      'callback-race',
      'expired',
      'disconnected',
      'existing-account',
    ]) {
      await t.test(variant, async (t) => {
        const succeeds = [
          'success',
          'single-connection',
          'watch-disabled',
          'two-accounts',
          'restart',
          'expired-claim-restart',
          'superseded',
          'restart-during-callback',
          'claim-during-start',
          'concurrent',
          'callback-race',
        ].includes(variant);
        const database = await hostedDatabase(
          ['single-connection', 'callback-race'].includes(variant)
            ? { max: 1, connectionTimeoutMillis: 1500 }
            : {},
        );
        const apps: ReturnType<typeof Fastify>[] = [];
        let releaseParsing = () => {};
        let parsed = () => {};
        const parsingStarted = new Promise<void>((resolve) => {
          parsed = resolve;
        });
        const parsingHeld = new Promise<void>((resolve) => {
          releaseParsing = resolve;
        });
        let holdingParse = false;
        let releaseAuthorization = () => {};
        let authorizing = () => {};
        const authorizationStarted = new Promise<void>((resolve) => {
          authorizing = resolve;
        });
        const authorizationHeld = new Promise<void>((resolve) => {
          releaseAuthorization = resolve;
        });
        let releaseInspection = () => {};
        let inspected = () => {};
        const inspectionStarted = new Promise<void>((resolve) => {
          inspected = resolve;
        });
        const inspectionHeld = new Promise<void>((resolve) => {
          releaseInspection = resolve;
        });
        let holdingInspection = false;
        const completedTokens = new Set<string>();
        t.after(async () => {
          releaseParsing();
          releaseAuthorization();
          releaseInspection();
          for (const app of apps) await app.close();
          await database.close();
        });
        const owner = 'fixture-owner';
        const oldId = randomUUID();
        const otherId = randomUUID();
        const selected: Array<Parameters<IntegrationProvider['createSession']>[1]> = [];
        const removed: string[] = [];
        const polled: string[] = [];
        const callbacks = new Map<string, string>();
        const remote = new Map<string, { email: string; active: boolean; owner: string }>();
        let nextEmail = variant === 'wrong-email' ? 'wrong@example.test' : 'owner@example.test';
        let authorizations = 0;
        const session: IntegrationSession = {
          id: 'new-session',
          authorize: async (_service, callback) => {
            authorizations++;
            if (variant === 'authorize-failure') throw new Error('Synthetic consent unavailable.');
            const accountId = `new-account-${authorizations}`;
            callbacks.set(accountId, callback);
            remote.set(accountId, {
              email: nextEmail,
              active: false,
              owner: variant === 'wrong-owner' ? 'another-owner' : owner,
            });
            if (variant === 'claim-during-start' && authorizations === 2) {
              authorizing();
              await authorizationHeld;
            }
            return {
              accountId: `pending_${new URL(callback).searchParams.get('state')}`,
              verificationSecret: 'synthetic-local-challenge',
              url: 'https://proxy.example.test/connect',
            };
          },
          search: async () => ({ tools: {}, suggestions: [] }),
          execute: async (_action, _args, accountId) => {
            assert.equal(remote.get(accountId!)?.active, true);
            return { accountId };
          },
        };
        await createIntegrations(database.pool, {
          ownerId: owner,
          provider: { ...fakeProvider(session), configurationId: 'previous-project' },
          baseUrl: 'http://localhost:4310',
          wake: async () => assert.fail('Old queued work must remain fenced.'),
        });
        async function seed(id: string, account: string, email: string | null, rowOwner = owner) {
          await database.pool.query(
            `INSERT INTO app_connections (id,owner_id,slug,account_id,provider_id,configuration_id,
             account_name,account_email,trigger_id,triggers_enabled,watch_requested,inbox_cursor)
             VALUES ($1,$2,'gmail',$3,'fixture','previous-project','Saved account',$4,$5,true,$6,'old-cursor')`,
            [id, rowOwner, account, email, `${account}-trigger`, variant !== 'watch-disabled'],
          );
          await database.pool.query(
            `INSERT INTO integration_events (id,owner_id,summary,slug,account_id,provider_id,poll_connection_id)
             VALUES ($1,$2,'Synthetic old queued message','gmail',$3,'fixture',$4)`,
            [`${account}-event`, rowOwner, account, id],
          );
        }
        await seed(
          oldId,
          'old-account',
          variant === 'unknown-identity' ? null : 'owner@example.test',
        );
        if (variant === 'two-accounts') await seed(otherId, 'old-other', 'second@example.test');
        if (variant === 'foreign-target')
          await seed(otherId, 'old-foreign', 'foreign@example.test', 'another-owner');
        if (variant === 'existing-account') {
          await database.pool.query(
            `INSERT INTO app_connections (id,owner_id,slug,account_id,provider_id,configuration_id,account_email,watch_requested)
             VALUES ($1,$2,'gmail','new-account-1','fixture','managed-project','owner@example.test',false)`,
            [otherId, owner],
          );
          remote.set('new-account-1', { email: 'owner@example.test', active: true, owner });
        }
        await database.pool.query(
          'CREATE TABLE integration_sessions (owner_id text PRIMARY KEY,session_id text,provider_id text,configuration_version integer,configuration_id text)',
        );
        await database.pool.query(
          `INSERT INTO integration_sessions(owner_id,session_id,provider_id,configuration_version,configuration_id)
           VALUES ($1,'old-session','fixture',3,'previous-project')`,
          [owner],
        );
        const provider: IntegrationProvider = {
          ...fakeProvider(session),
          configurationId: 'managed-project',
          supportsSubscriptions: [],
          webhooksConfigured: false,
          createSession: async (user, accounts) => {
            assert.equal(user, owner);
            assert.ok(
              Object.values(accounts)
                .flat()
                .every((id) => typeof id === 'string' && !id.startsWith('old-')),
            );
            selected.push(accounts);
            return session;
          },
          deleteSession: async (id) => {
            assert.notEqual(id, 'old-session');
            removed.push(id);
          },
          inspectAccount: async (id, user, options) => {
            assert.equal(user, owner);
            if (id.startsWith('old-')) {
              assert.equal(options?.verifyOwner, true);
              throw new Error('This account belongs to a different project owner.');
            }
            const account = remote.get(id);
            assert.ok(account);
            assert.equal(options?.verifyOwner, true);
            assert.equal(account.owner, user);
            if (variant === 'callback-race' && !holdingInspection) {
              holdingInspection = true;
              inspected();
              await inspectionHeld;
            }
            return { active: account.active, service: 'gmail', accountEmail: account.email };
          },
          deleteAccount: async (id) => {
            assert.ok(!id.startsWith('old-'));
            removed.push(id);
            if (remote.has(id)) assert.equal(remote.get(id)!.owner, owner);
            remote.delete(id);
          },
          unsubscribe: async (id) => assert.ok(!id.startsWith('old-')),
          reconnectAccount: async () => assert.fail('An old project account must not be reused.'),
          parseCallback: async (raw) => {
            const query = raw as Record<string, string>;
            if (completedTokens.has(query.state)) throw new Error('Completion token already used.');
            completedTokens.add(query.state);
            const account = remote.get(query.account_ref);
            assert.ok(account);
            if (query.outcome === 'ok') account.active = true;
            if (
              ['restart-during-callback', 'claim-during-start'].includes(variant) &&
              !holdingParse
            ) {
              holdingParse = true;
              parsed();
              await parsingHeld;
            }
            return {
              state: query.state,
              accountId: query.account_ref,
              pendingAccountId: `pending_${query.state}`,
              success: query.outcome === 'ok',
            };
          },
          pollInbox: async (id, cursor) => {
            assert.equal(remote.get(id)?.active, true);
            assert.equal(cursor, null);
            polled.push(id);
            return { cursor: 'new-cursor', hasMore: false, messages: [] };
          },
        };
        async function start() {
          const integrations = await createIntegrations(database.pool, {
            ownerId: owner,
            provider,
            baseUrl: 'http://localhost:4310',
            wake: async () => assert.fail('Old queued work must not be delivered.'),
          });
          const app = Fastify();
          apps.push(app);
          integrations.registerRoutes(app);
          return { integrations, app };
        }
        let { integrations, app } = await start();
        const original = (
          await database.pool.query('SELECT * FROM app_connections WHERE id=$1', [oldId])
        ).rows[0];
        const originalOther = (
          await database.pool.query('SELECT * FROM app_connections WHERE id=$1', [otherId])
        ).rows[0];
        const old = (await integrations.list(owner, { refresh: false })).find(
          (row) => row.connectionId === oldId,
        )!;
        assert.equal(old.status, 'disconnected');
        assert.equal(old.reconnectRequired, true);
        assert.deepEqual(
          await integrations.analyticsConnections(),
          variant === 'existing-account'
            ? [
                {
                  app: 'gmail',
                  publicApp: true,
                  connection_method: 'managed_app',
                  consentRevision: 'disabled',
                },
              ]
            : [],
        );
        await assert.rejects(
          integrations.execute(owner, 'GMAIL_LIST_LABELS', { connectionId: oldId }),
        );
        await integrations.pollInboxes();
        await integrations.drain();
        assert.deepEqual(polled, []);
        async function begin(id = oldId) {
          return app.inject({
            method: 'POST',
            url: '/api/apps/gmail/connect',
            payload: { connectionId: id },
          });
        }
        async function complete(account: string, outcome = 'ok') {
          const returned = new URL(callbacks.get(account)!);
          returned.searchParams.set('account_ref', account);
          returned.searchParams.set('outcome', outcome);
          return app.inject({ url: `${returned.pathname}${returned.search}` });
        }
        const starts =
          variant === 'concurrent'
            ? await Promise.all([begin(), begin()])
            : [await begin(variant === 'foreign-target' ? otherId : oldId)];
        const first = starts[0];
        if (['authorize-failure', 'unknown-identity', 'foreign-target'].includes(variant)) {
          assert.equal(
            first.statusCode,
            variant === 'authorize-failure' ? 502 : variant === 'foreign-target' ? 404 : 409,
            first.body,
          );
          assert.equal(authorizations, variant === 'authorize-failure' ? 1 : 0);
        } else {
          assert.equal(first.statusCode, 200, first.body);
          assert.deepEqual(first.json().account, {
            name: original.account_name,
            email: original.account_email,
          });
          assert.deepEqual(
            (await database.pool.query('SELECT * FROM app_connections WHERE id=$1', [oldId]))
              .rows[0],
            original,
          );
          if (variant === 'restart') {
            await app.close();
            ({ integrations, app } = await start());
          }
          if (variant === 'expired-claim-restart') {
            await database.pool.query(
              'UPDATE app_connections SET callback_claim_id=$1 WHERE account_id IS NULL',
              [randomUUID()],
            );
            await app.close();
            ({ integrations, app } = await start());
            const stale = await complete('new-account-1');
            assert.doesNotMatch(String(stale.headers.location), /connection=connected/);
            assert.equal(completedTokens.size, 0);
            assert.equal((await begin()).statusCode, 409);
            assert.equal(authorizations, 1);
            await database.pool.query(
              "UPDATE app_connections SET callback_expires=now()-interval '1 second' WHERE account_id IS NULL",
            );
            assert.equal((await begin()).statusCode, 200);
          }
          if (variant === 'superseded') {
            const second = await begin();
            assert.equal(second.statusCode, 200, second.body);
            const stale = await complete('new-account-1');
            assert.doesNotMatch(String(stale.headers.location), /connection=connected/);
          }
          let currentAccount = ['superseded', 'expired-claim-restart'].includes(variant)
            ? 'new-account-2'
            : 'new-account-1';
          if (variant === 'concurrent') {
            assert.equal(starts[1].statusCode, 200, starts[1].body);
            const pending = await database.pool.query(
              'SELECT pending_account_id FROM app_connections WHERE account_id IS NULL',
            );
            assert.equal(pending.rowCount, 1);
            currentAccount = [...callbacks].find(
              ([, url]) =>
                `pending_${new URL(url).searchParams.get('state')}` ===
                pending.rows[0].pending_account_id,
            )![0];
            const stale = await complete(
              currentAccount === 'new-account-1' ? 'new-account-2' : 'new-account-1',
            );
            assert.doesNotMatch(String(stale.headers.location), /connection=connected/);
          }
          if (variant === 'expired')
            await database.pool.query(
              "UPDATE app_connections SET callback_expires=now()-interval '1 second' WHERE account_id IS NULL",
            );
          if (variant === 'disconnected') {
            const disconnect = await app.inject({
              method: 'POST',
              url: `/api/apps/gmail/accounts/${oldId}/disconnect`,
            });
            assert.equal(disconnect.statusCode, 200, disconnect.body);
          }
          let retainedCompletion: ReturnType<typeof complete> | undefined;
          if (variant === 'claim-during-start') {
            const replacement = begin();
            await authorizationStarted;
            retainedCompletion = complete(currentAccount);
            await parsingStarted;
            releaseAuthorization();
            assert.equal((await replacement).statusCode, 409);
            releaseParsing();
          } else if (variant === 'restart-during-callback') {
            retainedCompletion = complete(currentAccount);
            await parsingStarted;
            assert.equal((await begin()).statusCode, 409);
            assert.equal(authorizations, 1);
            releaseParsing();
          }
          const accountId = currentAccount;
          const completion =
            retainedCompletion ?? complete(accountId, variant === 'cancel' ? 'cancel' : 'ok');
          if (variant === 'callback-race') {
            await inspectionStarted;
            const replay = await complete(accountId);
            assert.doesNotMatch(String(replay.headers.location), /connection=connected/);
            releaseInspection();
          }
          const returned = await completion;
          if (succeeds) {
            assert.match(String(returned.headers.location), /connection=connected/);
            const fresh = (await integrations.list(owner, { refresh: false })).filter(
              (row) => row.accountEmail === 'owner@example.test',
            );
            assert.equal(fresh.length, 1);
            assert.equal(fresh[0].connectionId, oldId);
            assert.equal(fresh[0].status, 'connected');
            assert.equal(fresh[0].reconnectRequired, false);
            const saved = (
              await database.pool.query('SELECT * FROM app_connections WHERE id=$1', [oldId])
            ).rows[0];
            assert.equal(saved.account_id, accountId);
            assert.equal(saved.watch_requested, original.watch_requested);
            assert.equal(saved.inbox_cursor, null);
            assert.equal(saved.trigger_id, null);
            assert.equal(
              (
                await database.pool.query(
                  "SELECT state FROM integration_events WHERE id='old-account-event'",
                )
              ).rows[0].state,
              'discarded',
            );
            assert.deepEqual(
              await integrations.execute(owner, 'GMAIL_LIST_LABELS', { connectionId: oldId }),
              { accountId },
            );
            if (variant === 'two-accounts') {
              assert.deepEqual(
                (await database.pool.query('SELECT * FROM app_connections WHERE id=$1', [otherId]))
                  .rows[0],
                originalOther,
              );
              nextEmail = 'second@example.test';
              assert.equal((await begin(otherId)).statusCode, 200);
              assert.match(
                String((await complete('new-account-2')).headers.location),
                /connection=connected/,
              );
              const second = (await integrations.list(owner, { refresh: false })).find(
                (row) => row.connectionId === otherId,
              )!;
              assert.equal(second.accountId, 'new-account-2');
              assert.equal(second.status, 'connected');
            }
            await integrations.pollInboxes();
            assert.deepEqual(
              polled,
              variant === 'watch-disabled'
                ? []
                : variant === 'two-accounts'
                  ? ['new-account-1', 'new-account-2']
                  : [accountId],
            );
            await integrations.drain();
            assert.equal(
              (await database.pool.query('SELECT id FROM app_connections WHERE account_id IS NULL'))
                .rowCount,
              0,
            );
          } else {
            assert.doesNotMatch(String(returned.headers.location), /connection=connected/);
          }
        }
        if (!succeeds && variant !== 'disconnected') {
          assert.deepEqual(
            (await database.pool.query('SELECT * FROM app_connections WHERE id=$1', [oldId]))
              .rows[0],
            original,
          );
          assert.equal(
            (
              await database.pool.query(
                "SELECT state FROM integration_events WHERE id='old-account-event'",
              )
            ).rows[0].state,
            'queued',
          );
          if (originalOther)
            assert.deepEqual(
              (await database.pool.query('SELECT * FROM app_connections WHERE id=$1', [otherId]))
                .rows[0],
              originalOther,
            );
          await assert.rejects(
            integrations.execute(owner, 'GMAIL_LIST_LABELS', { connectionId: oldId }),
          );
        }
        if (variant === 'disconnected')
          assert.equal(
            (await integrations.list(owner, { refresh: false })).some(
              (row) => row.status === 'connected',
            ),
            false,
          );
        if (['wrong-email', 'disconnected'].includes(variant))
          assert.equal(remote.has('new-account-1'), false);
        if (variant === 'wrong-owner') assert.equal(removed.includes('new-account-1'), false);
        assert.ok(removed.every((id) => !id.startsWith('old-')));
        assert.ok(
          selected.every((accounts) =>
            Object.values(accounts)
              .flat()
              .every((id) => typeof id === 'string' && !id.startsWith('old-')),
          ),
        );
      });
    }
  },
);

test(
  'integration accounts stay owner-private while event policy verifies and deduplicates',
  { skip: !process.env.TEST_DATABASE_URL },
  async (t) => {
    const schema = `test_composio_${randomUUID().replaceAll('-', '')}`;
    const admin = new pg.Pool({ connectionString: process.env.TEST_DATABASE_URL });
    await admin.query(`CREATE SCHEMA ${schema}`);
    const pool = new pg.Pool({
      connectionString: process.env.TEST_DATABASE_URL,
      options: `-c search_path=${schema}`,
    });
    const app = Fastify();
    let executed = 0;
    const delivered: string[] = [];
    const session: IntegrationSession = {
      id: 'fixture-session',
      authorize: async () => ({ accountId: 'ca-fixture', url: 'https://fixture.example/connect' }),
      execute: async () => {
        executed++;
        return { successful: true, data: { messages: [] } };
      },
      search: async () => ({
        tools: { GMAIL_SEND_EMAIL: { inputSchema: { type: 'object' } } },
        suggestions: [{ useCase: 'Send email', primaryToolSlugs: ['GMAIL_SEND_EMAIL'] }],
      }),
    };
    const provider = fakeProvider(session);
    const discoveredBrowserId = randomUUID();
    const pendingBrowserId = randomUUID();
    const savedLoginIds = [randomUUID(), randomUUID()];
    let browserEndpoint = 'https://example.test';
    const iconOrigins: string[] = [];
    const integrations = await createIntegrations(pool, {
      ownerId: 'local-development',
      provider,
      baseUrl: 'http://localhost:4310',
      icon: cachedIcons(async (origin) => {
        iconOrigins.push(origin);
        return { bytes: new Uint8Array([137, 80, 78, 71]), mimeType: 'image/png' };
      }),
      browserAccounts: async () => {
        return [
          ...savedLoginIds.map((id, index) => ({
            id,
            label: index ? 'Personal' : 'Work',
            origin: 'https://login.example.test',
          })),
          ...Array.from({ length: 25 }, (_, index) => ({
            id: randomUUID(),
            label: `Shop ${index}`,
            origin: `https://shop-${index}.example.test`,
          })),
        ].map((login) => ({
          ...login,
          kind: 'login' as const,
          usernameHint: 'synthetic-private-hint',
          username: 'synthetic-private-username',
          password: 'synthetic-private-password',
          updatedAt: '2026-01-01T00:00:00Z',
        }));
      },
      browserConnections: async () =>
        [
          { id: discoveredBrowserId, state: undefined },
          { id: pendingBrowserId, state: 'pending' as const },
        ].map(({ id, state }) => ({
          slug: 'browser-example-test',
          name: 'example.test',
          status: 'disconnected' as const,
          connectionId: id,
          triggersEnabled: false,
          accessPaths: [{ id, kind: 'browser' as const, endpoint: browserEndpoint }],
          ...(state ? { browserState: state } : {}),
        })),
      wake: async (prompt, id) => {
        delivered.push(id);
        assert.equal(prompt.includes('provider-secret'), false);
      },
    });
    integrations.registerRoutes(app);
    const event = {
      id: 'event-fixture-1',
      ownerId: 'local-development',
      service: 'gmail',
      accountId: 'ca-fixture',
      subscriptionId: 'ti-fixture',
      trigger: 'fixture-inbox-update',
      data: {
        subject: 'Meeting request',
        sender: 'person@example.com',
        access_token: 'provider-secret',
      },
    };
    async function send(value: unknown, invalid = false) {
      return app.inject({
        method: 'POST',
        url: '/api/webhooks/fixture',
        payload: JSON.stringify(value),
        headers: { 'content-type': 'application/json', 'x-fixture-valid': invalid ? 'no' : 'yes' },
      });
    }
    try {
      const listed = await integrations.manageConnections(
        'list',
        undefined,
        undefined,
        undefined,
        undefined,
        'https://login.example.test/signin',
      );
      assert.ok(Array.isArray(listed));
      const browserPaths = listed.flatMap((item) => ('slug' in item ? [item] : []));
      assert.deepEqual(
        browserPaths
          .filter((connection) => connection.accessPaths?.some((path) => path.kind === 'browser'))
          .map((connection) => connection.connectionId),
        [discoveredBrowserId, pendingBrowserId, ...savedLoginIds],
      );
      assert.deepEqual(
        browserPaths
          .filter((connection) => connection.savedLogin)
          .map(({ connectionId, accessPaths }) => ({ connectionId, accessPaths })),
        savedLoginIds.map((id) => ({
          connectionId: id,
          accessPaths: [{ id, kind: 'browser', endpoint: 'https://login.example.test' }],
        })),
      );
      assert.equal(
        browserPaths.find((connection) => connection.connectionId === pendingBrowserId)
          ?.browserAccess,
        'browser_session',
      );
      assert.doesNotMatch(JSON.stringify(browserPaths), /synthetic-private|usernameHint|password/);
      const byName = await integrations.manageConnections(
        'list',
        undefined,
        undefined,
        undefined,
        undefined,
        'Shop 7',
      );
      assert.ok(Array.isArray(byName));
      assert.deepEqual(
        byName.flatMap((item) =>
          'savedLogin' in item && item.savedLogin ? [item.accountName] : [],
        ),
        ['Shop 7'],
      );
      await assert.rejects(integrations.list('another-user'), { statusCode: 403 });
      const wrongSite = await integrations.manageConnections(
        'list',
        undefined,
        undefined,
        undefined,
        undefined,
        'example.test',
      );
      assert.ok(Array.isArray(wrongSite));
      assert.equal(
        wrongSite.filter((connection) => 'savedLogin' in connection && connection.savedLogin)
          .length,
        0,
      );
      await t.test(
        'app icons use only owned origins and never connection paths or credentials',
        async () => {
          const foreign = randomUUID();
          await pool.query(
            "INSERT INTO app_connections (id,owner_id,slug,account_id,provider_id) VALUES ($1,'another-user','gmail','ca-foreign','fixture')",
            [foreign],
          );
          for (const id of [foreign, randomUUID(), 'https%3A%2F%2Funowned.example'])
            assert.equal((await app.inject({ url: `/api/apps/${id}/icon` })).statusCode, 404);
          assert.deepEqual(iconOrigins, []);
          browserEndpoint = 'https://example.test/private/account?token=private-query#private';
          const result = await app.inject({ url: `/api/apps/${discoveredBrowserId}/icon` });
          assert.equal(result.statusCode, 200);
          assert.equal(result.headers['content-type'], 'image/png');
          assert.equal(result.headers['cross-origin-resource-policy'], 'same-origin');
          assert.equal(result.headers['x-content-type-options'], 'nosniff');
          assert.deepEqual(iconOrigins, ['https://example.test']);
          assert.equal(
            (await app.inject({ url: `/api/apps/${pendingBrowserId}/icon` })).statusCode,
            200,
          );
          assert.deepEqual(iconOrigins, ['https://example.test']);
          for (const endpoint of [
            'https://private-user:private-password@example.test/account',
            'http://127.0.0.1/account',
            'file:///private/account',
          ]) {
            browserEndpoint = endpoint;
            assert.equal(
              (await app.inject({ url: `/api/apps/${discoveredBrowserId}/icon` })).statusCode,
              404,
            );
          }
          assert.deepEqual(iconOrigins, ['https://example.test']);
          browserEndpoint = 'https://example.test';
        },
      );
      await pool.query(
        "INSERT INTO app_connections (owner_id,slug,account_id,trigger_id,triggers_enabled,provider_id) VALUES ('local-development','gmail','ca-fixture','ti-fixture',true,'fixture')",
      );
      const invalid = await send(event, true);
      assert.equal(invalid.statusCode, 401);
      assert.equal((await send({ ...event, ownerId: 'another-user' })).statusCode, 202);
      assert.equal((await send({ ...event, accountId: 'another-account' })).statusCode, 202);
      assert.equal((await pool.query('SELECT * FROM integration_events')).rowCount, 0);
      assert.equal((await send(event)).statusCode, 202);
      assert.equal((await send(event)).statusCode, 202);
      for (let attempt = 0; attempt < 100; attempt++) {
        if (
          (await pool.query("SELECT * FROM integration_events WHERE state = 'delivered'"))
            .rowCount === 1
        )
          break;
        await delay(10);
      }
      assert.deepEqual(delivered, ['fixture:event-fixture-1']);
      assert.equal((await pool.query('SELECT * FROM integration_events')).rowCount, 1);
      await integrations.execute('local-development', 'GMAIL_SEND_EMAIL', {
        recipient_email: 'test@example.com',
        subject: 'Fixture',
      });
      assert.equal(executed, 1);
      await integrations.execute('local-development', 'GMAIL_FETCH_EMAILS', { max_results: 5 });
      assert.equal(executed, 2);
      await integrations.execute('local-development', 'GMAIL_SEND_EMAIL', {
        recipient_email: 'fixture@example.com',
        connectionId: (await integrations.list()).find((row) => row.slug === 'gmail')?.connectionId,
      });
      assert.equal(executed, 3);
      await assert.rejects(integrations.execute('another-user', 'GMAIL_FETCH_EMAILS', {}));
      await assert.rejects(
        integrations.execute('local-development', 'COMPOSIO_MULTI_EXECUTE_TOOL', {}),
      );
      await assert.rejects(integrations.execute('local-development', 'GITHUB_CREATE_ISSUE', {}));
      const search = await integrations.execute('local-development', 'SEARCH_TOOLS', {
        query: 'Send an email',
      });
      assert.equal(JSON.stringify(search).includes('do-not-expose'), false);
      const searches = t.mock.method(session, 'search', session.search);
      assert.deepEqual(
        await integrations.execute('local-development', 'SEARCH_TOOLS', {
          query: 'Send an email',
          connectionId: (await integrations.list()).find((row) => row.slug === 'gmail')
            ?.connectionId,
        }),
        search,
      );
      assert.deepEqual(
        searches.mock.calls.map((call) => call.arguments[0]),
        ['Send an email'],
      );
      for (const args of [
        {},
        { query: '  ' },
        { query: 'x'.repeat(1001) },
        { query: 'List labels', connectionId: 'not-an-account' },
        { query: 'List labels', unexpected: 'private-fixture-value' },
      ])
        await integrations.execute('local-development', 'SEARCH_TOOLS', args);
      await assert.rejects(
        integrations.execute('another-user', 'SEARCH_TOOLS', { query: 'List labels' }),
      );
      assert.equal(searches.mock.callCount(), 1);
      t.mock.method(session, 'search', async () => {
        throw new Error('Fixture tool router timed out');
      });
      await assert.rejects(
        integrations.execute('local-development', 'SEARCH_TOOLS', { query: 'List Gmail labels' }),
        { statusCode: 502 },
      );
      await pool.query(
        "INSERT INTO integration_events (id,owner_id,summary,slug,account_id,trigger_id,provider_id) VALUES ('event-queued-before-disconnect','local-development','Obsolete event','gmail','ca-fixture','ti-fixture','fixture')",
      );
      await pool.query(
        "INSERT INTO integration_events (id,owner_id,summary,slug,account_id,trigger_id,provider_id,state,claimed_at) VALUES ('event-processing-before-disconnect','local-development','Interrupted event','gmail','ca-fixture','ti-fixture','fixture','processing',now()-interval '10 minutes')",
      );
      await pool.query(
        "UPDATE app_connections SET revoked = true, triggers_enabled = false WHERE slug = 'gmail'",
      );
      await integrations.drain();
      assert.equal(
        (
          await pool.query(
            "SELECT state FROM integration_events WHERE id = 'event-queued-before-disconnect'",
          )
        ).rows[0].state,
        'discarded',
      );
      assert.equal(
        (
          await pool.query(
            "SELECT state FROM integration_events WHERE id = 'event-processing-before-disconnect'",
          )
        ).rows[0].state,
        'discarded',
      );
      assert.equal(delivered.length, 1);
      await assert.rejects(integrations.execute('local-development', 'GMAIL_SEND_EMAIL', {}));
      assert.equal((await send({ ...event, id: 'event-after-disconnect' })).statusCode, 202);
      assert.equal((await pool.query('SELECT * FROM integration_events')).rowCount, 3);
    } finally {
      await app.close();
      await pool.end();
      await admin.query(`DROP SCHEMA ${schema} CASCADE`);
      await admin.end();
    }
  },
);

async function appsFixture(
  t: TestContext,
  poolOptions: { max?: number; connectionTimeoutMillis?: number } = {},
  listing: Partial<
    Pick<
      Parameters<typeof createIntegrations>[1],
      | 'browserConnections'
      | 'browserAccounts'
      | 'wake'
      | 'readWorkspaceFile'
      | 'writingStyle'
      | 'removeActivity'
      | 'admission'
      | 'analytics'
      | 'paused'
    >
  > = {},
) {
  const schema = `test_apps_${randomUUID().replaceAll('-', '')}`;
  const admin = new pg.Pool({ connectionString: process.env.TEST_DATABASE_URL });
  await admin.query(`CREATE SCHEMA ${schema}`);
  const pool = new pg.Pool({
    connectionString: process.env.TEST_DATABASE_URL,
    options: `-c search_path=${schema}`,
    ...poolOptions,
  });
  const app = Fastify();
  const accounts = new Map<string, IntegrationService>();
  const callbacks: string[] = [];
  const executed: Array<{ action: string; args: Record<string, unknown>; accountId?: string }> = [];
  const subscriptions: string[] = [];
  const removed: string[] = [];
  const sessions: unknown[] = [];
  const wakes: string[] = [];
  let settles = 0;
  const session: IntegrationSession = {
    id: 'current-session',
    authorize: async (service, callback) => {
      const accountId = `account-${accounts.size + 1}`;
      accounts.set(accountId, service);
      callbacks.push(callback);
      return { accountId, url: `https://consent.example.com/connect?account=${accountId}` };
    },
    search: async () => ({ tools: {}, suggestions: [] }),
    execute: async (action, args, accountId) => {
      executed.push({ action, args, accountId });
      return { ok: true };
    },
  };
  const provider: IntegrationProvider = {
    id: 'fixture',
    configured: true,
    supportedServices: integrationServiceIds,
    webhooksConfigured: true,
    supportsSubscriptions: ['gmail', 'googlecalendar', 'slack', 'googledocs'],
    createSession: async (_owner, selected) => {
      sessions.push(selected);
      return session;
    },
    deleteSession: async (id) => {
      removed.push(id);
    },
    inspectAccount: async (id) => ({
      active: accounts.has(id),
      service: accounts.get(id)!,
      accountName: `${accounts.get(id)} ${id}`,
    }),
    deleteAccount: async (id) => {
      removed.push(id);
      accounts.delete(id);
    },
    parseCallback: (value) => {
      const query = value as Record<string, string>;
      return { state: query.state, accountId: query.account, success: true };
    },
    subscribe: async (_owner, _service, accountId) => {
      subscriptions.push(accountId);
      return { id: `trigger-${accountId}` };
    },
    unsubscribe: async (id) => {
      removed.push(id);
    },
    matchesSubscription: (service, trigger) => trigger === `${service}-event`,
    verifyWebhook: async (body, headers) => {
      if (headers['x-fixture-signature'] !== 'valid') throw new Error('Invalid fixture signature.');
      return JSON.parse(String(body));
    },
  };
  const service = await createIntegrations(pool, {
    mailCheck: async (emails) => emails.map(() => false),
    ...listing,
    ownerId: 'local-development',
    provider,
    baseUrl: 'http://localhost:4310',
    wake:
      listing.wake ??
      (async (_prompt, id) => {
        wakes.push(id);
      }),
    settle: async () => settles++,
  });
  service.registerRoutes(app);
  t.after(async () => {
    await app.close();
    await pool.end();
    await admin.query(`DROP SCHEMA ${schema} CASCADE`);
    await admin.end();
  });
  async function connect(slug: IntegrationService) {
    const response = await app.inject({ method: 'POST', url: `/api/apps/${slug}/connect` });
    assert.equal(response.statusCode, 200, response.body);
    const url = new URL(callbacks.at(-1)!);
    assert.equal(url.pathname, '/api/apps/callback');
    const id = [...accounts.keys()].at(-1)!;
    url.searchParams.set('account', id);
    const callback = await app.inject({ url: `${url.pathname}${url.search}` });
    assert.equal(callback.statusCode, 302, callback.body);
    assert.equal(callback.headers.location, 'http://localhost:4310/apps?connection=connected');
    const replay = await app.inject({ url: `${url.pathname}${url.search}` });
    assert.equal(replay.statusCode, 302, replay.body);
    assert.equal(replay.headers.location, 'http://localhost:4310/apps?connection=expired');
    return (await service.list()).find((account) => account.accountId === id)!;
  }
  return {
    app,
    pool,
    accounts,
    service,
    provider,
    session,
    connect,
    executed,
    subscriptions,
    removed,
    sessions,
    wakes,
    settles: () => settles,
    callbacks,
  };
}

test(
  'Gmail scope failures preserve the account and its existing reconnect path',
  { skip: !process.env.TEST_DATABASE_URL },
  async (t) => {
    const f = await appsFixture(t);
    f.provider.reconnectAccount = async () => assert.fail('Consent needs an owner action.');
    const account = await f.connect('gmail');
    const before = (
      await f.pool.query('SELECT * FROM app_connections WHERE id=$1', [account.connectionId])
    ).rows[0];
    let requests = 0;
    f.session.execute = async () => {
      requests++;
      throw new IntegrationPermissionError(
        'HTTP 403: Request had insufficient authentication scopes.',
      );
    };
    await assert.rejects(
      f.service.execute('local-development', 'GMAIL_FETCH_EMAILS', {
        connectionId: account.connectionId,
      }),
      (error: Error & { statusCode?: number }) => {
        assert.equal(error.statusCode, 403);
        assert.match(error.message, /Do not retry until permissions change/);
        assert.ok(error.message.includes(account.connectionId!));
        return true;
      },
    );
    assert.equal(requests, 1);
    assert.ok(!f.removed.includes(account.accountId!));
    assert.deepEqual(
      (await f.pool.query('SELECT * FROM app_connections WHERE id=$1', [account.connectionId]))
        .rows[0],
      before,
    );
    const saved = (await f.service.list('local-development', { refresh: false })).find(
      (item) => item.connectionId === account.connectionId,
    );
    assert.equal(saved?.status, 'connected');
    assert.equal(saved?.canReconnect, true);
    assert.equal(saved?.reconnectRequired, false);
  },
);

test(
  'app preflight reads account state through the transaction with a full pool',
  { skip: !process.env.TEST_DATABASE_URL },
  async (t) => {
    const f = await appsFixture(t, { max: 1, connectionTimeoutMillis: 1000 });
    const account = await f.connect('gmail');
    const client = await f.pool.connect();
    try {
      await client.query('BEGIN');
      const prepare = () =>
        f.service.prepare(
          'local-development',
          'GMAIL_FETCH_EMAILS',
          { connectionId: account.connectionId },
          undefined,
          undefined,
          false,
          client,
        );
      assert.equal((await prepare()).connectionId, account.connectionId);
      await client.query('UPDATE app_connections SET account_active=false WHERE id=$1', [
        account.connectionId,
      ]);
      await assert.rejects(prepare(), /unavailable/);
      assert.equal(f.executed.length, 0);
    } finally {
      await client.query('ROLLBACK');
      client.release();
    }
  },
);

test('app groups retain service metadata and account identity when catalog data is missing', () => {
  const gmail: AppConnection = {
    slug: 'gmail',
    name: 'gmail',
    status: 'connected',
    connectionId: 'owned-gmail',
    triggersEnabled: false,
  };
  const notes: AppConnection = {
    slug: 'custom_notes',
    name: 'Custom Notes',
    description: 'Work with saved notes.',
    status: 'connected',
    connectionId: 'owned-notes',
    triggersEnabled: false,
  };
  for (const catalog of [
    [],
    [
      { slug: 'gmail', name: 'gmail', description: '' },
      { slug: 'custom_notes', name: ' ', description: ' ' },
    ].map((service): AppConnection => ({
      ...service,
      status: 'disconnected',
      triggersEnabled: false,
    })),
  ]) {
    const groups = connectionGroups([gmail, notes], catalog);
    const mail = groups.find((group) => group.key === 'gmail')!;
    assert.equal(mail.service.name, integrationServices.gmail.name);
    assert.equal(mail.service.description, integrationServices.gmail.description);
    assert.equal(mail.service.status, 'connected');
    assert.deepEqual(mail.accounts, [gmail]);
    const custom = groups.find((group) => group.key === 'custom_notes')!;
    assert.equal(custom.service.name, notes.name);
    assert.equal(custom.service.description, notes.description);
    assert.deepEqual(custom.accounts, [notes]);
  }
  const native = { ...notes, connectionId: undefined, status: 'disconnected' as const };
  const mcp = { ...notes, slug: 'custom_notes_mcp', name: 'Custom Notes MCP' };
  const catalog: AppConnection = {
    slug: notes.slug,
    name: notes.name,
    description: '',
    status: 'disconnected',
    triggersEnabled: false,
    logoUrl: 'https://assets.example.test/notes.svg',
    categories: ['Productivity'],
  };
  const [group] = connectionGroups([native, mcp], [catalog]);
  assert.equal(group.service.description, notes.description);
  assert.equal(group.service.logoUrl, catalog.logoUrl);
  assert.deepEqual(group.service.categories, catalog.categories);
  assert.deepEqual(group.accounts, [mcp]);
  const [available] = connectionGroups([native], [catalog]);
  assert.equal(available.service.description, notes.description);
  const [described] = connectionGroups([notes], [{ ...catalog, description: 'Catalog purpose.' }]);
  assert.equal(described.service.description, 'Catalog purpose.');
  const officialNotion: AppConnection = {
    slug: 'notion',
    name: 'Notion',
    status: 'disconnected',
    direct: true,
    triggersEnabled: false,
  };
  const legacyNotion: AppConnection = {
    slug: 'notion_mcp',
    name: 'Notion MCP',
    status: 'disconnected',
    connectionId: 'legacy-notion',
    reconnectRequired: true,
    triggersEnabled: false,
  };
  const [notionGroup] = connectionGroups(
    [officialNotion, legacyNotion],
    [{ slug: 'notion', name: 'Notion', status: 'disconnected', triggersEnabled: false }],
  );
  assert.equal(notionGroup.service.slug, 'notion');
  assert.equal(notionGroup.service.direct, true);
  assert.deepEqual(notionGroup.accounts, [legacyNotion]);
});

test(
  'managed app discovery keeps consent and underscore tool routing bound to owned accounts',
  { skip: !process.env.TEST_DATABASE_URL },
  async (t) => {
    const f = await appsFixture(t);
    f.provider.configurationId = 'current-configuration';
    const supported = f.provider.supportedServices!;
    f.provider.supportedServices = supported.filter((slug) => slug !== 'outlook');
    f.provider.listServices = async () => [];
    const unavailable = (await f.app.inject({ url: '/api/apps' })).json<AppConnection[]>();
    assert.equal(unavailable.find((entry) => entry.slug === 'outlook')?.status, 'not_configured');
    const blocked = await f.app.inject({ method: 'POST', url: '/api/apps/outlook/connect' });
    assert.equal(blocked.statusCode, 503, blocked.body);
    assert.equal(f.callbacks.length, 0);
    f.provider.supportedServices = supported;
    let catalogRequests = 0;
    f.provider.listServices = async () => {
      catalogRequests++;
      throw new Error('Synthetic catalog unavailable');
    };
    const personal = (await f.app.inject({ url: '/api/apps' })).json<AppConnection[]>();
    assert.equal(personal.find((entry) => entry.slug === 'outlook')?.status, 'disconnected');
    await f.connect('outlook');
    assert.equal(catalogRequests, 0);
    let failure: Error | undefined;
    f.provider.listServices = async () => {
      if (failure) throw failure;
      return [
        { slug: 'foo', name: 'Foo', description: '' },
        {
          slug: 'foo_mcp',
          name: 'Foo MCP',
          description: '',
          logoUrl: 'https://logos.composio.dev/api/foo_mcp',
          categories: ['Productivity', 'Meetings'],
        },
        {
          slug: 'gmail',
          name: 'gmail',
          description: '',
          logoUrl: 'https://logos.composio.dev/api/gmail',
          categories: ['Email'],
        },
        { slug: 'slack', name: 'Slack', description: '' },
        { slug: 'slackbot', name: 'Slackbot', description: '' },
        ...Array.from({ length: 31 }, (_, index) => ({
          slug: `catalog_${index}`,
          name: `Catalog item ${index}`,
          description: '',
        })),
      ];
    };
    const catalog = await f.app.inject({ url: '/api/apps/catalog' });
    assert.equal(catalog.statusCode, 200, catalog.body);
    const mail = catalog.json<AppConnection[]>().find((service) => service.slug === 'gmail')!;
    assert.equal(mail.name, integrationServices.gmail.name);
    assert.equal(mail.description, integrationServices.gmail.description);
    assert.equal(mail.logoUrl, 'https://logos.composio.dev/api/gmail');
    assert.deepEqual(mail.categories, ['Email']);
    const foo = await f.connect('foo');
    const consent = await f.app.inject({ method: 'POST', url: '/api/apps/foo_mcp/connect' });
    assert.equal(consent.statusCode, 200, consent.body);
    let callback = new URL(f.callbacks.at(-1)!);
    let accountId = [...f.accounts.keys()].at(-1)!;
    callback.searchParams.set('account', foo.accountId!);
    const mismatch = await f.app.inject({ url: `${callback.pathname}${callback.search}` });
    assert.equal(new URL(mismatch.headers.location!).searchParams.get('connection'), 'failed');
    callback.searchParams.set('account', accountId);
    const replay = await f.app.inject({ url: `${callback.pathname}${callback.search}` });
    assert.equal(new URL(replay.headers.location!).searchParams.get('connection'), 'expired');
    assert.equal(
      (await f.app.inject({ method: 'POST', url: '/api/apps/foo_mcp/connect' })).statusCode,
      200,
    );
    callback = new URL(f.callbacks.at(-1)!);
    accountId = [...f.accounts.keys()].at(-1)!;
    callback.searchParams.set('account', accountId);
    const completed = await f.app.inject({ url: `${callback.pathname}${callback.search}` });
    assert.equal(new URL(completed.headers.location!).searchParams.get('connection'), 'connected');
    const mcp = (await f.service.list()).find((entry) => entry.accountId === accountId)!;
    assert.equal(mcp.slug, 'foo_mcp');
    assert.equal(mcp.status, 'connected');
    const foreign = randomUUID();
    await f.pool.query(
      `INSERT INTO app_connections(id,owner_id,slug,account_id,provider_id,account_active,account_checked_at)
       VALUES($1,'foreign-owner','foo_mcp','foreign-account','fixture',true,now())`,
      [foreign],
    );
    await t.test('catalog discovery includes only matching owned saved account state', async () => {
      type SavedConnection = Pick<
        AppConnection,
        | 'connectionId'
        | 'status'
        | 'accountName'
        | 'accountEmail'
        | 'reconnectRequired'
        | 'canReconnect'
        | 'disconnectPending'
      >;
      const discover = async (query: string) =>
        JSON.parse(
          JSON.stringify(
            await f.service.manageConnections(
              'discover',
              undefined,
              undefined,
              undefined,
              undefined,
              query,
            ),
          ),
        ) as {
          services: Array<{ slug: string; connections: SavedConnection[] }>;
          total: number;
          hasMore: boolean;
        };
      const expected = (connection: AppConnection): SavedConnection => ({
        connectionId: connection.connectionId,
        status: 'connected',
        accountName: connection.accountName,
        reconnectRequired: false,
        canReconnect: false,
        disconnectPending: false,
      });
      const work = await f.connect('slack');
      const personal = await f.connect('slack');
      await f.pool.query('UPDATE app_connections SET account_email=$2 WHERE id=$1', [
        work.connectionId,
        'work@example.test',
      ]);
      const connected = await discover('slack');
      assert.deepEqual(
        connected.services.map(({ slug }) => slug),
        ['slack', 'slackbot'],
      );
      const workState = { ...expected(work), accountEmail: 'work@example.test' };
      assert.deepEqual(connected.services.find(({ slug }) => slug === 'slack')?.connections, [
        workState,
        expected(personal),
      ]);
      assert.deepEqual(connected.services.find(({ slug }) => slug === 'slackbot')?.connections, []);
      const neighbors = await discover('foo');
      assert.deepEqual(
        neighbors.services.map(({ slug, connections }) => ({ slug, connections })),
        [
          { slug: 'foo', connections: [expected(foo)] },
          { slug: 'foo_mcp', connections: [expected(mcp)] },
        ],
      );
      for (const [mutation, state] of [
        ['account_active=false', {}],
        ['account_active=true,revoked=true', { disconnectPending: true }],
        ["revoked=false,configuration_id='previous-configuration'", { reconnectRequired: true }],
      ] as const) {
        await f.pool.query(`UPDATE app_connections SET ${mutation} WHERE id=$1`, [
          personal.connectionId,
        ]);
        assert.deepEqual(
          (await discover('slack')).services.find(({ slug }) => slug === 'slack')?.connections,
          [workState, { ...expected(personal), status: 'disconnected', ...state }],
        );
      }
      const page = await discover('catalog item');
      assert.equal(page.total, 31);
      assert.equal(page.hasMore, true);
      assert.equal(page.services.length, 30);
      assert.ok(page.services.every(({ connections }) => connections.length === 0));
      assert.deepEqual(await discover('not-in-the-catalog'), {
        services: [],
        total: 0,
        hasMore: false,
      });
    });
    await assert.rejects(
      f.service.execute('local-development', 'FOO_MCP_LIST', { connectionId: foreign }),
      { statusCode: 404 },
    );
    await assert.rejects(
      f.service.execute('local-development', 'FOO_MCP_LIST', { connectionId: foo.connectionId }),
      { statusCode: 404 },
    );
    assert.equal(f.executed.length, 0);
    f.session.search = async () => ({
      tools: { FOO_LIST: {}, FOO_MCP_LIST: {} },
      suggestions: [],
    });
    const scoped = (await f.service.execute('local-development', 'SEARCH_TOOLS', {
      query: 'list',
      connectionId: foo.connectionId,
    })) as { tools: Record<string, unknown> };
    assert.deepEqual(Object.keys(scoped.tools), ['FOO_LIST']);
    failure = new Error('private-provider-detail');
    const failed = await f.app.inject({ url: '/api/apps/catalog' });
    assert.equal(failed.statusCode, 502);
    assert.doesNotMatch(failed.body, /private-provider-detail/);
    failure = Object.assign(new IntegrationConnectionError('permission', 'link'), {
      cause: new Error('synthetic-private-auth-response'),
    });
    const missingAuthAccess = await f.app.inject({ url: '/api/apps/catalog' });
    assert.equal(missingAuthAccess.statusCode, 503);
    assert.deepEqual(Object.keys(missingAuthAccess.json()), ['error']);
    assert.match(missingAuthAccess.json().error, /connection service/);
    assert.doesNotMatch(missingAuthAccess.body, /synthetic-private-auth-response/);
    failure = new IntegrationCatalogAccessDenied();
    const denied = await f.app.inject({ url: '/api/apps/catalog' });
    assert.equal(denied.statusCode, 403);
    const inventory = await f.app.inject({ url: '/api/apps' });
    assert.equal(inventory.statusCode, 200, inventory.body);
    assert.ok(
      inventory
        .json()
        .some((entry: { connectionId: string }) => entry.connectionId === mcp.connectionId),
    );
    assert.equal(
      inventory.json().some((entry: { connectionId: string }) => entry.connectionId === foreign),
      false,
    );
    await f.service.execute('local-development', 'FOO_MCP_LIST', {
      connectionId: mcp.connectionId,
    });
    assert.deepEqual(f.executed, [{ action: 'FOO_MCP_LIST', args: {}, accountId }]);
    const binding = await f.service.binding(mcp.connectionId!);
    assert.ok(binding);
    assert.equal(await f.service.binding(foreign), undefined);
    await f.pool.query('UPDATE app_connections SET account_id=$2 WHERE id=$1', [
      mcp.connectionId,
      'replacement-account',
    ]);
    await assert.rejects(
      f.service.execute(
        'local-development',
        'FOO_MCP_LIST',
        { connectionId: mcp.connectionId },
        undefined,
        AbortSignal.timeout(1000),
        binding,
      ),
      { statusCode: 409 },
    );
    assert.equal(f.executed.length, 1);
    await f.pool.query('UPDATE app_connections SET account_id=$2 WHERE id=$1', [
      mcp.connectionId,
      accountId,
    ]);
    await f.service.execute(
      'local-development',
      'FOO_MCP_LIST',
      { connectionId: mcp.connectionId },
      undefined,
      AbortSignal.timeout(1000),
      binding,
    );
    assert.equal(f.executed.length, 2);
    const reconnect = await f.app.inject({ method: 'POST', url: '/api/apps/gmail/connect' });
    assert.equal(reconnect.statusCode, 200, reconnect.body);
    const removed = await f.app.inject({
      method: 'POST',
      url: `/api/apps/foo_mcp/accounts/${mcp.connectionId}/disconnect`,
    });
    assert.equal(removed.statusCode, 200, removed.body);
    assert.equal(f.accounts.has(accountId), false);
  },
);

test(
  'connecting Gmail starts style learning in the background on that account only',
  { skip: !process.env.TEST_DATABASE_URL },
  async (t) => {
    const reads: string[] = [];
    let release: () => void = () => {};
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    t.after(() => release());
    const jobs: Array<Promise<unknown>> = [];
    const f = await appsFixture(t, undefined, {
      writingStyle: {
        enabled: async () => true,
        ready: () => true,
        learn: async (read) => {
          await held;
          jobs.push(read(AbortSignal.timeout(1000)));
        },
      },
    });
    f.provider.sentEmails = async (accountId) => {
      reads.push(`sent:${accountId}`);
      return [];
    };
    await f.connect('slack');
    const gmail = await f.connect('gmail');
    assert.deepEqual(reads, []);
    release();
    await delay(20);
    await Promise.all(jobs);
    assert.deepEqual(reads, [`sent:${gmail.accountId}`]);

    await t.test(
      'deferred sent reads and late results reject revoked and replaced account bindings',
      async (t) => {
        const readers: Array<(signal: AbortSignal) => Promise<unknown>> = [];
        const validators: Array<(signal: AbortSignal) => Promise<void>> = [];
        const accessed: string[] = [];
        const deferred = await appsFixture(t, undefined, {
          writingStyle: {
            enabled: async () => true,
            ready: () => true,
            learn: async (read, _stop, validate) => {
              assert.ok(validate);
              readers.push(read);
              validators.push(validate);
            },
          },
        });
        deferred.provider.sentEmails = async (accountId) => {
          accessed.push(accountId);
          return [];
        };
        const kept = await deferred.connect('gmail');
        const revoked = await deferred.connect('gmail');
        for (let attempt = 0; attempt < 200 && readers.length < 2; attempt++) await delay(10);
        assert.equal(readers.length, 2);
        assert.equal(validators.length, 2);
        deferred.provider.deleteAccount = async () => {
          throw new Error('Synthetic account deletion unavailable');
        };
        const disconnect = await deferred.app.inject({
          method: 'POST',
          url: `/api/apps/gmail/accounts/${revoked.connectionId}/disconnect`,
        });
        assert.ok(disconnect.statusCode >= 400);
        const inventory = await deferred.service.list('local-development', { refresh: false });
        assert.equal(
          inventory.find((account) => account.connectionId === revoked.connectionId)
            ?.disconnectPending,
          true,
        );
        assert.equal(
          inventory.find((account) => account.connectionId === kept.connectionId)?.status,
          'connected',
        );
        await assert.rejects(readers[1]!(AbortSignal.timeout(1000)), { statusCode: 404 });
        await assert.rejects(validators[1]!(AbortSignal.timeout(1000)), { statusCode: 404 });
        assert.deepEqual(accessed, []);
        await readers[0]!(AbortSignal.timeout(1000));
        await validators[0]!(AbortSignal.timeout(1000));
        assert.deepEqual(accessed, [kept.accountId]);
        await deferred.pool.query('UPDATE app_connections SET account_id=$2 WHERE id=$1', [
          kept.connectionId,
          'synthetic-replacement-account',
        ]);
        await assert.rejects(readers[0]!(AbortSignal.timeout(1000)), { statusCode: 404 });
        await assert.rejects(validators[0]!(AbortSignal.timeout(1000)), { statusCode: 404 });
        deferred.provider.configurationId = 'synthetic-replacement-configuration';
        await deferred.pool.query(
          'UPDATE app_connections SET account_id=$2,configuration_id=$3 WHERE id=$1',
          [kept.connectionId, kept.accountId, deferred.provider.configurationId],
        );
        await assert.rejects(readers[0]!(AbortSignal.timeout(1000)), { statusCode: 404 });
        await assert.rejects(validators[0]!(AbortSignal.timeout(1000)), { statusCode: 404 });
        assert.deepEqual(accessed, [kept.accountId]);
      },
    );
  },
);

test(
  "first-task inbox snippets read only the owner's active Gmail account",
  { skip: !process.env.TEST_DATABASE_URL },
  async (t) => {
    const f = await appsFixture(t);
    const reads: string[] = [];
    f.provider.inboxSnippets = async (accountId) => {
      reads.push(accountId);
      return [{ subject: 'Synthetic subject', snippet: 'Synthetic snippet' }];
    };
    await f.pool.query(
      "INSERT INTO app_connections(owner_id,slug,account_id) VALUES('synthetic-foreign-owner','gmail','foreign-gmail')",
    );
    const signal = AbortSignal.timeout(1000);
    assert.deepEqual(await f.service.inboxSnippets(signal), []);
    const gmail = await f.connect('gmail');
    assert.deepEqual(await f.service.inboxSnippets(signal), [
      { subject: 'Synthetic subject', snippet: 'Synthetic snippet' },
    ]);
    assert.deepEqual(reads, [gmail.accountId]);
  },
);

test('Composio first-task inbox snippets read at most fifteen subjects and snippets, never bodies', async (t) => {
  const requests: Array<{ path: string; parameters: unknown }> = [];
  const snippets = inboxPollFixture(
    t,
    (input) => {
      const path = input.endpoint.replace('https://gmail.googleapis.com/gmail/v1/users/me/', '');
      requests.push({ path, parameters: input.parameters });
      if (path === 'messages')
        return {
          status: 200,
          data: { messages: Array.from({ length: 15 }, (_, index) => ({ id: `m${index}` })) },
        };
      return {
        status: 200,
        data: {
          snippet: `Synthetic snippet ${path}`,
          payload: { headers: [{ name: 'Subject', value: `Synthetic ${path}` }] },
        },
      };
    },
    'inboxSnippets',
  );
  const read = await snippets('inbox-account', new AbortController().signal);
  assert.equal(read.length, 15);
  for (const request of requests.slice(1))
    assert.deepEqual(request.parameters, [
      { in: 'query', name: 'format', value: 'metadata' },
      { in: 'query', name: 'metadataHeaders', value: 'Subject' },
      { in: 'query', name: 'fields', value: 'snippet,payload/headers' },
    ]);
});

test('Composio inbox threads read the latest message from someone else and skip threads only you wrote', async (t) => {
  const requests: Array<{ path: string; parameters: unknown }> = [];
  const message = (id: string, from: string, labels: string[], text: string, at: number) => ({
    id,
    internalDate: String(at),
    labelIds: labels,
    payload: {
      mimeType: 'text/plain',
      headers: [
        { name: 'Subject', value: 'Synthetic venue contract' },
        { name: 'From', value: from },
      ],
      body: { data: Buffer.from(text).toString('base64url') },
    },
  });
  const threads: Record<string, unknown> = {
    'threads/t0': {
      messages: [
        message(
          'a',
          'Riley Synthetic <riley@example.test>',
          ['INBOX', 'STARRED'],
          'Can you sign?',
          1,
        ),
        message('b', 'Owner <owner@example.test>', ['SENT'], 'Signed.', 2),
      ],
    },
    'threads/t1': {
      messages: [
        message('c', 'riley@example.test', ['INBOX'], 'Any update?', 3),
        message('e', 'Owner <owner@example.test>', ['DRAFT'], 'Unsent synthetic draft', 5),
      ],
    },
    'threads/t2': { messages: [message('d', 'Owner <owner@example.test>', ['SENT'], 'Note.', 4)] },
  };
  const read = inboxPollFixture(
    t,
    (input) => {
      const path = input.endpoint.replace('https://gmail.googleapis.com/gmail/v1/users/me/', '');
      requests.push({ path, parameters: input.parameters });
      if (path === 'threads')
        return { status: 200, data: { threads: [{ id: 't0' }, { id: 't1' }, { id: 't2' }] } };
      return { status: 200, data: threads[path] };
    },
    'inboxThreads',
  );
  assert.deepEqual(await read('inbox-account', new AbortController().signal), [
    {
      subject: 'Synthetic venue contract',
      from: 'Riley Synthetic',
      received: new Date(2).toISOString(),
      messages: 2,
      waitingOnYou: false,
      flagged: true,
      automated: false,
      text: 'Can you sign?',
    },
    {
      subject: 'Synthetic venue contract',
      from: '',
      received: new Date(3).toISOString(),
      messages: 1,
      waitingOnYou: true,
      flagged: false,
      automated: false,
      text: 'Any update?',
    },
  ]);
  assert.deepEqual(requests[0].parameters, [
    {
      in: 'query',
      name: 'q',
      value: 'in:inbox newer_than:30d -category:promotions -category:social -category:forums',
    },
    { in: 'query', name: 'maxResults', value: 40 },
    { in: 'query', name: 'fields', value: 'threads/id' },
  ]);
  for (const request of requests.slice(1))
    assert.deepEqual(request.parameters, [{ in: 'query', name: 'format', value: 'full' }]);
});

test(
  'desktop OAuth callbacks use a public completion page and preserve owned turn continuation',
  { skip: !process.env.TEST_DATABASE_URL },
  async (t) => {
    const f = await appsFixture(t);
    const ownerId = 'local-development';
    const grantVault = await createAppGrantVault(f.pool, {
      ownerId,
      keyStore: { id: 'fixture', configured: true, getKey: async () => Buffer.alloc(32, 1) },
    });
    for (const desktop of [false, true]) {
      const resumed: string[] = [];
      const resumeConnection = async (turnId: string) => {
        resumed.push(turnId);
        return true;
      };
      let discoveredState = '';
      const discovered = await createDiscoveredConnections(f.pool, {
        ownerId,
        baseUrl: 'http://127.0.0.1:4310',
        grantVault,
        resumeConnection,
        transport: {
          validateEndpoint: async (endpoint) => endpoint,
          http: async () => ({ status: 200, body: null }),
          listTools: async () => ({ tools: [{ name: 'list_records', inputSchema: {} }] }),
          callTool: async () => ({}),
        },
        oauth: {
          begin: async (_endpoint, redirectUri, state) => {
            discoveredState = state;
            return { url: 'https://fixture.example/authorize', saved: { redirectUri } };
          },
          finish: async (_endpoint, saved, code) => {
            assert.equal(code, 'fixture-code');
            return {
              ...saved,
              tokens: { access_token: 'synthetic-oauth-token', token_type: 'Bearer' },
            };
          },
          refresh: async () => {
            throw new Error('No refresh is expected.');
          },
        },
      });
      const integrations = await createIntegrations(f.pool, {
        ownerId,
        provider: f.provider,
        baseUrl: 'http://127.0.0.1:4310',
        callbackReturnTo: desktop ? 'window' : undefined,
        discovered,
        resumeConnection,
        wake: async () => {},
      });
      const app = Fastify();
      t.after(() => app.close());
      const token = 'synthetic-access-token';
      registerLocalAccess(app, 4310, { key: token, desktop });
      integrations.registerRoutes(app);
      const headers = {
        host: '127.0.0.1:4310',
        ...(desktop ? { 'x-nod-desktop-token': token } : { cookie: `nod-access-4310=${token}` }),
      };
      const assertSurface = (location: string) =>
        assert.equal(new URL(location).searchParams.get('desktop'), desktop ? '1' : null);
      for (const fromChat of [false, true]) {
        const turn = fromChat ? { threadId: randomUUID(), turnId: randomUUID() } : undefined;
        const expectedOutcome = fromChat ? 'continued' : 'connected';
        await integrations.manageConnections('connect', 'gmail', turn, undefined, true);
        const callback = new URL(f.callbacks.at(-1)!);
        callback.searchParams.set('account', [...f.accounts.keys()].at(-1)!);
        callback.searchParams.set('desktop', desktop ? '0' : '1');
        const response = await app.inject({
          url: `${callback.pathname}${callback.search}`,
          headers: { host: headers.host },
        });
        assert.equal(response.statusCode, 302, response.body);
        assertSurface(response.headers.location!);
        assert.equal(
          new URL(response.headers.location!).searchParams.get('connection'),
          expectedOutcome,
        );
        const replay = await app.inject({
          url: `${callback.pathname}${callback.search}`,
          headers: { host: headers.host },
        });
        assert.equal(new URL(replay.headers.location!).searchParams.get('connection'), 'expired');
        assertSurface(replay.headers.location!);
        assert.deepEqual(resumed, turn ? [turn.turnId] : []);
        resumed.length = 0;

        const proposal = await discovered.propose(
          {
            service: `fixture-${desktop ? 'desktop' : 'web'}-${fromChat ? 'chat' : 'apps'}`,
            name: 'Fixture app',
            paths: [{ kind: 'mcp', endpoint: 'https://fixture.example/mcp', auth: 'oauth' }],
          },
          turn,
        );
        const id = new URL(proposal.url, 'http://localhost').searchParams.get('connect');
        const begin = await app.inject({
          method: 'POST',
          url: `/api/apps/discovery/${id}/authorize`,
          headers,
          payload: {},
        });
        assert.equal(begin.statusCode, 200, begin.body);
        const complete = await app.inject({
          url: `/api/apps/callback?state=${discoveredState}&code=fixture-code`,
          headers: { host: headers.host },
        });
        assert.equal(complete.statusCode, 302, complete.body);
        assertSurface(complete.headers.location!);
        assert.equal(
          new URL(complete.headers.location!).searchParams.get('connection'),
          expectedOutcome,
        );
        assert.deepEqual(resumed, turn ? [turn.turnId] : []);
        resumed.length = 0;

        discoveredState = '';
        const official = (await integrations.manageConnections(
          'connect',
          'notion',
          turn,
          undefined,
          true,
        )) as { url: string };
        assert.equal(discoveredState, '');
        const officialId = new URL(official.url, 'http://localhost').searchParams.get('connect');
        const officialBegin = await app.inject({
          method: 'POST',
          url: `/api/apps/discovery/${officialId}/authorize`,
          headers,
          payload: {},
        });
        assert.equal(officialBegin.statusCode, 200, officialBegin.body);
        assert.notEqual(discoveredState, '');
        const officialComplete = await app.inject({
          url: `/api/apps/callback?state=${discoveredState}&code=fixture-code`,
          headers: { host: headers.host },
        });
        assertSurface(officialComplete.headers.location!);
        assert.equal(
          new URL(officialComplete.headers.location!).searchParams.get('connection'),
          expectedOutcome,
        );
        assert.deepEqual(resumed, turn ? [turn.turnId] : []);
        resumed.length = 0;
      }
      const windowBegin = await app.inject({
        method: 'POST',
        url: '/api/apps/gmail/connect',
        headers,
        payload: { returnTo: 'window' },
      });
      assert.equal(windowBegin.statusCode, 200, windowBegin.body);
      const windowCallback = new URL(f.callbacks.at(-1)!);
      windowCallback.searchParams.set('account', [...f.accounts.keys()].at(-1)!);
      const windowComplete = await app.inject({
        url: `${windowCallback.pathname}${windowCallback.search}`,
        headers: { host: headers.host },
      });
      assert.equal(windowComplete.statusCode, 302, windowComplete.body);
      assert.equal(new URL(windowComplete.headers.location!).pathname, '/connected.html');
      assertSurface(windowComplete.headers.location!);
      assert.equal(
        (await app.inject({ url: '/api/apps', headers: { host: headers.host } })).statusCode,
        401,
      );
    }
    await t.test(
      'remote clients bind their return target to the exact owned attempt',
      async (t) => {
        const f = await appsFixture(t);
        const baseUrl = 'https://server.fixture.example';
        const headers = {
          host: new URL(baseUrl).host,
          authorization: 'Bearer synthetic-server-token',
        };
        const resumed: string[] = [];
        const resumeConnection = async (id: string) => {
          resumed.push(id);
          return true;
        };
        const inspectAccount = f.provider.inspectAccount;
        f.provider.inspectAccount = async (...args) => ({
          ...(await inspectAccount(...args)),
          accountEmail: 'owner@example.test',
          authConfigId: 'synthetic-auth-config',
        });
        f.provider.reconnectAccount = async (_owner, service, _account, callback) => ({
          ...(await f.session.authorize(service, callback)),
          authConfigId: 'synthetic-auth-config',
        });
        const discovered = await createDiscoveredConnections(f.pool, {
          ownerId,
          baseUrl,
          grantVault: await createAppGrantVault(f.pool, {
            ownerId,
            keyStore: { id: 'fixture', configured: true, getKey: async () => Buffer.alloc(32, 2) },
          }),
          resumeConnection,
          transport: {
            validateEndpoint: async (endpoint) => endpoint,
            http: async () => ({ status: 200, body: null }),
            listTools: async () => ({ tools: [{ name: 'list_records', inputSchema: {} }] }),
            callTool: async () => ({}),
          },
          oauth: {
            begin: async (_endpoint, redirectUri, state) => ({
              url: `https://consent.fixture.example/authorize?state=${state}`,
              saved: { redirectUri },
            }),
            finish: async (_endpoint, saved) => ({
              ...saved,
              tokens: { access_token: 'synthetic-access-token', token_type: 'Bearer' },
            }),
            refresh: async () => assert.fail('No refresh is expected.'),
          },
        });
        const service = await createIntegrations(f.pool, {
          ownerId,
          provider: f.provider,
          baseUrl,
          discovered,
          resumeConnection,
          wake: async () => {},
        });
        const app = Fastify();
        t.after(() => app.close());
        registerLocalAccess(app, 4310, {
          key: 'synthetic-server-token',
          origin: baseUrl,
          bearer: true,
        });
        service.registerRoutes(app);
        const post = (url: string, payload: Record<string, unknown>) =>
          app.inject({ method: 'POST', url, headers, payload });
        const complete = async (
          state: string,
          target: 'window' | 'desktop',
          slug: string,
          account?: string,
          outcome = 'connected',
        ) => {
          const response = await app.inject({
            url: `/api/apps/callback?state=${state}&code=synthetic-code${account ? `&account=${account}` : ''}&desktop=${target === 'desktop' ? '0' : '1'}&returnTo=https://foreign.example&redirect=https://foreign.example`,
            headers: { host: headers.host },
          });
          assert.equal(response.statusCode, 302, response.body);
          const destination = new URL(response.headers.location!);
          assert.equal(destination.origin, baseUrl);
          assert.equal(destination.pathname, '/connected.html');
          assert.equal(destination.searchParams.get('desktop'), target === 'desktop' ? '1' : null);
          assert.equal(destination.searchParams.get('attempt'), state);
          assert.equal(destination.searchParams.get('service'), slug);
          assert.equal(destination.searchParams.get('connection'), outcome);
        };
        for (const returnTo of ['window', 'desktop'] as const) {
          const initial = await post('/api/apps/gmail/connect', { returnTo });
          assert.equal(initial.statusCode, 200, initial.body);
          assert.match(initial.json().attempt, /^[A-Za-z0-9_-]{43}$/);
          const account = [...f.accounts.keys()].at(-1)!;
          await complete(initial.json().attempt, returnTo, 'gmail', account);
          const connectionId = (await service.list()).find(
            (row) => row.accountId === account,
          )!.connectionId;
          const reconnect = await post('/api/apps/gmail/connect', { returnTo, connectionId });
          assert.equal(reconnect.statusCode, 200, reconnect.body);
          await complete(
            reconnect.json().attempt,
            returnTo,
            'gmail',
            [...f.accounts.keys()].at(-1)!,
          );
          const first = await post('/api/apps/notion/connect', { returnTo });
          assert.equal(first.statusCode, 200, first.body);
          const restarted = await post('/api/apps/notion/connect', {
            returnTo,
            restartAttempt: first.json().attempt,
          });
          assert.equal(restarted.statusCode, 200, restarted.body);
          assert.notEqual(restarted.json().attempt, first.json().attempt);
          const stale = await app.inject({
            url: `/api/apps/callback?state=${first.json().attempt}&code=old&desktop=1`,
            headers: { host: headers.host },
          });
          assert.equal(new URL(stale.headers.location!).searchParams.get('connection'), 'expired');
          assert.equal(new URL(stale.headers.location!).searchParams.get('desktop'), null);
          await complete(restarted.json().attempt, returnTo, 'notion');
          const addressed = await post('/api/apps/n8n/connect', { returnTo });
          const proposalId = new URL(addressed.json().url, baseUrl).searchParams.get('connect');
          const instance = await post(`/api/apps/discovery/${proposalId}/instance`, {
            instanceUrl: `https://${returnTo}.n8n.example`,
            returnTo,
          });
          assert.equal(instance.statusCode, 200, instance.body);
          await complete(instance.json().attempt, returnTo, 'n8n');
        }
        const cancelled = await post('/api/apps/notion/connect', { returnTo: 'desktop' });
        assert.equal(cancelled.statusCode, 200, cancelled.body);
        const cancelledHash = createHash('sha256')
          .update(new URL(cancelled.json().url).href)
          .digest('hex');
        assert.equal(
          (await post('/api/apps/setup-cancel', { hash: cancelledHash })).statusCode,
          200,
        );
        assert.equal(
          (await post('/api/apps/setup-status', { hashes: [cancelledHash] })).json().apps[0]
            ?.available,
          false,
        );
        const late = await app.inject({
          url: `/api/apps/callback?state=${cancelled.json().attempt}&code=synthetic-code`,
          headers: { host: headers.host },
        });
        assert.equal(new URL(late.headers.location!).searchParams.get('connection'), 'expired');
        const turn = { threadId: randomUUID(), turnId: randomUUID() };
        const chat = (await service.manageConnections(
          'connect',
          'gmail',
          turn,
          undefined,
          true,
        )) as { url: string };
        const callback = new URL(f.callbacks.at(-1)!);
        const state = callback.searchParams.get('state')!;
        const account = [...f.accounts.keys()].at(-1)!;
        const hash = createHash('sha256').update(chat.url).digest('hex');
        assert.equal(
          (
            await app.inject({
              method: 'POST',
              url: '/api/apps/setup-return',
              headers: { host: headers.host },
              payload: { hash, returnTo: 'desktop' },
            })
          ).statusCode,
          401,
        );
        assert.equal(
          (await post('/api/apps/setup-return', { hash, returnTo: 'https://foreign.example' }))
            .statusCode,
          400,
        );
        for (const mutation of [
          "owner_id='foreign-owner'",
          'revoked=true',
          "callback_claim_id='claimed'",
          "callback_expires=now()-interval '1 minute'",
        ]) {
          await f.pool.query(`UPDATE app_connections SET ${mutation} WHERE setup_link_hash=$1`, [
            hash,
          ]);
          assert.equal(
            (await post('/api/apps/setup-return', { hash, returnTo: 'desktop' })).statusCode,
            409,
          );
          await f.pool.query(
            "UPDATE app_connections SET owner_id=$2,revoked=false,callback_claim_id=NULL,callback_expires=now()+interval '10 minutes' WHERE setup_link_hash=$1",
            [hash, ownerId],
          );
        }
        assert.equal(
          (await post('/api/apps/setup-return', { hash, returnTo: 'desktop' })).statusCode,
          200,
        );
        await complete(state, 'desktop', 'gmail', account, 'continued');
        assert.deepEqual(resumed, [turn.turnId]);
        assert.equal(
          (await post('/api/apps/setup-return', { hash, returnTo: 'desktop' })).statusCode,
          409,
        );
      },
    );
  },
);

test(
  'managed sign-in restarts replace only an unclaimed attempt and preserve a finishing callback',
  { skip: !process.env.TEST_DATABASE_URL },
  async (t) => {
    for (const outcome of ['unclaimed', 'connected', 'failed'])
      await t.test(outcome, async (t) => {
        const finishing = outcome !== 'unclaimed';
        const f = await appsFixture(t);
        const begin = (restartAttempt?: string) =>
          f.app.inject({
            method: 'POST',
            url: '/api/apps/gmail/connect',
            payload: { returnTo: 'window', restartAttempt },
          });
        const started = await begin();
        assert.equal(started.statusCode, 200, started.body);
        const attempt = started.json<{ url: string; attempt: string }>();
        const hash = createHash('sha256').update(attempt.url).digest('hex');
        const callback = new URL(f.callbacks.at(-1)!);
        callback.searchParams.set('account', [...f.accounts.keys()].at(-1)!);
        let release = () => {};
        let entered = () => {};
        const held = new Promise<void>((resolve) => {
          release = resolve;
        });
        const checking = new Promise<void>((resolve) => {
          entered = resolve;
        });
        t.after(release);
        const inspect = f.provider.inspectAccount;
        let inspections = 0;
        f.provider.inspectAccount = async (...args) => {
          inspections++;
          if (finishing) {
            entered();
            await held;
            if (outcome === 'failed') throw new Error('Synthetic account inspection failure.');
          }
          return inspect(...args);
        };
        const complete = () => f.app.inject({ url: callback.pathname + callback.search });
        const completion = finishing ? complete() : undefined;
        if (finishing) await checking;
        try {
          const restarted = await begin(attempt.attempt);
          assert.equal(restarted.statusCode, finishing ? 409 : 200, restarted.body);
          if (finishing) {
            const duplicateStart = await begin();
            assert.equal(duplicateStart.statusCode, 409, duplicateStart.body);
            assert.equal(f.callbacks.length, 1);
            const cancel = await f.app.inject({
              method: 'POST',
              url: '/api/apps/setup-cancel',
              payload: { hash },
            });
            assert.equal(cancel.statusCode, 200, cancel.body);
            const duplicate = await complete();
            assert.equal(
              new URL(duplicate.headers.location!).searchParams.get('connection'),
              'expired',
            );
            assert.equal(inspections, 1);
            release();
            assert.equal(
              new URL((await completion!).headers.location!).searchParams.get('connection'),
              outcome === 'connected' ? 'connected' : 'failed',
            );
            const again = await begin(attempt.attempt);
            assert.equal(again.statusCode, 409, again.body);
            const status = await f.app.inject({
              method: 'POST',
              url: '/api/apps/setup-status',
              payload: { hashes: [hash], pairingUrl: attempt.url },
            });
            assert.deepEqual(status.json().completed, outcome === 'connected' ? [hash] : []);
            if (outcome === 'failed') assert.equal(status.json().apps[0].available, false);
          } else {
            const stale = await complete();
            assert.equal(
              new URL(stale.headers.location!).searchParams.get('connection'),
              'expired',
            );
            assert.equal(inspections, 0);
            const wrong = await begin(attempt.attempt);
            assert.equal(wrong.statusCode, 409, wrong.body);
          }
          assert.equal(
            (await f.pool.query('SELECT count(*)::int AS n FROM app_connections')).rows[0].n,
            outcome === 'failed' ? 0 : 1,
          );
        } finally {
          release();
        }
      });
  },
);

test(
  'a settled OAuth callback survives a delayed restart refusal',
  { skip: !process.env.TEST_DATABASE_URL, timeout: 30_000 },
  async (t) => {
    const dom = new JSDOM('<!doctype html><div id="root"></div>', {
      url: 'http://localhost:4310/',
      pretendToBeVisual: true,
    });
    const channels: Array<{ onmessage?: (event: { data: Record<string, string> }) => void }> = [];
    const globals = {
      window: dom.window,
      document: dom.window.document,
      navigator: dom.window.navigator,
      HTMLElement: dom.window.HTMLElement,
      IS_REACT_ACT_ENVIRONMENT: true,
      BroadcastChannel: class {
        onmessage?: (event: { data: Record<string, string> }) => void;
        constructor() {
          channels.push(this);
        }
        close() {}
      },
      fetch: globalThis.fetch,
    };
    const originals = new Map(
      Object.keys(globals).map((key) => [key, Object.getOwnPropertyDescriptor(globalThis, key)]),
    );
    for (const [key, value] of Object.entries(globals))
      Object.defineProperty(globalThis, key, { configurable: true, writable: true, value });
    dom.window.open = () =>
      ({ closed: false, close() {}, location: { href: '' } }) as unknown as Window;
    const { act, createElement } = await import('react');
    const { createRoot } = await import('react-dom/client');
    const { useAppSignIn } = await import('../src/web/hooks/use-app-sign-in.ts');
    try {
      for (const outcome of ['connected', 'failed', 'opener-failed'])
        await t.test(outcome, async (t) => {
          const f = await appsFixture(t);
          const openerFailure = new Error('Synthetic desktop opener failure.');
          let opened = 0;
          if (outcome === 'opener-failed')
            Object.defineProperty(dom.window, 'nodDesktop', {
              configurable: true,
              value: {
                async openExternal() {
                  if (++opened === 2) throw openerFailure;
                },
              },
            });
          let release = () => {};
          let entered = () => {};
          let respond = () => {};
          let received = (_status: number) => {};
          let statusReady = () => {};
          const statusRead = new Promise<void>((resolve) => {
            statusReady = resolve;
          });
          const held = new Promise<void>((resolve) => {
            release = resolve;
          });
          const checking = new Promise<void>((resolve) => {
            entered = resolve;
          });
          const responseHeld = new Promise<void>((resolve) => {
            respond = resolve;
          });
          const responseReady = new Promise<number>((resolve) => {
            received = resolve;
          });
          const inspect = f.provider.inspectAccount;
          f.provider.inspectAccount = async (...args) => {
            entered();
            await held;
            if (outcome === 'failed') throw new Error('Synthetic provider failure.');
            return inspect(...args);
          };
          globalThis.fetch = async (path, options = {}) => {
            const response = await f.app.inject({
              method: (options.method ?? 'GET') as 'GET' | 'POST',
              url: String(path),
              ...(options.body
                ? { payload: String(options.body), headers: { 'content-type': 'application/json' } }
                : {}),
            });
            if (String(path) === '/api/apps/setup-status') statusReady();
            if (
              String(path) === '/api/apps/gmail/connect' &&
              outcome !== 'opener-failed' &&
              JSON.parse(String(options.body)).restartAttempt
            ) {
              received(response.statusCode);
              await responseHeld;
            }
            return new Response(response.body, { status: response.statusCode });
          };
          let signIn!: ReturnType<typeof useAppSignIn>;
          let settled = 0;
          function SignIn() {
            signIn = useAppSignIn({
              entry: 'onboarding',
              name: (service) => service,
              onSettled() {
                settled++;
              },
            });
            return null;
          }
          const root = createRoot(dom.window.document.getElementById('root')!);
          let restarting: Promise<void> | undefined;
          try {
            await act(async () => root.render(createElement(SignIn)));
            await act(async () => {
              await signIn.connect({ service: 'gmail' });
              await statusRead;
            });
            if (outcome === 'opener-failed') {
              await act(async () => signIn.connect({ service: 'gmail' }));
              assert.equal(opened, 2);
              assert.equal(f.callbacks.length, 2);
              assert.equal(signIn.error, openerFailure.message);
              assert.equal(signIn.signInUrl, undefined);
              assert.equal(signIn.pending, undefined);
              assert.equal(signIn.completed, undefined);
              return;
            }
            const callback = new URL(f.callbacks.at(-1)!);
            callback.searchParams.set('account', [...f.accounts.keys()].at(-1)!);
            const completion = f.app.inject({ url: callback.pathname + callback.search });
            await checking;
            await act(async () => {
              restarting = signIn.connect({ service: 'gmail' });
              assert.equal(await responseReady, 409);
            });
            release();
            const returned = new URL((await completion).headers.location!);
            assert.equal(returned.searchParams.get('connection'), outcome);
            await act(async () => {
              channels.at(-1)!.onmessage?.({
                data: {
                  connection: outcome,
                  service: 'gmail',
                  attempt: callback.searchParams.get('state')!,
                },
              });
            });
            const completed = signIn.completed;
            const error = signIn.error;
            assert.equal(Boolean(completed), outcome === 'connected');
            assert.equal(settled, 1);
            await act(async () => {
              respond();
              await restarting;
            });
            assert.equal(signIn.completed, completed);
            assert.equal(signIn.error, error);
            assert.equal(signIn.pending, undefined);
            assert.equal(settled, 1);
            assert.equal(f.callbacks.length, 1);
          } finally {
            release();
            respond();
            await act(async () => {
              await restarting;
              root.unmount();
            });
            Reflect.deleteProperty(dom.window, 'nodDesktop');
          }
        });
    } finally {
      dom.window.close();
      for (const [key, value] of originals)
        if (value) Object.defineProperty(globalThis, key, value);
        else Reflect.deleteProperty(globalThis, key);
    }
  },
);

test(
  'an executing callback stays protected past expiry and an expired restart claim can be replaced without replay',
  { skip: !process.env.TEST_DATABASE_URL },
  async (t) => {
    await t.test('executing callback', async (t) => {
      const f = await appsFixture(t);
      const begin = () =>
        f.app.inject({
          method: 'POST',
          url: '/api/apps/gmail/connect',
          payload: { returnTo: 'window' },
        });
      const first = await begin();
      const callback = new URL(f.callbacks.at(-1)!);
      callback.searchParams.set('account', [...f.accounts.keys()].at(-1)!);
      let release = () => {};
      let entered = () => {};
      const held = new Promise<void>((resolve) => {
        release = resolve;
      });
      const checking = new Promise<void>((resolve) => {
        entered = resolve;
      });
      const inspect = f.provider.inspectAccount;
      f.provider.inspectAccount = async (...args) => {
        entered();
        await held;
        return inspect(...args);
      };
      const completion = f.app.inject({ url: callback.pathname + callback.search });
      await checking;
      try {
        await f.pool.query("UPDATE app_connections SET callback_expires=now()-interval '1 minute'");
        const blocked = await begin();
        assert.equal(blocked.statusCode, 409, blocked.body);
        assert.equal(f.callbacks.length, 1);
        assert.equal(
          (
            await f.pool.query(
              'SELECT count(*)::int AS n FROM app_connections WHERE callback_claim_id IS NOT NULL',
            )
          ).rows[0].n,
          1,
        );
        release();
        assert.equal(
          new URL((await completion).headers.location!).searchParams.get('connection'),
          'failed',
        );
        const fresh = await begin();
        assert.equal(fresh.statusCode, 200, fresh.body);
        const old = await f.app.inject({ url: callback.pathname + callback.search });
        assert.equal(new URL(old.headers.location!).searchParams.get('connection'), 'expired');
        assert.equal(f.callbacks.length, 2);
        assert.notEqual(fresh.json().attempt, first.json().attempt);
      } finally {
        release();
      }
    });
    await t.test('new-account claim after restart', async (t) => {
      const f = await appsFixture(t);
      const first = await f.app.inject({
        method: 'POST',
        url: '/api/apps/gmail/connect',
        payload: { returnTo: 'window' },
      });
      const attempt = first.json<{ attempt: string }>().attempt;
      const callback = new URL(f.callbacks.at(-1)!);
      callback.searchParams.set('account', [...f.accounts.keys()].at(-1)!);
      await f.pool.query(
        "UPDATE app_connections SET callback_claim_id='synthetic-stopped-process'",
      );
      const service = await createIntegrations(f.pool, {
        ownerId: 'local-development',
        provider: f.provider,
        baseUrl: 'http://localhost:4310',
        wake: async () => {},
      });
      const app = Fastify();
      service.registerRoutes(app);
      t.after(() => app.close());
      const retry = () =>
        app.inject({
          method: 'POST',
          url: '/api/apps/gmail/connect',
          payload: { returnTo: 'window', restartAttempt: attempt },
        });
      assert.equal((await retry()).statusCode, 409);
      const now = Date.now();
      const clock = t.mock.method(Date, 'now', () => now + 20 * 60_000);
      try {
        assert.equal((await retry()).statusCode, 409);
        assert.equal(f.callbacks.length, 1);
        assert.equal(
          (await f.pool.query('SELECT callback_hash FROM app_connections')).rows[0].callback_hash,
          createHash('sha256').update(attempt).digest('hex'),
        );
      } finally {
        clock.mock.restore();
      }
      await f.pool.query("UPDATE app_connections SET callback_expires=now()-interval '1 minute'");
      const fresh = await retry();
      assert.equal(fresh.statusCode, 200, fresh.body);
      assert.notEqual(fresh.json().attempt, attempt);
      const stale = await app.inject({ url: callback.pathname + callback.search });
      assert.equal(new URL(stale.headers.location!).searchParams.get('connection'), 'expired');
      assert.equal(
        (await f.pool.query('SELECT count(*)::int AS n FROM app_connections')).rows[0].n,
        1,
      );
    });
    await t.test('saved-account claim after restart', async (t) => {
      const f = await managedReconnectFixture(t);
      const started = await f.reconnect();
      assert.equal(started.statusCode, 200, started.body);
      const first = f.links.at(-1)!;
      await f.pool.query(
        "UPDATE app_connections SET callback_claim_id='synthetic-stopped-process' WHERE id=$1",
        [f.connectionId],
      );
      const service = await createIntegrations(f.pool, {
        ownerId: f.ownerId,
        provider: f.provider,
        baseUrl: 'http://localhost:4310',
        wake: async () => {},
      });
      const app = Fastify();
      service.registerRoutes(app);
      t.after(() => app.close());
      const retry = () =>
        app.inject({
          method: 'POST',
          url: '/api/apps/gmail/connect',
          payload: { connectionId: f.connectionId },
        });
      assert.equal((await retry()).statusCode, 409);
      assert.equal(f.links.length, 1);
      const now = Date.now();
      const clock = t.mock.method(Date, 'now', () => now + 20 * 60_000);
      try {
        assert.equal((await retry()).statusCode, 409);
        assert.equal(f.links.length, 1);
        assert.equal((await f.row()).callback_claim_id, 'synthetic-stopped-process');
      } finally {
        clock.mock.restore();
      }
      await f.pool.query(
        "UPDATE app_connections SET callback_expires=now()-interval '1 minute' WHERE id=$1",
        [f.connectionId],
      );
      const fresh = await retry();
      assert.equal(fresh.statusCode, 200, fresh.body);
      assert.equal(f.links.length, 2);
      assert.equal((await f.row()).account_id, 'old-account');
      assert.equal(await f.complete(first), 'expired');
      assert.equal(f.accounts.has('old-account'), true);
      assert.equal(f.removed.includes(first.accountId), true);
    });
  },
);

test(
  'abandoned app sign-ins can no longer complete',
  { skip: !process.env.TEST_DATABASE_URL },
  async (t) => {
    const f = await appsFixture(t);
    const live = new Set<string>();
    f.provider.ownsConnectionUrl = (url) => live.has(url);
    const begin = async () => {
      const response = await f.app.inject({ method: 'POST', url: '/api/apps/slack/connect' });
      assert.equal(response.statusCode, 200, response.body);
      const url = response.json().url as string;
      live.add(url);
      const callback = new URL(f.callbacks.at(-1)!);
      const account = [...f.accounts.keys()].at(-1)!;
      callback.searchParams.set('account', account);
      return {
        url,
        account,
        hash: createHash('sha256').update(url).digest('hex'),
        callback: `${callback.pathname}${callback.search}`,
      };
    };
    const available = async (attempt: Awaited<ReturnType<typeof begin>>) =>
      (
        await f.app.inject({
          method: 'POST',
          url: '/api/apps/setup-status',
          payload: { hashes: [attempt.hash], pairingUrl: attempt.url },
        })
      ).json().apps[0]?.available;
    const finish = async (attempt: Awaited<ReturnType<typeof begin>>) =>
      (await f.app.inject({ url: attempt.callback })).headers.location;

    const cancelled = await begin();
    assert.equal(await available(cancelled), true);
    const cancel = await f.app.inject({
      method: 'POST',
      url: '/api/apps/setup-cancel',
      payload: { hash: cancelled.hash },
    });
    assert.equal(cancel.statusCode, 200, cancel.body);
    assert.equal(await available(cancelled), false);
    assert.equal(await finish(cancelled), 'http://localhost:4310/apps?connection=expired');

    const closed = await begin();
    live.delete(closed.url);
    assert.equal(await available(closed), false);
    assert.equal(await finish(closed), 'http://localhost:4310/apps?connection=expired');

    assert.ok(f.removed.includes(cancelled.account) && f.removed.includes(closed.account));
    assert.equal(
      (await f.pool.query("SELECT 1 FROM app_connections WHERE slug='slack'")).rowCount,
      0,
    );

    const completing = await begin();
    await f.pool.query(
      "UPDATE app_connections SET callback_claim_id='synthetic-claim' WHERE setup_link_hash=$1",
      [completing.hash],
    );
    live.delete(completing.url);
    assert.equal(await available(completing), true);
    assert.equal(
      (
        await f.pool.query('SELECT 1 FROM app_connections WHERE setup_link_hash=$1', [
          completing.hash,
        ])
      ).rowCount,
      1,
    );
  },
);

test(
  'native app sign-ins survive browser key metadata and preserve owned callback completion',
  { skip: !process.env.TEST_DATABASE_URL, timeout: 30_000 },
  async (t) => {
    const f = await appsFixture(t);
    const root = await mkdtemp(join(tmpdir(), 'nod-native-sign-in-'));
    const browser = createIntegrationBrowser();
    t.after(async () => {
      await browser.close();
      await rm(root, { recursive: true, force: true });
    });
    const starts = new Map<string, { challenge: string; toolkit: string }>();
    let completions = 0;
    const proxy = createComposioProxy({
      dataRoot: root,
      ownerId: 'local-development',
      keyStore: installationKeyStore,
      checkpoint: createIntegrationIdentityCheckpoint(f.pool, 'local-development'),
      browser,
      url: 'https://proxy.example.test',
      request: async (input, init) => {
        const request = new Request(input, init);
        const path = new URL(request.url).pathname;
        const body = await request.json();
        if (path === '/v2/access/enroll')
          return Response.json({ state: 'enabled', userId: proxy.userId });
        if (path === '/v2/connect/start') {
          assert.deepEqual(Object.keys(body.browserKey).sort(), ['crv', 'kty', 'x', 'y']);
          assert.equal(body.browserKey.kty, 'EC');
          assert.equal(body.browserKey.crv, 'P-256');
          starts.set(body.transactionId, body);
          return Response.json({
            redirectUrl: `https://proxy.example.test/v2/connect/pair?ticket=${body.transactionId}`,
            transactionId: body.transactionId,
          });
        }
        if (path === '/v2/connect/status')
          return Response.json({ pairingConfirmed: starts.has(body.ticket) });
        assert.equal(path, '/v2/connect/complete');
        const started = starts.get(body.transactionId)!;
        assert.ok(started);
        assert.equal(body.challenge, started.challenge);
        assert.equal(body.completionToken, 'synthetic-completion');
        const accountId = `synthetic_${body.transactionId}`;
        f.accounts.set(accountId, started.toolkit);
        completions++;
        return Response.json({
          connectedAccountId: accountId,
          toolkit: started.toolkit,
          status: 'ACTIVE',
        });
      },
    });
    await proxy.initialize();
    const managed = createComposioProvider({ proxy });
    f.provider.supportedServices = [...integrationServiceIds, 'github'];
    f.provider.configurationId = managed.configurationId;
    f.provider.ownsConnectionUrl = managed.ownsConnectionUrl;
    f.provider.connectionStatus = managed.connectionStatus;
    f.provider.parseCallback = managed.parseCallback;
    f.provider.authorize = async (owner, service, callback) => {
      f.callbacks.push(callback);
      return managed.authorize!(owner, service, callback);
    };
    const key = generateKeyPairSync('ec', { namedCurve: 'prime256v1' }).publicKey.export({
      format: 'jwk',
    });
    const begin = async (service: IntegrationService) => {
      const response = await f.app.inject({ method: 'POST', url: `/api/apps/${service}/connect` });
      assert.equal(response.statusCode, 200, response.body);
      const url = response.json().url as string;
      const callback = new URL(f.callbacks.at(-1)!);
      callback.searchParams.set('completion_token', 'synthetic-completion');
      return {
        url,
        hash: createHash('sha256').update(url).digest('hex'),
        callback: `${callback.pathname}${callback.search}`,
      };
    };
    const status = async (attempt: Awaited<ReturnType<typeof begin>>) => {
      const response = await f.app.inject({
        method: 'POST',
        url: '/api/apps/setup-status',
        payload: { hashes: [attempt.hash], pairingUrl: attempt.url },
      });
      assert.equal(response.statusCode, 200, response.body);
      return response.json();
    };
    const start = async (
      attempt: Awaited<ReturnType<typeof begin>>,
      browserKey: Record<string, unknown>,
    ) => {
      assert.equal((await status(attempt)).apps[0].available, true);
      const html = await (await fetch(attempt.url)).text();
      const bridgeKey = JSON.parse(html.match(/const bridgeKey=("[^"]+");/)![1]);
      const response = await fetch(`${new URL(attempt.url).origin}/start`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          origin: new URL(attempt.url).origin,
          'x-nod-bridge': bridgeKey,
        },
        body: JSON.stringify({ browserKey }),
      });
      await response.text();
      const setup = await status(attempt);
      const returned = await f.app.inject({
        method: 'POST',
        url: '/api/apps/setup-return',
        payload: { hash: attempt.hash, returnTo: 'desktop' },
      });
      return {
        startStatus: response.status,
        available: setup.apps[0]?.available,
        returnStatus: returned.statusCode,
      };
    };
    const outcome = async (attempt: Awaited<ReturnType<typeof begin>>) =>
      new URL((await f.app.inject({ url: attempt.callback })).headers.location!).searchParams.get(
        'connection',
      );
    const complete = async (attempt: Awaited<ReturnType<typeof begin>>) => {
      const before = completions;
      assert.equal(await outcome(attempt), 'connected');
      assert.equal(completions, before + 1);
      assert.deepEqual(await status(attempt), { completed: [attempt.hash], apps: [] });
      assert.equal(await outcome(attempt), 'expired');
      assert.equal(completions, before + 1);
    };
    for (const [service, metadata] of [
      ['github', { alg: 'ES256', ext: true, key_ops: ['verify'] }],
      ['gmail', { use: 'sig', kid: 'synthetic-public-key' }],
      ['github', {}],
    ] as const) {
      await t.test(
        `${service} with ${Object.keys(metadata).join(',') || 'core key fields'}`,
        async () => {
          const attempt = await begin(service);
          assert.deepEqual(await start(attempt, { ...key, ...metadata }), {
            startStatus: 200,
            available: true,
            returnStatus: 200,
          });
          await complete(attempt);
        },
      );
    }
    await t.test(
      'polling while account verification finishes preserves the claimed callback',
      async () => {
        const attempt = await begin('github');
        assert.equal((await start(attempt, key)).startStatus, 200);
        let inspecting = () => {};
        let release = () => {};
        const inspected = new Promise<void>((resolve) => {
          inspecting = resolve;
        });
        const gate = new Promise<void>((resolve) => {
          release = resolve;
        });
        const inspect = f.provider.inspectAccount;
        f.provider.inspectAccount = async (...args) => {
          inspecting();
          await gate;
          return inspect(...args);
        };
        const finishing = outcome(attempt);
        try {
          await inspected;
          assert.equal(browser.owns(attempt.url), false);
          assert.equal((await status(attempt)).apps[0].available, true);
          release();
          assert.equal(await finishing, 'connected');
        } finally {
          release();
          f.provider.inspectAccount = inspect;
          await finishing;
        }
        assert.deepEqual(await status(attempt), { completed: [attempt.hash], apps: [] });
      },
    );
    await t.test('invalid keys expire their attempt and a fresh retry succeeds', async () => {
      for (const invalid of [{ kty: 'RSA' }, { crv: 'P-384' }]) {
        const attempt = await begin('github');
        const before = completions;
        assert.deepEqual(await start(attempt, { ...key, ...invalid }), {
          startStatus: 400,
          available: false,
          returnStatus: 409,
        });
        assert.equal(await outcome(attempt), 'expired');
        assert.equal(completions, before);
      }
      const retry = await begin('github');
      assert.equal((await start(retry, { ...key, alg: 'ES256' })).startStatus, 200);
      await complete(retry);
    });
  },
);

test(
  'discovered desktop OAuth reports durable completion and retries without replacing pending attempts',
  { skip: !process.env.TEST_DATABASE_URL },
  async (t) => {
    const f = await appsFixture(t, { max: 1, connectionTimeoutMillis: 1000 });
    const ownerId = 'local-development';
    const grantVault = await createAppGrantVault(f.pool, {
      ownerId,
      keyStore: { id: 'fixture', configured: true, getKey: async () => Buffer.alloc(32, 1) },
    });
    const states: string[] = [];
    const issuer = 'https://auth.fixture.example';
    let issSupported = true;
    let finished = 0;
    let finishStarted: () => void = () => {};
    let finishRelease: () => void = () => {};
    let finishing = new Promise<void>((resolve) => {
      finishStarted = resolve;
    });
    let finishGate = new Promise<void>((resolve) => {
      finishRelease = resolve;
    });
    t.after(() => finishRelease());
    const options = {
      ownerId,
      baseUrl: 'http://127.0.0.1:4310',
      grantVault,
      transport: {
        validateEndpoint: async (endpoint: string) => endpoint,
        http: async () => ({ status: 200, body: null }),
        listTools: async () => ({ tools: [{ name: 'list_records', inputSchema: {} }] }),
        callTool: async () => ({}),
      },
      oauth: {
        begin: async (_endpoint: string, redirectUri: string, state: string) => {
          states.push(state);
          return {
            url: `https://fixture.example/authorize?state=${state}`,
            saved: {
              redirectUri,
              verifier: 'synthetic-private-verifier',
              discovery: {
                authorizationServerUrl: issuer,
                authorizationServerMetadata: {
                  issuer,
                  authorization_endpoint: `${issuer}/authorize`,
                  token_endpoint: `${issuer}/token`,
                  response_types_supported: ['code'],
                  authorization_response_iss_parameter_supported: issSupported,
                },
              },
            },
          };
        },
        finish: async (_endpoint: string, saved: DiscoveredOAuthState, code: string) => {
          finished++;
          if (code === 'fail') throw new Error('Synthetic exchange failure');
          if (code === 'hold') {
            finishStarted();
            await finishGate;
          }
          return {
            ...saved,
            tokens: { access_token: 'synthetic-private-token', token_type: 'Bearer' },
          };
        },
        refresh: async () => {
          throw new Error('No refresh is expected.');
        },
      },
    };
    const discovered = await createDiscoveredConnections(f.pool, options);
    const service = await createIntegrations(f.pool, {
      ownerId,
      provider: f.provider,
      baseUrl: options.baseUrl,
      callbackReturnTo: 'window',
      discovered,
      wake: async () => {},
    });
    const app = Fastify();
    t.after(() => app.close());
    registerLocalAccess(app, 4310, { key: 'synthetic-desktop-token', desktop: true });
    service.registerRoutes(app);
    const headers = {
      host: '127.0.0.1:4310',
      'x-nod-desktop-token': 'synthetic-desktop-token',
    };
    const proposed = await discovered.propose({
      service: 'fixture-desktop',
      name: 'Fixture app',
      paths: [{ kind: 'mcp', endpoint: 'https://fixture.example/mcp', auth: 'oauth' }],
    });
    const id = new URL(proposed.url, options.baseUrl).searchParams.get('connect');
    const path = `/api/apps/discovery/${id}`;
    const setupHash = createHash('sha256').update(proposed.url).digest('hex');
    const setupStatus = async () => {
      const response = await app.inject({
        method: 'POST',
        url: '/api/apps/setup-status',
        headers,
        payload: { hashes: [setupHash], connectionIds: [id] },
      });
      assert.equal(response.statusCode, 200, response.body);
      return response.json();
    };
    const authorizations = new Map<string, { url: string; attempt: string }>();
    const authorize = async (payload = {}) => {
      const response = await app.inject({
        method: 'POST',
        url: `${path}/authorize`,
        headers,
        payload,
      });
      if (response.statusCode === 200)
        authorizations.set(
          new URL(response.json().url).searchParams.get('state')!,
          response.json(),
        );
      return response;
    };
    const rawStatus = async (url: string) => {
      const hash = createHash('sha256').update(url).digest('hex');
      const response = await app.inject({
        method: 'POST',
        url: '/api/apps/setup-status',
        headers,
        payload: { hashes: [hash] },
      });
      assert.equal(response.statusCode, 200, response.body);
      return response.json();
    };
    const status = async () => {
      const response = await app.inject({ url: path, headers });
      assert.equal(response.statusCode, 200, response.body);
      assert.ok(!response.body.includes('synthetic-private'));
      return response.json();
    };
    const callback = async (state: string, result: string, iss = issuer) => {
      const response = await app.inject({
        url: `/api/apps/callback?state=${state}&${result}${iss ? `&iss=${encodeURIComponent(iss)}` : ''}`,
        headers: { host: headers.host },
      });
      assert.equal(response.statusCode, 302, response.body);
      const destination = new URL(response.headers.location!);
      assert.equal(destination.pathname, '/connected.html');
      assert.equal(destination.searchParams.get('desktop'), '1');
      const outcome = destination.searchParams.get('connection');
      if (outcome !== 'expired')
        assert.equal(destination.searchParams.get('attempt'), authorizations.get(state)?.attempt);
      return outcome;
    };
    const first = await authorize();
    assert.equal(first.statusCode, 200, first.body);
    assert.equal(typeof first.json().attempt, 'string');
    assert.ok(first.json().attempt.length >= 32);
    assert.equal((await rawStatus(first.json().url)).apps[0].available, true);
    assert.deepEqual(await setupStatus(), {
      completed: [],
      apps: [{ hash: setupHash, slug: 'fixture-desktop', name: 'Fixture app' }],
    });
    assert.deepEqual((await authorize()).json(), first.json());
    assert.equal(states.length, 1);
    assert.equal((await status()).oauthStatus, 'pending');
    assert.equal((await status()).authorizationUrl, first.json().url);
    assert.equal((await status()).attempt, first.json().attempt);
    const recovered = Fastify();
    t.after(() => recovered.close());
    (await createDiscoveredConnections(f.pool, options)).registerRoutes(recovered);
    assert.equal((await recovered.inject(path)).json().authorizationUrl, first.json().url);
    const foreign = Fastify();
    t.after(() => foreign.close());
    (
      await createDiscoveredConnections(f.pool, { ...options, ownerId: 'foreign-owner' })
    ).registerRoutes(foreign);
    assert.equal((await foreign.inject(path)).statusCode, 404);
    assert.equal(
      (await app.inject({ url: path, headers: { host: headers.host } })).statusCode,
      401,
    );
    assert.equal(await callback(states[0], 'error=access_denied'), 'cancelled');
    assert.equal((await status()).oauthStatus, 'cancelled');
    assert.equal((await rawStatus(first.json().url)).apps[0].available, false);
    assert.notEqual((await setupStatus()).apps[0].available, false);
    const firstHash = createHash('sha256').update(first.json().url).digest('hex');
    const mixed = await app.inject({
      method: 'POST',
      url: '/api/apps/setup-status',
      headers,
      payload: { hashes: [setupHash, firstHash], connectionIds: [id] },
    });
    assert.equal(mixed.statusCode, 200, mixed.body);
    assert.deepEqual(mixed.json().completed, []);
    assert.equal(mixed.json().apps.length, 2);
    assert.equal(
      mixed.json().apps.find((row: { hash: string }) => row.hash === firstHash).available,
      false,
    );
    assert.equal(
      mixed.json().apps.find((row: { hash: string }) => row.hash === setupHash).available,
      undefined,
    );

    assert.equal((await status()).authorizationUrl, undefined);
    assert.equal((await authorize()).statusCode, 200);
    assert.equal(states.length, 2);
    assert.notEqual(authorizations.get(states[1])?.attempt, first.json().attempt);
    assert.equal(await callback(states[0], 'error=access_denied'), 'expired');
    assert.equal((await status()).oauthStatus, 'pending');
    assert.equal(await callback(states[1], 'code=fail'), 'failed');
    assert.equal((await status()).oauthStatus, 'failed');
    assert.equal((await rawStatus(authorizations.get(states[1])!.url)).apps[0].available, false);
    assert.notEqual((await setupStatus()).apps[0].available, false);
    assert.equal((await authorize()).statusCode, 200);
    assert.equal(states.length, 3);
    assert.equal(await callback(states[1], 'code=fixture-code'), 'expired');
    assert.equal((await status()).oauthStatus, 'pending');
    const interrupted = callback(states[2], 'code=hold');
    await finishing;
    assert.equal((await rawStatus(authorizations.get(states[2])!.url)).apps[0].available, true);
    assert.equal((await authorize()).statusCode, 409);
    assert.equal((await authorize({ restart: true, returnTo: 'window' })).statusCode, 409);
    assert.equal(await callback(states[2], 'code=fixture-code'), 'expired');
    assert.equal(finished, 2);
    await createDiscoveredConnections(f.pool, { ...options, ownerId: 'foreign-owner' });
    assert.equal((await status()).oauthStatus, 'pending');
    await createDiscoveredConnections(f.pool, options);
    assert.equal((await status()).oauthStatus, 'failed');
    await assert.rejects(grantVault.read(id!));
    assert.equal((await authorize()).statusCode, 200);
    assert.equal(states.length, 4);
    finishRelease();
    assert.equal(await interrupted, 'failed');
    assert.equal((await status()).oauthStatus, 'pending');
    assert.equal(await callback(states[2], 'code=fixture-code'), 'expired');
    assert.equal(await callback(states[3], 'code=fixture-code', ''), 'failed');
    issSupported = false;
    assert.equal((await authorize()).statusCode, 200);
    assert.equal(await callback(states[4], 'code=fixture-code', 'https://other.example'), 'failed');
    assert.equal((await authorize()).statusCode, 200);
    assert.equal(states.length, 6);
    assert.equal(finished, 2);
    assert.equal(await callback(states[5], 'code=fixture-code', ''), 'connected');
    assert.equal((await status()).oauthStatus, 'connected');
    assert.deepEqual(await setupStatus(), { completed: [setupHash], apps: [] });
    await createDiscoveredConnections(f.pool, options);
    assert.equal((await recovered.inject(path)).json().oauthStatus, 'connected');
    assert.equal((await status()).authorizationUrl, undefined);
    assert.equal((await authorize()).statusCode, 409);
    assert.equal(await callback(states[5], 'code=fixture-code'), 'expired');
    assert.equal(finished, 3);
    assert.equal((await discovered.list()).length, 1);
    await assert.rejects(grantVault.read(id!));
    await f.pool.query(
      "UPDATE discovered_connection_proposals SET expires_at=now()-interval '1 second' WHERE id=$1",
      [id],
    );
    assert.deepEqual(await setupStatus(), { completed: [setupHash], apps: [] });
    const webService = await createIntegrations(f.pool, {
      ownerId,
      provider: f.provider,
      baseUrl: options.baseUrl,
      discovered,
      wake: async () => {},
    });
    const web = Fastify();
    t.after(() => web.close());
    webService.registerRoutes(web);
    const finishInWindow = async (started: { url: string; attempt: string }, result: string) => {
      const state = new URL(started.url).searchParams.get('state');
      const response = await web.inject({
        url: `/api/apps/callback?state=${state}&${result}&iss=${encodeURIComponent(issuer)}`,
      });
      assert.equal(response.statusCode, 302, response.body);
      const destination = new URL(response.headers.location!);
      assert.equal(destination.searchParams.get('desktop'), null);
      if (destination.searchParams.get('connection') !== 'expired') {
        assert.equal(destination.pathname, '/connected.html');
        assert.equal(destination.searchParams.get('attempt'), started.attempt);
      }
      return destination.searchParams.get('connection');
    };
    for (const slug of ['notion', 'linear']) {
      const connect = () =>
        web.inject({
          method: 'POST',
          url: `/api/apps/${slug}/connect`,
          payload: { returnTo: 'window' },
        });
      const cancelled = await connect();
      assert.equal(cancelled.statusCode, 200, cancelled.body);
      assert.equal(typeof cancelled.json().attempt, 'string');
      assert.equal((await rawStatus(cancelled.json().url)).apps[0].available, true);
      assert.equal(await finishInWindow(cancelled.json(), 'error=access_denied'), 'cancelled');
      assert.equal((await rawStatus(cancelled.json().url)).apps[0].available, false);
      const retry = await connect();
      assert.equal(retry.statusCode, 200, retry.body);
      assert.notEqual(retry.json().attempt, cancelled.json().attempt);
      assert.equal(await finishInWindow(cancelled.json(), 'code=old'), 'expired');
      const beforeFinish: number = finished;
      assert.equal(await finishInWindow(retry.json(), 'code=fixture-code'), 'connected');
      assert.equal(await finishInWindow(retry.json(), 'code=fixture-code'), 'expired');
      assert.equal(finished, beforeFinish + 1);
      const hash = createHash('sha256').update(retry.json().url).digest('hex');
      assert.deepEqual(await rawStatus(retry.json().url), { completed: [hash], apps: [] });
      const connectionsBefore: number = (await discovered.list()).length;
      const replaceable = await connect();
      const independent = await connect();
      const replace = (attempt: string, extra: Record<string, unknown> = {}, service = slug) =>
        web.inject({
          method: 'POST',
          url: `/api/apps/${service}/connect`,
          payload: { returnTo: 'window', restartAttempt: attempt, ...extra },
        });
      const replaced = await replace(replaceable.json().attempt);
      assert.equal(replaced.statusCode, 200, replaced.body);
      assert.notEqual(replaced.json().attempt, replaceable.json().attempt);
      assert.equal(await finishInWindow(replaceable.json(), 'code=old'), 'expired');
      assert.equal((await rawStatus(independent.json().url)).apps[0].available, true);
      const authorizationsBefore: number = states.length;
      assert.equal((await replace(replaceable.json().attempt)).statusCode, 409);
      assert.equal((await replace('x'.repeat(43))).statusCode, 409);
      assert.equal(
        (await replace(replaced.json().attempt, { connectionId: randomUUID() })).statusCode,
        409,
      );
      assert.equal(
        (await replace(replaced.json().attempt, {}, slug === 'notion' ? 'linear' : 'notion'))
          .statusCode,
        409,
      );
      const differentAccount = (await discovered.list()).find((entry) => entry.slug === slug)!;
      await f.pool.query('UPDATE discovered_connections SET reconnect_required=true WHERE id=$1', [
        differentAccount.connectionId,
      ]);
      assert.equal(
        (await replace(replaced.json().attempt, { connectionId: differentAccount.connectionId }))
          .statusCode,
        409,
      );
      await f.pool.query('UPDATE discovered_connections SET reconnect_required=false WHERE id=$1', [
        differentAccount.connectionId,
      ]);
      assert.equal(states.length, authorizationsBefore);
      assert.equal(await finishInWindow(replaced.json(), 'code=fixture-code'), 'connected');
      assert.equal((await discovered.list()).length, connectionsBefore + 1);
      assert.equal(await finishInWindow(independent.json(), 'code=fixture-code'), 'connected');
      assert.equal((await discovered.list()).length, connectionsBefore + 2);
      finishing = new Promise<void>((resolve) => {
        finishStarted = resolve;
      });
      finishGate = new Promise<void>((resolve) => {
        finishRelease = resolve;
      });
      const completing = await connect();
      const completingResult = finishInWindow(completing.json(), 'code=hold');
      await finishing;
      const beforeBlocked: number = states.length;
      assert.equal((await replace(completing.json().attempt)).statusCode, 409);
      assert.equal(states.length, beforeBlocked);
      finishRelease();
      assert.equal(await completingResult, 'connected');
      assert.equal((await discovered.list()).length, connectionsBefore + 3);
    }
    const custom = await discovered.propose({
      service: 'fixture-restart',
      name: 'Synthetic restart app',
      paths: [{ kind: 'mcp', endpoint: 'https://fixture.example/restart', auth: 'oauth' }],
    });
    const customId = new URL(custom.url, options.baseUrl).searchParams.get('connect');
    const startCustom = (payload: Record<string, unknown>) =>
      web.inject({
        method: 'POST',
        url: `/api/apps/discovery/${customId}/authorize`,
        payload: { returnTo: 'window', ...payload },
      });
    const oldCustom = await startCustom({
      clientId: 'synthetic-client-id',
      restartAttempt: null,
    });
    assert.equal(oldCustom.statusCode, 200, oldCustom.body);
    assert.deepEqual((await startCustom({})).json(), oldCustom.json());
    const currentCustom = await startCustom({
      restart: true,
      restartAttempt: oldCustom.json().attempt,
    });
    assert.equal(currentCustom.statusCode, 200, currentCustom.body);
    assert.notEqual(currentCustom.json().url, oldCustom.json().url);
    assert.notEqual(currentCustom.json().attempt, oldCustom.json().attempt);
    assert.deepEqual((await rawStatus(oldCustom.json().url)).apps, []);
    assert.equal(await finishInWindow(oldCustom.json(), 'code=old'), 'expired');
    assert.equal((await rawStatus(currentCustom.json().url)).apps[0].available, true);
    const beforeStaleRestart = states.length;
    assert.equal(
      (await startCustom({ restart: true, restartAttempt: oldCustom.json().attempt })).statusCode,
      409,
    );
    assert.equal(states.length, beforeStaleRestart);
    const currentCustomStatus = await web.inject(`/api/apps/discovery/${customId}`);
    assert.equal(currentCustomStatus.statusCode, 200, currentCustomStatus.body);
    assert.equal(currentCustomStatus.json().attempt, currentCustom.json().attempt);
    assert.equal(currentCustomStatus.json().authorizationUrl, currentCustom.json().url);
    assert.equal(await finishInWindow(currentCustom.json(), 'code=fail'), 'failed');
    assert.equal((await web.inject(`/api/apps/discovery/${customId}`)).json().attempt, undefined);
    const newerWhileEditing = await startCustom({ restart: true, restartAttempt: null });
    assert.equal(newerWhileEditing.statusCode, 200, newerWhileEditing.body);
    const beforeStaleEditor = states.length;
    assert.equal((await startCustom({ restart: true, restartAttempt: null })).statusCode, 409);
    assert.equal(states.length, beforeStaleEditor);
    const reconciled = await web.inject(`/api/apps/discovery/${customId}`);
    assert.equal(reconciled.json().attempt, newerWhileEditing.json().attempt);
    assert.equal(reconciled.json().authorizationUrl, newerWhileEditing.json().url);
    assert.equal(await finishInWindow(newerWhileEditing.json(), 'code=fixture-code'), 'connected');
    assert.equal((await web.inject(`/api/apps/discovery/${customId}`)).json().attempt, undefined);
  },
);

test(
  'the n8n address form offers only its fixed local address, checked through that address alone',
  { skip: !process.env.TEST_DATABASE_URL },
  async (t) => {
    const f = await appsFixture(t);
    const ownerId = 'local-development';
    const grantVault = await createAppGrantVault(f.pool, {
      ownerId,
      keyStore: { id: 'fixture', configured: true, getKey: async () => Buffer.alloc(32, 1) },
    });
    const transport = {
      validateEndpoint: async (endpoint: string) => endpoint,
      http: async () => {
        throw new Error('Only the bound local transport may probe.');
      },
      listTools: async () => ({ tools: [] }),
      callTool: async () => ({}),
    };
    const oauth = {
      begin: async () => {
        throw new Error('No sign-in is expected.');
      },
      finish: async () => {
        throw new Error('No sign-in is expected.');
      },
      refresh: async () => {
        throw new Error('No sign-in is expected.');
      },
    };
    const probes: string[] = [];
    let answer: unknown = { resource: 'https://elsewhere.example/mcp-server/http' };
    const discovered = await createDiscoveredConnections(f.pool, {
      ownerId,
      baseUrl: 'http://127.0.0.1:4310',
      grantVault,
      transport,
      oauth,
      local: (origin) => ({
        transport: {
          ...transport,
          http: async (endpoint: string) => {
            probes.push(`${origin} ${endpoint}`);
            if (!answer) throw new Error('Connection refused');
            return { status: 200, body: answer };
          },
        },
        oauth,
      }),
    });
    const app = Fastify();
    t.after(() => app.close());
    discovered.registerRoutes(app);
    const form = async (service: string) => {
      const { url } = await discovered.signIn(service, {
        threadId: randomUUID(),
        turnId: randomUUID(),
      });
      const id = new URL(url, 'http://localhost').searchParams.get('connect');
      const response = await app.inject(`/api/apps/discovery/${id}`);
      assert.equal(response.statusCode, 200, response.body);
      return response.json();
    };
    assert.equal((await form('n8n')).localAddress, 'http://localhost:5678');
    assert.deepEqual(probes, [
      'http://localhost:5678 http://localhost:5678/.well-known/oauth-protected-resource/mcp-server/http',
    ]);
    answer = undefined;
    const unanswered = await form('n8n');
    assert.equal(unanswered.needsAddress, true);
    assert.equal(unanswered.localAddress, undefined);
    answer = { resource: 'http://localhost:5678/mcp-server/http' };
    assert.equal((await form('notion')).localAddress, undefined);
    assert.equal(probes.length, 2);
  },
);

test(
  'native app setup reuses owned accounts unless another account is explicitly requested',
  { skip: !process.env.TEST_DATABASE_URL },
  async (t) => {
    const f = await appsFixture(t);
    const work = await f.connect('gmail');
    await f.pool.query('UPDATE app_connections SET account_email=$2 WHERE id=$1', [
      work.connectionId,
      'work@example.test',
    ]);
    await f.pool.query(
      `INSERT INTO app_connections(owner_id,slug,account_id,provider_id,account_email)
       VALUES('foreign-owner','gmail','foreign-account','fixture','foreign@example.test')`,
    );
    const directory = await mkdtemp(join(tmpdir(), 'nod-add-account-'));
    const threadId = randomUUID();
    const turnId = randomUUID();
    const replies: string[] = [];
    const agent: Agent = {
      open: async ({ tools }) => ({
        resumed: false,
        prompt: async () => {
          const tool = tools.find((item) => item.name === 'manage_apps')!;
          for (const extra of [{}, { newAccount: false }])
            assert.deepEqual(
              resultValue(await tool.execute({ action: 'connect', service: 'gmail', ...extra })),
              {
                status: 'already_connected',
                accounts: [
                  {
                    connectionId: work.connectionId,
                    accountName: work.accountName,
                    accountEmail: 'work@example.test',
                  },
                ],
              },
            );
          for (const action of ['list', 'propose'])
            await assert.rejects(tool.execute({ action, service: 'gmail', newAccount: true }));
          assert.equal(f.callbacks.length, 1);
          await tool.execute({ action: 'connect', service: 'gmail', newAccount: true });
        },
        abort() {},
        dispose() {},
      }),
      dispose() {},
    };
    const runtime = createAgentRuntime({
      agent,
      computer: fakeComputer(),
      workspace: fakeWorkspace(),
    });
    t.after(async () => {
      await runtime.dispose();
      await rm(directory, { recursive: true, force: true });
    });
    const result = await runtime.runTurn({
      threadId,
      sessionId: threadId,
      turnId,
      prompt: 'Connect my personal Gmail too, keeping my work account.',
      history: [],
      attachments: [],
      workspacePath: directory,
      signal: new AbortController().signal,
      emit: async () => {},
      reply: async (text) => {
        replies.push(text);
      },
      delta() {},
      publish: async () => {
        throw new Error('Unexpected fixture publication.');
      },
      requestCredential: async () => {
        throw new Error('Unexpected fixture credential request.');
      },
      integration: async () => {
        throw new Error('Unexpected fixture app action.');
      },
      manage: async () => {
        throw new Error('Unexpected fixture management.');
      },
      connections: async (action, service, proposal, newAccount) => ({
        ...(await f.service.manageConnections(
          action,
          service,
          { threadId, turnId },
          proposal,
          newAccount,
        )),
        message: 'Connect the synthetic account.',
      }),
    });
    assert.equal(result.status, 'waiting_user');
    assert.equal(f.callbacks.length, 2);
    assert.deepEqual(replies, []);
    assert.ok(result.message?.includes('https://consent.example.com/connect'));
    const pending = (
      await f.pool.query('SELECT * FROM app_connections WHERE owner_id=$1 AND turn_id=$2', [
        'local-development',
        turnId,
      ])
    ).rows[0];
    assert.equal(pending.account_id, null);
    assert.equal(pending.pending_account_id, 'account-2');
    const callback = new URL(f.callbacks.at(-1)!);
    callback.searchParams.set('account', pending.pending_account_id);
    const response = await f.app.inject({ url: `${callback.pathname}${callback.search}` });
    assert.equal(
      response.headers.location,
      'http://localhost:4310/?connection=connected&service=gmail',
    );
    const accounts = (await f.service.list()).filter((item) => item.slug === 'gmail');
    assert.equal(accounts.length, 2);
    assert.ok(accounts.every((item) => item.status === 'connected'));
    assert.equal(
      accounts.find((item) => item.connectionId === work.connectionId)?.accountEmail,
      'work@example.test',
    );
    assert.ok(accounts.some((item) => item.connectionId === pending.id));
  },
);

test(
  'native setup completion tracks only the successful owned link through account merges and removal',
  { skip: !process.env.TEST_DATABASE_URL },
  async (t) => {
    const f = await appsFixture(t);
    const work = await f.connect('gmail');
    const start = async (app = f.app) => {
      const response = await app.inject({ method: 'POST', url: '/api/apps/gmail/connect' });
      assert.equal(response.statusCode, 200);
      const callback = new URL(f.callbacks.at(-1)!);
      const pending = (
        await f.pool.query('SELECT * FROM app_connections WHERE callback_hash=$1', [
          createHash('sha256').update(callback.searchParams.get('state')!).digest('hex'),
        ])
      ).rows[0];
      callback.searchParams.set('account', pending.pending_account_id);
      const hash = createHash('sha256').update(new URL(response.json().url).href).digest('hex');
      assert.equal(pending.setup_link_hash, hash);
      return { id: pending.id, hash, callback };
    };
    const setupStatus = async (...hashes: string[]) => {
      const response = await f.app.inject({
        method: 'POST',
        url: '/api/apps/setup-status',
        payload: { hashes },
      });
      assert.equal(response.statusCode, 200);
      return response.json<{
        completed: string[];
        apps: Array<{ hash: string; slug: string; name: string; logoUrl?: string }>;
      }>();
    };
    const status = async (...hashes: string[]) => (await setupStatus(...hashes)).completed;
    const complete = async (callback: URL) =>
      (await f.app.inject({ url: `${callback.pathname}${callback.search}` })).headers.location;
    let personal = await start();
    const other = await start();
    const foreignApp = Fastify();
    t.after(() => foreignApp.close());
    (
      await createIntegrations(f.pool, {
        ownerId: 'foreign-owner',
        provider: f.provider,
        baseUrl: 'http://localhost:4310',
        wake: async () => {},
      })
    ).registerRoutes(foreignApp);
    const foreign = await start(foreignApp);
    const pendingStatus = await setupStatus(
      personal.hash,
      other.hash,
      foreign.hash,
      '0'.repeat(64),
      personal.hash,
    );
    assert.deepEqual(pendingStatus.completed, []);
    assert.deepEqual(
      pendingStatus.apps.map((app) => app.hash).sort(),
      [personal.hash, other.hash].sort(),
    );
    await f.pool.query('INSERT INTO app_setup_completions(owner_id,link_hash) VALUES($1,$2)', [
      'foreign-owner',
      other.hash,
    ]);
    assert.deepEqual(await status(personal.hash, other.hash), []);
    const wrongAccount = new URL(personal.callback);
    wrongAccount.searchParams.set('account', work.accountId!);
    assert.equal(await complete(wrongAccount), 'http://localhost:4310/apps?connection=failed');
    assert.deepEqual(await status(personal.hash, other.hash), []);
    assert.equal(
      await complete(personal.callback),
      'http://localhost:4310/apps?connection=expired',
    );
    const rejectedHash = personal.hash;
    personal = await start();
    assert.equal(
      await complete(personal.callback),
      'http://localhost:4310/apps?connection=connected',
    );
    assert.deepEqual(await status(rejectedHash, personal.hash, other.hash), [personal.hash]);
    assert.deepEqual(await status(personal.hash, other.hash), [personal.hash]);
    assert.deepEqual((await setupStatus(personal.hash)).apps, []);
    await f.pool.query(
      "UPDATE app_connections SET callback_expires=now()-interval '1 second' WHERE id=$1",
      [other.id],
    );
    assert.equal(await complete(other.callback), 'http://localhost:4310/apps?connection=expired');
    assert.deepEqual(await status(other.hash), []);
    assert.deepEqual((await setupStatus(other.hash, foreign.hash, '0'.repeat(64))).apps, [
      { hash: other.hash, slug: 'gmail', name: 'Gmail', available: false },
    ]);
    f.provider.configurationId = 'current-configuration';
    await f.pool.query('UPDATE app_connections SET configuration_id=$1 WHERE id=$2', [
      'previous-configuration',
      work.connectionId,
    ]);
    assert.equal(
      (await f.service.list()).find((connection) => connection.connectionId === work.connectionId)
        ?.status,
      'disconnected',
    );
    f.session.authorize = async (_service, callback) => {
      f.callbacks.push(callback);
      return { accountId: work.accountId!, url: 'https://consent.example.com/reconnect-work' };
    };
    const reconnect = await start();
    assert.deepEqual(await status(reconnect.hash), []);
    assert.equal(
      await complete(reconnect.callback),
      'http://localhost:4310/apps?connection=connected',
    );
    assert.equal(
      (await f.pool.query('SELECT id FROM app_connections WHERE id=$1', [reconnect.id])).rowCount,
      0,
    );
    assert.equal(
      (await f.service.list()).find((connection) => connection.accountId === work.accountId)
        ?.connectionId,
      work.connectionId,
    );
    assert.equal(
      (await f.service.list()).find((connection) => connection.connectionId === work.connectionId)
        ?.status,
      'connected',
    );
    assert.equal(
      (
        await f.pool.query('SELECT configuration_id FROM app_connections WHERE id=$1', [
          work.connectionId,
        ])
      ).rows[0].configuration_id,
      f.provider.configurationId,
    );
    await f.service.execute('local-development', 'GMAIL_FETCH_EMAILS', {
      connectionId: work.connectionId,
    });
    assert.equal(f.executed.at(-1)?.accountId, work.accountId);
    assert.deepEqual(await status(reconnect.hash), [reconnect.hash]);
    assert.deepEqual((await setupStatus(reconnect.hash)).apps, []);
    assert.equal(
      await complete(reconnect.callback),
      'http://localhost:4310/apps?connection=expired',
    );
    assert.equal(
      (
        await f.app.inject({
          method: 'POST',
          url: `/api/apps/gmail/accounts/${work.connectionId}/disconnect`,
        })
      ).statusCode,
      200,
    );
    assert.deepEqual(await status(reconnect.hash), [reconnect.hash]);
    assert.deepEqual(await status(other.hash), []);
  },
);

test(
  'expired Gmail setup cards preserve owned app metadata after another attempt completes and the service restarts',
  { skip: !process.env.TEST_DATABASE_URL },
  async (t) => {
    const f = await appsFixture(t);
    const pairingChecks = t.mock.fn(async () => ({ pairingConfirmed: false }));
    f.provider.connectionStatus = pairingChecks;
    const start = async (app = f.app) => {
      const response = await app.inject({ method: 'POST', url: '/api/apps/gmail/connect' });
      assert.equal(response.statusCode, 200, response.body);
      const url = response.json().url as string;
      const hash = createHash('sha256').update(url).digest('hex');
      const pending = (
        await f.pool.query(
          'SELECT id,pending_account_id FROM app_connections WHERE setup_link_hash=$1',
          [hash],
        )
      ).rows[0];
      const callback = new URL(f.callbacks.at(-1)!);
      callback.searchParams.set('account', pending.pending_account_id);
      return { id: pending.id, hash, url, callback };
    };
    const earlier = await start();
    const later = await start();
    const foreignApp = Fastify();
    t.after(() => foreignApp.close());
    (
      await createIntegrations(f.pool, {
        ownerId: 'foreign-owner',
        provider: f.provider,
        baseUrl: 'http://localhost:4310',
        wake: async () => {},
      })
    ).registerRoutes(foreignApp);
    const foreign = await start(foreignApp);
    const read = async (app: typeof f.app, pairingUrl = earlier.url) => {
      const response = await app.inject({
        method: 'POST',
        url: '/api/apps/setup-status',
        payload: {
          hashes: [earlier.hash, later.hash, foreign.hash, '0'.repeat(64)],
          pairingUrl,
        },
      });
      assert.equal(response.statusCode, 200, response.body);
      assert.equal(response.headers['cache-control'], 'no-store');
      return response.json();
    };
    const pending = await read(f.app);
    assert.deepEqual(pending.completed, []);
    assert.deepEqual(
      pending.apps.map((app: { hash: string }) => app.hash).sort(),
      [earlier.hash, later.hash].sort(),
    );
    assert.equal(pairingChecks.mock.callCount(), 1);
    await f.pool.query('DROP TABLE app_setup_links');
    await initializeIntegrationSchema(f.pool);
    await f.pool.query(
      "UPDATE app_connections SET callback_expires=now()-interval '1 second' WHERE id=$1",
      [earlier.id],
    );
    const completed = await f.app.inject({
      url: `${later.callback.pathname}${later.callback.search}`,
    });
    assert.equal(completed.headers.location, 'http://localhost:4310/apps?connection=connected');
    const expected = {
      completed: [later.hash],
      apps: [{ hash: earlier.hash, slug: 'gmail', name: 'Gmail', available: false }],
    };
    assert.deepEqual(await read(f.app), expected);
    assert.equal(pairingChecks.mock.callCount(), 1);
    await f.pool.query('DELETE FROM app_connections WHERE id=$1', [earlier.id]);
    assert.deepEqual(await read(f.app), expected);
    assert.equal(pairingChecks.mock.callCount(), 1);
    const recovered = Fastify();
    t.after(() => recovered.close());
    (
      await createIntegrations(f.pool, {
        ownerId: 'local-development',
        provider: f.provider,
        baseUrl: 'http://localhost:4310',
        wake: async () => {},
      })
    ).registerRoutes(recovered);
    assert.deepEqual(await read(recovered), expected);
    assert.equal(pairingChecks.mock.callCount(), 1);
    assert.deepEqual(await read(recovered, foreign.url), expected);
    assert.equal(pairingChecks.mock.callCount(), 1);
  },
);

test(
  'ordinary account-scoped discovery excludes other accounts from the provider session',
  { skip: !process.env.TEST_DATABASE_URL },
  async (t) => {
    const f = await appsFixture(t);
    const selected = await f.connect('gmail');
    await f.connect('gmail');
    await f.connect('slack');
    f.sessions.length = 0;
    t.mock.method(f.session, 'search', async () => ({
      tools: { GMAIL_GET_PROFILE: {}, SLACK_SEARCH: {} },
      suggestions: [],
    }));
    const result = (await f.service.execute('local-development', 'SEARCH_TOOLS', {
      query: 'recent email',
      connectionId: selected.connectionId,
    })) as { tools: Record<string, unknown>; accounts: Array<{ connectionId: string }> };
    assert.deepEqual(f.sessions, [{ gmail: [selected.accountId] }]);
    assert.deepEqual(Object.keys(result.tools), ['GMAIL_GET_PROFILE']);
    assert.deepEqual(
      result.accounts.map((account) => account.connectionId),
      [selected.connectionId],
    );
    const dynamic = randomUUID();
    await f.pool.query(
      `INSERT INTO app_connections(id,owner_id,slug,account_id,provider_id)
       VALUES($1,'local-development','foo','foo-account','fixture'),
             ($2,'local-development','foo_mcp','mcp-account','fixture')`,
      [dynamic, randomUUID()],
    );
    t.mock.method(f.session, 'search', async () => ({
      tools: { FOO_LIST: {}, FOO_MCP_LIST: {} },
      suggestions: [],
    }));
    const cold = (await f.service.execute('local-development', 'SEARCH_TOOLS', {
      query: 'list',
      connectionId: dynamic,
    })) as { tools: Record<string, unknown> };
    assert.deepEqual(f.sessions.at(-1), { foo: ['foo-account'] });
    assert.deepEqual(Object.keys(cold.tools), ['FOO_LIST']);
  },
);

test(
  'inbox polling and verified webhooks share message receipts and retain exact source identities',
  { skip: !process.env.TEST_DATABASE_URL },
  async (t) => {
    const admission = createWorkAdmission();
    admission.pause();
    let paused = false;
    const f = await appsFixture(t, {}, { admission, paused: async () => paused });
    const selected = await f.connect('gmail');
    const metadata = {
      subject: 'Question about the upcoming planning review '.repeat(10),
      sender: `${'A long sender display name '.repeat(14)} <sender@example.test>`,
    };
    const message = (id: string) => ({
      id,
      threadId: '998877665544',
      ...metadata,
      summary: 'OTP 1234 A1B2C3 https://example.test/reset?token=credential',
      receivedAt: '2026-01-01T00:00:00.000Z',
    });
    f.provider.pollInbox = async (_account, cursor) => ({
      cursor: cursor ? 'complete' : 'baseline',
      hasMore: false,
      messages: cursor ? [message('112233445566'), message('223344556677')] : [],
    });
    await f.service.pollInboxes();
    const send = (id: string) =>
      f.app.inject({
        method: 'POST',
        url: '/api/webhooks/fixture',
        headers: { 'content-type': 'application/json', 'x-fixture-signature': 'valid' },
        payload: JSON.stringify({
          id: randomUUID(),
          ownerId: 'local-development',
          service: 'gmail',
          accountId: selected.accountId,
          subscriptionId: `trigger-${selected.accountId}`,
          trigger: 'gmail-event',
          data: {
            message_id: id,
            thread_id: '998877665544',
            intent: 'inspect_message',
            ...metadata,
          },
        }),
      });
    await send('112233445566');
    await f.service.drain();
    assert.equal(f.wakes.length, 1);
    await send('112233445566');
    await f.pool.query('UPDATE app_connections SET inbox_poll_at=NULL WHERE id=$1', [
      selected.connectionId,
    ]);
    await f.service.pollInboxes();
    await f.service.drain();
    await send('223344556677');
    await f.service.drain();
    const receipts = (await f.pool.query('SELECT * FROM integration_events ORDER BY created_at'))
      .rows;
    assert.equal(receipts.length, 2);
    assert.equal(new Set(f.wakes).size, 2);
    assert.equal(f.wakes.length, 2);
    assert.match(receipts[0].summary, /112233445566/);
    assert.match(receipts[1].summary, /223344556677/);
    assert.match(receipts[1].summary, /998877665544/);
    for (const row of receipts) {
      assert.ok(row.summary.length > 700);
      assert.ok(row.summary.slice(0, 700).includes(selected.connectionId!));
      assert.ok(row.summary.slice(0, 700).includes('998877665544'));
    }
    assert.doesNotMatch(
      JSON.stringify(receipts).replaceAll(selected.connectionId!, ''),
      /1234|A1B2C3|reset\?token|credential/,
    );
    assert.equal(receipts[1].poll_connection_id, selected.connectionId);
    assert.equal(receipts[1].trigger_id, null);
    await send('');
    await f.service.drain();
    assert.equal(f.wakes.length, 3);
    const calendar = await f.connect('googlecalendar');
    await f.app.inject({
      method: 'POST',
      url: '/api/webhooks/fixture',
      headers: { 'content-type': 'application/json', 'x-fixture-signature': 'valid' },
      payload: JSON.stringify({
        id: randomUUID(),
        ownerId: 'local-development',
        service: 'googlecalendar',
        accountId: calendar.accountId,
        subscriptionId: `trigger-${calendar.accountId}`,
        trigger: 'googlecalendar-event',
        data: { message_id: '334455667788', intent: 'inspect_message' },
      }),
    });
    await f.service.drain();
    assert.equal(f.wakes.length, 4);
    assert.equal(f.executed.length, 0);
    const settled = f.settles();
    await send('556677889900');
    await send('667788990011');
    await f.service.drain();
    assert.deepEqual([f.wakes.length, f.settles()], [6, settled + 1]);
    const count = async () =>
      (await f.pool.query('SELECT count(*)::int AS n FROM integration_events')).rows[0].n;
    const received = await count();
    paused = true;
    f.provider.pollInbox = async () => ({
      cursor: 'after-pause',
      hasMore: false,
      messages: [message('778899001122')],
    });
    await f.pool.query('UPDATE app_connections SET inbox_poll_at=NULL WHERE id=$1', [
      selected.connectionId,
    ]);
    await f.service.pollInboxes();
    assert.equal(await count(), received);
    await send('889900112233');
    const quiet = (
      await f.pool.query('SELECT summary FROM integration_events ORDER BY created_at DESC LIMIT 1')
    ).rows[0];
    assert.doesNotMatch(quiet.summary, /planning review|sender@example/);
    const watched = await f.service.watchState([selected.connectionId!]);
    assert.ok(watched);
    assert.equal(await count(), received + 2);
    assert.equal(await f.service.watchState([selected.connectionId!]), watched);
    f.provider.pollInbox = async () => ({
      cursor: 'later',
      hasMore: false,
      messages: [message('990011223344')],
    });
    assert.notEqual(await f.service.watchState([selected.connectionId!]), watched);
    assert.equal(await f.service.watchState([randomUUID()]), null);
  },
);

test(
  'inbox cursor and event commits roll back together and resume bounded continuations',
  { skip: !process.env.TEST_DATABASE_URL },
  async (t) => {
    const f = await appsFixture(t);
    f.provider.webhooksConfigured = false;
    const selected = await f.connect('gmail');
    let rejecting = true;
    const cursors: Array<string | null> = [];
    f.provider.pollInbox = async (_account, cursor) => {
      cursors.push(cursor);
      return {
        cursor: cursor === null ? 'baseline' : cursor === 'baseline' ? 'continuation' : 'complete',
        hasMore: cursor === 'baseline',
        messages:
          cursor === null
            ? []
            : ['first', 'second'].map((part) => ({
                id: `${cursor}-${part}`,
                threadId: 'thread-fixture',
                subject: rejecting && part === 'second' ? 'reject-fixture' : 'Question',
                sender: 'person@example.test',
                summary: 'Fixture request',
                receivedAt: '2026-01-01T00:00:00.000Z',
              })),
      };
    };
    await f.service.pollInboxes();
    await f.pool.query(
      "ALTER TABLE integration_events ADD CONSTRAINT reject_fixture CHECK (summary NOT LIKE '%reject-fixture%')",
    );
    await f.pool.query('UPDATE app_connections SET inbox_poll_at=NULL WHERE id=$1', [
      selected.connectionId,
    ]);
    await f.service.pollInboxes();
    assert.equal(
      (
        await f.pool.query('SELECT inbox_cursor FROM app_connections WHERE id=$1', [
          selected.connectionId,
        ])
      ).rows[0].inbox_cursor,
      'baseline',
    );
    assert.equal((await f.pool.query('SELECT * FROM integration_events')).rowCount, 0);
    rejecting = false;
    await f.pool.query('UPDATE app_connections SET inbox_poll_at=NULL WHERE id=$1', [
      selected.connectionId,
    ]);
    await f.service.pollInboxes();
    assert.equal(
      (
        await f.pool.query('SELECT inbox_cursor FROM app_connections WHERE id=$1', [
          selected.connectionId,
        ])
      ).rows[0].inbox_cursor,
      'continuation',
    );
    await f.service.pollInboxes();
    assert.deepEqual(cursors, [null, 'baseline', 'baseline', 'continuation']);
    assert.equal(
      (
        await f.pool.query('SELECT inbox_cursor FROM app_connections WHERE id=$1', [
          selected.connectionId,
        ])
      ).rows[0].inbox_cursor,
      'complete',
    );
    assert.equal((await f.pool.query('SELECT * FROM integration_events')).rowCount, 4);
    await f.pool.query('UPDATE app_connections SET watch_revision=watch_revision+1 WHERE id=$1', [
      selected.connectionId,
    ]);
    await f.service.drain();
    assert.equal(f.wakes.length, 4);
  },
);

test(
  'disconnect during a claimed event prevents admission and cannot revive discarded delivery',
  { skip: !process.env.TEST_DATABASE_URL, timeout: 15_000 },
  async (t) => {
    for (const fail of [false, true]) {
      let enter = () => {};
      let release = () => {};
      const entered = new Promise<void>((resolve) => {
        enter = resolve;
      });
      const released = new Promise<void>((resolve) => {
        release = resolve;
      });
      let admitted = 0;
      const f = await appsFixture(
        t,
        {},
        {
          wake: async (_summary, _id, current) => {
            enter();
            await released;
            const client = await f.pool.connect();
            try {
              await client.query('BEGIN');
              assert.ok(current);
              if (await current(client)) admitted++;
              await client.query('COMMIT');
            } finally {
              client.release();
            }
            if (fail) throw new Error('Synthetic wake failure after disconnect.');
          },
        },
      );
      const selected = await f.connect('gmail');
      const eventId = randomUUID();
      await f.pool.query(
        `INSERT INTO integration_events(id,owner_id,summary,slug,account_id,provider_id,poll_connection_id)
         VALUES($1,'local-development','Synthetic pending update','gmail',$2,'fixture',$3)`,
        [eventId, selected.accountId, selected.connectionId],
      );
      const draining = f.service.drain();
      try {
        await entered;
        const response = await f.app.inject({
          method: 'POST',
          url: `/api/apps/gmail/accounts/${selected.connectionId}/disconnect`,
        });
        assert.equal(response.statusCode, 200);
      } finally {
        release();
      }
      await draining;
      assert.equal(admitted, 0);
      assert.equal(
        (await f.pool.query('SELECT state FROM integration_events WHERE id=$1', [eventId])).rows[0]
          .state,
        'discarded',
      );
    }
  },
);

test(
  'workspace attachments preserve file bytes and fence account changes before execution',
  { skip: !process.env.TEST_DATABASE_URL },
  async (t) => {
    const turn = { threadId: randomUUID(), turnId: randomUUID() };
    const files = new Map([
      ['report.pdf', Buffer.from('%PDF-1.7\nSynthetic report\n')],
      ['data.csv', Buffer.from('item,total\nFixture,42\n')],
    ]);
    let reads = 0;
    const f = await appsFixture(
      t,
      {},
      {
        readWorkspaceFile: async (current, path, maximum) => {
          assert.deepEqual(current, turn);
          reads++;
          const bytes = files.get(path);
          if (!bytes) throw new Error('The workspace file is unavailable.');
          if (bytes.length > maximum) throw new Error('The workspace file is too large.');
          return bytes;
        },
      },
    );
    const first = await f.connect('gmail');
    const second = await f.connect('gmail');
    const stored = new Map<string, IntegrationFile>();
    f.session.upload = async (_action, file) => {
      const key = randomUUID();
      stored.set(key, { ...file, bytes: Uint8Array.from(file.bytes) });
      return { name: file.name, mimetype: file.mimeType, s3key: key };
    };
    const delivered: IntegrationFile[][] = [];
    f.session.execute = async (_action, args, accountId) => {
      assert.equal(accountId, second.accountId);
      const attachments = args.attachment as Array<{ s3key: string }>;
      delivered.push(
        attachments.map(({ s3key }) => {
          const file = stored.get(s3key);
          assert.ok(file, 'The attachment must exist in file storage.');
          return file;
        }),
      );
      return { successful: true };
    };
    const args = {
      connectionId: second.connectionId,
      recipient_email: 'recipient@example.test',
      attachment: [
        { workspaceFile: 'report.pdf', mimeType: 'application/pdf', name: 'report.pdf', size: 42 },
        { workspaceFile: 'data.csv', mimeType: 'text/csv', name: 'totals.csv' },
      ],
    };
    const pinned = await f.service.prepare(
      'local-development',
      'GMAIL_SEND_EMAIL',
      args,
      turn,
      undefined,
      true,
    );
    assert.equal(reads, 2);
    assert.equal(stored.size, 0);
    assert.deepEqual(
      await f.service.prepare('local-development', 'GMAIL_SEND_EMAIL', pinned),
      pinned,
    );
    const original = files.get('report.pdf')!;
    files.set('report.pdf', Buffer.from('Changed after confirmation was requested.'));
    await assert.rejects(
      f.service.prepare('local-development', 'GMAIL_SEND_EMAIL', pinned, turn),
      /changed after this action was confirmed/,
    );
    assert.equal(stored.size, 0);
    files.set('report.pdf', original);
    const prepared = await f.service.prepare('local-development', 'GMAIL_SEND_EMAIL', pinned, turn);
    await f.service.executeApproved('local-development', 'GMAIL_SEND_EMAIL', prepared, turn);
    assert.deepEqual(
      delivered[0].map((file) => ({
        name: file.name,
        mimeType: file.mimeType,
        bytes: Buffer.from(file.bytes).toString(),
      })),
      [
        { name: 'report.pdf', mimeType: 'application/pdf', bytes: '%PDF-1.7\nSynthetic report\n' },
        { name: 'totals.csv', mimeType: 'text/csv', bytes: 'item,total\nFixture,42\n' },
      ],
    );
    const uploadCount = stored.size;
    for (const [owner, input, current] of [
      ['foreign-owner', args, turn],
      ['local-development', { ...args, connectionId: randomUUID() }, turn],
      ['local-development', args, undefined],
      [
        'local-development',
        {
          ...args,
          attachment: [
            args.attachment[0],
            { workspaceFile: 'missing.pdf', mimeType: 'application/pdf' },
          ],
        },
        turn,
      ],
    ] as const)
      await assert.rejects(f.service.execute(owner, 'GMAIL_SEND_EMAIL', input, current));
    assert.equal(stored.size, uploadCount);
    files.set('report.pdf', Buffer.alloc(fileBytes));
    await assert.rejects(
      f.service.execute('local-development', 'GMAIL_SEND_EMAIL', args, turn),
      /too large|between 1 byte/,
    );
    assert.equal(delivered.length, 1);
    assert.equal(stored.size, uploadCount);

    let entered: () => void = () => {};
    let finish: () => void = () => {};
    const started = new Promise<void>((resolve) => {
      entered = resolve;
    });
    const gate = new Promise<void>((resolve) => {
      finish = resolve;
    });
    f.session.upload = async () => {
      entered();
      await gate;
      return { name: 'report.pdf', mimetype: 'application/pdf', s3key: 'late-file' };
    };
    files.set('report.pdf', Buffer.from('Synthetic report'));
    const pending = f.service.execute(
      'local-development',
      'GMAIL_SEND_EMAIL',
      {
        ...args,
        connectionId: first.connectionId,
      },
      turn,
    );
    await started;
    await f.app.inject({
      method: 'POST',
      url: `/api/apps/gmail/accounts/${first.connectionId}/disconnect`,
    });
    finish();
    await assert.rejects(pending, /unavailable/);
    const controller = new AbortController();
    f.session.upload = async (_action, _file, signal) => {
      assert.equal(signal, controller.signal);
      controller.abort(new Error('Fixture upload stopped.'));
      return { s3key: 'cancelled-file' };
    };
    await assert.rejects(
      f.service.execute('local-development', 'GMAIL_SEND_EMAIL', args, turn, controller.signal),
      /Fixture upload stopped/,
    );
    assert.equal(delivered.length, 1);
  },
);

const query = 'List Gmail labels';

const searchResult = {
  tools: { GMAIL_LIST_LABELS: { inputSchema: { type: 'object' } } },
  suggestions: [{ useCase: query, primaryToolSlugs: ['GMAIL_LIST_LABELS'] }],
};

type Execute = (id: string, action: string, args: Record<string, unknown>) => Promise<unknown>;

function resultValue(result: AgentToolResult) {
  const part = result.content.find((value) => value.type === 'text');
  assert.ok(part && part.type === 'text');
  return JSON.parse(part.text);
}

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

async function searchFixture(
  t: TestContext,
  run: (execute: Execute, connectionId: string) => Promise<void>,
  options: {
    controller?: AbortController;
    search?: IntegrationSession['search'];
    execute?: IntegrationSession['execute'];
  } = {},
) {
  const directory = await mkdtemp(join(tmpdir(), 'nod-integration-search-recovery-'));
  const schema = `test_search_recovery_${randomUUID().replaceAll('-', '')}`;
  const admin = new pg.Pool({ connectionString: process.env.TEST_DATABASE_URL });
  const pool = new pg.Pool({
    connectionString: process.env.TEST_DATABASE_URL,
    options: `-c search_path=${schema}`,
  });
  const app = Fastify();
  let runtime: ReturnType<typeof createAgentRuntime> | undefined;
  t.after(async () => {
    try {
      await runtime?.dispose();
      await app.close();
    } finally {
      await pool.end();
      try {
        await admin.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);
      } finally {
        await admin.end();
        await rm(directory, { recursive: true, force: true });
      }
    }
  });
  await admin.query(`CREATE SCHEMA ${schema}`);
  const owner = randomUUID();
  const connectionId = randomUUID();
  const calendarId = randomUUID();
  const foreignId = randomUUID();
  const threadId = randomUUID();
  const turnId = randomUUID();
  const searches: string[] = [];
  const calls: Array<{ action: string; args: Record<string, unknown>; accountId?: string }> = [];
  const sessions: Array<{ owner: string; accounts: unknown }> = [];
  const events: string[] = [];
  const modelResults: unknown[] = [];
  const session: IntegrationSession = {
    id: 'fixture-search-session',
    authorize: async () => {
      throw new Error('Unexpected fixture authorization.');
    },
    search: async (value) => {
      searches.push(value);
      return options.search ? options.search(value) : searchResult;
    },
    execute: async (action, args, accountId) => {
      calls.push({ action, args, accountId });
      return options.execute
        ? options.execute(action, args, accountId)
        : { successful: true, data: { labels: [{ id: 'fixture-label' }] } };
    },
  };
  const provider: IntegrationProvider = {
    id: 'fixture',
    configured: true,
    webhooksConfigured: false,
    supportsSubscriptions: [],
    createSession: async (sessionOwner, accounts) => {
      sessions.push({ owner: sessionOwner, accounts });
      return session;
    },
    deleteSession: async () => {},
    inspectAccount: async (id) => ({
      active: true,
      service: id === 'fixture-calendar' ? 'googlecalendar' : 'gmail',
    }),
    deleteAccount: async () => {
      throw new Error('Unexpected fixture account deletion.');
    },
    subscribe: async () => {
      throw new Error('Unexpected fixture subscription.');
    },
    unsubscribe: async () => {
      throw new Error('Unexpected fixture unsubscribe.');
    },
    parseCallback: () => {
      throw new Error('Unexpected fixture callback.');
    },
    verifyWebhook: async () => {
      throw new Error('Unexpected fixture webhook.');
    },
    matchesSubscription: () => false,
  };
  const integrations = await createIntegrations(pool, {
    ownerId: owner,
    provider,
    baseUrl: 'http://localhost:4310',
    wake: async () => {
      throw new Error('Unexpected fixture wake.');
    },
  });
  integrations.registerRoutes(app);
  await app.ready();
  await pool.query(
    `INSERT INTO app_connections(id,owner_id,slug,account_id,provider_id,account_checked_at)
     VALUES($1,$2,'gmail','fixture-gmail','fixture',now()),
     ($3,$2,'googlecalendar','fixture-calendar','fixture',now()),
     ($4,$5,'gmail','fixture-foreign','fixture',now())`,
    [connectionId, owner, calendarId, foreignId, randomUUID()],
  );
  const agent: Agent = {
    open: async ({ tools }) => ({
      resumed: false,
      prompt: async () => {
        const tool = tools.find((value) => value.name === 'apps')!;
        await run(async (_id, action, args) => {
          const result = resultValue(await tool.execute({ action, args }));
          modelResults.push(result);
          return result;
        }, connectionId);
      },
      abort() {},
      dispose() {},
    }),
    dispose() {},
  };
  runtime = createAgentRuntime({
    agent,
    computer: fakeComputer(),
    workspace: fakeWorkspace(),
    redactError: createErrorRedactor(['fixture-provider-key-value']),
  });
  const context: RuntimeContext = {
    threadId,
    sessionId: threadId,
    turnId,
    prompt: 'Get the synthetic Gmail label count without reading or changing messages.',
    history: [],
    attachments: [],
    workspacePath: directory,
    signal: (options.controller ?? new AbortController()).signal,
    emit: async (type) => {
      events.push(type);
    },
    reply: async () => {},
    delta() {},
    publish: async () => {
      throw new Error('Unexpected fixture publication.');
    },
    requestCredential: async () => {
      throw new Error('Unexpected fixture credential request.');
    },
    integration: (action, args) =>
      integrations.execute(owner, action, args, { threadId, turnId }, context.signal),
    manage: async () => {
      throw new Error('Unexpected fixture management.');
    },
  };
  return {
    searches,
    calls,
    sessions,
    events,
    modelResults,
    owner,
    connectionId,
    calendarId,
    foreignId,
    run: () => runtime!.runTurn(context),
  };
}

test(
  'a failed app execution stops the turn and reaches the harness with a redacted provider error',
  { skip: !process.env.TEST_DATABASE_URL },
  async (t) => {
    const f = await searchFixture(
      t,
      async (execute, connectionId) => {
        await execute('uncertain', 'GMAIL_LIST_LABELS', { connectionId, user_id: 'me' });
        assert.fail('An uncertain provider result must not continue.');
      },
      {
        execute: async () => {
          throw new Error(
            'private-provider-diagnostic fixture-provider-key-value Bearer fixture.bearer-token https://files.example/f?X-Amz-Signature=fixture-signature',
          );
        },
      },
    );
    const leaked = /fixture-provider-key-value|fixture\.bearer-token|fixture-signature/;
    await assert.rejects(f.run(), (error: Error) => {
      assert.match(error.message, /private-provider-diagnostic/);
      assert.doesNotMatch(error.message, leaked);
      return true;
    });
    assert.equal(f.calls.length, 1);
    assert.deepEqual(f.modelResults, []);
  },
);

test(
  'cancellation during a provider wait prevents the next model action',
  { skip: !process.env.TEST_DATABASE_URL },
  async (t) => {
    const controller = new AbortController();
    const entered = deferred();
    const release = deferred();
    const f = await searchFixture(
      t,
      async (execute) => {
        await execute('cancelled', 'SEARCH_TOOLS', { query });
        assert.fail('Cancellation must prevent the next model action.');
      },
      {
        controller,
        search: async () => {
          entered.resolve();
          await release.promise;
          return searchResult;
        },
      },
    );
    const running = assert.rejects(f.run());
    await entered.promise;
    controller.abort();
    release.resolve();
    await running;
    assert.equal(f.searches.length, 1);
    assert.deepEqual(f.calls, []);
    assert.deepEqual(f.modelResults, []);
  },
);

function composioProxyFixture(
  client: Composio,
  ownerId = 'fixture-owner',
  overrides: Partial<ReturnType<typeof createComposioProxy>> = {},
): ReturnType<typeof createComposioProxy> {
  return {
    client,
    ownerId,
    userId: ownerId,
    configurationId: 'synthetic-proxy-configuration',
    origin: 'https://proxy.fixture.invalid',
    initialize: async () => {},
    ownsConnectionUrl: (url) => new URL(url).origin === 'https://proxy.fixture.invalid',
    connectionStatus: async () => ({ pairingConfirmed: false }),
    authorize: async () => assert.fail('Unexpected fixture consent.'),
    parseCallback: async () => assert.fail('Unexpected fixture callback.'),
    upload: async () => assert.fail('Unexpected fixture upload.'),
    isPendingAccount: () => false,
    ...overrides,
  };
}

async function managedReconnectFixture(t: TestContext, watchRequested = true, service = 'gmail') {
  const database = await hostedDatabase();
  const pool = database.pool;
  const app = Fastify();
  const client = new Composio({
    apiKey: 'fixture-key-never-live',
    baseURL: 'https://proxy.fixture.invalid',
    allowTracking: false,
    disableVersionCheck: true,
    fileUploadDirs: false,
  });
  const raw = client.getClient();
  const transport = raw.toolRouter.session;
  const ownerId = 'local-development';
  const authConfigId = `original-${service}-auth`;
  const remoteAccount = (id: string, status = 'ACTIVE') => ({
    id,
    user_id: ownerId,
    toolkit: { slug: service },
    auth_config: {
      id: authConfigId,
      auth_scheme: 'OAUTH2',
      is_composio_managed: false,
      is_disabled: false,
    },
    status,
    status_reason: null,
    is_disabled: false,
    created_at: '2026-10-01T00:00:00.000Z',
    updated_at: '2026-10-07T00:00:00.000Z',
  });
  const accounts = new Map([['old-account', remoteAccount('old-account', 'EXPIRED')]]);
  const emails = new Map([['old-account', 'work@example.test']]);
  const configurations = new Map<string, Record<string, unknown>>();
  const links: Array<{ id: string; accountId: string; callback: URL }> = [];
  const removed: string[] = [];
  const unsubscribed: string[] = [];
  const subscribed: string[] = [];
  const executed: Array<{ action: string; account: string }> = [];
  const resumed: Array<{ turnId: string; service: string }> = [];
  const control = {
    pause: async (_phase: string, _id: string) => {},
    outlookMail: true,
  };
  t.mock.method(raw.toolkits, 'list', async () => ({ items: [], next_cursor: null }));
  t.mock.method(raw.authConfigs, 'list', async () => {
    assert.fail('Reconnect must retain the original auth config instead of selecting a default.');
  });
  t.mock.method(raw.authConfigs, 'retrieve', async () => {
    assert.fail('Reconnect must use the auth config bound to the original account.');
  });
  t.mock.method(raw.connectedAccounts, 'retrieve', async (id: string) => {
    await control.pause('account', id);
    const account = accounts.get(id);
    if (!account)
      throw Object.assign(new Error('synthetic-private-account-detail'), { status: 404 });
    return structuredClone(account);
  });
  t.mock.method(raw.connectedAccounts, 'delete', async (id: string) => {
    await control.pause('delete', id);
    removed.push(id);
    accounts.delete(id);
    return { success: true };
  });
  const snapshot = (id: string) => ({
    session_id: id,
    mcp: { type: 'http', url: `https://proxy.fixture.invalid/tool_router/mcp/${id}` },
    config: { user_id: ownerId, ...configurations.get(id) },
    config_version: 1,
  });
  let nextSession = 0;
  t.mock.method(transport, 'create', async (config: Record<string, unknown>) => {
    const id = `recovery-session-${++nextSession}`;
    configurations.set(id, config);
    await control.pause('create', id);
    return snapshot(id);
  });
  const authorize = async (slug: string, callbackUrl: string, reconnectAccountId?: string) => {
    assert.equal(slug, service);
    assert.equal(reconnectAccountId, 'old-account');
    const accountId = `replacement-${links.length + 1}`;
    accounts.set(accountId, remoteAccount(accountId, 'INITIATED'));
    emails.set(accountId, 'work@example.test');
    links.push({ id: `consent-${links.length + 1}`, accountId, callback: new URL(callbackUrl) });
    await control.pause('link', accountId);
    return {
      accountId,
      url: `https://proxy.fixture.invalid/connect/${accountId}`,
      verificationSecret: 'v'.repeat(43),
    };
  };
  t.mock.method(raw, 'delete', async (path: string) => {
    assert.match(path, /^\/api\/v3\.1\/tool_router\/session\//);
    const id = decodeURIComponent(path.split('/').at(-1)!);
    removed.push(id);
    return { session_id: id, deleted: true };
  });
  t.mock.method(transport, 'execute', async (id: string, input: Record<string, unknown>) => {
    const action = String(input.tool_slug);
    const account = String(input.account);
    const bindings = configurations.get(id)?.connected_accounts as Record<
      string,
      string | string[]
    >;
    const selected = bindings?.[service];
    assert.ok(typeof selected === 'string' ? selected === account : selected?.includes(account));
    executed.push({ action, account });
    const response = {
      data: action === 'GMAIL_GET_PROFILE' ? { emailAddress: emails.get(account) } : { labels: [] },
      error: null,
      log_id: 'synthetic-recovery-log',
      result_type: 'completed',
    };
    await control.pause('execute', account);
    return response;
  });
  const profiles: string[] = [];
  t.mock.method(
    client.tools,
    'proxyExecute',
    async (request: Parameters<typeof client.tools.proxyExecute>[0]) => {
      if (service !== 'outlook') throw new Error('No unverified identity fallback is available.');
      assert.equal(
        request.endpoint,
        'https://graph.microsoft.com/v1.0/me?$select=displayName,mail,userPrincipalName',
      );
      assert.equal(request.method, 'GET');
      const account = request.connectedAccountId!;
      assert.equal(accounts.get(account)?.user_id, ownerId);
      profiles.push(account);
      return {
        status: 200,
        data: {
          displayName: 'Work',
          mail: control.outlookMail ? emails.get(account) : null,
          userPrincipalName: emails.get(account),
        },
      };
    },
  );
  t.mock.method(client.tools, 'getRawComposioToolBySlug', async (slug: string) => ({
    slug,
    name: slug,
    tags: ['readOnlyHint'],
  }));
  t.mock.method(
    raw.triggerInstances,
    'upsert',
    async (_slug: string, input: { connected_account_id: string }) => {
      subscribed.push(input.connected_account_id);
      return { trigger_id: `trigger-${input.connected_account_id}` };
    },
  );
  t.mock.method(client.triggers, 'delete', async (id: string) => {
    unsubscribed.push(id);
  });
  const provider = createComposioProvider({
    proxy: composioProxyFixture(client, ownerId, {
      authorize,
      parseCallback: async (input, pending) => {
        assert.ok(pending);
        const query = input as Record<string, string>;
        return {
          state: query.state,
          accountId: query.connected_account_id ?? '',
          pendingAccountId: pending.accountId,
          success: query.status === 'success',
        };
      },
    }),
  });
  const integrations = await createIntegrations(pool, {
    ownerId,
    provider,
    baseUrl: 'http://localhost:4310',
    wake: async () => {},
    resumeConnection: async (turnId, service) => {
      resumed.push({ turnId, service });
      return true;
    },
  });
  integrations.registerRoutes(app);
  t.after(async () => {
    await app.close();
    await database.close();
  });
  const inserted = await pool.query<{ id: string }>(
    `INSERT INTO app_connections(owner_id,slug,account_id,provider_id,account_active,account_checked_at,
     account_email,account_name,watch_requested,watch_attempted,watch_revision,trigger_id,triggers_enabled,
     inbox_cursor,inbox_claim_id,inbox_failed,inbox_reconnect_required,configuration_id)
     VALUES($1,$4,'old-account','composio',false,now(),'work@example.test','Work', $2,true,7,
     NULL,false,'old-cursor','old-claim',true,true,$3) RETURNING id`,
    [ownerId, watchRequested, provider.configurationId, service],
  );
  const connectionId = inserted.rows[0].id;
  await pool.query(
    `INSERT INTO integration_events(id,owner_id,summary,slug,account_id,trigger_id,provider_id,poll_connection_id)
     VALUES('old-event',$1,'Synthetic old update',$3,'old-account','old-trigger','composio',$2)`,
    [ownerId, connectionId, service],
  );
  const row = async () =>
    (await pool.query('SELECT * FROM app_connections WHERE id=$1', [connectionId])).rows[0];
  const reconnect = (id = connectionId, slug = service) =>
    app.inject({ method: 'POST', url: `/api/apps/${slug}/connect`, payload: { connectionId: id } });
  const complete = async (link = links.at(-1)!, status = 'success', accountId = link.accountId) => {
    const url = new URL(link.callback);
    url.searchParams.set('connected_account_id', accountId);
    url.searchParams.set('status', status);
    const response = await app.inject({ url: `${url.pathname}${url.search}` });
    assert.equal(response.statusCode, 302);
    return new URL(response.headers.location!).searchParams.get('connection');
  };
  const disconnect = () =>
    app.inject({ method: 'POST', url: `/api/apps/${service}/accounts/${connectionId}/disconnect` });
  return {
    app,
    pool,
    provider,
    integrations,
    accounts,
    emails,
    control,
    configurations,
    profiles,
    links,
    removed,
    unsubscribed,
    subscribed,
    executed,
    resumed,
    ownerId,
    authConfigId,
    connectionId,
    row,
    reconnect,
    complete,
    disconnect,
  };
}

test(
  'Outlook reconnect keeps the verified Graph identity when mail is present or null',
  { skip: !process.env.TEST_DATABASE_URL },
  async (t) => {
    for (const mail of [true, false])
      await t.test(mail ? 'mail' : 'user principal name', async (t) => {
        const f = await managedReconnectFixture(t, false, 'outlook');
        f.control.outlookMail = mail;
        f.accounts.get('old-account')!.status = 'ACTIVE';
        const identity = await f.provider.inspectAccount('old-account', f.ownerId, {
          verifyOwner: true,
        });
        assert.equal(identity.accountEmail, 'work@example.test');
        assert.equal(identity.accountName, 'Work');
        assert.deepEqual(f.profiles, ['old-account']);
        f.accounts.get('old-account')!.status = 'EXPIRED';
        const mismatch = await f.reconnect();
        assert.equal(mismatch.statusCode, 200, mismatch.body);
        const different = f.links.at(-1)!;
        f.accounts.get(different.accountId)!.status = 'ACTIVE';
        f.emails.set(different.accountId, 'different@example.test');
        assert.equal(await f.complete(different), 'failed');
        assert.equal((await f.row()).account_id, 'old-account');
        assert.equal((await f.row()).account_email, identity.accountEmail);
        const response = await f.reconnect();
        assert.equal(response.statusCode, 200, response.body);
        const attempt = f.links.at(-1)!;
        f.accounts.get(attempt.accountId)!.status = 'ACTIVE';
        assert.equal(await f.complete(attempt), 'connected');
        assert.equal((await f.row()).account_email, identity.accountEmail);
        assert.equal((await f.row()).account_id, attempt.accountId);
        assert.deepEqual(f.profiles, ['old-account', different.accountId, attempt.accountId]);
        assert.deepEqual(f.executed, []);
      });
  },
);

test(
  'managed reconnect preserves the owned connection and watch preference until matching consent completes',
  { skip: !process.env.TEST_DATABASE_URL },
  async (t) => {
    for (const [watch, active, storedEmail] of [
      [false, false, true],
      [true, false, true],
      [true, true, true],
      [false, true, false],
    ])
      await t.test(`watch ${watch}, active ${active}, stored email ${storedEmail}`, async (t) => {
        const f = await managedReconnectFixture(t, watch);
        f.accounts.get('old-account')!.status = active ? 'ACTIVE' : 'EXPIRED';
        await f.pool.query('UPDATE app_connections SET turn_id=$2,account_active=$3 WHERE id=$1', [
          f.connectionId,
          randomUUID(),
          active,
        ]);
        if (!storedEmail)
          await f.pool.query('UPDATE app_connections SET account_email=NULL WHERE id=$1', [
            f.connectionId,
          ]);
        const before = await f.row();
        const saved = (await f.integrations.list()).find(
          (row) => row.connectionId === f.connectionId,
        )!;
        assert.equal(saved.canReconnect, true);
        assert.equal(saved.reconnectRequired, true);
        assert.equal(saved.status, active ? 'connected' : 'disconnected');
        assert.equal(connectedGmail(saved), active);
        const response = await f.reconnect();
        assert.equal(response.statusCode, 200, response.body);
        assert.deepEqual(response.json().account, { name: 'Work', email: 'work@example.test' });
        assert.doesNotMatch(response.body, /original-gmail-auth|old-account|private/);
        const pending = await f.row();
        for (const key of [
          'id',
          'account_id',
          'provider_id',
          'watch_requested',
          'watch_revision',
          'trigger_id',
          'inbox_cursor',
        ])
          assert.equal(pending[key], before[key], key);
        assert.equal(
          (await f.pool.query('SELECT count(*) FROM app_connections')).rows[0].count,
          '1',
        );
        assert.equal(f.accounts.has('old-account'), true);
        assert.equal(f.removed.includes('old-account'), false);
        assert.deepEqual(f.unsubscribed, []);
        assert.deepEqual(f.subscribed, []);
        const link = f.links.at(-1)!;
        f.accounts.get(link.accountId)!.status = 'ACTIVE';
        assert.equal(await f.complete(link), 'connected');
        const after = await f.row();
        assert.equal(after.id, f.connectionId);
        assert.equal(after.account_id, link.accountId);
        assert.equal(after.provider_id, 'composio');
        assert.equal(after.account_email, 'work@example.test');
        assert.equal(after.account_active, true);
        assert.equal(after.watch_requested, watch);
        assert.deepEqual(f.resumed, []);
        assert.ok(after.watch_revision > before.watch_revision);
        for (const key of [
          'pending_account_id',
          'callback_hash',
          'callback_expires',
          'inbox_cursor',
          'inbox_claim_id',
        ])
          assert.equal(after[key], null, key);
        assert.equal(after.inbox_failed, false);
        assert.equal(after.inbox_reconnect_required, false);
        assert.equal(
          (await f.integrations.list()).find((row) => row.connectionId === f.connectionId)
            ?.reconnectRequired,
          false,
        );
        assert.deepEqual(f.unsubscribed, []);
        assert.deepEqual(f.subscribed, []);
        assert.equal(after.trigger_id, null);
        assert.deepEqual(
          (await f.pool.query('SELECT state,poll_connection_id FROM integration_events')).rows,
          [{ state: 'discarded', poll_connection_id: f.connectionId }],
        );
        await f.integrations.execute(f.ownerId, 'GMAIL_LIST_LABELS', {
          connectionId: f.connectionId,
          user_id: 'me',
        });
        assert.deepEqual(f.executed.at(-1), {
          action: 'GMAIL_LIST_LABELS',
          account: link.accountId,
        });
        assert.equal(await f.complete(link), 'expired');
        assert.equal((await f.row()).account_id, link.accountId);
      });
  },
);

test(
  'managed reconnect consumes rejected consent without replacing the saved account or its watches',
  { skip: !process.env.TEST_DATABASE_URL },
  async (t) => {
    for (const kind of [
      'owner',
      'missing-owner',
      'id',
      'toolkit',
      'auth-config',
      'disabled-auth',
      'disabled-account',
      'inactive',
      'identity',
      'missing-identity',
      'callback-id',
      'cancelled',
      'failed',
      'expired',
      'already-saved',
    ] as const)
      await t.test(kind, async (t) => {
        const f = await managedReconnectFixture(t);
        const before = await f.row();
        assert.equal((await f.reconnect()).statusCode, 200);
        const link = f.links.at(-1)!;
        const account = f.accounts.get(link.accountId)!;
        account.status = 'ACTIVE';
        if (kind === 'owner') account.user_id = 'foreign-owner';
        if (kind === 'missing-owner') Reflect.deleteProperty(account, 'user_id');
        if (kind === 'id') account.id = 'unrelated-account';
        if (kind === 'toolkit') account.toolkit.slug = 'googledrive';
        if (kind === 'auth-config') account.auth_config.id = 'different-auth';
        if (kind === 'disabled-auth') account.auth_config.is_disabled = true;
        if (kind === 'disabled-account') account.is_disabled = true;
        if (kind === 'inactive') account.status = 'INITIATED';
        if (kind === 'identity') f.emails.set(link.accountId, 'other@example.test');
        if (kind === 'missing-identity') f.emails.delete(link.accountId);
        if (kind === 'expired')
          await f.pool.query(
            "UPDATE app_connections SET callback_expires=now()-interval '1 minute' WHERE id=$1",
            [f.connectionId],
          );
        if (kind === 'already-saved')
          await f.pool.query(
            `INSERT INTO app_connections(owner_id,slug,account_id,provider_id,account_email,account_active)
         VALUES($1,'gmail',$2,'composio','work@example.test',true)`,
            [f.ownerId, link.accountId],
          );
        const result = await f.complete(
          link,
          kind === 'cancelled' || kind === 'failed' ? kind : 'success',
          kind === 'callback-id' ? 'unrelated-account' : link.accountId,
        );
        assert.equal(
          result,
          kind === 'expired'
            ? 'expired'
            : kind === 'cancelled' || kind === 'failed'
              ? 'cancelled'
              : 'failed',
        );
        const after = await f.row();
        for (const key of [
          'id',
          'account_id',
          'provider_id',
          'watch_requested',
          'watch_revision',
          'trigger_id',
          'triggers_enabled',
          'inbox_cursor',
          'inbox_claim_id',
        ])
          assert.equal(after[key], before[key], key);
        assert.equal(f.accounts.has('old-account'), true);
        assert.equal(f.removed.includes('old-account'), false);
        const retained = ['owner', 'missing-owner', 'id', 'already-saved'].includes(kind);
        assert.equal(f.accounts.has(link.accountId), retained);
        assert.equal(f.removed.includes(link.accountId), !retained);
        assert.equal(f.removed.includes('unrelated-account'), false);
        assert.deepEqual(f.unsubscribed, []);
        assert.deepEqual(f.subscribed, []);
        assert.deepEqual(f.resumed, []);
        if (['owner', 'missing-owner', 'id', 'callback-id'].includes(kind))
          assert.deepEqual(f.executed, []);
        assert.equal(
          (await f.pool.query('SELECT state FROM integration_events')).rows[0].state,
          'queued',
        );
        assert.equal(await f.complete(link), 'expired');
        if (kind !== 'expired')
          for (const key of [
            'pending_account_id',
            'pending_account_email',
            'pending_auth_config_id',
            'callback_hash',
            'callback_expires',
          ])
            assert.equal(after[key], null, key);
      });
  },
);

test(
  'managed reconnect cannot revive an account disconnected during authorization or completion',
  { skip: !process.env.TEST_DATABASE_URL },
  async (t) => {
    for (const phase of ['link', 'execute'] as const)
      await t.test(phase, async (t) => {
        const f = await managedReconnectFixture(t);
        const entered = deferred();
        const release = deferred();
        f.control.pause = async (current, accountId) => {
          if (current !== phase || accountId !== 'replacement-1') return;
          entered.resolve();
          await release.promise;
        };
        let inflight: Promise<unknown>;
        if (phase === 'link')
          inflight = f.reconnect().then((response) => {
            assert.equal(response.statusCode, 409, response.body);
          });
        else {
          assert.equal((await f.reconnect()).statusCode, 200);
          f.accounts.get('replacement-1')!.status = 'ACTIVE';
          inflight = f.complete().then((result) => assert.equal(result, 'failed'));
        }
        await entered.promise;
        const response = await f.disconnect();
        assert.equal(response.statusCode, 200, response.body);
        release.resolve();
        await inflight;
        assert.equal(await f.row(), undefined);
        assert.equal(await f.complete(f.links[0]), 'expired');
        assert.deepEqual(f.subscribed, []);
        assert.equal(f.accounts.has('old-account'), false);
        assert.equal(f.accounts.has(f.links[0].accountId), false);
      });
  },
);

test(
  'managed reconnect from the agent requires an explicit owned connection and resumes only its waiting turn',
  { skip: !process.env.TEST_DATABASE_URL },
  async (t) => {
    const f = await managedReconnectFixture(t);
    const turn = { threadId: randomUUID(), turnId: randomUUID() };
    for (const [action, newAccount, connectionId] of [
      ['list', undefined, f.connectionId],
      ['discover', undefined, f.connectionId],
      ['connect', true, f.connectionId],
      ['connect', undefined, 'not-a-uuid'],
      ['connect', undefined, randomUUID()],
    ] as const)
      await assert.rejects(
        f.integrations.manageConnections(
          action,
          'gmail',
          turn,
          undefined,
          newAccount,
          undefined,
          connectionId,
        ),
      );
    assert.equal(f.links.length, 0);
    const response = await f.integrations.manageConnections(
      'connect',
      'gmail',
      turn,
      undefined,
      undefined,
      undefined,
      f.connectionId,
    );
    assert.match(
      JSON.stringify(response),
      /https:\/\/proxy\.fixture\.invalid\/connect\/replacement-1/,
    );
    assert.ok(response && !Array.isArray(response) && 'account' in response);
    assert.deepEqual(response.account, { name: 'Work', email: 'work@example.test' });
    assert.ok('operation' in response);
    assert.equal(response.operation, 'reconnect');
    assert.doesNotMatch(JSON.stringify(response), /original-gmail-auth|old-account|private/);
    assert.equal((await f.row()).id, f.connectionId);
    assert.equal((await f.row()).turn_id, turn.turnId);
    assert.equal((await f.pool.query('SELECT count(*) FROM app_connections')).rows[0].count, '1');
    const link = f.links[0];
    f.accounts.get(link.accountId)!.status = 'ACTIVE';
    assert.equal(await f.complete(link), 'continued');
    assert.deepEqual(f.resumed, [{ turnId: turn.turnId, service: 'gmail' }]);
    assert.equal(await f.complete(link), 'expired');
    assert.equal(f.resumed.length, 1);
  },
);

test(
  'adding another Gmail account uses proxy consent without changing the pinned execution account',
  { skip: !process.env.TEST_DATABASE_URL },
  async (t) => {
    const database = await hostedDatabase();
    const pool = database.pool;
    const app = Fastify();
    t.after(async () => {
      await app.close();
      await database.close();
    });
    const client = new Composio({
      apiKey: 'fixture-key-never-live',
      baseURL: 'https://proxy.fixture.invalid',
      allowTracking: false,
      disableVersionCheck: true,
      fileUploadDirs: false,
    });
    t.mock.method(client.getClient().toolkits, 'list', async () => ({
      items: [],
      next_cursor: null,
    }));
    t.mock.method(client.getClient().authConfigs, 'list', async () =>
      assert.fail('Project authentication belongs to the proxy.'),
    );
    t.mock.method(client.connectedAccounts, 'delete', async () =>
      assert.fail('Consent must not remove an existing account.'),
    );
    const execution = t.mock.fn(
      async (_action: string, _args: unknown, selected: { account: string }) => {
        assert.equal(selected.account, 'existing-account');
        return { data: { labels: [] }, error: null, resultType: 'completed' };
      },
    );
    const created = t.mock.method(
      client.sessions,
      'create',
      async (owner: string, config: { connectedAccounts: unknown }) => {
        assert.equal(owner, 'local-development');
        assert.deepEqual(config.connectedAccounts, { gmail: ['existing-account'] });
        return { sessionId: 'execution-session', execute: execution };
      },
    );
    t.mock.method(client.sessions, 'delete', async () => {});
    const links: Array<{ accountId: string; callback: URL }> = [];
    let failed = false;
    const provider = createComposioProvider({
      proxy: composioProxyFixture(client, 'local-development', {
        authorize: async (service, callbackUrl, reconnectAccountId) => {
          assert.equal(service, 'gmail');
          assert.equal(reconnectAccountId, undefined);
          if (failed) throw new Error('synthetic-private-provider-detail');
          const accountId = `new-account-${links.length + 1}`;
          links.push({ accountId, callback: new URL(callbackUrl) });
          return {
            accountId,
            url: `https://proxy.fixture.invalid/connect/${accountId}`,
            verificationSecret: 'v'.repeat(43),
          };
        },
      }),
    });
    const integrations = await createIntegrations(pool, {
      ownerId: 'local-development',
      provider,
      baseUrl: 'http://localhost:4310',
      wake: async () => {},
    });
    integrations.registerRoutes(app);
    const account = await pool.query<{ id: string }>(
      `INSERT INTO app_connections(owner_id,slug,account_id,provider_id,account_active,account_checked_at,configuration_id)
       VALUES('local-development','gmail','existing-account','composio',true,now(),$1) RETURNING id`,
      [provider.configurationId],
    );
    const connect = () => app.inject({ method: 'POST', url: '/api/apps/gmail/connect' });
    const response = await connect();
    assert.equal(response.statusCode, 200, response.body);
    assert.equal(response.json().url, 'https://proxy.fixture.invalid/connect/new-account-1');
    assert.equal(
      created.mock.callCount(),
      0,
      'Consent never opens an execution session with the saved account.',
    );
    assert.equal(links[0].callback.pathname, '/api/apps/callback');
    assert.match(links[0].callback.searchParams.get('state')!, /^[A-Za-z0-9_-]{43}$/);
    assert.deepEqual(
      (
        await pool.query(
          'SELECT account_id,revoked,pending_account_id FROM app_connections WHERE id=$1',
          [account.rows[0].id],
        )
      ).rows,
      [{ account_id: 'existing-account', revoked: false, pending_account_id: null }],
    );
    await integrations.execute('local-development', 'GMAIL_LIST_LABELS', {
      connectionId: account.rows[0].id,
      user_id: 'me',
    });
    assert.equal(execution.mock.callCount(), 1);
    failed = true;
    const rejected = await connect();
    assert.equal(rejected.statusCode, 502);
    assert.doesNotMatch(rejected.body, /synthetic-private/);
    assert.equal(links.length, 1);
    assert.equal((await pool.query('SELECT id FROM app_connections')).rowCount, 2);
  },
);

test(
  'manual MCP setup validates destinations and keeps proposals scoped to their owner',
  { skip: !process.env.TEST_DATABASE_URL },
  async (t) => {
    const schema = `test_manual_mcp_${randomUUID().replaceAll('-', '')}`;
    const admin = new pg.Pool({ connectionString: process.env.TEST_DATABASE_URL });
    await admin.query(`CREATE SCHEMA ${schema}`);
    const pool = new pg.Pool({
      connectionString: process.env.TEST_DATABASE_URL,
      options: `-c search_path=${schema}`,
    });
    const app = Fastify();
    const foreign = Fastify();
    t.after(async () => {
      await app.close();
      await foreign.close();
      await pool.end();
      await admin.query(`DROP SCHEMA ${schema} CASCADE`);
      await admin.end();
    });
    const ownerId = 'fixture-mcp-owner';
    const key = randomBytes(32);
    const keyStore = { id: 'fixture', configured: true, getKey: async () => key };
    const grantVault = await createAppGrantVault(pool, { ownerId, keyStore });
    const transport = createDiscoveredTransport(async () => {
      throw new Error('Proposal creation must not call the remote server.');
    });
    const authorizations: Array<{ endpoint: string; clientId?: string }> = [];
    const oauth: Parameters<typeof createDiscoveredConnections>[1]['oauth'] = {
      async begin(endpoint, redirectUri, _state, _scope, clientId) {
        authorizations.push({ endpoint, clientId });
        return {
          url: 'https://authorization.example.test/consent',
          saved: { redirectUri, clientInformation: { client_id: clientId! } },
        };
      },
      async finish() {
        throw new Error('The fixture must not finish OAuth.');
      },
      async refresh() {
        throw new Error('The fixture must not refresh OAuth.');
      },
    };
    const options = {
      ownerId,
      baseUrl: 'http://localhost:4310',
      grantVault,
      transport,
      oauth,
    };
    (await createDiscoveredConnections(pool, options)).registerRoutes(app);
    const create = (payload: Record<string, unknown>) =>
      app.inject({ method: 'POST', url: '/api/apps/mcp', payload });
    const input = { name: 'Fixture MCP', endpoint: 'https://93.184.216.34/mcp', auth: 'oauth' };
    for (const endpoint of [
      'https://127.0.0.1/mcp',
      'https://192.168.1.1/mcp',
      'http://93.184.216.34/mcp',
      'https://93.184.216.34/mcp?token=synthetic',
      'https://93.184.216.34/mcp#secret',
      'https://user:synthetic@93.184.216.34/mcp',
    ]) {
      const response = await create({ ...input, endpoint });
      assert.equal(response.statusCode, 400, response.body);
    }
    for (const auth of ['bearer', 'x-api-key']) {
      const rejected = await create({ ...input, auth, clientIdRequired: true });
      assert.equal(rejected.statusCode, 400, rejected.body);
    }
    assert.equal((await create({ ...input, clientIdRequired: 'true' })).statusCode, 400);
    assert.equal((await create({ ...input, ownerId: 'foreign-owner' })).statusCode, 400);
    assert.equal((await pool.query('SELECT id FROM discovered_connection_proposals')).rowCount, 0);
    const response = await create(input);
    assert.equal(response.statusCode, 200, response.body);
    assert.equal(response.headers['cache-control'], 'no-store');
    const { id } = response.json();
    const saved = (
      await pool.query(
        'SELECT owner_id,paths,turn_id,callback_return_to FROM discovered_connection_proposals WHERE id=$1',
        [id],
      )
    ).rows[0];
    assert.equal(saved.owner_id, ownerId);
    assert.equal(saved.turn_id, null);
    assert.equal(saved.callback_return_to, 'apps');
    assert.deepEqual(saved.paths, [{ id, kind: 'mcp', endpoint: input.endpoint, auth: 'oauth' }]);
    assert.equal((await app.inject({ url: `/api/apps/discovery/${id}` })).statusCode, 200);
    (
      await createDiscoveredConnections(pool, { ...options, ownerId: 'foreign-owner' })
    ).registerRoutes(foreign);
    assert.equal((await foreign.inject({ url: `/api/apps/discovery/${id}` })).statusCode, 404);
    assert.equal(
      (
        await foreign.inject({
          method: 'POST',
          url: `/api/apps/discovery/${id}/complete`,
          payload: { token: 'synthetic-token', accountName: 'Foreign account' },
        })
      ).statusCode,
      404,
    );
    const registered = await create({
      ...input,
      endpoint: 'HTTPS://93.184.216.34/registered',
      clientIdRequired: true,
    });
    assert.equal(registered.statusCode, 200, registered.body);
    const registeredId = registered.json().id;
    const setup = await app.inject({ url: `/api/apps/discovery/${registeredId}` });
    assert.equal(setup.statusCode, 200, setup.body);
    assert.deepEqual(setup.json().paths, [
      {
        kind: 'mcp',
        endpoint: 'https://93.184.216.34/registered',
        auth: 'oauth',
        clientIdRequired: true,
      },
    ]);
    assert.equal(setup.json().callbackUrl, 'http://127.0.0.1:4310/api/apps/callback');
    const authorize = (server: typeof app, payload: Record<string, unknown>) =>
      server.inject({
        method: 'POST',
        url: `/api/apps/discovery/${registeredId}/authorize`,
        payload,
      });
    assert.equal((await authorize(app, {})).statusCode, 400);
    assert.equal((await authorize(foreign, { clientId: 'synthetic-client' })).statusCode, 404);
    assert.equal(authorizations.length, 0);
    const started = await authorize(app, { clientId: 'synthetic-client' });
    assert.equal(started.statusCode, 200, started.body);
    assert.deepEqual(authorizations, [
      { endpoint: 'https://93.184.216.34/registered', clientId: 'synthetic-client' },
    ]);
    assert.equal(started.json().url, 'https://authorization.example.test/consent');
    for (const auth of ['oauth', 'bearer', 'x-api-key']) {
      const ordinary = await create({
        ...input,
        endpoint: `HTTPS://93.184.216.34/${auth}`,
        auth,
        clientIdRequired: false,
      });
      assert.equal(ordinary.statusCode, 200, ordinary.body);
      const view = await app.inject({ url: `/api/apps/discovery/${ordinary.json().id}` });
      assert.equal(view.statusCode, 200, view.body);
      assert.deepEqual(view.json().paths, [
        { kind: 'mcp', endpoint: `https://93.184.216.34/${auth}`, auth },
      ]);
      assert.equal(Object.hasOwn(view.json(), 'callbackUrl'), false);
    }
    assert.equal((await pool.query('SELECT id FROM discovered_connections')).rowCount, 0);
  },
);

test(
  'discovered setup preserves owned paths, scoped discovery and account replacement',
  { skip: !process.env.TEST_DATABASE_URL },
  async () => {
    const schema = `test_discovery_${randomUUID().replaceAll('-', '')}`;
    const admin = new pg.Pool({ connectionString: process.env.TEST_DATABASE_URL });
    await admin.query(`CREATE SCHEMA ${schema}`);
    const pool = new pg.Pool({
      connectionString: process.env.TEST_DATABASE_URL,
      options: `-c search_path=${schema}`,
    });
    const app = Fastify();
    try {
      const owner = 'fixture-owner';
      const key = randomBytes(32);
      const keyStore = { id: 'fixture', configured: true, getKey: async () => key };
      const grantVault = await createAppGrantVault(pool, { ownerId: owner, keyStore });
      const catalogs: string[] = [];
      let cliCalls = 0;
      let cliExitCode: number | undefined;
      const cliRuns: unknown[] = [];
      let blocked: 'http' | 'listTools' | 'callTool' | 'cli' | undefined;
      let entered = () => {};
      const waitForAbort = async (method: typeof blocked, signal?: AbortSignal) => {
        if (blocked !== method) return;
        assert.ok(signal);
        signal.throwIfAborted();
        entered();
        await new Promise<void>((_resolve, reject) => {
          signal.addEventListener('abort', () => reject(signal.reason), { once: true });
        });
      };
      const discovered = await createDiscoveredConnections(pool, {
        ownerId: owner,
        baseUrl: 'http://localhost:4310',
        grantVault,
        transport: {
          validateEndpoint: async (endpoint) => endpoint,
          http: async (_endpoint, _headers, method, _body, signal) => {
            await waitForAbort('http', signal);
            assert.equal(method, 'GET');
            return { status: 200, body: { items: [] } };
          },
          listTools: async (endpoint, _headers, signal) => {
            await waitForAbort('listTools', signal);
            catalogs.push(endpoint);
            return {
              tools: [
                {
                  name: 'list_records',
                  inputSchema: { type: 'object' },
                  annotations: { readOnlyHint: true },
                },
                { name: 'find_user', description: 'Find a user by display name', inputSchema: {} },
                {
                  name: 'search_issues',
                  description: 'Search issues by text',
                  inputSchema: {
                    type: 'object',
                    properties: { query: { type: 'string' } },
                    required: ['query'],
                  },
                },
              ],
            };
          },
          callTool: async (_endpoint, _headers, _name, _input, signal) => {
            await waitForAbort('callTool', signal);
            return { content: [{ type: 'text', text: '[]' }] };
          },
        },
        oauth: {} as Parameters<typeof createDiscoveredConnections>[1]['oauth'],
        runCli: async (_thread, cli, _argv, _environment, _timeout, signal) => {
          cliCalls++;
          cliRuns.push(cli);
          await waitForAbort('cli', signal);
          if (cliExitCode !== undefined)
            return { exitCode: cliExitCode, output: 'Synthetic private CLI output' };
          throw new Error('The CLI must not run during setup.');
        },
      });
      const cliProposal = (source?: unknown) => ({
        service: 'fixture-app',
        name: 'Fixture app',
        paths: [{ kind: 'cli', command: 'fixturecli', env: ['FIXTURE_API_KEY'], source }],
      });
      for (const source of [
        undefined,
        { npm: '--registry=https://fixture.example' },
        { npm: './fixturecli' },
        { npm: 'file:../fixturecli' },
        { npm: 'fixturecli@file:/tmp/fixturecli' },
        { npm: 'fixturecli@link:../fixturecli' },
        { npm: '@scope/fixturecli@../fixturecli' },
        { npm: 'fixturecli@~/fixturecli' },
        { pypi: 'fixturecli; true' },
        { url: 'http://fixture.example/fixturecli' },
        { url: 'https://fixture.example/fixturecli', sha256: 'abc' },
        { npm: 'fixturecli', pypi: 'fixturecli' },
      ])
        await assert.rejects(discovered.propose(cliProposal(source)), { name: 'ZodError' });
      const cliSource = {
        url: 'https://fixture.example/releases/fixturecli_linux_amd64.tar.gz',
        sha256: 'a'.repeat(64),
      };
      const result = await discovered.propose(cliProposal(cliSource));
      const id = new URL(result.url, 'http://localhost:4310').searchParams.get('connect');
      const saved = await pool.query<{ paths: Array<{ id: string }> }>(
        'SELECT paths FROM discovered_connection_proposals WHERE id=$1',
        [id],
      );
      assert.equal(saved.rows[0].paths[0].id, id);
      const connectionId = randomUUID();
      const otherId = randomUUID();
      const foreignId = randomUUID();
      const httpPath = randomUUID();
      const mcpPath = randomUUID();
      const cliPath = randomUUID();
      const paths = [
        {
          id: httpPath,
          kind: 'http',
          endpoint: 'https://fixture.example/api',
          auth: 'bearer',
          testPath: 'records',
        },
        { id: mcpPath, kind: 'mcp', endpoint: 'https://fixture.example/mcp', auth: 'bearer' },
        {
          id: cliPath,
          kind: 'cli',
          command: 'fixturecli',
          auth: 'env',
          env: ['FIXTURE_API_KEY'],
          source: { npm: '@fixture/cli@1.2.3' },
        },
      ];
      for (const [accountId, accountOwner, accountPaths] of [
        [connectionId, owner, paths],
        [
          otherId,
          owner,
          [{ ...paths[1], id: randomUUID(), endpoint: 'https://other.example/mcp' }],
        ],
        [
          foreignId,
          'other-owner',
          [{ ...paths[1], id: randomUUID(), endpoint: 'https://foreign.example/mcp' }],
        ],
      ] as const) {
        await pool.query(
          'INSERT INTO discovered_connections(id,owner_id,service,name,account_name,paths) VALUES($1,$2,$3,$4,$5,$6)',
          [
            accountId,
            accountOwner,
            'fixture-app',
            'Fixture app',
            'Synthetic account',
            JSON.stringify(accountPaths),
          ],
        );
        if (accountOwner === owner) await grantVault.put(accountId, `synthetic-token-${accountId}`);
      }
      const ref = { threadId: randomUUID(), turnId: randomUUID() };
      const provider = fakeProvider({
        id: 'unused',
        authorize: async () => {
          throw new Error('No provider account may be opened.');
        },
        search: async () => {
          throw new Error('No native provider may be searched.');
        },
        execute: async () => {
          throw new Error('No native provider may be read.');
        },
      });
      provider.configured = false;
      const integrations = await createIntegrations(pool, {
        ownerId: owner,
        provider,
        discovered,
        baseUrl: 'http://localhost:4310',
        wake: async () => {},
      });
      integrations.registerRoutes(app);
      await pool.query('UPDATE discovered_connections SET reconnect_required=true WHERE id=$1', [
        connectionId,
      ]);
      const additional = await app.inject({
        method: 'POST',
        url: '/api/apps/fixture-app/connect',
        payload: { connectionId, newAccount: true },
      });
      assert.equal(additional.statusCode, 200, additional.body);
      const additionalId = new URL(additional.json().url, 'http://localhost:4310').searchParams.get(
        'connect',
      );
      const additionalProposal = (
        await pool.query('SELECT connection_id FROM discovered_connection_proposals WHERE id=$1', [
          additionalId,
        ])
      ).rows[0];
      assert.equal(additionalProposal.connection_id, null);
      assert.equal(
        (await pool.query('SELECT id FROM discovered_connections WHERE id=$1', [connectionId]))
          .rowCount,
        1,
      );
      await pool.query('UPDATE discovered_connections SET reconnect_required=false WHERE id=$1', [
        connectionId,
      ]);
      const setupPage = await app.inject({ url: `/api/apps/discovery/${id}` });
      assert.deepEqual(setupPage.json().paths[0].source, cliSource);
      const foreignProposal = randomUUID();
      const expiredProposal = randomUUID();
      for (const [proposalId, proposalOwner, expired] of [
        [foreignProposal, 'other-owner', false],
        [expiredProposal, owner, true],
      ] as const)
        await pool.query(
          `INSERT INTO discovered_connection_proposals(id,owner_id,service,name,paths,expires_at)
           SELECT $2,$3,service,name,paths,CASE WHEN $4 THEN now()-interval '1 second' ELSE expires_at END
           FROM discovered_connection_proposals WHERE id=$1`,
          [id, proposalId, proposalOwner, expired],
        );
      const setupHash = (proposalId: string) =>
        createHash('sha256').update(`/apps?connect=${proposalId}`).digest('hex');
      const proposalStatus = async (hashes: string[], connectionIds: string[]) => {
        const response = await app.inject({
          method: 'POST',
          url: '/api/apps/setup-status',
          payload: { hashes, connectionIds },
        });
        assert.equal(response.statusCode, 200);
        return response.json();
      };
      assert.ok(id);
      const visibleProposals = await proposalStatus(
        [setupHash(id), setupHash(foreignProposal), setupHash(expiredProposal), '0'.repeat(64)],
        [id, foreignProposal, expiredProposal, randomUUID()],
      );
      assert.deepEqual(visibleProposals.completed, []);
      assert.equal(visibleProposals.apps.length, 2);
      assert.deepEqual(
        visibleProposals.apps.find((row: { hash: string }) => row.hash === setupHash(id)),
        { hash: setupHash(id), slug: 'fixture-app', name: result.name },
      );
      assert.deepEqual(
        visibleProposals.apps.find(
          (row: { hash: string }) => row.hash === setupHash(expiredProposal),
        ),
        {
          hash: setupHash(expiredProposal),
          slug: 'fixture-app',
          name: result.name,
          available: false,
        },
      );
      const expiredLinkHash = createHash('sha256')
        .update('https://fixture.example/expired-authorization')
        .digest('hex');
      await pool.query(
        "UPDATE discovered_connection_proposals SET link_hash=$2,oauth_status='pending' WHERE id=$1",
        [expiredProposal, expiredLinkHash],
      );
      assert.deepEqual(await proposalStatus([expiredLinkHash], []), {
        completed: [],
        apps: [
          {
            hash: expiredLinkHash,
            slug: 'fixture-app',
            name: result.name,
            available: false,
          },
        ],
      });
      assert.equal(
        (await app.inject({ url: `/api/apps/discovery/${expiredProposal}` })).statusCode,
        404,
      );
      assert.equal(
        (
          await app.inject({
            method: 'POST',
            url: `/api/apps/discovery/${expiredProposal}/complete`,
            payload: { token: 'synthetic-expired-token', accountName: 'Expired fixture account' },
          })
        ).statusCode,
        404,
      );
      assert.deepEqual(await proposalStatus(['0'.repeat(64)], [id]), {
        completed: [],
        apps: [],
      });
      assert.deepEqual(catalogs, []);
      const cliSetup = await app.inject({
        method: 'POST',
        url: `/api/apps/discovery/${id}/complete`,
        payload: { token: 'synthetic-cli-token', accountName: 'Fixture CLI account' },
      });
      assert.equal(cliSetup.statusCode, 200);
      assert.deepEqual(await proposalStatus([setupHash(id)], [id]), {
        completed: [],
        apps: [],
      });
      assert.equal(cliCalls, 0);
      const addedCli = (await discovered.list()).find(
        (account) => account.accountName === 'Fixture CLI account',
      );
      assert.ok(addedCli?.connectionId);
      await discovered.disconnect(addedCli.connectionId, 'fixture-app');
      const inventory = await integrations.connectedApps();
      assert.deepEqual(
        new Set(inventory.map((item) => item.connectionId)),
        new Set([connectionId, otherId]),
      );
      assert.deepEqual(inventory.find((item) => item.connectionId === connectionId)?.access, [
        'http',
        'mcp',
        'cli',
      ]);
      assert.deepEqual(catalogs, []);
      const search = (await integrations.execute(
        owner,
        'SEARCH_TOOLS',
        { query: 'list_records', connectionId },
        ref,
        new AbortController().signal,
      )) as { accounts: Array<{ connectionId: string }> };
      assert.deepEqual(
        search.accounts.map((item) => item.connectionId),
        [connectionId],
      );
      assert.deepEqual(catalogs, ['https://fixture.example/mcp']);
      const sentence = (await integrations.execute(
        owner,
        'SEARCH_TOOLS',
        { query: 'please list the open records', connectionId },
        ref,
        new AbortController().signal,
      )) as {
        discovered: Array<{ paths: Array<{ id: string; tools?: Array<{ name: string }> }> }>;
      };
      assert.deepEqual(
        sentence.discovered[0].paths
          .find((item) => item.id === mcpPath)
          ?.tools?.map((tool) => tool.name),
        ['list_records'],
      );
      const onboardingQuery =
        'Fixture app recent activity messages events tasks projects documents';
      const scopedCatalog = await discovered.search(onboardingQuery, connectionId);
      const available = scopedCatalog.accounts[0].paths.find((path) => path.id === mcpPath);
      assert.ok(available && 'tools' in available);
      assert.deepEqual(
        available.tools.map((tool) => tool.name),
        ['list_records', 'find_user', 'search_issues'],
      );
      assert.deepEqual(available.tools.find((tool) => tool.name === 'search_issues')?.inputSchema, {
        type: 'object',
        properties: { query: { type: 'string' } },
        required: ['query'],
      });
      const missing = await discovered.search('unmatched lookup', connectionId);
      assert.deepEqual(
        missing.accounts[0].paths.flatMap((path) => ('tools' in path ? path.tools : [])),
        [],
      );
      assert.equal(cliCalls, 0);
      await assert.rejects(
        discovered.execute(
          'CONNECTED_MCP_CALL',
          { connectionId: foreignId, pathId: mcpPath, tool: 'list_records' },
          ref,
          new AbortController().signal,
        ),
        /unavailable/,
      );
      const mcpArgs = { connectionId, pathId: mcpPath, tool: 'list_records' };
      const cancellations: Array<
        [NonNullable<typeof blocked>, (signal: AbortSignal) => Promise<unknown>]
      > = [
        ['listTools', (signal) => discovered.search('list_records', otherId, signal)],
        ['callTool', (signal) => discovered.execute('CONNECTED_MCP_CALL', mcpArgs, ref, signal)],
        [
          'http',
          (signal) =>
            discovered.execute(
              'CONNECTED_HTTP',
              { connectionId, pathId: httpPath, method: 'GET', path: 'records' },
              ref,
              signal,
            ),
        ],
        [
          'cli',
          (signal) =>
            discovered.execute(
              'CONNECTED_CLI',
              { connectionId, pathId: cliPath, argv: ['list'] },
              ref,
              signal,
            ),
        ],
      ];
      for (const [method, start] of cancellations) {
        blocked = method;
        const started = new Promise<void>((resolve) => {
          entered = resolve;
        });
        const controller = new AbortController();
        const reason = new DOMException('Synthetic cancellation', 'AbortError');
        const outcome = assert.rejects(start(controller.signal), (error) => error === reason);
        await Promise.race([started, outcome]);
        controller.abort(reason);
        await outcome;
      }
      blocked = undefined;
      const unscopedCatalog = await discovered.search(onboardingQuery);
      assert.deepEqual(
        unscopedCatalog.accounts.flatMap((account) =>
          account.paths.flatMap((path) => ('tools' in path ? path.tools : [])),
        ),
        [],
      );
      assert.deepEqual(cliRuns, [
        { id: cliPath, command: 'fixturecli', source: { npm: '@fixture/cli@1.2.3' } },
      ]);
      const again = await discovered.reconnect('fixture-app', connectionId);
      const reproposed = await pool.query<{ paths: Array<{ kind: string; source?: unknown }> }>(
        'SELECT paths FROM discovered_connection_proposals WHERE id=$1',
        [new URL(again.url, 'http://localhost:4310').searchParams.get('connect')],
      );
      assert.deepEqual(reproposed.rows[0].paths.find((path) => path.kind === 'cli')?.source, {
        npm: '@fixture/cli@1.2.3',
      });
      const legacyId = randomUUID();
      const legacyPath = randomUUID();
      await pool.query(
        'INSERT INTO discovered_connections(id,owner_id,service,name,account_name,paths) VALUES($1,$2,$3,$4,$5,$6)',
        [
          legacyId,
          owner,
          'legacy-cli',
          'Legacy CLI',
          'Synthetic account',
          JSON.stringify([{ ...paths[2], id: legacyPath, source: undefined }]),
        ],
      );
      await grantVault.put(legacyId, 'synthetic-legacy-token');
      await assert.rejects(
        discovered.execute(
          'CONNECTED_CLI',
          { connectionId: legacyId, pathId: legacyPath, argv: ['list'] },
          ref,
          new AbortController().signal,
        ),
        /install source/,
      );
      await assert.rejects(discovered.reconnect('legacy-cli', legacyId), /set up this CLI again/);
      assert.equal(cliCalls, 1);
      await discovered.disconnect(legacyId, 'legacy-cli');
      for (const exitCode of [7, 0]) {
        cliExitCode = exitCode;
        assert.equal(
          (
            (await discovered.execute(
              'CONNECTED_CLI',
              { connectionId, pathId: cliPath, argv: ['list'] },
              ref,
            )) as { exitCode: number }
          ).exitCode,
          exitCode,
        );
      }

      const replacement = await discovered.propose({
        service: 'fixture-app',
        name: 'Fixture app',
        connectionId,
        paths: [{ kind: 'http', endpoint: 'https://fixture.example/new-api', testPath: 'records' }],
      });
      const proposalId = new URL(replacement.url, 'http://localhost:4310').searchParams.get(
        'connect',
      );
      const complete = () =>
        app.inject({
          method: 'POST',
          url: `/api/apps/discovery/${proposalId}/complete`,
          payload: { token: 'synthetic-new-token', accountName: 'Replacement account' },
        });
      const account = async () =>
        (await integrations.connectedApps(owner, true)).find(
          (item) => item.connectionId === connectionId,
        )?.accountId;
      const replacedAccount = await account();
      assert.ok(replacedAccount);
      assert.equal((await complete()).statusCode, 200);
      assert.equal((await complete()).statusCode, 404);
      assert.equal((await grantVault.read(connectionId)).value, 'synthetic-new-token');
      assert.notEqual(await account(), replacedAccount);
    } finally {
      await app.close();
      await pool.end();
      await admin.query(`DROP SCHEMA ${schema} CASCADE`);
      await admin.end();
    }
  },
);

test(
  'MCP catalog refresh keeps known tools available and drops disconnected accounts',
  { skip: !process.env.TEST_DATABASE_URL },
  async (t) => {
    const schema = `test_catalog_${randomUUID().replaceAll('-', '')}`;
    const admin = new pg.Pool({ connectionString: process.env.TEST_DATABASE_URL });
    await admin.query(`CREATE SCHEMA ${schema}`);
    const pool = new pg.Pool({
      connectionString: process.env.TEST_DATABASE_URL,
      options: `-c search_path=${schema}`,
    });
    let release!: () => void;
    const waiting = new Promise<void>((resolve) => {
      release = resolve;
    });
    try {
      const owner = 'fixture-owner';
      const connectionId = randomUUID();
      const key = randomBytes(32);
      const grantVault = await createAppGrantVault(pool, {
        ownerId: owner,
        keyStore: { id: 'fixture', configured: true, getKey: async () => key },
      });
      let refresh = false;
      let requests = 0;
      let entered!: () => void;
      const refreshing = new Promise<void>((resolve) => {
        entered = resolve;
      });
      const discovered = await createDiscoveredConnections(pool, {
        ownerId: owner,
        baseUrl: 'http://localhost:4310',
        grantVault,
        transport: {
          validateEndpoint: async (endpoint) => endpoint,
          http: async () => {
            throw new Error('The catalog must not run an HTTP action.');
          },
          callTool: async () => {
            throw new Error('The catalog must not run an MCP action.');
          },
          listTools: async () => {
            requests += 1;
            if (refresh) {
              entered();
              await waiting;
            }
            return {
              tools: [{ name: refresh ? 'new_tool' : 'known_tool', inputSchema: {} }],
            };
          },
        },
        oauth: {} as Parameters<typeof createDiscoveredConnections>[1]['oauth'],
      });
      await pool.query(
        'INSERT INTO discovered_connections(id,owner_id,service,name,account_name,paths) VALUES($1,$2,$3,$4,$5,$6)',
        [
          connectionId,
          owner,
          'fixture-app',
          'Fixture app',
          'Fixture account',
          JSON.stringify([{ id: randomUUID(), kind: 'mcp', endpoint: 'https://example.com/mcp' }]),
        ],
      );
      await grantVault.put(connectionId, 'synthetic-token');
      const first = await Promise.all([discovered.servers(), discovered.servers()]);
      assert.ok(first.every((servers) => servers[0].tools[0].name === 'known_tool'));
      assert.equal(requests, 1);
      const now = Date.now();
      t.mock.method(Date, 'now', () => now + 11 * 60_000);
      refresh = true;
      let returned = false;
      const next = discovered.servers().then((value) => {
        returned = true;
        return value;
      });
      await refreshing;
      await delay(0);
      assert.equal(returned, true);
      assert.equal((await next)[0].tools[0].name, 'known_tool');
      assert.equal((await discovered.servers())[0].tools[0].name, 'known_tool');
      assert.equal(requests, 2);
      release();
      await delay(0);
      assert.equal((await discovered.servers())[0].tools[0].name, 'new_tool');
      await pool.query('DELETE FROM discovered_connections WHERE id=$1', [connectionId]);
      assert.deepEqual(await discovered.servers(), []);
    } finally {
      release();
      await pool.end();
      await admin.query(`DROP SCHEMA ${schema} CASCADE`);
      await admin.end();
    }
  },
);

test(
  'a connected CLI receives each named setting and never shows their values',
  { skip: !process.env.TEST_DATABASE_URL },
  async () => {
    const schema = `test_discovered_cli_${randomUUID().replaceAll('-', '')}`;
    const admin = new pg.Pool({ connectionString: process.env.TEST_DATABASE_URL });
    await admin.query(`CREATE SCHEMA ${schema}`);
    const pool = new pg.Pool({
      connectionString: process.env.TEST_DATABASE_URL,
      options: `-c search_path=${schema}`,
    });
    const app = Fastify();
    try {
      const owner = 'fixture-owner';
      const key = randomBytes(32);
      const grantVault = await createAppGrantVault(pool, {
        ownerId: owner,
        keyStore: { id: 'fixture', configured: true, getKey: async () => key },
      });
      const environments: Array<Record<string, string>> = [];
      const discovered = await createDiscoveredConnections(pool, {
        ownerId: owner,
        baseUrl: 'http://localhost:4310',
        grantVault,
        transport: {} as Parameters<typeof createDiscoveredConnections>[1]['transport'],
        oauth: {} as Parameters<typeof createDiscoveredConnections>[1]['oauth'],
        runCli: async (_thread, _cli, _argv, environment) => {
          environments.push(environment);
          return {
            exitCode: 0,
            output: `signed in as ${Object.values(environment).join(' and ')}`,
          };
        },
      });
      discovered.registerRoutes(app);
      const cli = {
        kind: 'cli',
        command: 'fixturecli',
        env: ['FIXTURE_ACCESS_KEY_ID', 'FIXTURE_SECRET_ACCESS_KEY'],
        source: { npm: '@fixture/cli@1.2.3' },
      };
      await assert.rejects(
        discovered.propose({
          service: 'fixture-cloud',
          name: 'Fixture cloud',
          paths: [cli, { kind: 'http', endpoint: 'https://fixture.example/api', testPath: 'me' }],
        }),
        /its own connection/,
      );
      await assert.rejects(
        discovered.propose({
          service: 'fixture-cloud',
          name: 'Fixture cloud',
          paths: [{ ...cli, env: ['LD_PRELOAD'] }],
        }),
        { name: 'ZodError' },
      );
      const proposal = await discovered.propose({
        service: 'fixture-cloud',
        name: 'Fixture cloud',
        paths: [cli],
      });
      const id = new URL(proposal.url, 'http://localhost:4310').searchParams.get('connect');
      const complete = (token: unknown) =>
        app.inject({
          method: 'POST',
          url: `/api/apps/discovery/${id}/complete`,
          payload: { token, accountName: 'Fixture account' },
        });
      assert.equal((await complete('synthetic-single-token')).statusCode, 400);
      assert.equal((await complete({ FIXTURE_ACCESS_KEY_ID: 'synthetic-key-id' })).statusCode, 400);
      const values = {
        FIXTURE_ACCESS_KEY_ID: 'synthetic-key-id',
        FIXTURE_SECRET_ACCESS_KEY: 'synthetic-secret-key',
      };
      assert.equal((await complete(values)).statusCode, 200);
      const saved = await pool.query<{ id: string; paths: Array<{ id: string }> }>(
        'SELECT id,paths FROM discovered_connections WHERE owner_id=$1',
        [owner],
      );
      const result = await discovered.execute(
        'CONNECTED_CLI',
        { connectionId: saved.rows[0].id, pathId: saved.rows[0].paths[0].id, argv: ['whoami'] },
        { threadId: randomUUID(), turnId: randomUUID() },
        new AbortController().signal,
      );
      assert.deepEqual(environments, [values]);
      assert.equal(JSON.stringify(result).includes('synthetic-'), false);
      const single = await discovered.propose({
        service: 'fixture-tool',
        name: 'Fixture tool',
        paths: [{ ...cli, env: ['FIXTURE_TOKEN'] }],
      });
      const singleId = new URL(single.url, 'http://localhost:4310').searchParams.get('connect');
      assert.equal(
        (
          await app.inject({
            method: 'POST',
            url: `/api/apps/discovery/${singleId}/complete`,
            payload: { token: { FIXTURE_TOKEN: 'synthetic-tool-token' }, accountName: 'Tool' },
          })
        ).statusCode,
        200,
      );
      const tool = await pool.query<{ id: string; paths: Array<{ id: string }> }>(
        "SELECT id,paths FROM discovered_connections WHERE owner_id=$1 AND service='fixture-tool'",
        [owner],
      );
      await discovered.execute(
        'CONNECTED_CLI',
        { connectionId: tool.rows[0].id, pathId: tool.rows[0].paths[0].id, argv: ['whoami'] },
        { threadId: randomUUID(), turnId: randomUUID() },
        new AbortController().signal,
      );
      assert.deepEqual(environments.at(-1), { FIXTURE_TOKEN: 'synthetic-tool-token' });
    } finally {
      await app.close();
      await pool.end();
      await admin.query(`DROP SCHEMA ${schema} CASCADE`);
      await admin.end();
    }
  },
);

test(
  'discovered HTTP and MCP results keep files and failures but never the token',
  { skip: !process.env.TEST_DATABASE_URL },
  async (t) => {
    const schema = `test_discovered_failures_${randomUUID().replaceAll('-', '')}`;
    const admin = new pg.Pool({ connectionString: process.env.TEST_DATABASE_URL });
    await admin.query(`CREATE SCHEMA ${schema}`);
    const pool = new pg.Pool({
      connectionString: process.env.TEST_DATABASE_URL,
      options: `-c search_path=${schema}`,
    });
    t.after(async () => {
      await pool.end();
      await admin.query(`DROP SCHEMA ${schema} CASCADE`);
      await admin.end();
    });
    const owner = 'fixture-owner';
    const token = 'synthetic/secret token';
    const encoded = 'synthetic%2Fsecret%20token';
    const mixedCaseEncoded = 'synthetic%2fsecret%20token';
    const formEncoded = 'synthetic%2Fsecret+token';
    const key = randomBytes(32);
    const keyStore = { id: 'fixture', configured: true, getKey: async () => key };
    const grantVault = await createAppGrantVault(pool, { ownerId: owner, keyStore });
    const image = Buffer.from('synthetic agenda image');
    const toolCalls: unknown[] = [];
    const transport = createDiscoveredTransport(async (input, init) => {
      if (String(input) === 'https://fixture.example/api/records')
        return Response.json(
          { error: { code: 'invalid_field', detail: `Rejected ${encoded}` } },
          { status: 422 },
        );
      if (String(input) === 'https://fixture.example/api/files/agenda')
        return new Response(image, {
          headers: {
            'content-type': 'image/png',
            'content-disposition': 'attachment; filename="agenda.png"',
          },
        });
      if (String(input) === 'https://fixture.example/api/files/report')
        return new Response('month,total\nSeptember,42\n', {
          headers: {
            'content-type': 'text/csv',
            'content-disposition': 'attachment; filename="report.csv"',
          },
        });
      if (String(input) === 'https://fixture.example/api/files/log')
        return new Response('x'.repeat(20_000), { headers: { 'content-type': 'text/plain' } });
      if (String(input) === 'https://fixture.example/api/files/echo')
        return new Response(Buffer.from(`echo ${mixedCaseEncoded}`), {
          headers: { 'content-type': 'application/octet-stream' },
        });
      if (init?.method === 'GET') return new Response(null, { status: 405 });
      const message = JSON.parse(String(init?.body));
      if (message.id === undefined) return new Response(null, { status: 202 });
      if (message.method === 'tools/call') toolCalls.push(message.params.arguments);
      return Response.json({
        jsonrpc: '2.0',
        id: message.id,
        result:
          message.method === 'initialize'
            ? {
                protocolVersion: message.params.protocolVersion,
                capabilities: { tools: {} },
                serverInfo: { name: 'fixture', version: '1' },
              }
            : message.params.name === 'agenda'
              ? {
                  content: [
                    { type: 'text', text: 'Agenda attached' },
                    { type: 'image', data: image.toString('base64'), mimeType: 'image/png' },
                  ],
                }
              : {
                  isError: true,
                  content: [{ type: 'text', text: `Unknown record for ${formEncoded}` }],
                },
      });
    });
    const discovered = await createDiscoveredConnections(pool, {
      ownerId: owner,
      baseUrl: 'http://localhost:4310',
      grantVault,
      transport,
      oauth: {} as Parameters<typeof createDiscoveredConnections>[1]['oauth'],
    });
    const connectionId = randomUUID();
    const httpPath = randomUUID();
    const mcpPath = randomUUID();
    await pool.query(
      'INSERT INTO discovered_connections(id,owner_id,service,name,account_name,paths) VALUES($1,$2,$3,$4,$5,$6)',
      [
        connectionId,
        owner,
        'fixture-app',
        'Fixture app',
        'Synthetic account',
        JSON.stringify([
          {
            id: httpPath,
            kind: 'http',
            endpoint: 'https://fixture.example/api',
            auth: 'bearer',
            testPath: 'records',
          },
          { id: mcpPath, kind: 'mcp', endpoint: 'https://fixture.example/mcp', auth: 'bearer' },
        ]),
      ],
    );
    await grantVault.put(connectionId, token);
    const failure = (error: unknown) => (error instanceof Error ? error.message : '');
    await assert.rejects(
      discovered.execute('CONNECTED_HTTP', {
        connectionId,
        pathId: httpPath,
        method: 'GET',
        path: 'records',
      }),
      (error) => {
        assert.match(failure(error), /\(422\).*invalid_field.*Rejected \[redacted\]/);
        assert.doesNotMatch(failure(error), new RegExp(token));
        assert.ok(!failure(error).includes(encoded));
        return true;
      },
    );
    await assert.rejects(
      discovered.execute('CONNECTED_MCP_CALL', { connectionId, pathId: mcpPath, tool: 'find' }),
      (error) => {
        assert.match(failure(error), /Unknown record for \[redacted\]/);
        assert.doesNotMatch(failure(error), new RegExp(token));
        assert.ok(!failure(error).includes(formEncoded));
        return true;
      },
    );
    const get = (path: string) =>
      discovered.execute('CONNECTED_HTTP', { connectionId, pathId: httpPath, method: 'GET', path });
    assert.deepEqual(await get('files/agenda'), {
      status: 200,
      file: { name: 'agenda.png', mimeType: 'image/png', bytes: new Uint8Array(image) },
    });
    assert.deepEqual(await get('files/report'), {
      status: 200,
      file: {
        name: 'report.csv',
        mimeType: 'text/csv',
        bytes: new Uint8Array(Buffer.from('month,total\nSeptember,42\n')),
      },
    });
    assert.equal(
      ((await get('files/log')) as { file: { bytes: Uint8Array } }).file.bytes.byteLength,
      20_000,
    );
    assert.deepEqual(await get('files/echo'), {
      status: 200,
      file: {
        name: 'echo',
        mimeType: 'application/octet-stream',
        error: 'The file was withheld because it contains the connection credential.',
      },
    });
    const input = {
      query: 'roadmap',
      page_url: 'https://www.notion.so/team/synthetic-page',
      filters: { created_date_range: { start_date: '2026-01-01' } },
    };
    assert.deepEqual(
      await discovered.execute('CONNECTED_MCP_CALL', {
        connectionId,
        pathId: mcpPath,
        tool: 'agenda',
        input,
      }),
      {
        content: [
          { type: 'text', text: 'Agenda attached' },
          { name: 'image-2.png', mimeType: 'image/png', bytes: image },
        ],
      },
    );
    assert.deepEqual(toolCalls.at(-1), input);
  },
);

test('Composio paginates managed apps and native DCR MCPs with exact slugs for consent and tools', async (t) => {
  t.mock.method(globalThis, 'fetch', async () => assert.fail('Unexpected external request.'));
  const client = new Composio({
    apiKey: 'fixture-key-never-live',
    baseURL: 'https://proxy.fixture.invalid',
    allowTracking: false,
    disableVersionCheck: true,
    fileUploadDirs: false,
  });
  const item = (
    slug: string,
    schemes: string[] = ['OAUTH2'],
    logo?: unknown,
    authSchemes = schemes,
    categories?: unknown,
  ) => ({
    slug,
    name: slug,
    type: 'native',
    meta: {
      description: `Connect ${slug}`,
      ...(logo !== undefined ? { logo } : {}),
      ...(categories !== undefined ? { categories } : {}),
    },
    auth_schemes: authSchemes,
    composio_managed_auth_schemes: schemes,
  });
  const categories = [
    { id: 'meetings', name: ' Meetings ' },
    { id: 'duplicate', name: 'Meetings' },
    { id: 'empty', name: ' ' },
    { id: 'invalid', name: 42 },
    { id: 'long', name: 'x'.repeat(81) },
    { id: 'control', name: 'Category\u0000name' },
    { id: 'direction', name: 'Category\u202ename' },
    ...Array.from({ length: 40 }, (_, index) => ({
      id: `category_${index}`,
      name: `Group ${index}`,
    })),
  ];
  const gate = deferred();
  let catalogMode: 'mixed' | 'managed' | 'empty' = 'mixed';
  const listing = t.mock.method(
    client.getClient().toolkits,
    'list',
    async (input: { cursor?: string; type: string }, options: { signal: AbortSignal }) => {
      assert.equal(input.type, 'native');
      assert.equal(options.signal.aborted, false);
      await gate.promise;
      if (catalogMode === 'empty') return { items: [], next_cursor: null };
      if (catalogMode === 'managed')
        return {
          items: [
            item('managed_notes'),
            item('granola_mcp', [], undefined, ['DCR_OAUTH']),
            item('custom_app', []),
          ],
          next_cursor: null,
        };
      if (!input.cursor)
        return {
          items: [
            item(
              'granola_mcp',
              [],
              'https://logos.composio.dev/api/granola_mcp',
              ['DCR_OAUTH'],
              categories,
            ),
            item('private_api', [], undefined, ['API_KEY']),
            { ...item('custom_oauth', [], undefined, ['OAUTH2']), type: 'custom' },
            item('unconfigured_app', [], undefined, ['API_KEY']),
            item('router_disabled', [], undefined, ['BASIC']),
            item('router_missing', [], undefined, ['BEARER_TOKEN']),
            item('no_auth', [], undefined, ['NO_AUTH']),
            item('../invalid'),
            null,
            42,
            { ...item('invalid_name'), name: ' ' },
            { ...item('invalid_auth'), composio_managed_auth_schemes: 'OAUTH2' },
            { ...item('missing_meta'), meta: undefined },
            { ...item('invalid_meta'), meta: null },
            {
              ...item('invalid_description'),
              meta: { description: 42, logo: 'https://logos.composio.dev/api/notes' },
            },
            { ...item('long_description'), meta: { description: 'x'.repeat(1500) } },
          ],
          next_cursor: 'second-page',
        };
      assert.equal(input.cursor, 'second-page');
      return {
        items: [
          item(
            'granola_mcp',
            [],
            'https://logos.composio.dev/api/granola_mcp',
            ['dcr_oauth'],
            categories,
          ),
          item(
            'managed_notes',
            ['OAUTH2'],
            'https://assets.composio.dev/logos/notes.svg',
            ['OAUTH2'],
            { name: 'Not an array' },
          ),
          item('custom_app', []),
          ...[
            'https://user:credential@logos.composio.dev/api/notes',
            'https://logos.composio.dev/api/notes?token=private',
            'https://logos.composio.dev/api/notes#private',
            'https://logos.composio.dev.example.com/api/notes',
            'https://untrusted.example/logo.svg',
            42,
          ].map((logo, index) => item(`unsafe_logo_${index}`, ['OAUTH2'], logo)),
        ],
        next_cursor: null,
      };
    },
  );
  t.mock.method(client.getClient().authConfigs, 'list', async () => {
    assert.fail('The app must not provision project authentication.');
  });
  const authorize = t.mock.fn(async (slug: string) => {
    assert.equal(slug, 'granola_mcp');
    return {
      accountId: 'fixture-account',
      url: 'https://proxy.fixture.invalid/connect/fixture',
      verificationSecret: 'fixture-verification',
    };
  });
  const create = t.mock.method(client.sessions, 'create', async () => ({
    sessionId: 'fixture-session',
    search: async () => ({
      success: true,
      error: null,
      toolSchemas: {
        GRANOLA_MCP_SEARCH_NOTES: {
          toolSlug: 'GRANOLA_MCP_SEARCH_NOTES',
          toolkit: 'granola_mcp',
          inputSchema: { type: 'object' },
        },
      },
      results: [],
    }),
  }));
  const provider = createComposioProvider({
    proxy: composioProxyFixture(client, 'fixture-owner', { authorize }),
  });
  const first = provider.listServices!();
  const concurrent = provider.listServices!();
  gate.resolve();
  const [services, repeated] = await Promise.all([first, concurrent]);
  assert.deepEqual(services, repeated);
  assert.equal(listing.mock.callCount(), 2);
  assert.equal(services.filter((entry) => entry.slug === 'granola_mcp').length, 1);
  assert.ok(services.some((entry) => entry.slug === 'managed_notes'));
  assert.equal(
    services.some((entry) =>
      [
        'custom_app',
        'custom_oauth',
        'private_api',
        'unconfigured_app',
        'router_disabled',
        'router_missing',
        'no_auth',
        '../invalid',
        'invalid_name',
        'invalid_auth',
      ].includes(entry.slug),
    ),
    false,
  );
  for (const slug of ['missing_meta', 'invalid_meta', 'invalid_description']) {
    const service = services.find((entry) => entry.slug === slug);
    assert.ok(service);
    assert.equal(service.description, '');
  }
  assert.equal(
    services.find((entry) => entry.slug === 'invalid_description')?.logoUrl,
    'https://logos.composio.dev/api/notes',
  );
  assert.equal(
    services.find((entry) => entry.slug === 'long_description')?.description.length,
    1000,
  );
  assert.equal(
    services.find((entry) => entry.slug === 'granola_mcp')?.logoUrl,
    'https://logos.composio.dev/api/granola_mcp',
  );
  assert.equal(
    services.find((entry) => entry.slug === 'managed_notes')?.logoUrl,
    'https://assets.composio.dev/logos/notes.svg',
  );
  const unsafeLogos = services.filter((entry) => entry.slug.startsWith('unsafe_logo_'));
  assert.equal(unsafeLogos.length, 6);
  assert.ok(unsafeLogos.every((entry) => !entry.logoUrl));
  assert.deepEqual(services.find((entry) => entry.slug === 'granola_mcp')?.categories, [
    'Meetings',
    ...Array.from({ length: 11 }, (_, index) => `Group ${index}`),
  ]);
  assert.equal(services.find((entry) => entry.slug === 'managed_notes')?.categories, undefined);
  const accounts = { retired_mcp: ['owned-account'] };
  const session = await provider.createSession('fixture-owner', accounts);
  const [owner, configuration] = create.mock.calls[0]!.arguments as unknown as [
    string,
    { toolkits: string[]; connectedAccounts: typeof accounts },
  ];
  assert.equal(owner, 'fixture-owner');
  assert.deepEqual(configuration.connectedAccounts, accounts);
  assert.deepEqual(configuration.toolkits, ['retired_mcp']);
  await assert.rejects(session.authorize('granola_mcp', 'http://localhost:4310/api/apps/callback'));
  await assert.rejects(session.search('Find notes'));
  const authorization = await provider.createSession('fixture-owner', {});
  const authorizationConfig = create.mock.calls[1]!.arguments[1] as { toolkits: string[] };
  assert.ok(authorizationConfig.toolkits.includes('granola_mcp'));
  await authorization.authorize('granola_mcp', 'http://localhost:4310/api/apps/callback');
  await assert.rejects(
    authorization.authorize('private_api', 'http://localhost:4310/api/apps/callback'),
  );
  await assert.rejects(
    authorization.authorize('custom_oauth', 'http://localhost:4310/api/apps/callback'),
  );
  await assert.rejects(
    authorization.authorize('unconfigured_app', 'http://localhost:4310/api/apps/callback'),
  );
  await assert.rejects(
    authorization.authorize('no_auth', 'http://localhost:4310/api/apps/callback'),
  );
  assert.equal(authorize.mock.callCount(), 1);
  assert.deepEqual(Object.keys((await authorization.search('Find notes')).tools as object), [
    'GRANOLA_MCP_SEARCH_NOTES',
  ]);
  assert.equal(listing.mock.callCount(), 2);
  for (const mode of ['empty', 'managed'] as const) {
    catalogMode = mode;
    await createComposioProvider({ proxy: composioProxyFixture(client) }).listServices!();
  }
});

test(
  'Notion MCP catalog routes new connections to the official server and excludes the broken managed toolkit',
  { skip: !process.env.TEST_DATABASE_URL },
  async (t) => {
    t.mock.method(globalThis, 'fetch', async () => assert.fail('Unexpected external request.'));
    const database = await hostedDatabase();
    const app = Fastify();
    t.after(async () => {
      await app.close();
      await database.close();
    });
    const owner = 'fixture-owner';
    const endpoint = 'https://mcp.notion.com/mcp';
    const token = 'synthetic-notion-access-token';
    const client = new Composio({
      apiKey: 'fixture-key-never-live',
      baseURL: 'https://proxy.fixture.invalid',
      allowTracking: false,
      disableVersionCheck: true,
      fileUploadDirs: false,
    });
    t.mock.method(client.getClient().toolkits, 'list', async () => ({
      items: [
        {
          slug: 'notion_mcp',
          name: 'Notion MCP',
          type: 'native',
          meta: { description: 'Read Notion pages' },
          auth_schemes: ['DCR_OAUTH'],
          composio_managed_auth_schemes: [],
        },
      ],
      next_cursor: null,
    }));
    const provider = createComposioProvider({ proxy: composioProxyFixture(client, owner) });
    const removedManaged = t.mock.method(client.connectedAccounts, 'delete', async (id: string) => {
      assert.equal(id, 'synthetic-managed-notion');
    });
    const mcpCalls: Array<{ name: string; input: Record<string, unknown> }> = [];
    const request: typeof safeRemoteFetch = async (input, init) => {
      const value = new Request(input, init);
      assert.equal(value.url, endpoint);
      assert.equal(value.headers.get('authorization'), `Bearer ${token}`);
      if (value.method === 'GET') return new Response(null, { status: 405 });
      if (value.method === 'DELETE') return new Response(null, { status: 200 });
      const message = JSON.parse(await value.text());
      if (message.id === undefined) return new Response(null, { status: 202 });
      if (message.method === 'tools/call') {
        mcpCalls.push({ name: message.params.name, input: message.params.arguments });
      }
      return Response.json({
        jsonrpc: '2.0',
        id: message.id,
        result:
          message.method === 'initialize'
            ? {
                protocolVersion: message.params.protocolVersion,
                capabilities: { tools: {} },
                serverInfo: { name: 'synthetic-notion', version: '1' },
              }
            : message.method === 'tools/list'
              ? {
                  tools: [
                    {
                      name: 'notion-search',
                      inputSchema: {
                        type: 'object',
                        properties: { query: { type: 'string' } },
                        required: ['query'],
                      },
                    },
                    {
                      name: 'notion-fetch',
                      inputSchema: {
                        type: 'object',
                        properties: { id: { type: 'string' } },
                        required: ['id'],
                      },
                    },
                  ],
                }
              : { content: [{ type: 'text', text: 'Synthetic Notion page content' }] },
      });
    };
    const discovered = await createDiscoveredConnections(database.pool, {
      ownerId: owner,
      baseUrl: 'http://localhost:4310',
      grantVault: await createAppGrantVault(database.pool, {
        ownerId: owner,
        keyStore: installationKeyStore,
      }),
      transport: createDiscoveredTransport(request, async (value) => {
        assert.equal(value, endpoint);
        return value;
      }),
      oauth: {
        begin: async (value, redirectUri, state) => {
          assert.equal(value, endpoint);
          return {
            url: `https://notion.example.test/authorize?state=${state}`,
            saved: { redirectUri },
          };
        },
        finish: async (value, saved) => {
          assert.equal(value, endpoint);
          return { ...saved, tokens: { access_token: token, token_type: 'Bearer' } };
        },
        refresh: async () => assert.fail('A fresh token must not be refreshed.'),
      },
    });
    const integrations = await createIntegrations(database.pool, {
      ownerId: owner,
      provider,
      discovered,
      baseUrl: 'http://localhost:4310',
      wake: async () => {},
    });
    integrations.registerRoutes(app);
    const managed = await database.pool.query<{ id: string }>(
      `INSERT INTO app_connections(owner_id,slug,account_id,provider_id,account_active,configuration_id)
       VALUES($1,'notion_mcp','synthetic-managed-notion','composio',true,$2) RETURNING id`,
      [owner, provider.configurationId],
    );
    const catalog = (await app.inject({ url: '/api/apps/catalog' })).json<AppConnection[]>();
    assert.equal(
      catalog.some((service) => service.slug === 'notion_mcp'),
      false,
    );
    assert.equal(
      catalog.some((service) => service.slug === 'notion'),
      true,
    );
    const oldAccount = (await integrations.list(owner, { refresh: false })).find(
      (account) => account.connectionId === managed.rows[0].id,
    );
    assert.equal(oldAccount?.status, 'disconnected');
    assert.equal(oldAccount?.canReconnect, false);
    assert.equal(
      (await integrations.connectedApps(owner)).some(
        (account) => account.connectionId === managed.rows[0].id,
      ),
      false,
    );
    const staleReconnect = await app.inject({
      method: 'POST',
      url: '/api/apps/notion_mcp/connect',
      payload: { connectionId: managed.rows[0].id },
    });
    assert.equal(staleReconnect.statusCode, 409);
    const mistakenReconnect = await app.inject({
      method: 'POST',
      url: '/api/apps/notion/connect',
      payload: { connectionId: managed.rows[0].id },
    });
    assert.equal(mistakenReconnect.statusCode, 404);
    const started = await app.inject({ method: 'POST', url: '/api/apps/notion_mcp/connect' });
    assert.equal(started.statusCode, 200, started.body);
    const authorization = new URL(started.json().url);
    assert.equal(authorization.origin, 'https://notion.example.test');
    const callback = await app.inject({
      url: `/api/apps/callback?state=${authorization.searchParams.get('state')}&code=synthetic-code`,
    });
    assert.equal(new URL(callback.headers.location!).searchParams.get('connection'), 'connected');
    const afterConnect = await integrations.list(owner, { refresh: false });
    const legacyAfterConnect = afterConnect.find(
      (account) => account.connectionId === managed.rows[0].id,
    );
    assert.equal(legacyAfterConnect?.slug, 'notion_mcp');
    assert.equal(legacyAfterConnect?.accountId, 'synthetic-managed-notion');
    assert.equal(legacyAfterConnect?.status, 'disconnected');
    assert.equal(legacyAfterConnect?.canReconnect, false);
    const connected = afterConnect.find(
      (account) => account.slug === 'notion' && account.status === 'connected',
    );
    assert.ok(connected?.connectionId);
    const search = (await integrations.execute(owner, 'SEARCH_TOOLS', {
      connectionId: connected.connectionId,
      query: 'Notion page',
    })) as {
      discovered: Array<{
        connectionId: string;
        paths: Array<{ id: string; tools?: Array<{ name: string }> }>;
      }>;
    };
    const path = search.discovered.find(
      (account) => account.connectionId === connected.connectionId,
    )?.paths[0];
    assert.ok(path?.id);
    assert.deepEqual(
      path.tools?.map((tool) => tool.name),
      ['notion-search', 'notion-fetch'],
    );
    const read = await integrations.execute(owner, 'CONNECTED_MCP_CALL', {
      connectionId: connected.connectionId,
      pathId: path.id,
      tool: 'notion-fetch',
      input: { id: 'synthetic-page-id' },
    });
    assert.deepEqual(read, { content: [{ type: 'text', text: 'Synthetic Notion page content' }] });
    assert.deepEqual(mcpCalls, [{ name: 'notion-fetch', input: { id: 'synthetic-page-id' } }]);
    const removal = await app.inject({
      method: 'POST',
      url: `/api/apps/notion_mcp/accounts/${managed.rows[0].id}/disconnect`,
    });
    assert.equal(removal.statusCode, 200, removal.body);
    assert.equal(removedManaged.mock.callCount(), 1);
    const afterRemoval = await integrations.list(owner, { refresh: false });
    assert.equal(
      afterRemoval.some((account) => account.connectionId === managed.rows[0].id),
      false,
    );
    assert.equal(
      afterRemoval.some(
        (account) =>
          account.connectionId === connected.connectionId && account.status === 'connected',
      ),
      true,
    );
  },
);

test('account-bound Composio sessions search only owned toolkits without waiting for the catalog', async (t) => {
  const client = new Composio({
    apiKey: 'fixture-key-never-live',
    baseURL: 'https://proxy.fixture.invalid',
    allowTracking: false,
    disableVersionCheck: true,
    fileUploadDirs: false,
  });
  const gate = deferred();
  t.after(() => gate.resolve());
  const listing = t.mock.method(client.getClient().toolkits, 'list', async () => {
    await gate.promise;
    return { items: [], next_cursor: null };
  });
  const search = t.mock.fn(async (_input: unknown) => ({
    success: true,
    error: null,
    toolSchemas: {
      GMAIL_FETCH_EMAILS: {
        toolSlug: 'GMAIL_FETCH_EMAILS',
        toolkit: 'gmail',
        inputSchema: { type: 'object' },
      },
    },
    results: [],
  }));
  const create = t.mock.method(client.sessions, 'create', async () => ({
    sessionId: 'fixture-session',
    search,
  }));
  const provider = createComposioProvider({ proxy: composioProxyFixture(client) });
  const session = await provider.createSession(
    'fixture-owner',
    { gmail: ['owned-gmail-account'] },
    AbortSignal.timeout(1000),
  );
  assert.equal(listing.mock.callCount(), 0);
  assert.deepEqual(create.mock.calls[0]!.arguments[1], {
    toolkits: ['gmail'],
    connectedAccounts: { gmail: ['owned-gmail-account'] },
    multiAccount: {
      enable: true,
      maxAccountsPerToolkit: 10,
      requireExplicitSelection: true,
    },
    manageConnections: false,
    sandbox: { enable: false },
  });
  assert.deepEqual(
    Object.keys((await session.search('Find recent Gmail messages')).tools as object),
    ['GMAIL_FETCH_EMAILS'],
  );
  assert.deepEqual(search.mock.calls[0]!.arguments[0], {
    query: 'Find recent Gmail messages',
    toolkits: ['gmail'],
  });
});

test('large Gmail searches hydrate visible schemas and exact names without loading the rest', async (t) => {
  const client = new Composio({
    apiKey: 'fixture-key-never-live',
    baseURL: 'https://proxy.fixture.invalid',
    allowTracking: false,
    disableVersionCheck: true,
    fileUploadDirs: false,
  });
  t.mock.method(client.getClient().toolkits, 'list', async () => ({
    items: [],
    next_cursor: null,
  }));
  const slugs = Array.from({ length: 25 }, (_, index) => `GMAIL_SYNTHETIC_${index}`);
  const incomplete = (slug: string) => ({
    toolSlug: slug,
    toolkit: 'gmail',
    hasFullSchema: false,
    schemaRef: {
      tool: 'COMPOSIO_GET_TOOL_SCHEMAS',
      args: { toolSlugs: [slug] },
    },
  });
  let advertised: Record<string, ReturnType<typeof incomplete>> = Object.fromEntries(
    slugs.map((slug) => [slug, incomplete(slug)]),
  );
  t.mock.method(client.sessions, 'create', async () => ({
    sessionId: 'fixture-session',
    search: async () => ({ success: true, error: null, toolSchemas: advertised, results: [] }),
  }));
  const requests: string[][] = [];
  t.mock.method(
    client.getClient().toolRouter.session,
    'executeMeta',
    async (_id: string, input: { arguments: { tool_slugs: string[] } }) => {
      const batch = input.arguments.tool_slugs;
      requests.push(batch);
      return {
        error: null,
        data: {
          success: true,
          tool_schemas: Object.fromEntries(
            batch.map((slug) => [
              slug,
              { tool_slug: slug, toolkit: 'gmail', input_schema: { type: 'object' } },
            ]),
          ),
        },
      };
    },
  );
  const provider = createComposioProvider({ proxy: composioProxyFixture(client) });
  const session = await provider.createSession('fixture-owner', { gmail: ['owned-gmail-account'] });
  const broad = (await session.search('Find recent messages')).tools as Record<
    string,
    { hasFullSchema?: boolean }
  >;
  assert.deepEqual(requests, [slugs.slice(0, 3)]);
  assert.ok(slugs.slice(0, 3).every((slug) => broad[slug]?.hasFullSchema === true));
  assert.ok(slugs.slice(3).every((slug) => broad[slug]?.hasFullSchema === false));

  requests.length = 0;
  const exact = (await session.search(slugs[18]!)).tools as Record<
    string,
    { hasFullSchema?: boolean }
  >;
  assert.deepEqual(requests, [[slugs[18]]]);
  assert.equal(exact[slugs[18]!]!.hasFullSchema, true);
  assert.ok(
    slugs.filter((slug) => slug !== slugs[18]).every((slug) => !exact[slug]?.hasFullSchema),
  );

  requests.length = 0;
  const mixedQuery = (await session.search(`${slugs[18]}, CONNECTED_HTTP`)).tools as Record<
    string,
    { hasFullSchema?: boolean }
  >;
  assert.deepEqual(requests, [slugs.slice(0, 3)]);
  assert.equal(mixedQuery[slugs[18]!]!.hasFullSchema, false);

  requests.length = 0;
  advertised = Object.fromEntries(slugs.slice(0, 5).map((slug) => [slug, incomplete(slug)]));
  await session.search('Find Gmail messages');
  assert.deepEqual(requests, [slugs.slice(0, 5)]);

  requests.length = 0;
  advertised = Object.fromEntries(slugs.map((slug) => [slug, incomplete(slug)]));
  advertised[slugs[24]!]!.schemaRef.args.toolSlugs = ['GMAIL_UNADVERTISED'];
  await assert.rejects(session.search('Find recent messages'), /schemas could not be loaded/);
  assert.deepEqual(requests, []);
});

test('mixed built-in app searches hydrate visible schemas and dynamic apps keep full hydration', async (t) => {
  const client = new Composio({
    apiKey: 'fixture-key-never-live',
    baseURL: 'https://proxy.fixture.invalid',
    allowTracking: false,
    disableVersionCheck: true,
    fileUploadDirs: false,
  });
  const entries = Array.from({ length: 8 }, (_, index) => {
    const toolkit = index % 2 ? 'slack' : 'gmail';
    const slug = `${toolkit.toUpperCase()}_SYNTHETIC_${index}`;
    return [slug, toolkit] as const;
  });
  const slugs = entries.map(([slug]) => slug);
  const toolSchemas = Object.fromEntries(
    entries.map(([slug, toolkit]) => [
      slug,
      {
        toolSlug: slug,
        toolkit,
        hasFullSchema: false,
        schemaRef: { tool: 'COMPOSIO_GET_TOOL_SCHEMAS', args: { toolSlugs: [slug] } },
      },
    ]),
  );
  t.mock.method(client.sessions, 'create', async () => ({
    sessionId: 'fixture-session',
    search: async () => ({ success: true, error: null, toolSchemas, results: [] }),
  }));
  const requests: string[][] = [];
  t.mock.method(
    client.getClient().toolRouter.session,
    'executeMeta',
    async (_id: string, input: { arguments: { tool_slugs: string[] } }) => {
      const batch = input.arguments.tool_slugs;
      requests.push(batch);
      return {
        error: null,
        data: {
          success: true,
          tool_schemas: Object.fromEntries(
            batch.map((slug) => [
              slug,
              {
                tool_slug: slug,
                toolkit: entries.find(([name]) => name === slug)![1],
                input_schema: { type: 'object' },
              },
            ]),
          ),
        },
      };
    },
  );
  const provider = createComposioProvider({ proxy: composioProxyFixture(client) });
  const accounts = { gmail: ['owned-gmail-account'], slack: ['owned-slack-account'] };
  const session = await provider.createSession('fixture-owner', accounts);
  const broad = (await session.search('Find a message')).tools as Record<
    string,
    { hasFullSchema?: boolean }
  >;
  assert.deepEqual(requests, [slugs.slice(0, 3)]);
  assert.ok(slugs.slice(0, 3).every((slug) => broad[slug]?.hasFullSchema === true));
  assert.ok(slugs.slice(3).every((slug) => broad[slug]?.hasFullSchema === false));

  requests.length = 0;
  await session.search(slugs[7]!);
  assert.deepEqual(requests, [[slugs[7]]]);

  requests.length = 0;
  const dynamic = await provider.createSession('fixture-owner', {
    ...accounts,
    native_mcp: ['owned-native-account'],
  });
  await dynamic.search('Find a message');
  assert.deepEqual(requests, [slugs]);
});

test('Composio catalog failures preserve owned accounts', async (t) => {
  const client = new Composio({
    apiKey: 'fixture-key-never-live',
    baseURL: 'https://proxy.fixture.invalid',
    allowTracking: false,
    disableVersionCheck: true,
    fileUploadDirs: false,
  });
  const listing = t.mock.method(client.getClient().toolkits, 'list', async () => {
    throw Object.assign(new Error('private-provider-response'), { status: 403 });
  });
  const execute = t.mock.fn(async () => ({
    data: { ok: true },
    error: null,
    resultType: 'completed',
  }));
  const create = t.mock.method(client.sessions, 'create', async () => ({
    sessionId: 'new-session',
    execute,
  }));
  const authorize = t.mock.fn(async () => ({
    accountId: 'fixture-outlook',
    url: 'https://proxy.fixture.invalid/connect/outlook',
    verificationSecret: 'fixture-outlook-verification',
  }));
  const provider = createComposioProvider({
    proxy: composioProxyFixture(client, 'fixture-owner', { authorize }),
  });
  await assert.rejects(provider.listServices!(), (error: Error) => {
    assert.ok(error instanceof IntegrationCatalogAccessDenied);
    assert.doesNotMatch(error.message, /private-provider-response/);
    return true;
  });
  const session = await provider.createSession('fixture-owner', { retired_mcp: ['owned-account'] });
  const configuration = create.mock.calls[0]!.arguments[1] as unknown as { toolkits: string[] };
  assert.deepEqual(configuration.toolkits, ['retired_mcp']);
  const callback = 'http://localhost:4310/api/apps/callback';
  await assert.rejects(session.authorize('outlook', callback));
  const authorization = await provider.createSession('fixture-owner', {});
  await authorization.authorize('outlook', callback);
  assert.deepEqual(authorize.mock.calls[0]!.arguments, ['outlook', callback]);
  assert.equal(listing.mock.callCount(), 1);
  await session.execute('RETIRED_MCP_LIST', {}, 'owned-account');
  assert.equal(execute.mock.callCount(), 1);
  assert.equal(listing.mock.callCount(), 1);
});

test('Composio failure envelopes reject with the provider error', async (t) => {
  const client = new Composio({
    apiKey: 'fixture-key-never-live',
    baseURL: 'https://proxy.fixture.invalid',
    allowTracking: false,
    disableVersionCheck: true,
    fileUploadDirs: false,
  });
  t.mock.method(client.getClient().toolkits, 'list', async () => ({
    items: [],
    next_cursor: null,
  }));
  let result: Record<string, unknown> = {};
  t.mock.method(client.sessions, 'create', async () => ({
    sessionId: 'fixture-session',
    execute: async () => result,
  }));
  const session = await createComposioProvider({
    proxy: composioProxyFixture(client, 'local-development'),
  }).createSession('local-development', {
    gmail: 'fixture-account',
    slack: 'fixture-account',
  });
  for (const failure of [
    { data: {}, error: 'Fixture rate limit', logId: 'log-fixture', resultType: 'failed' },
    { data: {}, error: null, logId: 'log-fixture', resultType: 'failed' },
    {
      data: { successful: false, error: 'Fixture rate limit' },
      error: null,
      resultType: 'completed',
    },
  ]) {
    result = failure;
    await assert.rejects(session.execute('GMAIL_SEND_EMAIL', {}, 'fixture-account'));
  }
  for (const failure of [
    { error: 'HTTP 403: Permission denied.', data: {} },
    { error: null, data: { successful: false, error: { code: 403, message: 'Forbidden' } } },
    {
      error: null,
      data: {
        successful: false,
        error: { code: 403, errors: [{ reason: 'insufficientPermissions' }] },
      },
    },
  ]) {
    result = { ...failure, resultType: 'completed' };
    await assert.rejects(
      session.execute('GMAIL_FETCH_EMAILS', {}, 'fixture-account'),
      (error: Error) => !(error instanceof IntegrationPermissionError),
    );
  }
  result = {
    data: { successful: true, message: 'insufficient_scope ACCESS_TOKEN_SCOPE_INSUFFICIENT' },
    error: null,
    resultType: 'completed',
  };
  assert.deepEqual(await session.execute('GMAIL_FETCH_EMAILS', {}, 'fixture-account'), result);
  for (const failure of [
    {
      error: 'HTTP 403: Request had insufficient authentication scopes.',
      resultType: 'failed',
      data: {},
    },
    {
      error: null,
      resultType: 'completed',
      data: {
        successful: false,
        error: 'HTTP 403: Request had insufficient authentication scopes.',
      },
    },
  ]) {
    result = failure;
    await assert.rejects(
      session.execute('GMAIL_FETCH_EMAILS', {}, 'fixture-account'),
      IntegrationPermissionError,
    );
  }
  result = {
    error: `Permission denied. ${'x'.repeat(5000)}`,
    data: {
      ok: false,
      needed: `canvases:write,${'y'.repeat(5000)}`,
      provided: `chat:write,channels:read,${'z'.repeat(5000)}`,
    },
    resultType: 'failed',
  };
  await assert.rejects(
    session.execute('SLACK_CREATE_CANVAS', {}, 'fixture-account'),
    (error: Error) => {
      assert.match(error.message, /needed: canvases:write/);
      assert.match(error.message, /provided: chat:write,channels:read/);
      assert.match(error.message, /Permission denied/);
      assert.ok(error.message.length < 5000);
      return true;
    },
  );
  result = { data: { ok: false, error: 'invalid_auth' }, error: null, resultType: 'completed' };
  await assert.rejects(
    session.execute('SLACK_SEND_MESSAGE', {}, 'fixture-account'),
    /invalid_auth/,
  );
  result = { data: { ok: false }, error: null, resultType: 'completed' };
  await assert.rejects(session.execute('SLACK_SEND_MESSAGE', {}, 'fixture-account'));
  result = {
    data: { ok: true, canvas_id: 'fixture-canvas' },
    error: null,
    resultType: 'completed',
  };
  assert.deepEqual(await session.execute('SLACK_CREATE_CANVAS', {}, 'fixture-account'), result);
  result = { data: { ok: false }, error: null, resultType: 'completed' };
  assert.deepEqual(await session.execute('GMAIL_GET_PROFILE', {}, 'fixture-account'), result);
  result = {
    data: { successful: true, id: 'fixture-message' },
    error: null,
    resultType: 'completed',
  };
  await session.execute('GMAIL_SEND_EMAIL', {}, 'fixture-account');
});

test('Composio connection requests classify HTTP failures without repeating consent or exposing provider details', async (t) => {
  const { createServer } = await import('node:http');
  const { IntegrationConnectionError } = await import('../src/ports/integrations.ts');
  let failure: { phase: string; status: number } | undefined;
  let rejected = 0;
  const server = createServer(async (request, response) => {
    const path = new URL(request.url!, 'http://localhost').pathname;
    const phase = path.endsWith('/tool_router/session') ? 'session' : undefined;
    response.setHeader('content-type', 'application/json');
    if (failure && failure.phase === phase && phase) {
      rejected++;
      response.statusCode = failure.status;
      response.end(JSON.stringify({ error: { message: 'synthetic-private-provider-body' } }));
      return;
    }
    if (path.endsWith('/toolkits')) {
      response.end(JSON.stringify({ items: [], next_cursor: null }));
      return;
    }
    if (phase === 'session') {
      let body = '';
      for await (const chunk of request) body += chunk;
      response.end(
        JSON.stringify({
          session_id: 'fixture-consent',
          mcp: { type: 'http', url: `http://${request.headers.host}/tool_router/mcp/fixture` },
          config: JSON.parse(body),
          config_version: 1,
        }),
      );
      return;
    }
    response.statusCode = 404;
    response.end('{}');
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(async () => {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });
  const address = server.address() as { port: number };
  const client = new Composio({
    apiKey: 'fixture-key-never-live',
    baseURL: `http://127.0.0.1:${address.port}`,
    allowTracking: false,
    disableVersionCheck: true,
    fileUploadDirs: false,
  });
  const provider = createComposioProvider({
    proxy: composioProxyFixture(client, 'fixture-owner', {
      authorize: async () => ({
        accountId: 'fixture-account',
        url: 'https://proxy.fixture.invalid/connect/fixture',
        verificationSecret: 'v'.repeat(43),
      }),
    }),
  });
  const connect = async () => {
    const session = await provider.createSession('fixture-owner', {});
    return session.authorize('gmail', 'http://localhost:4310/api/apps/callback');
  };
  for (const phase of ['session'] as const) {
    for (const [status, reason] of [
      [401, 'authorization'],
      [403, 'permission'],
      [429, 'rate_limit'],
      [503, 'unavailable'],
      [504, 'timeout'],
      [404, 'invalid_request'],
      [422, 'invalid_request'],
    ] as const) {
      failure = { phase, status };
      const before = rejected;
      await assert.rejects(connect(), (error: unknown) => {
        assert.ok(error instanceof IntegrationConnectionError);
        assert.equal(error.reason, reason);
        assert.equal(error.phase, phase);
        assert.doesNotMatch(String(error), /synthetic-private|fixture-key/);
        assert.equal(error.cause, undefined);
        return true;
      });
      assert.equal(rejected, before + 1);
    }
  }
  failure = undefined;
  assert.equal((await connect()).accountId, 'fixture-account');
  for (const [cause, reason] of [
    [new APIConnectionError({ message: 'synthetic-private-network-detail' }), 'unavailable'],
    [new APIConnectionTimeoutError(), 'timeout'],
  ] as const) {
    const create = t.mock.method(client.getClient().toolRouter.session, 'create', async () => {
      throw cause;
    });
    await assert.rejects(connect(), (error: unknown) => {
      assert.ok(error instanceof IntegrationConnectionError);
      assert.equal(error.reason, reason);
      assert.equal(error.cause, undefined);
      assert.doesNotMatch(String(error), /synthetic-private/);
      return true;
    });
    assert.equal(create.mock.callCount(), 1);
    create.mock.restore();
  }
});

test('Composio proxy sessions omit SDK metadata and refuse unsupported webhooks', async (t) => {
  const client = new Composio({
    apiKey: 'fixture-key-never-live',
    baseURL: 'https://proxy.fixture.invalid',
    allowTracking: false,
    disableVersionCheck: true,
    fileUploadDirs: false,
  });
  t.mock.method(client.getClient().toolkits, 'list', async () => ({
    items: [],
    next_cursor: null,
  }));
  t.mock.method(client.sessions, 'create', async () => ({
    sessionId: 'fixture-session',
    execute: async () => ({ data: [] }),
    search: async () => ({
      success: true,
      error: null,
      toolSchemas: {
        GMAIL_FETCH_EMAILS: {
          toolSlug: 'GMAIL_FETCH_EMAILS',
          toolkit: 'gmail',
          inputSchema: { type: 'object' },
        },
      },
      results: [{ useCase: 'Find email', primaryToolSlugs: ['GMAIL_FETCH_EMAILS'] }],
      session: { token: 'do-not-expose' },
    }),
  }));
  const provider = createComposioProvider({ proxy: composioProxyFixture(client) });
  const session = await provider.createSession('fixture-owner', {});
  assert.equal(JSON.stringify(await session.search('Find email')).includes('do-not-expose'), false);
  assert.equal(provider.webhooksConfigured, false);
  await assert.rejects(provider.verifyWebhook('{}', {}), /not configured/);
  await assert.rejects(
    provider.subscribe('fixture-owner', 'gmail', 'fixture-account'),
    /unavailable/,
  );
});

async function hostedDatabase(options: pg.PoolConfig = {}) {
  const schema = 'test_hosted_integrations_' + randomUUID().replaceAll('-', '');
  const admin = new pg.Pool({ connectionString: process.env.TEST_DATABASE_URL });
  await admin.query(`CREATE SCHEMA ${schema}`);
  const pool = new pg.Pool({
    connectionString: process.env.TEST_DATABASE_URL,
    options: `-c search_path=${schema}`,
    ...options,
  });
  return {
    pool,
    async close() {
      await pool.end();
      await admin.query(`DROP SCHEMA ${schema} CASCADE`);
      await admin.end();
    },
  };
}

test(
  'the ledger keeps owned costs and actions, reports them and enforces the monthly limit',
  { skip: !process.env.TEST_DATABASE_URL },
  async () => {
    const schema = `test_ledger_${randomUUID().replaceAll('-', '')}`;
    const admin = new pg.Pool({ connectionString: process.env.TEST_DATABASE_URL });
    await admin.query(`CREATE SCHEMA ${schema}`);
    const pool = new pg.Pool({
      connectionString: process.env.TEST_DATABASE_URL,
      options: `-c search_path=${schema}`,
    });
    const app = Fastify();
    const chat = randomUUID(),
      scheduled = randomUUID(),
      foreign = randomUUID(),
      schedule = randomUUID(),
      conversation = randomUUID();
    try {
      await pool.query(`
        CREATE TABLE threads(id uuid PRIMARY KEY,owner_id text NOT NULL,archived_at timestamptz);
        CREATE TABLE turns(id uuid PRIMARY KEY,owner_id text NOT NULL,source text NOT NULL,source_id text,
          message_id uuid,prompt text NOT NULL,channel text NOT NULL DEFAULT 'web',status text NOT NULL DEFAULT 'succeeded',
          error text,created_at timestamptz NOT NULL DEFAULT now(),thread_id uuid,session_id uuid);
        CREATE TABLE turn_events(id uuid DEFAULT gen_random_uuid(),turn_id uuid,type text,summary text DEFAULT '',created_at timestamptz NOT NULL DEFAULT now());
        CREATE TABLE messages(id uuid,owner_id text,role text,text text,turn_id uuid,thread_id uuid,created_at timestamptz DEFAULT now(),hidden_at timestamptz);
        CREATE TABLE preferences(owner_id text PRIMARY KEY,time_zone text,locale text,hour_cycle text);
        CREATE TABLE schedules(id uuid,owner_id text,title text);
        CREATE TABLE tasks(id uuid,owner_id text,session_id uuid,title text,activity_key text);
        CREATE TABLE app_actions(id uuid PRIMARY KEY DEFAULT gen_random_uuid(),owner_id text NOT NULL,
          turn_id uuid NOT NULL REFERENCES turns(id) ON DELETE CASCADE,action text NOT NULL,
          created_at timestamptz NOT NULL DEFAULT now())`);
      await pool.query(
        `INSERT INTO turns(id,owner_id,source,source_id,prompt,created_at) VALUES
          ($1,'owner','user',NULL,'Tell Sam we take the quote',greatest(now()-interval '2 hours',date_trunc('month',now() AT TIME ZONE 'UTC') AT TIME ZONE 'UTC')),
          ($2,'owner','schedule',$4,'Run the morning brief',greatest(now()-interval '1 hour',(date_trunc('month',now() AT TIME ZONE 'UTC') AT TIME ZONE 'UTC')+interval '1 millisecond')),
          ($3,'other','user',NULL,'Foreign request',now())`,
        [chat, scheduled, foreign, `schedule:${schedule}:1:now`],
      );
      await pool.query(
        'UPDATE turns SET thread_id=$1,session_id=CASE WHEN id=$2 THEN id ELSE $1 END WHERE id<>$3',
        [conversation, scheduled, foreign],
      );
      await pool.query('UPDATE turns SET thread_id=id,session_id=id WHERE id=$1', [foreign]);
      await pool.query("INSERT INTO threads(id,owner_id) VALUES($1,'owner'),($2,'other')", [
        conversation,
        foreign,
      ]);
      await pool.query("INSERT INTO schedules VALUES($1,'owner','Morning brief')", [schedule]);
      await pool.query(
        "INSERT INTO app_actions(owner_id,turn_id,action,created_at) VALUES('owner',$1,'NOTION_UPDATE_PAGE',now()-interval '90 minutes')",
        [scheduled],
      );
      await pool.query(
        "INSERT INTO turn_events(turn_id,type) VALUES($1,'tool_complete'),($1,'tool_complete'),($2,'tool_complete'),($3,'tool_complete')",
        [chat, scheduled, foreign],
      );
      const ledger = createLedger({ pool, ownerId: 'owner' });
      await ledger.initialize();
      ledger.registerRoutes(app);
      const usage = (turnId: string, costUsd: number | null): AgentEvent => ({
        type: 'model_usage',
        id: randomUUID(),
        provider: 'openai',
        model: 'fixture',
        inputTokens: 4,
        outputTokens: 2,
        cacheReadTokens: 0,
        cacheWriteTokens: 0,
        totalTokens: 6,
        costUsd,
        costSource: costUsd === null ? 'unavailable' : 'sdk_estimate',
        createdAt: new Date().toISOString(),
      });
      const agent = ledger.agent({
        async open(options) {
          return {
            resumed: false,
            async prompt() {
              options.onEvent(usage(options.turnId, options.turnId === chat ? 0.4 : null));
              options.onEvent({
                type: 'provider_usage',
                usage: {
                  id: randomUUID(),
                  provider: 'openai',
                  category: 'agent',
                  operation: 'compaction',
                  status: 'succeeded',
                  durationMs: 1,
                  costUsd: 0.1,
                  pricing: 'sdk_estimate',
                },
              });
            },
            abort() {},
            dispose() {},
          };
        },
        dispose() {},
      });
      for (const turnId of [chat, scheduled, foreign])
        await (
          await agent.open({
            ...fakeExecution(randomUUID(), turnId),
            systemPrompt: 'Synthetic prompt',
            tools: [],
            workspace: fakeWorkspace().open({
              threadId: randomUUID(),
              workspacePath: '/fixture/workspace',
              signal: new AbortController().signal,
            }),
            runTool: (_name, _params, run) => run(),
            shouldStop: () => false,
            onEvent() {},
          })
        ).prompt('Synthetic message', []);
      await ledger.withTurn(chat, () =>
        ledger
          .curator({
            id: 'fixture',
            configured: true,
            curate: async (_request, _signal, report) => {
              report?.({ id: randomUUID(), model: 'fixture-small', costUsd: 0.05 });
              return {};
            },
          })
          .curate({ task: 'review', instructions: 'Synthetic', input: {} }),
      );
      await ledger.action(chat, 'GMAIL_FETCH_EMAILS', { kind: 'read' });
      await ledger.action(chat, 'GMAIL_SEND_EMAIL', { kind: 'approved' });
      await ledger.action(foreign, 'GMAIL_SEND_EMAIL', { kind: 'approved' });
      for (let attempt = 0; attempt < 50; attempt++) {
        const rows = await pool.query('SELECT count(*)::int AS count FROM model_usage');
        if (rows.rows[0].count === 5) break;
        await new Promise((resolve) => setTimeout(resolve, 20));
      }
      assert.deepEqual((await pool.query('SELECT DISTINCT owner_id FROM model_usage')).rows, [
        { owner_id: 'owner' },
      ]);
      const costs = await ledger.sessionCosts([conversation, scheduled, foreign]);
      assert.equal(Math.round(costs[conversation]! * 100) / 100, 0.55);
      assert.equal(costs[scheduled], null);
      assert.equal(Object.hasOwn(costs, foreign), false);
      await pool.query(
        `UPDATE app_actions SET basis='{"kind":"approved"}' WHERE action='NOTION_UPDATE_PAGE'`,
      );
      assert.deepEqual(
        (await pool.query('SELECT action FROM app_actions ORDER BY created_at')).rows,
        [
          { action: 'NOTION_UPDATE_PAGE' },
          { action: 'GMAIL_FETCH_EMAILS' },
          { action: 'GMAIL_SEND_EMAIL' },
        ],
      );
      const view = (await app.inject('/api/trust')).json();
      assert.deepEqual(
        { ...view.week, spentUsd: Math.round(view.week.spentUsd * 100) / 100 },
        { things: 3, actions: 3, spentUsd: 0.65, planUsd: 0 },
      );
      assert.equal(view.month.unpriced, true);
      assert.deepEqual(
        view.entries.map((entry: TrustEntry) => [entry.title, entry.source, entry.costUsd]),
        [
          ['Morning brief', 'schedule', 0.1],
          ['Tell Sam we take the quote', 'chat', 0.55],
        ],
      );
      const chatEntry = (entries: TrustEntry[]) =>
        entries.find((entry) => entry.title === 'Tell Sam we take the quote')!;
      assert.ok(view.entries.every((entry: TrustEntry) => entry.messageId === null));
      const hiddenConfirmation = randomUUID();
      await pool.query(
        "INSERT INTO messages(id,owner_id,role,text,turn_id,thread_id,hidden_at) VALUES($1,'owner','assistant','Retired confirmation',$2,$3,now())",
        [hiddenConfirmation, scheduled, conversation],
      );
      const scheduledEntry = (await app.inject('/api/trust'))
        .json()
        .entries.find((entry: TrustEntry) => entry.id === scheduled) as TrustEntry;
      assert.equal(scheduledEntry.messageId, null);
      assert.equal(scheduledEntry.costUsd, 0.1);
      assert.deepEqual(chatEntry(view.entries).actions, [
        { label: 'Gmail: fetch emails' },
        { label: 'Gmail: send email', because: { kind: 'approved' } },
      ]);
      const said = randomUUID();
      const foreignSaid = randomUUID();
      await pool.query(
        "INSERT INTO messages(id,owner_id,role,text,turn_id,thread_id) VALUES($1,'owner','user','Tell Sam we take the quote',$3,$5),($2,'other','user','Foreign words',$4,$4)",
        [said, foreignSaid, chat, foreign, conversation],
      );
      await pool.query('UPDATE turns SET message_id=$2 WHERE id=$1', [chat, said]);
      const linkedMessage = async () =>
        (await app.inject('/api/trust'))
          .json()
          .entries.find((entry: TrustEntry) => entry.id === chat).messageId;
      assert.equal(await linkedMessage(), said);
      const firstResult = randomUUID();
      const latestResult = randomUUID();
      const foreignResult = randomUUID();
      const archivedResult = randomUUID();
      const archivedThread = randomUUID();
      await pool.query("INSERT INTO threads VALUES($1,'owner',now())", [archivedThread]);
      await pool.query(
        `INSERT INTO messages(id,owner_id,role,text,turn_id,thread_id,created_at) VALUES
          ($1,'owner','assistant','Synthetic first result',$5,$6,now()-interval '2 minutes'),
          ($2,'owner','assistant','Synthetic latest result',$5,$6,now()-interval '1 minute'),
          ($3,'other','assistant','Foreign result',$5,$6,now()),
          ($4,'owner','assistant','Archived result',$5,$7,now())`,
        [
          firstResult,
          latestResult,
          foreignResult,
          archivedResult,
          chat,
          conversation,
          archivedThread,
        ],
      );
      assert.equal(await linkedMessage(), latestResult);
      await pool.query('UPDATE messages SET hidden_at=now() WHERE id=$1', [latestResult]);
      assert.equal(await linkedMessage(), firstResult);
      await pool.query('DELETE FROM messages WHERE id=$1', [latestResult]);
      assert.equal(await linkedMessage(), firstResult);
      await pool.query('DELETE FROM messages WHERE id=$1', [firstResult]);
      assert.equal(await linkedMessage(), said);
      for (const unavailable of [foreignSaid, archivedResult, randomUUID()]) {
        await pool.query('UPDATE turns SET message_id=$2 WHERE id=$1', [chat, unavailable]);
        assert.equal(await linkedMessage(), null);
      }
      await pool.query('UPDATE turns SET message_id=$2 WHERE id=$1', [chat, said]);
      await pool.query('UPDATE threads SET archived_at=now() WHERE id=$1', [conversation]);
      assert.equal(await linkedMessage(), null);
      await pool.query('UPDATE threads SET archived_at=NULL WHERE id=$1', [conversation]);
      assert.equal(await linkedMessage(), said);
      await pool.query('DELETE FROM messages WHERE id=ANY($1::uuid[])', [
        [foreignResult, archivedResult],
      ]);
      await ledger.action(chat, 'SLACK_SEND_MESSAGE', {
        kind: 'message',
        messageId: said,
        quote: 'Tell Sam we take the quote',
      });
      await ledger.action(chat, 'SLACK_SEND_MESSAGE', {
        kind: 'message',
        messageId: foreignSaid,
        quote: 'Foreign words',
      });
      await ledger.action(scheduled, 'GMAIL_FETCH_EMAILS', { kind: 'read' });
      assert.deepEqual(
        chatEntry((await app.inject('/api/trust')).json().entries).actions.slice(-2),
        [
          {
            label: 'Slack: send message',
            because: { kind: 'message', text: 'Tell Sam we take the quote' },
          },
          { label: 'Slack: send message' },
        ],
      );
      assert.deepEqual(
        (await app.inject(`/api/trust/entries?session=${scheduled}`))
          .json()
          .entries.map((entry: TrustEntry) => entry.id),
        [scheduled],
      );
      await pool.query(
        "DELETE FROM app_actions WHERE action='SLACK_SEND_MESSAGE' OR (turn_id=$1 AND action='GMAIL_FETCH_EMAILS')",
        [scheduled],
      );
      await pool.query('DELETE FROM messages WHERE id=ANY($1::uuid[])', [[said, foreignSaid]]);
      assert.doesNotMatch(
        usagePdf(await ledger.report(), new Date()).toString('latin1'),
        /Foreign request/,
      );
      const limit = async (monthlyUsd: number | null) =>
        (
          await app.inject({ method: 'PUT', url: '/api/trust/limit', payload: { monthlyUsd } })
        ).json().limit;
      assert.deepEqual(await limit(1), { monthlyUsd: 1, reached: false });
      assert.equal(await ledger.limitReached(), false);
      await pool.query(
        "INSERT INTO model_usage(id,owner_id,turn_id,cost_usd) VALUES('extra','owner',NULL,0.5)",
      );
      assert.equal(await ledger.limitReached(), true);
      const limited = (await app.inject('/api/trust')).json();
      assert.deepEqual(limited.limit, { monthlyUsd: 1, reached: true });
      assert.equal(Math.round(limited.month.backgroundUsd * 100) / 100, 0.6);
      const reply = randomUUID();
      await pool.query(
        "INSERT INTO turns(id,owner_id,source,prompt,thread_id,session_id) VALUES($1,'owner','user','Owner reply',$2,$3)",
        [reply, conversation, scheduled],
      );
      await pool.query(
        "INSERT INTO model_usage(id,owner_id,turn_id,cost_usd) VALUES('reply','owner',$1,0.2)",
        [reply],
      );
      assert.equal(
        Math.round((await app.inject('/api/trust')).json().month.backgroundUsd * 100) / 100,
        0.6,
      );
      await pool.query("DELETE FROM model_usage WHERE id='reply'");
      assert.deepEqual(limited.month.outside, [{ kind: 'other', costUsd: 0.5 }]);
      assert.equal(await limit(null), null);
      assert.equal(await ledger.limitReached(), false);
      await limit(1.16);
      await pool.query(`
        CREATE FUNCTION refuse_usage() RETURNS trigger LANGUAGE plpgsql AS $$
          BEGIN RAISE EXCEPTION 'Synthetic usage write failure.'; END;
        $$;
        CREATE TRIGGER refuse_usage BEFORE INSERT ON model_usage FOR EACH ROW EXECUTE FUNCTION refuse_usage()`);
      let modelRequests = 0;
      const curator = ledger.curator({
        id: 'fixture',
        configured: true,
        curate: async (_request, _signal, report) => {
          modelRequests++;
          report?.({ id: randomUUID(), model: 'fixture-small', costUsd: 0.05 });
          return {};
        },
      });
      const request = { task: 'review' as const, instructions: 'Synthetic', input: {} };
      await assert.rejects(curator.curate(request), /Synthetic usage write failure/);
      const failedAt = Date.now();
      await new Promise((resolve) => setTimeout(resolve, 20));
      await assert.rejects(curator.curate(request), /Synthetic usage write failure/);
      assert.equal(modelRequests, 1);
      await pool.query('DROP TRIGGER refuse_usage ON model_usage');
      assert.equal(await ledger.limitReached(), true);
      await assert.rejects(curator.curate(request), /spending limit is reached/);
      assert.equal(modelRequests, 1);
      const recoveredUsage = await pool.query(
        "SELECT created_at FROM model_usage WHERE owner_id='owner' AND turn_id IS NULL AND cost_usd=0.05",
      );
      assert.ok(recoveredUsage.rows[0].created_at.getTime() <= failedAt);
      assert.equal(
        Math.round((await app.inject('/api/trust')).json().month.spentUsd * 100) / 100,
        1.2,
      );
      await ledger.withTurn(reply, () => curator.curate(request), true);
      assert.equal(modelRequests, 2);
      await assert.rejects(curator.curate(request), /spending limit is reached/);
      await pool.query('DELETE FROM model_usage WHERE turn_id=$1', [reply]);
      const decimalLedger = createLedger({ pool, ownerId: 'decimal-owner' });
      await pool.query("INSERT INTO spending_limits VALUES('decimal-owner',1)");
      await pool.query(
        "INSERT INTO model_usage(id,owner_id,cost_usd) SELECT 'decimal-'||n,'decimal-owner',0.1 FROM generate_series(1,9) n",
      );
      assert.equal(await decimalLedger.limitReached(), false);
      await pool.query(
        "INSERT INTO model_usage(id,owner_id,cost_usd) VALUES('decimal-10','decimal-owner',0.1)",
      );
      assert.equal(await decimalLedger.limitReached(), true);
      await limit(null);
      const sessionId = randomUUID();
      const childRunId = randomUUID();
      const threadId = randomUUID();
      const reviewId = randomUUID();
      const childUsage = usage(chat, 0.2);
      const rootUsage = usage(chat, 0.1);
      const reviewed = ledger.curator({
        id: 'fixture',
        configured: true,
        curate: async (_request, _signal, report) => {
          report?.({ id: reviewId, provider: 'openai', model: 'fixture-review', costUsd: 0.05 });
          return {};
        },
      });
      const billed = ledger.agent({
        open: async (input) => ({
          resumed: false,
          abort() {},
          dispose() {},
          prompt: async () => {
            const event = input.parentRunId ? childUsage : rootUsage;
            input.onEvent(event);
            input.onEvent(event);
            if (input.parentRunId)
              await reviewed.curate({
                task: 'review',
                instructions: 'Synthetic review',
                input: {},
              });
          },
        }),
        dispose() {},
      });
      for (const runId of [chat, childRunId]) {
        const execution = {
          threadId,
          sessionId,
          turnId: chat,
          runId,
          browserId: runId === chat ? sessionId : runId,
          ...(runId !== chat ? { parentRunId: chat } : {}),
        };
        const session = await billed.open({
          ...execution,
          systemPrompt: 'Synthetic prompt',
          tools: [],
          workspace: fakeWorkspace().open({
            threadId,
            workspacePath: '/fixture',
            signal: new AbortController().signal,
          }),
          runTool: (_name, _params, run) => run(),
          shouldStop: () => false,
          onEvent() {},
        });
        await session.prompt('Synthetic request', []);
        await session.dispose();
      }
      const usageIds = new Set([
        rootUsage.type === 'model_usage' ? rootUsage.id : '',
        childUsage.type === 'model_usage' ? childUsage.id : '',
        reviewId,
      ]);
      const { rows: recorded } = await pool.query(
        `SELECT id,run_id AS "runId",parent_run_id AS "parentRunId",session_id AS "sessionId",browser_id AS "browserId",details
         FROM model_usage WHERE owner_id=$1 AND turn_id=$2 AND id=ANY($3::text[])`,
        ['owner', chat, [...usageIds]],
      );
      assert.equal(recorded.length, 3);
      assert.equal(
        recorded.filter((item: { runId: string }) => item.runId === childRunId).length,
        2,
      );
      assert.ok(recorded.every((item: { sessionId: string }) => item.sessionId === sessionId));
      assert.equal(recorded.find((item) => item.runId === chat).browserId, sessionId);
      assert.ok(
        recorded
          .filter((item) => item.runId === childRunId)
          .every((item) => item.browserId === childRunId),
      );
      assert.equal(recorded.find((item: { id: string }) => item.id === reviewId).parentRunId, chat);
      assert.equal(
        recorded.find((item: { runId: string }) => item.runId === chat).details.inputTokens,
        4,
      );
      assert.equal(
        Math.round((await ledger.sessionCosts([conversation]))[conversation]! * 100) / 100,
        0.9,
      );
      const imageIds = [randomUUID(), randomUUID()];
      const imageEvents: AgentEvent[] = [];
      for (const id of imageIds)
        await ledger.withExecution(
          {
            threadId,
            sessionId,
            turnId: chat,
            runId: chat,
            browserId: sessionId,
            onEvent: (event) => imageEvents.push(event),
          },
          () =>
            ledger
              .curator({
                id: 'fixture-vision',
                configured: true,
                curate: async (_request, _signal, report) => {
                  report?.({ id, provider: 'openrouter', model: 'fixture-vision', costUsd: 0.03 });
                  return { description: 'Synthetic label' };
                },
              })
              .curate({ task: 'vision', instructions: 'Synthetic image input', input: {} }),
        );
      assert.equal(imageEvents.length, 2);
      assert.ok(
        imageEvents.every(
          (event) =>
            event.type === 'provider_usage' &&
            event.usage.category === 'agent' &&
            event.usage.operation === 'vision',
        ),
      );
      const imageRows = (
        await pool.query(
          'SELECT turn_id,run_id,session_id,browser_id FROM model_usage WHERE owner_id=$1 AND id=ANY($2::text[])',
          ['owner', imageIds],
        )
      ).rows;
      assert.deepEqual(
        imageRows,
        imageIds.map(() => ({
          turn_id: chat,
          run_id: chat,
          session_id: sessionId,
          browser_id: sessionId,
        })),
      );
      assert.equal(
        (await pool.query("SELECT count(*)::int AS n FROM model_usage WHERE details ? 'costUsd'"))
          .rows[0].n,
        0,
      );
      await pool.query('ALTER TABLE turns ADD COLUMN IF NOT EXISTS session_id uuid');
      const task = randomUUID();
      const [started, answered, resumed] = [randomUUID(), randomUUID(), randomUUID()];
      await pool.query(
        `INSERT INTO turns(id,owner_id,source,prompt,session_id,created_at) VALUES
          ($1,'owner','task','Compare trains',$4,now()-interval '30 minutes'),
          ($2,'owner','user','Yes, keep going',$4,now()-interval '10 minutes'),
          ($3,'owner','resume','Approved action',$4,now()-interval '5 minutes')`,
        [started, answered, resumed, task],
      );
      await pool.query(
        `INSERT INTO model_usage(id,owner_id,session_id,cost_usd,details,created_at) VALUES
          ('before-answer','owner',$1,4,'{}',now()-interval '20 minutes'),
          ('after-answer','owner',$1,0.5,'{}',now()-interval '8 minutes'),
          ('plan','owner',$1,NULL,'{"estimateUsd":0.25}',now()-interval '4 minutes'),
          ('other-session','owner',$2,9,'{}',now()-interval '4 minutes'),
          ('other-owner','other',$1,9,'{}',now()-interval '4 minutes')`,
        [task, randomUUID()],
      );
      assert.deepEqual(await ledger.checkIn(task, started), {
        budgetUsd: 5,
        spentUsd: 4.75,
        planUsd: 0.25,
      });
      assert.deepEqual(await ledger.checkIn(task, resumed), {
        budgetUsd: 5,
        spentUsd: 0.75,
        planUsd: 0.25,
      });
      const planned = (await app.inject('/api/trust')).json();
      assert.deepEqual([planned.week.planUsd, planned.month.planUsd], [0.25, 0.25]);
      const pricings = randomUUID();
      const [planTurn, localTurn, failedTurn] = [randomUUID(), randomUUID(), randomUUID()];
      await pool.query(
        `INSERT INTO turns(id,owner_id,source,prompt,session_id,created_at) VALUES
          ($1,'owner','user','On the plan',$4,now()-interval '3 minutes'),
          ($2,'owner','user','On a local model',$4,now()-interval '2 minutes'),
          ($3,'owner','user','Failed before a reply',$4,now()-interval '1 minute')`,
        [planTurn, localTurn, failedTurn, pricings],
      );
      await pool.query(
        `INSERT INTO model_usage(id,owner_id,turn_id,cost_usd,details) VALUES
          ($1,'owner',$4,NULL,'{"estimateUsd":0.2,"status":"succeeded"}'),
          ($2,'owner',$5,0,'{"status":"succeeded"}'),
          ($3,'owner',$6,NULL,'{"status":"failed"}')`,
        [randomUUID(), randomUUID(), randomUUID(), planTurn, localTurn, failedTurn],
      );
      assert.deepEqual(
        (await app.inject(`/api/trust/entries?session=${pricings}`))
          .json()
          .entries.map((entry: TrustEntry) => [entry.title, entry.costUsd, entry.pricing ?? null]),
        [
          ['Failed before a reply', null, null],
          ['On a local model', null, 'unpriced'],
          ['On the plan', null, 'plan'],
        ],
      );
      const unscopedUsage = randomUUID();
      await ledger.withTurn(resumed, () =>
        ledger
          .curator({
            id: 'fixture-review',
            configured: true,
            curate: async (_request, _signal, report) => {
              report?.({ id: unscopedUsage, model: 'fixture-review', costUsd: 0.1 });
              return {};
            },
          })
          .curate({ task: 'review', instructions: 'Synthetic review', input: {} }),
      );
      assert.deepEqual(await ledger.checkIn(task, resumed), {
        budgetUsd: 5,
        spentUsd: 0.85,
        planUsd: 0.25,
      });
      await pool.query('DELETE FROM model_usage WHERE id=$1', [unscopedUsage]);
      const preprocessing = randomUUID();
      await pool.query(
        `INSERT INTO model_usage(id,owner_id,cost_usd,details,created_at)
         VALUES($1,'owner',0.4,'{"operation":"transcribe"}',now()-interval '31 minutes')`,
        [preprocessing],
      );
      const attribution = await pool.connect();
      try {
        await ledger.attributeMediaUsage(attribution, [preprocessing], started);
        await ledger.attributeMediaUsage(attribution, [preprocessing], resumed);
      } finally {
        attribution.release();
      }
      assert.deepEqual(await ledger.checkIn(task, started), {
        budgetUsd: 5,
        spentUsd: 5.15,
        planUsd: 0.25,
      });
      assert.equal(
        (await pool.query('SELECT turn_id FROM model_usage WHERE id=$1', [preprocessing])).rows[0]
          .turn_id,
        started,
      );
      assert.deepEqual(await ledger.checkIn(task, resumed), {
        budgetUsd: 5,
        spentUsd: 0.75,
        planUsd: 0.25,
      });

      await pool.query(
        `INSERT INTO turns(id,owner_id,source,prompt,session_id,created_at)
         VALUES($1,'owner','task','Also compare buses',$2,now()-interval '6 minutes')`,
        [randomUUID(), task],
      );
      assert.deepEqual(await ledger.checkIn(task, resumed), {
        budgetUsd: 5,
        spentUsd: 0.25,
        planUsd: 0.25,
      });
      const limits = async (payload: object) =>
        (await app.inject({ method: 'PUT', url: '/api/trust/limit', payload })).json();
      assert.deepEqual(await limits({ taskUsd: 20 }), { limit: null, taskUsd: 20 });
      assert.equal((await ledger.checkIn(task, resumed))?.budgetUsd, 20);
      assert.deepEqual(await limits({ taskUsd: null, monthlyUsd: 30 }), {
        limit: { monthlyUsd: 30, reached: false },
        taskUsd: null,
      });
      assert.equal(await ledger.checkIn(task, resumed), undefined);
      const speechLedger = createLedger({ pool, ownerId: 'speech-owner' });
      await pool.query(
        "INSERT INTO spending_limits(owner_id,monthly_usd) VALUES('speech-owner',1)",
      );
      let transcriptionRequests = 0;
      let speechReady = false;
      const speech = speechLedger.speech({
        id: 'fixture',
        configured: false,
        get transcriptionConfigured() {
          return speechReady;
        },
        async synthesize() {
          throw new Error('Not used.');
        },
        async transcribe(_audio, _signal, report) {
          transcriptionRequests++;
          const usage = {
            id: randomUUID(),
            provider: 'fixture',
            category: 'agent' as const,
            operation: 'transcribe',
            model: 'fixture',
            status: 'succeeded' as const,
            durationMs: 1,
            costUsd: 0.6,
          };
          report?.(usage);
          report?.(usage);
          return 'Synthetic transcript';
        },
      });
      const { createSpeech } = await import('../src/server/speech.ts');
      const service = createSpeech(speech);
      const audio = { bytes: new Uint8Array([1]), mimeType: 'audio/ogg', name: 'voice.ogg' };
      await assert.rejects(service.transcribe(audio));
      speechReady = true;
      await speechLedger.withTurn(chat, () => service.transcribe(audio));
      speechReady = false;
      await assert.rejects(service.transcribe(audio));
      assert.equal(transcriptionRequests, 1);
      speechReady = true;
      await service.transcribe(audio);
      assert.equal(await speechLedger.limitReached(), true);
      await service.transcribe(audio);
      assert.equal(transcriptionRequests, 3);
      const billedSpeech = await pool.query(
        "SELECT count(*)::int AS n,sum(cost_usd::numeric)::float8 AS spent FROM model_usage WHERE owner_id='speech-owner'",
      );
      assert.deepEqual(billedSpeech.rows[0], { n: 3, spent: 1.8 });
      assert.equal(
        (
          await pool.query(
            "SELECT count(*)::int AS n FROM model_usage WHERE owner_id='speech-owner' AND turn_id IS NOT NULL",
          )
        ).rows[0].n,
        0,
      );
      await ledger.setLimits({ monthlyUsd: null });
      const late = await agent.open({
        ...fakeExecution(conversation, chat),
        systemPrompt: 'Synthetic prompt',
        tools: [],
        workspace: fakeWorkspace().open({
          threadId: conversation,
          workspacePath: '/fixture/workspace',
          signal: new AbortController().signal,
        }),
        runTool: (_name, _params, run) => run(),
        shouldStop: () => false,
        onEvent() {},
      });
      const beforeReset = (await pool.query('SELECT id FROM model_usage')).rows.map(
        (row) => row.id,
      );
      await pool.query('DELETE FROM turns WHERE id=$1', [chat]);
      await late.prompt('Synthetic model usage after reset', []);
      assert.deepEqual(
        (
          await pool.query(
            'SELECT owner_id,turn_id,cost_usd FROM model_usage WHERE NOT(id=ANY($1::text[])) ORDER BY cost_usd',
            [beforeReset],
          )
        ).rows,
        [
          { owner_id: 'owner', turn_id: null, cost_usd: 0.1 },
          { owner_id: 'owner', turn_id: null, cost_usd: 0.4 },
        ],
      );
      await late.dispose();
      const attributionLedger = createLedger({ pool, ownerId: 'usage-owner' });
      const empty = await attributionLedger.read();
      assert.equal(empty.month.planUsage, false);
      assert.equal(empty.month.unpriced, false);
      const [subscriptionTurn, mixedTurn, unpricedTurn, freeTurn, legacyTurn] = Array.from(
        { length: 5 },
        () => randomUUID(),
      );
      await pool.query(
        `INSERT INTO turns(id,owner_id,source,prompt,session_id) VALUES
          ($1,'usage-owner','task','Synthetic plan task',$1),
          ($2,'usage-owner','task','Synthetic mixed task',$2),
          ($3,'usage-owner','task','Synthetic unpriced task',$3),
          ($4,'usage-owner','task','Synthetic local task',$4),
          ($5,'usage-owner','task','Synthetic legacy task',$5)`,
        [subscriptionTurn, mixedTurn, unpricedTurn, freeTurn, legacyTurn],
      );
      for (const costUsd of [0.2, 0]) {
        await pool.query(
          `INSERT INTO model_usage(id,owner_id,turn_id,cost_usd,details) VALUES
            ('usage-charged-estimate','usage-owner',$1,$2,'{"provider":"openai","model":"fixture-priced","estimateUsd":0.6,"status":"succeeded"}')`,
          [freeTurn, costUsd],
        );
        const charged = await attributionLedger.read();
        assert.equal(charged.month.planUsage, false);
        assert.equal(charged.month.unpriced, costUsd === 0);
        assert.equal(charged.month.spentUsd, costUsd);
        assert.deepEqual(charged.entries[0]!.models, [
          { provider: 'openai', model: 'fixture-priced', billing: 'api' },
        ]);
        await pool.query("DELETE FROM model_usage WHERE id='usage-charged-estimate'");
      }
      await pool.query(
        `INSERT INTO model_usage(id,owner_id,turn_id,cost_usd,details) VALUES
          ('usage-plan-a','usage-owner',$1,NULL,'{"provider":"openai-codex","model":"fixture-plan","estimateUsd":null,"status":"succeeded"}'),
          ('usage-plan-b','usage-owner',$1,NULL,'{"provider":"openai-codex","model":"fixture-plan","estimateUsd":0.6,"status":"succeeded"}')`,
        [subscriptionTurn],
      );
      const planOnly = await attributionLedger.read();
      assert.equal(planOnly.month.planUsage, true);
      assert.equal(planOnly.month.unpriced, true);
      assert.equal(planOnly.month.planUsd, 0.6);
      assert.equal(planOnly.month.spentUsd, 0);
      assert.deepEqual(
        planOnly.entries.map((entry) => [entry.id, entry.costUsd, entry.models]),
        [
          [
            subscriptionTurn,
            null,
            [{ provider: 'openai-codex', model: 'fixture-plan', billing: 'plan' }],
          ],
        ],
      );
      await pool.query(
        `INSERT INTO model_usage(id,owner_id,turn_id,cost_usd,details) VALUES
          ('usage-mixed-api','usage-owner',$1,0.2,'{"provider":"openai","model":"fixture-shared"}'),
          ('usage-mixed-plan','usage-owner',$1,NULL,'{"provider":"openai","model":"fixture-shared","estimateUsd":0.4}'),
          ('usage-unpriced','usage-owner',$2,NULL,'{"provider":"compatible","model":"fixture-unknown-price","status":"succeeded"}'),
          ('usage-free','usage-owner',$3,0,'{"provider":"compatible","model":"fixture-local","status":"succeeded"}'),
          ('usage-legacy','usage-owner',$4,0.1,'{}'),
          ('usage-foreign','other',$1,9,'{"provider":"foreign","model":"foreign-model"}')`,
        [mixedTurn, unpricedTurn, freeTurn, legacyTurn],
      );
      await pool.query(
        `INSERT INTO app_actions(owner_id,turn_id,action,basis)
          VALUES('other',$1,'FOREIGN_ACTION','{"kind":"read"}')`,
        [mixedTurn],
      );
      const attributed = await attributionLedger.read();
      assert.equal(attributed.month.planUsage, true);
      assert.equal(attributed.month.unpriced, true);
      assert.equal(Math.round(attributed.month.spentUsd * 100), 30);
      assert.equal(attributed.entries.length, 5);
      const mixed = attributed.entries.find((entry) => entry.id === mixedTurn)!;
      assert.equal(mixed.costUsd, 0.2);
      assert.deepEqual(mixed.actions, []);
      assert.deepEqual(mixed.models, [
        { provider: 'openai', model: 'fixture-shared', billing: 'api' },
        { provider: 'openai', model: 'fixture-shared', billing: 'plan' },
      ]);
      assert.deepEqual(attributed.entries.find((entry) => entry.id === unpricedTurn)!.models, [
        { provider: 'compatible', model: 'fixture-unknown-price', billing: 'api' },
      ]);
      assert.equal(attributed.entries.find((entry) => entry.id === freeTurn)!.costUsd, null);
      assert.equal(attributed.entries.find((entry) => entry.id === freeTurn)!.pricing, 'unpriced');
      assert.deepEqual(attributed.entries.find((entry) => entry.id === legacyTurn)!.models, [
        { provider: null, model: null, billing: 'api' },
      ]);
      assert.deepEqual(await attributionLedger.checkIn(subscriptionTurn!, subscriptionTurn!), {
        budgetUsd: 5,
        spentUsd: 0.6,
        planUsd: 0.6,
      });
      await attributionLedger.setLimits({ monthlyUsd: 1 });
      assert.equal(await attributionLedger.limitReached(), false);
    } finally {
      await app.close();
      await pool.end();
      await admin.query(`DROP SCHEMA ${schema} CASCADE`);
      await admin.end();
    }
  },
);

test('managed uploads retain the selected account across separate operation sessions', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'nod-integration-uploads-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const uploads: Array<Record<string, unknown>> = [];
  const proxy = createComposioProxy({
    keyStore: installationKeyStore,
    checkpoint: fixtureIdentityCheckpoint,
    dataRoot: root,
    ownerId: 'owner',
    url: 'https://proxy.example.test',
    request: async (input, init) => {
      const request = new Request(input, init);
      const url = new URL(request.url);
      assert.equal(url.origin, 'https://proxy.example.test');
      assert.ok(request.headers.has('x-nod-signature'));
      assert.equal(request.headers.has('x-api-key'), false);
      if (url.pathname === '/v2/access/enroll')
        return Response.json({ state: 'enabled', userId: proxy.userId });
      if (url.pathname === '/v2/api/v3.1/toolkits')
        return Response.json({ items: [], next_cursor: null });
      if (
        url.pathname === '/v2/api/v3.1/tool_router/session' ||
        url.pathname === '/v2/api/v3.1/tool_router/session/trs_private_metered'
      )
        return Response.json({
          session_id: 'trs_private_metered',
          mcp: { type: 'http', url: 'https://proxy.example.test/unsupported-mcp' },
          config: {
            user_id: proxy.userId,
            toolkits: { enabled: ['gmail'] },
            connected_accounts: { gmail: ['ca_private_first', 'ca_private_second'] },
          },
          config_version: 1,
        });
      assert.equal(url.pathname, '/v2/files/upload');
      const body = (await request.json()) as Record<string, unknown>;
      uploads.push(body);
      assert.equal(body.sessionId, 'trs_private_metered');
      assert.equal(body.action, 'GMAIL_SEND_EMAIL');
      assert.equal(body.data, 'AP/+CkGA');
      return Response.json({
        name: body.name,
        mimetype: body.mimeType,
        s3key: 'nod-file.private-owned-capability',
      });
    },
  });
  await proxy.initialize();
  const provider = createComposioProvider({ proxy });
  const file = {
    name: 'private-attachment.bin',
    mimeType: 'application/octet-stream',
    bytes: Uint8Array.from([0, 255, 254, 10, 65, 128]),
  };
  for (const [session, account] of [
    [await provider.createSession('owner', { gmail: 'ca_private_first' }), 'ca_private_first'],
    [await provider.createSession('owner', { gmail: 'ca_private_second' }), 'ca_private_second'],
  ] as const)
    assert.deepEqual(
      await session.upload!('GMAIL_SEND_EMAIL', file, new AbortController().signal, account),
      {
        name: file.name,
        mimetype: file.mimeType,
        s3key: 'nod-file.private-owned-capability',
      },
    );
  assert.deepEqual(
    uploads.map((upload) => upload.accountId),
    ['ca_private_first', 'ca_private_second'],
  );
});

function inboxPollFixture<M extends 'pollInbox' | 'inboxSnippets' | 'inboxThreads' = 'pollInbox'>(
  t: TestContext,
  respond: (
    input: Parameters<Composio['tools']['proxyExecute']>[0],
    signal: AbortSignal,
  ) => unknown,
  method: M = 'pollInbox' as M,
) {
  const client = new Composio({
    apiKey: 'fixture-key-never-live',
    baseURL: 'https://proxy.fixture.invalid',
    allowTracking: false,
    disableVersionCheck: true,
    fileUploadDirs: false,
  });
  t.mock.method(client.getClient().toolkits, 'list', async () => ({
    items: [],
    next_cursor: null,
  }));
  t.mock.method(
    client.tools,
    'proxyExecute',
    async (
      input: Parameters<Composio['tools']['proxyExecute']>[0],
      options: { signal: AbortSignal },
    ) => {
      assert.equal(input.connectedAccountId, 'inbox-account');
      assert.equal(input.method, 'GET');
      assert.equal(new URL(input.endpoint).origin, 'https://gmail.googleapis.com');
      assert.ok(options.signal instanceof AbortSignal);
      return respond(input, options.signal);
    },
  );
  return createComposioProvider({ proxy: composioProxyFixture(client) })[method]!;
}

test('Composio inbox polling rejects cancellation and invalid metadata after partial progress', async (t) => {
  let deadline = new AbortController();
  t.mock.method(AbortSignal, 'timeout', () => {
    deadline = new AbortController();
    return deadline.signal;
  });
  let external = new AbortController();
  let failure: 'cancel' | 'invalid' | 'identity' | 'unlabeled' | 'none' = 'cancel';
  const poll = inboxPollFixture(t, (input, signal) => {
    if (input.endpoint.endsWith('/history'))
      return {
        status: 200,
        data: {
          historyId: '200',
          history: [{ messagesAdded: ['m0', 'm1'].map((id) => ({ message: { id } })) }],
        },
      };
    const id = input.endpoint.split('/').at(-1)!;
    if (id === 'm1' && failure === 'cancel') {
      deadline.abort(new DOMException('Fixture deadline', 'TimeoutError'));
      external.abort();
      signal.throwIfAborted();
    }
    return {
      status: 200,
      data: {
        id: id === 'm1' && failure === 'identity' ? 'other-message' : id,
        threadId: `thread-${id}`,
        internalDate: id === 'm1' && failure === 'invalid' ? 'invalid' : '1790769600000',
        ...(id === 'm1' && failure === 'unlabeled' ? {} : { labelIds: ['INBOX'] }),
        payload: { headers: [] },
      },
    };
  });
  const cursor = JSON.stringify({ accountId: 'inbox-account', historyId: '100' });
  await assert.rejects(poll('inbox-account', cursor, external.signal), { name: 'AbortError' });
  external = new AbortController();
  for (const invalid of ['invalid', 'identity'] as const) {
    failure = invalid;
    await assert.rejects(poll('inbox-account', cursor, external.signal));
  }
  failure = 'none';
  const recovered = await poll('inbox-account', cursor, external.signal);
  assert.deepEqual(
    recovered.messages.map(({ id }) => id),
    ['m0', 'm1'],
  );
  assert.equal(recovered.hasMore, false);
  assert.equal(JSON.parse(recovered.cursor).historyId, '200');
  failure = 'unlabeled';
  const unlabeled = await poll('inbox-account', cursor, external.signal);
  assert.deepEqual(
    unlabeled.messages.map(({ id }) => id),
    ['m0'],
  );
  assert.equal(unlabeled.hasMore, false);
  assert.equal(JSON.parse(unlabeled.cursor).historyId, '200');
});

test('Composio inbox failure diagnostics keep private provider detail out of logs', async (t) => {
  const diagnostics: Array<Record<string, unknown>> = [];
  t.mock.method(console, 'warn', (value: string) => {
    diagnostics.push(JSON.parse(value));
  });
  let failure: unknown = {
    status: 503,
    data: { error: 'private-provider-token', headers: { Authorization: 'private-key' } },
  };
  const poll = inboxPollFixture(t, (input) => {
    if (input.endpoint.endsWith('/history'))
      return {
        status: 200,
        data: {
          historyId: '200',
          history: [{ messagesAdded: [{ message: { id: 'private-message-id' } }] }],
        },
      };
    if (failure instanceof Error) throw failure;
    return failure;
  });
  const cursor = JSON.stringify({ accountId: 'inbox-account', historyId: '100' });
  await assert.rejects(poll('inbox-account', cursor, new AbortController().signal));
  failure = {
    status: 200,
    data: {
      id: 'private-message-id',
      threadId: 'private-thread-id',
      internalDate: '1790769600000',
      labelIds: ['INBOX'],
      payload: {
        headers: [{ name: 'private-header-name', value: 'private-header-value'.repeat(1000) }],
      },
    },
  };
  await assert.rejects(poll('inbox-account', cursor, new AbortController().signal));
  failure = Object.assign(new Error('private-provider-error'), {
    status: 429,
    headers: { Authorization: 'private-key' },
  });
  await assert.rejects(poll('inbox-account', cursor, new AbortController().signal));
  assert.equal(diagnostics.length, 3);
  assert.doesNotMatch(JSON.stringify(diagnostics), /private|inbox-account|Authorization|https?:/);
});

test('connected provider cancellation reaches session creation, search, schemas, and execution', async (t) => {
  const client = new Composio({
    apiKey: 'fixture-key-never-live',
    baseURL: 'https://proxy.fixture.invalid',
    allowTracking: false,
    disableVersionCheck: true,
    fileUploadDirs: false,
  });
  t.mock.method(client.getClient().toolkits, 'list', async () => ({
    items: [],
    next_cursor: null,
  }));
  let phase = '';
  let started = () => {};
  const requests: AbortSignal[] = [];
  const block = (signal?: AbortSignal) => {
    assert.ok(signal);
    requests.push(signal);
    return new Promise<never>((_resolve, reject) => {
      signal.addEventListener('abort', () => reject(signal.reason), { once: true });
      started();
    });
  };
  const managed = {
    sessionId: 'fixture-session',
    search: async (_input: unknown, options: { signal?: AbortSignal }) => {
      if (phase === 'search') return block(options.signal);
      return {
        success: true,
        error: null,
        toolSchemas: {
          GMAIL_FETCH_EMAILS: {
            toolSlug: 'GMAIL_FETCH_EMAILS',
            toolkit: 'gmail',
            hasFullSchema: false,
            schemaRef: {
              tool: 'COMPOSIO_GET_TOOL_SCHEMAS',
              args: { toolSlugs: ['GMAIL_FETCH_EMAILS'] },
            },
          },
        },
        results: [],
      };
    },
    execute: async (
      _action: string,
      _args: unknown,
      account: { account: string },
      options: { signal?: AbortSignal; maxRetries?: number },
    ) => {
      assert.equal(account.account, 'fixture-account');
      assert.equal(options.maxRetries, 0);
      return block(options.signal);
    },
  };
  t.mock.method(
    client.sessions,
    'create',
    async (_owner: string, _input: unknown, options: { signal?: AbortSignal }) =>
      phase === 'create' ? block(options.signal) : managed,
  );
  t.mock.method(
    client.getClient().toolRouter.session,
    'executeMeta',
    async (_id: string, _input: unknown, options: { signal?: AbortSignal }) =>
      block(options.signal),
  );
  const provider = createComposioProvider({ proxy: composioProxyFixture(client) });
  const session = await provider.createSession('fixture-owner', { gmail: ['fixture-account'] });
  for (const [name, run] of [
    ['create', (signal: AbortSignal) => provider.createSession('fixture-owner', {}, signal)],
    ['search', (signal: AbortSignal) => session.search('email', signal)],
    ['schema', (signal: AbortSignal) => session.search('email', signal)],
    [
      'execute',
      (signal: AbortSignal) => session.execute('GMAIL_FETCH_EMAILS', {}, 'fixture-account', signal),
    ],
  ] as const) {
    phase = name;
    const waiting = new Promise<void>((resolve) => {
      started = resolve;
    });
    const controller = new AbortController();
    const result = assert.rejects(run(controller.signal), { name: 'AbortError' });
    await waiting;
    controller.abort();
    await result;
    assert.equal(requests.at(-1)?.aborted, true);
    const count = requests.length;
    await assert.rejects(run(controller.signal), { name: 'AbortError' });
    assert.equal(requests.length, count);
  }
  assert.equal(requests.length, 4);
});

test('discovered requests follow redirects only to checked public addresses and drop credentials across origins', async () => {
  const { PassThrough } = await import('node:stream');
  const { EventEmitter } = await import('node:events');
  const sent: Array<{ url: string; authorization?: string }> = [];
  const routes: Record<string, { status: number; location?: string }> = {
    'https://api.fixture.example/start': {
      status: 302,
      location: 'https://files.fixture.example/data',
    },
    'https://files.fixture.example/data': { status: 200 },
    'https://api.fixture.example/private': {
      status: 307,
      location: 'https://internal.fixture.example/',
    },
    'https://api.fixture.example/item': {
      status: 301,
      location: 'https://api.fixture.example/items/1',
    },
    'https://api.fixture.example/items/1': { status: 200 },
    'https://api.fixture.example/broken': { status: 302, location: 'https://[' },
  };
  const methods: string[] = [];
  const request = ((
    url: URL,
    options: { method: string; headers: Record<string, string> },
    callback: (incoming: unknown) => void,
  ) => {
    methods.push(options.method);
    sent.push({ url: url.href, authorization: options.headers.authorization });
    const route = routes[url.href]!;
    const incoming = Object.assign(new PassThrough(), {
      statusCode: route.status,
      headers: route.location ? { location: route.location } : { 'content-type': 'text/plain' },
    });
    queueMicrotask(() => {
      callback(incoming);
      incoming.end(route.status === 200 ? 'synthetic file' : '');
    });
    return Object.assign(new EventEmitter(), { end() {} });
  }) as unknown as NonNullable<Parameters<typeof safeRemoteFetch>[2]>['request'];
  const validate = async (value: string) => {
    const url = new URL(value);
    if (url.hostname === 'internal.fixture.example')
      throw new Error('Private network destinations are blocked.');
    return { url, address: '93.184.216.34' };
  };
  const response = await safeRemoteFetch(
    'https://api.fixture.example/start',
    { headers: { authorization: 'Bearer synthetic-token' } },
    { validate, request },
  );
  assert.equal(await response.text(), 'synthetic file');
  assert.deepEqual(sent, [
    { url: 'https://api.fixture.example/start', authorization: 'Bearer synthetic-token' },
    { url: 'https://files.fixture.example/data', authorization: undefined },
  ]);
  await assert.rejects(
    safeRemoteFetch(
      'https://api.fixture.example/private',
      { method: 'POST', body: '{}' },
      { validate, request },
    ),
    /Private network/,
  );
  methods.length = 0;
  await safeRemoteFetch(
    'https://api.fixture.example/item',
    { method: 'DELETE' },
    { validate, request },
  );
  assert.deepEqual(methods, ['DELETE', 'DELETE']);
  await assert.rejects(
    safeRemoteFetch('https://api.fixture.example/broken', {}, { validate, request }),
    /invalid address/,
  );
});

test(
  'connection failures expose bounded recovery errors and require a manual retry',
  { skip: !process.env.TEST_DATABASE_URL },
  async (t) => {
    const { IntegrationConnectionError } = await import('../src/ports/integrations.ts');
    const f = await appsFixture(t);
    const authorize = f.session.authorize;
    const privateValue = 'synthetic-private-provider-key';
    let failure: Error | undefined;
    let phase: 'session' | 'link' = 'session';
    let sessions = 0;
    let authorizations = 0;
    f.provider.createSession = async () => {
      sessions++;
      if (failure && phase === 'session') throw failure;
      return f.session;
    };
    f.session.authorize = async (...args) => {
      authorizations++;
      if (failure) throw failure;
      return authorize(...args);
    };
    const connect = () =>
      f.app.inject({
        method: 'POST',
        url: '/api/apps/gmail/connect',
        payload: { returnTo: 'window' },
      });
    const pending = async () =>
      Number((await f.pool.query('SELECT count(*) FROM app_connections')).rows[0].count);
    phase = 'link';
    failure = Object.assign(new IntegrationConnectionError('timeout', phase), {
      cause: new Error(privateValue),
      response: { body: privateValue },
    });
    const classified = await connect();
    assert.doesNotMatch(classified.body, new RegExp(privateValue));
    assert.equal(sessions, 1);
    assert.equal(authorizations, 1);
    assert.equal(await pending(), 0);
    phase = 'session';
    failure = Object.assign(new Error(privateValue), { statusCode: 401, code: privateValue });
    const beforeFailure = sessions;
    const unknown = await connect();
    assert.doesNotMatch(unknown.body, new RegExp(privateValue));
    assert.equal(sessions, beforeFailure + 1);
    assert.equal(await pending(), 0);
    failure = undefined;
    const retried = await connect();
    assert.equal(retried.statusCode, 200, retried.body);
    assert.equal(sessions, beforeFailure + 2);
    assert.equal(await pending(), 1);
  },
);

test(
  'approved actions refuse an account that became inactive or was revoked during session creation',
  { skip: !process.env.TEST_DATABASE_URL },
  async (t) => {
    const owner = 'local-development';
    const f = await appsFixture(t);
    f.provider.supportedServices = [...integrationServiceIds, 'github'];
    await f.pool.query(
      `INSERT INTO app_connections(owner_id,slug,pending_account_id,callback_hash,callback_expires,provider_id)
       VALUES('another-owner','github','foreign-abandoned','foreign-hash',now()-interval '1 minute','fixture')`,
    );
    const connected = await f.connect('github');
    assert.equal(
      (
        await f.pool.query(
          "SELECT 1 FROM app_connections WHERE pending_account_id='foreign-abandoned'",
        )
      ).rowCount,
      1,
    );
    const prepared = await f.service.prepare(owner, 'GITHUB_LIST_REPOSITORIES', {
      connectionId: connected.connectionId,
    });
    const executions = f.executed.length;
    await f.pool.query('UPDATE app_connections SET account_active=false WHERE id=$1', [
      connected.connectionId,
    ]);
    await assert.rejects(f.service.executeApproved(owner, 'GITHUB_LIST_REPOSITORIES', prepared), {
      statusCode: 404,
    });
    await f.pool.query('UPDATE app_connections SET account_active=true WHERE id=$1', [
      connected.connectionId,
    ]);
    const createSession = f.provider.createSession;
    f.provider.createSession = async (...args) => {
      const session = await createSession(...args);
      await f.pool.query('UPDATE app_connections SET revoked=true WHERE id=$1', [
        connected.connectionId,
      ]);
      return session;
    };
    await assert.rejects(f.service.executeApproved(owner, 'GITHUB_LIST_REPOSITORIES', prepared), {
      statusCode: 404,
    });
    assert.equal(f.executed.length, executions);
  },
);

test(
  'source identity survives a login refresh and rejects an in-flight account swap',
  { skip: !process.env.TEST_DATABASE_URL },
  async (t) => {
    const captured: import('../src/server/analytics.ts').AnalyticsEvent[] = [];
    const f = await appsFixture(t, {}, { analytics: (event) => captured.push(event) });
    const connected = await f.connect('gmail');
    assert.ok(connected.connectionId);
    const { identity } = createComposioProvider({
      proxy: composioProxyFixture({} as Composio),
    }).activity!.gmail;
    const gmail = { read: async () => ({ records: [] }), identity };
    f.provider.activity = { gmail };
    await f.pool.query(
      "UPDATE app_connections SET account_email='owner@example.test' WHERE id=$1",
      [connected.connectionId],
    );
    const first = (await f.service.activitySources())[0];
    assert.ok(first.revision);
    assert.equal(first.changeToken, undefined);
    assert.equal(first.eventDriven, true);
    await f.pool.query(
      'UPDATE app_connections SET inbox_failed=true,triggers_enabled=false,trigger_id=NULL WHERE id=$1',
      [connected.connectionId],
    );
    const degraded = (await f.service.activitySources())[0];
    assert.equal(degraded.active, true);
    assert.equal(degraded.changeToken, undefined);
    assert.equal(degraded.eventDriven, false);
    await f.pool.query(
      'UPDATE app_connections SET inbox_failed=false,inbox_reconnect_required=true WHERE id=$1',
      [connected.connectionId],
    );
    assert.equal((await f.service.activitySources())[0].changeToken, undefined);
    await f.pool.query(
      'UPDATE app_connections SET inbox_reconnect_required=false,watch_requested=false WHERE id=$1',
      [connected.connectionId],
    );
    assert.equal((await f.service.activitySources())[0].active, false);
    await f.pool.query('UPDATE app_connections SET watch_requested=true WHERE id=$1', [
      connected.connectionId,
    ]);

    await f.pool.query('UPDATE app_connections SET account_active=false WHERE id=$1', [
      connected.connectionId,
    ]);
    const expired = (await f.service.activitySources())[0];
    assert.equal(expired.revision, first.revision);
    assert.equal(expired.active, false);
    assert.equal(
      (await f.service.connectedApps()).some((app) => app.connectionId === connected.connectionId),
      false,
    );
    await f.pool.query(
      "UPDATE app_connections SET account_active=true,account_id='replacement-physical-id' WHERE id=$1",
      [connected.connectionId],
    );
    const refreshed = (await f.service.activitySources())[0];
    assert.equal(refreshed.revision, first.revision);
    assert.equal(refreshed.active, true);
    await f.service.readActivity(
      { connectionId: connected.connectionId, revision: first.revision },
      new AbortController().signal,
    );
    gmail.read = async () => {
      await f.pool.query(
        "UPDATE app_connections SET account_id='another-physical-id' WHERE id=$1",
        [connected.connectionId],
      );
      return { records: [] };
    };
    await assert.rejects(
      f.service.readActivity(
        { connectionId: connected.connectionId, revision: first.revision },
        new AbortController().signal,
      ),
      /changed during/,
    );
    await f.pool.query(
      "UPDATE app_connections SET account_email='different@example.test' WHERE id=$1",
      [connected.connectionId],
    );
    assert.notEqual((await f.service.activitySources())[0].revision, first.revision);
    await assert.rejects(
      f.service.readActivity(
        { connectionId: connected.connectionId, revision: first.revision },
        new AbortController().signal,
      ),
      /changed before/,
    );
    const reads = captured.filter((event) => event.event === 'service_used');
    assert.equal(reads.length, 2);
    assert.equal(reads[0]!.properties.app, 'gmail');
    assert.equal(reads[0]!.properties.outcome, 'succeeded');
    assert.equal(reads[1]!.properties.outcome, 'failed');
    for (const value of ['owner@example.test', 'replacement-physical-id', connected.connectionId])
      assert.equal(JSON.stringify(reads).includes(value), false);
  },
);

test('proactive readers use fixed GET paths, preserve pages, and check exact source state', async () => {
  const { composioActivity } = await import('../src/providers/composio/activity.ts');
  const readActivity = async (
    client: Pick<Composio['tools'], 'proxyExecute'>,
    service: string,
    accountId: string,
    input: { ids?: string[]; cursor?: string; asOf?: string },
    signal: AbortSignal,
  ) => {
    const readers = composioActivity(client);
    if (!Object.hasOwn(readers, service)) throw new Error('This source has no reader.');
    return readers[service].read(accountId, input, signal);
  };
  const calls: Array<{
    endpoint: string;
    method: string;
    parameters?: Array<{ name: string; value: unknown }>;
  }> = [];
  const message = (id: string, at: number, labels: string[]) => ({
    id,
    internalDate: String(at),
    labelIds: labels,
    payload: {
      mimeType: 'text/plain',
      headers: [
        { name: 'From', value: 'sender@example.test' },
        { name: 'Subject', value: 'Fixture request' },
      ],
      body: { data: Buffer.from('Please review the synthetic plan.').toString('base64url') },
    },
  });
  let fail = false;
  const proxyExecute = async (input: Parameters<Composio['tools']['proxyExecute']>[0]) => {
    assert.equal(input.method, 'GET');
    assert.equal(input.connectedAccountId, 'fixture-account');
    calls.push(input);
    if (fail) return { status: 503, data: {} };
    if (input.endpoint.endsWith('/missing')) return { status: 404, data: {} };
    if (input.endpoint.endsWith('/threads'))
      return { status: 200, data: { threads: [{ id: 'thread1' }], nextPageToken: 'page2' } };
    if (input.endpoint.endsWith('/thread1'))
      return {
        status: 200,
        data: {
          id: 'thread1',
          messages: [
            message('sent', 2000, ['SENT']),
            message('received', 1000, ['INBOX']),
            message('draft', 3000, ['DRAFT']),
          ],
        },
      };
    if (input.endpoint.includes('/messages/')) {
      const messageId = input.endpoint.split('/').at(-1)!;
      return {
        status: 200,
        data: message(
          messageId,
          messageId === 'sent' ? 2000 : 1000,
          messageId === 'sent' ? ['SENT'] : ['INBOX'],
        ),
      };
    }
    if (input.endpoint.endsWith('/cancelled'))
      return { status: 200, data: { id: 'cancelled', status: 'cancelled' } };
    throw new Error('Unexpected endpoint.');
  };
  const client = { proxyExecute } as unknown as Pick<Composio['tools'], 'proxyExecute'>;
  const read = (service: string, input: { ids?: string[]; cursor?: string; asOf?: string }) =>
    readActivity(client, service, 'fixture-account', input, new AbortController().signal);
  const first = await read('gmail', { asOf: '2026-10-23T12:00:00.000Z' });
  assert.equal(first.nextCursor, 'page2');
  assert.equal(first.records[0].available, true);
  assert.equal((first.records[0].data.messages as Array<{ sent: boolean }>).at(-1)!.sent, true);
  assert.equal((first.records[0].data.messages as unknown[]).length, 1);
  const second = await read('gmail', {
    cursor: first.nextCursor,
    asOf: '2026-10-23T12:00:00.000Z',
  });
  assert.equal(second.records[0].version, first.records[0].version);
  assert.ok(JSON.stringify(calls).includes('page2'));
  assert.equal((await read('gmail', { ids: ['missing'] })).records[0].available, false);
  assert.equal((await read('gmail', { ids: ['thread1'] })).records[0].available, true);
  assert.ok(
    calls
      .filter((call) => call.endpoint.includes('/threads/'))
      .every(
        (call) =>
          !call.parameters?.some(
            (parameter) => parameter.name === 'format' && parameter.value === 'full',
          ),
      ),
  );
  assert.equal(
    (await read('googlecalendar', { ids: ['cancelled'] })).records[0].data.status,
    'cancelled',
  );
  assert.ok(
    calls.every((call) =>
      ['https://gmail.googleapis.com', 'https://www.googleapis.com'].includes(
        new URL(call.endpoint).origin,
      ),
    ),
  );
  const before = calls.length;
  for (const id of ['../messages/send', 'id?alt=media', 'https://evil.example'])
    await assert.rejects(read('gmail', { ids: [id] }));
  await assert.rejects(read('unknown', {}));
  await assert.rejects(readActivity(client, 'gmail', 'fixture-account', {}, AbortSignal.abort()));
  assert.equal(calls.length, before);
  fail = true;
  await assert.rejects(read('gmail', {}), /could not be checked/);
  const isolatedCalls: Array<Parameters<Composio['tools']['proxyExecute']>[0]> = [];
  const isolated = {
    proxyExecute: async (input: Parameters<Composio['tools']['proxyExecute']>[0]) => {
      isolatedCalls.push(input);
      const item = input.endpoint.split('/').at(-1)!;
      if (item === 'threads')
        return {
          status: 200,
          data: {
            threads: [{ id: 'bad' }, { id: 'large' }, { id: 'good' }],
            nextPageToken: 'next-page',
          },
        };
      if (item === 'bad') return { status: 503, data: {} };
      if (input.endpoint.includes('/messages/')) {
        const full = input.parameters?.some(
          (parameter) => parameter.name === 'format' && parameter.value === 'full',
        );
        return {
          status: 200,
          data:
            item === 'large1000' && full
              ? { ...message(item, 1000, []), oversized: 'x'.repeat(1_000_001) }
              : message(item, 1000, []),
        };
      }
      return {
        status: 200,
        data: {
          id: item,
          historyId: 'history-one',
          messages:
            item === 'large'
              ? Array.from({ length: 1001 }, (_, i) => ({
                  id: `large${i}`,
                  internalDate: String(i + 1),
                  labelIds: ['INBOX'],
                }))
              : [{ id: 'good-message', internalDate: '1000', labelIds: ['INBOX'] }],
        },
      };
    },
  } as unknown as Pick<Composio['tools'], 'proxyExecute'>;
  const partial = await readActivity(
    isolated,
    'gmail',
    'fixture-account',
    {},
    new AbortController().signal,
  );
  assert.equal(partial.nextCursor, 'next-page');
  assert.equal(partial.records.find((record) => record.id === 'bad')?.error, 'unavailable');
  assert.equal(partial.records.find((record) => record.id === 'large')?.available, true);
  assert.equal(partial.records.find((record) => record.id === 'good')?.available, true);
  assert.ok(
    isolatedCalls
      .filter((call) => call.endpoint.includes('/threads/'))
      .every(
        (call) =>
          !call.parameters?.some(
            (parameter) => parameter.name === 'format' && parameter.value === 'full',
          ),
      ),
  );
  const exact = await readActivity(
    isolated,
    'gmail',
    'fixture-account',
    { ids: ['large', 'good'] },
    new AbortController().signal,
  );
  assert.equal(exact.records.find((record) => record.id === 'large')?.error, 'unavailable');
  assert.equal(exact.records.find((record) => record.id === 'good')?.available, true);
  const slow = {
    proxyExecute: async (input: Parameters<Composio['tools']['proxyExecute']>[0]) => {
      if (input.endpoint.endsWith('/threads'))
        return {
          status: 200,
          data: { threads: [{ id: 'slow' }, { id: 'good' }], nextPageToken: 'after-slow' },
        };
      if (input.endpoint.endsWith('/slow')) return new Promise<never>(() => {});
      return isolated.proxyExecute(input);
    },
  } as unknown as Pick<Composio['tools'], 'proxyExecute'>;
  const started = performance.now();
  const recovered = await readActivity(
    slow,
    'gmail',
    'fixture-account',
    {},
    new AbortController().signal,
  );
  assert.ok(performance.now() - started < 10000);
  assert.equal(recovered.records.find((record) => record.id === 'slow')?.error, 'unavailable');
  assert.equal(recovered.records.find((record) => record.id === 'good')?.available, true);
  assert.equal(recovered.nextCursor, 'after-slow');
});

test('generic source privacy checks hide access mail and cannot delay Stop', async () => {
  const { createObservationSources } = await import('../src/server/observation-sources.ts');
  const secret = 'synthetic-known-source-secret';
  const analytics: import('../src/server/analytics.ts').AnalyticsEvent[] = [];
  let release: () => void = () => {};
  let begin: () => void = () => {};
  let hold = false;
  let entered = new Promise<void>((resolve) => {
    begin = resolve;
  });
  const pending = new Promise<void>((resolve) => {
    release = resolve;
  });
  const source = createObservationSources(
    [
      {
        id: 'records',
        sources: async () => [
          {
            id: 'feed',
            label: 'Private feed',
            description: 'Read current records.',
            revision: 'v1',
            readable: true,
          },
        ],
        read: async () => ({
          records: [
            {
              id: 'item/1',
              version: 'v1',
              available: true,
              data: {
                note: secret,
                mail: {
                  id: 'access/1',
                  from: 'sender@example.test',
                  subject: 'Sign in',
                  text: 'Your synthetic sign-in code is 843921. ' + secret,
                },
                padding1: 'x'.repeat(64000),
                padding2: 'y'.repeat(64000),
                padding3: 'z'.repeat(64000),
              },
            },
          ],
        }),
      },
    ],
    {
      secrets: [secret],
      analytics: (event) => analytics.push(event),
      check: async (mail) => {
        assert.equal(JSON.stringify(mail).includes(secret), false);
        begin();
        if (hold) await pending;
        return mail.map(() => true);
      },
    },
  );
  const result = await source.read({ sourceId: 'records:feed' }, new AbortController().signal);
  assert.equal(JSON.stringify(result).includes(secret), false);
  assert.equal(JSON.stringify(result).includes('843921'), false);
  assert.match(JSON.stringify(result), /content is private/);
  assert.equal(analytics.length, 1);
  assert.deepEqual(analytics[0], {
    event: 'source_read',
    properties: {
      source_type: 'other',
      operation: 'records',
      outcome: 'succeeded',
      duration_ms: (analytics[0] as any).properties.duration_ms,
      record_count: 1,
      unavailable_count: 0,
    },
  });
  assert.ok(Number((analytics[0] as any).properties.duration_ms) >= 0);
  for (const value of [secret, 'records:feed', 'Private feed', '843921', 'item/1'])
    assert.equal(JSON.stringify(analytics).includes(value), false);
  hold = true;
  entered = new Promise<void>((resolve) => {
    begin = resolve;
  });
  const controller = new AbortController();
  const stopped = source.read({ sourceId: 'records:feed' }, controller.signal);
  await entered;
  controller.abort();
  await assert.rejects(stopped);
  assert.equal(analytics.length, 2);
  assert.equal((analytics[1] as any).properties.outcome, 'cancelled');
  release();
  await Promise.resolve();
  assert.equal(analytics.length, 2);
  const recovering = createObservationSources(
    [
      {
        id: 'mail',
        sources: async () => [
          {
            id: 'feed',
            label: 'Synthetic feed',
            description: 'Read current records.',
            revision: 'one',
            readable: true,
          },
        ],
        read: async () => ({
          records: ['slow', 'ready'].map((id) => ({
            id,
            version: 'v1',
            available: true,
            data: {
              from: id + '@example.test',
              subject: 'Synthetic request',
              text: 'Please review this item.',
            },
          })),
          nextCursor: 'second-page',
        }),
      },
    ],
    {
      check: async (mail) =>
        mail.some((email) => email.from.startsWith('slow'))
          ? new Promise<Array<boolean>>(() => {})
          : mail.map(() => false),
    },
  );
  const started = Date.now();
  const page = await recovering.read({ sourceId: 'mail:feed' }, new AbortController().signal);
  assert.equal(page.nextCursor, 'second-page');
  assert.equal(page.records.find((record) => record.id === 'slow')?.error, 'unavailable');
  assert.equal(page.records.find((record) => record.id === 'ready')?.available, true);
  assert.ok(Date.now() - started < 15000);
});

test(
  'cheap source changes keep stable tokens and reject failures and account races',
  { skip: !process.env.TEST_DATABASE_URL },
  async (t) => {
    let removed = '';
    const f = await appsFixture(
      t,
      {},
      {
        removeActivity: async (id, client) => {
          const current = (
            await client.query('SELECT revoked FROM app_connections WHERE id=$1', [id])
          ).rows[0];
          assert.equal(current.revoked, true);
          removed = id;
        },
      },
    );
    const account = await f.connect('googlecalendar');
    const calendar: import('../src/ports/integrations.ts').ActivityReader = {
      read: async () => ({ records: [] }),
    };
    f.provider.activity = { googlecalendar: calendar };
    let calls = 0;
    let token = 'version-one';
    let fail = false;
    let swap = false;
    let changedConfiguration = false;
    calendar.changeToken = async (accountId) => {
      calls++;
      assert.equal(accountId, account.accountId);
      if (changedConfiguration) {
        await f.pool.query(
          "UPDATE app_connections SET configuration_id='replacement-config' WHERE id=$1",
          [account.connectionId],
        );
        throw new Error('The previous configuration failed late.');
      }
      if (fail) throw new Error('Synthetic outage');
      if (swap)
        await f.pool.query("UPDATE app_connections SET account_id='replacement' WHERE id=$1", [
          account.connectionId,
        ]);
      return token;
    };
    const age = () =>
      f.pool.query(
        "UPDATE app_connections SET activity_poll_at=now()-interval '1 minute' WHERE id=$1",
        [account.connectionId],
      );
    await f.service.pollActivityChanges();
    const first = (await f.service.activitySources())[0];
    assert.equal(first.changeToken, 'version-one');
    assert.equal(first.eventDriven, true);
    await f.service.pollActivityChanges();
    assert.equal(calls, 1);
    await age();
    await f.service.pollActivityChanges();
    assert.equal((await f.service.activitySources())[0].changeToken, first.changeToken);
    fail = true;
    await age();
    await f.service.pollActivityChanges();
    assert.equal((await f.service.activitySources())[0].active, false);
    fail = false;
    token = 'version-two';
    await age();
    await f.service.pollActivityChanges();
    assert.equal((await f.service.activitySources())[0].active, true);
    assert.equal((await f.service.activitySources())[0].changeToken, token);
    changedConfiguration = true;
    await age();
    await f.service.pollActivityChanges();
    assert.equal((await f.service.activitySources())[0].active, true);
    changedConfiguration = false;
    await f.pool.query('UPDATE app_connections SET configuration_id=NULL WHERE id=$1', [
      account.connectionId,
    ]);
    swap = true;
    token = 'wrong-account';
    await age();
    await f.service.pollActivityChanges();
    assert.equal((await f.service.activitySources())[0].changeToken, 'version-two');
    await f.pool.query('UPDATE app_connections SET account_id=$2 WHERE id=$1', [
      account.connectionId,
      account.accountId,
    ]);
    const response = await f.app.inject({
      method: 'POST',
      url: `/api/apps/googlecalendar/accounts/${account.connectionId}/disconnect`,
    });
    assert.equal(response.statusCode, 200, response.body);
    assert.equal(removed, account.connectionId);
    assert.equal((await f.service.activitySources()).length, 0);
  },
);
