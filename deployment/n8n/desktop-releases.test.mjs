import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { EventEmitter } from 'node:events';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import {
  createDesktopUpdater,
  createUpdateSource,
  createWeeklyId,
} from '../../desktop/main/updates.mjs';
import {
  base,
  checkRedirect,
  checkRequest,
  posthog,
  releaseResponse,
  updateCheck,
  workflowNodes,
} from './desktop-releases.mjs';

const asset = (id, name) => ({
  id,
  name,
  size: 1234,
  state: 'uploaded',
  digest: `sha256:${'a'.repeat(64)}`,
  content_type: 'application/octet-stream',
  url: 'https://untrusted.invalid/private',
  uploader: { secret: 'synthetic-private-field' },
});
const release = (overrides = {}) => ({
  id: 42,
  tag_name: 'desktop-v0.2.0',
  draft: false,
  prerelease: true,
  published_at: '2026-10-04T12:00:00Z',
  assets: [asset(101, 'release.json'), asset(102, 'Otto-arm64.zip'), asset(103, 'Otto-arm64.dmg')],
  author: { secret: 'synthetic-private-field' },
  ...overrides,
});
const read = (body, input = { params: { releaseId: '42' } }) =>
  releaseResponse([{ statusCode: 200, body }], checkRequest(input), base);

test('N8ND-REQUEST and N8ND-TAG: only fixed repository URLs and exact request shapes are accepted', () => {
  const tag = `runtime-darwin-arm64-${'b'.repeat(64)}`;
  assert.equal(
    read(
      [
        release({
          tag_name: tag,
          assets: [asset(104, `Otto-Runtime-darwin-arm64-${'c'.repeat(12)}.tar.gz`)],
        }),
      ],
      { params: { tag } },
    ).status,
    200,
  );
  for (const input of [
    { query: { url: 'https://attacker.invalid' } },
    { query: { installer: 'false' } },
    { query: { installer: 'true', url: 'https://attacker.invalid' } },
    { params: { releaseId: '42' }, query: { installer: 'true' } },
    { params: { releaseId: ['42'] } },
    { params: { releaseId: '42', assetId: '102', filename: '../private' } },
    { params: { releaseId: '42', assetId: '102', filename: 'https://attacker.invalid' } },
    { params: { releaseId: '9007199254740993' } },
    { params: { tag: 'v0.2.0' } },
    { params: { tag: 'desktop-v01.2.0' } },
    {
      params: { releaseId: '42', assetId: '102' },
      query: { version: '0.1.0', platform: 'linux-x64' },
    },
  ])
    assert.equal(checkRequest(input).status, 400);
});

test('N8ND-PUBLISHED: broker omits drafts, legacy tags, unknown assets and private API fields', () => {
  const result = read(
    [
      release(),
      release({ id: 43, draft: true }),
      release({ id: 44, tag_name: 'v9.0.0' }),
      release({ id: 45, assets: [asset(105, 'secret-source.tar.gz')] }),
    ],
    {},
  );
  assert.equal(result.status, 200);
  assert.deepEqual(
    result.body.map((entry) => entry.id),
    [42, 45],
  );
  assert.equal(result.body[1].assets.length, 0);
  assert.equal(
    result.body[0].assets[1].browser_download_url,
    `${base}/releases/42/assets/102/Otto-arm64.zip`,
  );
  assert.doesNotMatch(
    JSON.stringify(result),
    /synthetic-private-field|untrusted\.invalid|secret-source/,
  );
  assert.equal(read(release({ draft: true })).status, 404);
  assert.equal(read(release({ tag_name: 'v0.2.0' })).status, 404);
});

