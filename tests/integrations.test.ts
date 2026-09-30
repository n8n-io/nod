import assert from 'node:assert/strict';
import { createHmac, randomBytes, randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test, { type TestContext } from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';
import { Composio } from '@composio/core';
import Fastify from 'fastify';
import pg from 'pg';
import type {
  Agent,
  AgentEvent,
  AgentToolResult,
  RuntimeContext,
  RuntimeObservation,
} from '../src/ports/agent.ts';
import type {
  IntegrationFile,
  IntegrationProvider,
  IntegrationService,
  IntegrationSession,
} from '../src/ports/integrations.ts';
import { createComposioProvider } from '../src/providers/composio/integrations.ts';
import { createDirectProvider } from '../src/providers/direct/integrations.ts';
import { createDirectOAuth } from '../src/providers/direct/oauth.ts';
import { createDiscoveredOAuth } from '../src/providers/discovered/oauth.ts';
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

const readTool = { annotations: { readOnlyHint: true } };

function catalogReadOnly(tools: Record<string, { annotations?: { readOnlyHint?: boolean } }>) {
  return async (action: string) => tools[action]?.annotations?.readOnlyHint === true;
}

function fakeProvider(
  session: IntegrationSession,
  tools: Parameters<typeof catalogReadOnly>[0] = {},
): IntegrationProvider {
  return {
    id: 'fixture',
    configured: true,
    webhooksConfigured: true,
    supportsSubscriptions: ['gmail', 'googlecalendar'],
    createSession: async () => session,
    restoreSession: async () => session,
    readOnly: catalogReadOnly(tools),
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
  'integration accounts stay owner-private while event policy verifies, deduplicates, and gates writes',
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
    const provider = fakeProvider(session, { GMAIL_FETCH_EMAILS: readTool });
    const discoveredBrowserId = randomUUID();
    const pendingBrowserId = randomUUID();
    const savedLoginIds = [randomUUID(), randomUUID()];
    let savedLoginReads = 0;
    const integrations = await createIntegrations(pool, {
      ownerId: 'local-development',
      provider,
      baseUrl: 'http://localhost:4310',
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
          accessPaths: [{ id, kind: 'browser' as const, endpoint: 'https://example.test' }],
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
      assert.deepEqual(result, {
        requiresApproval: true,
        action: 'GMAIL_SEND_EMAIL',
        args: {
          recipient_email: 'test@example.com',
          subject: 'Fixture',
          connectionId: (await integrations.list()).find((row) => row.slug === 'gmail')
            ?.connectionId,
        },
      });
      assert.equal(executed, 0);
      await integrations.execute('local-development', 'GMAIL_FETCH_EMAILS', { max_results: 5 });
      assert.equal(executed, 1);
      await integrations.executeApproved('local-development', 'GMAIL_SEND_EMAIL', {
        recipient_email: 'fixture@example.com',
        connectionId: (await integrations.list()).find((row) => row.slug === 'gmail')?.connectionId,
      });
      assert.equal(executed, 2);
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
        searches.mock.calls.map((call) => call.arguments),
        [['Send an email']],
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
  'multiple Google accounts keep independent identity, approvals, subscriptions and revocation',
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
    const provider = fakeProvider(session, { GMAIL_LIST_LABELS: readTool });
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
      const approval = await integrations.execute('local-development', 'GMAIL_SEND_EMAIL', {
        connectionId: first.connectionId,
        subject: 'Fixture',
      });
      assert.deepEqual(approval, {
        requiresApproval: true,
        action: 'GMAIL_SEND_EMAIL',
        args: { connectionId: first.connectionId, subject: 'Fixture' },
      });
      assert.equal(executions.length, 1);
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
            message:
              'This approval does not identify its connected account. Request a new approval.',
          },
        );
      }
      assert.equal(executions.length, 1);
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

async function appsFixture(t: TestContext) {
  const schema = `test_apps_${randomUUID().replaceAll('-', '')}`;
  const admin = new pg.Pool({ connectionString: process.env.TEST_DATABASE_URL });
  await admin.query(`CREATE SCHEMA ${schema}`);
  const pool = new pg.Pool({
    connectionString: process.env.TEST_DATABASE_URL,
    options: `-c search_path=${schema}`,
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
  const tools = {
    GMAIL_GET_ATTACHMENT: readTool,
    NOTION_RETRIEVE_PAGE: readTool,
    SLACK_SEARCH_MESSAGES: readTool,
  };
  const session: IntegrationSession = {
    id: 'current-session',
    authorize: async (service, callback) => {
      const accountId = `account-${accounts.size + 1}`;
      accounts.set(accountId, service);
      callbacks.push(callback);
      return { accountId, url: 'https://consent.example.com/connect' };
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
    readOnly: catalogReadOnly(tools),
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
    ownerId: 'local-development',
    provider,
    baseUrl: 'http://localhost:4310',
    wake: async (_prompt, id) => {
      wakes.push(id);
    },
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
    callbacks,
  };
}

test(
  'Slack and Notion preserve owned accounts, reviewed reads, exact write approvals and signed event boundaries',
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
      assert.deepEqual(result, { requiresApproval: true, action, args: { connectionId } });
    }
    assert.equal(f.executed.length, 2);
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
  'attachment retrieval avoids write review and downloads only from the selected current account',
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
  tools: { GMAIL_LIST_LABELS: { inputSchema: { type: 'object' }, ...readTool } },
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
    readOnly: catalogReadOnly(searchResult.tools),
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
  'a foreign account hint cannot select another owner or narrow discovery',
  { skip: !process.env.TEST_DATABASE_URL },
  async (t) => {
    const f = await searchFixture(t, async (execute, connectionId) => {
      const result = await execute('search', 'SEARCH_TOOLS', {
        query,
        connectionId: f.foreignId,
      });
      assert.deepEqual(
        (result as { accounts: Array<{ connectionId: string }> }).accounts
          .map((item) => item.connectionId)
          .sort(),
        [f.connectionId, f.calendarId].sort(),
      );
      assert.doesNotMatch(JSON.stringify(result), /fixture-foreign/);
      await execute('labels', 'GMAIL_LIST_LABELS', { connectionId, user_id: 'me' });
    });
    assert.deepEqual(await f.run(), { status: 'succeeded' });
    assert.deepEqual(f.searches, [query]);
    assert.deepEqual(f.sessions, [
      {
        owner: f.owner,
        accounts: { gmail: ['fixture-gmail'], googlecalendar: ['fixture-calendar'] },
      },
    ]);
    assert.deepEqual(f.calls, [
      {
        action: 'GMAIL_LIST_LABELS',
        args: { user_id: 'me' },
        accountId: 'fixture-gmail',
      },
    ]);
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
    t.mock.method(transport, 'execute', async (id: string, input: Record<string, unknown>) => {
      assert.equal(id, 'execution-session');
      assert.equal(input.account, 'existing-account');
      return { data: { labels: [] }, error: null, log_id: 'synthetic-log' };
    });
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
  'direct Notion and Linear accounts work beside an existing Composio Notion account',
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
    const resumes: string[] = [];
    const directAccounts: Array<Record<string, unknown>> = [];
    let composioSearchFails = false;
    let failInspectOnce = false;
    let state = '';
    let lastService = 'notion';
    const session = (id: string): IntegrationSession => ({
      id,
      authorize: async (service, callback) => {
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
      readOnly: catalogReadOnly({
        NOTION_SEARCH_NOTION_PAGE: readTool,
        LINEAR_LIST_PROJECTS: readTool,
      }),
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
      const integrations = await createIntegrations(pool, {
        ownerId: 'local-development',
        provider: provider('composio', ['notion']),
        additionalProviders: [provider('direct', ['notion', 'linear'])],
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
      const legacy = await integrations.execute('local-development', 'SEARCH_TOOLS', {
        query: 'notion',
      });
      assert.ok((legacy as { tools: Record<string, unknown> }).tools.NOTION_FETCH_DATABASE);
      const connect = await app.inject({ method: 'POST', url: '/api/apps/notion/connect' });
      assert.equal(connect.statusCode, 200);
      const callback = await app.inject({ url: `/api/apps/callback?state=${state}&code=fixture` });
      assert.equal(callback.headers.location, 'http://localhost:4310/apps?connection=connected');
      const rows = (await integrations.list()).filter((item) => item.slug === 'notion');
      assert.equal(rows.length, 2);
      const direct = rows.find((item) => item.connectionId !== existing.rows[0].id)!;
      assert.equal(direct.status, 'connected');
      assert.equal(rows[0]?.connectionId, direct.connectionId);
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
  'a discovered setup link identifies the saved access path',
  { skip: !process.env.TEST_DATABASE_URL },
  async () => {
    const schema = `test_discovery_${randomUUID().replaceAll('-', '')}`;
    const admin = new pg.Pool({ connectionString: process.env.TEST_DATABASE_URL });
    await admin.query(`CREATE SCHEMA ${schema}`);
    const pool = new pg.Pool({
      connectionString: process.env.TEST_DATABASE_URL,
      options: `-c search_path=${schema}`,
    });
    try {
      const discovered = await createDiscoveredConnections(pool, {
        ownerId: 'fixture-owner',
        baseUrl: 'http://localhost:4310',
        keyStore: {},
        grantVault: {},
        transport: {},
        oauth: {},
        runCli: async () => {
          throw new Error('The CLI must not run during setup.');
        },
      } as unknown as Parameters<typeof createDiscoveredConnections>[1]);
      const result = await discovered.propose({
        service: 'fixture-app',
        name: 'Fixture app',
        paths: [
          { kind: 'cli', command: 'fixturecli', envName: 'FIXTURE_API_KEY', testArgs: ['list'] },
        ],
      });
      const id = new URL(result.url, 'http://localhost:4310').searchParams.get('connect');
      const saved = await pool.query<{ paths: Array<{ id: string }> }>(
        'SELECT paths FROM discovered_connection_proposals WHERE id=$1',
        [id],
      );
      assert.equal(saved.rows[0].paths[0].id, id);
    } finally {
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

test('Composio actions skip review only when the catalog tags them read-only', async (t) => {
  const client = new Composio({
    apiKey: 'fixture-key-never-live',
    allowTracking: false,
    disableVersionCheck: true,
    fileUploadDirs: false,
  });
  const tags: Record<string, string[]> = {
    GMAIL_GET_PROFILE: ['readOnlyHint', 'openWorldHint'],
    GMAIL_SEND_EMAIL: ['openWorldHint'],
    SLACK_GET_AND_DELETE_MESSAGES: ['readOnlyHint', 'destructiveHint'],
    GMAIL_UNTAGGED_ACTION: [],
    GMAIL_LIST_THREADS: ['readOnlyHint'],
  };
  let outage = true;
  const lookup = t.mock.method(client.tools, 'getRawComposioToolBySlug', async (slug: string) => {
    if (slug === 'GMAIL_LIST_THREADS' && outage) throw new Error('Fixture catalog outage');
    return { slug, name: slug, tags: tags[slug] };
  });
  const provider = createComposioProvider({ client });
  assert.equal(await provider.readOnly('GMAIL_GET_PROFILE'), true);
  assert.equal(await provider.readOnly('GMAIL_SEND_EMAIL'), false);
  assert.equal(await provider.readOnly('SLACK_GET_AND_DELETE_MESSAGES'), false);
  assert.equal(await provider.readOnly('GMAIL_UNTAGGED_ACTION'), false);
  assert.equal(await provider.readOnly('not a tool slug'), false);
  assert.equal(await provider.readOnly('GMAIL_LIST_THREADS'), false);
  outage = false;
  assert.equal(await provider.readOnly('GMAIL_LIST_THREADS'), true);
  assert.equal(await provider.readOnly('GMAIL_GET_PROFILE'), true);
  assert.equal(lookup.mock.callCount(), 6);
});

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
      readOnly: async () => false,
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
  const target = {
    origin: 'https://private.example',
    kind: 'otp' as const,
    passwordSelector: '@e19',
    emailCode: true,
  };
  await meterComputer(
    {
      ...fakeComputer(),
      inspectLogin: async (threadId, selected) => {
        assert.equal(threadId, 'private-thread');
        assert.deepEqual(selected, target);
        return {
          origin: 'https://private.example',
          url: 'https://private.example/verification',
          fields: [],
          methods: [],
        };
      },
    },
    usage,
  ).inspectLogin('private-thread', target);
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
      'inspect_login',
    ].sort(),
  );
  assert.doesNotMatch(JSON.stringify(rows), /private|secret\.example/);
});
