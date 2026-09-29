import assert from 'node:assert/strict';
import { randomBytes, randomUUID } from 'node:crypto';
import { createServer, request } from 'node:http';
import { connect as connectTls } from 'node:tls';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AddressInfo } from 'node:net';
import { runInNewContext } from 'node:vm';
import test from 'node:test';
import Fastify from 'fastify';
import pg from 'pg';
import { JSDOM } from 'jsdom';
import { downloadArguments } from '../src/providers/composio/downloads.ts';
import type { IntegrationService } from '../src/ports/integrations.ts';
import { ChannelSetupFailure } from '../src/ports/channel-settings.ts';
import { createChannelSettings } from '../src/server/channel-settings.ts';
import { createFixtureMessagingSetup, fixtureChannelCredentials } from '../scripts/e2e-channels.ts';
import {
  createAuthFixture,
  createFixtureProxy,
  createIntegrationFixture,
  fixtureCredentials,
  fixturePrefix,
} from '../scripts/e2e-fixtures.ts';

test('channel setup fixture accepts only fixed synthetic accounts and never enables message delivery', async () => {
  const setup = createFixtureMessagingSetup();
  assert.deepEqual(
    setup.create({}).channels.map(({ id, status }) => ({ id, status })),
    [
      { id: 'telegram', status: 'disabled' },
      { id: 'whatsapp', status: 'disabled' },
    ],
  );
  const telegram = await setup.verifier.verify('telegram', fixtureChannelCredentials.telegram);
  const whatsapp = await setup.verifier.verify('whatsapp', fixtureChannelCredentials.whatsapp);
  assert.match(telegram.summary.accountName!, /Synthetic.*UI only/);
  assert.equal(telegram.summary.mode, 'polling');
  assert.equal(telegram.summary.accountHandle, '@otto_synthetic_fixture_bot');
  assert.match(whatsapp.summary.accountName!, /Synthetic.*UI only/);
  assert.equal(whatsapp.summary.webhookStatus, 'manual_setup');
  for (const secret of [
    fixtureChannelCredentials.telegram.botToken,
    fixtureChannelCredentials.whatsapp.accessToken,
    fixtureChannelCredentials.whatsapp.appSecret,
    fixtureChannelCredentials.whatsapp.verifyToken,
  ])
    assert.equal(JSON.stringify([telegram.summary, whatsapp.summary]).includes(secret), false);
  for (const input of [
    { ...fixtureChannelCredentials.telegram, botToken: 'not-a-fixture-token' },
    { ...fixtureChannelCredentials.telegram, allowedUserId: '999999999' },
    { ...fixtureChannelCredentials.telegram, webhookUrl: 'https://private.example/callback' },
    { ...fixtureChannelCredentials.telegram, unexpected: true },
  ])
    await assert.rejects(
      setup.verifier.verify('telegram', input),
      (error) => error instanceof ChannelSetupFailure && error.reason === 'invalid_input',
    );
  for (const input of [
    { ...fixtureChannelCredentials.whatsapp, accessToken: 'not-a-fixture-token' },
    { ...fixtureChannelCredentials.whatsapp, allowedNumber: '15555550124' },
    { ...fixtureChannelCredentials.whatsapp, webhookUrl: 'https://private.example/callback' },
    { ...fixtureChannelCredentials.whatsapp, policyConfirmed: false },
  ])
    await assert.rejects(
      setup.verifier.verify('whatsapp', input),
      (error) => error instanceof ChannelSetupFailure && error.reason === 'invalid_input',
    );
  const environment = { ...telegram.environment, ...whatsapp.environment };
  const transport = setup.create(environment);
  assert.equal(transport.pollingEnabled, undefined);
  assert.equal(transport.poll, undefined);
  for (const channel of transport.channels) {
    assert.equal(channel.status, 'configured');
    const response = await transport.receive({
      channelId: channel.id,
      method: 'POST',
      headers: {},
      query: {},
      body: Buffer.from('{"text":"Synthetic inbound message"}'),
    });
    assert.equal(response.status, 404);
    assert.equal(response.messages, undefined);
    await assert.rejects(
      transport.post({
        channelId: channel.id,
        accountId: channel.accountId!,
        threadId: `${channel.id}:synthetic`,
        text: 'Synthetic outbound message',
      }),
      /^Error: Delivery is disabled in this UI fixture\.$/,
    );
  }
  assert.deepEqual(
    setup
      .create({ ...environment, TELEGRAM_ENABLED: 'false' })
      .channels.map(({ status }) => status),
    ['disabled', 'configured'],
  );
  await transport.close();
});