test('N8ND-INSTALLER: latest metadata pins the highest published current desktop release and fails closed when incomplete', () => {
  const input = { query: { installer: 'true' } };
  const result = read(
    [
      release({ tag_name: 'desktop-v0.9.0' }),
      release({ id: 43, tag_name: 'desktop-v0.10.0' }),
      release({ id: 44, tag_name: 'desktop-v0.10.0-beta.1' }),
      release({ id: 45, tag_name: 'desktop-v9.0.0', draft: true }),
      release({ id: 46, tag_name: 'v99.0.0' }),
      release({ id: 47, tag_name: `runtime-darwin-arm64-${'b'.repeat(64)}` }),
    ],
    input,
  );
  assert.deepEqual(result, {
    status: 200,
    body: {
      schema: 1,
      version: '0.10.0',
      releaseId: 43,
      disk: {
        url: `${base}/releases/43/assets/103/Otto-arm64.dmg`,
        bytes: 1234,
        sha256: 'a'.repeat(64),
      },
      manifestUrl: `${base}/releases/43/assets/101/release.json`,
    },
  });
  assert.equal(read([], input).status, 404);
  assert.equal(
    read([release(), release({ id: 43, tag_name: 'desktop-v1.0.0', assets: [] })], input).status,
    503,
  );
  assert.equal(read([release({ assets: [asset(103, 'Otto-arm64.dmg')] })], input).status, 503);
  const pages = [
    { statusCode: 200, body: [release()] },
    { statusCode: 200, body: [release({ id: 43, tag_name: 'desktop-v0.3.0' })] },
  ];
  assert.equal(releaseResponse(pages, checkRequest(input), base).body.version, '0.3.0');
  const full = Array.from({ length: 5 }, () => ({
    statusCode: 200,
    body: Array.from({ length: 100 }, () => release()),
  }));
  assert.equal(releaseResponse(full, checkRequest(input), base).status, 503);
});

test('N8ND-PIN: asset resolution binds release, asset ID and filename including replacement races', () => {
  const input = { params: { releaseId: '42', assetId: '102', filename: 'Otto-arm64.zip' } };
  assert.deepEqual(read(release(), input), {
    assetUrl: 'https://api.github.com/repos/n8n-io/otto/releases/assets/102',
  });
  assert.equal(read(release({ id: 43 }), input).status, 404);
  assert.equal(
    read(release(), { params: { ...input.params, filename: 'Otto-arm64.dmg' } }).status,
    404,
  );
  assert.equal(read(release({ assets: [asset(200, 'Otto-arm64.zip')] }), input).status, 404);
  assert.equal(
    read(
      release({
        assets: [asset(102, 'Otto-arm64.zip'), asset(200, 'Otto-arm64.zip')],
      }),
      input,
    ).status,
    503,
  );
  const name = 'Otto-arm64.dmg';
  const installer = { params: { releaseId: '42', assetId: '103', filename: name } };
  assert.deepEqual(read(release({ assets: [asset(103, name)] }), installer), {
    assetUrl: 'https://api.github.com/repos/n8n-io/otto/releases/assets/103',
  });
  assert.equal(read(release({ assets: [asset(104, name)] }), installer).status, 404);
  assert.equal(
    read(release({ assets: [{ ...asset(103, name), digest: null }] }), installer).status,
    503,
  );
  assert.equal(
    read(release({ assets: [asset(103, name), asset(104, name)] }), installer).status,
    503,
  );
  assert.equal(
    read(release({ assets: [asset(102, 'secret-source.tar.gz')] }), {
      params: { ...input.params, filename: 'secret-source.tar.gz' },
    }).status,
    404,
  );
  assert.equal(
    read(
      release({
        assets: [asset(102, 'Otto-arm64.zip'), { ...asset(200, 'release.json'), digest: null }],
      }),
      input,
    ).status,
    503,
  );
});

test('N8ND-UPSTREAM: denied, missing, malformed and truncated sources fail without disclosing provider errors', () => {
  const request = checkRequest({ params: { releaseId: '42' } });
  assert.equal(
    releaseResponse(
      [{ statusCode: 403, body: { message: 'synthetic-secret-provider-error' } }],
      request,
      base,
    ).status,
    503,
  );
  assert.equal(releaseResponse([{ statusCode: 404, body: {} }], request, base).status, 404);
  assert.equal(
    releaseResponse([{ error: { message: 'synthetic-secret-provider-error' } }], request, base)
      .status,
    503,
  );
  assert.doesNotMatch(
    JSON.stringify(
      releaseResponse(
        [{ statusCode: 403, body: { message: 'synthetic-secret-provider-error' } }],
        request,
        base,
      ),
    ),
    /synthetic-secret/,
  );
  assert.equal(
    releaseResponse([{ statusCode: 200, body: {} }], checkRequest({}), base).status,
    503,
  );
});

