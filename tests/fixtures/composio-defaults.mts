import assert from 'node:assert/strict';
import { createHash, createPublicKey, verify } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

let source = '';
for await (const chunk of process.stdin) source += chunk;
const { phase } = JSON.parse(source) as { phase: 'initial' | 'restart' };
const root = process.env.NOD_DATA_ROOT!;
const origin = 'https://composio.n8n.cloud';
const statePath = join(root, 'fixture-state.json');
const saved = phase === 'restart' ? JSON.parse(await readFile(statePath, 'utf8')) : undefined;
let retainedOwner: string | undefined = saved?.userId;
let userId = '';
let requests = 0;
let executions = 0;
let foreignDenied = 0;
const sessions = new Map<string, string>();
const nonces = new Set<string>();
const violations: unknown[] = [];
globalThis.fetch = async (input, init) => {
  try {
    const request = new Request(input, init);
    const url = new URL(request.url);
    const body = Buffer.from(await request.arrayBuffer());
    const publicKey = request.headers.get('x-nod-public-key')!;
    assert.equal(url.origin, origin);
    assert.equal(request.headers.has('x-api-key'), false);
    assert.equal(request.headers.has('authorization'), false);
    const timestamp = request.headers.get('x-nod-timestamp') ?? '';
    const requestId = request.headers.get('x-nod-request-id') ?? '';
    assert.match(timestamp, /^\d{10}$/);
    assert.match(requestId, /^[A-Za-z0-9_-]{20,100}$/);
    const issuedAt = Number(timestamp) * 1000;
    const now = Date.now();
    assert.ok(issuedAt >= now - 60_000 && issuedAt <= now + 5_000);
    const nonce = `${publicKey}:${requestId}`;
    assert.equal(nonces.has(nonce), false);
    nonces.add(nonce);
    assert.ok(
      verify(
        null,
        Buffer.from(
          [
            'nod-composio-v1',
            request.method,
            origin,
            url.pathname + url.search,
            timestamp,
            requestId,
            createHash('sha256').update(body).digest('hex'),
          ].join('\n'),
        ),
        createPublicKey({ key: { kty: 'OKP', crv: 'Ed25519', x: publicKey }, format: 'jwk' }),
        Buffer.from(request.headers.get('x-nod-signature')!, 'base64url'),
      ),
    );
    const identity =
      'nod_' + createHash('sha256').update(Buffer.from(publicKey, 'base64url')).digest('hex');
    userId ||= identity;
    retainedOwner ??= identity;
    requests++;
    if (url.pathname === '/v2/access/enroll')
      return Response.json({ state: 'enabled', userId: identity });
    if (url.pathname === '/v2/api/v3.1/toolkits')
      return Response.json({ items: [], next_cursor: null });
    if (identity !== retainedOwner) {
      foreignDenied++;
      return Response.json({ error: 'account_not_owned' }, { status: 403 });
    }
    if (url.pathname === '/v2/api/v3.1/connected_accounts/ca_retained')
      return Response.json({
        id: 'ca_retained',
        user_id: retainedOwner,
        status: 'ACTIVE',
        status_reason: null,
        is_disabled: false,
        created_at: '2026-10-01T00:00:00.000Z',
        updated_at: '2026-10-01T00:00:00.000Z',
        toolkit: { slug: 'gmail' },
        auth_config: { id: 'fixture-gmail', is_disabled: false, is_composio_managed: true },
      });
    const payload = body.length ? JSON.parse(body.toString()) : undefined;
    if (url.pathname === '/v2/api/v3.1/tool_router/session') {
      assert.equal(request.method, 'POST');
      assert.equal(payload.user_id, retainedOwner);
      assert.deepEqual(payload.connected_accounts, { gmail: ['ca_retained'] });
      sessions.set('trs_retained', identity);
      return Response.json({
        session_id: 'trs_retained',
        mcp: { type: 'http', url: origin + '/unsupported-mcp' },
        config: {
          user_id: retainedOwner,
          toolkits: { enabled: ['gmail'] },
          connected_accounts: {},
        },
        config_version: 1,
      });
    }
    if (url.pathname === '/v2/api/v3.1/tool_router/session/trs_retained/execute') {
      assert.equal(sessions.get('trs_retained'), identity);
      assert.equal(payload.account, 'ca_retained');
      assert.ok(['GMAIL_GET_PROFILE', 'GMAIL_LIST_LABELS'].includes(payload.tool_slug));
      const profile = payload.tool_slug === 'GMAIL_GET_PROFILE';
      assert.deepEqual(payload.arguments, profile ? { user_id: 'me' } : {});
      if (!profile) executions++;
      return Response.json({
        data: profile ? { emailAddress: 'retained@example.test' } : { labels: [] },
        error: null,
        log_id: 'fixture-log',
        result_type: 'completed',
      });
    }
    if (url.pathname === '/v2/api/v3.1/tool_router/session/trs_retained') {
      assert.equal(request.method, 'DELETE');
      assert.equal(sessions.get('trs_retained'), identity);
      sessions.delete('trs_retained');
      return Response.json({});
    }
    throw new Error('Unexpected synthetic connection service request.');
  } catch (error) {
    violations.push(error);
    throw error;
  }
};
const { createDefaultAdapters } = await import('../../src/server/composition.ts');
const { createComposioProxy } = await import('../../src/providers/composio/proxy.ts');
const { createComposioProvider } = await import('../../src/providers/composio/integrations.ts');
const { pool } = await import('../../src/server/db.ts');
const { createIntegrationIdentityCheckpoint } =
  await import('../../src/server/integration-identity.ts');
const { ownerId } = await import('../../src/server/config.ts');
const adapters = createDefaultAdapters(process.env);
adapters.models!.initialize = async () => {};
try {
  await adapters.initialize!();
  const provider = adapters.integrations;
  assert.equal(provider.configured, true);
  assert.equal(requests, 0);
  await provider.listServices!();
  assert.equal(
    (await provider.inspectAccount('ca_retained', ownerId, { verifyOwner: true })).active,
    true,
  );
  const session = await provider.createSession(ownerId, { gmail: 'ca_retained' });
  assert.deepEqual(await session.execute('GMAIL_LIST_LABELS', {}, 'ca_retained'), {
    data: { labels: [] },
    error: null,
    logId: 'fixture-log',
    resultType: 'completed',
  });
  const foreignProxy = createComposioProxy({
    dataRoot: root,
    ownerId: 'foreign-fixture-owner',
    checkpoint: createIntegrationIdentityCheckpoint(pool, 'foreign-fixture-owner'),
    keyStore: adapters.keyStore,
  });
  await foreignProxy.initialize();
  assert.notEqual(foreignProxy.userId, retainedOwner);
  const foreignProvider = createComposioProvider({ proxy: foreignProxy });
  await assert.rejects(
    foreignProvider.inspectAccount('ca_retained', foreignProxy.ownerId, { verifyOwner: true }),
  );
  await assert.rejects(
    foreignProvider.createSession(foreignProxy.ownerId, { gmail: 'ca_retained' }),
  );
  const current = { userId, configurationId: provider.configurationId };
  if (phase === 'initial') await writeFile(statePath, JSON.stringify(current));
  else assert.deepEqual(current, saved);
  assert.deepEqual(violations, []);
  process.stdout.write(
    JSON.stringify({ connected: true, requests, executions, foreignDenied }) + '\n',
  );
} finally {
  await adapters.integrationBrowser?.close();
  await pool.end();
}
