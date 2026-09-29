import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import test, { type TestContext } from 'node:test';
import Fastify from 'fastify';
import pg from 'pg';
import type {
  IntegrationFile,
  IntegrationProvider,
  IntegrationService,
  IntegrationSession,
} from '../src/ports/integrations.ts';
import { integrationServiceIds } from '../src/shared/integrations.ts';
import { createIntegrations } from '../src/server/integrations.ts';

async function fixture(t: TestContext) {
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
  'new-window consent returns before session cleanup and closes through a fixed page',
  { skip: !process.env.TEST_DATABASE_URL, timeout: 30_000 },
  async (t) => {
    const f = await fixture(t);
    let release!: () => void;
    f.provider.deleteSession = () =>
      new Promise((resolve) => {
        release = resolve;
      });
    const response = await f.app.inject({
      method: 'POST',
      url: '/api/apps/slack/connect',
      payload: { returnTo: 'window' },
    });
    assert.equal(response.statusCode, 200, response.body);
    release();
    const url = new URL(f.callbacks.at(-1)!);
    assert.equal(response.json().attempt, url.searchParams.get('state'));
    url.searchParams.set('account', [...f.accounts.keys()].at(-1)!);
    const callback = await f.app.inject({ url: `${url.pathname}${url.search}` });
    assert.equal(
      callback.headers.location,
      `http://localhost:4310/connected.html?connection=connected&service=slack&attempt=${response.json().attempt}`,
    );
    const forged = await f.app.inject({
      url: `/api/apps/callback?state=${'x'.repeat(43)}&returnTo=window&service=slack`,
    });
    assert.equal(forged.headers.location, 'http://localhost:4310/apps?connection=expired');
    const rejected = await f.app.inject({
      method: 'POST',
      url: '/api/apps/slack/connect',
      payload: { returnTo: 'https://attacker.example.test' },
    });
    assert.equal(rejected.statusCode, 400);
  },
);

test(
  'owned app reads omit oversized results while discovery preserves complete schemas',
  { skip: !process.env.TEST_DATABASE_URL },
  async (t) => {
    const f = await fixture(t);
    const notion = await f.connect('notion');
    const args = { connectionId: notion.connectionId, query: 'synthetic page', page_size: 100 };
    const oversized = {
      results: [
        { title: 'Earlier unrelated page', description: 'x'.repeat(18_000) },
        { title: 'Synthetic page beyond the old cutoff' },
      ],
      has_more: false,
    };
    let executions = 0;
    f.session.execute = async (action, providerArgs, accountId) => {
      executions += 1;
      assert.equal(action, 'NOTION_SEARCH_NOTION_PAGE');
      assert.equal(accountId, notion.accountId);
      assert.deepEqual(providerArgs, { query: 'synthetic page', page_size: 100 });
      return oversized;
    };
    const result = (await f.service.execute(
      'local-development',
      'NOTION_SEARCH_NOTION_PAGE',
      args,
    )) as Record<string, unknown>;
    assert.equal(executions, 1);
    assert.equal(result.truncated, true);
    assert.equal(result.resultOmitted, true);
    assert.equal(result.originalBytes, Buffer.byteLength(JSON.stringify(oversized)));
    assert.ok(Buffer.byteLength(JSON.stringify(result)) <= 18_000);
    assert.equal(result.results, undefined);
    assert.equal(result.resultPreview, undefined);
    assert.match(String(result.message), /incomplete/i);
    assert.match(String(result.message), /not.found/i);
    assert.match(String(result.message), /narrower read-only/i);
    assert.ok(!JSON.stringify(result).includes('Earlier unrelated page'));
    const small = { results: [{ title: 'Synthetic page' }], has_more: true, next_cursor: 'next' };
    f.session.execute = async () => small;
    assert.deepEqual(
      await f.service.execute('local-development', 'NOTION_SEARCH_NOTION_PAGE', args),
      small,
    );
    const schema = {
      description: 'x'.repeat(18_000),
      parameters: {
        type: 'object',
        properties: { query: { type: 'string' } },
        required: ['query'],
      },
    };
    let searches = 0;
    f.session.search = async () => {
      searches += 1;
      return { tools: { NOTION_SEARCH_NOTION_PAGE: schema }, suggestions: [] };
    };
    const discovered = (await f.service.execute('local-development', 'SEARCH_TOOLS', {
      query: 'Search Notion pages',
    })) as Record<string, unknown>;
    assert.equal(searches, 1);
    assert.ok(Buffer.byteLength(JSON.stringify(schema)) > 18_000);
    assert.deepEqual(discovered.tools, { NOTION_SEARCH_NOTION_PAGE: schema });
    assert.deepEqual(discovered.suggestions, []);
    assert.equal(discovered.truncated, undefined);
    assert.equal(discovered.resultOmitted, undefined);
  },
);