test('N8ND-FEED: native feed uses the exact newer app ZIP and handles version ordering', () => {
  const input = (version) => ({
    params: { releaseId: '42', assetId: '102' },
    query: { version, platform: 'darwin-arm64' },
  });
  const result = read(release(), input('0.1.0'));
  assert.deepEqual(result, {
    status: 200,
    body: {
      url: `${base}/releases/42/assets/102/Otto-arm64.zip`,
      name: 'Otto 0.2.0',
      pub_date: '2026-10-04T12:00:00Z',
    },
  });
  assert.equal(read(release(), input('0.2.0')).status, 204);
  assert.equal(read(release(), input('0.3.0')).status, 204);
  assert.equal(
    read(release({ tag_name: 'desktop-v0.2.0-alpha.2' }), input('0.2.0-alpha.10')).status,
    204,
  );
  assert.equal(
    read(release({ tag_name: 'desktop-v0.2.0-alpha.10' }), input('0.2.0-alpha.2')).status,
    200,
  );
  assert.equal(read(release({ tag_name: 'desktop-v0.2.0-alpha' }), input('0.2.0')).status, 204);
  assert.equal(
    read(release({ assets: [asset(102, 'Otto-arm64.dmg')] }), input('0.1.0')).status,
    404,
  );
  assert.equal(
    read(release({ tag_name: `runtime-darwin-arm64-${'b'.repeat(64)}` }), input('0.1.0')).status,
    404,
  );
});

test('N8ND-REDIRECT: archive resolution exposes only an exact HTTPS GitHub download redirect', () => {
  const valid = 'https://release-assets.githubusercontent.com/fixture/asset?signature=synthetic';
  assert.deepEqual(checkRedirect({ statusCode: 302, headers: { location: valid } }), {
    status: 302,
    body: '',
    location: valid,
  });
  for (const location of [
    'http://release-assets.githubusercontent.com/a',
    'https://attacker.invalid/a',
    'https://release-assets.githubusercontent.com.attacker.invalid/a',
    'https://user@release-assets.githubusercontent.com/a',
    `${valid}#fragment`,
    `${valid}\nLocation: https://attacker.invalid`,
    '//release-assets.githubusercontent.com/a',
  ])
    assert.equal(checkRedirect({ statusCode: 302, headers: { location } }).status, 503);
  assert.equal(checkRedirect({ statusCode: 301, headers: { location: valid } }).status, 503);
  assert.equal(checkRedirect({ statusCode: 200, headers: { location: valid } }).status, 503);
  assert.equal(
    checkRedirect({ statusCode: 302, headers: { location: valid, Location: valid } }).status,
    503,
  );
});

test('N8ND-METADATA200: bounded JSON bytes and digest are verified before direct delivery', () => {
  const body = JSON.stringify({ name: 'Otto \u00e1', version: '0.2.0' });
  const digest = (value) => `sha256:${createHash('sha256').update(value).digest('hex')}`;
  const metadataAsset = {
    ...asset(101, 'release.json'),
    size: Buffer.byteLength(body),
    digest: digest(body),
  };
  const input = { params: { releaseId: '42', assetId: '101', filename: 'release.json' } };
  const plan = read(release({ assets: [metadataAsset] }), input);
  assert.deepEqual(checkRedirect({ statusCode: 200, body }, plan.metadata), {
    status: 200,
    body: JSON.parse(body),
  });
  assert.equal(plan.metadata.bytes, Buffer.byteLength(body));
  assert.equal(plan.metadata.digest, digest(body));
  const nodes = workflowNodes();
  const method = (value) =>
    new Function(
      '$json',
      `return ${nodes.find((entry) => entry.name === 'Read GitHub asset redirect').parameters.method.slice(3, -2)}`,
    )(value);
  assert.equal(method(plan), 'GET');
  const code = nodes.find((entry) => entry.name === 'Check GitHub redirect').parameters.jsCode;
  const execute = (response, request = plan) =>
    new Function('$input', '$', 'require', code)(
      { first: () => ({ json: response }) },
      () => ({ first: () => ({ json: request }) }),
      createRequire(import.meta.url),
    )[0].json;
  assert.deepEqual(execute({ statusCode: 200, body }).body, JSON.parse(body));
  for (const response of [
    { statusCode: 200, body: `${body} ` },
    { statusCode: 200, body: body.replace('0.2.0', '0.9.0') },
    { statusCode: 200, body: JSON.parse(body) },
  ])
    assert.equal(execute(response).status, 503);
  assert.equal(
    execute({ statusCode: 200, body: '{' }, { metadata: { bytes: 1, digest: digest('{') } }).status,
    503,
  );
  const archive = read(release(), {
    params: { releaseId: '42', assetId: '102', filename: 'Otto-arm64.zip' },
  });
  assert.equal(method(archive), 'HEAD');
  assert.equal(execute({ statusCode: 200, body }, archive).status, 503);
  const oversized = read(
    release({ assets: [{ ...metadataAsset, size: 2 * 1024 * 1024 + 1 }] }),
    input,
  );
  assert.equal(oversized.status, 503);
  assert.equal(oversized.assetUrl, undefined);
  assert.equal(
    execute({
      statusCode: 302,
      headers: { location: 'https://release-assets.githubusercontent.com/fixture/metadata' },
    }).status,
    302,
  );
});

