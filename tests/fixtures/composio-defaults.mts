import assert from 'node:assert/strict';
import { createHash, createPrivateKey, createPublicKey, randomUUID, verify } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { mock } from 'node:test';
import Fastify from 'fastify';

let source = '';
for await (const chunk of process.stdin) source += chunk;
const input = JSON.parse(source) as {
  scenario: string;
  phase: 'initial' | 'restart';
  connectionId: string;
};
const scenarios = [
  'fresh-desktop',
  'keyless-server',
  'later-managed-desktop-restart',
  'direct-server-key-rotation',
  'different-server-project',
  'switchable-server',
  'switchable-desktop',
  'revoked-managed-server',
  'signed-out-managed-server',
];
assert.ok(scenarios.includes(input.scenario));
assert.ok(['initial', 'restart'].includes(input.phase));
assert.equal(process.env.DOTENV_CONFIG_PATH, '/dev/null');
const switching = ['switchable-server', 'switchable-desktop'].includes(input.scenario);
const detaching = ['revoked-managed-server', 'signed-out-managed-server'].includes(input.scenario);
const managed =
  ['fresh-desktop', 'keyless-server', 'later-managed-desktop-restart'].includes(input.scenario) ||
  (switching && input.phase === 'initial') ||
  detaching;
const rejected =
  ['different-server-project', 'switchable-server', 'switchable-desktop'].includes(
    input.scenario,
  ) && input.phase === 'restart';
const proxyOrigin = 'https://composio.n8n.cloud';
const directOrigin = 'https://backend.composio.dev';
const origin = managed ? proxyOrigin : directOrigin;
const ownKey = 'synthetic-project-a-first';
const rotatedKey = 'synthetic-project-a-rotated';
const hash = (value: string | Uint8Array) => createHash('sha256').update(value).digest('hex');
const keys = new Map([
  ['synthetic-project-a-first', 'project-a'],
  ['synthetic-project-a-rotated', 'project-a'],
  ['synthetic-project-b-foreign', 'project-b'],
]);
type Session = {
  project: string;
  value: {
    session_id: string;
    config: {
      user_id: string;
      connected_accounts: Record<string, string[]>;
      toolkits: { enabled: string[]; disabled: string[] };
      workbench: { enable: boolean };
    };
    mcp: { type: string; url: string; headers: Record<string, string> };
    config_version: number;
  };
};
type State = {
  sequence: number;
  accounts: Record<string, Record<string, string>>;
  sessions: Record<string, Session>;
  retained?: Record<string, unknown>;
  configurationId?: string;
  identityHash?: string;
  userId?: string;
  ownConfigurationId?: string;
  ownConnectionId?: string;
  ownAttempt?: string;
};
const root = process.env.OTTO_DATA_ROOT!;
const statePath = join(root, 'backend.json');
const state: State =
  input.phase === 'initial'
    ? { sequence: 0, accounts: {}, sessions: {} }
    : JSON.parse(await readFile(statePath, 'utf8'));
const calls: Array<{
  method: string;
  path: string;
  project: string;
  action?: string;
  status?: number;
}> = [];
const violations: string[] = [];
const requestIds = new Set<string>();
const privateValues: string[] = [];
const attempts: string[] = [];
let failing: string | undefined;
let interleave: (() => Promise<void>) | undefined;
let managedUser = '';
let signatureChecks = 0;
let accessChecks = 0;
let managedAccess: 'enabled' | 'revoked' | 'sign_in_required' | 'unavailable' = 'enabled';
const managedStatus = () => ({
  state: managedAccess,
  email: managedAccess === 'enabled' ? 'approved@example.test' : null,
});
let modelInitializationBypasses = 0;

