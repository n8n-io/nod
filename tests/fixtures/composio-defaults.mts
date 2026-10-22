import assert from 'node:assert/strict';
import { createHash, createPublicKey, verify } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

let source = '';
for await (const chunk of process.stdin) source += chunk;
const { phase } = JSON.parse(source) as { phase: 'initial' | 'restart' };
const root = process.env.OTTO_DATA_ROOT!;
const origin = 'https://composio.n8n.cloud';
let userId = '';
let requests = 0;
globalThis.fetch = async (input, init) => {
  const request = new Request(input, init);
  const url = new URL(request.url);
  const body = Buffer.from(await request.arrayBuffer());
  const publicKey = request.headers.get('x-otto-public-key')!;
  assert.equal(url.origin, origin);
  assert.equal(request.headers.has('x-api-key'), false);
  assert.equal(request.headers.has('authorization'), false);
  assert.ok(
    verify(
      null,
      Buffer.from(
        [
          'otto-composio-v1',
          request.method,
          origin,
          url.pathname + url.search,
          request.headers.get('x-otto-timestamp'),
          request.headers.get('x-otto-request-id'),
          createHash('sha256').update(body).digest('hex'),
        ].join('\n'),
      ),
      createPublicKey({ key: { kty: 'OKP', crv: 'Ed25519', x: publicKey }, format: 'jwk' }),
      Buffer.from(request.headers.get('x-otto-signature')!, 'base64url'),
    ),
  );
  const identity =
    'otto_' + createHash('sha256').update(Buffer.from(publicKey, 'base64url')).digest('hex');
  if (userId) assert.equal(identity, userId);
  userId = identity;
  requests++;
  if (url.pathname === '/v2/access/enroll') return Response.json({ state: 'enabled', userId });
  if (url.pathname === '/v2/api/v3.1/toolkits')
    return Response.json({ items: [], next_cursor: null });
  if (url.pathname === '/v2/api/v3.1/connected_accounts/ca_retained')
    return Response.json({
      id: 'ca_retained',
      user_id: userId,
      status: 'ACTIVE',
      toolkit: { slug: 'gmail' },
      auth_config: { id: 'fixture-gmail', is_disabled: false },
    });
  throw new Error('Unexpected synthetic connection service request.');
};
const { createDefaultAdapters } = await import('../../src/server/composition.ts');
const { pool } = await import('../../src/server/db.ts');
const { ownerId } = await import('../../src/server/config.ts');
const adapters = createDefaultAdapters(process.env);
adapters.models!.initialize = async () => {};
try {
  await adapters.initialize!();
  const provider = adapters.integrations;
  assert.equal(provider.configured, true);
  assert.equal(requests, 0);
  await provider.listServices!();
  assert.equal((await provider.inspectAccount('ca_retained', ownerId)).active, true);
  const current = { userId, configurationId: provider.configurationId };
  const statePath = join(root, 'fixture-state.json');
  if (phase === 'initial') await writeFile(statePath, JSON.stringify(current));
  else assert.deepEqual(current, JSON.parse(await readFile(statePath, 'utf8')));
  process.stdout.write(JSON.stringify({ connected: true, requests }) + '\n');
} finally {
  await adapters.integrationBrowser?.close();
  await pool.end();
}