test(
  'synthetic Channels forms persist encrypted configuration, retain it on rejection and disconnect independently',
  { skip: !process.env.TEST_DATABASE_URL },
  async () => {
    const schema = `test_e2e_channels_${randomUUID().replaceAll('-', '')}`;
    const admin = new pg.Pool({ connectionString: process.env.TEST_DATABASE_URL });
    await admin.query(`CREATE SCHEMA ${schema}`);
    const pool = new pg.Pool({
      connectionString: process.env.TEST_DATABASE_URL,
      options: `-c search_path=${schema}`,
    });
    const app = Fastify();
    const fixture = createFixtureMessagingSetup();
    const key = randomBytes(32);
    const settings = await createChannelSettings(pool, {
      ownerId: 'local-development',
      keyStore: { id: 'synthetic', configured: true, getKey: async () => key },
      verifier: fixture.verifier,
      apply: async () => {},
    });
    settings.registerRoutes(app);
    try {
      assert.deepEqual((await app.inject('/api/channel-settings')).json().channels, []);
      for (const provider of ['telegram', 'whatsapp'] as const) {
        const response = await app.inject({
          method: 'PUT',
          url: `/api/channel-settings/${provider}`,
          payload: fixtureChannelCredentials[provider],
        });
        assert.equal(response.statusCode, 200);
        assert.match(response.json().channel.accountName, /Synthetic.*UI only/);
      }
      const raw = JSON.stringify((await pool.query('SELECT * FROM channel_settings')).rows);
      for (const token of [
        fixtureChannelCredentials.telegram.botToken,
        fixtureChannelCredentials.whatsapp.accessToken,
        fixtureChannelCredentials.whatsapp.appSecret,
        fixtureChannelCredentials.whatsapp.verifyToken,
      ])
        assert.equal(raw.includes(token), false);
      assert.deepEqual(
        fixture.create(await settings.environment()).channels.map(({ status }) => status),
        ['configured', 'configured'],
      );
      const rejected = await app.inject({
        method: 'PUT',
        url: '/api/channel-settings/telegram',
        payload: { ...fixtureChannelCredentials.telegram, botToken: 'arbitrary-token' },
      });
      assert.equal(rejected.statusCode, 400);
      assert.equal(rejected.body.includes('arbitrary-token'), false);
      assert.equal((await settings.environment()).TELEGRAM_ENABLED, 'true');
      assert.equal(
        (await app.inject({ method: 'DELETE', url: '/api/channel-settings/telegram' })).statusCode,
        200,
      );
      assert.deepEqual(
        fixture.create(await settings.environment()).channels.map(({ status }) => status),
        ['disabled', 'configured'],
      );
    } finally {
      await app.close();
      await pool.end();
      await admin.query(`DROP SCHEMA ${schema} CASCADE`);
      await admin.end();
    }
  },
);

test('synthetic authentication requires the password and OTP, expires no secrets into audit', async () => {
  const audit: unknown[] = [];
  const server = createServer(createAuthFixture((kind, fields) => audit.push({ kind, ...fields })));
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  try {
    const login = await fetch(origin + fixturePrefix + 'login');
    assert.match(await login.text(), /autocomplete="current-password"/);
    const wrong = await fetch(origin + fixturePrefix + 'password', {
      method: 'POST',
      body: new URLSearchParams({ username: fixtureCredentials.username, password: 'wrong' }),
    });
    assert.match(await wrong.text(), /incorrect/);
    assert.equal(wrong.headers.get('set-cookie'), null);
    const password = await fetch(origin + fixturePrefix + 'password', {
      method: 'POST',
      body: new URLSearchParams({
        username: fixtureCredentials.username,
        password: fixtureCredentials.password,
      }),
    });
    assert.match(await password.text(), /one-time-code/);
    const cookie = password.headers.get('set-cookie')!.split(';')[0];
    assert.match(password.headers.get('set-cookie')!, /HttpOnly; Secure; SameSite=Lax/);
    const rejected = await fetch(origin + fixturePrefix + 'otp', {
      method: 'POST',
      headers: { cookie },
      body: new URLSearchParams({ code: '000000' }),
    });
    assert.match(await rejected.text(), /incorrect/);
    const otp = await fetch(origin + fixturePrefix + 'otp', {
      method: 'POST',
      headers: { cookie },
      body: new URLSearchParams({ code: fixtureCredentials.code }),
      redirect: 'manual',
    });
    assert.equal(otp.status, 303);
    const portal = await fetch(origin + fixturePrefix + 'portal', { headers: { cookie } });
    assert.match(await portal.text(), /NS-1042/);
    const unauthenticated = await fetch(origin + fixturePrefix + 'portal');
    assert.doesNotMatch(await unauthenticated.text(), /NS-1042/);
    for (const secret of Object.values(fixtureCredentials))
      assert.ok(!JSON.stringify(audit).includes(secret));
    assert.deepEqual(
      audit.map((event) => (event as { kind: string }).kind),
      [
        'fixture_password_submit',
        'fixture_password_submit',
        'fixture_otp_submit',
        'fixture_otp_submit',
        'fixture_portal_view',
      ],
    );
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});

test('staged sign-in fixture requires identifier, password and OTP in separate forms', async () => {
  const audit: unknown[] = [];
  const server = createServer(createAuthFixture((kind, fields) => audit.push({ kind, ...fields })));
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}${fixturePrefix}`;
  try {
    const initial = await (await fetch(origin + 'staged-login')).text();
    assert.match(initial, /Continue with Google/);
    assert.match(initial, /Continue with Apple/);
    assert.match(initial, /autocomplete="username"/);
    assert.doesNotMatch(initial, /type="password"/);
    const identifier = await fetch(origin + 'identifier', {
      method: 'POST',
      body: new URLSearchParams({ username: fixtureCredentials.username }),
    });
    const passwordPage = await identifier.text();
    assert.match(passwordPage, /autocomplete="current-password"/);
    assert.doesNotMatch(passwordPage, /autocomplete="username"/);
    const cookie = identifier.headers.get('set-cookie')!.split(';')[0];
    const password = await fetch(origin + 'password', {
      method: 'POST',
      headers: { cookie },
      body: new URLSearchParams({ password: fixtureCredentials.password }),
    });
    assert.match(await password.text(), /one-time-code/);
    const verifiedCookie = password.headers.get('set-cookie')!.split(';')[0];
    const verified = await fetch(origin + 'otp', {
      method: 'POST',
      headers: { cookie: verifiedCookie },
      body: new URLSearchParams({ code: fixtureCredentials.code }),
      redirect: 'manual',
    });
    assert.equal(verified.status, 303);
    const portal = await fetch(origin + 'portal', { headers: { cookie: verifiedCookie } });
    assert.match(await portal.text(), /NS-1043/);
    for (const secret of Object.values(fixtureCredentials))
      assert.ok(!JSON.stringify(audit).includes(secret));
    assert.deepEqual(audit, [
      { kind: 'fixture_identifier_submit', accepted: true },
      { kind: 'fixture_password_submit', accepted: true },
      { kind: 'fixture_otp_submit', accepted: true },
      { kind: 'fixture_portal_view' },
    ]);
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});

test('test proxy pins one synthetic HTTPS host and forwards other CONNECT requests to the public guard', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'otto-e2e-proxy-test-'));
  const forwarded: string[] = [];
  const guard = createServer();
  guard.on('connect', (request, socket) => {
    forwarded.push(request.url!);
    socket.end('HTTP/1.1 403 Forbidden\r\n\r\n');
  });
  await new Promise<void>((resolve) => guard.listen(0, '127.0.0.1', resolve));
  let launch: string[] = [];
  const proxy = await createFixtureProxy(directory, undefined, async (_command, args) => {
    launch = args;
    return { stdout: '', stderr: '', exitCode: 0 };
  });
  try {
    await proxy.run(
      'fixture',
      [
        '--proxy',
        `http://127.0.0.1:${(guard.address() as AddressInfo).port}`,
        '--args',
        '--disable-quic',
      ],
      {},
    );
    assert.equal(launch[1], proxy.proxyUrl);
    assert.match(launch[3], /--ignore-certificate-errors-spki-list=[A-Za-z0-9+/]+=*/);
    assert.ok(!launch.includes('--ignore-certificate-errors'));
    const native = proxy.nativeArgs([
      '--user-data-dir=/synthetic-profile',
      `--proxy-server=http://127.0.0.1:${(guard.address() as AddressInfo).port}`,
      'https://example.com/__otto_e2e__/login',
    ]);
    assert.equal(native[1], `--proxy-server=${proxy.proxyUrl}`);
    assert.match(native[2], /^--ignore-certificate-errors-spki-list=/);
    assert.equal(native.at(-1), 'https://example.com/__otto_e2e__/login');
    assert.throws(() => proxy.nativeArgs(['https://example.com']), /proxy was missing/);
    assert.throws(
      () => proxy.nativeArgs(['--proxy-server=https://example.com', 'https://example.com']),
      /loopback guard/,
    );

    const page = await new Promise<string>((resolve, reject) => {
      const tunnel = request(proxy.proxyUrl, { method: 'CONNECT', path: 'example.com:443' });
      tunnel.on('error', reject);
      tunnel.on('connect', (response, socket) => {
        assert.equal(response.statusCode, 200);
        const secure = connectTls({ socket, servername: 'example.com', ca: proxy.certificate });
        const parts: Buffer[] = [];
        secure.on('error', reject);
        secure.on('data', (chunk) => parts.push(chunk));
        secure.on('end', () => resolve(Buffer.concat(parts).toString('utf8')));
        secure.on('secureConnect', () =>
          secure.write(
            `GET ${fixturePrefix}login HTTP/1.1\r\nHost: example.com\r\nConnection: close\r\n\r\n`,
          ),
        );
      });
      tunnel.end();
    });
    assert.match(page, /Northstar demo sign in/);
    await new Promise<void>((resolve, reject) => {
      const tunnel = request(proxy.proxyUrl, { method: 'CONNECT', path: '127.0.0.1:4320' });
      tunnel.on('error', reject);
      tunnel.on('connect', (response, socket) => {
        assert.equal(response.statusCode, 403);
        socket.destroy();
        resolve();
      });
      tunnel.end();
    });
    assert.deepEqual(forwarded, ['127.0.0.1:4320']);
  } finally {
    await proxy.close();
    await new Promise<void>((resolve) => guard.close(() => resolve()));
    await rm(directory, { recursive: true, force: true });
  }
});