test('N8ND-CONFIG: actual embedded request pipeline gates credentialed metadata and HEAD requests', () => {
  const nodes = workflowNodes();
  const requestNode = nodes.find((entry) => entry.name === 'Check desktop request');
  const responseNode = nodes.find((entry) => entry.name === 'Build desktop response');
  const input = { params: { releaseId: '42', assetId: '102', filename: 'Otto-arm64.zip' } };
  const request = new Function('$input', requestNode.parameters.jsCode)({
    first: () => ({ json: input }),
  })[0].json;
  const result = new Function('$input', '$', responseNode.parameters.jsCode)(
    { all: () => [{ json: { statusCode: 200, body: release() } }] },
    () => ({ first: () => ({ json: request }) }),
  )[0].json;
  assert.equal(result.assetUrl, 'https://api.github.com/repos/n8n-io/otto/releases/assets/102');
  for (const entry of nodes.filter((value) => value.credentials)) {
    assert.equal(entry.type, 'n8n-nodes-base.httpRequest');
    assert.equal(entry.parameters.options.redirect.redirect.followRedirects, false);
    assert.equal(entry.parameters.options.sendCredentialsOnCrossOriginRedirect, false);
    assert.equal(entry.parameters.authentication, 'predefinedCredentialType');
  }
});

