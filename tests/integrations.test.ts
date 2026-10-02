import assert from 'node:assert/strict';
import { createHash, createHmac, randomBytes, randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test, { type TestContext } from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';
import { Composio } from '@composio/core';
import { APIConnectionError, APIConnectionTimeoutError } from '@composio/client';
import Fastify from 'fastify';
import pg from 'pg';
import type {
  Agent,
  AgentEvent,
  AgentToolResult,
  RuntimeContext,
  RuntimeObservation,
} from '../src/ports/agent.ts';
import {
  IntegrationInboxCursorExpired,
  type IntegrationFile,
  type IntegrationProvider,
  type IntegrationService,
  type IntegrationSession,
} from '../src/ports/integrations.ts';
import { createComposioProvider } from '../src/providers/composio/integrations.ts';
import { createDirectProvider } from '../src/providers/direct/integrations.ts';
import { createDirectOAuth } from '../src/providers/direct/oauth.ts';
import { withDirectMcp } from '../src/providers/direct/mcp.ts';
import { createDiscoveredOAuth } from '../src/providers/discovered/oauth.ts';
import { createDiscoveredTransport, safeRemoteFetch } from '../src/providers/discovered/remote.ts';
import { createAgentRuntime } from '../src/runtime/index.ts';
import { createDiscoveredConnections } from '../src/server/discovered-connections.ts';
import { createIntegrations, eventOverview } from '../src/server/integrations.ts';
import { createErrorRedactor } from '../src/server/inspector-redaction.ts';
import { createProviderUsageStore } from '../src/server/provider-usage.ts';
import {
  meterAgent,
  meterComputer,
  meterIntegrations,
  meterRelevance,
  meterSpeech,
} from '../src/server/provider-metering.ts';
import { createAppGrantVault } from '../src/server/vault-app-grants.ts';
import { integrationServiceIds } from '../src/shared/integrations.ts';
import { fakeComputer, fakeWorkspace } from './runtime-fixtures.ts';

function fakeProvider(session: IntegrationSession): IntegrationProvider {
  return {
    id: 'fixture',
    configured: true,
    webhooksConfigured: true,
    supportsSubscriptions: ['gmail', 'googlecalendar'],
    createSession: async () => session,
    restoreSession: async () => session,
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

test('notification summaries exclude message bodies, tokens, and unbounded provider payloads', () => {
  const summary = eventOverview('gmail', 'GMAIL_NEW_GMAIL_MESSAGE', {
    subject: `Login code 123456 ${'x'.repeat(3000)}`,
    sender: 'person@example.com',
    message_text: 'private body',
    access_token: 'provider-secret',
    payload: { password: 'another-secret' },
  });
  assert.match(summary, /untrusted event data/);
  assert.match(summary, /person@example.com/);
  for (const excluded of ['123456', 'private body', 'provider-secret', 'another-secret'])
    assert.equal(summary.includes(excluded), false);
  assert.ok(summary.length < 1000);
});

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
    let savedLoginReads = 0;
    let browserEndpoint = 'https://example.test';
    const iconOrigins: string[] = [];
    const integrations = await createIntegrations(pool, {
      ownerId: 'local-development',
      provider,
      baseUrl: 'http://localhost:4310',
      icon: async (origin) => {
        iconOrigins.push(origin);
        return { bytes: new Uint8Array([137, 80, 78, 71]), mimeType: 'image/png' };
      },
      browserAccounts: async () => {
        savedLoginReads++;
        return savedLoginIds.map((id, index) => ({
          kind: 'login' as const,
          id,
          label: index ? 'Personal' : 'Work',
          origin: 'https://login.example.test',
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
      const browserPaths = await integrations.manageConnections('list');
      assert.ok(Array.isArray(browserPaths));
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
      await assert.rejects(integrations.list('another-user'), { statusCode: 403 });
      assert.equal(savedLoginReads, 1);
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
          assert.match(result.headers['cache-control'] ?? '', /^private,/);
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
      const result = await integrations.execute('local-development', 'GMAIL_SEND_EMAIL', {
        recipient_email: 'test@example.com',
        subject: 'Fixture',
      });
      assert.deepEqual(result, { successful: true, data: { messages: [] } });
      assert.equal(executed, 1);
      await integrations.execute('local-development', 'GMAIL_FETCH_EMAILS', { max_results: 5 });
      assert.equal(executed, 2);
      await integrations.executeApproved('local-development', 'GMAIL_SEND_EMAIL', {
        recipient_email: 'fixture@example.com',
        connectionId: (await integrations.list()).find((row) => row.slug === 'gmail')?.connectionId,
      });
      assert.equal(executed, 3);
      await assert.rejects(integrations.execute('another-user', 'GMAIL_FETCH_EMAILS', {}));
      await assert.rejects(
        integrations.executeApproved('local-development', 'COMPOSIO_MULTI_EXECUTE_TOOL', {}),
      );
      await assert.rejects(
        integrations.executeApproved('local-development', 'GITHUB_CREATE_ISSUE', {}),
      );
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
      ]) {
        assert.deepEqual(await integrations.execute('local-development', 'SEARCH_TOOLS', args), {
          status: 'rejected',
          code: 'invalid_search_arguments',
          message:
            'SEARCH_TOOLS requires a query of 1 to 1000 characters and accepts an optional UUID connectionId. No app request was sent. Correct the arguments before continuing.',
        });
      }
      await assert.rejects(
        integrations.execute('another-user', 'SEARCH_TOOLS', { query: 'List labels' }),
      );
      assert.equal(searches.mock.callCount(), 1);
      t.mock.method(session, 'search', async () => {
        throw new Error('Fixture tool router timed out');
      });
      await assert.rejects(
        integrations.execute('local-development', 'SEARCH_TOOLS', { query: 'List Gmail labels' }),
        { message: 'App tool search failed: Fixture tool router timed out', statusCode: 502 },
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
      await assert.rejects(
        integrations.executeApproved('local-development', 'GMAIL_SEND_EMAIL', {}),
      );
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

test(
  'disconnect during session creation prevents execute on the removed account',
  { skip: !process.env.TEST_DATABASE_URL },
  async () => {
    const schema = `test_composio_${randomUUID().replaceAll('-', '')}`;
    const admin = new pg.Pool({ connectionString: process.env.TEST_DATABASE_URL });
    await admin.query(`CREATE SCHEMA ${schema}`);
    const pool = new pg.Pool({
      connectionString: process.env.TEST_DATABASE_URL,
      options: `-c search_path=${schema}`,
    });
    const app = Fastify();
    let entered!: () => void;
    let release!: () => void;
    const started = new Promise<void>((resolve) => {
      entered = resolve;
    });
    const blocked = new Promise<void>((resolve) => {
      release = resolve;
    });
    let executed = 0;
    const session: IntegrationSession = {
      id: 'delayed-session',
      authorize: async () => ({
        accountId: 'ca-fixture',
        url: 'https://fixture.example/connect',
      }),
      execute: async () => {
        executed++;
        return { successful: true };
      },
      search: async () => ({ tools: {}, suggestions: [] }),
    };
    const provider = fakeProvider(session);
    provider.createSession = async () => {
      entered();
      await blocked;
      return session;
    };
    const integrations = await createIntegrations(pool, {
      ownerId: 'local-development',
      provider,
      baseUrl: 'http://localhost:4310',
      wake: async () => {},
    });
    integrations.registerRoutes(app);
    let action: Promise<unknown> | undefined;
    try {
      const { rows } = await pool.query<{ id: string }>(
        "INSERT INTO app_connections(owner_id,slug,account_id,provider_id) VALUES ('local-development','gmail','ca-fixture','fixture') RETURNING id",
      );
      const args = { connectionId: rows[0]!.id, recipient_email: 'fixture@example.test' };
      action = integrations.executeApproved('local-development', 'GMAIL_SEND_EMAIL', args);
      const outcome = action.then(
        () => 'executed',
        () => 'rejected',
      );
      await started;
      const response = await app.inject({
        method: 'POST',
        url: `/api/apps/gmail/accounts/${rows[0]!.id}/disconnect`,
      });
      assert.equal(response.statusCode, 200);
      release();
      assert.equal(await outcome, 'rejected');
      assert.equal(executed, 0);
    } finally {
      release();
      await action?.catch(() => {});
      await app.close();
      await pool.end();
      await admin.query(`DROP SCHEMA ${schema} CASCADE`);
      await admin.end();
    }
  },
);

test(
  'connection callback requires its saved attempt and a provider-verified active account',
  { skip: !process.env.TEST_DATABASE_URL },
  async () => {
    const schema = `test_composio_${randomUUID().replaceAll('-', '')}`;
    const admin = new pg.Pool({ connectionString: process.env.TEST_DATABASE_URL });
    await admin.query(`CREATE SCHEMA ${schema}`);
    const pool = new pg.Pool({
      connectionString: process.env.TEST_DATABASE_URL,
      options: `-c search_path=${schema}`,
    });
    let callback = '';
    let providerStatus = 'INITIATED';
    const session: IntegrationSession = {
      id: 'fixture-session',
      authorize: async (_service, callbackUrl) => {
        callback = callbackUrl;
        return { accountId: 'ca-fixture', url: 'https://fixture.example/connect' };
      },
      execute: async () => ({}),
      search: async () => ({ tools: {}, suggestions: [] }),
    };
    const provider = fakeProvider(session);
    provider.inspectAccount = async () => ({
      active: providerStatus === 'ACTIVE',
      service: 'gmail',
    });
    const app = Fastify();
    const integrations = await createIntegrations(pool, {
      ownerId: 'local-development',
      provider,
      baseUrl: 'http://localhost:4310',
      wake: async () => {},
    });
    integrations.registerRoutes(app);
    try {
      assert.equal(
        (await app.inject({ method: 'POST', url: '/api/apps/gmail/connect' })).statusCode,
        200,
      );
      const url = new URL(callback);
      url.searchParams.set('outcome', 'ok');
      url.searchParams.set('account_ref', 'ca-other-user');
      const foreignAccount = await app.inject({ url: `${url.pathname}${url.search}` });
      assert.equal(foreignAccount.statusCode, 302, foreignAccount.body);
      assert.equal(foreignAccount.headers.location, 'http://localhost:4310/apps?connection=failed');
      url.searchParams.set('account_ref', 'ca-fixture');
      const inactiveAccount = await app.inject({ url: `${url.pathname}${url.search}` });
      assert.equal(inactiveAccount.statusCode, 302, inactiveAccount.body);
      assert.equal(
        inactiveAccount.headers.location,
        'http://localhost:4310/apps?connection=failed',
      );
      providerStatus = 'ACTIVE';
      assert.equal((await app.inject({ url: `${url.pathname}${url.search}` })).statusCode, 302);
      assert.equal(
        (await app.inject({ url: `${url.pathname}${url.search}` })).headers.location,
        'http://localhost:4310/apps?connection=expired',
      );
      const connection = (await integrations.list()).find((item) => item.slug === 'gmail');
      assert.equal(connection?.status, 'connected');
      assert.equal(connection?.triggersEnabled, true);
      assert.equal(connection?.triggersActive, true);
    } finally {
      await app.close();
      await pool.end();
      await admin.query(`DROP SCHEMA ${schema} CASCADE`);
      await admin.end();
    }
  },
);

test(
  'multiple Google accounts keep independent identity, actions, subscriptions and revocation',
  { skip: !process.env.TEST_DATABASE_URL },
  async () => {
    const schema = `test_accounts_${randomUUID().replaceAll('-', '')}`;
    const admin = new pg.Pool({ connectionString: process.env.TEST_DATABASE_URL });
    await admin.query(`CREATE SCHEMA ${schema}`);
    const pool = new pg.Pool({
      connectionString: process.env.TEST_DATABASE_URL,
      options: `-c search_path=${schema}`,
    });
    const app = Fastify();
    let attempt = 0;
    const callbacks: string[] = [];
    const executions: Array<{ action: string; args: Record<string, unknown>; accountId?: string }> =
      [];
    const subscriptions: string[] = [];
    const deleted: string[] = [];
    const accountSets: unknown[] = [];
    const session: IntegrationSession = {
      id: 'fixture-session',
      authorize: async (_service, callback) => {
        callbacks.push(callback);
        return { accountId: `account-${++attempt}`, url: 'https://fixture.example/connect' };
      },
      search: async () => ({ tools: {}, suggestions: [] }),
      execute: async (action, args, accountId) => {
        executions.push({ action, args, accountId });
        return { data: { labels: [] } };
      },
    };
    const provider = fakeProvider(session);
    provider.createSession = async (_owner, accounts) => {
      accountSets.push(accounts);
      return session;
    };
    provider.inspectAccount = async (id) => ({
      active: true,
      service: 'gmail',
      accountName: id === 'account-1' ? 'Personal account' : 'Work account',
      accountEmail: `${id}@example.com`,
    });
    provider.subscribe = async (_owner, _service, accountId) => {
      subscriptions.push(accountId);
      return { id: `trigger-${accountId}` };
    };
    provider.deleteAccount = async (id) => {
      deleted.push(id);
    };
    const delivered: string[] = [];
    const integrations = await createIntegrations(pool, {
      ownerId: 'local-development',
      provider,
      baseUrl: 'http://localhost:4310',
      wake: async (prompt) => {
        delivered.push(prompt);
      },
    });
    integrations.registerRoutes(app);
    async function connect() {
      assert.equal(
        (await app.inject({ method: 'POST', url: '/api/apps/gmail/connect' })).statusCode,
        200,
      );
      const callback = new URL(callbacks.at(-1)!);
      callback.searchParams.set('account_ref', `account-${attempt}`);
      callback.searchParams.set('outcome', 'ok');
      assert.equal(
        (await app.inject({ url: `${callback.pathname}${callback.search}` })).statusCode,
        302,
      );
    }
    try {
      await connect();
      await connect();
      const accounts = (await integrations.list()).filter((row) => row.slug === 'gmail');
      assert.equal(accounts.length, 2);
      const first = accounts.find((row) => row.accountId === 'account-1')!;
      const second = accounts.find((row) => row.accountId === 'account-2')!;
      assert.equal(first.accountEmail, 'account-1@example.com');
      assert.equal(second.accountName, 'Work account');
      assert.equal(first.triggerStatus, 'active');
      assert.equal(second.triggerStatus, 'active');
      assert.deepEqual(subscriptions, ['account-1', 'account-2']);
      await assert.rejects(integrations.execute('local-development', 'GMAIL_LIST_LABELS', {}), {
        statusCode: 409,
      });
      await integrations.execute('local-development', 'GMAIL_LIST_LABELS', {
        connectionId: second.connectionId,
        user_id: 'me',
      });
      assert.deepEqual(executions, [
        { action: 'GMAIL_LIST_LABELS', args: { user_id: 'me' }, accountId: 'account-2' },
      ]);
      assert.deepEqual(accountSets.at(-1), { gmail: ['account-1', 'account-2'] });
      const sent = await integrations.execute('local-development', 'GMAIL_SEND_EMAIL', {
        connectionId: first.connectionId,
        subject: 'Fixture',
      });
      assert.deepEqual(sent, { data: { labels: [] } });
      assert.deepEqual(executions[1], {
        action: 'GMAIL_SEND_EMAIL',
        args: { subject: 'Fixture' },
        accountId: 'account-1',
      });
      const search = (await integrations.execute('local-development', 'SEARCH_TOOLS', {
        query: 'List Gmail labels',
      })) as { accounts: Array<{ connectionId: string }> };
      assert.deepEqual(
        new Set(search.accounts.map((row) => row.connectionId)),
        new Set([first.connectionId, second.connectionId]),
      );
      assert.equal(
        (await app.inject({ method: 'POST', url: '/api/apps/gmail/disconnect' })).statusCode,
        409,
      );
      assert.equal(
        (
          await app.inject({
            method: 'POST',
            url: `/api/apps/googlecalendar/accounts/${second.connectionId}/disconnect`,
          })
        ).statusCode,
        404,
      );
      const foreign = (
        await pool.query<{ id: string }>(
          "INSERT INTO app_connections(owner_id,slug,account_id,provider_id) VALUES('another-owner','gmail','foreign-account','fixture') RETURNING id",
        )
      ).rows[0].id;
      await assert.rejects(
        integrations.execute('local-development', 'GMAIL_LIST_LABELS', { connectionId: foreign }),
        { statusCode: 404 },
      );
      assert.equal(
        (
          await app.inject({
            method: 'POST',
            url: `/api/apps/gmail/accounts/${foreign}/disconnect`,
          })
        ).statusCode,
        404,
      );
      assert.equal(
        (
          await app.inject({
            method: 'POST',
            url: `/api/apps/gmail/accounts/${first.connectionId}/triggers`,
            payload: { enabled: false },
          })
        ).statusCode,
        409,
      );
      const afterToggle = (await integrations.list()).filter((row) => row.slug === 'gmail');
      assert.equal(
        afterToggle.find((row) => row.connectionId === first.connectionId)?.triggerStatus,
        'active',
      );
      assert.equal(
        afterToggle.find((row) => row.connectionId === second.connectionId)?.triggerStatus,
        'active',
      );
      const event = {
        id: 'second-account-event',
        ownerId: 'local-development',
        service: 'gmail',
        accountId: 'account-2',
        subscriptionId: 'trigger-account-2',
        trigger: 'fixture-inbox-update',
        data: { subject: 'Fixture update' },
      };
      const accepted = await app.inject({
        method: 'POST',
        url: '/api/webhooks/fixture',
        payload: JSON.stringify(event),
        headers: { 'content-type': 'application/json', 'x-fixture-valid': 'yes' },
      });
      assert.equal(accepted.statusCode, 202);
      for (let index = 0; index < 30 && !delivered.length; index++) await delay(10);
      assert.equal(delivered.length, 1);
      assert.ok(delivered[0].includes(second.connectionId!));
      assert.equal(
        (
          await app.inject({
            method: 'POST',
            url: `/api/apps/gmail/accounts/${first.connectionId}/disconnect`,
          })
        ).statusCode,
        200,
      );
      assert.deepEqual(deleted, ['account-1']);
      assert.equal((await integrations.list()).filter((row) => row.slug === 'gmail').length, 1);
      await assert.rejects(
        integrations.executeApproved('local-development', 'GMAIL_SEND_EMAIL', {
          connectionId: first.connectionId,
        }),
        { statusCode: 404 },
      );
      for (const connectionId of [undefined, 'invalid-account-reference']) {
        await assert.rejects(
          integrations.validateApproval('local-development', 'GMAIL_SEND_EMAIL', {
            ...(connectionId === undefined ? {} : { connectionId }),
          }),
          { statusCode: 409 },
        );
        await assert.rejects(
          integrations.executeApproved('local-development', 'GMAIL_SEND_EMAIL', {
            subject: 'Legacy pending approval',
            ...(connectionId === undefined ? {} : { connectionId }),
          }),
          {
            statusCode: 409,
            message: 'Choose a connected account for this action.',
          },
        );
      }
      assert.equal(executions.length, 2);
      await integrations.execute('local-development', 'GMAIL_LIST_LABELS', {});
      assert.equal(executions.at(-1)?.accountId, 'account-2');
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
      'browserConnections' | 'browserAccounts' | 'validateActivityCheck' | 'wake'
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
  const downloads: Array<{ action: string; args: Record<string, unknown>; accountId: string }> = [];
  const subscriptions: string[] = [];
  const removed: string[] = [];
  const sessions: unknown[] = [];
  const wakes: string[] = [];
  const wakeIntents: Array<string | undefined> = [];
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
    download: async (action, args, accountId) => {
      downloads.push({ action, args, accountId });
      return {
        name: 'invoice.pdf',
        mimeType: 'application/pdf',
        bytes: Buffer.from('synthetic invoice'),
      };
    },
  };
  const provider: IntegrationProvider = {
    id: 'fixture',
    configured: true,
    supportedServices: integrationServiceIds,
    webhooksConfigured: true,
    supportsSubscriptions: ['gmail', 'googlecalendar', 'slack', 'notion'],
    createSession: async (_owner, selected) => {
      sessions.push(selected);
      return session;
    },
    restoreSession: async () => {
      assert.fail('An old session must be replaced.');
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
    ...listing,
    ownerId: 'local-development',
    provider,
    baseUrl: 'http://localhost:4310',
    wake:
      listing.wake ??
      (async (_prompt, id, intent) => {
        wakes.push(id);
        wakeIntents.push(intent);
      }),
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
    downloads,
    subscriptions,
    removed,
    sessions,
    wakes,
    wakeIntents,
    callbacks,
  };
}

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
    const directory = await mkdtemp(join(tmpdir(), 'otto-add-account-'));
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
      connections: (action, service, proposal, newAccount) =>
        f.service.manageConnections(action, service, { threadId, turnId }, proposal, newAccount),
    });
    assert.equal(result.status, 'waiting_user');
    assert.equal(f.callbacks.length, 2);
    assert.equal(replies.length, 1);
    assert.ok(replies[0].includes('https://consent.example.com/connect'));
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
    const start = async () => {
      const response = await f.app.inject({ method: 'POST', url: '/api/apps/gmail/connect' });
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
    const status = async (...hashes: string[]) => {
      const response = await f.app.inject({
        method: 'POST',
        url: '/api/apps/setup-status',
        payload: { hashes },
      });
      assert.equal(response.statusCode, 200);
      assert.equal(response.headers['cache-control'], 'no-store');
      return response.json();
    };
    const complete = async (callback: URL) =>
      (await f.app.inject({ url: `${callback.pathname}${callback.search}` })).headers.location;
    const personal = await start();
    const other = await start();
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
      'http://localhost:4310/apps?connection=connected',
    );
    assert.deepEqual(await status(personal.hash, other.hash), [personal.hash]);
    await f.pool.query(
      "UPDATE app_connections SET callback_expires=now()-interval '1 second' WHERE id=$1",
      [other.id],
    );
    assert.equal(await complete(other.callback), 'http://localhost:4310/apps?connection=expired');
    assert.deepEqual(await status(other.hash), []);
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
    assert.deepEqual(await status(reconnect.hash), [reconnect.hash]);
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
    for (const receipt of (await f.pool.query('SELECT * FROM app_setup_completions')).rows) {
      assert.deepEqual(Object.keys(receipt).sort(), ['link_hash', 'owner_id']);
      assert.match(receipt.link_hash, /^[a-f0-9]{64}$/);
    }
    for (const hashes of [
      [],
      ['https://consent.example.com/private'],
      Array(101).fill(personal.hash),
    ])
      assert.equal(
        (await f.app.inject({ method: 'POST', url: '/api/apps/setup-status', payload: { hashes } }))
          .statusCode,
        400,
      );
  },
);

test(
  'legacy app review metadata names only the selected owned account',
  { skip: !process.env.TEST_DATABASE_URL },
  async (t) => {
    const f = await appsFixture(t);
    const first = await f.connect('gmail');
    const selected = await f.connect('gmail');
    await f.pool.query('UPDATE app_connections SET account_email=$2 WHERE id=$1', [
      selected.connectionId,
      'selected@example.test',
    ]);
    const metadata = await f.service.describeApproval('local-development', 'GMAIL_SEND_EMAIL', {
      connectionId: selected.connectionId,
    });
    assert.deepEqual(metadata, {
      name: 'Gmail',
      accountName: `gmail ${selected.accountId}`,
      accountEmail: 'selected@example.test',
    });
    assert.doesNotMatch(JSON.stringify(metadata), /private-callback|connectionId/);
    assert.notDeepEqual(
      metadata,
      await f.service.describeApproval('local-development', 'GMAIL_SEND_EMAIL', {
        connectionId: first.connectionId,
      }),
    );
    assert.equal(
      await f.service.describeApproval('local-development', 'NOTION_UPDATE_PAGE', {
        connectionId: selected.connectionId,
      }),
      undefined,
    );
    await f.pool.query('UPDATE app_connections SET revoked=true WHERE id=$1', [
      selected.connectionId,
    ]);
    assert.equal(
      await f.service.describeApproval('local-development', 'GMAIL_SEND_EMAIL', {
        connectionId: selected.connectionId,
      }),
      undefined,
    );
    await assert.rejects(
      f.service.describeApproval('foreign-owner', 'GMAIL_SEND_EMAIL', {
        connectionId: first.connectionId,
      }),
      { statusCode: 403 },
    );
  },
);

test(
  'background app inventory stays local, owned and current without authenticating saved logins',
  { skip: !process.env.TEST_DATABASE_URL },
  async (t) => {
    const browserId = randomUUID();
    let browserState: 'saved' | 'needs_sign_in' = 'saved';
    const f = await appsFixture(
      t,
      {},
      {
        browserAccounts: async () => [
          {
            kind: 'login',
            id: randomUUID(),
            label: 'Saved login',
            origin: 'https://login.example.test',
            usernameHint: 'user@example.test',
            updatedAt: '2026-01-01T00:00:00Z',
          },
        ],
        browserConnections: async () => [
          {
            slug: 'browser-fixture',
            name: 'Browser fixture',
            connectionId: browserId,
            accountName: 'Work',
            status: browserState === 'saved' ? 'connected' : 'disconnected',
            browserState,
            checkedAt: '2026-01-01T00:00:00Z',
            triggersEnabled: false,
            supportsTriggers: false,
            browserUrl: 'https://example.test/private',
            accessPaths: [
              { id: browserId, kind: 'browser', endpoint: 'https://example.test/private' },
            ],
          },
        ],
      },
    );
    const selected = await f.connect('slack');
    const disconnected = await f.connect('notion');
    await f.pool.query(
      "UPDATE app_connections SET account_checked_at=NULL,account_email='owner@example.test'",
    );
    await f.pool.query('UPDATE app_connections SET revoked=true WHERE id=$1', [
      disconnected.connectionId,
    ]);
    await f.pool.query(
      "INSERT INTO app_connections(owner_id,slug,account_id,provider_id,account_email) VALUES('foreign-owner','gmail','foreign-account','fixture','foreign@example.test')",
    );
    let inspected = 0;
    t.mock.method(f.provider, 'inspectAccount', async () => {
      inspected++;
      return { active: true, service: 'slack' };
    });
    const inventory = await f.service.connectedApps();
    assert.deepEqual(
      inventory.map((app) => app.connectionId),
      [selected.connectionId, browserId],
    );
    assert.equal(inventory[0].accountEmail, 'owner@example.test');
    assert.deepEqual(inventory[1].access, ['browser']);
    assert.equal(inventory[1].browserState, 'saved');
    assert.equal(inventory[1].supportsTriggers, false);
    assert.equal(inspected, 0);
    assert.doesNotMatch(
      JSON.stringify(inventory),
      /foreign|Saved login|endpoint|browserUrl|https:|accountId/,
    );
    await assert.rejects(f.service.connectedApps('foreign-owner'), { statusCode: 403 });
    await f.pool.query('UPDATE app_connections SET account_active=false WHERE id=$1', [
      selected.connectionId,
    ]);
    browserState = 'needs_sign_in';
    assert.deepEqual(await f.service.connectedApps(), []);
    assert.equal(inspected, 0);
    await f.service.list();
    assert.ok(inspected > 0);
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
  },
);

test(
  'scoped activity discovery rechecks the account and receipt after temporary session creation',
  { skip: !process.env.TEST_DATABASE_URL },
  async (t) => {
    const turn = { threadId: randomUUID(), turnId: randomUUID() };
    let valid = true;
    const f = await appsFixture(
      t,
      {},
      {
        validateActivityCheck: async (received) => {
          assert.deepEqual(received, turn);
          if (!valid) throw new Error('The activity receipt was invalidated.');
        },
      },
    );
    const selected = await f.connect('gmail');
    await f.connect('gmail');
    let entered = false,
      searches = 0;
    let release = () => {};
    let pending = new Promise<void>((resolve) => {
      release = resolve;
    });
    t.mock.method(
      f.provider,
      'createSession',
      async (_owner: string, accounts: Parameters<IntegrationProvider['createSession']>[1]) => {
        assert.deepEqual(accounts, { gmail: [selected.accountId] });
        entered = true;
        await pending;
        return f.session;
      },
    );
    t.mock.method(f.session, 'search', async () => {
      searches++;
      return { tools: { GMAIL_GET_PROFILE: {}, SLACK_SEARCH: {} }, suggestions: [] };
    });
    const search = () =>
      f.service.execute(
        'local-development',
        'SEARCH_TOOLS',
        { query: 'recent activity' },
        turn,
        undefined,
        selected.connectionId,
      );
    const waitForSession = async () => {
      for (let attempt = 0; attempt < 100 && !entered; attempt++) await delay(5);
      assert.equal(entered, true);
    };
    const revoked = search();
    await waitForSession();
    await f.pool.query('UPDATE app_connections SET revoked=true WHERE id=$1', [
      selected.connectionId,
    ]);
    release();
    await assert.rejects(revoked);
    assert.equal(searches, 0);
    await f.pool.query('UPDATE app_connections SET revoked=false WHERE id=$1', [
      selected.connectionId,
    ]);
    entered = false;
    pending = new Promise<void>((resolve) => {
      release = resolve;
    });
    const replaced = search();
    await waitForSession();
    valid = false;
    release();
    await assert.rejects(replaced);
    assert.equal(searches, 0);
    valid = true;
    const result = (await search()) as {
      tools: Record<string, unknown>;
      accounts: Array<{ connectionId: string }>;
    };
    assert.equal(searches, 1);
    assert.deepEqual(Object.keys(result.tools), ['GMAIL_GET_PROFILE']);
    assert.deepEqual(
      result.accounts.map((account) => account.connectionId),
      [selected.connectionId],
    );
    await assert.rejects(
      f.service.execute(
        'local-development',
        'GMAIL_GET_PROFILE',
        { connectionId: randomUUID() },
        turn,
        undefined,
        selected.connectionId,
      ),
    );
    assert.equal(f.executed.length, 0);
  },
);

test(
  'private Gmail drafts run on the selected active owned account',
  { skip: !process.env.TEST_DATABASE_URL },
  async (t) => {
    const f = await appsFixture(t);
    await f.connect('gmail');
    const selected = await f.connect('gmail');
    const action = 'GMAIL_CREATE_EMAIL_DRAFT';
    const content = {
      recipient_email: 'alex@example.test',
      thread_id: 'synthetic-thread',
      body: 'A reply for review.',
    };
    await assert.rejects(f.service.execute('local-development', action, content), {
      statusCode: 409,
    });
    const args = { ...content, connectionId: selected.connectionId };
    assert.deepEqual(await f.service.execute('local-development', action, args), { ok: true });
    assert.deepEqual(f.executed, [{ action, args: content, accountId: selected.accountId }]);
    await f.pool.query('UPDATE app_connections SET owner_id=$2 WHERE id=$1', [
      selected.connectionId,
      'foreign',
    ]);
    await assert.rejects(f.service.execute('local-development', action, args), {
      statusCode: 404,
    });
    await f.pool.query('UPDATE app_connections SET owner_id=$2,revoked=true WHERE id=$1', [
      selected.connectionId,
      'local-development',
    ]);
    await assert.rejects(f.service.execute('local-development', action, args), {
      statusCode: 404,
    });
    assert.equal(f.executed.length, 1);
  },
);

test(
  'inbox polling baselines only owned requested accounts and reports read health without empty wakes',
  { skip: !process.env.TEST_DATABASE_URL },
  async (t) => {
    const f = await appsFixture(t);
    f.provider.supportsSubscriptions = [];
    const calls: Array<{ account: string; cursor: string | null }> = [];
    f.provider.pollInbox = async (account, cursor) => {
      calls.push({ account, cursor });
      return { cursor: 'baseline', hasMore: false, messages: [] };
    };
    const selected = await f.connect('gmail');
    const other = await f.connect('gmail');
    await f.service.syncWatches();
    assert.deepEqual(f.subscriptions, []);
    assert.ok(
      (await f.pool.query('SELECT watch_attempted FROM app_connections')).rows.every(
        (row) => !row.watch_attempted,
      ),
    );
    await f.pool.query('UPDATE app_connections SET watch_requested=false WHERE id=$1', [
      other.connectionId,
    ]);
    assert.equal(
      (await f.service.list()).find((row) => row.connectionId === selected.connectionId)
        ?.triggersActive,
      false,
    );
    await f.pool.query(
      `INSERT INTO app_connections (owner_id,slug,account_id,provider_id) VALUES
       ('foreign-owner','gmail','foreign-account','fixture'),
       ('local-development','gmail','other-provider-account','composio'),
       ('local-development','slack','slack-account','fixture')`,
    );
    await Promise.all([f.service.pollInboxes(), f.service.pollInboxes()]);
    await f.service.drain();
    assert.deepEqual(calls, [{ account: selected.accountId, cursor: null }]);
    assert.equal(f.wakes.length, 0);
    assert.equal((await f.pool.query('SELECT * FROM integration_events')).rowCount, 0);
    await f.pool.query("DELETE FROM app_connections WHERE provider_id='composio'");
    assert.equal(
      (await f.service.list()).find((row) => row.connectionId === selected.connectionId)
        ?.triggerStatus,
      'active',
    );
    await f.service.pollInboxes();
    assert.equal(calls.length, 1);
    await f.pool.query(
      "UPDATE app_connections SET inbox_checked_at=now()-interval '4 minutes' WHERE id=$1",
      [selected.connectionId],
    );
    assert.equal(
      (await f.service.list()).find((row) => row.connectionId === selected.connectionId)
        ?.triggerStatus,
      'active',
    );
    await f.pool.query(
      "UPDATE app_connections SET inbox_checked_at=now()-interval '7 minutes' WHERE id=$1",
      [selected.connectionId],
    );
    assert.equal(
      (await f.service.list()).find((row) => row.connectionId === selected.connectionId)
        ?.triggersActive,
      false,
    );
    f.provider.pollInbox = async (account, cursor) => {
      calls.push({ account, cursor });
      throw new Error('synthetic provider failure');
    };
    await f.pool.query('UPDATE app_connections SET inbox_poll_at=NULL WHERE id=$1', [
      selected.connectionId,
    ]);
    await f.service.pollInboxes();
    assert.deepEqual(calls.at(-1), { account: selected.accountId, cursor: 'baseline' });
    assert.equal(
      (await f.service.list()).find((row) => row.connectionId === selected.connectionId)
        ?.triggerStatus,
      'unavailable',
    );
    const row = (
      await f.pool.query('SELECT * FROM app_connections WHERE id=$1', [selected.connectionId])
    ).rows[0];
    assert.equal(row.inbox_cursor, 'baseline');
    assert.equal(row.inbox_failed, true);
    assert.equal(f.wakes.length, 0);
    assert.equal(f.executed.length, 0);
  },
);

test(
  'inbox polling and verified webhooks share message receipts and retain exact source identities',
  { skip: !process.env.TEST_DATABASE_URL },
  async (t) => {
    const f = await appsFixture(t);
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
    const send = (
      id: string,
      subscriptionId = `trigger-${selected.accountId}`,
      signature = 'valid',
    ) =>
      f.app.inject({
        method: 'POST',
        url: '/api/webhooks/fixture',
        headers: { 'content-type': 'application/json', 'x-fixture-signature': signature },
        payload: JSON.stringify({
          id: randomUUID(),
          ownerId: 'local-development',
          service: 'gmail',
          accountId: selected.accountId,
          subscriptionId,
          trigger: 'gmail-event',
          data: {
            message_id: id,
            thread_id: '998877665544',
            intent: 'inspect_message',
            ...metadata,
          },
        }),
      });
    assert.equal((await send('112233445566', undefined, 'invalid')).statusCode, 401);
    await send('112233445566', 'foreign-subscription');
    assert.equal((await f.pool.query('SELECT * FROM integration_events')).rowCount, 0);
    await send('112233445566');
    for (let attempt = 0; attempt < 100 && !f.wakes.length; attempt++) await delay(10);
    assert.equal(f.wakes.length, 1);
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
    assert.deepEqual(f.wakeIntents, ['inspect_message', 'inspect_message']);
    assert.match(receipts[0].summary, /112233445566/);
    assert.match(receipts[1].summary, /223344556677/);
    assert.match(receipts[1].summary, /998877665544/);
    for (const row of receipts) {
      assert.ok(row.summary.length > 700);
      assert.ok(row.summary.slice(0, 700).includes(selected.connectionId!));
      assert.ok(row.summary.slice(0, 700).includes('998877665544'));
    }
    assert.doesNotMatch(JSON.stringify(receipts), /1234|A1B2C3|reset\?token|credential/);
    assert.equal(receipts[1].poll_connection_id, selected.connectionId);
    assert.equal(receipts[1].trigger_id, null);
    await send('');
    for (let attempt = 0; attempt < 100 && f.wakes.length < 3; attempt++) await delay(10);
    assert.equal(f.wakes.length, 3);
    assert.equal(f.wakeIntents.at(-1), 'classify');
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
    for (let attempt = 0; attempt < 100 && f.wakes.length < 4; attempt++) await delay(10);
    assert.equal(f.wakes.length, 4);
    assert.equal(f.wakeIntents.at(-1), 'classify');
    assert.equal(f.executed.length, 0);
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
  'inbox acquisition resumes its durable cursor after restart and drops queued events after disconnect',
  { skip: !process.env.TEST_DATABASE_URL },
  async (t) => {
    const f = await appsFixture(t);
    f.provider.webhooksConfigured = false;
    const selected = await f.connect('gmail');
    const cursors: Array<string | null> = [];
    f.provider.pollInbox = async (_account, cursor) => {
      cursors.push(cursor);
      return {
        cursor: 'baseline',
        hasMore: false,
        messages: cursor
          ? [
              {
                id: 'new-message',
                threadId: 'thread',
                subject: 'Question',
                sender: 'sender@example.test',
                summary: 'Fixture',
                receivedAt: '2026-01-01T00:00:00.000Z',
              },
            ]
          : [],
      };
    };
    await f.service.pollInboxes();
    await f.app.close();
    const app = Fastify();
    const restarted = await createIntegrations(f.pool, {
      ownerId: 'local-development',
      provider: f.provider,
      baseUrl: 'http://localhost:4310',
      wake: async (_prompt, id) => {
        f.wakes.push(id);
      },
    });
    restarted.registerRoutes(app);
    try {
      await f.pool.query('UPDATE app_connections SET inbox_poll_at=NULL WHERE id=$1', [
        selected.connectionId,
      ]);
      await restarted.pollInboxes();
      assert.deepEqual(cursors, [null, 'baseline']);
      assert.equal((await f.pool.query('SELECT * FROM integration_events')).rowCount, 1);
      assert.equal(
        (
          await app.inject({
            method: 'POST',
            url: `/api/apps/gmail/accounts/${selected.connectionId}/disconnect`,
          })
        ).statusCode,
        200,
      );
      await restarted.drain();
      assert.equal(
        (await f.pool.query('SELECT state FROM integration_events')).rows[0].state,
        'discarded',
      );
      assert.equal(f.wakes.length, 0);
      await restarted.pollInboxes();
      assert.equal(cursors.length, 2);
    } finally {
      await app.close();
    }
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
          wake: async (_summary, _id, _intent, current) => {
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
  'inbox results are fenced by watch revisions, account ownership, claim replacement and disconnect',
  { skip: !process.env.TEST_DATABASE_URL },
  async (t) => {
    const f = await appsFixture(t);
    f.provider.webhooksConfigured = false;
    const selected = await f.connect('gmail');
    const changes = [
      'watch_revision=watch_revision+1',
      "account_id='replacement-account'",
      "owner_id='foreign-owner'",
      "inbox_claim_id='replacement-claim'",
      'watch_requested=false',
      'revoked=true',
    ];
    for (const change of changes) {
      await f.pool.query(
        `UPDATE app_connections SET owner_id='local-development',account_id=$1,watch_requested=true,revoked=false,inbox_poll_at=NULL WHERE id=$2`,
        [selected.accountId, selected.connectionId],
      );
      let release: () => void = () => {};
      let entered: () => void = () => {};
      const started = new Promise<void>((resolve) => {
        entered = resolve;
      });
      f.provider.pollInbox = async () => {
        entered();
        await new Promise<void>((resolve) => {
          release = resolve;
        });
        return {
          cursor: 'stale',
          hasMore: false,
          messages: [
            {
              id: 'stale',
              threadId: 'thread',
              subject: 'Question',
              sender: 'sender@example.test',
              summary: 'Fixture',
              receivedAt: '2026-01-01T00:00:00.000Z',
            },
          ],
        };
      };
      const pending = f.service.pollInboxes();
      await started;
      await f.pool.query(`UPDATE app_connections SET ${change} WHERE id=$1`, [
        selected.connectionId,
      ]);
      release();
      await pending;
      assert.equal(
        (
          await f.pool.query('SELECT inbox_cursor FROM app_connections WHERE id=$1', [
            selected.connectionId,
          ])
        ).rows[0].inbox_cursor,
        null,
        change,
      );
      assert.equal((await f.pool.query('SELECT * FROM integration_events')).rowCount, 0, change);
    }
    assert.equal(f.wakes.length, 0);
  },
);

test(
  'failed disconnect cleanup cannot revive old inbox work when the same account reconnects',
  { skip: !process.env.TEST_DATABASE_URL },
  async (t) => {
    const f = await appsFixture(t);
    f.provider.webhooksConfigured = false;
    const selected = await f.connect('gmail');
    const cursors: Array<string | null> = [];
    f.provider.pollInbox = async (_account, cursor) => {
      cursors.push(cursor);
      return {
        cursor: cursor ? 'next' : 'baseline',
        hasMore: false,
        messages: cursor
          ? [
              {
                id: 'old-mail',
                threadId: 'thread',
                subject: 'Question',
                sender: 'sender@example.test',
                summary: 'Fixture',
                receivedAt: '2026-01-01T00:00:00.000Z',
              },
            ]
          : [],
      };
    };
    await f.service.pollInboxes();
    await f.pool.query('UPDATE app_connections SET inbox_poll_at=NULL WHERE id=$1', [
      selected.connectionId,
    ]);
    await f.service.pollInboxes();
    assert.equal(
      (await f.pool.query('SELECT state FROM integration_events')).rows[0].state,
      'queued',
    );
    f.provider.deleteAccount = async () => {
      throw new Error('synthetic cleanup failure');
    };
    assert.equal(
      (
        await f.app.inject({
          method: 'POST',
          url: `/api/apps/gmail/accounts/${selected.connectionId}/disconnect`,
        })
      ).statusCode,
      502,
    );
    assert.equal(
      (await f.pool.query('SELECT state FROM integration_events')).rows[0].state,
      'discarded',
    );
    const revoked = (
      await f.pool.query('SELECT * FROM app_connections WHERE id=$1', [selected.connectionId])
    ).rows[0];
    assert.equal(revoked.revoked, true);
    assert.equal(revoked.inbox_cursor, null);
    assert.equal(revoked.inbox_claim_id, null);
    f.session.authorize = async (_service, callback) => {
      f.callbacks.push(callback);
      return { accountId: selected.accountId!, url: 'https://consent.example.com/connect' };
    };
    await f.app.inject({ method: 'POST', url: '/api/apps/gmail/connect' });
    const callback = new URL(f.callbacks.at(-1)!);
    callback.searchParams.set('account', selected.accountId!);
    assert.equal(
      (await f.app.inject({ url: `${callback.pathname}${callback.search}` })).statusCode,
      302,
    );
    const reconnected = (await f.service.list()).find(
      (row) => row.accountId === selected.accountId,
    )!;
    assert.equal(reconnected.connectionId, selected.connectionId);
    assert.equal(reconnected.triggersActive, false);
    await f.service.pollInboxes();
    assert.deepEqual(cursors, [null, 'baseline', null]);
    await f.service.drain();
    assert.equal(f.wakes.length, 0);
    assert.equal(
      (await f.pool.query('SELECT state FROM integration_events')).rows[0].state,
      'discarded',
    );
  },
);

test(
  'inbox provider reads leave the database pool available and failures finish with a single connection',
  { skip: !process.env.TEST_DATABASE_URL },
  async (t) => {
    const f = await appsFixture(t, { max: 1, connectionTimeoutMillis: 1000 });
    f.provider.webhooksConfigured = false;
    for (let count = 0; count < 4; count++) await f.connect('gmail');
    let entered: () => void = () => {};
    let release: () => void = () => {};
    let reads = 0;
    const started = new Promise<void>((resolve) => {
      entered = resolve;
    });
    const blocked = new Promise<void>((resolve) => {
      release = resolve;
    });
    f.provider.pollInbox = async () => {
      if (++reads === 4) entered();
      await blocked;
      throw new Error('synthetic provider failure');
    };
    const pending = f.service.pollInboxes();
    await started;
    try {
      assert.equal((await f.pool.query('SELECT 1 AS available')).rows[0].available, 1);
    } finally {
      release();
      await pending;
    }
    assert.equal(reads, 4);
    assert.equal(
      (await f.pool.query('SELECT * FROM app_connections WHERE inbox_failed')).rowCount,
      4,
    );
    assert.equal(f.wakes.length, 0);
  },
);

test(
  'expired inbox history stops reads, emits one owned blocker and requires a new baseline on reconnect',
  { skip: !process.env.TEST_DATABASE_URL },
  async (t) => {
    const f = await appsFixture(t);
    f.provider.webhooksConfigured = false;
    const selected = await f.connect('gmail');
    const cursors: Array<string | null> = [];
    f.provider.pollInbox = async (_account, cursor) => {
      cursors.push(cursor);
      if (cursor) throw new IntegrationInboxCursorExpired();
      return { cursor: 'baseline', hasMore: false, messages: [] };
    };
    await f.service.pollInboxes();
    await f.pool.query('UPDATE app_connections SET inbox_poll_at=NULL WHERE id=$1', [
      selected.connectionId,
    ]);
    await f.service.pollInboxes();
    const blocked = (
      await f.pool.query('SELECT * FROM app_connections WHERE id=$1', [selected.connectionId])
    ).rows[0];
    assert.equal(blocked.inbox_cursor, 'baseline');
    assert.equal(blocked.inbox_reconnect_required, true);
    const receipt = (await f.pool.query('SELECT * FROM integration_events')).rows[0];
    assert.equal(receipt.owner_id, 'local-development');
    assert.equal(receipt.account_id, selected.accountId);
    assert.equal(receipt.poll_connection_id, selected.connectionId);
    await f.pool.query('UPDATE app_connections SET inbox_poll_at=NULL WHERE id=$1', [
      selected.connectionId,
    ]);
    await f.service.pollInboxes();
    assert.deepEqual(cursors, [null, 'baseline']);
    await f.service.drain();
    await f.service.drain();
    assert.equal(f.wakes.length, 1);
    const status = (await f.service.list()).find(
      (row) => row.connectionId === selected.connectionId,
    )!;
    assert.equal(status.triggersActive, false);
    assert.equal(status.triggerStatus, 'unavailable');
    assert.match(status.description ?? '', /missing interval/);
    f.session.authorize = async (_service, callback) => {
      f.callbacks.push(callback);
      return { accountId: selected.accountId!, url: 'https://consent.example.com/connect' };
    };
    await f.app.inject({ method: 'POST', url: '/api/apps/gmail/connect' });
    const callback = new URL(f.callbacks.at(-1)!);
    callback.searchParams.set('account', selected.accountId!);
    await f.app.inject({ url: `${callback.pathname}${callback.search}` });
    await f.service.pollInboxes();
    assert.deepEqual(cursors, [null, 'baseline', null]);
    assert.equal(
      (
        await f.pool.query('SELECT inbox_reconnect_required FROM app_connections WHERE id=$1', [
          selected.connectionId,
        ])
      ).rows[0].inbox_reconnect_required,
      false,
    );
    assert.equal((await f.pool.query('SELECT * FROM integration_events')).rowCount, 1);
    assert.equal(f.wakes.length, 1);
  },
);

test(
  'connecting an already healthy Gmail account preserves its cursor and queued mail',
  { skip: !process.env.TEST_DATABASE_URL },
  async (t) => {
    const f = await appsFixture(t);
    f.provider.webhooksConfigured = false;
    const selected = await f.connect('gmail');
    f.provider.pollInbox = async (_account, cursor) => ({
      cursor: cursor ? 'next' : 'baseline',
      hasMore: false,
      messages: cursor
        ? [
            {
              id: 'new-mail',
              threadId: 'thread',
              subject: 'Question',
              sender: 'sender@example.test',
              receivedAt: '2026-01-01T00:00:00.000Z',
            },
          ]
        : [],
    });
    await f.service.pollInboxes();
    await f.pool.query('UPDATE app_connections SET inbox_poll_at=NULL WHERE id=$1', [
      selected.connectionId,
    ]);
    await f.service.pollInboxes();
    f.session.authorize = async (_service, callback) => {
      f.callbacks.push(callback);
      return { accountId: selected.accountId!, url: 'https://consent.example.com/connect' };
    };
    await f.app.inject({ method: 'POST', url: '/api/apps/gmail/connect' });
    const callback = new URL(f.callbacks.at(-1)!);
    callback.searchParams.set('account', selected.accountId!);
    await f.app.inject({ url: `${callback.pathname}${callback.search}` });
    assert.equal(
      (
        await f.pool.query('SELECT inbox_cursor FROM app_connections WHERE id=$1', [
          selected.connectionId,
        ])
      ).rows[0].inbox_cursor,
      'next',
    );
    assert.equal(
      (await f.pool.query('SELECT state FROM integration_events')).rows[0].state,
      'queued',
    );
    await f.service.drain();
    assert.equal(f.wakes.length, 1);
  },
);

test(
  'Slack and Notion keep owned accounts, direct actions and signed event boundaries',
  { skip: !process.env.TEST_DATABASE_URL },
  async (t) => {
    const f = await appsFixture(t);
    const slack = await f.connect('slack');
    const another = await f.connect('slack');
    const notion = await f.connect('notion');
    assert.equal((await f.app.inject({ url: '/api/connections' })).statusCode, 404);
    assert.equal((await f.service.list()).length, 9);
    assert.equal(slack.triggerStatus, 'active');
    assert.equal(notion.triggerStatus, 'active');
    await assert.rejects(
      f.service.execute('local-development', 'SLACK_SEARCH_MESSAGES', { query: 'project' }),
      { statusCode: 409 },
    );
    await f.service.execute('local-development', 'SLACK_SEARCH_MESSAGES', {
      connectionId: another.connectionId,
      query: 'project',
    });
    await f.service.execute('local-development', 'NOTION_RETRIEVE_PAGE', {
      connectionId: notion.connectionId,
      page_id: 'fixture-page',
    });
    assert.deepEqual(f.executed, [
      { action: 'SLACK_SEARCH_MESSAGES', args: { query: 'project' }, accountId: another.accountId },
      {
        action: 'NOTION_RETRIEVE_PAGE',
        args: { page_id: 'fixture-page' },
        accountId: notion.accountId,
      },
    ]);
    for (const [action, connectionId] of [
      ['SLACK_SEND_MESSAGE', slack.connectionId],
      ['SLACK_ENABLE_PUBLIC_SHARING_OF_A_FILE', slack.connectionId],
      ['SLACK_DOWNLOAD_SLACK_FILE', slack.connectionId],
      ['SLACK_GET_AND_DELETE_MESSAGES', slack.connectionId],
      ['NOTION_UPDATE_PAGE', notion.connectionId],
      ['NOTION_CREATE_FILE_UPLOAD', notion.connectionId],
    ]) {
      const result = await f.service.execute('local-development', action!, { connectionId });
      assert.deepEqual(result, { ok: true });
    }
    assert.deepEqual(
      f.executed.slice(2).map(({ action, accountId }) => ({ action, accountId })),
      [
        { action: 'SLACK_SEND_MESSAGE', accountId: slack.accountId },
        { action: 'SLACK_ENABLE_PUBLIC_SHARING_OF_A_FILE', accountId: slack.accountId },
        { action: 'SLACK_DOWNLOAD_SLACK_FILE', accountId: slack.accountId },
        { action: 'SLACK_GET_AND_DELETE_MESSAGES', accountId: slack.accountId },
        { action: 'NOTION_UPDATE_PAGE', accountId: notion.accountId },
        { action: 'NOTION_CREATE_FILE_UPLOAD', accountId: notion.accountId },
      ],
    );
    await assert.rejects(
      f.service.execute('local-development', 'NOTION_RETRIEVE_PAGE', {
        connectionId: slack.connectionId,
      }),
      { statusCode: 404 },
    );
    await assert.rejects(
      f.service.execute('foreign-owner', 'SLACK_SEARCH_MESSAGES', {
        connectionId: slack.connectionId,
      }),
    );
    await assert.rejects(f.service.execute('local-development', 'COMPOSIO_MULTI_EXECUTE_TOOL', {}));
    const event = {
      id: 'slack-event-1',
      ownerId: 'local-development',
      service: 'slack',
      accountId: slack.accountId,
      subscriptionId: `trigger-${slack.accountId}`,
      trigger: 'slack-event',
      data: { channel: 'D-fixture', text: 'private message body', access_token: 'private-token' },
    };
    const send = (payload: unknown, signature = 'valid') =>
      f.app.inject({
        method: 'POST',
        url: '/api/webhooks/fixture',
        headers: { 'x-fixture-signature': signature, 'content-type': 'application/json' },
        payload: JSON.stringify(payload),
      });
    assert.equal((await send(event, 'invalid')).statusCode, 401);
    await send({ ...event, ownerId: 'foreign-owner' });
    await send({ ...event, accountId: another.accountId });
    assert.equal((await f.pool.query('SELECT * FROM integration_events')).rowCount, 0);
    await send(event);
    await send(event);
    await f.service.drain();
    const receipts = (await f.pool.query('SELECT * FROM integration_events')).rows;
    assert.equal(receipts.length, 1);
    assert.equal(receipts[0].summary.includes('private message body'), false);
    assert.equal(receipts[0].summary.includes('private-token'), false);
    assert.match(receipts[0].summary, /D-fixture/);
    assert.equal(
      (
        await f.app.inject({
          method: 'POST',
          url: `/api/apps/slack/accounts/${slack.connectionId}/disconnect`,
        })
      ).statusCode,
      200,
    );
    assert.ok(f.removed.includes(slack.accountId!));
    assert.ok((await f.service.list()).some((item) => item.connectionId === another.connectionId));
    await assert.rejects(
      f.service.executeApproved('local-development', 'SLACK_SEND_MESSAGE', {
        connectionId: slack.connectionId,
      }),
      { statusCode: 404 },
    );
  },
);

test(
  'attachment retrieval downloads only from the selected current account',
  { skip: !process.env.TEST_DATABASE_URL },
  async (t) => {
    const f = await appsFixture(t);
    const first = await f.connect('gmail');
    const second = await f.connect('gmail');
    const args = {
      connectionId: second.connectionId,
      message_id: 'last-sent-message',
      attachment_id: 'selected-part',
      file_name: 'invoice.pdf',
    };
    const result = await f.service.execute('local-development', 'GMAIL_GET_ATTACHMENT', args);
    assert.ok(
      result &&
        typeof result === 'object' &&
        'downloadRequired' in result &&
        result.downloadRequired,
    );
    assert.equal('requiresApproval' in result, false);
    assert.equal(f.executed.length, 0);
    const file = await f.service.download('local-development', 'GMAIL_GET_ATTACHMENT', args);
    assert.equal(file.bytes.byteLength, 17);
    assert.deepEqual(f.downloads[0], {
      action: 'GMAIL_GET_ATTACHMENT',
      args: {
        message_id: 'last-sent-message',
        attachment_id: 'selected-part',
        file_name: 'invoice.pdf',
      },
      accountId: second.accountId,
    });
    await assert.rejects(f.service.download('foreign-owner', 'GMAIL_GET_ATTACHMENT', args));
    await assert.rejects(f.service.download('local-development', 'GMAIL_SEND_EMAIL', args), {
      statusCode: 403,
    });
    await assert.rejects(
      f.service.download('local-development', 'GMAIL_GET_ATTACHMENT', {
        ...args,
        connectionId: randomUUID(),
      }),
      { statusCode: 404 },
    );
    let finish: (file: IntegrationFile) => void = () => {};
    let started: () => void = () => {};
    const entered = new Promise<void>((resolve) => {
      started = resolve;
    });
    f.session.download = async () => {
      started();
      return new Promise((resolve) => {
        finish = resolve;
      });
    };
    const pending = f.service.download('local-development', 'GMAIL_GET_ATTACHMENT', {
      ...args,
      connectionId: first.connectionId,
    });
    await entered;
    await f.app.inject({
      method: 'POST',
      url: `/api/apps/gmail/accounts/${first.connectionId}/disconnect`,
    });
    finish(file);
    await assert.rejects(pending, {
      message: 'The file could not be downloaded: This connected account is unavailable.',
      statusCode: 502,
    });
    assert.ok((await f.service.list()).some((item) => item.connectionId === second.connectionId));
    let enterCancelled: () => void = () => {};
    const cancellationStarted = new Promise<void>((resolve) => {
      enterCancelled = resolve;
    });
    f.session.download = async () => {
      enterCancelled();
      return new Promise((resolve) => {
        finish = resolve;
      });
    };
    const controller = new AbortController();
    const cancelled = f.service.download(
      'local-development',
      'GMAIL_GET_ATTACHMENT',
      args,
      controller.signal,
    );
    await cancellationStarted;
    controller.abort();
    await assert.rejects(cancelled, { name: 'AbortError' });
    finish(file);
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
    observe?: (event: RuntimeObservation) => Promise<void>;
  } = {},
) {
  const directory = await mkdtemp(join(tmpdir(), 'otto-integration-search-recovery-'));
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
  const observations: RuntimeObservation[] = [];
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
    restoreSession: async () => session,
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
    turnId,
    prompt: 'Get the synthetic Gmail label count without reading or changing messages.',
    history: [],
    attachments: [],
    workspacePath: directory,
    signal: (options.controller ?? new AbortController()).signal,
    emit: async (type) => {
      events.push(type);
    },
    observe: async (event) => {
      observations.push(event);
      await options.observe?.(event);
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
    observations,
    modelResults,
    owner,
    connectionId,
    calendarId,
    foreignId,
    run: () => runtime!.runTurn(context),
  };
}

test(
  'a foreign account hint rejects discovery before any provider call',
  { skip: !process.env.TEST_DATABASE_URL },
  async (t) => {
    const f = await searchFixture(t, async (execute) => {
      await execute('search', 'SEARCH_TOOLS', {
        query,
        connectionId: f.foreignId,
      });
      assert.fail('A foreign connection cannot start provider discovery.');
    });
    await assert.rejects(f.run(), /This connected account is unavailable/);
    assert.deepEqual(f.searches, []);
    assert.deepEqual(f.sessions, []);
    assert.deepEqual(f.calls, []);
    assert.doesNotMatch(JSON.stringify(f.observations), /fixture-foreign/);
  },
);

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
      assert.match(error.message, /The app request failed: private-provider-diagnostic/);
      assert.doesNotMatch(error.message, leaked);
      return true;
    });
    assert.equal(f.calls.length, 1);
    assert.deepEqual(f.modelResults, []);
    assert.match(JSON.stringify(f.observations), /private-provider-diagnostic/);
    assert.doesNotMatch(JSON.stringify(f.observations), leaked);
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
    assert.equal(f.observations.filter((event) => event.type === 'tool_end').length, 1);
  },
);

test(
  'adding another Gmail account uses isolated consent without changing the pinned execution account',
  { skip: !process.env.TEST_DATABASE_URL },
  async (t) => {
    const schema = `test_consent_${randomUUID().replaceAll('-', '')}`;
    const admin = new pg.Pool({ connectionString: process.env.TEST_DATABASE_URL });
    await admin.query(`CREATE SCHEMA ${schema}`);
    const pool = new pg.Pool({
      connectionString: process.env.TEST_DATABASE_URL,
      options: `-c search_path=${schema}`,
    });
    const app = Fastify();
    t.after(async () => {
      await app.close();
      await pool.end();
      await admin.query(`DROP SCHEMA ${schema} CASCADE`);
      await admin.end();
    });
    const client = new Composio({
      apiKey: 'fixture-key-never-live',
      allowTracking: false,
      disableVersionCheck: true,
      fileUploadDirs: false,
    });
    const transport = client.getClient().toolRouter.session;
    const created: Array<{ id: string; config: Record<string, unknown> }> = [];
    const deleted: string[] = [];
    const links: Array<{ id: string; input: Record<string, unknown> }> = [];
    const configurations = new Map<string, Record<string, unknown>>([
      ['execution-session', { connected_accounts: { gmail: ['existing-account'] } }],
    ]);
    function session(id: string) {
      return {
        session_id: id,
        mcp: { type: 'http', url: `https://backend.composio.dev/tool_router/mcp/${id}` },
        config: { user_id: 'local-development', ...configurations.get(id) },
        config_version: 1,
      };
    }
    t.mock.method(transport, 'retrieve', async (id: string) => session(id));
    t.mock.method(transport, 'create', async (config: Record<string, unknown>) => {
      const id = `consent-session-${created.length + 1}`;
      configurations.set(id, config);
      created.push({ id, config });
      return session(id);
    });
    let failure: 'provider' | 'url' | undefined;
    let cleanupFailure = false;
    t.mock.method(transport, 'link', async (id: string, input: Record<string, unknown>) => {
      links.push({ id, input });
      const accounts = configurations.get(id)?.connected_accounts as Record<string, string[]>;
      if (accounts?.gmail?.length)
        throw Object.assign(
          new Error(
            "Connected account already defined for toolkit 'gmail'. Cannot create a new link when connected_accounts is set.",
          ),
          { status: 400, error: { code: 4309 } },
        );
      if (failure === 'provider') throw new Error('synthetic-private-provider-detail');
      return {
        connected_account_id: `new-account-${created.length}`,
        redirect_url:
          failure === 'url'
            ? 'https://untrusted.example/connect'
            : 'https://connect.composio.dev/link/synthetic-consent',
      };
    });
    t.mock.method(
      client.getClient(),
      'delete',
      async (path: string, options: { signal?: AbortSignal }) => {
        assert.match(path, /^\/api\/v3\.1\/tool_router\/session\//);
        assert.ok(options.signal instanceof AbortSignal);
        assert.equal(options.signal.aborted, false);
        const id = decodeURIComponent(path.split('/').at(-1)!);
        deleted.push(id);
        assert.notEqual(id, 'execution-session');
        if (cleanupFailure) throw new Error('synthetic-private-cleanup-detail');
        return { session_id: id, deleted: true };
      },
    );
    t.mock.method(client.connectedAccounts, 'delete', async () => {
      assert.fail('Consent must not remove an existing account.');
    });
    t.mock.method(client.tools, 'getRawComposioToolBySlug', async (slug: string) => {
      assert.equal(slug, 'GMAIL_LIST_LABELS');
      return { slug, name: slug, tags: ['readOnlyHint'] };
    });
    const execution = t.mock.method(
      transport,
      'execute',
      async (id: string, input: Record<string, unknown>) => {
        assert.equal(id, 'execution-session');
        assert.equal(input.account, 'existing-account');
        return { data: { labels: [] }, error: null, log_id: 'synthetic-log' };
      },
    );
    const provider = createComposioProvider({
      client,
      authConfigs: { gmail: 'custom-gmail-auth' },
    });
    const integrations = await createIntegrations(pool, {
      ownerId: 'local-development',
      provider,
      baseUrl: 'http://localhost:4310',
      wake: async () => {},
    });
    integrations.registerRoutes(app);
    const account = await pool.query<{ id: string }>(
      `INSERT INTO app_connections(owner_id,slug,account_id,provider_id,account_active,account_checked_at)
       VALUES('local-development','gmail','existing-account','composio',true,now()) RETURNING id`,
    );
    await pool.query(
      `INSERT INTO integration_sessions(owner_id,session_id,provider_id,configuration_version)
       VALUES('local-development','execution-session','composio',3)`,
    );
    const connect = () => app.inject({ method: 'POST', url: '/api/apps/gmail/connect' });
    const response = await connect();
    assert.equal(response.statusCode, 200);
    assert.deepEqual(response.json(), {
      url: 'https://connect.composio.dev/link/synthetic-consent',
    });
    assert.equal(created.length, 1);
    assert.deepEqual(created[0].config.connected_accounts, {});
    assert.deepEqual(created[0].config.auth_configs, { gmail: 'custom-gmail-auth' });
    assert.deepEqual(created[0].config.multi_account, {
      enable: true,
      max_accounts_per_toolkit: 10,
      require_explicit_selection: true,
    });
    assert.deepEqual(deleted, ['consent-session-1']);
    assert.equal(links[0].id, 'consent-session-1');
    const callback = new URL(String(links[0].input.callback_url));
    assert.equal(callback.pathname, '/api/apps/callback');
    assert.match(callback.searchParams.get('state')!, /^[A-Za-z0-9_-]{43}$/);
    assert.deepEqual((await pool.query('SELECT session_id FROM integration_sessions')).rows, [
      { session_id: 'execution-session' },
    ]);
    assert.deepEqual(
      (
        await pool.query(
          'SELECT account_id,revoked,pending_account_id FROM app_connections WHERE id=$1',
          [account.rows[0].id],
        )
      ).rows,
      [{ account_id: 'existing-account', revoked: false, pending_account_id: null }],
    );
    assert.equal(
      (await pool.query('SELECT pending_account_id FROM app_connections WHERE account_id IS NULL'))
        .rows[0].pending_account_id,
      'new-account-1',
    );
    await integrations.execute('local-development', 'GMAIL_LIST_LABELS', {
      connectionId: account.rows[0].id,
      user_id: 'me',
    });
    assert.equal(execution.mock.callCount(), 1);
    for (const kind of ['provider', 'url'] as const) {
      failure = kind;
      const rejected = await connect();
      assert.equal(rejected.statusCode, 502);
      assert.deepEqual(rejected.json(), {
        error: 'The connection provider could not complete this request.',
      });
      assert.equal((await pool.query('SELECT id FROM app_connections')).rowCount, 2);
    }
    assert.deepEqual(deleted, ['consent-session-1', 'consent-session-2', 'consent-session-3']);
    failure = undefined;
    cleanupFailure = true;
    const accepted = await connect();
    assert.equal(accepted.statusCode, 200);
    assert.equal((await pool.query('SELECT id FROM app_connections')).rowCount, 3);
    assert.equal(deleted.at(-1), 'consent-session-4');
  },
);

test(
  'direct Linear OAuth uses read access and keeps tokens encrypted',
  { skip: !process.env.TEST_DATABASE_URL },
  async () => {
    const schema = `direct_${randomUUID().replaceAll('-', '')}`;
    const admin = new pg.Pool({ connectionString: process.env.TEST_DATABASE_URL });
    await admin.query(`CREATE SCHEMA ${schema}`);
    const address = new URL(process.env.TEST_DATABASE_URL!);
    address.searchParams.set('options', `-c search_path=${schema}`);
    const pool = new pg.Pool({ connectionString: address.href });
    const secretKey = randomBytes(32);
    const keyStore = { id: 'fixture', configured: true, getKey: async () => secretKey };
    const redirectUris: string[] = [];
    let tokenRequests = 0;
    let refreshRequests = 0;
    let mcpRequests = 0;
    const request: typeof fetch = async (input, init) => {
      const url = String(input);
      if (url === 'https://mcp.linear.app/mcp/readonly') {
        mcpRequests += 1;
        throw new Error('The synthetic MCP server is unavailable.');
      }
      if (url.endsWith('/.well-known/oauth-protected-resource/mcp/readonly'))
        return Response.json({ authorization_servers: ['https://mcp.linear.app'] });
      if (url.endsWith('/.well-known/oauth-authorization-server'))
        return Response.json({
          issuer: 'https://mcp.linear.app',
          authorization_response_iss_parameter_supported: true,
          authorization_endpoint: 'https://mcp.linear.app/authorize',
          token_endpoint: 'https://mcp.linear.app/token',
          registration_endpoint: 'https://mcp.linear.app/register',
        });
      if (url.endsWith('/register')) {
        const body = JSON.parse(String(init?.body));
        assert.equal(body.scope, 'read');
        redirectUris.push(body.redirect_uris[0]);
        return Response.json({ client_id: 'fixture-client' });
      }
      if (url.endsWith('/token')) {
        tokenRequests += 1;
        const body = init?.body as URLSearchParams;
        assert.equal(body.get('client_id'), 'fixture-client');
        assert.equal(body.get('resource'), 'https://mcp.linear.app/mcp/readonly');
        if (body.get('grant_type') === 'refresh_token') {
          refreshRequests += 1;
          assert.equal(
            body.get('refresh_token'),
            refreshRequests === 1 ? 'private-refresh-token' : 'first-refresh-token',
          );
          return Response.json({
            access_token:
              refreshRequests === 1 ? 'first-refreshed-access-token' : 'refreshed-access-token',
            refresh_token:
              refreshRequests === 1 ? 'first-refresh-token' : 'refreshed-refresh-token',
            expires_in: refreshRequests === 1 ? 0 : 3600,
          });
        }
        assert.ok(body.get('code_verifier'));
        return Response.json({
          access_token: 'private-access-token',
          refresh_token: 'private-refresh-token',
          expires_in: 0,
        });
      }
      throw new Error(`Unexpected request: ${url}`);
    };
    try {
      const grantVault = await createAppGrantVault(pool, {
        ownerId: 'fixture-owner',
        keyStore,
      });
      const provider = createDirectProvider({
        pool,
        keyStore,
        grantVault,
        ownerId: 'fixture-owner',
        request,
      });
      assert.deepEqual(provider.supportedServices, ['notion', 'linear']);
      const session = await provider.createSession('fixture-owner', {});
      const state = randomBytes(32).toString('base64url');
      const attempt = await session.authorize(
        'linear',
        `http://localhost:4310/api/apps/callback?state=${state}`,
      );
      const url = new URL(attempt.url);
      assert.equal(url.origin, 'https://mcp.linear.app');
      assert.equal(url.searchParams.get('scope'), 'read');
      assert.equal(url.searchParams.get('resource'), 'https://mcp.linear.app/mcp/readonly');
      assert.equal(url.searchParams.get('redirect_uri'), 'http://127.0.0.1:4310/api/apps/callback');
      const hostedState = randomBytes(32).toString('base64url');
      const hosted = await session.authorize(
        'linear',
        `https://sidekick.example/api/apps/callback?state=${hostedState}`,
      );
      assert.equal(
        new URL(hosted.url).searchParams.get('redirect_uri'),
        'https://sidekick.example/api/apps/callback',
      );
      assert.deepEqual(redirectUris, [
        'http://127.0.0.1:4310/api/apps/callback',
        'https://sidekick.example/api/apps/callback',
      ]);
      await assert.rejects(
        Promise.resolve().then(() =>
          provider.parseCallback({ state: 'wrong', code: 'fixture-code' }),
        ),
      );
      await assert.rejects(() =>
        Promise.resolve(provider.parseCallback({ state, code: 'fixture-code' })),
      );
      const callback = await provider.parseCallback({
        state,
        code: 'fixture-code',
        iss: 'https://mcp.linear.app',
      });
      assert.deepEqual(callback, { state, accountId: attempt.accountId, success: true });
      const stored = await pool.query<{ ciphertext: string }>(
        'SELECT ciphertext FROM vault_app_grants WHERE id=$1',
        [attempt.accountId],
      );
      assert.doesNotMatch(stored.rows[0].ciphertext, /private-access-token|fixture-client/);
      const oauth = createDirectOAuth({
        pool,
        keyStore,
        grantVault,
        ownerId: 'fixture-owner',
        request,
      });
      assert.deepEqual(await oauth.access('fixture-owner', attempt.accountId), {
        service: 'linear',
        accessToken: 'first-refreshed-access-token',
      });
      assert.equal(refreshRequests, 1);
      assert.deepEqual(await oauth.access('fixture-owner', attempt.accountId), {
        service: 'linear',
        accessToken: 'refreshed-access-token',
      });
      assert.equal(refreshRequests, 2);
      await oauth.access('fixture-owner', attempt.accountId);
      assert.equal(refreshRequests, 2);
      assert.doesNotMatch(
        (
          await pool.query<{ ciphertext: string }>(
            'SELECT ciphertext FROM vault_app_grants WHERE id=$1',
            [attempt.accountId],
          )
        ).rows[0].ciphertext,
        /refreshed-access-token/,
      );
      const expiredId = randomUUID();
      await pool.query(
        `INSERT INTO direct_oauth_accounts(id,owner_id,service,connected,expires_at)
         VALUES($1,$2,'linear',false,now()-interval '1 minute')`,
        [expiredId, 'fixture-owner'],
      );
      await pool.query(
        `INSERT INTO direct_oauth_accounts(id,owner_id,service,connected)
         VALUES($1,$2,$3,true)`,
        ['00000000-0000-0000-0000-000000000001', 'fixture-owner', 'linear'],
      );
      const recovered = createDirectOAuth({
        pool,
        keyStore,
        grantVault,
        ownerId: 'fixture-owner',
        request,
      });
      assert.equal(
        (await recovered.access('fixture-owner', attempt.accountId)).accessToken,
        'refreshed-access-token',
      );
      assert.equal(
        (await pool.query('SELECT id FROM direct_oauth_accounts WHERE id=$1', [expiredId]))
          .rowCount,
        0,
      );
      const connectedSession = await provider.createSession('fixture-owner', {
        linear: ['00000000-0000-0000-0000-000000000001', attempt.accountId],
      });
      assert.deepEqual((await connectedSession.search('linear')).tools, {});
      assert.ok(mcpRequests > 0);
      assert.deepEqual((await session.search('linear')).tools, {});
      await assert.rejects(
        session.execute('LINEAR_DELETE_ISSUE', {}, attempt.accountId),
        /unavailable/,
      );
      assert.deepEqual(
        await provider.parseCallback({
          state,
          code: 'fixture-code',
          iss: 'https://mcp.linear.app',
        }),
        callback,
      );
      assert.equal(tokenRequests, 3);
      const raceState = randomBytes(32).toString('base64url');
      const race = await oauth.authorize(
        'fixture-owner',
        'linear',
        `http://localhost:4310/api/apps/callback?state=${raceState}`,
      );
      let resumeRead = () => {};
      let readStarted = () => {};
      const readWait = new Promise<void>((resolve) => {
        resumeRead = resolve;
      });
      const started = new Promise<void>((resolve) => {
        readStarted = resolve;
      });
      const errorCallback = createDirectOAuth({
        pool,
        keyStore,
        grantVault: {
          ...grantVault,
          read: async (id) => {
            const grant = await grantVault.read(id);
            if (id === race.accountId) {
              readStarted();
              await readWait;
            }
            return grant;
          },
        },
        ownerId: 'fixture-owner',
        request,
      });
      const errorResult = errorCallback.parseCallback({
        state: raceState,
        error: 'access_denied',
        iss: 'https://mcp.linear.app',
      });
      await started;
      try {
        await oauth.parseCallback({
          state: raceState,
          code: 'fixture-code',
          iss: 'https://mcp.linear.app',
        });
      } finally {
        resumeRead();
      }
      assert.deepEqual(await errorResult, {
        state: raceState,
        accountId: race.accountId,
        success: false,
      });
      assert.equal(
        JSON.parse((await grantVault.read(race.accountId)).value).accessToken,
        'private-access-token',
      );
    } finally {
      await pool.end();
      await admin.query(`DROP SCHEMA ${schema} CASCADE`);
      await admin.end();
    }
  },
);

test(
  'direct Notion and Linear accounts preserve native setup beside existing HTTP and Composio accounts',
  { skip: !process.env.TEST_DATABASE_URL },
  async () => {
    const schema = `direct_routes_${randomUUID().replaceAll('-', '')}`;
    const admin = new pg.Pool({ connectionString: process.env.TEST_DATABASE_URL });
    await admin.query(`CREATE SCHEMA ${schema}`);
    const pool = new pg.Pool({
      connectionString: process.env.TEST_DATABASE_URL,
      options: `-c search_path=${schema}`,
    });
    const app = Fastify();
    const calls: string[] = [];
    const authorizations: string[] = [];
    const resumes: string[] = [];
    const directAccounts: Array<Record<string, unknown>> = [];
    let composioSearchFails = false;
    let failInspectOnce = false;
    let state = '';
    let lastService = 'notion';
    const session = (id: string): IntegrationSession => ({
      id,
      authorize: async (service, callback) => {
        authorizations.push(`${id}:${service}`);
        if (id === 'direct') {
          state = new URL(callback).searchParams.get('state')!;
          lastService = service;
        }
        return { accountId: `${id}-${service}`, url: 'https://example.test/authorize' };
      },
      search: async () => {
        if (id === 'composio' && composioSearchFails) throw new Error('Provider unavailable.');
        return {
          tools: {
            [`${id}_tool`]: {},
            NOTION_RETRIEVE_PAGE: { provider: id },
            ...(id === 'composio' ? { NOTION_FETCH_DATABASE: { provider: id } } : {}),
          },
          suggestions: [],
        };
      },
      execute: async (action) => {
        calls.push(`${id}:${action}`);
        return { id };
      },
    });
    const provider = (
      id: string,
      services: IntegrationProvider['supportedServices'],
    ): IntegrationProvider => ({
      id,
      configured: true,
      supportedServices: services,
      webhooksConfigured: false,
      supportsSubscriptions: [],
      createSession: async (_ownerId, accounts) => {
        if (id === 'direct') directAccounts.push(accounts);
        return session(id);
      },
      restoreSession: async () => session(id),
      deleteSession: async () => {},
      inspectAccount: async (accountId) => {
        if (accountId.endsWith('linear') && failInspectOnce) {
          failInspectOnce = false;
          throw new Error('Temporary MCP failure.');
        }
        return { active: true, service: accountId.endsWith('linear') ? 'linear' : 'notion' };
      },
      deleteAccount: async () => {},
      parseCallback: async (query) => ({
        state: (query as { state: string }).state,
        accountId: `direct-${lastService}`,
        success: true,
      }),
      subscribe: async () => ({ id: '' }),
      unsubscribe: async () => {},
      verifyWebhook: async () => {
        throw new Error('Unavailable.');
      },
      matchesSubscription: () => false,
    });
    try {
      const key = randomBytes(32);
      const keyStore = { id: 'fixture', configured: true, getKey: async () => key };
      const grantVault = await createAppGrantVault(pool, {
        ownerId: 'local-development',
        keyStore,
      });
      const unavailableFetch = async () => {
        throw new Error('Native setup must not contact a discovered connection.');
      };
      const discovered = await createDiscoveredConnections(pool, {
        ownerId: 'local-development',
        baseUrl: 'http://localhost:4310',
        keyStore,
        grantVault,
        transport: createDiscoveredTransport(unavailableFetch),
        oauth: createDiscoveredOAuth(unavailableFetch),
      });
      const httpId = randomUUID();
      const foreignHttpId = randomUUID();
      const httpPaths = [
        {
          id: randomUUID(),
          kind: 'http',
          endpoint: 'https://example.test/notion/api',
          auth: 'bearer',
          testPath: 'me',
        },
      ];
      for (const [id, owner] of [
        [httpId, 'local-development'],
        [foreignHttpId, 'another-owner'],
      ])
        await pool.query(
          `INSERT INTO discovered_connections(id,owner_id,service,name,account_name,paths)
           VALUES($1,$2,'notion','Notion','HTTP account',$3)`,
          [id, owner, JSON.stringify(httpPaths)],
        );
      const integrations = await createIntegrations(pool, {
        ownerId: 'local-development',
        provider: provider('composio', ['notion']),
        additionalProviders: [provider('direct', ['notion', 'linear'])],
        discovered,
        resumeConnection: async (turnId, service) => {
          resumes.push(`${turnId}:${service}`);
          return true;
        },
        baseUrl: 'http://localhost:4310',
        wake: async () => {},
      });
      integrations.registerRoutes(app);
      const existing = await pool.query<{ id: string }>(
        `INSERT INTO app_connections(owner_id,slug,account_id,provider_id)
         VALUES('local-development','notion','composio-notion','composio') RETURNING id`,
      );
      const foreignNative = await pool.query<{ id: string }>(
        `INSERT INTO app_connections(owner_id,slug,account_id,provider_id)
         VALUES('another-owner','notion','foreign-notion','direct') RETURNING id`,
      );
      const inventory = await integrations.manageConnections('list');
      assert.ok(Array.isArray(inventory));
      assert.deepEqual(inventory.find((item) => item.connectionId === httpId)?.accessPaths, [
        { id: httpPaths[0].id, kind: 'http', endpoint: httpPaths[0].endpoint },
      ]);
      assert.equal(
        inventory.some((item) =>
          [foreignHttpId, foreignNative.rows[0].id].includes(item.connectionId ?? ''),
        ),
        false,
      );
      const legacy = await integrations.execute('local-development', 'SEARCH_TOOLS', {
        query: 'notion',
      });
      assert.ok((legacy as { tools: Record<string, unknown> }).tools.NOTION_FETCH_DATABASE);
      const connect = await integrations.manageConnections('connect', 'notion');
      assert.equal('accounts' in connect, false);
      assert.equal('url' in connect && connect.url, 'https://example.test/authorize');
      const callback = await app.inject({ url: `/api/apps/callback?state=${state}&code=fixture` });
      assert.equal(callback.headers.location, 'http://localhost:4310/apps?connection=connected');
      const rows = (await integrations.list()).filter((item) => item.slug === 'notion');
      assert.equal(rows.length, 3);
      const direct = rows.find(
        (item) => item.connectionId !== existing.rows[0].id && item.connectionId !== httpId,
      )!;
      assert.equal(direct.status, 'connected');
      assert.equal(rows[0]?.connectionId, direct.connectionId);
      assert.deepEqual(await integrations.manageConnections('connect', 'notion'), {
        name: direct.name,
        accounts: [
          {
            connectionId: direct.connectionId,
            accountName: direct.accountName,
            accountEmail: direct.accountEmail,
          },
        ],
      });
      assert.deepEqual(authorizations, ['direct:notion']);
      assert.deepEqual(
        await integrations.execute('local-development', 'NOTION_SEARCH_NOTION_PAGE', {}),
        { id: 'direct' },
      );
      assert.deepEqual(
        await integrations.execute('local-development', 'NOTION_SEARCH_NOTION_PAGE', {
          connectionId: existing.rows[0].id,
        }),
        { id: 'composio' },
      );
      assert.deepEqual(
        await integrations.execute('local-development', 'NOTION_SEARCH_NOTION_PAGE', {
          connectionId: direct.connectionId,
        }),
        { id: 'direct' },
      );
      const search = await integrations.execute('local-development', 'SEARCH_TOOLS', {
        query: 'notion',
      });
      assert.ok(
        directAccounts.some(
          (accounts) => Array.isArray(accounts.notion) && accounts.notion.includes('direct-notion'),
        ),
      );
      assert.deepEqual(Object.keys((search as { tools: object }).tools), [
        'composio_tool',
        'NOTION_RETRIEVE_PAGE',
        'direct_tool',
        'CONNECTED_HTTP',
        'CONNECTED_MCP_CALL',
        'CONNECTED_CLI',
      ]);
      assert.deepEqual((search as { tools: Record<string, unknown> }).tools.NOTION_RETRIEVE_PAGE, {
        provider: 'direct',
      });
      assert.equal(
        Object.hasOwn(
          (search as { tools: Record<string, unknown> }).tools,
          'NOTION_FETCH_DATABASE',
        ),
        false,
      );
      await pool.query('UPDATE app_connections SET account_active=false WHERE id=$1', [
        direct.connectionId,
      ]);
      const inactive = await integrations.execute('local-development', 'SEARCH_TOOLS', {
        query: 'notion',
      });
      assert.equal(directAccounts.at(-1)?.notion, undefined);
      assert.deepEqual(
        (inactive as { tools: Record<string, unknown> }).tools.NOTION_RETRIEVE_PAGE,
        { provider: 'composio' },
      );
      assert.deepEqual(
        await integrations.execute('local-development', 'NOTION_SEARCH_NOTION_PAGE', {}),
        { id: 'composio' },
      );
      await pool.query('UPDATE app_connections SET account_active=true WHERE id=$1', [
        direct.connectionId,
      ]);
      composioSearchFails = true;
      const partial = await integrations.execute('local-development', 'SEARCH_TOOLS', {
        query: 'notion',
      });
      assert.deepEqual(Object.keys((partial as { tools: object }).tools), [
        'direct_tool',
        'NOTION_RETRIEVE_PAGE',
        'CONNECTED_HTTP',
        'CONNECTED_MCP_CALL',
        'CONNECTED_CLI',
      ]);
      composioSearchFails = false;
      await pool.query('UPDATE app_connections SET revoked=true WHERE id=$1', [
        existing.rows[0].id,
      ]);
      const directOnly = await integrations.execute('local-development', 'SEARCH_TOOLS', {
        query: 'notion',
      });
      assert.deepEqual(
        (directOnly as { tools: Record<string, unknown> }).tools.NOTION_RETRIEVE_PAGE,
        { provider: 'direct' },
      );
      const turnId = randomUUID();
      await integrations.manageConnections('connect', 'linear', {
        threadId: randomUUID(),
        turnId,
      });
      failInspectOnce = true;
      const firstCallback = await app.inject({
        url: `/api/apps/callback?state=${state}&code=fixture`,
      });
      assert.equal(
        firstCallback.headers.location,
        'http://localhost:4310/?connection=failed&service=linear',
      );
      const chatCallback = await app.inject({
        url: `/api/apps/callback?state=${state}&code=fixture`,
      });
      assert.equal(
        chatCallback.headers.location,
        'http://localhost:4310/?connection=continued&service=linear',
      );
      assert.deepEqual(resumes, [`${turnId}:linear`]);
      const linear = (await integrations.list()).find((item) => item.slug === 'linear');
      assert.equal(linear?.status, 'connected');
      assert.deepEqual(
        await integrations.manageConnections('connect', 'linear', {
          threadId: randomUUID(),
          turnId: randomUUID(),
        }),
        {
          name: linear?.name,
          accounts: [
            {
              connectionId: linear?.connectionId,
              accountName: linear?.accountName,
              accountEmail: linear?.accountEmail,
            },
          ],
        },
      );
      assert.deepEqual(
        await integrations.execute('local-development', 'LINEAR_LIST_PROJECTS', {
          connectionId: linear?.connectionId,
        }),
        { id: 'direct' },
      );
      assert.deepEqual(calls, [
        'direct:NOTION_SEARCH_NOTION_PAGE',
        'composio:NOTION_SEARCH_NOTION_PAGE',
        'direct:NOTION_SEARCH_NOTION_PAGE',
        'composio:NOTION_SEARCH_NOTION_PAGE',
        'direct:LINEAR_LIST_PROJECTS',
      ]);
    } finally {
      await app.close();
      await pool.end();
      await admin.query(`DROP SCHEMA ${schema} CASCADE`);
      await admin.end();
    }
  },
);

test('a discovered MCP server can register, sign in and refresh without service code', async () => {
  const calls: string[] = [];
  const request: typeof fetch = async (input, init) => {
    const value = new Request(input, init);
    const url = new URL(value.url);
    calls.push(`${value.method} ${url.pathname}`);
    if (url.pathname === '/.well-known/oauth-protected-resource/mcp')
      return Response.json({
        resource: 'https://example.com/mcp',
        authorization_servers: ['https://example.org'],
        scopes_supported: ['read', 'write'],
      });
    if (url.pathname === '/.well-known/oauth-authorization-server')
      return Response.json({
        issuer: 'https://example.org',
        authorization_endpoint: 'https://example.org/authorize',
        token_endpoint: 'https://example.org/token',
        registration_endpoint: 'https://example.org/register',
        response_types_supported: ['code'],
        grant_types_supported: ['authorization_code', 'refresh_token'],
        code_challenge_methods_supported: ['S256'],
      });
    if (url.pathname === '/register')
      return Response.json({ ...JSON.parse(await value.text()), client_id: 'fixture-client' });
    if (url.pathname === '/token') {
      const form = new URLSearchParams(await value.text());
      const refresh = form.get('grant_type') === 'refresh_token';
      if (refresh) assert.equal(form.get('refresh_token'), 'fixture-refresh');
      else {
        assert.equal(form.get('grant_type'), 'authorization_code');
        assert.equal(form.get('code'), 'fixture-code');
      }
      return Response.json({
        access_token: refresh ? 'fresh-token' : 'first-token',
        refresh_token: 'fixture-refresh',
        token_type: 'Bearer',
        expires_in: refresh ? 3600 : 0,
      });
    }
    throw new Error(`Unexpected OAuth request: ${url.pathname}`);
  };
  const oauth = createDiscoveredOAuth(request);
  const started = await oauth.begin(
    'https://example.com/mcp',
    'http://127.0.0.1:4310/api/apps/callback',
    'fixture-state',
    'read write',
  );
  const authorize = new URL(started.url);
  assert.equal(authorize.origin, 'https://example.org');
  assert.equal(authorize.searchParams.get('state'), 'fixture-state');
  assert.equal(authorize.searchParams.get('scope'), 'read write');
  const finished = await oauth.finish('https://example.com/mcp', started.saved, 'fixture-code');
  assert.equal(finished.tokens?.access_token, 'first-token');
  assert.ok(finished.expiresAt !== undefined && finished.expiresAt <= Date.now());
  const refreshed = await oauth.refresh('https://example.com/mcp', finished);
  assert.equal(refreshed.tokens?.access_token, 'fresh-token');
  assert.ok(calls.includes('POST /register'));
  assert.equal(calls.filter((call) => call === 'POST /token').length, 2);
  const registered = calls.filter((call) => call === 'POST /register').length;
  const supplied = await oauth.begin(
    'https://example.com/mcp',
    'http://127.0.0.1:4310/api/apps/callback',
    'another-state',
    'read',
    'supplied-client',
  );
  assert.equal(supplied.saved.clientInformation?.client_id, 'supplied-client');
  assert.equal(calls.filter((call) => call === 'POST /register').length, registered);
});

test(
  'discovered setup preserves owned paths, scoped checks, and atomic replacement invalidation',
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
      let replacementCalls = 0;
      let failReplacement = false;
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
      await pool.query(
        'CREATE TABLE fixture_checks(owner_id text,connection_id uuid,turn_id uuid)',
      );
      const discovered = await createDiscoveredConnections(pool, {
        ownerId: owner,
        baseUrl: 'http://localhost:4310',
        keyStore,
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
            return [
              {
                name: 'list_records',
                inputSchema: { type: 'object' },
                annotations: { readOnlyHint: true },
              },
            ];
          },
          callTool: async (_endpoint, _headers, _name, _input, signal) => {
            await waitForAbort('callTool', signal);
            return { content: [{ type: 'text', text: '[]' }] };
          },
        },
        oauth: {} as Parameters<typeof createDiscoveredConnections>[1]['oauth'],
        runCli: async (_thread, _command, _argv, _envName, _token, _timeout, signal) => {
          cliCalls++;
          await waitForAbort('cli', signal);
          throw new Error('The CLI must not run during setup.');
        },
        accountReplaced: async (connectionId, client) => {
          replacementCalls++;
          await client.query('DELETE FROM fixture_checks WHERE owner_id=$1 AND connection_id=$2', [
            owner,
            connectionId,
          ]);
          if (failReplacement) throw new Error('Synthetic replacement failure.');
        },
      });
      const result = await discovered.propose({
        service: 'fixture-app',
        name: 'Fixture app',
        paths: [{ kind: 'cli', command: 'fixturecli', envName: 'FIXTURE_API_KEY' }],
      });
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
          envName: 'FIXTURE_API_KEY',
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
      await pool.query('INSERT INTO fixture_checks VALUES($1,$2,$3)', [
        owner,
        connectionId,
        ref.turnId,
      ]);
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
        validateActivityCheck: async (turn, selectedId) => {
          const receipt = await pool.query(
            'SELECT 1 FROM fixture_checks WHERE owner_id=$1 AND connection_id=$2 AND turn_id=$3',
            [owner, selectedId, turn.turnId],
          );
          if (!receipt.rowCount) throw new Error('This activity check is unavailable.');
        },
      });
      integrations.registerRoutes(app);
      const cliSetup = await app.inject({
        method: 'POST',
        url: `/api/apps/discovery/${id}/complete`,
        payload: { token: 'synthetic-cli-token', accountName: 'Fixture CLI account' },
      });
      assert.equal(cliSetup.statusCode, 200);
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
        { query: 'list_records' },
        ref,
        new AbortController().signal,
        connectionId,
      )) as { accounts: Array<{ connectionId: string }> };
      assert.deepEqual(
        search.accounts.map((item) => item.connectionId),
        [connectionId],
      );
      assert.deepEqual(catalogs, ['https://fixture.example/mcp']);
      await assert.rejects(
        integrations.execute(
          owner,
          'CONNECTED_CLI',
          { connectionId, pathId: cliPath, argv: ['list'] },
          ref,
          new AbortController().signal,
          connectionId,
        ),
        /only read its selected account/,
      );
      assert.equal(cliCalls, 0);
      await assert.rejects(
        discovered.selected({ connectionId: foreignId, pathId: mcpPath }),
        /unavailable/,
      );
      const mcpArgs = { connectionId, pathId: mcpPath, tool: 'list_records' };
      const cancellations: Array<
        [NonNullable<typeof blocked>, (signal: AbortSignal) => Promise<unknown>]
      > = [
        ['listTools', (signal) => discovered.search('list_records', connectionId, signal)],
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
      failReplacement = true;
      assert.equal((await complete()).statusCode, 502);
      assert.equal((await pool.query('SELECT 1 FROM fixture_checks')).rowCount, 1);
      assert.equal(
        (
          await pool.query('SELECT account_name FROM discovered_connections WHERE id=$1', [
            connectionId,
          ])
        ).rows[0].account_name,
        'Synthetic account',
      );
      assert.equal((await grantVault.read(connectionId)).value, `synthetic-token-${connectionId}`);
      failReplacement = false;
      assert.equal((await complete()).statusCode, 200);
      assert.equal(replacementCalls, 2);
      assert.equal((await pool.query('SELECT 1 FROM fixture_checks')).rowCount, 0);
      assert.equal((await grantVault.read(connectionId)).value, 'synthetic-new-token');
      const count = catalogs.length;
      await assert.rejects(
        integrations.execute(
          owner,
          'SEARCH_TOOLS',
          { query: 'list_records' },
          ref,
          new AbortController().signal,
          connectionId,
        ),
        /unavailable/,
      );
      assert.equal(catalogs.length, count);
    } finally {
      await app.close();
      await pool.end();
      await admin.query(`DROP SCHEMA ${schema} CASCADE`);
      await admin.end();
    }
  },
);

