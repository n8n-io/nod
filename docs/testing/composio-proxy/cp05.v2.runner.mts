import pg from 'pg';
import Fastify from 'fastify';
import assert from 'node:assert/strict';
import { createHash, createPrivateKey, randomUUID } from 'node:crypto';
import { mkdtemp, rm, readFile, writeFile, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve, relative } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { execFileSync } from 'node:child_process';
import { parseArgs } from 'node:util';

const repository = fileURLToPath(new URL('../../../', import.meta.url));
const { values } = parseArgs({
  options: {
    mode: { type: 'string' },
    'freeze-id': { type: 'string' },
    'proxy-root': { type: 'string' },
    inputs: { type: 'string', default: 'docs/testing/composio-proxy/cp05.v2.inputs.json' },
    output: { type: 'string', default: 'docs/testing/composio-proxy/cp05.v2.results.json' },
  },
});
assert.ok(
  ['freeze', 'run'].includes(values.mode ?? ''),
  'Explicit freeze or run mode is required.',
);
assert.ok(
  values['freeze-id'] && /^CP05\.v2-a\d{2}$/.test(values['freeze-id']),
  'An exact freeze ID is required.',
);
assert.ok(values['proxy-root'], 'An explicit companion proxy checkout is required.');
assert.equal(process.version, 'v24.21.0');
const proxyRoot = resolve(values['proxy-root']);
const inputPath = resolve(repository, values.inputs);
const outputPath = resolve(repository, values.output);
const runnerPath = fileURLToPath(import.meta.url);
const hash = (bytes: Uint8Array | string) => createHash('sha256').update(bytes).digest('hex');
const md5 = (bytes: Uint8Array) => createHash('md5').update(bytes).digest('hex');
const git = (root: string, args: string[]) =>
  execFileSync('git', args, { cwd: root, encoding: 'utf8' }).trim();
const serialize = async (value: unknown) => {
  const prettier = await import('prettier');
  return prettier.format(JSON.stringify(value), {
    ...(await prettier.resolveConfig(inputPath)),
    parser: 'json',
  });
};
const previousPath = join(repository, 'docs/testing/composio-proxy/cp05.v1.inputs.json');
const previousResultsPath = join(repository, 'docs/testing/composio-proxy/cp05.v1.results.json');
const prompt = 'Attach this workspace file to my draft.';