test('N8ND-ADAPTER: real updater reads broker routes, a long release list and an older runtime tag', async () => {
  const fingerprint = 'b'.repeat(64);
  const archive = {
    file: `Otto-Runtime-darwin-arm64-${'c'.repeat(12)}.tar.gz`,
    bytes: 1234,
    sha256: 'a'.repeat(64),
  };
  const runtime = { platform: 'darwin-arm64', id: 'c'.repeat(64), fingerprint, archive };
  const appRelease = release({
    assets: [
      asset(101, 'release.json'),
      asset(102, 'Otto-arm64.zip'),
      asset(103, 'Otto-arm64.dmg'),
      asset(104, 'runtime-release.json'),
    ],
  });
  const runtimeRelease = release({
    id: 70,
    tag_name: `runtime-darwin-arm64-${fingerprint}`,
    assets: [asset(105, archive.file)],
  });
  const manifest = {
    version: '0.2.0',
    platform: 'darwin-arm64',
    source: 'd'.repeat(40),
    signing: { mode: 'self-signed' },
    disk: { file: 'Otto-arm64.dmg', bytes: 1234, sha256: 'a'.repeat(64) },
    update: { file: 'Otto-arm64.zip', bytes: 1234, sha256: 'a'.repeat(64) },
    runtime,
  };
  const unrelated = Array.from({ length: 100 }, (_, index) =>
    release({
      id: 1000 + index,
      tag_name: `runtime-darwin-arm64-${index.toString(16).padStart(64, '0')}`,
      assets: [],
    }),
  );
  const list = [appRelease, ...unrelated];
  const requests = [];
  const counted = [];
  const profile = await mkdtemp(join(tmpdir(), 'otto-update-week-'));
  const metadata = new Map([
    [101, manifest],
    [104, runtime],
  ]);
  const request = async (address, options) => {
    const url = new URL(address);
    requests.push(url.href);
    const event = updateCheck(options?.headers, posthog.key);
    if (event) counted.push([url.href, event]);
    if (url.origin === 'https://release-assets.githubusercontent.com') {
      const content = metadata.get(Number(url.pathname.slice(1)));
      assert.ok(content, 'Only synthetic metadata assets may be read.');
      return Response.json(content);
    }
    assert.equal(url.origin, new URL(base).origin);
    const path = url.pathname.slice(new URL(base).pathname.length + 1).split('/');
    const params =
      path[0] === 'tags'
        ? { tag: path[1] }
        : path.length === 1
          ? {}
          : path.length === 2
            ? { releaseId: path[1] }
            : { releaseId: path[1], assetId: path[3], filename: path[4] };
    const checked = checkRequest({ params, query: Object.fromEntries(url.searchParams) });
    if (checked.status) return Response.json(checked.body, { status: checked.status });
    const pages =
      checked.operation === 'list'
        ? [list.slice(0, 100), list.slice(100)].map((body) => ({ statusCode: 200, body }))
        : [{ statusCode: 200, body: checked.tag ? [runtimeRelease] : appRelease }];
    const result = releaseResponse(pages, checked, base);
    if (result.assetUrl) {
      const redirect = checkRedirect({
        statusCode: 302,
        headers: { location: `https://release-assets.githubusercontent.com/${checked.assetId}` },
      });
      return new Response(null, {
        status: redirect.status,
        headers: { location: redirect.location },
      });
    }
    return Response.json(result.body, { status: result.status });
  };
  const native = new EventEmitter();
  let feed;
  let runtimePrepared = false;
  native.setFeedURL = ({ url }) => {
    const address = new URL(url);
    const path = address.pathname.split('/');
    const checked = checkRequest({
      params: { releaseId: path.at(-3), assetId: path.at(-1) },
      query: Object.fromEntries(address.searchParams),
    });
    const result = releaseResponse([{ statusCode: 200, body: appRelease }], checked, base);
    assert.equal(result.status, 200);
    feed = result.body;
  };
  native.checkForUpdates = () => {
    assert.equal(runtimePrepared, true);
    queueMicrotask(() =>
      native.emit('update-downloaded', {}, '', feed.name, new Date(feed.pub_date), feed.url),
    );
  };
  const updater = createDesktopUpdater({
    source: createUpdateSource({
      sourceUrl: base,
      arch: 'arm64',
      fetch: request,
      weeklyId: createWeeklyId(join(profile, 'update-week.json')),
    }),
    currentVersion: '0.1.0',
    native,
    prepareRuntime: async (candidate) => {
      assert.equal(candidate.runtime.id, runtime.id);
      runtimePrepared = true;
    },
  });
  const candidate = await updater.check();
  await updater.dispose();
  const { id } = JSON.parse(await readFile(join(profile, 'update-week.json'), 'utf8'));
  await rm(profile, { recursive: true, force: true });
  assert.deepEqual(
    counted.map(([url, event]) => [url, event.distinct_id, event.properties.platform]),
    [[`${base}/releases`, `week:${id}`, 'darwin-arm64']],
  );
  assert.equal(requests[0], `${base}/releases`);
  assert.ok(requests.includes(`${base}/tags/runtime-darwin-arm64-${fingerprint}`));
  assert.equal(candidate.version, '0.2.0');
  assert.equal(
    candidate.feedUrl,
    `${base}/releases/42/feed/102?version=0.1.0&platform=darwin-arm64`,
  );
  assert.equal(candidate.downloadUrl, `${base}/releases/70/assets/105/${archive.file}`);
  assert.equal(candidate.runtime.id, runtime.id);
});