test('manual-control fixture verifies submitted input without storing its value', async () => {
  const audit: unknown[] = [];
  const server = createServer(createAuthFixture((kind, fields) => audit.push({ kind, ...fields })));
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}${fixturePrefix}manual`;
  try {
    assert.match(await (await fetch(url)).text(), /Test note/);
    for (const note of ['wrong', 'Hello Northstar']) {
      const response = await fetch(url, { method: 'POST', body: new URLSearchParams({ note }) });
      assert.equal((await response.text()).includes('MANUAL-741'), note === 'Hello Northstar');
    }
    assert.deepEqual(audit, [
      { kind: 'fixture_manual_submit', accepted: false },
      { kind: 'fixture_manual_submit', accepted: true },
    ]);
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});

test('synthetic app consent preserves callback state, verified account ownership and account-scoped execution', async () => {
  const app = Fastify();
  const fixture = createIntegrationFixture('http://localhost:4320');
  const session = await fixture.provider.createSession('owner-a', {});
  fixture.register(app);
  app.post('/connect', async () =>
    session.authorize('gmail', 'http://localhost:4320/api/apps/callback?state=nonce-original'),
  );
  try {
    const result = (await app.inject({ method: 'POST', url: '/connect' })).json();
    assert.match(result.url, /^http:\/\/localhost:4320\/e2e\/connect\/[a-f0-9-]+$/);
    assert.equal(
      (await fixture.provider.inspectAccount(result.accountId, 'owner-a')).active,
      false,
    );
    await assert.rejects(
      () => session.execute('GMAIL_LIST_LABELS', {}, result.accountId),
      /Connect/,
    );
    const connected = await app.inject({ method: 'POST', url: new URL(result.url).pathname });
    const callback = new URL(connected.headers.location!);
    assert.equal(callback.searchParams.get('state'), 'nonce-original');
    assert.equal(callback.searchParams.get('account_ref'), result.accountId);
    assert.equal(
      (await fixture.provider.inspectAccount(result.accountId, 'owner-a')).accountEmail,
      'tester1@example.test',
    );
    assert.equal(
      (await fixture.provider.inspectAccount(result.accountId, 'owner-b')).active,
      false,
    );
    assert.match(
      JSON.stringify(await session.execute('GMAIL_LIST_LABELS', {}, result.accountId)),
      /Review account 1/,
    );
    const otherSession = await fixture.provider.createSession('owner-b', {});
    await assert.rejects(
      () => otherSession.execute('GMAIL_LIST_LABELS', {}, result.accountId),
      /Connect/,
    );
    assert.equal(fixture.writes.length, 0);
    await session.execute('GMAIL_SEND_EMAIL', {}, result.accountId);
    assert.equal(fixture.writes.length, 1);
    assert.equal(fixture.writes[0].accountId, result.accountId);
  } finally {
    await app.close();
  }
});

test('synthetic spending Sheet returns fixed rows and stays read-only', async (t) => {
  const app = Fastify();
  const fixture = createIntegrationFixture('http://localhost:4320');
  fixture.register(app);
  const session = await fixture.provider.createSession('owner-a', {});
  const account = await session.authorize(
    'googlesheets',
    'http://localhost:4320/api/apps/callback',
  );
  try {
    await app.inject({ method: 'POST', url: `/e2e/connect/${account.accountId}` });
    const listed = (await session.execute(
      'GOOGLESHEETS_SEARCH_SPREADSHEETS',
      { query: 'September spending' },
      account.accountId,
    )) as {
      spreadsheets: Array<{ id: string; name: string; webViewLink: string }>;
    };
    assert.equal(listed.spreadsheets[0].name, 'September spending test');
    assert.match(listed.spreadsheets[0].webViewLink, /otto-e2e-spending-2026-09/);
    const info = (await session.execute(
      'GOOGLESHEETS_GET_SPREADSHEET_INFO',
      { spreadsheet_id: listed.spreadsheets[0].id },
      account.accountId,
    )) as {
      properties: { title: string };
      sheets: Array<{ properties: { title: string } }>;
    };
    assert.equal(info.properties.title, 'September spending test');
    assert.deepEqual(
      info.sheets.map((sheet) => sheet.properties.title),
      ['Spending', 'Budget'],
    );
    const read = async (range: string, spreadsheetId = listed.spreadsheets[0].id) =>
      (await session.execute(
        'GOOGLESHEETS_BATCH_GET',
        { spreadsheet_id: spreadsheetId, ranges: [range] },
        account.accountId,
      )) as {
        valueRanges: Array<{ values: string[][] }>;
      };
    assert.deepEqual(
      (await read('Spending!A1:E20')).valueRanges[0].values.slice(1).map((row) => row[3]),
      ['32.50', '17.50', '125.00', '20.00', '20.00'],
    );
    assert.deepEqual(
      (await read('Budget!A1:B20')).valueRanges[0].values.slice(1).map((row) => row[1]),
      ['200.00', '100.00', '60.00'],
    );
    assert.deepEqual((await read('Spending!B2:D3')).valueRanges[0].values, [
      ['Food', 'Grocer One', '32.50'],
      ['Food', 'Grocer Two', '17.50'],
    ]);
    assert.deepEqual((await read('Budget!B2:B3')).valueRanges[0].values, [['200.00'], ['100.00']]);
    await assert.rejects(read('Spending!D3:B2'), /invalid/);
    await assert.rejects(read('Unknown!A1:B20'), /not found/);
    await t.test('cell ranges return only the requested rows and columns', async () => {
      assert.deepEqual((await read('Spending!A2')).valueRanges[0].values, [['2026-09-28']]);
      assert.deepEqual((await read("'Spending'!$C$3:$D$4")).valueRanges[0].values, [
        ['Grocer Two', '17.50'],
        ['Rail Pass', '125.00'],
      ]);
      assert.deepEqual((await read('Budget!b3:c20')).valueRanges[0].values, [
        ['100.00'],
        ['60.00'],
      ]);
      for (const range of ['Spending!A100:E100', 'Spending!Z1:ZZ3'])
        assert.deepEqual((await read(range)).valueRanges[0].values, []);
      for (const range of ['Spending!invalid', 'Spending!A0:E2', 'Spending!C4:A2', 'Spending!A1:E'])
        await assert.rejects(read(range), /range/);
      await assert.rejects(
        session.execute(
          'GOOGLESHEETS_BATCH_GET',
          { spreadsheet_id: listed.spreadsheets[0].id, ranges: 'Spending!A1' },
          account.accountId,
        ),
        /range/,
      );
    });
    await t.test(
      'only the exact spreadsheet ID or its Google Sheets URL identifies the fixture',
      async () => {
        const url = listed.spreadsheets[0].webViewLink;
        const fromUrl = (await session.execute(
          'GOOGLESHEETS_GET_SPREADSHEET_INFO',
          { spreadsheet_id: url },
          account.accountId,
        )) as { spreadsheetId: string };
        assert.equal(fromUrl.spreadsheetId, listed.spreadsheets[0].id);
        for (const id of [
          `unrelated-${listed.spreadsheets[0].id}-suffix`,
          `${listed.spreadsheets[0].id}-suffix`,
          url.replace('docs.google.com', 'evil.example'),
          url.replace('https:', 'http:'),
          url.replace('docs.google.com', 'user:password@docs.google.com'),
          `${url}/unrelated`,
        ])
          for (const action of ['GOOGLESHEETS_GET_SPREADSHEET_INFO', 'GOOGLESHEETS_BATCH_GET'])
            await assert.rejects(
              session.execute(
                action,
                { spreadsheet_id: id, ranges: ['Budget!A1:B20'] },
                account.accountId,
              ),
              /not found/,
            );
        assert.deepEqual(
          (await read('Budget!B2', `${url}?usp=sharing#gid=1`)).valueRanges[0].values,
          [['200.00']],
        );
      },
    );
    assert.equal(fixture.writes.length, 0);
  } finally {
    await app.close();
  }
});