globalThis.fetch = async (resource, options) => {
  const request = new Request(resource, options);
  const url = new URL(request.url);
  const viaProxy = url.origin === proxyOrigin;
  try {
    const bytes = Buffer.from(await request.arrayBuffer());
    const body = bytes.length ? JSON.parse(bytes.toString()) : undefined;
    const wire = [
      url.href,
      ...url.searchParams.keys(),
      ...url.searchParams.values(),
      JSON.stringify([...request.headers]),
      bytes.toString(),
    ].join('\n');
    for (const value of privateValues) assert.equal(wire.includes(value), false);
    if (viaProxy || (managed && !switching && !detaching))
      for (const key of [...keys.keys(), 'synthetic-invalid-key'])
        assert.equal(wire.includes(key), false);
    assert.equal(request.headers.has('authorization'), false);
    assert.equal(request.headers.has('x-user-api-key'), false);
    assert.equal(request.headers.has('x-org-api-key'), false);
    if (url.origin === 'https://registry.npmjs.org') {
      assert.equal(url.pathname, '/@composio/core/latest');
      assert.equal(request.headers.has('x-api-key'), false);
      assert.equal(request.headers.has('x-otto-signature'), false);
      return Response.json({ version: '0.0.1' });
    }
    if (switching || detaching) assert.ok([proxyOrigin, directOrigin].includes(url.origin));
    else assert.equal(url.origin, origin);
    let project: string;
    if (viaProxy) {
      assert.equal(request.headers.has('x-api-key'), false);
      const publicKey = request.headers.get('x-otto-public-key')!;
      const timestamp = request.headers.get('x-otto-timestamp')!;
      const nonce = request.headers.get('x-otto-request-id')!;
      assert.equal(Buffer.from(publicKey, 'base64url').length, 32);
      assert.ok(Math.abs(Date.now() / 1000 - Number(timestamp)) < 90);
      assert.ok(nonce && !requestIds.has(nonce));
      requestIds.add(nonce);
      assert.ok(
        verify(
          null,
          Buffer.from(
            [
              'otto-composio-v1',
              request.method,
              proxyOrigin,
              url.pathname + url.search,
              timestamp,
              nonce,
              hash(bytes),
            ].join('\n'),
          ),
          createPublicKey({ key: { kty: 'OKP', crv: 'Ed25519', x: publicKey }, format: 'jwk' }),
          Buffer.from(request.headers.get('x-otto-signature')!, 'base64url'),
        ),
      );
      assert.equal('otto_' + hash(Buffer.from(publicKey, 'base64url')), managedUser);
      signatureChecks++;
      project = 'hosted';
    } else {
      assert.equal(request.headers.has('x-otto-signature'), false);
      const key = request.headers.get('x-api-key')!;
      if (!switching && !detaching) assert.equal(key, process.env.COMPOSIO_API_KEY);
      project = keys.get(key) ?? 'invalid';
    }
    if (url.pathname === '/v1/access/status' && request.method === 'POST') {
      assert.equal(viaProxy, true);
      accessChecks++;
      if (managedAccess === 'unavailable')
        return Response.json({ error: 'service_unavailable' }, { status: 503 });
      return Response.json({
        state: managedAccess,
        ...(managedAccess === 'enabled' ? { email: 'approved@example.test' } : {}),
      });
    }
    calls.push({ method: request.method, path: url.pathname, project });
    if (viaProxy && managedAccess !== 'enabled') {
      calls.at(-1)!.status = 403;
      return Response.json({ error: 'proxy_access_revoked' }, { status: 403 });
    }
    if (project === 'invalid') {
      calls.at(-1)!.status = 401;
      return Response.json({ error: 'invalid key' }, { status: 401 });
    }
    const accounts = state.accounts[project] ?? {};
    if (url.pathname === '/api/v3.1/toolkits' && request.method === 'GET')
      return Response.json({ items: [], next_cursor: null });
    if (url.pathname === '/api/v3.1/connected_accounts' && request.method === 'GET')
      return Response.json({ items: [], next_cursor: null, total_pages: 0 });
    if (url.pathname === '/api/v3.1/auth_configs' && request.method === 'GET')
      return Response.json({ items: [], next_cursor: null });
    if (url.pathname === '/v1/connect/start' && request.method === 'POST') {
      attempts.push(body.transactionId);
      const during = interleave;
      interleave = undefined;
      await during?.();
      return Response.json({
        redirectUrl: proxyOrigin + '/v1/connect/pair?ticket=synthetic',
        transactionId: body.transactionId,
      });
    }
    if (url.pathname === '/v1/connect/complete' && request.method === 'POST') {
      assert.ok(attempts.includes(body.transactionId));
      assert.equal(body.completionToken, 'synthetic-completion');
      return Response.json({ connectedAccountId: 'ca_late', toolkit: 'gmail', status: 'ACTIVE' });
    }
    const accountMatch = url.pathname.match(/^\/api\/v3\.1\/connected_accounts\/([^/]+)$/);
    if (accountMatch && request.method === 'DELETE') {
      const id = accountMatch[1];
      calls.at(-1)!.status = failing === project ? 403 : accounts[id] ? 200 : 404;
      if (calls.at(-1)!.status !== 200)
        return Response.json({ error: 'refused' }, { status: calls.at(-1)!.status });
      delete state.accounts[project][id];
      return Response.json({ success: true });
    }
    const triggerMatch = url.pathname.match(/^\/api\/v3\.1\/trigger_instances\/manage\/([^/]+)$/);
    if (triggerMatch && request.method === 'DELETE') {
      calls.at(-1)!.status = 200;
      return Response.json({ trigger_id: triggerMatch[1] });
    }
    if (accountMatch && request.method === 'GET') {
      const id = accountMatch[1];
      calls.at(-1)!.status = accounts[id] ? 200 : 404;
      if (!accounts[id]) return Response.json({ error: 'missing' }, { status: 404 });
      return Response.json({
        id,
        user_id: accounts[id],
        toolkit: { slug: 'gmail' },
        auth_config: { id: 'ac_fixture', is_disabled: false, is_composio_managed: true },
        status: 'ACTIVE',
        is_disabled: false,
        status_reason: null,
        created_at: '2026-10-01T00:00:00Z',
        updated_at: '2026-10-01T00:00:00Z',
        ...(project === 'hosted'
          ? {}
          : {
              state: {
                authScheme: 'OAUTH2',
                val: { status: 'ACTIVE', access_token: 'synthetic-account-token' },
              },
            }),
      });
    }
    if (url.pathname === '/api/v3.1/tool_router/session' && request.method === 'POST') {
      const connected = Object.fromEntries(
        Object.entries(body.connected_accounts ?? {}).map(([toolkit, accounts]) => [
          toolkit,
          Array.isArray(accounts) ? accounts : [accounts],
        ]),
      );
      for (const ids of Object.values(connected) as string[][])
        for (const id of ids) assert.equal(accounts[id], body.user_id);
      assert.equal(body.user_id, project === 'hosted' ? managedUser : ownerId);
      const id = `trs_fixture_${state.sequence++}`;
      const value: Session['value'] = {
        session_id: id,
        config: {
          user_id: body.user_id,
          connected_accounts: connected,
          toolkits: { enabled: body.toolkits?.enable ?? [], disabled: [] },
          workbench: { enable: false },
        },
        mcp: { type: 'http', url: url.origin + '/unsupported-mcp', headers: {} },
        config_version: 1,
      };
      state.sessions[id] = { project, value };
      return Response.json(value);
    }
    const sessionMatch = url.pathname.match(
      /^\/api\/v3\.1\/tool_router\/session\/([^/]+)(?:\/(execute|link))?$/,
    );
    if (sessionMatch) {
      const session = state.sessions[sessionMatch[1]];
      if (!session || session.project !== project)
        return Response.json({ error: 'missing' }, { status: 404 });
      if (project === 'hosted') assert.equal(session.value.config.user_id, managedUser);
      if (!sessionMatch[2] && request.method === 'GET') return Response.json(session.value);
      if (!sessionMatch[2] && request.method === 'DELETE') {
        delete state.sessions[sessionMatch[1]];
        return Response.json({ session_id: sessionMatch[1], deleted: true });
      }
      if (sessionMatch[2] === 'execute' && request.method === 'POST') {
        assert.equal(accounts[body.account], session.value.config.user_id);
        assert.ok(session.value.config.connected_accounts.gmail.includes(body.account));
        assert.ok(['GMAIL_GET_PROFILE', 'GMAIL_LIST_LABELS'].includes(body.tool_slug));
        calls.at(-1)!.action = body.tool_slug;
        return Response.json({
          data:
            body.tool_slug === 'GMAIL_GET_PROFILE'
              ? { emailAddress: 'owner@example.test', name: 'Synthetic owner' }
              : { labels: [{ id: 'INBOX', name: 'Inbox' }] },
          error: null,
          log_id: 'fixture-log',
          result_type: 'completed',
        });
      }
      if (sessionMatch[2] === 'link' && request.method === 'POST') {
        attempts.push(new URL(body.callback_url).searchParams.get('state')!);
        return Response.json({
          connected_account_id: 'ca_pending_own',
          redirect_url: 'https://connect.composio.dev/link/synthetic',
        });
      }
    }
    assert.fail('Unexpected synthetic backend route.');
  } catch (error) {
    violations.push(request.method + ' ' + url.pathname);
    process.stderr.write(
      JSON.stringify({
        fixtureRequest: request.method + ' ' + url.pathname,
        assertion: error instanceof assert.AssertionError,
        location:
          error instanceof Error
            ? error.stack
                ?.split('\n')
                .find((line) => line.includes('at globalThis.fetch'))
                ?.trim()
            : undefined,
      }) + '\n',
    );
    throw error;
  }
};

