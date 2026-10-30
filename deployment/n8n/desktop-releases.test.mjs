import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { EventEmitter } from 'node:events';
import { createRequire } from 'node:module';
import test from 'node:test';
import { createDesktopUpdater, createUpdateSource } from '../../desktop/main/updates.mjs';
import {
  base,
  checkRedirect,
  checkRequest,
  releaseResponse,
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
  tag_name: 'nod-v0.2.0',
  draft: false,
  prerelease: true,
  published_at: '2026-10-04T12:00:00Z',
  assets: [asset(101, 'release.json'), asset(102, 'nod-arm64.zip'), asset(103, 'nod-arm64.dmg')],
  author: { secret: 'synthetic-private-field' },
  ...overrides,
});
const read = (body, input = { params: { releaseId: '42' } }) =>
  releaseResponse([{ statusCode: 200, body }], checkRequest(input), base);

test('N8ND-REQUEST and N8ND-TAG: only fixed repository URLs and exact request shapes are accepted', () => {
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
    { params: { tag: 'nod-v01.2.0' } },
    { params: { tag: `runtime-darwin-arm64-${'b'.repeat(64)}` } },
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
    `${base}/releases/42/assets/102/nod-arm64.zip`,
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
      release({ tag_name: 'nod-v0.9.0' }),
      release({ id: 43, tag_name: 'nod-v0.10.0' }),
      release({ id: 44, tag_name: 'nod-v0.10.0-beta.1' }),
      release({ id: 45, tag_name: 'nod-v9.0.0', draft: true }),
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
        url: `${base}/releases/43/assets/103/nod-arm64.dmg`,
        bytes: 1234,
        sha256: 'a'.repeat(64),
      },
      manifestUrl: `${base}/releases/43/assets/101/release.json`,
    },
  });
  assert.equal(read([], input).status, 404);
  assert.equal(
    read([release(), release({ id: 43, tag_name: 'nod-v1.0.0', assets: [] })], input).status,
    503,
  );
  assert.equal(read([release({ assets: [asset(103, 'nod-arm64.dmg')] })], input).status, 503);
  const pages = [
    { statusCode: 200, body: [release()] },
    { statusCode: 200, body: [release({ id: 43, tag_name: 'nod-v0.3.0' })] },
  ];
  assert.equal(releaseResponse(pages, checkRequest(input), base).body.version, '0.3.0');
  const full = Array.from({ length: 5 }, () => ({
    statusCode: 200,
    body: Array.from({ length: 100 }, () => release()),
  }));
  assert.equal(releaseResponse(full, checkRequest(input), base).status, 503);
});

