import assert from 'node:assert/strict';
import { createCipheriv, randomBytes, randomUUID } from 'node:crypto';
import test from 'node:test';
import pg from 'pg';
import Fastify from 'fastify';
import type { IntegrationProvider, IntegrationSession } from '../src/ports/integrations.ts';
import { createDirectProvider } from '../src/providers/direct/integrations.ts';
import { createDirectOAuth } from '../src/providers/direct/oauth.ts';
import { createIntegrations } from '../src/server/integrations.ts';
import { createAppGrantVault } from '../src/server/vault-app-grants.ts';

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
      const encrypted = await pool.query<{ ciphertext: string }>(
        'SELECT ciphertext FROM direct_oauth_accounts WHERE id=$1',
        [attempt.accountId],
      );
      assert.equal(encrypted.rows[0].ciphertext, '');
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
            'SELECT ciphertext FROM direct_oauth_accounts WHERE id=$1',
            [attempt.accountId],
          )
        ).rows[0].ciphertext,
        /refreshed-access-token/,
      );
      const legacyId = randomUUID();
      const nonce = randomBytes(12);
      const cipher = createCipheriv('aes-256-gcm', secretKey, nonce);
      cipher.setAAD(Buffer.from(`otto-direct-oauth-v1:${legacyId}`));
      const bytes = Buffer.concat([
        nonce,
        cipher.update(JSON.stringify({ clientId: 'legacy-client', accessToken: 'legacy-token' })),
        cipher.final(),
      ]);
      const legacyCiphertext = Buffer.concat([
        bytes.subarray(0, 12),
        cipher.getAuthTag(),
        bytes.subarray(12),
      ]).toString('base64');
      await pool.query(
        `INSERT INTO direct_oauth_accounts(id,owner_id,service,ciphertext,connected)
         VALUES($1,$2,'linear',$3,true)`,
        [legacyId, 'fixture-owner', legacyCiphertext],
      );
      const expiredId = randomUUID();
      await pool.query(
        `INSERT INTO direct_oauth_accounts(id,owner_id,service,ciphertext,connected,expires_at)
         VALUES($1,$2,'linear','expired',false,now()-interval '1 minute')`,
        [expiredId, 'fixture-owner'],
      );
      const migrated = createDirectOAuth({
        pool,
        keyStore,
        grantVault,
        ownerId: 'fixture-owner',
        request,
      });
      assert.equal((await migrated.access('fixture-owner', legacyId)).accessToken, 'legacy-token');
      assert.equal(
        (await pool.query('SELECT id FROM direct_oauth_accounts WHERE id=$1', [expiredId]))
          .rowCount,
        0,
      );
      assert.equal(
        (
          await pool.query<{ ciphertext: string }>(
            'SELECT ciphertext FROM direct_oauth_accounts WHERE id=$1',
            [legacyId],
          )
        ).rows[0].ciphertext,
        '',
      );
      await pool.query(
        `INSERT INTO direct_oauth_accounts(id,owner_id,service,ciphertext,connected)
         VALUES($1,$2,$3,$4,true)`,
        ['00000000-0000-0000-0000-000000000001', 'fixture-owner', 'linear', 'invalid'],
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
        resumeConnection: async (taskId, revision, service) => {
          resumes.push(`${taskId}:${revision}:${service}`);
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
      const taskId = randomUUID();
      await integrations.manageConnections('connect', 'linear', { id: taskId, revision: 3 });
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
      assert.deepEqual(resumes, [`${taskId}:3:linear`]);
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