test('synthetic Drive CSV gives the same spending totals without a Sheets read', async () => {
  const app = Fastify();
  const audit: Array<{ kind: string; fields: Record<string, unknown> }> = [];
  const fixture = createIntegrationFixture('http://localhost:4320', (kind, fields) => {
    audit.push({ kind, fields: fields ?? {} });
  });
  fixture.register(app);
  const session = await fixture.provider.createSession('owner-a', {});
  const account = await session.authorize('googledrive', 'http://localhost:4320/api/apps/callback');
  try {
    await app.inject({ method: 'POST', url: `/e2e/connect/${account.accountId}` });
    const found = (await session.execute(
      'GOOGLEDRIVE_FIND_FILE',
      { query: 'September spending export.csv' },
      account.accountId,
    )) as { files: Array<{ id: string; name: string }> };
    assert.equal(found.files[0].name, 'September spending export.csv');
    const args = { fileId: found.files[0].id };
    assert.deepEqual(downloadArguments('GOOGLEDRIVE_DOWNLOAD_FILE', args), args);
    const file = await session.download!('GOOGLEDRIVE_DOWNLOAD_FILE', args, account.accountId);
    const rows = Buffer.from(file.bytes)
      .toString('utf8')
      .split('\n')
      .slice(1)
      .map((line) => line.split(','));
    assert.deepEqual(
      rows.map((row) => [row[1], row[3], row[4]]),
      [
        ['Food', '32.50', '200.00'],
        ['Food', '17.50', '200.00'],
        ['Transport', '125.00', '100.00'],
        ['Software', '20.00', '60.00'],
        ['Software', '20.00', '60.00'],
      ],
    );
    assert.equal(file.name, 'September spending export.csv');
    assert.equal(file.mimeType, 'text/csv');
    assert.equal(
      audit.some((item) => item.kind === 'fixture_integration_download'),
      true,
    );
    assert.equal(fixture.writes.length, 0);
    assert.equal(
      audit
        .filter((item) => item.kind === 'fixture_integration_execute')
        .some((item) => String(item.fields.action).startsWith('GOOGLESHEETS_')),
      false,
    );
  } finally {
    await app.close();
  }
});