test('Composio failure envelopes reject with the provider error', async (t) => {
  const client = new Composio({
    apiKey: 'fixture-key-never-live',
    allowTracking: false,
    disableVersionCheck: true,
    fileUploadDirs: false,
  });
  let result: Record<string, unknown> = {};
  t.mock.method(client.sessions, 'create', async () => ({
    sessionId: 'fixture-session',
    execute: async () => result,
  }));
  const session = await createComposioProvider({ client }).createSession('local-development', {});
  for (const failure of [
    { data: {}, error: 'Fixture rate limit', logId: 'log-fixture' },
    { data: {}, successful: false },
    { data: { successful: false, error: 'Fixture rate limit' }, error: null },
  ]) {
    result = failure;
    await assert.rejects(session.execute('GMAIL_SEND_EMAIL', {}, 'fixture-account'));
  }
  result = { data: {}, error: 'Fixture rate limit', logId: 'log-fixture' };
  await assert.rejects(session.execute('GMAIL_SEND_EMAIL', {}, 'fixture-account'), {
    message: /Fixture rate limit \(Composio log log-fixture\)/,
  });
  result = { data: { successful: true, id: 'fixture-message' }, error: null };
  assert.deepEqual(await session.execute('GMAIL_SEND_EMAIL', {}, 'fixture-account'), result);
});