if (values.mode === 'freeze') {
  const previous = JSON.parse(await readFile(previousPath, 'utf8'));
  const { build } = await import('esbuild');
  const sourceHashes: Record<string, Record<string, string>> = {};
  for (const [scope, directory, entryPoints] of [
    [
      'otto',
      repository,
      [
        'src/server/integrations.ts',
        'src/server/provider-metering.ts',
        'src/providers/composio/proxy.ts',
        'src/providers/composio/integrations.ts',
      ],
    ],
    ['proxy', proxyRoot, ['src/index.ts', 'src/files.ts', 'src/security.ts']],
  ] as const) {
    const bundled = await build({
      absWorkingDir: directory,
      entryPoints: [...entryPoints],
      bundle: true,
      write: false,
      metafile: true,
      packages: 'external',
      platform: 'node',
      format: 'esm',
      outdir: join(tmpdir(), 'cp05-metadata-unused'),
      logLevel: 'silent',
    });
    const paths = [
      ...new Set([...Object.keys(bundled.metafile!.inputs), 'package.json', 'package-lock.json']),
    ].sort();
    sourceHashes[scope] = Object.fromEntries(
      await Promise.all(
        paths.map(async (path) => [path, hash(await readFile(join(directory, path)))]),
      ),
    );
  }
  const baseFiles = previous.freezes.find(
    (entry: any) => entry.id === 'CP05.storage-prerequisite.v1',
  ).files;
  const frozen = {
    id: values['freeze-id'],
    case: 'CP05.v2',
    frozenAt: new Date().toISOString(),
    prompt,
    promptSha256: hash(prompt),
    reason:
      'Add exact freeze/script/input binding, response-header scans, strict cleanup, and the production metering wrapper including restored-session upload with another selected account. Preserve CP05.v1 unchanged.',
    scope:
      'Actual Otto createIntegrations + meterIntegrations + Composio SDK + Worker against independent stateful storage/provider/draft fixtures and disposable PostgreSQL schemas. No model or real provider call.',
    model: 'none',
    runtime: process.version,
    platform: process.platform,
    arch: process.arch,
    timeLimitSeconds: 600,
    repeats: { base: 1, holdout: 1 },
    ottoCommit: git(repository, ['rev-parse', 'HEAD']),
    proxyCommit: git(proxyRoot, ['rev-parse', 'HEAD']),
    sourceHashes,
    runner: relative(repository, runnerPath),
    runnerSha256: hash(await readFile(runnerPath)),
    databaseUrl: 'postgresql://otto:otto@127.0.0.1:60516/otto',
    databaseScope:
      'New random schema for each variant. No normal schema reads or writes. Drop every created schema after the variant.',
    variants: [
      { id: 'base', first: 'base.bin', second: 'base.bin' },
      { id: 'holdout', first: 'collision-a.bin', second: 'collision-b.bin' },
    ],
    files: baseFiles,
    inputContents: previous.inputContents,
    expected: {
      receivingDraftsPerVariant: 3,
      deniedAttacksPerVariant: 6,
      workspaceReadsPerVariant: 3,
      uploadAccounts: ['owner-a/account-a', 'owner-b/account-b', 'owner-a/account-a2'],
      restoredUploadsPerVariant: 1,
    },
    checks: [
      {
        id: 'BINDING',
        applies: 'Every run',
        pass: 'Exact freeze ID, runner, source closure, lockfiles, Worker revision and every input byte/hash match before and after; collision hashes are equal MD5 and unequal SHA256.',
        evidence: 'Executable guards and per-file independent hashes',
        method: 'code',
      },
      {
        id: 'BYTES',
        applies: 'Every variant',
        pass: 'Three source files match the independently stored bytes and receiving draft SHA256/length.',
        evidence: 'Workspace reads, storage map and draft receiver',
        method: 'code',
      },
      {
        id: 'FILEOWNER',
        applies: 'Every variant',
        pass: 'Wrong owner/account/action, raw key, foreign deletion and private mount attacks fail without extra draft or mutation.',
        evidence: 'Six rejected requests and stable receiving/object counts',
        method: 'code',
      },
      {
        id: 'IMMUTABLE',
        applies: 'Every variant',
        pass: 'Same filenames and equal-content or MD5-collision inputs use distinct object keys; a later upload leaves prior bytes unchanged.',
        evidence: 'Independent storage map keys and SHA256',
        method: 'code',
      },
      {
        id: 'ACTION',
        applies: 'Every variant',
        pass: 'Real prepare and executeApproved through real meterIntegrations produce three drafts for A, B, A2; A2 uploads from a restored session and prepared capabilities survive original source-session deletion.',
        evidence:
          'Usage operations, signed upload account IDs, authoritative upstream sessions and receiving drafts',
        method: 'code',
      },
      {
        id: 'SECRET',
        applies: 'Every public request and response',
        pass: 'Public request headers/body and response headers/body exclude synthetic project/provider/encryption secrets and task-generated private key encodings; responses also exclude raw object keys/storage host. Storage PUT has no project or authorization header.',
        evidence: 'Fail-closed scans and injected-header scanner control',
        method: 'code',
      },
      {
        id: 'CLEANUP',
        applies: 'Every variant',
        pass: 'Every explicit file/session deletion succeeds; no stored files, mounts, fixture sessions or owned SQL schemas remain; cleanup failures fail the attempt.',
        evidence: 'Delete receipts, map counts and SQL catalog absence',
        method: 'code',
      },
      {
        id: 'BOUNDED',
        applies: 'Every variant',
        pass: 'Completes once within 600 seconds and no unexpected fetch, live model, connected-account or recipient call occurs.',
        evidence: 'Elapsed timer and deny-by-default transports',
        method: 'code',
      },
    ],
    historicalEvidence: {
      inputs: {
        path: relative(repository, previousPath),
        sha256: hash(await readFile(previousPath)),
      },
      results: {
        path: relative(repository, previousResultsPath),
        sha256: hash(await readFile(previousResultsPath)),
      },
      reuse:
        'The original empty-session real storage prerequisite and 15 MiB workerd run are historical evidence only. They are not rerun here. CP05.v2 scores only the current synthetic metered app path; no new claim about live Gmail delivery, provider cleanup or 24-hour retention.',
    },
    commands: {
      freeze:
        'node --experimental-transform-types docs/testing/composio-proxy/cp05.v2.runner.mts --mode freeze --freeze-id ' +
        values['freeze-id'] +
        ' --proxy-root <companion-checkout>',
      run:
        'node --experimental-transform-types docs/testing/composio-proxy/cp05.v2.runner.mts --mode run --freeze-id ' +
        values['freeze-id'] +
        ' --proxy-root <companion-checkout>',
    },
  };
  assert.equal(
    git(proxyRoot, ['status', '--porcelain']),
    '',
    'The companion source must be clean.',
  );
  await writeFile(inputPath, await serialize(frozen), { flag: 'wx' });
  console.log(
    JSON.stringify({
      frozen: frozen.id,
      inputsSha256: hash(await readFile(inputPath)),
      sources: Object.fromEntries(
        Object.entries(sourceHashes).map(([scope, files]) => [scope, Object.keys(files).length]),
      ),
    }),
  );
  process.exit(0);
}