test(
  'Slack and Notion preserve owned accounts, reviewed reads, exact write approvals and signed event boundaries',
  { skip: !process.env.TEST_DATABASE_URL },
  async (t) => {
    const f = await fixture(t);
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
  'Apps preserves existing accounts while replacing five-service sessions and reports actual subscription capability',
  { skip: !process.env.TEST_DATABASE_URL },
  async (t) => {
    const f = await fixture(t);
    f.accounts.set('existing-gmail', 'gmail');
    await f.pool.query(
      "INSERT INTO app_connections(owner_id,slug,account_id,provider_id) VALUES('local-development','gmail','existing-gmail','fixture')",
    );
    await f.pool.query(
      "INSERT INTO integration_sessions(owner_id,session_id,provider_id,configuration_version) VALUES('local-development','old-five-services','fixture',2)",
    );
    await f.service.execute('local-development', 'GMAIL_LIST_LABELS', {});
    assert.deepEqual(f.sessions, [{ gmail: ['existing-gmail'] }]);
    assert.ok(f.removed.includes('old-five-services'));
    assert.equal(
      (await f.pool.query('SELECT configuration_version FROM integration_sessions')).rows[0]
        .configuration_version,
      3,
    );
    f.provider.webhooksConfigured = false;
    const slack = await f.connect('slack');
    assert.equal(slack.triggersEnabled, true);
    assert.equal(slack.triggersActive, false);
    assert.equal(slack.triggerStatus, 'unavailable');
    assert.equal(f.subscriptions.length, 0);
    f.provider.webhooksConfigured = true;
    f.provider.subscribe = async () => {
      throw new Error('Provider ingress missing');
    };
    await f.service.syncWatches();
    assert.equal(
      (await f.service.list()).find((item) => item.connectionId === slack.connectionId)
        ?.triggerStatus,
      'pending',
    );
    f.provider.supportedServices = ['gmail'];
    assert.equal(
      (await f.service.list()).find((item) => item.slug === 'notion')?.status,
      'not_configured',
    );
    assert.equal(
      (await f.app.inject({ method: 'POST', url: '/api/apps/notion/connect' })).statusCode,
      503,
    );
    assert.equal(
      (await f.pool.query("SELECT * FROM app_connections WHERE account_id='existing-gmail'"))
        .rowCount,
      1,
    );
  },
);

test(
  'attachment retrieval avoids write review and downloads only from the selected current account',
  { skip: !process.env.TEST_DATABASE_URL },
  async (t) => {
    const f = await fixture(t);
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
      message: 'The file could not be downloaded. Check the account and file, then try again.',
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

test(
  'app listing reads connections, discovered apps and browser access at the same time',
  { skip: !process.env.TEST_DATABASE_URL },
  async (t) => {
    const f = await fixture(t);
    const entered: string[] = [];
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const read =
      <T>(name: string, value: T) =>
      async () => {
        entered.push(name);
        await gate;
        return value;
      };
    const service = await createIntegrations(f.pool, {
      ownerId: 'local-development',
      provider: f.provider,
      baseUrl: 'http://localhost:4310',
      wake: async () => {},
      browserAccounts: read('logins', []),
      discovered: { list: read('discovered', []) } as never,
      browserConnections: read('browser', []),
    });
    const listing = service.list();
    for (let attempt = 0; entered.length < 3 && attempt < 100; attempt++)
      await new Promise((resolve) => setTimeout(resolve, 10));
    assert.deepEqual(entered.sort(), ['browser', 'discovered', 'logins']);
    release();
    assert.ok((await listing).length > 0);
  },
);