test(
  'connected Composio actions execute without a second tool catalog request',
  { skip: !process.env.TEST_DATABASE_URL },
  async (t) => {
    const schema = `catalog_free_${randomUUID().replaceAll('-', '')}`;
    const admin = new pg.Pool({ connectionString: process.env.TEST_DATABASE_URL });
    await admin.query(`CREATE SCHEMA ${schema}`);
    const pool = new pg.Pool({
      connectionString: process.env.TEST_DATABASE_URL,
      options: `-c search_path=${schema}`,
    });
    const client = new Composio({
      apiKey: 'fixture-key-never-live',
      allowTracking: false,
      disableVersionCheck: true,
      fileUploadDirs: false,
    });
    const lookup = t.mock.method(client.tools, 'getRawComposioToolBySlug', async () => {
      throw new Error('Fixture catalog outage');
    });
    const calls: string[] = [];
    t.mock.method(client.sessions, 'create', async () => ({
      sessionId: 'fixture-session',
      execute: async (action: string) => {
        calls.push(action);
        return { data: {}, error: null };
      },
    }));
    t.mock.method(client.sessions, 'delete', async () => ({}));
    try {
      const integrations = await createIntegrations(pool, {
        ownerId: 'fixture-owner',
        provider: createComposioProvider({ client }),
        baseUrl: 'http://localhost:4310',
        wake: async () => {},
      });
      const connectionId = randomUUID();
      await pool.query(
        'INSERT INTO app_connections(id,owner_id,slug,account_id,provider_id) VALUES($1,$2,$3,$4,$5)',
        [connectionId, 'fixture-owner', 'gmail', 'fixture-account', 'composio'],
      );
      await integrations.execute('fixture-owner', 'GMAIL_FETCH_EMAILS', { connectionId });
      await integrations.execute('fixture-owner', 'GMAIL_SEND_EMAIL', { connectionId });
      assert.deepEqual(calls, ['GMAIL_FETCH_EMAILS', 'GMAIL_SEND_EMAIL']);
      assert.equal(lookup.mock.callCount(), 0);
    } finally {
      await pool.end();
      await admin.query(`DROP SCHEMA ${schema} CASCADE`);
      await admin.end();
    }
  },
);