const frozenBytes = await readFile(inputPath);
const frozen = JSON.parse(frozenBytes.toString());
assert.equal(
  frozen.id,
  values['freeze-id'],
  'The requested freeze does not match the exact input file.',
);
assert.equal(frozen.case, 'CP05.v2');
assert.deepEqual(
  frozen.variants.map((variant: any) => variant.id),
  ['base', 'holdout'],
);
assert.deepEqual(frozen.repeats, { base: 1, holdout: 1 });
assert.equal(frozen.timeLimitSeconds, 600);
assert.equal(process.env.COMPOSIO_API_KEY, undefined, 'Run with a scrubbed environment.');
let unexpectedOutbound = 0;
globalThis.fetch = async () => {
  unexpectedOutbound++;
  throw new Error('Unexpected outbound fetch is forbidden.');
};
async function verifyBinding() {
  assert.equal(hash(await readFile(inputPath)), hash(frozenBytes), 'Frozen input bytes changed.');
  assert.equal(hash(await readFile(runnerPath)), frozen.runnerSha256, 'Evaluator source changed.');
  assert.equal(hash(prompt), frozen.promptSha256);
  assert.equal(git(proxyRoot, ['rev-parse', 'HEAD']), frozen.proxyCommit);
  for (const [scope, files] of Object.entries(frozen.sourceHashes) as Array<
    [string, Record<string, string>]
  >) {
    const directory = scope === 'otto' ? repository : proxyRoot;
    for (const [path, expected] of Object.entries(files))
      assert.equal(
        hash(await readFile(join(directory, path))),
        expected,
        'Frozen source mismatch: ' + scope + '/' + path,
      );
  }
  for (const evidence of [frozen.historicalEvidence.inputs, frozen.historicalEvidence.results])
    assert.equal(hash(await readFile(join(repository, evidence.path))), evidence.sha256);
}
await verifyBinding();
const { createIntegrations } = await import('../../../src/server/integrations.ts');
const { meterIntegrations } = await import('../../../src/server/provider-metering.ts');
const { createComposioProxy } = await import('../../../src/providers/composio/proxy.ts');
const { createComposioProvider } = await import('../../../src/providers/composio/integrations.ts');
const { createHandler } = await import(pathToFileURL(join(proxyRoot, 'src/index.ts')).href);
const { fileHelper } = await import(pathToFileURL(join(proxyRoot, 'src/files.ts')).href);
const { randomToken } = await import(pathToFileURL(join(proxyRoot, 'src/security.ts')).href);
const root = await mkdtemp(join(tmpdir(), 'otto-cp05-v2-'));
const secretValues = new Set<string>();
const rememberSecret = (value: string | Uint8Array) => {
  const bytes = typeof value === 'string' ? Buffer.from(value) : Buffer.from(value);
  for (const text of [
    bytes.toString(),
    bytes.toString('hex'),
    bytes.toString('base64'),
    bytes.toString('base64url'),
  ]) {
    if (text.length >= 16) {
      secretValues.add(text);
      secretValues.add(encodeURIComponent(text));
    }
  }
};
const assertNoSecrets = (text: string) => {
  if ([...secretValues].some((value) => text.includes(value)))
    throw new Error('A synthetic secret crossed the public boundary.');
};
const wireText = async (value: Request | Response) =>
  JSON.stringify([...value.headers]) + '\n' + (await value.clone().text());