mock.timers.enable({ apis: ['setInterval'] });
const { createDefaultAdapters } = await import('../../src/server/composition.ts');
const { createIntegrations } = await import('../../src/server/integrations.ts');
const { createIntegrationKeyService } = await import('../../src/server/integration-key.ts');
const { createComposioProvider } = await import('../../src/providers/composio/integrations.ts');
const { createWorkAdmission } = await import('../../src/server/work-admission.ts');
const { ownerId } = await import('../../src/server/config.ts');
const { pool } = await import('../../src/server/db.ts');
const app = Fastify();
try {
  const adapters = createDefaultAdapters(process.env);
  assert.ok(adapters.models);
  adapters.models.initialize = async () => {
    modelInitializationBypasses++;
  };
  await adapters.initialize?.();
  const provider = adapters.integrations;
  const integrationKey = adapters.integrationKey!;
  const redacted: string[] = [];
  integrationKey.onSecrets((values) => redacted.push(...values));
  assert.equal(provider.configured, true);
  if (managed || switching) {
    const pem = await readFile(join(root, 'integration-identity', hash(ownerId) + '.pem'));
    const key = createPrivateKey(pem);
    const jwk = key.export({ format: 'jwk' });
    const publicKey = createPublicKey(key).export({ format: 'jwk' }).x!;
    managedUser = 'otto_' + hash(Buffer.from(publicKey, 'base64url'));
    privateValues.push(pem.toString(), pem.toString('base64'), jwk.d!);
    if (input.phase === 'restart') {
      assert.equal(hash(pem), state.identityHash);
      assert.equal(managedUser, state.userId);
      if (managed) assert.equal(provider.configurationId, state.configurationId);
    } else {
      state.identityHash = hash(pem);
      state.userId = managedUser;
    }
  } else {
    await assert.rejects(readFile(join(root, 'integration-identity', hash(ownerId) + '.pem')), {
      code: 'ENOENT',
    });
  }
  if (input.phase === 'initial') {
    state.accounts = {
      [managed ? 'hosted' : 'project-a']: { ca_retained: managed ? managedUser : ownerId },
      'project-b': { ca_other_project: ownerId },
    };
  }
  await provider.listServices!();
  const admission = createWorkAdmission();
  const service = await createIntegrations(pool, {
    admission,
    ownerId,
    provider,
    standbyProviders: adapters.standbyIntegrations,
    baseUrl: process.env.OTTO_PUBLIC_URL!,
    wake: async () => assert.fail('Periodic fixture workers must not dispatch queued work.'),
  });
  service.registerRoutes(app);
  integrationKey.register(app, service);
  const settle = async () => {
    admission.pause();
    await admission.drain(Date.now() + 5000);
    admission.resume();
  };
  await settle();
  const keyStatus = async () =>
    (await app.inject({ method: 'GET', url: '/api/integrations/key' })).json();
  assert.deepEqual(await keyStatus(), {
    mode: managed ? 'otto' : 'own',
    switchable: managed || switching,
    keyWritable: managed || switching,
    managed: managed
      ? managedStatus()
      : switching
        ? { state: 'sign_in_required', email: null }
        : null,
    suffix: switching && !managed ? rotatedKey.slice(-4) : null,
  });
  assert.equal(redacted.includes(rotatedKey), switching && !managed);
  if (!managed && !switching) {
    const before = calls.length;
    for (const method of ['PUT', 'DELETE'] as const) {
      const refused = await app.inject({
        method,
        url: '/api/integrations/key',
        ...(method === 'PUT' ? { payload: { key: ownKey } } : {}),
      });
      assert.equal(refused.statusCode, 400);
    }
    assert.equal(calls.length, before);
    assert.deepEqual(await keyStatus(), {
      mode: 'own',
      switchable: false,
      keyWritable: false,
      managed: null,
      suffix: null,
    });
  }
  if (input.phase === 'initial') {
    assert.equal(
      (await service.list(ownerId, { refresh: false })).filter(
        (connection) => connection.status === 'connected',
      ).length,
      0,
    );
    assert.equal((await pool.query('SELECT id FROM app_connections')).rows.length, 0);
    const account = await provider.inspectAccount('ca_retained', ownerId, { verifyOwner: true });
    assert.equal(account.active, true);
    assert.equal(account.service, 'gmail');
    assert.equal(account.accountEmail, 'owner@example.test');
    await pool.query(
      `INSERT INTO app_connections(id,owner_id,provider_id,slug,account_id,configuration_id,
       account_active,account_checked_at,account_name,account_email,watch_requested,inbox_cursor,
       trigger_id,triggers_enabled)
       VALUES($1,$2,'composio','gmail','ca_retained',$3,true,'2100-01-01','Synthetic owner',
       'owner@example.test',true,'retained-cursor','retained-trigger',true)`,
      [input.connectionId, ownerId, provider.configurationId],
    );
    await pool.query(
      `INSERT INTO integration_events(id,owner_id,provider_id,summary,slug,account_id,trigger_id)
       VALUES('retained-event',$1,'composio','Synthetic event','gmail','ca_retained','retained-trigger')`,
      [ownerId],
    );
    state.configurationId = provider.configurationId;
  }
  if (!switching || input.phase === 'initial') {
    const row = (
      await pool.query('SELECT * FROM app_connections WHERE id=$1', [input.connectionId])
    ).rows[0];
    const { configuration_id: configurationId, ...retained } = JSON.parse(JSON.stringify(row));
    if (input.phase === 'initial') state.retained = retained;
    else assert.deepEqual(retained, state.retained);
    assert.equal(configurationId, rejected ? state.configurationId : provider.configurationId);
    if (!managed && input.phase === 'restart')
      assert.notEqual(provider.configurationId, state.configurationId);
    const connected = (await service.list(ownerId, { refresh: false })).find(
      (connection) => connection.connectionId === input.connectionId,
    );
    assert.ok(connected);
    assert.equal(connected.status === 'connected', !rejected);
    if (rejected) {
      await assert.rejects(
        service.executeApproved(ownerId, 'GMAIL_LIST_LABELS', { connectionId: input.connectionId }),
      );
      assert.ok(
        calls.some(
          (call) => call.path === '/api/v3.1/connected_accounts/ca_retained' && call.status === 404,
        ),
      );
      assert.ok(calls.every((call) => call.method === 'GET'));
    } else {
      const result = (await service.executeApproved(ownerId, 'GMAIL_LIST_LABELS', {
        connectionId: input.connectionId,
      })) as { data: unknown };
      assert.deepEqual(result.data, { labels: [{ id: 'INBOX', name: 'Inbox' }] });
      assert.equal(calls.filter((call) => call.action === 'GMAIL_LIST_LABELS').length, 1);
      if (managed && input.phase === 'restart')
        assert.ok(
          calls.some(
            (call) => call.method === 'POST' && call.path === '/api/v3.1/tool_router/session',
          ),
        );
    }
    assert.deepEqual((await pool.query('SELECT id,state FROM integration_events')).rows, [
      { id: 'retained-event', state: 'queued' },
    ]);
    assert.ok(calls.length > 0);
    assert.ok(
      calls.every(
        (call) => call.project === (managed ? 'hosted' : rejected ? 'project-b' : 'project-a'),
      ),
    );
    assert.equal(signatureChecks, managed ? calls.length + accessChecks : 0);
  }
  const startup = calls.slice();
  if (detaching) {
    const started = await app.inject({
      method: 'POST',
      url: '/api/apps/gmail/connect',
      payload: {},
    });
    assert.equal(started.statusCode, 200, started.body);
    const pending = attempts.at(-1)!;
    assert.equal(
      (await pool.query('SELECT id FROM app_connections WHERE callback_expires>now()')).rowCount,
      1,
    );
    const session = await provider.createSession(ownerId, { gmail: ['ca_retained'] });
    await pool.query(
      `INSERT INTO integration_events(id,owner_id,provider_id,summary,state,poll_connection_id)
       VALUES('processing-event',$1,'composio','Synthetic processing event','processing',$2)`,
      [ownerId, input.connectionId],
    );
    const foreignId = randomUUID();
    const otherConfigurationId = randomUUID();
    const otherProviderId = randomUUID();
    await pool.query(
      `INSERT INTO app_connections(id,owner_id,provider_id,slug,account_id,configuration_id)
       VALUES($1,'another-synthetic-owner','composio','gmail','ca_foreign',$2),
       ($3,$4,'composio','gmail','ca_other_configuration','other-configuration'),
       ($5,$4,'another-provider','gmail','ca_other_provider',$2)`,
      [foreignId, provider.configurationId, otherConfigurationId, ownerId, otherProviderId],
    );
    await pool.query(
      `INSERT INTO integration_events(id,owner_id,provider_id,summary,account_id,poll_connection_id)
       VALUES('foreign-event','another-synthetic-owner','composio','Synthetic foreign event','ca_retained',$1),
       ('other-configuration-event',$2,'composio','Synthetic other configuration event','ca_other_configuration',$3),
       ('other-provider-event',$2,'another-provider','Synthetic other provider event','ca_other_provider',$4)`,
      [input.connectionId, ownerId, otherConfigurationId, otherProviderId],
    );
    const savedRows = (await pool.query('SELECT * FROM app_connections ORDER BY id')).rows;
    const save = () =>
      app.inject({ method: 'PUT', url: '/api/integrations/key', payload: { key: ownKey } });
    managedAccess = 'unavailable';
    const unavailable = await save();
    assert.equal(unavailable.statusCode, 400);
    assert.equal(provider.configurationId, state.configurationId);
    assert.deepEqual(
      (await pool.query('SELECT * FROM app_connections ORDER BY id')).rows,
      savedRows,
    );
    assert.equal((await pool.query('SELECT * FROM integration_keys')).rowCount, 0);
    managedAccess = 'enabled';
    failing = 'hosted';
    const inaccessible = await save();
    failing = undefined;
    assert.equal(inaccessible.statusCode, 400);
    assert.equal(provider.configurationId, state.configurationId);
    assert.deepEqual(
      (await pool.query('SELECT * FROM app_connections ORDER BY id')).rows,
      savedRows,
    );
    managedAccess = input.scenario === 'revoked-managed-server' ? 'revoked' : 'sign_in_required';
    const before = calls.length;
    const switched = await save();
    assert.equal(switched.statusCode, 200, switched.body);
    assert.equal(switched.json().mode, 'own');
    assert.equal(switched.json().suffix, ownKey.slice(-4));
    assert.equal(typeof switched.json().warning, 'string');
    assert.ok(switched.json().warning.length > 0);
    await settle();
    assert.ok(calls.slice(before).every((call) => call.project === 'project-a'));
    assert.equal(state.accounts.hosted.ca_retained, managedUser);
    assert.ok(state.sessions[session.id]);
    assert.deepEqual(
      (await pool.query('SELECT * FROM app_connections ORDER BY id')).rows,
      savedRows.filter((row) =>
        [foreignId, otherConfigurationId, otherProviderId].includes(row.id),
      ),
    );
    assert.deepEqual(
      (await pool.query('SELECT id,state FROM integration_events ORDER BY id')).rows,
      [
        { id: 'foreign-event', state: 'queued' },
        { id: 'other-configuration-event', state: 'queued' },
        { id: 'other-provider-event', state: 'queued' },
        { id: 'processing-event', state: 'discarded' },
        { id: 'retained-event', state: 'discarded' },
      ],
    );
    assert.equal(
      (await pool.query('SELECT * FROM integration_keys WHERE owner_id=$1', [ownerId])).rowCount,
      1,
    );
    const callback = await app.inject({
      method: 'GET',
      url: `/api/apps/callback?state=${pending}&completion_token=synthetic-completion`,
    });
    assert.match(String(callback.headers.location), /connection=expired/);
    await assert.rejects(
      service.executeApproved(ownerId, 'GMAIL_LIST_LABELS', { connectionId: input.connectionId }),
    );
    const directChecks = accessChecks;
    assert.equal((await keyStatus()).mode, 'own');
    const directId = randomUUID();
    state.accounts['project-a'] ??= {};
    state.accounts['project-a'].ca_detached_own = ownerId;
    await pool.query(
      `INSERT INTO app_connections(id,owner_id,provider_id,slug,account_id,configuration_id,account_checked_at)
       VALUES($1,$2,'composio','gmail','ca_detached_own',$3,'2100-01-01')`,
      [directId, ownerId, provider.configurationId],
    );
    const result = await service.executeApproved(ownerId, 'GMAIL_LIST_LABELS', {
      connectionId: directId,
    });
    assert.deepEqual((result as { data: unknown }).data, {
      labels: [{ id: 'INBOX', name: 'Inbox' }],
    });
    assert.equal(accessChecks, directChecks);
    assert.ok(calls.slice(before).every((call) => call.project === 'project-a'));
  }
  if (switching) {
    const save = (key: string) =>
      app.inject({ method: 'PUT', url: '/api/integrations/key', payload: { key } });
    const connection = async (id: string) =>
      (await service.list(ownerId, { refresh: false })).find((item) => item.connectionId === id);
    const labels = async (id: string) =>
      (
        (await service.executeApproved(ownerId, 'GMAIL_LIST_LABELS', {
          connectionId: id,
        })) as { data: unknown }
      ).data;
    const abandoned = async (query: string) => {
      const response = await app.inject({ method: 'GET', url: '/api/apps/callback?' + query });
      assert.match(String(response.headers.location), /connection=(?:failed|expired)/);
    };
    const configuration = async (id: string) =>
      (await pool.query('SELECT configuration_id FROM app_connections WHERE id=$1', [id])).rows[0]
        .configuration_id;
    const deleted = (path: string, project: string) =>
      calls.some(
        (call) =>
          call.method === 'DELETE' &&
          call.path === path &&
          call.project === project &&
          call.status === 200,
      );
    if (input.phase === 'initial') {
      const pairing = await app.inject({
        method: 'POST',
        url: '/api/apps/gmail/connect',
        payload: {},
      });
      assert.equal(pairing.json().pairingCode, undefined);
      const managedAttempt = attempts.at(-1)!;
      const checked = calls.length;
      const invalid = await save('synthetic-invalid-key');
      assert.equal(invalid.statusCode, 400);
      assert.ok(calls.length > checked);
      assert.ok(calls.slice(checked).every((call) => call.status === 401));
      failing = 'hosted';
      const refused = await save(ownKey);
      failing = undefined;
      assert.equal(refused.statusCode, 400);
      assert.equal(provider.configurationId, state.configurationId);
      assert.deepEqual(await keyStatus(), {
        mode: 'otto',
        switchable: true,
        keyWritable: true,
        managed: managedStatus(),
        suffix: null,
      });
      assert.deepEqual((await pool.query('SELECT * FROM integration_keys')).rows, []);
      assert.equal((await connection(input.connectionId))!.status, 'connected');
      assert.equal(state.accounts.hosted.ca_retained, managedUser);
      assert.equal(
        (await pool.query('SELECT id FROM app_connections WHERE callback_expires>now()')).rowCount,
        1,
      );
      let saved: Awaited<ReturnType<typeof save>> | undefined;
      interleave = async () => {
        saved = await save(ownKey);
      };
      const raced = await app.inject({
        method: 'POST',
        url: '/api/apps/gmail/connect',
        payload: {},
      });
      assert.equal(raced.statusCode, 409);
      assert.equal(saved!.statusCode, 200);
      assert.equal(saved!.body.includes(ownKey), false);
      assert.deepEqual(saved!.json(), {
        mode: 'own',
        switchable: true,
        keyWritable: true,
        managed: managedStatus(),
        suffix: ownKey.slice(-4),
      });
      assert.ok(redacted.includes(ownKey));
      assert.equal(redacted.includes('synthetic-invalid-key'), false);
      assert.deepEqual(
        (await pool.query('SELECT ciphertext FROM vault_app_grants')).rows.filter((grant) =>
          grant.ciphertext.includes(ownKey),
        ),
        [],
      );
      assert.ok(deleted('/api/v3.1/connected_accounts/ca_retained', 'hosted'));
      assert.ok(deleted('/api/v3.1/trigger_instances/manage/retained-trigger', 'hosted'));
      assert.equal(state.accounts.hosted.ca_retained, undefined);
      assert.equal(await connection(input.connectionId), undefined);
      assert.equal(
        (await pool.query('SELECT id FROM app_connections WHERE callback_expires>now()')).rowCount,
        0,
      );
      await settle();
      const switched = calls.length;
      const directAccessChecks = accessChecks;
      state.ownConnectionId = randomUUID();
      state.accounts['project-a'] = { ca_own: ownerId };
      await pool.query(
        `INSERT INTO app_connections(id,owner_id,provider_id,slug,account_id,configuration_id,
         account_active,account_checked_at,account_name,account_email,trigger_id)
         VALUES($1,$2,'composio','gmail','ca_own',$3,true,'2100-01-01','Synthetic owner',
         'owner@example.test','own-trigger')`,
        [state.ownConnectionId, ownerId, provider.configurationId],
      );
      assert.deepEqual(await labels(state.ownConnectionId), {
        labels: [{ id: 'INBOX', name: 'Inbox' }],
      });
      const firstConfiguration = provider.configurationId;
      const rotated = await save(rotatedKey);
      assert.deepEqual(rotated.json(), {
        mode: 'own',
        switchable: true,
        keyWritable: true,
        managed: managedStatus(),
        suffix: rotatedKey.slice(-4),
      });
      assert.notEqual(provider.configurationId, firstConfiguration);
      await settle();
      assert.equal(await configuration(state.ownConnectionId), provider.configurationId);
      assert.deepEqual(await labels(state.ownConnectionId), {
        labels: [{ id: 'INBOX', name: 'Inbox' }],
      });
      state.ownConfigurationId = provider.configurationId;
      const direct = await app.inject({
        method: 'POST',
        url: '/api/apps/gmail/connect',
        payload: {},
      });
      assert.equal(new URL(direct.json().url).origin, 'https://connect.composio.dev');
      assert.equal(direct.json().pairingCode, undefined);
      state.ownAttempt = attempts.at(-1);
      state.accounts['project-a'].ca_pending_own = ownerId;
      assert.ok(calls.slice(switched).every((call) => call.project === 'project-a'));
      await keyStatus();
      assert.equal(accessChecks, directAccessChecks);
      assert.ok(calls.every((call) => !(call.method === 'DELETE' && call.path.includes('ca_own'))));
      state.accounts.hosted.ca_late = managedUser;
      await abandoned(`state=${managedAttempt}&completion_token=synthetic-completion`);
      assert.equal(calls.filter((call) => call.path === '/v1/connect/complete').length, 1);
      assert.ok(deleted('/api/v3.1/connected_accounts/ca_late', 'hosted'));
      assert.equal(state.accounts.hosted.ca_late, undefined);
      assert.equal(
        (await pool.query("SELECT id FROM app_connections WHERE account_id='ca_late'")).rowCount,
        0,
      );
      assert.ok(calls.every((call) => !call.path.includes('ca_pending_own')));
      const recoveringOwner = 'synthetic-unsealed-owner';
      await pool.query('INSERT INTO integration_keys(owner_id,vault_id) VALUES($1,$2)', [
        recoveringOwner,
        randomUUID(),
      ]);
      const recovering = createIntegrationKeyService({
        ownerId: recoveringOwner,
        keyStore: {
          id: 'synthetic-unconfigured',
          configured: false,
          getKey: async () => assert.fail('An unconfigured key store has no key.'),
        },
        provider: createComposioProvider({}),
        managed: { status: async () => managedStatus() },
      });
      await recovering.initialize();
      const unsealed = Fastify();
      recovering.register(unsealed, { changeProvider: async (_, swap) => swap() });
      const before = calls.length;
      const request = (method: 'GET' | 'PUT' | 'DELETE') =>
        unsealed.inject({
          method,
          url: '/api/integrations/key',
          ...(method === 'PUT' ? { payload: { key: ownKey } } : {}),
        });
      assert.deepEqual((await request('GET')).json(), {
        mode: 'own',
        switchable: true,
        keyWritable: false,
        managed: { state: 'sign_in_required', email: null },
        suffix: null,
      });
      const unsaved = await request('PUT');
      assert.equal(unsaved.statusCode, 400);
      assert.deepEqual((await request('GET')).json(), {
        mode: 'own',
        switchable: true,
        keyWritable: false,
        managed: { state: 'sign_in_required', email: null },
        suffix: null,
      });
      assert.deepEqual((await request('DELETE')).json(), {
        mode: 'otto',
        switchable: true,
        keyWritable: false,
        managed: managedStatus(),
        suffix: null,
      });
      assert.equal(
        (await pool.query('SELECT 1 FROM integration_keys WHERE owner_id=$1', [recoveringOwner]))
          .rowCount,
        0,
      );
      assert.equal(calls.length, before);
      await unsealed.close();
    } else {
      const ownConnection = state.ownConnectionId!;
      const directAccessChecks = accessChecks;
      assert.equal(directAccessChecks, 0);
      assert.equal(provider.configurationId, state.ownConfigurationId);
      assert.deepEqual(await labels(ownConnection), {
        labels: [{ id: 'INBOX', name: 'Inbox' }],
      });
      await keyStatus();
      assert.equal(accessChecks, directAccessChecks);
      const stale = randomUUID();
      state.accounts.hosted = { ca_stale: managedUser };
      await pool.query(
        `INSERT INTO app_connections(id,owner_id,provider_id,slug,account_id,configuration_id)
         VALUES($1,$2,'composio','gmail','ca_stale',$3)`,
        [stale, ownerId, state.configurationId],
      );
      assert.equal((await connection(stale))!.reconnectRequired, true);
      const disconnected = await app.inject({
        method: 'POST',
        url: `/api/apps/gmail/accounts/${stale}/disconnect`,
        payload: {},
      });
      assert.deepEqual(disconnected.json(), { ok: true });
      assert.ok(deleted('/api/v3.1/connected_accounts/ca_stale', 'hosted'));
      assert.equal(await connection(stale), undefined);
      managedAccess = 'revoked';
      const protectedKey = (await pool.query('SELECT * FROM vault_app_grants')).rows;
      const beforeDeniedSwitch = calls.length;
      const deniedSwitch = await app.inject({ method: 'DELETE', url: '/api/integrations/key' });
      assert.equal(deniedSwitch.statusCode, 400);
      assert.equal(provider.configurationId, state.ownConfigurationId);
      assert.equal(calls.length, beforeDeniedSwitch);
      assert.deepEqual((await pool.query('SELECT * FROM vault_app_grants')).rows, protectedKey);
      assert.equal((await keyStatus()).managed.state, 'revoked');
      assert.deepEqual(await labels(ownConnection), { labels: [{ id: 'INBOX', name: 'Inbox' }] });
      const gone = randomUUID();
      await pool.query(
        `INSERT INTO app_connections(id,owner_id,provider_id,slug,account_id,configuration_id)
         VALUES($1,$2,'composio','gmail','ca_gone',$3)`,
        [gone, ownerId, provider.configurationId],
      );
      managedAccess = 'enabled';
      const switched = calls.length;
      const removed = await app.inject({ method: 'DELETE', url: '/api/integrations/key' });
      assert.deepEqual(removed.json(), {
        mode: 'otto',
        switchable: true,
        keyWritable: true,
        managed: managedStatus(),
        suffix: null,
      });
      assert.equal(provider.configurationId, state.configurationId);
      assert.deepEqual((await pool.query('SELECT * FROM integration_keys')).rows, []);
      assert.deepEqual((await pool.query('SELECT * FROM vault_app_grants')).rows, []);
      assert.ok(deleted('/api/v3.1/connected_accounts/ca_own', 'project-a'));
      assert.ok(deleted('/api/v3.1/trigger_instances/manage/own-trigger', 'project-a'));
      assert.ok(deleted('/api/v3.1/connected_accounts/ca_pending_own', 'project-a'));
      assert.equal(state.accounts['project-a'].ca_own, undefined);
      assert.equal(await connection(ownConnection), undefined);
      assert.equal(await connection(gone), undefined);
      assert.ok(
        calls.some(
          (call) =>
            call.method === 'GET' &&
            call.path === '/api/v3.1/connected_accounts/ca_gone' &&
            call.status === 404,
        ),
      );
      await settle();
      await abandoned(
        `state=${state.ownAttempt}&status=success&connected_account_id=ca_pending_own`,
      );
      assert.ok(calls.slice(switched).every((call) => call.project === 'project-a'));
      assert.ok(calls.every((call) => call.path !== '/v1/connect/complete'));
    }
    assert.equal(
      (await pool.query("SELECT id FROM app_connections WHERE account_id='ca_pending_own'")).rows
        .length,
      0,
    );
  }
  assert.equal(modelInitializationBypasses, 1);
  assert.deepEqual(violations, []);
  await writeFile(statePath, JSON.stringify(state), { mode: 0o600 });
  process.stdout.write(
    JSON.stringify({
      scenario: input.scenario,
      phase: input.phase,
      passed: true,
      connected: !rejected,
      origin,
      calls: startup,
      signatureChecks,
      accessChecks,
      periodicWorkers: 'frozen; foreground routing and account continuity only',
    }) + '\n',
  );
} finally {
  await app.close();
  await pool.end();
  mock.timers.reset();
}