test('Composio account identity comes from an account-bound Google response and excludes credentials', async (t) => {
  const client = new Composio({
    apiKey: 'fixture-key-never-live',
    allowTracking: false,
    disableVersionCheck: true,
    fileUploadDirs: false,
  });
  t.mock.method(client.connectedAccounts, 'get', async () => ({
    status: 'ACTIVE',
    isDisabled: false,
    toolkit: { slug: 'gmail' },
    data: { access_token: 'must-not-expose', email: 'untrusted@example.com' },
  }));
  t.mock.method(client.sessions, 'create', async () => {
    throw new Error('Fixture session is unavailable.');
  });
  const endpoints: string[] = [];
  t.mock.method(
    client.tools,
    'proxyExecute',
    async (input: { connectedAccountId: string; method: string; endpoint: string }) => {
      assert.equal(input.connectedAccountId, 'verified-account');
      assert.equal(input.method, 'GET');
      endpoints.push(input.endpoint);
      if (input.endpoint.includes('/oauth2/'))
        return { status: 403, data: { error: 'Missing profile scope' } };
      assert.equal(input.endpoint, 'https://gmail.googleapis.com/gmail/v1/users/me/profile');
      return {
        status: 200,
        data: {
          emailAddress: 'verified@example.com',
          messagesTotal: 999,
          historyId: 'private-history',
        },
      };
    },
  );
  const provider = createComposioProvider({ client });
  assert.deepEqual(await provider.inspectAccount('verified-account', 'fixture-owner'), {
    active: true,
    service: 'gmail',
    accountEmail: 'verified@example.com',
  });
  assert.deepEqual(await provider.inspectAccount('verified-account', 'fixture-owner'), {
    active: true,
    service: 'gmail',
    accountEmail: 'verified@example.com',
  });
  assert.equal(endpoints.length, 2);
});