const results: any[] = [];
const cleanupErrors: string[] = [];
const inputEvidence: any[] = [];
const usageEvents: any[] = [];
const publicUploads: any[] = [];
let headerControl = false;
let privateEncodingsRegistered = 0;
let sourceBindingBefore = true;
let sourceBindingAfter = false;
const startedAt = new Date().toISOString();
const origin = 'https://broker.example';
const storageHost = '4d4f16c61d89ec64e760039c4ec50717.r2.cloudflarestorage.com';
const used = new Set<string>();
const sessions = new Map<string, any>();
const accountOwners = new Map<string, string>();
const fileMounts = new Map<string, { path: string; key: string }>();
const stored = new Map<string, Uint8Array>();
const upstreamCalls: Array<{ path: string; method: string; body: any }> = [];
const publicCalls: Array<{ path: string; status: number }> = [];
const executed: any[] = [];
let sequence = 0;
const env: any = {
  PUBLIC_ORIGIN: origin,
  COMPOSIO_API_KEY: 'synthetic-project-secret',
  BROKER_ENCRYPTION_KEY: randomToken(),
  AUTH_CONFIGS_JSON: '{}',
  OAUTH_VERIFIER_ENABLED: 'true',
  REQUEST_LIMITER: { limit: async () => ({ success: true }) },
  BROWSER_LIMITER: { limit: async () => ({ success: true }) },
  REPLAY_GUARD: {
    idFromName: (x: string) => x,
    get: () => ({
      fetch: async (req: Request) => {
        const { digest } = (await req.json()) as any;
        if (used.has(digest)) return new Response('', { status: 409 });
        used.add(digest);
        return new Response('');
      },
    }),
  },
};
const account = (id: string) => ({
  id,
  user_id: accountOwners.get(id),
  toolkit: { slug: 'gmail' },
  auth_config: {
    id: 'ac_gmail',
    auth_scheme: 'OAUTH2',
    is_composio_managed: true,
    is_disabled: false,
  },
  status: 'ACTIVE',
  is_disabled: false,
  status_reason: null,
  created_at: '2026-10-08T00:00:00Z',
  updated_at: '2026-10-08T00:00:00Z',
  state: { authScheme: 'OAUTH2', val: { access_token: 'must-be-stripped' } },
});
const upstream: typeof fetch = async (input, init) => {
  const request = new Request(input, init);
  const url = new URL(request.url);
  if (url.hostname === storageHost) {
    assert.equal(request.method, 'PUT');
    assert.equal(request.headers.get('x-api-key'), null);
    assert.equal(request.headers.get('authorization'), null);
    assert.equal(request.headers.get('content-type'), 'application/octet-stream');
    const storageKey = decodeURIComponent(url.pathname).slice('/temp/'.length);
    assert.equal(stored.has(storageKey), false, 'An immutable fixture object was overwritten.');
    stored.set(storageKey, new Uint8Array(await request.arrayBuffer()));
    return new Response('', { status: 200 });
  }
  assert.equal(url.origin, 'https://backend.composio.dev');
  assert.equal(request.headers.get('x-api-key'), env.COMPOSIO_API_KEY);
  const path = url.pathname.replace('/api/v3.1', '');
  const body: any = request.body ? await request.json() : undefined;
  upstreamCalls.push({ path, method: request.method, body });
  if (path === '/toolkits')
    return Response.json({
      items: [
        'gmail',
        'googlecalendar',
        'googledrive',
        'googlesheets',
        'googledocs',
        'slack',
        'notion',
      ].map((slug) => ({ slug, type: 'native' })),
      next_cursor: null,
    });
  if (path.startsWith('/tools/') && request.method === 'GET')
    return Response.json({ slug: path.split('/').at(-1), toolkit: { slug: 'gmail' } });
  if (path.startsWith('/toolkits/'))
    return Response.json({ slug: path.split('/').at(-1), type: 'native', enabled: true });
  if (path.startsWith('/connected_accounts/')) {
    const id = path.split('/').at(-1)!;
    return accountOwners.has(id)
      ? Response.json(account(id))
      : Response.json({ error: 'missing' }, { status: 404 });
  }
  if (path === '/tool_router/session') {
    const id = 'session_' + sequence++;
    const connected = Object.fromEntries(
      Object.entries(body.connected_accounts ?? {}).map(([key, value]) => [
        key,
        Array.isArray(value) ? value : [value],
      ]),
    );
    const value = {
      session_id: id,
      config: {
        ...body,
        connected_accounts: connected,
        toolkits: { enabled: body.toolkits?.enable ?? [], disabled: [] },
        workbench: {
          enable: body.workbench?.enable ?? false,
          tool_execution_enabled: body.workbench?.enable_tool_execution ?? true,
          proxy_execution_enabled: body.workbench?.enable_proxy_execution ?? true,
        },
      },
      mcp: {
        type: 'http',
        url: 'https://backend.composio.dev/mcp',
        headers: { 'x-api-key': env.COMPOSIO_API_KEY },
      },
      config_version: 1,
    };
    sessions.set(id, value);
    return Response.json(value);
  }
  const match = path.match(/^\/tool_router\/session\/([^/]+)(?:\/(.+))?$/);
  if (match) {
    const session = sessions.get(match[1]);
    if (!session) return Response.json({ error: 'missing' }, { status: 404 });
    if (request.method === 'GET') return Response.json(session);
    if (request.method === 'DELETE') {
      assert.equal(fileMounts.has(match[1]), false, 'A session was deleted before its file.');
      sessions.delete(match[1]);
      return Response.json({ session_id: match[1], deleted: true });
    }
    if (match[2] === 'mounts/files/upload_url') {
      const key = `tool_router/${session.config.user_id}/${match[1]}/${body.mount_relative_path}`;
      fileMounts.set(match[1], { path: body.mount_relative_path, key });
      return Response.json(
        {
          upload_url: `https://${storageHost}/temp/${key}?X-Amz-SignedHeaders=host`,
          mount_relative_path: body.mount_relative_path,
          sandbox_mount_prefix: '/mnt/files',
          expires_at: '2099-01-01T00:00:00Z',
        },
        { status: 201 },
      );
    }
    if (match[2] === 'mounts/files/delete') {
      const file = fileMounts.get(match[1]);
      assert.equal(body.mount_relative_path, file?.path);
      if (file) stored.delete(file.key);
      fileMounts.delete(match[1]);
      return Response.json({
        mount_relative_path: body.mount_relative_path,
        sandbox_mount_prefix: '/mnt/files',
      });
    }
    if (match[2] === 'execute_meta' && body.slug === 'COMPOSIO_REMOTE_WORKBENCH') {
      const file = fileMounts.get(match[1])!;
      assert.equal(body.arguments.code_to_execute, fileHelper(file.path));
      assert.equal(session.config.workbench.tool_execution_enabled, false);
      assert.equal(session.config.workbench.proxy_execution_enabled, false);
      assert.deepEqual(session.config.toolkits.enabled, []);
      const content = stored.get(file.key)!;
      return Response.json({
        result_type: 'completed',
        data: {
          stdout:
            JSON.stringify({
              otto_file_key: [file.key, ''],
              sha256: hash(content),
              size: content.length,
            }) + '\n',
          stderr: '',
          error: '',
          results: '',
        },
        error: null,
        log_id: 'log_file',
      });
    }
    if (match[2] === 'execute') {
      const attachment = body.arguments.attachment;
      const content = stored.get(attachment.s3key);
      assert.ok(content);
      assert.equal(accountOwners.get(body.account), session.config.user_id);
      executed.push({ ...body, sessionId: match[1], sha256: hash(content), bytes: content.length });
      return Response.json({
        data: { draftId: 'draft-' + executed.length, sha256: hash(content), bytes: content.length },
        error: null,
        log_id: 'log_fixture',
      });
    }
    if (match[2] === 'execute_meta')
      return Response.json({
        error: null,
        successful: true,
        data: {
          success: true,
          tool_schemas: {
            GMAIL_LIST_LABELS: {
              tool_slug: 'GMAIL_LIST_LABELS',
              toolkit: 'gmail',
              input_schema: { type: 'object', properties: {} },
              hasFullSchema: true,
            },
          },
        },
      });
    if (match[2] === 'search')
      return Response.json({
        success: true,
        error: null,
        results: [],
        tool_schemas: {
          GMAIL_LIST_LABELS: {
            tool_slug: 'GMAIL_LIST_LABELS',
            toolkit: 'gmail',
            hasFullSchema: false,
            schemaRef: {
              tool: 'COMPOSIO_GET_TOOL_SCHEMAS',
              args: { tool_slugs: ['GMAIL_LIST_LABELS'] },
            },
          },
        },
        toolkit_connection_statuses: [],
        next_steps_guidance: [],
        session: { id: match[1], generate_id: false, instructions: '' },
        time_info: {
          current_time_utc: '2026-10-08T00:00:00Z',
          current_time_utc_epoch_seconds: 0,
          message: '',
        },
      });
  }
  if (path === '/tools/execute/proxy')
    return Response.json({ status: 200, data: { messages: [] }, headers: {} });
  throw new Error('Unmapped synthetic route');
};