test('synthetic Gmail drafts remain unsent and destructive operations stay bound to observed account records', async () => {
  const app = Fastify();
  const audit: unknown[] = [];
  const fixture = createIntegrationFixture('http://localhost:4320', (kind, fields) =>
    audit.push({ kind, ...fields }),
  );
  fixture.register(app);
  const session = await fixture.provider.createSession('owner-a', {});
  async function connect() {
    const result = await session.authorize('gmail', 'http://localhost:4320/api/apps/callback');
    assert.equal(
      (await app.inject({ method: 'POST', url: `/e2e/connect/${result.accountId}` })).statusCode,
      302,
    );
    return result.accountId;
  }
  try {
    const first = await connect();
    const second = await connect();
    const tools = (
      await session.search(
        'Create an email draft, list drafts, read a draft and permanently delete an email',
      )
    ).tools as Array<{ name: string; parameters: { required?: string[] } }>;
    assert.deepEqual(
      tools.find((tool) => tool.name === 'GMAIL_CREATE_EMAIL_DRAFT')?.parameters.required,
      ['recipient_email', 'subject', 'body'],
    );
    assert.deepEqual(
      tools.find((tool) => tool.name === 'GMAIL_DELETE_MESSAGE')?.parameters.required,
      ['message_id'],
    );
    assert.ok(tools.some((tool) => tool.name === 'GMAIL_LIST_DRAFTS'));
    assert.ok(tools.some((tool) => tool.name === 'GMAIL_GET_DRAFT'));
    const args = {
      recipient_email: 'draft-recipient@example.test',
      subject: 'Synthetic draft review',
      body: 'Synthetic unsent draft content.',
    };
    for (const invalid of [
      { ...args, body: '' },
      { ...args, body: 'x'.repeat(12001) },
      { ...args, recipient_email: 'invalid' },
      { ...args, user_id: 'another' },
      { ...args, url: 'https://unrelated.example.test' },
    ])
      await assert.rejects(
        session.execute('GMAIL_CREATE_EMAIL_DRAFT', invalid, first),
        /invalid|selected synthetic/,
      );
    assert.equal(fixture.writes.length, 0);
    const draft = (await session.execute('GMAIL_CREATE_EMAIL_DRAFT', args, first)) as {
      id: string;
      message: { id: string; to: string; subject: string; body: string; labelIds: string[] };
      deliveredExternally: boolean;
    };
    assert.equal(draft.deliveredExternally, false);
    assert.deepEqual(draft.message.labelIds, ['DRAFT']);
    assert.equal(draft.message.body, args.body);
    assert.deepEqual(
      fixture.writes.map((item) => item.action),
      ['GMAIL_CREATE_EMAIL_DRAFT'],
    );
    assert.deepEqual(
      ((await session.execute('GMAIL_LIST_DRAFTS', {}, first)) as { drafts: unknown[] }).drafts,
      [{ id: draft.id, message: draft.message }],
    );
    assert.deepEqual(
      ((await session.execute('GMAIL_LIST_DRAFTS', {}, second)) as { drafts: unknown[] }).drafts,
      [],
    );
    assert.deepEqual(
      (
        (await session.execute('GMAIL_GET_DRAFT', { draft_id: draft.id }, first)) as {
          message: unknown;
        }
      ).message,
      draft.message,
    );
    await assert.rejects(
      session.execute('GMAIL_GET_DRAFT', { draft_id: draft.id }, second),
      /not found/,
    );
    for (const [accountId, messageId] of [
      [first, draft.id],
      [second, draft.message.id],
      [first, 'unknown-message'],
    ])
      await assert.rejects(
        session.execute('GMAIL_DELETE_MESSAGE', { message_id: messageId }, accountId),
        /not found/,
      );
    const foreign = await fixture.provider.createSession('owner-b', {});
    await assert.rejects(
      foreign.execute('GMAIL_DELETE_MESSAGE', { message_id: draft.message.id }, first),
      /Connect/,
    );
    assert.equal(fixture.writes.length, 1);
    const sent = (await session.execute('GMAIL_SEND_EMAIL', args, first)) as {
      deliveredExternally: boolean;
    };
    assert.equal(sent.deliveredExternally, false);
    const removed = (await session.execute(
      'GMAIL_DELETE_MESSAGE',
      { message_id: draft.message.id },
      first,
    )) as { deleted: boolean };
    assert.equal(removed.deleted, true);
    assert.deepEqual(
      ((await session.execute('GMAIL_LIST_DRAFTS', {}, first)) as { drafts: unknown[] }).drafts,
      [],
    );
    await assert.rejects(
      session.execute('GMAIL_GET_DRAFT', { draft_id: draft.id }, first),
      /not found/,
    );
    await assert.rejects(
      session.execute('GMAIL_DELETE_MESSAGE', { message_id: draft.message.id }, first),
      /not found/,
    );
    assert.deepEqual(
      fixture.writes.map((item) => ({ action: item.action, accountId: item.accountId })),
      [
        { action: 'GMAIL_CREATE_EMAIL_DRAFT', accountId: first },
        { action: 'GMAIL_SEND_EMAIL', accountId: first },
        { action: 'GMAIL_DELETE_MESSAGE', accountId: first },
      ],
    );
    for (const value of Object.values(args))
      assert.equal(JSON.stringify(audit).includes(value), false);
    const messageId = 'fixture-sent-1-newest';
    await session.execute('GMAIL_DELETE_MESSAGE', { message_id: messageId }, first);
    assert.equal(
      (
        (await session.execute('GMAIL_FETCH_EMAILS', { query: 'in:sent' }, first)) as {
          messages: unknown[];
        }
      ).messages.length,
      1,
    );
    assert.equal(
      (
        (await session.execute('GMAIL_FETCH_EMAILS', { query: 'in:sent' }, second)) as {
          messages: unknown[];
        }
      ).messages.length,
      2,
    );
    await assert.rejects(
      session.download!(
        'GMAIL_GET_ATTACHMENT',
        {
          message_id: messageId,
          attachment_id: 'fixture-attachment-1-2048',
          file_name: 'northstar-review-2048.csv',
        },
        first,
      ),
      /does not match/,
    );
  } finally {
    await app.close();
  }
});