test('Composio adapter normalizes sessions without exposing SDK metadata and authenticates raw webhooks', async (t) => {
  const client = new Composio({
    apiKey: 'fixture-key-never-live',
    allowTracking: false,
    disableVersionCheck: true,
    fileUploadDirs: false,
  });
  t.mock.method(client.sessions, 'create', async () => ({
    sessionId: 'fixture-session',
    authorize: async () => ({
      id: 'fixture-account',
      redirectUrl: 'https://connect.composio.dev/link/fixture',
    }),
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
  const provider = createComposioProvider({ client, webhookSecret: 'fixture-signing-secret' });
  const session = await provider.createSession('local-development', {});
  assert.equal(session.id, 'fixture-session');
  assert.deepEqual(await session.authorize('gmail', 'http://localhost:4310/api/apps/callback'), {
    accountId: 'fixture-account',
    url: 'https://connect.composio.dev/link/fixture',
  });
  assert.equal(JSON.stringify(await session.search('Find email')).includes('do-not-expose'), false);
  const body = JSON.stringify({
    id: 'event-fixture',
    type: 'composio.trigger.message',
    timestamp: new Date().toISOString(),
    metadata: {
      log_id: 'log-fixture',
      trigger_slug: 'GMAIL_NEW_GMAIL_MESSAGE',
      trigger_id: 'ti-fixture',
      connected_account_id: 'ca-fixture',
      auth_config_id: 'ac-fixture',
      user_id: 'local-development',
    },
    data: { subject: 'Fixture event' },
  });
  function signed(timestamp = String(Math.floor(Date.now() / 1000))) {
    const id = 'delivery-fixture';
    const signature = createHmac('sha256', 'fixture-signing-secret')
      .update(`${id}.${timestamp}.${body}`)
      .digest('base64');
    return {
      'webhook-id': id,
      'webhook-timestamp': timestamp,
      'webhook-signature': `v1,${signature}`,
    };
  }
  const verified = await provider.verifyWebhook(body, signed());
  assert.equal(verified.ownerId, 'local-development');
  assert.equal(verified.accountId, 'ca-fixture');
  assert.equal(verified.subscriptionId, 'ti-fixture');
  await assert.rejects(
    provider.verifyWebhook(body, { ...signed(), 'webhook-signature': 'v1,invalid' }),
  );
  await assert.rejects(
    createComposioProvider({
      client,
      webhookSecret: 'different-fixture-signing-secret',
    }).verifyWebhook(body, signed()),
  );
  await assert.rejects(
    provider.verifyWebhook(body, signed(String(Math.floor(Date.now() / 1000) - 600))),
  );
});

async function hostedDatabase() {
  const schema = 'test_hosted_integrations_' + randomUUID().replaceAll('-', '');
  const admin = new pg.Pool({ connectionString: process.env.TEST_DATABASE_URL });
  await admin.query(`CREATE SCHEMA ${schema}`);
  const pool = new pg.Pool({
    connectionString: process.env.TEST_DATABASE_URL,
    options: `-c search_path=${schema}`,
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
  'hosted app consent returns to its owned screen and tenant event workers cannot consume each other',
  { skip: !process.env.TEST_DATABASE_URL },
  async (t) => {
    t.mock.timers.enable({ apis: ['setInterval'] });
    const db = await hostedDatabase();
    const apps = [Fastify(), Fastify()];
    const owners = ['owner-one', 'owner-two'];
    const callbacks = new Map<string, string>();
    const accounts = new Map<string, string>();
    const delivered = new Map<string, string[]>();
    let inspectCount = 0;
    const provider: IntegrationProvider = {
      id: 'fixture',
      configured: true,
      webhooksConfigured: true,
      supportsSubscriptions: ['gmail'],
      async createSession(owner) {
        return {
          id: 'session-' + owner,
          authorize: async (_service, callback) => {
            const accountId = randomUUID();
            accounts.set(accountId, owner);
            callbacks.set(owner, callback + '&account=' + accountId + '&success=true');
            return { accountId, url: 'https://provider.example/consent' };
          },
          execute: async () => ({}),
          search: async () => ({ tools: {}, suggestions: [] }),
        };
      },
      restoreSession: async () => {
        throw new Error();
      },
      deleteSession: async () => {},
      deleteAccount: async () => {},
      inspectAccount: async (id, owner) => {
        inspectCount++;
        assert.equal(accounts.get(id), owner);
        return { active: true, service: 'gmail' };
      },
      parseCallback: (input) => {
        const query = input as Record<string, string>;
        return { state: query.state, accountId: query.account, success: query.success === 'true' };
      },
      subscribe: async (_owner, _service, account) => ({ id: 'trigger-' + account }),
      unsubscribe: async () => {},
      verifyWebhook: async (body) => JSON.parse(String(body)),
      matchesSubscription: () => true,
    };
    const services = [];
    try {
      for (const [index, ownerId] of owners.entries()) {
        delivered.set(ownerId, []);
        const service = await createIntegrations(db.pool, {
          ownerId,
          provider,
          baseUrl: 'https://otto.example',
          wake: async (_text, id) => {
            delivered.get(ownerId)!.push(id);
          },
        });
        service.registerRoutes(apps[index]);
        services.push(service);
      }
      assert.equal(
        (
          await apps[0].inject({
            method: 'POST',
            url: '/api/apps/gmail/connect',
            payload: { returnTo: 'https://foreign.example' },
          })
        ).statusCode,
        400,
      );
      assert.equal(callbacks.size, 0);
      assert.equal(
        (
          await apps[0].inject({
            method: 'POST',
            url: '/api/apps/gmail/connect',
            payload: { returnTo: 'onboarding' },
          })
        ).statusCode,
        200,
      );
      const callback = new URL(callbacks.get(owners[0])!);
      const before = inspectCount;
      assert.equal(
        (await apps[1].inject(callback.pathname + callback.search)).headers.location,
        'https://otto.example/apps?connection=expired',
      );
      assert.equal(inspectCount, before);
      assert.equal(
        (await apps[0].inject(callback.pathname + callback.search)).headers.location,
        'https://otto.example/onboarding?connection=connected',
      );
      await assert.rejects(services[1].list(owners[0]), { statusCode: 403 });
      assert.equal(
        (await services[1].list()).some((connection) => connection.status === 'connected'),
        false,
      );
      await apps[1].inject({
        method: 'POST',
        url: '/api/apps/gmail/connect',
        payload: { returnTo: 'apps' },
      });
      const second = new URL(callbacks.get(owners[1])!);
      assert.equal(
        (await apps[1].inject(second.pathname + second.search)).headers.location,
        'https://otto.example/apps?connection=connected',
      );
      for (const [account, owner] of accounts) {
        await db.pool.query(
          'INSERT INTO integration_events(id,owner_id,summary,slug,account_id,trigger_id,provider_id) VALUES($1,$2,$3,$4,$5,$6,$7)',
          [
            'event-' + owner,
            owner,
            'Synthetic event',
            'gmail',
            account,
            'trigger-' + account,
            'fixture',
          ],
        );
      }
      await services[0].drain();
      assert.deepEqual(delivered.get(owners[0]), ['event-' + owners[0]]);
      assert.deepEqual(delivered.get(owners[1]), []);
      assert.equal(
        (await db.pool.query('SELECT state FROM integration_events WHERE owner_id=$1', [owners[1]]))
          .rows[0].state,
        'queued',
      );
      await services[1].drain();
      assert.deepEqual(delivered.get(owners[1]), ['event-' + owners[1]]);
      await apps[0].inject({
        method: 'POST',
        url: '/api/apps/gmail/connect',
        payload: { returnTo: 'onboarding' },
      });
      const cancelled = new URL(callbacks.get(owners[0])!);
      cancelled.searchParams.set('success', 'false');
      assert.equal(
        (await apps[0].inject(cancelled.pathname + cancelled.search)).headers.location,
        'https://otto.example/onboarding?connection=cancelled',
      );
      await apps[0].inject({
        method: 'POST',
        url: '/api/apps/gmail/connect',
        payload: { returnTo: 'onboarding' },
      });
      const expired = new URL(callbacks.get(owners[0])!);
      await db.pool.query(
        "UPDATE app_connections SET callback_expires=now()-interval '1 minute' WHERE owner_id=$1 AND callback_hash IS NOT NULL",
        [owners[0]],
      );
      assert.equal(
        (await apps[0].inject(expired.pathname + expired.search)).headers.location,
        'https://otto.example/onboarding?connection=expired',
      );
    } finally {
      await Promise.all(apps.map((app) => app.close()));
      await db.close();
    }
  },
);

test(
  'provider usage stays owned, counts all operations, preserves unknown pricing and avoids payload capture',
  { skip: !process.env.TEST_DATABASE_URL },
  async () => {
    const schema = `test_usage_${randomUUID().replaceAll('-', '')}`;
    const admin = new pg.Pool({ connectionString: process.env.TEST_DATABASE_URL });
    await admin.query(`CREATE SCHEMA ${schema}`);
    const pool = new pg.Pool({
      connectionString: process.env.TEST_DATABASE_URL,
      options: `-c search_path=${schema}`,
    });
    const turn = randomUUID(),
      foreign = randomUUID();
    let enabled = true;
    const usage = createProviderUsageStore(pool, {
      ownerId: 'owner',
      enabled: () => enabled,
      coverage: [],
    });
    const app = Fastify();
    try {
      await pool.query('CREATE TABLE turns(id uuid PRIMARY KEY,owner_id text NOT NULL)');
      await pool.query('INSERT INTO turns VALUES($1,$2),($3,$4)', [
        turn,
        'owner',
        foreign,
        'other',
      ]);
      await usage.initialize();
      usage.registerRoutes(app);
      const base = {
        provider: 'openai',
        category: 'agent' as const,
        operation: 'response',
        status: 'succeeded' as const,
        durationMs: 10,
        turnId: turn,
      };
      const id = randomUUID();
      usage.record({ ...base, id, inputTokens: 100, costUsd: 0.01, pricing: 'sdk_estimate' });
      usage.record({ ...base, id, inputTokens: 100, costUsd: 0.01, pricing: 'sdk_estimate' });
      usage.record({ ...base, inputTokens: 25, costUsd: 100, pricing: 'unavailable' });
      usage.record({ ...base, turnId: foreign, inputTokens: 999 });
      await usage.withTurn(turn, () =>
        usage.track(
          { provider: 'composio', category: 'integration', operation: 'execute' },
          async () => ({ private: 'never stored' }),
        ),
      );
      await assert.rejects(
        usage.track({ provider: 'jev', category: 'relevance', operation: 'classify' }, async () => {
          throw new Error('private provider error');
        }),
      );
      await usage.flush();
      const current = await usage.read(turn);
      const model = current.providers.find((row) => row.provider === 'openai')!;
      assert.equal(model.requests, 2);
      assert.equal(model.inputTokens, 125);
      assert.equal(model.costUsd, 0.01);
      assert.equal(model.pricedRequests, 1);
      assert.equal(model.pricing, 'sdk_estimate');
      assert.equal(current.providers.find((row) => row.provider === 'composio')?.costUsd, null);
      assert.equal(
        current.providers.some((row) => row.provider === 'jev'),
        false,
      );
      assert.equal(
        (await usage.read()).providers.find((row) => row.provider === 'jev')?.failures,
        1,
      );
      assert.equal(
        (await app.inject(`/api/inspector/providers?turnId=${foreign}`)).statusCode,
        404,
      );
      assert.doesNotMatch(
        JSON.stringify((await pool.query('SELECT * FROM provider_usage')).rows),
        /never stored|private provider error/,
      );
      enabled = false;
      usage.record(base);
      await usage.flush();
      assert.equal(
        (await usage.read(turn)).providers.find((row) => row.provider === 'openai')?.requests,
        2,
      );
      assert.equal((await app.inject('/api/inspector/providers')).statusCode, 404);
      enabled = true;
      await pool.query("UPDATE provider_usage SET recorded_at=now()-interval '8 days'");
      assert.equal((await usage.read()).providers.length, 0);
    } finally {
      await app.close();
      await usage.close();
      await pool.end();
      await admin.query(`DROP SCHEMA ${schema} CASCADE`);
      await admin.end();
    }
  },
);

test('metering covers capabilities without recording prompts, arguments, output or secrets', async () => {
  const rows: unknown[][] = [];
  const pool = {
    query: async (sql: string, values?: unknown[]) => {
      if (sql.includes('INSERT INTO provider_usage')) rows.push(values!);
      return { rows: [], rowCount: 1 };
    },
  } as unknown as pg.Pool;
  const usage = createProviderUsageStore(pool, {
    ownerId: 'owner',
    enabled: () => true,
    coverage: [],
  });
  const events: AgentEvent[] = [];
  const agent = meterAgent(
    {
      async open(options) {
        return {
          resumed: false,
          async prompt() {
            options.onEvent({
              type: 'model_usage',
              id: randomUUID(),
              provider: 'openai',
              model: 'fixture',
              inputTokens: 4,
              outputTokens: 2,
              cacheReadTokens: 0,
              cacheWriteTokens: 0,
              totalTokens: 6,
              costUsd: 0.1,
              costSource: 'sdk_estimate',
              createdAt: new Date().toISOString(),
            });
            options.onEvent({
              type: 'provider_usage',
              usage: {
                provider: 'openai',
                category: 'agent',
                operation: 'compaction',
                status: 'succeeded',
                durationMs: 3,
                inputTokens: 5,
              },
            });
          },
          abort() {},
          dispose() {},
        };
      },
      dispose() {},
    },
    usage,
  );
  await (
    await agent.open({
      threadId: randomUUID(),
      turnId: randomUUID(),
      systemPrompt: 'private prompt',
      tools: [],
      workspace: fakeWorkspace().open({
        threadId: randomUUID(),
        workspacePath: '/fixture/workspace',
        signal: new AbortController().signal,
      }),
      runTool: (_name, _params, run) => run(),
      shouldStop: () => false,
      onEvent: (event) => events.push(event),
    })
  ).prompt('private text', []);
  assert.equal(events.filter((event) => event.type === 'provider_usage').length, 0);
  const speech = meterSpeech(
    {
      id: 'openai',
      configured: true,
      transcribe: async () => 'private transcript',
      synthesize: async () => ({
        bytes: Buffer.from('sound'),
        mimeType: 'audio/mpeg',
        fileName: 'reply.mp3',
      }),
    },
    usage,
  );
  await speech.synthesize('private speech');
  await speech.transcribe({
    bytes: Buffer.from('audio'),
    mimeType: 'audio/wav',
    fileName: 'private.wav',
  });
  await meterRelevance(
    { id: 'jev', configured: true, classify: async () => 'ignore' },
    usage,
  ).classify(
    { private: 'context' },
    {
      instructions: 'private policy',
      criteria: { ignore: '', digest: '', wake: '' },
      minWakeConfidence: 0.5,
    },
  );
  const integration = {
    id: 'composio',
    pollInbox: async () => ({ cursor: 'private-cursor', hasMore: false, messages: [] }),
    restoreSession: async () => ({
      id: 'private-session',
      authorize: async () => ({ accountId: 'private-account', url: 'https://secret.example' }),
      search: async () => ({ tools: [], suggestions: [] }),
      execute: async () => ({ private: 'result' }),
    }),
  } as unknown as IntegrationProvider;
  await (
    await meterIntegrations(integration, usage).restoreSession('private-session')
  ).execute('ACTION', { secret: 'private-credential' }, 'private-account');
  await meterIntegrations(integration, usage).pollInbox!(
    'private-account',
    null,
    new AbortController().signal,
  );
  await meterComputer(
    {
      ...fakeComputer(),
      currentPage: async (threadId) => {
        assert.equal(threadId, 'private-thread');
        return { origin: 'https://private.example', url: 'https://private.example/verification' };
      },
    },
    usage,
  ).currentPage('private-thread');
  await usage.flush();
  assert.deepEqual(
    rows.map((row) => row[5]).sort(),
    [
      'response',
      'compaction',
      'synthesize',
      'transcribe',
      'classify',
      'restore_session',
      'execute',
      'poll_inbox',
      'current_page',
    ].sort(),
  );
  assert.doesNotMatch(JSON.stringify(rows), /private|secret\.example/);
});

function inboxPollFixture(
  t: TestContext,
  respond: (
    input: Parameters<Composio['tools']['proxyExecute']>[0],
    signal: AbortSignal,
  ) => unknown,
) {
  const client = new Composio({
    apiKey: 'fixture-key-never-live',
    allowTracking: false,
    disableVersionCheck: true,
    fileUploadDirs: false,
  });
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
  return createComposioProvider({ client }).pollInbox!;
}

test('Composio inbox polling establishes an account-bound baseline without replaying mail', async (t) => {
  const requests: string[] = [];
  const poll = inboxPollFixture(t, (input) => {
    requests.push(input.endpoint);
    assert.equal(input.endpoint, 'https://gmail.googleapis.com/gmail/v1/users/me/profile');
    assert.deepEqual(input.parameters, [{ in: 'query', name: 'fields', value: 'historyId' }]);
    return { status: 200, data: { historyId: '100', emailAddress: 'omit@example.com' } };
  });
  const baseline = await poll('inbox-account', null, new AbortController().signal);
  assert.deepEqual(baseline.messages, []);
  assert.equal(baseline.hasMore, false);
  assert.deepEqual(JSON.parse(baseline.cursor), {
    accountId: 'inbox-account',
    historyId: '100',
    pending: [],
  });
  await assert.rejects(poll('other-account', baseline.cursor, new AbortController().signal), {
    message: 'The Gmail inbox could not be checked.',
  });
  await assert.rejects(poll('inbox-account', '{invalid', new AbortController().signal), {
    message: 'The Gmail inbox could not be checked.',
  });
  assert.equal(requests.length, 1);
});

test('Composio inbox polling retains page continuations and limits metadata without losing messages', async (t) => {
  const visited: string[] = [];
  const pages: Array<Record<string, string | number>> = [];
  const poll = inboxPollFixture(t, (input) => {
    const query = Object.fromEntries(input.parameters!.map(({ name, value }) => [name, value]));
    if (input.endpoint.endsWith('/history')) {
      pages.push(query);
      assert.equal(query.startHistoryId, '100');
      assert.equal(query.historyTypes, 'messageAdded');
      assert.equal(query.labelId, 'INBOX');
      assert.equal(query.maxResults, 20);
      const ids = query.pageToken
        ? Array.from({ length: 21 }, (_, index) => `m${index + 22}`)
        : Array.from({ length: 22 }, (_, index) => `m${index}`);
      return {
        status: 200,
        data: {
          historyId: '900',
          ...(query.pageToken ? {} : { nextPageToken: 'second-page' }),
          history: [{ messagesAdded: [...ids, ids[0]].map((id) => ({ message: { id } })) }],
        },
      };
    }
    assert.equal(query.format, 'metadata');
    assert.equal(query.fields, 'id,threadId,internalDate,labelIds,payload/headers');
    const id = input.endpoint.split('/').at(-1)!;
    visited.push(id);
    if (id === 'm5') return { status: 404, data: { error: 'Deleted message' } };
    return {
      status: 200,
      data: {
        id,
        threadId: 'thread-' + id,
        internalDate: '1790769600000',
        labelIds: id === 'm7' ? ['ARCHIVED'] : ['INBOX'],
        snippet: 'OTP 1234 A1B2C3 https://example.test/reset?token=credential',
        payload: {
          headers: [
            { name: 'sUbJeCt', value: 'Fixture\nsubject' },
            { name: 'From', value: 'sender@example.com' },
            ...Array.from({ length: 21 }, (_, index) => ({
              name: `X-Fixture-${index}`,
              value: 'must-not-escape',
            })),
          ].filter(
            ({ name }) =>
              !query.metadataHeaders ||
              name.toLowerCase() === String(query.metadataHeaders).toLowerCase(),
          ),
          body: { data: 'must-not-escape' },
        },
      },
    };
  });
  let cursor = JSON.stringify({ accountId: 'inbox-account', historyId: '100' });
  const delivered: string[] = [];
  for (const [count, hasMore] of [
    [20, true],
    [2, true],
    [20, true],
    [1, false],
  ] as const) {
    const before = visited.length;
    const result = await poll('inbox-account', cursor, new AbortController().signal);
    assert.doesNotMatch(JSON.stringify(result), /must-not-escape|A1B2C3|reset\?token|credential/);
    assert.equal(visited.length - before, count);
    assert.equal(result.hasMore, hasMore);
    assert.equal(JSON.parse(result.cursor).historyId, hasMore ? '100' : '900');
    for (const message of result.messages) {
      assert.deepEqual(message, {
        id: message.id,
        threadId: 'thread-' + message.id,
        receivedAt: '2026-09-30T12:00:00.000Z',
        subject: 'Fixture subject',
        sender: 'sender@example.com',
      });
      delivered.push(message.id);
    }
    cursor = result.cursor;
  }
  assert.equal(pages.length, 2);
  assert.equal(pages[1].pageToken, 'second-page');
  assert.equal(visited.length, new Set(visited).size);
  assert.deepEqual(
    delivered,
    visited.filter((id) => !['m5', 'm7'].includes(id)),
  );
});

test('Composio inbox polling preserves completed metadata reads across repeated deadlines', async (t) => {
  let deadline = new AbortController();
  t.mock.method(AbortSignal, 'timeout', () => {
    deadline = new AbortController();
    return deadline.signal;
  });
  const ids = Array.from({ length: 20 }, (_, index) => `m${index}`);
  const completed: string[] = [];
  let historyReads = 0;
  let metadataReads = 0;
  const poll = inboxPollFixture(t, (input, signal) => {
    if (input.endpoint.endsWith('/history')) {
      historyReads++;
      return {
        status: 200,
        data: {
          historyId: '200',
          history: [{ messagesAdded: ids.map((id) => ({ message: { id } })) }],
        },
      };
    }
    if (++metadataReads === 3) {
      deadline.abort(new DOMException('Fixture deadline', 'TimeoutError'));
      signal.throwIfAborted();
    }
    const id = input.endpoint.split('/').at(-1)!;
    completed.push(id);
    return {
      status: 200,
      data: {
        id,
        threadId: `thread-${id}`,
        internalDate: '1790769600000',
        labelIds: ['INBOX'],
        payload: { headers: [] },
      },
    };
  });
  let cursor = JSON.stringify({ accountId: 'inbox-account', historyId: '100' });
  const delivered: string[] = [];
  for (let attempt = 0; attempt < ids.length; attempt++) {
    metadataReads = 0;
    const result = await poll('inbox-account', cursor, new AbortController().signal);
    delivered.push(...result.messages.map(({ id }) => id));
    cursor = result.cursor;
    const state = JSON.parse(cursor);
    assert.deepEqual(state.pending, ids.slice(delivered.length));
    assert.equal(state.historyId, result.hasMore ? '100' : '200');
    if (!result.hasMore) break;
  }
  assert.deepEqual(delivered, ids);
  assert.deepEqual(completed, ids);
  assert.equal(historyReads, 1);
  assert.equal(JSON.parse(cursor).historyId, '200');
});

test('Composio inbox polling rejects cancellation and invalid metadata after partial progress', async (t) => {
  let deadline = new AbortController();
  t.mock.method(AbortSignal, 'timeout', () => {
    deadline = new AbortController();
    return deadline.signal;
  });
  let external = new AbortController();
  let failure: 'cancel' | 'invalid' | 'identity' | 'none' = 'cancel';
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
        labelIds: ['INBOX'],
        payload: { headers: [] },
      },
    };
  });
  const cursor = JSON.stringify({ accountId: 'inbox-account', historyId: '100' });
  await assert.rejects(poll('inbox-account', cursor, external.signal), { name: 'AbortError' });
  external = new AbortController();
  for (const invalid of ['invalid', 'identity'] as const) {
    failure = invalid;
    await assert.rejects(poll('inbox-account', cursor, external.signal), {
      message: 'The Gmail inbox could not be checked.',
    });
  }
  failure = 'none';
  const recovered = await poll('inbox-account', cursor, external.signal);
  assert.deepEqual(
    recovered.messages.map(({ id }) => id),
    ['m0', 'm1'],
  );
  assert.equal(recovered.hasMore, false);
  assert.equal(JSON.parse(recovered.cursor).historyId, '200');
});

test('Composio inbox polling rejects malformed or expired history instead of resetting the baseline', async (t) => {
  let response: unknown;
  const paths: string[] = [];
  const poll = inboxPollFixture(t, (input) => {
    paths.push(input.endpoint);
    if (response instanceof Error) throw response;
    return response;
  });
  const cursor = JSON.stringify({ accountId: 'inbox-account', historyId: '100' });
  for (const failure of [
    { status: 404, data: { error: 'expired private history' } },
    { status: 200, data: { historyId: 'not-a-history-id' } },
    {
      status: 200,
      data: { historyId: '200', history: [{ messagesAdded: [{ message: { id: '../escape' } }] }] },
    },
    new Error('private-provider-error'),
  ]) {
    response = failure;
    await assert.rejects(
      poll('inbox-account', cursor, new AbortController().signal),
      !(failure instanceof Error) && failure.status === 404
        ? IntegrationInboxCursorExpired
        : { message: 'The Gmail inbox could not be checked.' },
    );
  }
  assert.equal(paths.length, 4);
  assert.ok(paths.every((path) => path.endsWith('/history')));
});

test('Composio inbox history overflow requires reconnection without advancing or dropping mail', async (t) => {
  const additions = Array.from({ length: 1001 }, (_, i) => ({ message: { id: `m${i}` } }));
  let history: unknown;
  const paths: string[] = [];
  const poll = inboxPollFixture(t, (input) => {
    paths.push(input.endpoint);
    return { status: 200, data: history };
  });
  const cursor = JSON.stringify({ accountId: 'inbox-account', historyId: '100' });
  for (const page of [
    { historyId: '200', history: [{ messagesAdded: additions }] },
    {
      historyId: '200',
      history: [
        { messagesAdded: additions.slice(0, 500) },
        { messagesAdded: additions.slice(500) },
      ],
    },
    { historyId: '200', history: [], padding: 'x'.repeat(1_000_001) },
  ]) {
    history = page;
    await assert.rejects(
      poll('inbox-account', cursor, new AbortController().signal),
      IntegrationInboxCursorExpired,
    );
  }
  assert.equal(paths.length, 3);
  assert.ok(paths.every((path) => path.endsWith('/history')));
});

test('Composio inbox failure diagnostics retain only bounded transport and schema details', async (t) => {
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
  await assert.rejects(poll('inbox-account', cursor, new AbortController().signal), {
    message: 'The Gmail inbox could not be checked.',
  });
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
  await assert.rejects(poll('inbox-account', cursor, new AbortController().signal), {
    message: 'The Gmail inbox could not be checked.',
  });
  failure = Object.assign(new Error('private-provider-error'), {
    status: 429,
    headers: { Authorization: 'private-key' },
  });
  await assert.rejects(poll('inbox-account', cursor, new AbortController().signal), {
    message: 'The Gmail inbox could not be checked.',
  });
  for (const error of [
    new APIConnectionError({
      cause: new TypeError('private-request-url', {
        cause: Object.assign(new Error('private-host'), { code: 'ECONNRESET' }),
      }),
    }),
    new APIConnectionTimeoutError(),
    new SyntaxError('private-response-body'),
    Object.assign(new TypeError('private-response-body'), { code: 'UND_ERR_SOCKET' }),
    new Error('private-wrapper', {
      cause: Object.assign(new Error('private-http-error'), { statusCode: 502 }),
    }),
    Object.assign(new (class privateSecretProviderError extends Error {})('private-error'), {
      code: 'private-token',
      status: 'private-status',
      statusCode: 900,
    }),
    new Error('private-wrapper', {
      cause: new Error('private-wrapper', {
        cause: new Error('private-wrapper', {
          cause: Object.assign(new Error('private-out-of-depth'), {
            code: 'ECONNRESET',
            statusCode: 503,
          }),
        }),
      }),
    }),
  ]) {
    failure = error;
    await assert.rejects(poll('inbox-account', cursor, new AbortController().signal), {
      message: 'The Gmail inbox could not be checked.',
    });
  }
  assert.deepEqual(
    diagnostics.map(({ timestamp, ...diagnostic }) => {
      assert.equal(typeof timestamp, 'string');
      assert.ok(Number.isFinite(Date.parse(String(timestamp))));
      return diagnostic;
    }),
    [
      { event: 'gmail_inbox_poll_failed', phase: 'message', category: 'http', status: 503 },
      {
        event: 'gmail_inbox_poll_failed',
        phase: 'message',
        category: 'schema',
        status: 200,
        issue: 'too_big',
        field: 'payload.headers.[].value',
      },
      { event: 'gmail_inbox_poll_failed', phase: 'message', category: 'request', status: 429 },
      {
        event: 'gmail_inbox_poll_failed',
        phase: 'message',
        category: 'request',
        errorKind: 'connection',
        causeCode: 'ECONNRESET',
      },
      {
        event: 'gmail_inbox_poll_failed',
        phase: 'message',
        category: 'request',
        errorKind: 'connection_timeout',
      },
      {
        event: 'gmail_inbox_poll_failed',
        phase: 'message',
        category: 'request',
        errorKind: 'invalid_json',
      },
      {
        event: 'gmail_inbox_poll_failed',
        phase: 'message',
        category: 'request',
        errorKind: 'type',
        causeCode: 'UND_ERR_SOCKET',
      },
      { event: 'gmail_inbox_poll_failed', phase: 'message', category: 'request', status: 502 },
      { event: 'gmail_inbox_poll_failed', phase: 'message', category: 'request' },
      { event: 'gmail_inbox_poll_failed', phase: 'message', category: 'request' },
    ],
  );
  assert.doesNotMatch(JSON.stringify(diagnostics), /private|inbox-account|Authorization|https?:/);
});

test('Composio inbox polling rejects mismatched metadata and stops immediately on cancellation', async (t) => {
  let controller = new AbortController();
  let calls = 0;
  let cancel = false;
  const poll = inboxPollFixture(t, (input, signal) => {
    calls++;
    if (input.endpoint.endsWith('/history'))
      return {
        status: 200,
        data: {
          historyId: '200',
          history: [
            { messagesAdded: [{ message: { id: 'first' } }, { message: { id: 'second' } }] },
          ],
        },
      };
    if (cancel) {
      controller.abort();
      assert.equal(signal.aborted, true);
    }
    return {
      status: 200,
      data: {
        id: 'mismatched',
        threadId: 'thread',
        internalDate: '1790769600000',
        labelIds: ['INBOX'],
        payload: { headers: [] },
      },
    };
  });
  const cursor = JSON.stringify({ accountId: 'inbox-account', historyId: '100' });
  await assert.rejects(poll('inbox-account', cursor, controller.signal), {
    message: 'The Gmail inbox could not be checked.',
  });
  assert.equal(calls, 2);
  cancel = true;
  controller = new AbortController();
  await assert.rejects(poll('inbox-account', cursor, controller.signal), { name: 'AbortError' });
  assert.equal(calls, 4);
  await assert.rejects(poll('inbox-account', cursor, controller.signal), { name: 'AbortError' });
  assert.equal(calls, 4);
});

test('connected provider cancellation reaches session creation, search, schemas, and execution', async (t) => {
  const client = new Composio({
    apiKey: 'fixture-key-never-live',
    allowTracking: false,
    disableVersionCheck: true,
    fileUploadDirs: false,
  });
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
      options: { signal?: AbortSignal },
    ) => {
      assert.equal(account.account, 'fixture-account');
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
    client.sessions,
    'use',
    async (_id: string, _input: unknown, options: { signal?: AbortSignal }) =>
      phase === 'restore' ? block(options.signal) : managed,
  );
  t.mock.method(
    client.getClient().toolRouter.session,
    'executeMeta',
    async (
      _id: string,
      _input: unknown,
      options: { signal?: AbortSignal; maxRetries?: number },
    ) => {
      assert.equal(options.maxRetries, 0);
      return block(options.signal);
    },
  );
  const usage = {
    track: async (_input: unknown, run: () => Promise<unknown>) => run(),
  } as Parameters<typeof meterIntegrations>[1];
  const provider = meterIntegrations(createComposioProvider({ client }), usage);
  const session = await provider.createSession('fixture-owner', { gmail: ['fixture-account'] });
  for (const [name, run] of [
    ['create', (signal: AbortSignal) => provider.createSession('fixture-owner', {}, signal)],
    ['restore', (signal: AbortSignal) => provider.restoreSession('fixture-session', signal)],
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
  assert.equal(requests.length, 5);
});

test('direct MCP cancellation aborts pending tool discovery and reads', async () => {
  for (const blockedMethod of ['tools/list', 'tools/call']) {
    const controller = new AbortController();
    let started = () => {};
    const waiting = new Promise<void>((resolve) => {
      started = resolve;
    });
    let pendingSignal: AbortSignal | null | undefined;
    const request: typeof fetch = async (_input, init) => {
      if (init?.method === 'GET') return new Response(null, { status: 405 });
      const message = JSON.parse(String(init?.body));
      if (message.method === blockedMethod) {
        pendingSignal = init?.signal;
        assert.ok(pendingSignal);
        return new Promise<Response>((_resolve, reject) => {
          pendingSignal!.addEventListener('abort', () => reject(pendingSignal!.reason), {
            once: true,
          });
          started();
        });
      }
      if (message.id === undefined) return new Response(null, { status: 202 });
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
            : { tools: [{ name: 'list_issues', inputSchema: { type: 'object' } }] },
      });
    };
    const result = assert.rejects(
      withDirectMcp(
        'linear',
        'synthetic-token',
        request,
        async (client) => {
          await client.listTools();
          return client.callTool({ name: 'list_issues', arguments: {} });
        },
        controller.signal,
      ),
    );
    await waiting;
    controller.abort();
    await result;
    assert.equal(pendingSignal?.aborted, true);
  }
});