test('legacy runtime tag lookup stays exact and only a missing release starts alias lookup', () => {
  const tag = `runtime-darwin-arm64-${'b'.repeat(64)}`;
  const request = checkRequest({ params: { tag } });
  assert(request.apiUrl.endsWith(`/tags/${tag}`));
  const legacy = release({ tag_name: tag });
  assert.equal(
    releaseResponse([{ statusCode: 200, body: legacy }], request, base).body.tag_name,
    tag,
  );
  assert.deepEqual(releaseResponse([{ statusCode: 404 }], request, base), {
    aliasApiUrl: 'https://api.github.com/repos/n8n-io/otto/releases?per_page=100',
  });
  assert.equal(releaseResponse([{ statusCode: 403 }], request, base).status, 503);
  const node = workflowNodes().find((entry) => entry.name === 'Build runtime alias response');
  const migrated = release({
    assets: [
      asset(110, `${tag}.json`),
      asset(111, `Otto-Runtime-darwin-arm64-${'c'.repeat(12)}.tar.gz`),
    ],
  });
  const result = new Function('$input', '$', node.parameters.jsCode)(
    { all: () => [{ json: { statusCode: 200, body: [migrated] } }] },
    () => ({ first: () => ({ json: request }) }),
  )[0].json;
  assert.equal(result.status, 200);
  assert.equal(result.body.tag_name, tag);
  assert.equal(result.body.id, migrated.id);
});

test('N8ND-WEEKLY: a valid weekly update check becomes one anonymous PostHog event, never with the IP', async () => {
  const week = 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee';
  const headers = {
    'x-otto-week': week,
    'x-otto-platform': 'win32-x64',
    'x-otto-version': '0.4.1',
    'x-forwarded-for': '203.0.113.7',
    'x-real-ip': '203.0.113.7',
  };
  assert.deepEqual(updateCheck(headers, posthog.key), {
    api_key: posthog.key,
    event: 'otto_update_check',
    distinct_id: `week:${week}`,
    properties: {
      platform: 'win32-x64',
      app_version: '0.4.1',
      analytics_schema: 'otto_v3',
      environment: 'production',
      $process_person_profile: false,
      $geoip_disable: true,
    },
  });
  assert.equal(
    updateCheck({ ...headers, 'x-otto-version': '0.5.0-beta.1' }, posthog.key).properties
      .environment,
    'development',
  );
  for (const invalid of [
    undefined,
    {},
    { ...headers, 'x-otto-week': undefined },
    { ...headers, 'x-otto-week': 'local:203.0.113.7' },
    { ...headers, 'x-otto-week': ['aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee'] },
    { ...headers, 'x-otto-platform': 'linux-x64' },
    { ...headers, 'x-otto-version': undefined },
    { ...headers, 'x-otto-version': '203.0.113.7/private' },
  ])
    assert.equal(updateCheck(invalid, posthog.key), null);

  const nodes = workflowNodes();
  const check = (input) =>
    new Function(
      '$input',
      nodes.find((entry) => entry.name === 'Check desktop request').parameters.jsCode,
    )({ first: () => ({ json: { params: {}, query: {}, ...input } }) })[0].json;
  assert.equal(check({ headers }).updateCheck.distinct_id, `week:${week}`);
  assert.doesNotMatch(JSON.stringify(check({ headers })), /203\.0\.113\.7/);
  assert.equal(check({ headers: {} }).updateCheck, null);
  assert.equal(check({ headers, query: { installer: 'true' } }).updateCheck, undefined);
  const send = nodes.find((entry) => entry.name === 'Send update check');
  assert.equal(send.parameters.url, 'https://eu.i.posthog.com/i/v0/e/');
  assert.equal(send.onError, 'continueRegularOutput');
  assert.equal(send.credentials, undefined);
  assert.doesNotMatch(JSON.stringify(send), /headers|forwarded|\$ip/i);
  assert.match(
    await readFile(new URL('../../src/shared/analytics.ts', import.meta.url), 'utf8'),
    new RegExp(posthog.key),
  );
});

test('N8ND-WEEKLY: the desktop weekly ID stays for its ISO week and is replaced the next week', async () => {
  const profile = await mkdtemp(join(tmpdir(), 'otto-update-week-'));
  let now = new Date('2026-10-19T00:00:00Z');
  const weeklyId = createWeeklyId(join(profile, 'update-week.json'), () => now);
  const first = await weeklyId();
  now = new Date('2026-10-25T23:59:59Z');
  assert.equal(await weeklyId(), first);
  now = new Date('2026-10-26T00:00:00Z');
  const next = await weeklyId();
  await rm(profile, { recursive: true, force: true });
  assert.notEqual(next, first);
  assert.match(next, /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
});