test('synthetic consent submits a nonempty form once, follows the verified callback and shows fixed retry errors', async () => {
  const origin = 'http://localhost:4320';
  const app = Fastify();
  const audit: unknown[] = [];
  const requests: Array<{ url: string; body: string; credentials: string }> = [];
  const navigations: string[] = [];
  const fixture = createIntegrationFixture(origin, (kind, fields) =>
    audit.push({ kind, ...fields }),
  );
  const session = await fixture.provider.createSession('synthetic-owner', {});
  fixture.register(app);
  app.addContentTypeParser(
    'application/x-www-form-urlencoded',
    { parseAs: 'string' },
    (_request, body, done) => done(null, new URLSearchParams(String(body))),
  );
  app.get('/api/apps/callback', async (request, reply) => {
    const callback = await fixture.provider.parseCallback(request.query);
    assert.equal(callback.state, 'synthetic-nonce');
    assert.equal(callback.success, true);
    assert.equal(
      (await fixture.provider.inspectAccount(callback.accountId, 'synthetic-owner')).active,
      true,
    );
    return reply.redirect('/apps');
  });
  app.get('/apps', async () => 'Connected synthetic accounts');
  const authorization = await session.authorize(
    'gmail',
    `${origin}/api/apps/callback?state=synthetic-nonce`,
  );
  const pageUrl = `${origin}/e2e/connect/${authorization.accountId}`;
  const page = await app.inject({ method: 'GET', url: new URL(pageUrl).pathname });
  const dom = new JSDOM(page.body, { url: pageUrl });
  let release!: () => void;
  const held = new Promise<void>((resolve) => {
    release = resolve;
  });
  let attempt = 0;
  const fetchFixture = async (url: string, options: RequestInit) => {
    requests.push({
      url,
      body: String(options.body),
      credentials: String(options.credentials),
    });
    if (++attempt === 1) {
      await held;
      throw new Error('Synthetic private failure detail');
    }
    let current = new URL(url);
    let response = await app.inject({
      method: 'POST',
      url: current.pathname,
      headers: options.headers as Record<string, string>,
      payload: String(options.body),
    });
    assert.equal(response.statusCode, 302);
    for (let redirects = 0; response.headers.location && redirects < 3; redirects++) {
      current = new URL(response.headers.location, current);
      assert.equal(current.origin, origin);
      response = await app.inject({ method: 'GET', url: current.pathname + current.search });
    }
    return { ok: response.statusCode === 200, url: current.href };
  };
  try {
    runInNewContext(dom.window.document.querySelector('script')!.textContent!, {
      document: dom.window.document,
      fetch: fetchFixture,
      URL,
      URLSearchParams,
      location: { href: pageUrl, origin, assign: (url: string) => navigations.push(url) },
    });
    const form = dom.window.document.querySelector('form')!;
    const button = form.querySelector('button')!;
    const error = dom.window.document.querySelector<HTMLElement>('[role="alert"]')!;
    button.click();
    assert.equal(button.disabled, true);
    assert.equal(error.hidden, true);
    form.dispatchEvent(new dom.window.Event('submit', { bubbles: true, cancelable: true }));
    assert.equal(requests.length, 1);
    assert.equal(requests[0].body, 'consent=connect');
    assert.equal(requests[0].credentials, 'same-origin');
    assert.equal(requests[0].url, pageUrl);
    release();
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(button.disabled, false);
    assert.equal(error.hidden, false);
    assert.equal(error.textContent, 'Could not connect the synthetic account. Try again.');
    assert.equal(dom.window.document.body.textContent?.includes('private failure detail'), false);
    assert.equal(navigations.length, 0);
    assert.equal(audit.length, 0);
    button.click();
    for (let tick = 0; button.disabled && tick < 50; tick++)
      await new Promise((resolve) => setImmediate(resolve));
    assert.equal(requests.length, 2);
    assert.deepEqual(navigations, [`${origin}/apps`]);
    assert.equal(error.hidden, true);
    assert.equal(audit.length, 1);
    assert.doesNotMatch(JSON.stringify(audit), /synthetic-nonce|private failure detail/);
  } finally {
    release();
    dom.window.close();
    await app.close();
  }
});