test('discovered validation cancellation never starts HTTP after a late DNS settlement', async () => {
  for (const fails of [false, true]) {
    const controller = new AbortController();
    let resolveValidation = (_value: { url: URL; address: string }) => {};
    let rejectValidation = (_error: Error) => {};
    let requests = 0;
    const validation = new Promise<{ url: URL; address: string }>((resolve, reject) => {
      resolveValidation = resolve;
      rejectValidation = reject;
    });
    const operation = safeRemoteFetch(
      'https://fixture.example/api',
      { signal: controller.signal },
      {
        validate: () => validation,
        request: (() => {
          requests++;
          throw new Error('HTTP must not start.');
        }) as NonNullable<Parameters<typeof safeRemoteFetch>[2]>['request'],
      },
    );
    const result = assert.rejects(operation, { name: 'AbortError' });
    controller.abort();
    await result;
    if (fails) rejectValidation(new Error('Synthetic DNS failure.'));
    else
      resolveValidation({ url: new URL('https://fixture.example/api'), address: '93.184.216.34' });
    await Promise.resolve();
    assert.equal(requests, 0);
  }
});

test(
  'direct OAuth refresh cancellation serializes settlement and fences uncertain rotating tokens',
  { skip: !process.env.TEST_DATABASE_URL },
  async () => {
    const schema = `direct_cancel_${randomUUID().replaceAll('-', '')}`;
    const admin = new pg.Pool({ connectionString: process.env.TEST_DATABASE_URL });
    await admin.query(`CREATE SCHEMA ${schema}`);
    const pool = new pg.Pool({
      connectionString: process.env.TEST_DATABASE_URL,
      options: `-c search_path=${schema}`,
    });
    const ownerId = 'fixture-owner';
    const accountId = randomUUID();
    const key = randomBytes(32);
    const keyStore = { id: 'fixture', configured: true, getKey: async () => key };
    try {
      const vault = await createAppGrantVault(pool, { ownerId, keyStore });
      let reads = 0;
      const requests: Array<{
        signal: AbortSignal;
        resolve: (response: Response) => void;
        reject: (error: unknown) => void;
      }> = [];
      const oauth = createDirectOAuth({
        pool,
        ownerId,
        keyStore,
        grantVault: {
          ...vault,
          read: async (id) => {
            const grant = await vault.read(id);
            reads++;
            return grant;
          },
        },
        request: async (_input, init) => {
          const signal = init?.signal;
          assert.ok(signal);
          return new Promise<Response>((resolve, reject) => {
            requests.push({ signal, resolve, reject });
          });
        },
      });
      await oauth.ready;
      await pool.query(
        'INSERT INTO direct_oauth_accounts(id,owner_id,service,connected) VALUES($1,$2,$3,true)',
        [accountId, ownerId, 'linear'],
      );
      const expire = () =>
        vault.put(
          accountId,
          JSON.stringify({
            accessToken: 'synthetic-old-token',
            refreshToken: 'synthetic-refresh',
            expiresAt: 1,
            clientId: 'fixture',
            tokenEndpoint: 'https://fixture.example/token',
          }),
        );
      const wait = async (condition: () => boolean) => {
        for (let attempt = 0; attempt < 100 && !condition(); attempt++) await delay(5);
        assert.ok(condition());
      };
      await expire();
      const cancelled = new AbortController();
      const live = new AbortController();
      const first = assert.rejects(oauth.access(ownerId, accountId, cancelled.signal), {
        name: 'AbortError',
      });
      const second = oauth.access(ownerId, accountId, live.signal);
      await wait(() => reads === 2 && requests.length === 1);
      cancelled.abort();
      await first;
      assert.equal(requests[0].signal.aborted, false);
      requests[0].resolve(Response.json({ access_token: 'synthetic-new-token', expires_in: 3600 }));
      assert.equal((await second).accessToken, 'synthetic-new-token');
      assert.equal(
        JSON.parse((await vault.read(accountId)).value).accessToken,
        'synthetic-new-token',
      );
      await expire();
      const abandoned = new AbortController();
      const third = assert.rejects(oauth.access(ownerId, accountId, abandoned.signal), {
        name: 'AbortError',
      });
      await wait(() => requests.length === 2);
      abandoned.abort();
      await third;
      assert.equal(requests[1].signal.aborted, true);
      assert.equal(
        JSON.parse((await vault.read(accountId)).value).accessToken,
        'synthetic-old-token',
      );
      let completed = false;
      const before = reads;
      const late = oauth.access(ownerId, accountId).finally(() => {
        completed = true;
      });
      await wait(() => reads > before);
      assert.equal(requests.length, 2);
      assert.equal(completed, false);
      requests[1].resolve(
        Response.json({
          access_token: 'synthetic-late-token',
          refresh_token: 'synthetic-rotated-token',
          expires_in: 3600,
        }),
      );
      assert.equal((await late).accessToken, 'synthetic-late-token');
      assert.equal(
        JSON.parse((await vault.read(accountId)).value).refreshToken,
        'synthetic-rotated-token',
      );
      await expire();
      const uncertain = new AbortController();
      const fourth = assert.rejects(oauth.access(ownerId, accountId, uncertain.signal), {
        name: 'AbortError',
      });
      await wait(() => requests.length === 3);
      uncertain.abort();
      await fourth;
      const beforeJoining = reads;
      const joining = assert.rejects(oauth.access(ownerId, accountId), { name: 'AbortError' });
      await wait(() => reads > beforeJoining);
      assert.equal(requests.length, 3);
      requests[2].reject(requests[2].signal.reason);
      await joining;
      await assert.rejects(oauth.access(ownerId, accountId), {
        message: 'Connect this account again.',
      });
      const restarted = createDirectOAuth({
        pool,
        ownerId,
        keyStore,
        grantVault: vault,
        request: async () => {
          throw new Error('An uncertain refresh must not be retried.');
        },
      });
      await assert.rejects(restarted.access(ownerId, accountId), {
        message: 'Connect this account again.',
      });
      assert.equal(requests.length, 3);
      await expire();
      const recovered = oauth.access(ownerId, accountId);
      await wait(() => requests.length === 4);
      requests[3].resolve(
        Response.json({ access_token: 'synthetic-recovered-token', expires_in: 3600 }),
      );
      assert.equal((await recovered).accessToken, 'synthetic-recovered-token');
      await oauth.access(ownerId, accountId);
      assert.equal(requests.length, 4);
    } finally {
      await pool.end();
      await admin.query(`DROP SCHEMA ${schema} CASCADE`);
      await admin.end();
    }
  },
);

