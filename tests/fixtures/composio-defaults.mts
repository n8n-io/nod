import assert from 'node:assert/strict';
import { createHash, createPrivateKey, createPublicKey, verify } from 'node:crypto';
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
];
assert.ok(scenarios.includes(input.scenario));
assert.ok(['initial', 'restart'].includes(input.phase));
assert.equal(process.env.DOTENV_CONFIG_PATH, '/dev/null');
const managed = ['fresh-desktop', 'keyless-server', 'later-managed-desktop-restart'].includes(
  input.scenario,
);
const rejected = input.scenario === 'different-server-project' && input.phase === 'restart';
const origin = managed ? 'https://composio.n8n.cloud' : 'https://backend.composio.dev';
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
let managedUser = '';
let signatureChecks = 0;
let modelInitializationBypasses = 0;

globalThis.fetch = async (resource, options) => {
  const request = new Request(resource, options);
  const url = new URL(request.url);
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
    if (managed) for (const key of keys.keys()) assert.equal(wire.includes(key), false);
    assert.equal(request.headers.has('authorization'), false);
    assert.equal(request.headers.has('x-user-api-key'), false);
    assert.equal(request.headers.has('x-org-api-key'), false);
    if (url.origin === 'https://registry.npmjs.org') {
      assert.equal(url.pathname, '/@composio/core/latest');
      assert.equal(request.headers.has('x-api-key'), false);
      assert.equal(request.headers.has('x-otto-signature'), false);
      return Response.json({ version: '0.0.1' });
    }
    assert.equal(url.origin, origin);
    let project: string;
    if (managed) {
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
              origin,
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
      assert.equal(request.headers.get('x-api-key'), process.env.COMPOSIO_API_KEY);
      project = keys.get(request.headers.get('x-api-key')!)!;
      assert.ok(project);
    }
    calls.push({ method: request.method, path: url.pathname, project });
    const accounts = state.accounts[project] ?? {};
    if (url.pathname === '/api/v3.1/toolkits' && request.method === 'GET')
      return Response.json({ items: [], next_cursor: null });
    const accountMatch = url.pathname.match(/^\/api\/v3\.1\/connected_accounts\/([^/]+)$/);
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
        ...(managed
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
      assert.equal(body.user_id, managed ? managedUser : 'local-development');
      const id = `trs_fixture_${state.sequence++}`;
      const value: Session['value'] = {
        session_id: id,
        config: {
          user_id: body.user_id,
          connected_accounts: connected,
          toolkits: { enabled: body.toolkits?.enable ?? [], disabled: [] },
          workbench: { enable: false },
        },
        mcp: { type: 'http', url: origin + '/unsupported-mcp', headers: {} },
        config_version: 1,
      };
      state.sessions[id] = { project, value };
      return Response.json(value);
    }
    const sessionMatch = url.pathname.match(
      /^\/api\/v3\.1\/tool_router\/session\/([^/]+)(?:\/(execute))?$/,
    );
    if (sessionMatch) {
      const session = state.sessions[sessionMatch[1]];
      if (!session || session.project !== project)
        return Response.json({ error: 'missing' }, { status: 404 });
      if (managed) assert.equal(session.value.config.user_id, managedUser);
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
        });
      }
    }
    assert.fail('Unexpected synthetic backend route.');
  } catch (error) {
    violations.push(request.method + ' ' + url.pathname);
    throw error;
  }
};

mock.timers.enable({ apis: ['setInterval'] });
const { createDefaultAdapters } = await import('../../src/server/composition.ts');
const { createIntegrations } = await import('../../src/server/integrations.ts');
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
  assert.equal(provider.configured, true);
  if (managed) {
    const pem = await readFile(join(root, 'integration-identity', hash(ownerId) + '.pem'));
    const key = createPrivateKey(pem);
    const jwk = key.export({ format: 'jwk' });
    const publicKey = createPublicKey(key).export({ format: 'jwk' }).x!;
    managedUser = 'otto_' + hash(Buffer.from(publicKey, 'base64url'));
    privateValues.push(pem.toString(), pem.toString('base64'), jwk.d!);
    if (input.phase === 'restart') {
      assert.equal(hash(pem), state.identityHash);
      assert.equal(managedUser, state.userId);
      assert.equal(provider.configurationId, state.configurationId);
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
    baseUrl: process.env.OTTO_PUBLIC_URL!,
    wake: async () => assert.fail('Periodic fixture workers must not dispatch queued work.'),
  });
  service.registerRoutes(app);
  admission.pause();
  await admission.drain(Date.now() + 5000);
  admission.resume();
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
  const row = (await pool.query('SELECT * FROM app_connections WHERE id=$1', [input.connectionId]))
    .rows[0];
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
        calls.some((call) => call.method === 'GET' && call.path.includes('/tool_router/session/')),
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
  assert.equal(signatureChecks, managed ? calls.length : 0);
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
      calls,
      signatureChecks,
      periodicWorkers: 'frozen; foreground routing and account continuity only',
    }) + '\n',
  );
} finally {
  await app.close();
  await pool.end();
  mock.timers.reset();
}