test('synthetic consent retains popup completion parameters and rejects unexpected destinations', async () => {
  const origin = 'http://localhost:4320';
  const app = Fastify();
  const fixture = createIntegrationFixture(origin);
  fixture.register(app);
  const session = await fixture.provider.createSession('synthetic-owner', {});
  const nonce = randomBytes(32).toString('base64url');
  const account = await session.authorize(
    'googlesheets',
    `${origin}/api/apps/callback?state=${nonce}`,
  );
  const pageUrl = `${origin}/e2e/connect/${account.accountId}`;
  const page = await app.inject({ method: 'GET', url: new URL(pageUrl).pathname });
  try {
    for (const [destination, accepted] of [
      [`${origin}/apps?connection=connected`, true],
      [`${origin}/?connection=continued&service=googlesheets`, true],
      [`${origin}/onboarding?connection=connected`, true],
      [`${origin}/connected.html?connection=connected&service=googlesheets&attempt=${nonce}`, true],
      [`https://evil.example/connected.html?attempt=${nonce}`, false],
      [`${origin}/connected.html/other?attempt=${nonce}`, false],
      [`${origin}/api/apps/callback?state=${nonce}`, false],
    ] as const) {
      const dom = new JSDOM(page.body, { url: pageUrl });
      const navigations: string[] = [];
      try {
        runInNewContext(dom.window.document.querySelector('script')!.textContent!, {
          document: dom.window.document,
          fetch: async () => ({ ok: true, url: destination }),
          URL,
          URLSearchParams,
          location: { href: pageUrl, origin, assign: (url: string) => navigations.push(url) },
        });
        const button = dom.window.document.querySelector('button')!;
        button.click();
        for (let tick = 0; button.disabled && tick < 20; tick++)
          await new Promise((resolve) => setImmediate(resolve));
        assert.equal(button.disabled, false);
        assert.deepEqual(navigations, accepted ? [destination] : [], destination);
        assert.equal(
          dom.window.document.querySelector<HTMLElement>('[role="alert"]')!.hidden,
          accepted,
        );
      } finally {
        dom.window.close();
      }
    }
  } finally {
    await app.close();
  }
});