test('discovered transports cancel HTTP, MCP discovery, and MCP reads in flight', async () => {
  for (const blockedMethod of ['http', 'initialize', 'tools/list', 'tools/call']) {
    const controller = new AbortController();
    let started = () => {};
    const waiting = new Promise<void>((resolve) => {
      started = resolve;
    });
    let pendingSignal: AbortSignal | null | undefined;
    let requests = 0;
    const transport = createDiscoveredTransport(async (_input, init) => {
      requests++;
      if (blockedMethod !== 'http' && init?.method === 'GET')
        return new Response(null, { status: 405 });
      const message =
        blockedMethod === 'http' ? { method: 'http' } : JSON.parse(String(init?.body));
      if (message.method === blockedMethod) {
        pendingSignal = init?.signal;
        assert.ok(pendingSignal);
        return new Promise<Response>((_resolve, reject) => {
          pendingSignal!.addEventListener('abort', () => reject(pendingSignal!.reason), {
            once: true,
          });
          started();
        });
      }
      if (message.id === undefined) return new Response(null, { status: 202 });
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
            : {
                tools: [
                  {
                    name: 'list_records',
                    inputSchema: { type: 'object' },
                    annotations: { readOnlyHint: true },
                  },
                ],
              },
      });
    });
    const run = () =>
      blockedMethod === 'http'
        ? transport.http('https://fixture.example/api', {}, 'GET', undefined, controller.signal)
        : blockedMethod === 'tools/call'
          ? transport.callTool(
              'https://fixture.example/mcp',
              {},
              'list_records',
              {},
              controller.signal,
            )
          : transport.listTools('https://fixture.example/mcp', {}, controller.signal);
    const result = assert.rejects(run());
    await waiting;
    controller.abort();
    await result;
    assert.equal(pendingSignal?.aborted, true);
    const count = requests;
    if (blockedMethod !== 'http') {
      await assert.rejects(run(), { name: 'AbortError' });
      assert.equal(requests, count);
    }
  }
});