for (const value of [env.COMPOSIO_API_KEY, env.BROKER_ENCRYPTION_KEY, 'must-be-stripped'])
  rememberSecret(value);
const handler = createHandler({ fetch: upstream, now: Date.now });
const request: typeof fetch = async (input, init) => {
  const req = new Request(input, init);
  assert.equal(new URL(req.url).origin, origin);
  assert.equal(req.headers.get('x-api-key'), null);
  assert.equal(req.headers.get('authorization'), null);
  assertNoSecrets(await wireText(req));
  if (new URL(req.url).pathname === '/v1/files/upload') {
    const body = (await req.clone().json()) as any;
    publicUploads.push({
      sessionId: body.sessionId,
      accountId: body.accountId,
      action: body.action,
    });
  }
  const response = await handler(req, env);
  const text = await wireText(response);
  assertNoSecrets(text);
  assert.equal(text.includes(storageHost), false);
  assert.equal(text.includes('tool_router/'), false);
  publicCalls.push({ path: new URL(req.url).pathname, status: response.status });
  return response;
};
let failure: any;
try {
  const injectedHeader = await wireText(
    new Response('', { headers: { 'x-synthetic-test': env.COMPOSIO_API_KEY } }),
  );
  assert.throws(() => assertNoSecrets(injectedHeader), /synthetic secret/);
  headerControl = true;
  const inputs = new Map<string, Uint8Array>();
  for (const file of frozen.files) {
    const content = frozen.inputContents[file.name];
    assert.ok(content && typeof content.hex === 'string');
    const bytes = Buffer.from(content.hex, 'hex');
    assert.equal(bytes.toString('hex'), content.hex);
    assert.equal(bytes.length, file.size);
    assert.equal(hash(bytes), file.sha256);
    assert.equal(md5(bytes), file.md5);
    const path = join(root, file.name);
    await writeFile(path, bytes);
    const disk = await readFile(path);
    assert.deepEqual(disk, bytes);
    inputs.set(file.name, disk);
    inputEvidence.push({ name: file.name, size: disk.length, sha256: hash(disk), md5: md5(disk) });
  }
  assert.equal(md5(inputs.get('collision-a.bin')!), md5(inputs.get('collision-b.bin')!));
  assert.notEqual(hash(inputs.get('collision-a.bin')!), hash(inputs.get('collision-b.bin')!));
  for (const variant of frozen.variants) {
    const start = Date.now();
    const timeout = setTimeout(() => {
      throw new Error('The frozen 600-second variant deadline expired.');
    }, frozen.timeLimitSeconds * 1000);
    const prefix = variant.id;
    const ownerA = prefix + '-owner-a';
    const ownerB = prefix + '-owner-b';
    const accountA = 'ca_' + prefix + '_a';
    const accountB = 'ca_' + prefix + '_b';
    const accountA2 = 'ca_' + prefix + '_a2';
    const proxy = createComposioProxy({ dataRoot: root, ownerId: ownerA, url: origin, request });
    const other = createComposioProxy({ dataRoot: root, ownerId: ownerB, url: origin, request });
    await Promise.all([proxy.initialize(), other.initialize()]);
    for (const owner of [ownerA, ownerB]) {
      const pem = await readFile(join(root, 'integration-identity', hash(owner) + '.pem'), 'utf8');
      const key = createPrivateKey(pem);
      rememberSecret(pem);
      rememberSecret(pem.replace(/-----[^\n]+-----|\s/g, ''));
      rememberSecret(key.export({ type: 'pkcs8', format: 'der' }));
      const privatePart = key.export({ format: 'jwk' }).d;
      assert.ok(privatePart);
      rememberSecret(privatePart);
      rememberSecret(Buffer.from(privatePart, 'base64url'));
      privateEncodingsRegistered++;
    }
    accountOwners.set(accountA, proxy.userId);
    accountOwners.set(accountA2, proxy.userId);
    accountOwners.set(accountB, other.userId);
    const metered = (value: ReturnType<typeof createComposioProvider>, owner: string) =>
      meterIntegrations(value, {
        track: async (event: any, operation: () => Promise<any>) => {
          const recorded = { owner, ...event, outcome: 'pending' };
          usageEvents.push(recorded);
          try {
            const result = await operation();
            recorded.outcome = 'succeeded';
            return result;
          } catch (error) {
            recorded.outcome = 'failed';
            throw error;
          }
        },
      } as Parameters<typeof meterIntegrations>[1]);
    const provider = metered(createComposioProvider({ proxy }), ownerA);
    const otherProvider = metered(createComposioProvider({ proxy: other }), ownerB);
    const dataA = inputs.get(variant.first)!;
    const dataB = inputs.get(variant.second)!;
    assert.ok(dataA && dataB);
    const workspaceA = join(root, prefix, 'workspace-a');
    const workspaceB = join(root, prefix, 'workspace-b');
    await Promise.all([
      mkdir(workspaceA, { recursive: true }),
      mkdir(workspaceB, { recursive: true }),
    ]);
    await Promise.all([
      writeFile(join(workspaceA, 'same-name.bin'), dataA),
      writeFile(join(workspaceB, 'same-name.bin'), dataB),
    ]);
    const schema = 'cp05v2_' + randomUUID().replaceAll('-', '');
    const admin = new pg.Pool({
      connectionString: frozen.databaseUrl,
      connectionTimeoutMillis: 5000,
    });
    await admin.query(`CREATE SCHEMA ${schema}`);
    const pool = new pg.Pool({
      connectionString: frozen.databaseUrl,
      options: `-c search_path=${schema}`,
      connectionTimeoutMillis: 5000,
    });
    const apps: ReturnType<typeof Fastify>[] = [];
    const turns = [
      { threadId: randomUUID(), turnId: randomUUID() },
      { threadId: randomUUID(), turnId: randomUUID() },
    ];
    const connections = [randomUUID(), randomUUID(), randomUUID()];
    const reads: any[] = [];
    const action = 'GMAIL_CREATE_EMAIL_DRAFT';
    const usageStart = usageEvents.length;
    const uploadStart = publicUploads.length;
    const makeService = async (index: number) => {
      const service = await createIntegrations(pool, {
        ownerId: index ? ownerB : ownerA,
        provider: index ? otherProvider : provider,
        baseUrl: 'http://localhost:4310',
        wake: async () => {},
        readWorkspaceFile: async (turn, path, maximum) => {
          assert.deepEqual(turn, turns[index]);
          assert.equal(path, '/workspace/nested/same-name.bin');
          const bytes = new Uint8Array(
            await readFile(join(index ? workspaceB : workspaceA, 'same-name.bin')),
          );
          assert.ok(bytes.byteLength <= maximum);
          reads.push({ owner: index, bytes: bytes.byteLength, sha256: hash(bytes) });
          return bytes;
        },
      });
      const app = Fastify();
      service.registerRoutes(app);
      apps.push(app);
      return service;
    };
    let variantResult: any;
    try {
      let first = await makeService(0);
      const second = await makeService(1);
      for (const [index, accountId, id] of [
        [0, accountA, connections[0]],
        [1, accountB, connections[1]],
        [0, accountA2, connections[2]],
      ] as const) {
        await pool.query(
          "INSERT INTO app_connections(id,owner_id,provider_id,slug,account_id,configuration_id,account_checked_at,watch_requested) VALUES($1,$2,'composio','gmail',$3,$4,now(),false)",
          [
            id,
            index ? ownerB : ownerA,
            accountId,
            index ? other.configurationId : proxy.configurationId,
          ],
        );
      }
      const input = (id: string) => ({
        connectionId: id,
        subject: 'Synthetic draft',
        attachment: {
          workspaceFile: '/workspace/nested/same-name.bin',
          name: 'same-name.bin',
          mimeType: 'application/octet-stream',
        },
      });
      const preparedA = await first.prepare(ownerA, action, input(connections[0]), turns[0]);
      const preparedB = await second.prepare(ownerB, action, input(connections[1]), turns[1]);
      const attachA = preparedA.attachment as any;
      const attachB = preparedB.attachment as any;
      const sourceA = (
        await pool.query('SELECT session_id FROM integration_sessions WHERE owner_id=$1', [ownerA])
      ).rows[0].session_id;
      await apps[0].close();
      first = await makeService(0);
      const beforeRestore = usageEvents.filter(
        (event) =>
          event.owner === ownerA &&
          event.operation === 'restore_session' &&
          event.outcome === 'succeeded',
      ).length;
      const extra = await first.prepare(ownerA, action, input(connections[2]), turns[0]);
      assert.equal(
        usageEvents.filter(
          (event) =>
            event.owner === ownerA &&
            event.operation === 'restore_session' &&
            event.outcome === 'succeeded',
        ).length,
        beforeRestore + 1,
      );
      const uploads = publicUploads.slice(uploadStart);
      assert.equal(uploads.length, 3);
      assert.deepEqual(
        uploads.map((value) => value.accountId),
        [accountA, accountB, accountA2],
      );
      assert.equal(uploads[0].sessionId, sourceA);
      assert.equal(uploads[2].sessionId, sourceA);
      assert.ok(uploads.every((value) => value.action === action));
      const attachments = [attachA, attachB, extra.attachment as any];
      for (const attachment of attachments) assert.match(attachment.s3key, /^otto-file\./);
      assert.equal(new Set(attachments.map((value) => value.s3key)).size, 3);
      await apps[2].close();
      await pool.query('DELETE FROM integration_sessions WHERE owner_id=$1', [ownerA]);
      await provider.deleteSession(sourceA);
      first = await makeService(0);
      const beforeDraft = executed.length;
      const draftA = (await first.executeApproved(ownerA, action, preparedA, turns[0])) as any;
      const draftB = (await second.executeApproved(ownerB, action, preparedB, turns[1])) as any;
      const extraDraft = (await first.executeApproved(ownerA, action, extra, turns[0])) as any;
      const received = executed.slice(beforeDraft);
      assert.equal(received.length, 3);
      assert.deepEqual(
        received.map((value) => value.account),
        [accountA, accountB, accountA2],
      );
      for (const [draft, data] of [
        [draftA, dataA],
        [draftB, dataB],
        [extraDraft, dataA],
      ] as const) {
        assert.equal(draft.data.sha256, hash(data));
        assert.equal(draft.data.bytes, data.length);
      }
      assert.ok(received.every((value) => value.sessionId !== sourceA));
      const keys = received.map((value) => value.arguments.attachment.s3key);
      assert.equal(new Set(keys).size, 3);
      assert.deepEqual(
        keys.map((key) => hash(stored.get(key)!)),
        [hash(dataA), hash(dataB), hash(dataA)],
      );
      const baseline = executed.length;
      const attacks = [
        {
          id: 'wrong-action',
          run: () => first.executeApproved(ownerA, 'GMAIL_SEND_EMAIL', preparedA, turns[0]),
        },
        {
          id: 'wrong-account',
          run: () =>
            first.executeApproved(
              ownerA,
              action,
              { ...preparedA, connectionId: connections[2] },
              turns[0],
            ),
        },
        {
          id: 'wrong-owner',
          run: () =>
            second.executeApproved(
              ownerB,
              action,
              { ...preparedA, connectionId: connections[1] },
              turns[1],
            ),
        },
        {
          id: 'raw-key',
          run: () =>
            first.executeApproved(
              ownerA,
              action,
              { ...preparedA, attachment: { ...attachA, s3key: keys[0] } },
              turns[0],
            ),
        },
        {
          id: 'foreign-delete',
          run: () =>
            other.client.getClient().post('/v1/files/delete', { body: { s3key: attachA.s3key } }),
        },
        {
          id: 'private-mount',
          run: () =>
            other.client
              .getClient()
              .post(
                `/api/v3.1/tool_router/session/${received[0].sessionId}/mounts/files/download_url`,
                { body: { mount_relative_path: 'same-name.bin' } },
              ),
        },
      ];
      for (const attack of attacks) await assert.rejects(attack.run(), undefined, attack.id);
      assert.equal(executed.length, baseline);
      assert.deepEqual(
        keys.map((key) => hash(stored.get(key)!)),
        [hash(dataA), hash(dataB), hash(dataA)],
      );
      assert.equal((await proxy.client.connectedAccounts.get(accountA)).state, undefined);
      assert.equal(
        upstreamCalls.some((call) => call.path === '/files/upload/request'),
        false,
      );
      assert.deepEqual(
        reads.map((item) => item.sha256),
        [hash(dataA), hash(dataB), hash(dataA)],
      );
      const meteredUploads = usageEvents
        .slice(usageStart)
        .filter((event) => event.operation === 'upload_file');
      assert.deepEqual(
        meteredUploads.map((value) => [value.owner, value.bytes, value.outcome]),
        [
          [ownerA, dataA.length, 'succeeded'],
          [ownerB, dataB.length, 'succeeded'],
          [ownerA, dataA.length, 'succeeded'],
        ],
      );
      let deletedFiles = 0;
      for (const [client, attachment] of [
        [proxy, attachA],
        [other, attachB],
        [proxy, extra.attachment],
      ] as const) {
        assert.deepEqual(
          await client.client
            .getClient()
            .post('/v1/files/delete', { body: { s3key: (attachment as any).s3key } }),
          { deleted: true },
        );
        deletedFiles++;
      }
      assert.equal(deletedFiles, 3);
      assert.equal(stored.size, 0);
      assert.equal(fileMounts.size, 0);
      for (const [id, session] of [...sessions]) {
        if (session.config.user_id === proxy.userId) await provider.deleteSession(id);
        else if (session.config.user_id === other.userId) await otherProvider.deleteSession(id);
        else assert.fail('Unexpected foreign fixture session during cleanup.');
      }
      assert.equal(sessions.size, 0);
      assert.equal(unexpectedOutbound, 0);
      assert.ok(Date.now() - start < frozen.timeLimitSeconds * 1000);
      variantResult = {
        variant: variant.id,
        pass: true,
        checks: Object.fromEntries(frozen.checks.map((check: any) => [check.id, 'pass'])),
        bytes: [dataA.length, dataB.length],
        sha256: [hash(dataA), hash(dataB)],
        workspaceReads: reads.length,
        receivingDrafts: received.length,
        deniedAttacks: attacks.map((attack) => attack.id),
        uploadsThroughMetering: meteredUploads.length,
        restoredUploads: 1,
        distinctSelectedAccounts: 3,
        sourceDeletedBeforeExecution: true,
        cleanup: {
          deletedFiles,
          storedFiles: stored.size,
          mounts: fileMounts.size,
          sessions: sessions.size,
          schemaAbsent: false,
        },
        elapsedMs: Date.now() - start,
      };
    } finally {
      clearTimeout(timeout);
      for (const [index, app] of apps.entries())
        try {
          await app.close();
        } catch {
          cleanupErrors.push(prefix + ':app-close-' + index);
        }
      try {
        await pool.end();
      } catch {
        cleanupErrors.push(prefix + ':pool-close');
      }
      try {
        await admin.query(`DROP SCHEMA ${schema} CASCADE`);
        const absent =
          (await admin.query('SELECT 1 FROM pg_namespace WHERE nspname=$1', [schema])).rows
            .length === 0;
        assert.equal(absent, true);
        if (variantResult) variantResult.cleanup.schemaAbsent = absent;
      } catch {
        cleanupErrors.push(prefix + ':schema-drop');
      }
      try {
        await admin.end();
      } catch {
        cleanupErrors.push(prefix + ':admin-close');
      }
    }
    assert.deepEqual(cleanupErrors, []);
    assert.ok(variantResult);
    results.push(variantResult);
  }
  await verifyBinding();
  sourceBindingAfter = true;
} catch (error) {
  failure = {
    name: error instanceof Error ? error.name : typeof error,
    message:
      error instanceof Error
        ? error.message
            .replace(/otto-file\.[A-Za-z0-9._-]+/g, '[attachment]')
            .replace(/https?:\/\/\S+/g, '[url]')
        : 'Unknown failure',
  };
  for (const value of secretValues)
    if (failure.message.includes(value))
      failure.message = 'A synthetic secret boundary assertion failed.';
} finally {
  try {
    await rm(root, { recursive: true, force: true });
  } catch {
    cleanupErrors.push('temporary-directory-remove');
  }
  const report = {
    case: 'CP05.v2',
    freezeId: frozen.id,
    phase: 'metered-actual-service-sdk-worker-fixture',
    inputPath: relative(repository, inputPath),
    inputsSha256: hash(frozenBytes),
    runnerSha256: frozen.runnerSha256,
    proxyRevision: frozen.proxyCommit,
    ottoCommit: frozen.ottoCommit,
    runtime: process.version,
    startedAt,
    endedAt: new Date().toISOString(),
    results,
    failure,
    inputEvidence,
    sourceBindingBefore,
    sourceBindingAfter,
    headerScannerControl: headerControl,
    privateIdentitiesScanned: privateEncodingsRegistered,
    responseHeadersScanned: publicCalls.length,
    responseBodiesScanned: publicCalls.length,
    publicRequests: publicCalls.length,
    upstreamRequests: upstreamCalls.length,
    receivingDrafts: executed.length,
    deniedAttacks: results.reduce((sum, result) => sum + result.deniedAttacks.length, 0),
    denied: publicCalls
      .filter((call) => call.status >= 400)
      .map((call) => ({
        route: call.path.replace(/\/session\/[^/]+/, '/session/:session'),
        status: call.status,
      })),
    cleanupErrors,
    remainingFixtureObjects: {
      files: stored.size,
      mounts: fileMounts.size,
      sessions: sessions.size,
    },
    unexpectedOutbound,
    modelCalls: 0,
    liveConnectedAccountCalls: 0,
    realRecipientCalls: 0,
    pass:
      !failure &&
      cleanupErrors.length === 0 &&
      results.length === 2 &&
      sourceBindingBefore &&
      sourceBindingAfter &&
      unexpectedOutbound === 0,
  };
  await writeFile(outputPath, await serialize(report), { flag: 'wx' });
  console.log(JSON.stringify(report));
  if (!report.pass) process.exitCode = 1;
}