test('synthetic sent mail exposes observed file references and downloads only the matching owned attachment', async () => {
  const app = Fastify();
  const audit: Array<{ kind: string } & Record<string, unknown>> = [];
  const fixture = createIntegrationFixture('http://localhost:4320', (kind, fields) =>
    audit.push({ kind, ...fields }),
  );
  const session = await fixture.provider.createSession('owner-a', {});
  fixture.register(app);
  const connect = async (service: IntegrationService) => {
    const account = await session.authorize(service, 'http://localhost:4320/api/apps/callback');
    const response = await app.inject({ method: 'POST', url: `/e2e/connect/${account.accountId}` });
    assert.equal(response.statusCode, 302);
    return account.accountId;
  };
  try {
    const first = await connect('gmail');
    const second = await connect('gmail');
    const tools = (await session.search('Gmail sent email attachment')).tools as Array<{
      name: string;
      parameters: { required?: string[] };
    }>;
    assert.deepEqual(
      tools.find((tool) => tool.name === 'GMAIL_GET_ATTACHMENT')?.parameters.required,
      ['message_id', 'attachment_id', 'file_name'],
    );
    type Email = {
      emailId: string;
      date: string;
      subject: string;
      attachments: Array<{
        attachmentId: string;
        filename: string;
        mimeType: string;
      }>;
    };
    const sent = (await session.execute(
      'GMAIL_FETCH_EMAILS',
      { query: 'in:sent', max_results: 2 },
      first,
    )) as { messages: Email[] };
    assert.equal(sent.messages.length, 2);
    assert.ok(new Date(sent.messages[0].date) > new Date(sent.messages[1].date));
    assert.match(sent.messages[0].subject, /NS-2048/);
    const limited = (await session.execute(
      'GMAIL_FETCH_EMAILS',
      { label_ids: ['SENT'], max_results: 1 },
      first,
    )) as { messages: Email[] };
    assert.deepEqual(limited.messages, sent.messages.slice(0, 1));
    const message = sent.messages[0];
    const attachment = message.attachments[0];
    const fetched = (await session.execute(
      'GMAIL_FETCH_MESSAGE_BY_MESSAGE_ID',
      { message_id: message.emailId },
      first,
    )) as { message: Email };
    assert.deepEqual(fetched.message, message);
    const args = {
      message_id: message.emailId,
      attachment_id: attachment.attachmentId,
      file_name: attachment.filename,
      user_id: 'me',
    };
    const file = await session.download!('GMAIL_GET_ATTACHMENT', args, first);
    assert.equal(file.name, attachment.filename);
    assert.equal(file.mimeType, 'text/csv');
    assert.equal(
      Buffer.from(file.bytes).toString(),
      'invoice,status,amount_eur\nNS-2048,Reviewed,360.00\n',
    );
    assert.equal(fixture.writes.length, 0);
    for (const invalid of [
      { ...args, message_id: sent.messages[1].emailId },
      { ...args, attachment_id: 'foreign-attachment' },
      { ...args, file_name: '../private.csv' },
      { ...args, user_id: 'other-user' },
      { ...args, url: 'https://private.example.test/file' },
    ])
      await assert.rejects(
        session.download!('GMAIL_GET_ATTACHMENT', invalid, first),
        /does not match/,
      );
    await assert.rejects(session.download!('GMAIL_GET_ATTACHMENT', args, second), /does not match/);
    await assert.rejects(session.download!('GOOGLEDRIVE_DOWNLOAD_FILE', args, first), /not found/);
    const foreign = await fixture.provider.createSession('owner-b', {});
    await assert.rejects(foreign.download!('GMAIL_GET_ATTACHMENT', args, first), /Connect/);
    const inactive = await session.authorize('gmail', 'http://localhost:4320/api/apps/callback');
    await assert.rejects(
      session.download!('GMAIL_GET_ATTACHMENT', args, inactive.accountId),
      /Connect/,
    );
    const cancelled = new AbortController();
    cancelled.abort();
    await assert.rejects(session.download!('GMAIL_GET_ATTACHMENT', args, first, cancelled.signal), {
      name: 'AbortError',
    });
    const downloads = audit.filter((item) => item.kind === 'fixture_integration_download');
    assert.deepEqual(downloads, [
      {
        kind: 'fixture_integration_download',
        action: 'GMAIL_GET_ATTACHMENT',
        accountId: first,
        size: file.bytes.byteLength,
      },
    ]);
    assert.equal(JSON.stringify(audit).includes(Buffer.from(file.bytes).toString()), false);
    assert.equal(JSON.stringify(audit).includes(Buffer.from(file.bytes).toString('base64')), false);
    assert.equal(JSON.stringify(audit).includes(attachment.filename), false);
    await assert.rejects(
      session.execute(`GMAIL_${fixtureCredentials.password}`, {}, first),
      /not implemented/,
    );
    assert.equal(JSON.stringify(audit).includes(fixtureCredentials.password), false);
    await fixture.provider.deleteAccount(first);
    await assert.rejects(session.download!('GMAIL_GET_ATTACHMENT', args, first), /Connect/);
    const replacement = await connect('gmail');
    const secondMailbox = (await session.execute(
      'GMAIL_FETCH_EMAILS',
      { query: 'in:sent' },
      second,
    )) as { messages: Email[] };
    const replacementMailbox = (await session.execute(
      'GMAIL_FETCH_EMAILS',
      { query: 'in:sent' },
      replacement,
    )) as { messages: Email[] };
    assert.notEqual(secondMailbox.messages[0].emailId, replacementMailbox.messages[0].emailId);
  } finally {
    await app.close();
  }
});

test('synthetic Slack and Notion consent exposes read schemas and keeps service accounts separate', async () => {
  const app = Fastify();
  const fixture = createIntegrationFixture('http://localhost:4320');
  const session = await fixture.provider.createSession('owner-a', {});
  fixture.register(app);
  try {
    assert.ok(fixture.provider.supportedServices?.includes('slack'));
    assert.ok(fixture.provider.supportedServices?.includes('notion'));
    for (const [service, action, expected] of [
      ['slack', 'SLACK_SEARCH_MESSAGES', 'milestone'],
      ['notion', 'NOTION_SEARCH_NOTION_PAGE', 'summary'],
    ] as const) {
      const authorization = await session.authorize(
        service,
        'http://localhost:4320/api/apps/callback',
      );
      const url = `/e2e/connect/${authorization.accountId}`;
      const consent = await app.inject({ method: 'GET', url });
      assert.match(
        consent.body,
        service === 'slack' ? /Connect synthetic Slack/ : /Connect synthetic Notion/,
      );
      assert.doesNotMatch(consent.body, /not Google OAuth/);
      await app.inject({ method: 'POST', url });
      const schemas = (await session.search(`${service} Northstar`)).tools as Array<{
        name: string;
      }>;
      assert.ok(schemas.some((tool) => tool.name === action));
      const result = await session.execute(action, { query: 'Northstar' }, authorization.accountId);
      assert.match(JSON.stringify(result), /NS-2048/);
      assert.ok(JSON.stringify(result).includes(expected));
      await assert.rejects(
        session.execute('GMAIL_FETCH_EMAILS', {}, authorization.accountId),
        /does not match/,
      );
      await assert.rejects(
        session.download!('GMAIL_GET_ATTACHMENT', {}, authorization.accountId),
        /Gmail/,
      );
      const absent = await session.execute(
        action,
        { query: 'no-matching-project' },
        authorization.accountId,
      );
      assert.doesNotMatch(JSON.stringify(absent), /NS-2048/);
    }
    assert.equal(fixture.writes.length, 0);
  } finally {
    await app.close();
  }
});