test('discovered OAuth cancellation stops discovery and token refresh without saving tokens', async () => {
  for (const cached of [false, true]) {
    const controller = new AbortController();
    let started = () => {};
    const waiting = new Promise<void>((resolve) => {
      started = resolve;
    });
    let pendingSignal: AbortSignal | null | undefined;
    let requests = 0;
    const oauth = createDiscoveredOAuth(async (input, init) => {
      requests++;
      const value = new Request(input, init);
      if (cached) assert.equal(value.url, 'https://fixture.example/token');
      pendingSignal = value.signal;
      return new Promise<Response>((_resolve, reject) => {
        pendingSignal!.addEventListener('abort', () => reject(pendingSignal!.reason), {
          once: true,
        });
        started();
      });
    });
    const saved: Parameters<typeof oauth.refresh>[1] = {
      redirectUri: 'http://127.0.0.1:4310/api/apps/callback',
      clientInformation: { client_id: 'fixture-client' },
      tokens: {
        access_token: 'synthetic-old-token',
        refresh_token: 'synthetic-refresh',
        token_type: 'Bearer',
        expires_in: 0,
      },
      ...(cached
        ? {
            discovery: {
              authorizationServerUrl: 'https://fixture.example',
              resourceMetadata: {
                resource: 'https://fixture.example/mcp',
                authorization_servers: ['https://fixture.example'],
              },
              authorizationServerMetadata: {
                issuer: 'https://fixture.example',
                authorization_endpoint: 'https://fixture.example/authorize',
                token_endpoint: 'https://fixture.example/token',
                response_types_supported: ['code'],
                grant_types_supported: ['authorization_code', 'refresh_token'],
                token_endpoint_auth_methods_supported: ['none'],
              },
            },
          }
        : {}),
    };
    const result = assert.rejects(
      oauth.refresh('https://fixture.example/mcp', saved, controller.signal),
    );
    await waiting;
    controller.abort();
    await result;
    assert.equal(pendingSignal?.aborted, true);
    assert.equal(requests, 1);
    assert.equal(saved.tokens?.access_token, 'synthetic-old-token');
    await assert.rejects(oauth.refresh('https://fixture.example/mcp', saved, controller.signal), {
      name: 'AbortError',
    });
    assert.equal(requests, 1);
  }
});
