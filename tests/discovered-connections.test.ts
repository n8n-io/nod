import assert from 'node:assert/strict';
import { randomBytes, randomUUID } from 'node:crypto';
import test from 'node:test';
import Fastify from 'fastify';
import pg from 'pg';
import type { DiscoveredTransport } from '../src/ports/discovered.ts';
import type { IntegrationProvider, IntegrationSession } from '../src/ports/integrations.ts';
import { createDiscoveredConnections } from '../src/server/discovered-connections.ts';
import { createIntegrations } from '../src/server/integrations.ts';
import { createAppGrantVault } from '../src/server/vault-app-grants.ts';

test(
  'a researched account uses read and write paths with a private token',
  { skip: !process.env.TEST_DATABASE_URL },
  async () => {
    const schema = `discovered_${randomUUID().replaceAll('-', '')}`;
    const admin = new pg.Pool({ connectionString: process.env.TEST_DATABASE_URL });
    await admin.query(`CREATE SCHEMA ${schema}`);
    const pool = new pg.Pool({
      connectionString: process.env.TEST_DATABASE_URL,
      options: `-c search_path=${schema}`,
    });
    const app = Fastify();
    const token = 'fixture-private-token';
    const oauthToken = 'fixture-oauth-token';
    const secretKey = randomBytes(32);
    const calls: string[] = [];
    const cliCalls: Array<{
      taskId: string;
      command: string;
      args: string[];
      signal?: AbortSignal;
    }> = [];
    const task = { id: randomUUID(), revision: 7 };
    const transport: DiscoveredTransport = {
      validateEndpoint: async (endpoint) => endpoint,
      http: async (endpoint, headers, method, body) => {
        assert.equal(headers.Authorization, `Bearer ${token}`);
        calls.push(`${method} ${endpoint}`);
        if (endpoint.endsWith('/user')) return { status: 200, body: { login: 'fixture-user' } };
        if (method === 'GET') return { status: 200, body: { items: ['read result'] } };
        return { status: 201, body: { url: 'https://example.test/pull/1', echo: token, body } };
      },
      listTools: async (_endpoint, headers) => {
        assert.equal(
          headers.Authorization,
          `Bearer ${_endpoint.includes('fixturedesk') ? oauthToken : token}`,
        );
        return [
          {
            name: 'get_file_contents',
            description: 'Read GitHub file',
            inputSchema: {
              type: 'object',
            },
            annotations: { readOnlyHint: true },
          },
          {
            name: 'push_files',
            description: 'Push GitHub files',
            inputSchema: {
              type: 'object',
            },
            annotations: { readOnlyHint: false },
          },
          {
            name: 'create_pull_request',
            description: 'Create GitHub PR',
            inputSchema: {
              type: 'object',
            },
            annotations: { readOnlyHint: false },
          },
        ];
      },
      callTool: async (_endpoint, headers, name) => {
        const selectedToken = _endpoint.includes('fixturedesk') ? oauthToken : token;
        assert.equal(headers.Authorization, `Bearer ${selectedToken}`);
        calls.push(`MCP ${name}`);
        return { content: [{ type: 'text', text: `${name}: ${selectedToken}` }] };
      },
    };
    const nativeSession: IntegrationSession = {
      id: 'fixture',
      authorize: async () => {
        throw new Error('Unavailable.');
      },
      search: async () => ({ tools: {}, suggestions: [] }),
      execute: async () => {
        throw new Error('Unavailable.');
      },
    };
    const native: IntegrationProvider = {
      id: 'fixture',
      configured: false,
      webhooksConfigured: false,
      supportsSubscriptions: [],
      createSession: async () => nativeSession,
      restoreSession: async () => nativeSession,
      deleteSession: async () => {},
      inspectAccount: async () => ({ active: false, service: '' }),
      deleteAccount: async () => {},
      parseCallback: async () => ({ state: '', accountId: '', success: false }),
      subscribe: async () => {
        throw new Error('Unavailable.');
      },
      unsubscribe: async () => {},
      verifyWebhook: async () => {
        throw new Error('Unavailable.');
      },
      matchesSubscription: () => false,
    };
    const resumes: Array<[string, number, string]> = [];
    const browserEntry = {
      kind: 'login' as const,
      id: randomUUID(),
      label: 'Browser account',
      origin: 'https://github.com',
      usernameHint: 'fi…',
      updatedAt: new Date().toISOString(),
    };
    const otherBrowserEntry = {
      ...browserEntry,
      id: randomUUID(),
      origin: 'https://github.org',
    };
    let browserAccounts = [browserEntry, otherBrowserEntry];
    let oauthRefreshes = 0;
    try {
      const keyStore = { id: 'fixture', configured: true, getKey: async () => secretKey };
      const grantVault = await createAppGrantVault(pool, {
        ownerId: 'fixture-owner',
        keyStore,
      });
      const discovered = await createDiscoveredConnections(pool, {
        ownerId: 'fixture-owner',
        baseUrl: 'http://localhost:4310',
        keyStore,
        grantVault,
        transport,
        runCli: async (taskId, command, args, envName, suppliedToken, _timeout, signal) => {
          assert.equal(command, 'fixture');
          assert.equal(envName, 'FIXTURE_TOKEN');
          assert.equal(suppliedToken, token);
          cliCalls.push({ taskId, command, args, signal });
          return { exitCode: 0, output: `result ${suppliedToken}` };
        },
        oauth: {
          begin: async (endpoint, redirectUri, state, scope, clientId) => {
            assert.equal(endpoint, 'https://mcp.fixturedesk.test/mcp');
            assert.equal(redirectUri, 'http://127.0.0.1:4310/api/apps/callback');
            assert.equal(scope, 'read write');
            assert.equal(clientId, 'fixture-client');
            return {
              url: `https://login.fixturedesk.test/authorize?state=${state}`,
              saved: {
                redirectUri,
                scope,
                verifier: 'fixture-verifier',
              },
            };
          },
          finish: async (_endpoint, saved, code) => {
            assert.equal(code, 'fixture-code');
            return {
              ...saved,
              tokens: {
                access_token: oauthToken,
                token_type: 'Bearer',
                refresh_token: 'fixture-refresh',
              },
              expiresAt: Date.now() - 1,
            };
          },
          refresh: async (_endpoint, saved) => {
            oauthRefreshes += 1;
            return {
              ...saved,
              tokens: {
                access_token: oauthToken,
                token_type: 'Bearer',
                refresh_token: 'fixture-refresh',
              },
              expiresAt: Date.now() + 3600_000,
            };
          },
        },
        resumeConnection: async (id, revision, name) => {
          resumes.push([id, revision, name]);
          return true;
        },
      });
      const integrations = await createIntegrations(pool, {
        ownerId: 'fixture-owner',
        provider: native,
        baseUrl: 'http://localhost:4310',
        wake: async () => {},
        discovered,
        browserAccounts: async () => browserAccounts,
        removeBrowserAccount: async (id) => {
          browserAccounts = browserAccounts.filter((entry) => entry.id !== id);
        },
      });
      integrations.registerRoutes(app);
      const browser = (await integrations.list()).find(
        (item) => item.connectionId === browserEntry.id,
      );
      assert.match(browser?.slug ?? '', /^browser-github-com-/);
      assert.notEqual(
        browser?.slug,
        (await integrations.list()).find((item) => item.connectionId === otherBrowserEntry.id)
          ?.slug,
      );
      assert.deepEqual(browser?.accessPaths, [
        { id: browserEntry.id, kind: 'browser', endpoint: 'https://github.com' },
      ]);
      await assert.rejects(() =>
        integrations.manageConnections('propose', undefined, task, {
          service: 'fixturecli',
          name: 'Fixture CLI',
          paths: [
            {
              kind: 'cli',
              command: 'fixture',
              envName: 'FIXTURE_TOKEN',
              testArgs: ['record', 'create'],
            },
          ],
        }),
      );
      await assert.rejects(() =>
        integrations.manageConnections('propose', undefined, task, {
          service: 'fixturecli',
          name: 'Fixture CLI',
          paths: [
            { kind: 'cli', command: 'sh', envName: 'FIXTURE_TOKEN', testArgs: ['-c', 'true'] },
          ],
        }),
      );
      await assert.rejects(() =>
        integrations.manageConnections('propose', undefined, task, {
          service: 'github',
          name: 'GitHub',
          paths: [{ kind: 'http', endpoint: 'https://api.github.com/' }],
        }),
      );
      await assert.rejects(() =>
        integrations.manageConnections('propose', undefined, task, {
          service: 'github',
          name: 'GitHub',
          paths: [{ kind: 'http', endpoint: 'https://api.github.com/', testPath: 'https://[' }],
        }),
      );
      const proposed = await integrations.manageConnections('propose', undefined, task, {
        service: 'GitHub',
        name: 'GitHub',
        setupUrl: 'https://github.com/settings/tokens',
        setupText: 'Create a token with access to the repository and pull requests.',
        paths: [{ kind: 'mcp', endpoint: 'https://mcp.example.test/mcp' }],
      });
      const link = new URL((proposed as { url: string }).url, 'http://localhost:4310');
      const proposalId = link.searchParams.get('connect')!;
      const metadata = await app.inject({
        method: 'GET',
        url: `/api/apps/discovery/${proposalId}`,
      });
      assert.equal(metadata.statusCode, 200);
      assert.equal(metadata.body.includes(token), false);
      assert.equal(metadata.json().paths.length, 1);
      assert.equal(metadata.json().setupUrl, 'https://github.com/settings/tokens');
      assert.match(metadata.json().setupText, /repository and pull requests/);
      const complete = await app.inject({
        method: 'POST',
        url: `/api/apps/discovery/${proposalId}/complete`,
        payload: { token, accountName: 'fixture-user' },
      });
      assert.equal(complete.statusCode, 200);
      assert.equal(complete.json().continued, true);
      assert.deepEqual(resumes, [[task.id, task.revision, 'GitHub']]);
      const ciphertext = (
        await pool.query<{ ciphertext: string }>('SELECT ciphertext FROM vault_app_grants')
      ).rows[0]?.ciphertext;
      assert.ok(ciphertext);
      assert.equal(ciphertext!.includes(token), false);
      assert.equal(
        (await pool.query<{ ciphertext: string }>('SELECT ciphertext FROM discovered_connections'))
          .rows[0]?.ciphertext,
        '',
      );
      const saved = (await integrations.list()).find((item) => item.slug === 'github')!;
      const foreignVault = await createAppGrantVault(pool, {
        ownerId: 'other-owner',
        keyStore,
      });
      await assert.rejects(() => foreignVault.read(saved.connectionId!));
      assert.equal(saved.accountName, 'fixture-user');
      assert.deepEqual(
        saved.accessPaths?.map((path) => path.kind),
        ['mcp'],
      );
      const [mcpPath] = saved.accessPaths!;
      const search = await integrations.execute('fixture-owner', 'SEARCH_TOOLS', {
        query: 'GitHub',
      });
      assert.equal(JSON.stringify(search).includes(token), false);
      assert.equal((search as { discovered: Array<unknown> }).discovered.length, 1);
      const named = (search as { discovered: Array<{ paths: Array<{ toolNames?: string[] }> }> })
        .discovered[0].paths[0].toolNames;
      assert.ok(named?.includes('push_files'));
      const pushSearch = await integrations.execute('fixture-owner', 'SEARCH_TOOLS', {
        query: 'push_files',
      });
      assert.equal(
        (pushSearch as { discovered: Array<{ paths: Array<{ tools: Array<{ name: string }> }> }> })
          .discovered[0].paths[0].tools[0].name,
        'push_files',
      );
      const read = await integrations.execute('fixture-owner', 'CONNECTED_MCP_CALL', {
        connectionId: saved.connectionId,
        pathId: mcpPath.id,
        tool: 'get_file_contents',
        input: { owner: 'demo', repo: 'app', path: 'README.md' },
      });
      assert.equal(JSON.stringify(read).includes(token), false);
      const pushArgs = {
        connectionId: saved.connectionId,
        pathId: mcpPath.id,
        tool: 'push_files',
        input: { owner: 'demo', repo: 'app', branch: 'feature', files: [] },
      };
      const push = await integrations.execute('fixture-owner', 'CONNECTED_MCP_CALL', pushArgs);
      assert.equal((push as { requiresApproval: boolean }).requiresApproval, true);
      await integrations.validateApproval('fixture-owner', 'CONNECTED_MCP_CALL', pushArgs);
      await integrations.executeApproved('fixture-owner', 'CONNECTED_MCP_CALL', pushArgs);
      const prArgs = {
        connectionId: saved.connectionId,
        pathId: mcpPath.id,
        tool: 'create_pull_request',
        input: { owner: 'demo', repo: 'app', head: 'feature' },
      };
      const mcpWrite = await integrations.execute('fixture-owner', 'CONNECTED_MCP_CALL', prArgs);
      assert.equal((mcpWrite as { requiresApproval: boolean }).requiresApproval, true);
      await integrations.validateApproval('fixture-owner', 'CONNECTED_MCP_CALL', prArgs);
      await integrations.executeApproved('fixture-owner', 'CONNECTED_MCP_CALL', prArgs);
      assert.ok(calls.includes('MCP push_files'));
      assert.ok(calls.includes('MCP create_pull_request'));
      const replacement = await integrations.manageConnections('propose', undefined, undefined, {
        service: 'github',
        name: 'GitHub API',
        connectionId: saved.connectionId,
        paths: [{ kind: 'http', endpoint: 'https://api.example.test/v1', testPath: '/user' }],
      });
      const replacementId = new URL(
        (replacement as { url: string }).url,
        'http://localhost:4310',
      ).searchParams.get('connect')!;
      const replaced = await app.inject({
        method: 'POST',
        url: `/api/apps/discovery/${replacementId}/complete`,
        payload: { token, accountName: 'fixture-user' },
      });
      assert.equal(replaced.statusCode, 200);
      const refreshed = (await integrations.list()).find((item) => item.slug === 'github')!;
      assert.equal(refreshed.connectionId, saved.connectionId);
      assert.equal(refreshed.name, 'GitHub');
      assert.deepEqual(
        refreshed.accessPaths?.map((path) => path.kind),
        ['http'],
      );
      const [httpPath] = refreshed.accessPaths!;
      await assert.rejects(() =>
        integrations.execute('fixture-owner', 'CONNECTED_MCP_CALL', {
          connectionId: saved.connectionId,
          pathId: mcpPath.id,
          tool: 'get_file_contents',
          input: {},
        }),
      );
      const apiRead = await integrations.execute('fixture-owner', 'CONNECTED_HTTP', {
        connectionId: saved.connectionId,
        pathId: httpPath.id,
        method: 'GET',
        path: '/repos/demo/app/branches',
      });
      assert.deepEqual((apiRead as { body: unknown }).body, { items: ['read result'] });
      for (const [method, path] of [
        ['PATCH', '/repos/demo/app/git/refs/heads/feature'],
        ['POST', '/repos/demo/app/pulls'],
      ]) {
        const args = {
          connectionId: saved.connectionId,
          pathId: httpPath.id,
          method,
          path,
          body: { title: 'Change' },
        };
        const reviewed = await integrations.execute('fixture-owner', 'CONNECTED_HTTP', args);
        assert.equal((reviewed as { requiresApproval: boolean }).requiresApproval, true);
        await integrations.validateApproval('fixture-owner', 'CONNECTED_HTTP', args);
        const result = await integrations.executeApproved('fixture-owner', 'CONNECTED_HTTP', args);
        assert.equal(JSON.stringify(result).includes(token), false);
      }
      assert.ok(
        calls.includes('PATCH https://api.example.test/v1/repos/demo/app/git/refs/heads/feature'),
      );
      assert.ok(calls.includes('POST https://api.example.test/v1/repos/demo/app/pulls'));
      const cliProposal = await integrations.manageConnections('propose', undefined, task, {
        service: 'fixturecli',
        name: 'Fixture CLI',
        paths: [
          {
            kind: 'cli',
            command: 'fixture',
            envName: 'FIXTURE_TOKEN',
            testArgs: ['account', 'show'],
          },
        ],
      });
      const cliId = new URL(
        (cliProposal as { url: string }).url,
        'http://localhost:4310',
      ).searchParams.get('connect')!;
      const cliMetadata = await app.inject({ method: 'GET', url: `/api/apps/discovery/${cliId}` });
      assert.equal(cliMetadata.statusCode, 200);
      assert.deepEqual(cliMetadata.json().paths[0], {
        kind: 'cli',
        command: 'fixture',
        auth: 'env',
        envName: 'FIXTURE_TOKEN',
        testArgs: ['account', 'show'],
      });
      assert.equal(
        (
          await app.inject({
            method: 'POST',
            url: `/api/apps/discovery/${cliId}/complete`,
            payload: { token, accountName: 'fixture-user' },
          })
        ).statusCode,
        200,
      );
      const cliAccount = (await integrations.list()).find((item) => item.slug === 'fixturecli')!;
      assert.equal(cliAccount.accessPaths?.[0].kind, 'cli');
      assert.equal(cliAccount.accessPaths?.[0].endpoint, 'fixture');
      const cliPath = cliAccount.accessPaths![0];
      const cliSearch = await integrations.execute('fixture-owner', 'SEARCH_TOOLS', {
        query: 'fixturecli',
      });
      assert.equal(JSON.stringify(cliSearch).includes(token), false);
      const cliRead = await integrations.execute(
        'fixture-owner',
        'CONNECTED_CLI',
        {
          connectionId: cliAccount.connectionId,
          pathId: cliPath.id,
          argv: ['account', 'show'],
        },
        task.id,
      );
      assert.equal(JSON.stringify(cliRead).includes(token), false);
      assert.equal((cliRead as { output: string }).output, 'result [redacted]');
      const cliSignal = new AbortController().signal;
      const declaredRead = await integrations.execute(
        'fixture-owner',
        'CONNECTED_CLI',
        {
          connectionId: cliAccount.connectionId,
          pathId: cliPath.id,
          argv: ['account', 'list'],
          readOnly: true,
        },
        task.id,
        cliSignal,
      );
      assert.equal((declaredRead as { output: string }).output, 'result [redacted]');
      assert.equal(cliCalls.at(-1)?.signal, cliSignal);
      const cliWriteArgs = {
        connectionId: cliAccount.connectionId,
        pathId: cliPath.id,
        argv: ['record', 'create'],
      };
      assert.equal(
        (
          (await integrations.execute('fixture-owner', 'CONNECTED_CLI', cliWriteArgs, task.id)) as {
            requiresApproval: boolean;
          }
        ).requiresApproval,
        true,
      );
      await integrations.validateApproval('fixture-owner', 'CONNECTED_CLI', cliWriteArgs);
      const cliWrite = await integrations.executeApproved(
        'fixture-owner',
        'CONNECTED_CLI',
        cliWriteArgs,
        task.id,
      );
      assert.equal(JSON.stringify(cliWrite).includes(token), false);
      assert.equal(
        (
          (await integrations.execute(
            'fixture-owner',
            'CONNECTED_CLI',
            { ...cliWriteArgs, readOnly: true },
            task.id,
          )) as { requiresApproval: boolean }
        ).requiresApproval,
        true,
      );
      assert.equal(
        (
          (await integrations.execute(
            'fixture-owner',
            'CONNECTED_CLI',
            {
              connectionId: cliAccount.connectionId,
              pathId: cliPath.id,
              argv: ['api', 'records', '--method', 'POST'],
              readOnly: true,
            },
            task.id,
          )) as { requiresApproval: boolean }
        ).requiresApproval,
        true,
      );
      assert.deepEqual(
        cliCalls.map((call) => call.args),
        [
          ['account', 'show'],
          ['account', 'show'],
          ['account', 'list'],
          ['record', 'create'],
        ],
      );
      assert.deepEqual(
        cliCalls.map((call) => call.taskId),
        [task.id, task.id, task.id, task.id],
      );
      assert.ok(cliCalls.every((call) => call.command === 'fixture'));
      assert.equal(
        (
          await pool.query<{ ciphertext: string }>(
            'SELECT ciphertext FROM vault_app_grants WHERE id=$1',
            [cliAccount.connectionId],
          )
        ).rows[0].ciphertext.includes(token),
        false,
      );
      await assert.rejects(() =>
        integrations.execute('fixture-owner', 'CONNECTED_HTTP', {
          connectionId: saved.connectionId,
          pathId: httpPath.id,
          method: 'GET',
          path: 'https://different.example.test/user',
        }),
      );
      for (const path of ['%2e%2e%2fadmin', '%252e%252e%252fadmin'])
        await assert.rejects(() =>
          integrations.execute('fixture-owner', 'CONNECTED_HTTP', {
            connectionId: saved.connectionId,
            pathId: httpPath.id,
            method: 'GET',
            path,
          }),
        );
      const oauthProposal = await integrations.manageConnections('propose', undefined, task, {
        service: 'fixturedesk',
        name: 'Fixture Desk',
        paths: [
          {
            kind: 'mcp',
            endpoint: 'https://mcp.fixturedesk.test/mcp',
            auth: 'oauth',
            scope: 'read write',
            clientIdRequired: true,
          },
        ],
      });
      const oauthId = new URL(
        (oauthProposal as { url: string }).url,
        'http://localhost:4310',
      ).searchParams.get('connect')!;
      const oauthDetails = await app.inject({
        method: 'GET',
        url: `/api/apps/discovery/${oauthId}`,
      });
      assert.equal(oauthDetails.json().paths[0].auth, 'oauth');
      assert.equal(oauthDetails.json().callbackUrl, 'http://127.0.0.1:4310/api/apps/callback');
      const started = await app.inject({
        method: 'POST',
        url: `/api/apps/discovery/${oauthId}/authorize`,
        payload: { clientId: 'fixture-client' },
      });
      assert.equal(started.statusCode, 200);
      assert.equal(
        (
          await pool.query<{ oauth_ciphertext: string | null }>(
            'SELECT oauth_ciphertext FROM discovered_connection_proposals WHERE id=$1',
            [oauthId],
          )
        ).rows[0].oauth_ciphertext,
        null,
      );
      assert.equal((await grantVault.read(oauthId)).value.includes('fixture-verifier'), true);
      const state = new URL(started.json().url).searchParams.get('state')!;
      const callback = await app.inject({
        method: 'GET',
        url: `/api/apps/callback?state=${state}&code=fixture-code`,
      });
      assert.equal(callback.statusCode, 302);
      assert.match(callback.headers.location ?? '', /connection=continued/);
      assert.deepEqual(resumes.at(-1), [task.id, task.revision, 'Fixture Desk']);
      const oauthAccount = (await integrations.list()).find((item) => item.slug === 'fixturedesk')!;
      assert.equal(oauthAccount.accessPaths?.[0].kind, 'mcp');
      assert.equal(
        (
          await pool.query<{ ciphertext: string }>(
            'SELECT ciphertext FROM vault_app_grants WHERE id=$1',
            [oauthAccount.connectionId],
          )
        ).rows[0].ciphertext.includes(oauthToken),
        false,
      );
      const oauthRead = await integrations.execute('fixture-owner', 'CONNECTED_MCP_CALL', {
        connectionId: oauthAccount.connectionId,
        pathId: oauthAccount.accessPaths![0].id,
        tool: 'get_file_contents',
        input: {},
      });
      assert.equal(JSON.stringify(oauthRead).includes(oauthToken), false);
      assert.equal(oauthRefreshes, 1);
      await assert.rejects(() => grantVault.read(oauthId));
      const knownProposal = await integrations.manageConnections('propose', undefined, undefined, {
        service: 'notion',
        name: 'Notion',
        paths: [{ kind: 'http', endpoint: 'https://api.example.test/v1', testPath: '/user' }],
      });
      const knownId = new URL(
        (knownProposal as { url: string }).url,
        'http://localhost:4310',
      ).searchParams.get('connect')!;
      assert.equal(
        (
          await app.inject({
            method: 'POST',
            url: `/api/apps/discovery/${knownId}/complete`,
            payload: { token, accountName: 'fixture-user' },
          })
        ).statusCode,
        200,
      );
      const known = (await integrations.list()).find(
        (item) => item.slug === 'notion' && item.accessPaths?.[0]?.kind === 'http',
      )!;
      const another = await app.inject({
        method: 'POST',
        url: '/api/apps/notion/connect',
        payload: { connectionId: known.connectionId, returnTo: 'apps' },
      });
      assert.equal(another.statusCode, 200);
      assert.match(another.json().url, /^\/apps\?connect=/);
      const knownRemoved = await app.inject({
        method: 'POST',
        url: `/api/apps/notion/accounts/${known.connectionId}/disconnect`,
        payload: {},
      });
      assert.equal(knownRemoved.statusCode, 200);
      await assert.rejects(() => grantVault.read(known.connectionId!));
      const removed = await app.inject({
        method: 'POST',
        url: `/api/apps/github/accounts/${saved.connectionId}/disconnect`,
        payload: {},
      });
      assert.equal(removed.statusCode, 200);
      await assert.rejects(() => grantVault.read(saved.connectionId!));
      const browserRemoved = await app.inject({
        method: 'POST',
        url: `/api/apps/${browser!.slug}/accounts/${browserEntry.id}/disconnect`,
        payload: {},
      });
      assert.equal(browserRemoved.statusCode, 200);
      assert.equal(browserAccounts.length, 1);
      assert.ok((await integrations.list()).some((item) => item.slug === 'fixturedesk'));
      await assert.rejects(() =>
        integrations.execute('fixture-owner', 'CONNECTED_HTTP', {
          connectionId: saved.connectionId,
          pathId: httpPath.id,
          method: 'GET',
          path: '/user',
        }),
      );
    } finally {
      await app.close();
      await pool.end();
      await admin.query(`DROP SCHEMA ${schema} CASCADE`);
      await admin.end();
    }
  },
);