test('N8ND-PIN: asset resolution binds release, asset ID and filename including replacement races', () => {
  const input = { params: { releaseId: '42', assetId: '102', filename: 'nod-arm64.zip' } };
  assert.deepEqual(read(release(), input), {
    assetUrl: 'https://api.github.com/repositories/1387586059/releases/assets/102',
  });
  assert.equal(read(release({ id: 43 }), input).status, 404);
  assert.equal(
    read(release(), { params: { ...input.params, filename: 'nod-arm64.dmg' } }).status,
    404,
  );
  assert.equal(read(release({ assets: [asset(200, 'nod-arm64.zip')] }), input).status, 404);
  assert.equal(
    read(
      release({
        assets: [asset(102, 'nod-arm64.zip'), asset(200, 'nod-arm64.zip')],
      }),
      input,
    ).status,
    503,
  );
  const name = 'nod-arm64.dmg';
  const installer = { params: { releaseId: '42', assetId: '103', filename: name } };
  assert.deepEqual(read(release({ assets: [asset(103, name)] }), installer), {
    assetUrl: 'https://api.github.com/repositories/1387586059/releases/assets/103',
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
        assets: [asset(102, 'nod-arm64.zip'), { ...asset(200, 'release.json'), digest: null }],
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
      url: `${base}/releases/42/assets/102/nod-arm64.zip`,
      name: 'nod 0.2.0',
      pub_date: '2026-10-04T12:00:00Z',
    },
  });
  assert.equal(read(release(), input('0.2.0')).status, 204);
  assert.equal(read(release(), input('0.3.0')).status, 204);
  assert.equal(
    read(release({ tag_name: 'nod-v0.2.0-alpha.2' }), input('0.2.0-alpha.10')).status,
    204,
  );
  assert.equal(
    read(release({ tag_name: 'nod-v0.2.0-alpha.10' }), input('0.2.0-alpha.2')).status,
    200,
  );
  assert.equal(read(release({ tag_name: 'nod-v0.2.0-alpha' }), input('0.2.0')).status, 204);
  assert.equal(
    read(release({ assets: [asset(102, 'nod-arm64.dmg')] }), input('0.1.0')).status,
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
  const body = JSON.stringify({ name: 'nod \u00e1', version: '0.2.0' });
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
    params: { releaseId: '42', assetId: '102', filename: 'nod-arm64.zip' },
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
  const input = { params: { releaseId: '42', assetId: '102', filename: 'nod-arm64.zip' } };
  const request = new Function('$input', requestNode.parameters.jsCode)({
    first: () => ({ json: input }),
  })[0].json;
  const result = new Function('$input', '$', responseNode.parameters.jsCode)(
    { all: () => [{ json: { statusCode: 200, body: release() } }] },
    () => ({ first: () => ({ json: request }) }),
  )[0].json;
  assert.equal(
    result.assetUrl,
    'https://api.github.com/repositories/1387586059/releases/assets/102',
  );
  for (const entry of nodes.filter((value) => value.credentials)) {
    assert.equal(entry.type, 'n8n-nodes-base.httpRequest');
    assert.equal(entry.parameters.options.redirect.redirect.followRedirects, false);
    assert.equal(entry.parameters.options.sendCredentialsOnCrossOriginRedirect, false);
    assert.equal(entry.parameters.authentication, 'predefinedCredentialType');
  }
});

test('N8ND-ADAPTER: real updater reads broker routes, a long release list and an earlier release runtime', async () => {
  const fingerprint = 'b'.repeat(64);
  const archive = {
    file: `nod-Runtime-darwin-arm64-${'c'.repeat(12)}.tar.gz`,
    bytes: 1234,
    sha256: 'a'.repeat(64),
  };
  const runtime = {
    platform: 'darwin-arm64',
    id: 'c'.repeat(64),
    fingerprint,
    archive,
    releaseTag: 'nod-v0.1.9',
  };
  const appRelease = release({
    assets: [
      asset(101, 'release.json'),
      asset(102, 'nod-arm64.zip'),
      asset(103, 'nod-arm64.dmg'),
      asset(104, 'runtime-release.json'),
    ],
  });
  const runtimeRelease = release({
    id: 70,
    tag_name: 'nod-v0.1.9',
    assets: [asset(105, archive.file)],
  });
  const manifest = {
    version: '0.2.0',
    platform: 'darwin-arm64',
    source: 'd'.repeat(40),
    signing: { mode: 'self-signed' },
    disk: { file: 'nod-arm64.dmg', bytes: 1234, sha256: 'a'.repeat(64) },
    update: { file: 'nod-arm64.zip', bytes: 1234, sha256: 'a'.repeat(64) },
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
  const metadata = new Map([
    [101, manifest],
    [104, runtime],
  ]);
  const request = async (address, options) => {
    const url = new URL(address);
    requests.push(url.href);
    assert.deepEqual(Object.keys(options?.headers ?? {}), ['accept']);
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
        : [{ statusCode: 200, body: checked.tag ? runtimeRelease : appRelease }];
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
    source: createUpdateSource({ sourceUrl: base, arch: 'arm64', fetch: request }),
    currentVersion: '0.1.0',
    native,
    prepareRuntime: async (candidate) => {
      assert.equal(candidate.runtime.id, runtime.id);
      runtimePrepared = true;
    },
  });
  const candidate = await updater.check();
  await updater.dispose();
  assert.equal(requests[0], `${base}/releases`);
  assert.ok(requests.includes(`${base}/tags/nod-v0.1.9`));
  assert.equal(candidate.version, '0.2.0');
  assert.equal(
    candidate.feedUrl,
    `${base}/releases/42/feed/102?version=0.1.0&platform=darwin-arm64`,
  );
  assert.equal(candidate.downloadUrl, `${base}/releases/70/assets/105/${archive.file}`);
  assert.equal(candidate.runtime.id, runtime.id);
});
