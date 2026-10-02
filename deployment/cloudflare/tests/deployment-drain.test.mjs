import assert from 'node:assert/strict';
import { randomBytes, randomUUID } from 'node:crypto';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { createDeploymentClient, inspectImageDigest } from '../scripts/drain.mjs';
import { createDeploymentVerifier, deploymentHeader } from '../../../src/server/deployment-auth.ts';

async function manifestFixture(t) {
  const directory = await mkdtemp(join(tmpdir(), 'otto-manifest-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const image = `registry.cloudflare.com/${'a'.repeat(32)}/otto-production:${'b'.repeat(40)}`;
  const fixturePath = join(directory, 'manifest.json');
  await writeFile(
    join(directory, 'docker'),
    `#!${process.execPath}
const { readFileSync } = require('node:fs');
const fixture = JSON.parse(readFileSync(process.env.OTTO_MANIFEST_FIXTURE, 'utf8'));
if (JSON.stringify(process.argv.slice(2)) !== JSON.stringify(fixture.args)) process.exit(23);
process.stderr.write('synthetic private registry error');
process.stdout.write(fixture.output, () => process.exit(fixture.code));
`,
    { mode: 0o700 },
  );
  return {
    reference: `${image.slice(0, image.lastIndexOf(':'))}@sha256:${'c'.repeat(64)}`,
    async inspect(manifest, { output = JSON.stringify(manifest), code = 0 } = {}) {
      await writeFile(
        fixturePath,
        JSON.stringify({ args: ['manifest', 'inspect', '-v', image], output, code }),
        { mode: 0o600 },
      );
      return inspectImageDigest(image, {
        PATH: directory,
        OTTO_MANIFEST_FIXTURE: fixturePath,
      });
    },
  };
}

function manifestEntry(descriptor = {}, body = {}) {
  return {
    Descriptor: {
      mediaType: 'application/vnd.oci.image.manifest.v1+json',
      digest: `sha256:${'c'.repeat(64)}`,
      platform: { os: 'linux', architecture: 'amd64' },
      ...descriptor,
    },
    ...body,
  };
}

test('registry inspection pins an individual amd64 image from OCI and Docker object responses', async (t) => {
  const f = await manifestFixture(t);
  for (const mediaType of [
    'application/vnd.oci.image.manifest.v1+json',
    'application/vnd.docker.distribution.manifest.v2+json',
  ])
    assert.equal(await f.inspect(manifestEntry({ mediaType })), f.reference);
});

test('registry inspection selects the unique amd64 image and never pins an attestation or foreign platform', async (t) => {
  const f = await manifestFixture(t);
  const selected = manifestEntry();
  const attestation = manifestEntry(
    {
      digest: `sha256:${'d'.repeat(64)}`,
      platform: { os: 'unknown', architecture: 'unknown' },
      annotations: { 'vnd.docker.reference.type': 'attestation-manifest' },
    },
    { OCIManifest: { artifactType: 'application/vnd.docker.attestation.manifest.v1+json' } },
  );
  const arm = manifestEntry({
    digest: `sha256:${'e'.repeat(64)}`,
    platform: { os: 'linux', architecture: 'arm64', variant: 'v8' },
  });
  for (const entries of [
    [selected, attestation],
    [attestation, selected],
    [arm, attestation, selected],
  ])
    assert.equal(await f.inspect(entries), f.reference);
});

test('registry inspection refuses missing, malformed, ambiguous and unsupported image metadata', async (t) => {
  const f = await manifestFixture(t);
  for (const [name, manifest] of [
    ['empty list', []],
    ['null response', null],
    ['missing descriptor', {}],
    ['malformed list member', [manifestEntry(), null]],
    ['missing platform', manifestEntry({ platform: undefined })],
    ['unknown platform', manifestEntry({ platform: { os: 'unknown', architecture: 'unknown' } })],
    ['arm64 only', manifestEntry({ platform: { os: 'linux', architecture: 'arm64' } })],
    ['windows only', manifestEntry({ platform: { os: 'windows', architecture: 'amd64' } })],
    ['duplicate amd64', [manifestEntry(), manifestEntry()]],
    [
      'different amd64 images',
      [manifestEntry(), manifestEntry({ digest: `sha256:${'d'.repeat(64)}` })],
    ],
    ['malformed digest', manifestEntry({ digest: 'sha256:unknown' })],
    ['array digest', manifestEntry({ digest: [`sha256:${'c'.repeat(64)}`] })],
    ['missing digest', manifestEntry({ digest: undefined })],
    ['unsupported digest', manifestEntry({ digest: `sha512:${'c'.repeat(128)}` })],
    ['missing media type', manifestEntry({ mediaType: undefined })],
    ['image index', manifestEntry({ mediaType: 'application/vnd.oci.image.index.v1+json' })],
    [
      'nonbaseline amd64',
      manifestEntry({ platform: { os: 'linux', architecture: 'amd64', variant: 'v3' } }),
    ],
    [
      'attestation annotation',
      manifestEntry({ annotations: { 'vnd.docker.reference.type': 'attestation-manifest' } }),
    ],
    [
      'artifact manifest',
      manifestEntry(
        {},
        { OCIManifest: { artifactType: 'application/vnd.docker.attestation.manifest.v1+json' } },
      ),
    ],
    [
      'too many entries',
      Array.from({ length: 129 }, () =>
        manifestEntry({ platform: { os: 'unknown', architecture: 'unknown' } }),
      ),
    ],
  ])
    await t.test(name, () =>
      assert.rejects(f.inspect(manifest), /Deployment safety checks did not pass/),
    );
});

test('registry inspection bounds output and normalizes malformed JSON or failed subprocess output', async (t) => {
  const f = await manifestFixture(t);
  for (const options of [
    { output: '{private invalid json' },
    { code: 1 },
    { output: JSON.stringify({ padding: 'x'.repeat(1024 * 1024), ...manifestEntry() }) },
  ])
    await assert.rejects(f.inspect(manifestEntry(), options), {
      message: 'Deployment safety checks did not pass; admission remains unchanged or closed.',
    });
});

function fixture(overrides = {}) {
  const masterKey = randomBytes(32);
  const origin = 'https://otto.test.workers.dev';
  const release = 'b'.repeat(40);
  const account = 'c'.repeat(32);
  const classes = [
    'GatewayContainer',
    'TenantContainer',
    'BrowserComputerContainer',
    'WorkspaceComputerContainer',
  ];
  const containers = classes.map((name, index) => ({
    name: `otto-${name.toLowerCase()}-production`,
    image: `registry.cloudflare.com/${account}/otto-production-${index}@sha256:${'d'.repeat(64)}`,
  }));
  const plan = {
    origin,
    release,
    config: { env: { production: { name: 'otto', containers } } },
  };
  const variables = {
    CLOUDFLARE_ACCOUNT_ID: account,
    CLOUDFLARE_API_TOKEN: 'synthetic-api-key',
    GATEWAY_ENV: JSON.stringify({
      OTTO_MASTER_KEY: masterKey.toString('base64'),
      DATABASE_URL: 'synthetic-db',
    }),
  };
  const requests = [];
  const controls = [];
  let registryReads = 0;
  let applicationReads = 0;
  const state = {
    missing: false,
    missingCode: 10007,
    denied: false,
    published: false,
    occupied: false,
    rollout: false,
    wrongImage: false,
    application: (value) => value,
    control: null,
    ...overrides,
  };
  const verify = createDeploymentVerifier({ masterKey, environment: 'production' });
  const api = (result) => Response.json({ success: true, result });
  const client = createDeploymentClient({
    environment: 'production',
    plan,
    variables,
    attempts: 2,
    intervalMs: 0,
    wait: async () => {},
    emptyRegistry: async () => {
      registryReads += 1;
      return !state.occupied;
    },
    fetcher: async (raw, options) => {
      const url = new URL(raw);
      requests.push({ url, options });
      assert.equal(options.redirect, 'error');
      if (url.hostname === 'api.cloudflare.com') {
        assert.equal(options.headers.authorization, 'Bearer synthetic-api-key');
        assert.equal(options.cache, 'no-store');
        if (url.pathname.endsWith('/settings')) {
          if (state.denied) return Response.json({ success: false }, { status: 403 });
          if (state.missing)
            return Response.json(
              { success: false, errors: [{ code: state.missingCode }] },
              { status: 404 },
            );
          return api({ bindings: [] });
        }
        if (state.api) {
          const response = await state.api(url, options);
          if (response) return response;
        }
        applicationReads += 1;
        const name = url.searchParams.get('name');
        const expected = containers.find((container) => container.name === name);
        assert.ok(expected);
        return api(
          state.missing && !state.published
            ? []
            : [
                state.application({
                  name,
                  configuration: { image: state.wrongImage ? 'wrong' : expected.image },
                  ...(state.rollout ? { active_rollout_id: 'still-running' } : {}),
                }),
              ],
        );
      }
      assert.equal(options.headers?.authorization, undefined);
      if (url.pathname === '/api/health')
        return Response.json({ ok: true, release: state.published ? release : 'a'.repeat(40) });
      assert.equal(url.pathname, '/api/deployment');
      const input = await verify(
        options.headers[deploymentHeader],
        options.method,
        url.pathname,
        options.body,
      );
      controls.push(input);
      assert.equal(Buffer.from(options.body).includes(masterKey), false);
      if (input.action === 'status') return Response.json({ ok: true, state: state.control });
      const phase = {
        prepare: 'prepared',
        activate: 'activating',
        complete: 'complete',
        abort: 'aborted',
      }[input.action];
      const { action: _action, ...identity } = input;
      state.control = { ...identity, phase, receipts: [] };
      return Response.json({ ok: true, state: state.control });
    },
  });
  return {
    client,
    controls,
    requests,
    state,
    registryReads: () => registryReads,
    applicationReads: () => applicationReads,
    containers,
  };
}

function completedRolloutFixture() {
  const id = randomUUID();
  const rolloutId = randomUUID();
  const identity = {
    id,
    account_id: 'c'.repeat(32),
    durable_objects: { namespace_id: 'e'.repeat(32) },
  };
  const observations = [];
  const changes = {
    list: (value) => value,
    detail: (value) => value,
    rollout: (value) => value,
    status: () => 200,
  };
  const f = fixture({
    application: (value) =>
      value.name.includes('tenantcontainer')
        ? changes.list({
            ...value,
            ...structuredClone(identity),
            version: 10,
            configuration: { image: 'previous-image' },
            active_rollout_id: rolloutId,
          })
        : value,
    api: (url, options) => {
      if (!url.pathname.includes('/containers/applications/')) return;
      assert.equal(options.method, undefined);
      const resource = url.pathname.endsWith(`/rollouts/${rolloutId}`) ? 'rollout' : 'detail';
      assert.equal(
        url.pathname,
        `/client/v4/accounts/${identity.account_id}/containers/applications/${id}${resource === 'rollout' ? `/rollouts/${rolloutId}` : ''}`,
      );
      observations.push(resource);
      const status = changes.status(resource);
      if (status !== 200) return Response.json({ success: false }, { status });
      const container = f.containers[1];
      const result =
        resource === 'detail'
          ? changes.detail(
              {
                ...structuredClone(identity),
                name: container.name,
                version: 11,
                configuration: { image: container.image, vcpu: 1, memory_mib: 4096 },
              },
              observations.filter((value) => value === 'detail').length,
            )
          : changes.rollout({
              id: rolloutId,
              status: 'completed',
              current_version: 10,
              current_configuration: { image: 'previous-image' },
              target_version: 11,
              target_configuration: { image: container.image },
              health: { errors: [], instances: { failed: 0, healthy: 7 } },
              steps: [{ status: 'completed', step_size: { percentage: 100 } }],
              progress: {
                total_steps: 1,
                current_step: 1,
                updated_instances: 7,
                total_instances: 7,
                version_distribution: {
                  target_version_instances: 7,
                  current_version_instances: 0,
                  target_version_percentage: 100,
                },
              },
            });
      return Response.json({ success: true, result });
    },
  });
  return { ...f, changes, observations };
}

test('a stale application list requires exact completed rollout proof bracketed by coherent detail reads', async () => {
  const f = completedRolloutFixture();
  await f.client.prepare();
  await f.client.activate();
  await f.client.verifyRollouts();
  assert.deepEqual(f.observations, ['detail', 'rollout', 'detail']);
  await f.client.complete();
  assert.deepEqual(
    f.controls.map((input) => input.action),
    ['prepare', 'activate', 'complete'],
  );
  assert.equal(new Set(f.controls.map((input) => input.nonce)).size, 1);
});

test('the completed rollout fallback refuses malformed or foreign list identities without detail requests', async (t) => {
  for (const [name, change] of [
    ['missing application ID', (value) => delete value.id],
    ['malformed application ID', (value) => (value.id = '../foreign')],
    ['foreign account', (value) => (value.account_id = 'a'.repeat(32))],
    ['missing namespace', (value) => delete value.durable_objects],
    ['malformed namespace', (value) => (value.durable_objects.namespace_id = 'unknown')],
    ['missing list version', (value) => delete value.version],
    ['negative list version', (value) => (value.version = -1)],
    ['missing rollout ID', (value) => delete value.active_rollout_id],
    ['malformed rollout ID', (value) => (value.active_rollout_id = '../foreign')],
    ['unknown pending target', (value) => (value.scheduling_hint = { target: {} })],
    [
      'conflicting pending target',
      (value) => (value.scheduling_hint = { target: { configuration: { image: 'newer' } } }),
    ],
  ])
    await t.test(name, async () => {
      const f = completedRolloutFixture();
      f.changes.list = (value) => {
        change(value);
        return value;
      };
      await f.client.prepare();
      await f.client.activate();
      await assert.rejects(f.client.verifyRollouts());
      await assert.rejects(f.client.complete());
      assert.deepEqual(f.observations, []);
    });
});

test('the completed rollout fallback requires terminal progress for every instance and step', async (t) => {
  for (const [name, change] of [
    ['foreign rollout', (value) => (value.id = randomUUID())],
    ['pending rollout', (value) => (value.status = 'running')],
    ['failed rollout', (value) => (value.status = 'failed')],
    ['wrong source version', (value) => (value.current_version = 9)],
    ['wrong source image', (value) => (value.current_configuration.image = 'other')],
    ['non-increasing version', (value) => (value.target_version = 10)],
    ['wrong target version', (value) => (value.target_version = 12)],
    ['wrong target image', (value) => (value.target_configuration.image = 'wrong')],
    ['unknown target', (value) => delete value.target_configuration],
    ['reported health error', (value) => value.health.errors.push({ code: 'failed' })],
    ['missing health errors', (value) => delete value.health.errors],
    ['failed instance', (value) => (value.health.instances.failed = 1)],
    ['unknown instance health', (value) => delete value.health.instances.failed],
    ['no steps', (value) => (value.steps = [])],
    ['unfinished step', (value) => (value.steps[0].status = 'running')],
    ['partial final step', (value) => (value.steps[0].step_size.percentage = 50)],
    ['inconsistent steps', (value) => (value.progress.total_steps = 2)],
    ['unfinished progress step', (value) => (value.progress.current_step = 0)],
    ['no instances', (value) => (value.progress.total_instances = 0)],
    ['not all instances updated', (value) => (value.progress.updated_instances = 6)],
    ['fractional instance count', (value) => (value.progress.updated_instances = 7.5)],
    ['unknown distribution', (value) => delete value.progress.version_distribution],
    [
      'old-version instance',
      (value) => (value.progress.version_distribution.current_version_instances = 1),
    ],
    [
      'missing target instance',
      (value) => (value.progress.version_distribution.target_version_instances = 6),
    ],
    [
      'partial version distribution',
      (value) => (value.progress.version_distribution.target_version_percentage = 99),
    ],
  ])
    await t.test(name, async () => {
      const f = completedRolloutFixture();
      f.changes.rollout = (value) => {
        change(value);
        return value;
      };
      await f.client.prepare();
      await f.client.activate();
      await assert.rejects(f.client.verifyRollouts());
      await assert.rejects(f.client.complete());
      assert.deepEqual(f.observations, ['detail', 'rollout', 'detail', 'rollout']);
    });
});

test('rollout completion cannot mask conflicting, foreign or changed application detail', async (t) => {
  for (const [name, change] of [
    ['foreign application', (value) => (value.id = randomUUID())],
    ['foreign name', (value) => (value.name = 'foreign')],
    ['foreign account', (value) => (value.account_id = 'a'.repeat(32))],
    ['foreign namespace', (value) => (value.durable_objects.namespace_id = 'a'.repeat(32))],
    ['wrong version', (value) => (value.version = 12)],
    ['wrong image', (value) => (value.configuration.image = 'wrong')],
    ['newer active rollout', (value) => (value.active_rollout_id = randomUUID())],
    ['unknown target', (value) => (value.scheduling_hint = { target: {} })],
    [
      'conflicting target',
      (value) => (value.scheduling_hint = { target: { configuration: { image: 'wrong' } } }),
    ],
  ])
    for (const secondRead of [false, true])
      await t.test(`${name} on ${secondRead ? 'final' : 'first'} read`, async () => {
        const f = completedRolloutFixture();
        f.changes.detail = (value, read) => {
          if (!secondRead || read % 2 === 0) change(value);
          return value;
        };
        await f.client.prepare();
        await f.client.activate();
        await assert.rejects(f.client.verifyRollouts());
        await assert.rejects(f.client.complete());
        assert.equal(
          f.controls.some((input) => input.action === 'complete'),
          false,
        );
      });
  const f = completedRolloutFixture();
  f.changes.detail = (value, read) => {
    if (read % 2 === 0) value.configuration.memory_mib *= 2;
    return value;
  };
  await f.client.prepare();
  await f.client.activate();
  await assert.rejects(f.client.verifyRollouts());
  await assert.rejects(f.client.complete());
});

test('detail and rollout API failures remain closed without retrying an ambiguous response', async (t) => {
  for (const resource of ['detail', 'rollout'])
    for (const status of [403, 404, 500])
      await t.test(`${resource} HTTP ${status}`, async () => {
        const f = completedRolloutFixture();
        f.changes.status = (requested) => (requested === resource ? status : 200);
        await f.client.prepare();
        await f.client.activate();
        await assert.rejects(f.client.verifyRollouts());
        await assert.rejects(f.client.complete());
        assert.deepEqual(
          f.observations,
          resource === 'detail' ? ['detail'] : ['detail', 'rollout'],
        );
      });
});

test('a later failed verification invalidates earlier completed rollout proof before recovery can reopen', async () => {
  const f = completedRolloutFixture();
  const original = interrupted();
  f.state.control = original;
  await f.client.recover();
  await f.client.verifyRollouts();
  f.changes.rollout = (value) => ({ ...value, status: 'failed' });
  await assert.rejects(f.client.verifyRollouts());
  await assert.rejects(f.client.complete());
  assert.deepEqual(
    f.controls.map((input) => input.action),
    ['status'],
  );
  f.changes.rollout = (value) => value;
  await f.client.verifyRollouts();
  await f.client.complete();
  assert.deepEqual(
    f.controls.map((input) => input.action),
    ['status', 'complete'],
  );
  assert.equal(f.controls[1].nonce, original.nonce);
  assert.equal(f.controls[1].deadline, original.deadline);
});

test('existing deployment requires signed drain and all four exact image rollouts before reopening', async () => {
  const f = fixture();
  await assert.rejects(f.client.activate());
  await f.client.prepare();
  await f.client.activate();
  await assert.rejects(f.client.complete());
  f.state.rollout = true;
  await assert.rejects(f.client.verifyRollouts());
  await assert.rejects(f.client.abort());
  f.state.rollout = false;
  f.state.wrongImage = true;
  await assert.rejects(f.client.verifyRollouts());
  f.state.wrongImage = false;
  await f.client.verifyRollouts();
  await f.client.initialize();
  await f.client.complete();
  assert.deepEqual(
    f.controls.map((input) => input.action),
    ['prepare', 'activate', 'complete'],
  );
  assert.equal(new Set(f.controls.map((input) => input.nonce)).size, 1);
  assert.equal(f.registryReads(), 0);
  assert.equal(f.applicationReads(), 20);
});

test('ordinary deployment refuses the already running release without opening a control operation', async () => {
  const f = fixture({ published: true });
  await assert.rejects(f.client.prepare(), {
    message: 'Deployment safety checks did not pass; admission remains unchanged or closed.',
  });
  await assert.rejects(f.client.activate());
  await assert.rejects(f.client.complete());
  await assert.rejects(f.client.abort());
  assert.deepEqual(f.controls, []);
  assert.deepEqual(
    f.requests.map(({ url }) => url.pathname),
    [`/client/v4/accounts/${'c'.repeat(32)}/workers/scripts/otto/settings`, '/api/health'],
  );
  assert.equal(f.registryReads(), 0);
  assert.equal(f.applicationReads(), 0);
});

test('initial deployment requires confirmed absent Worker, absent applications and empty database registry', async () => {
  const f = fixture({ missing: true });
  await f.client.prepare();
  assert.equal(f.registryReads(), 1);
  assert.equal(f.controls.length, 0);
  await f.client.activate();
  f.state.published = true;
  await f.client.verifyRollouts();
  await assert.rejects(f.client.complete());
  await f.client.initialize();
  await f.client.complete();
  assert.deepEqual(
    f.controls.map((input) => input.action),
    ['prepare', 'activate', 'complete'],
  );
  assert.equal(f.controls[0].previousRelease, f.controls[0].targetRelease);
});

test('initial deployment refuses unknown or pending rollout metadata for any application', async (t) => {
  for (const [name, metadata] of [
    ['target without configuration', { scheduling_hint: { target: {} } }],
    ['target without image', { scheduling_hint: { target: { configuration: {} } } }],
    ['null target configuration', { scheduling_hint: { target: { configuration: null } } }],
    ['empty target image', { scheduling_hint: { target: { configuration: { image: '' } } } }],
    ['wrong target image', { scheduling_hint: { target: { configuration: { image: 'wrong' } } } }],
    ['non-object target', { scheduling_hint: { target: false } }],
    ['array target', { scheduling_hint: { target: [] } }],
    ['non-object scheduling hint', { scheduling_hint: false }],
    ['array scheduling hint', { scheduling_hint: [] }],
    ['pending rollout', { active_rollout_id: 'pending' }],
    ['unknown rollout identity', { active_rollout_id: false }],
  ]) {
    await t.test(name, async () => {
      const f = fixture({
        missing: true,
        application: (value) =>
          value.name.includes('workspacecomputer') ? { ...value, ...metadata } : value,
      });
      await f.client.prepare();
      await f.client.activate();
      f.state.published = true;
      await assert.rejects(f.client.verifyRollouts(), /Deployment safety checks did not pass/);
      await assert.rejects(f.client.initialize());
      await assert.rejects(f.client.complete());
      assert.equal(f.controls.length, 0);
      assert.equal(f.applicationReads(), 12);
    });
  }
});

test('initial deployment accepts absent, null or matching targets only after all current images match', async (t) => {
  for (const [name, metadata] of [
    ['absent scheduling hint', () => ({})],
    ['null scheduling hint', () => ({ scheduling_hint: null })],
    ['absent target', () => ({ scheduling_hint: {} })],
    ['null target', () => ({ scheduling_hint: { target: null } })],
    [
      'matching target',
      (value) => ({
        active_rollout_id: null,
        scheduling_hint: { target: { configuration: { image: value.configuration.image } } },
      }),
    ],
  ]) {
    await t.test(name, async () => {
      const f = fixture({
        missing: true,
        application: (value) => ({ ...value, ...metadata(value) }),
      });
      await f.client.prepare();
      await f.client.activate();
      f.state.published = true;
      await f.client.verifyRollouts();
      await f.client.initialize();
      await f.client.complete();
      assert.deepEqual(
        f.controls.map((input) => input.action),
        ['prepare', 'activate', 'complete'],
      );
    });
  }
});

test('API denial, unknown404, occupied registry or existing application never count as empty bootstrap', async () => {
  for (const changes of [
    { denied: true },
    { missing: true, missingCode: 99999 },
    { missing: true, occupied: true },
    { missing: true, published: true },
  ]) {
    const f = fixture(changes);
    await assert.rejects(f.client.prepare());
    await assert.rejects(f.client.activate());
    assert.equal(f.controls.length, 0);
  }
});

test('pre-activation abort is explicitly signed against the same deployment identity', async () => {
  const f = fixture();
  await f.client.prepare();
  await f.client.abort();
  assert.deepEqual(
    f.controls.map((input) => input.action),
    ['prepare', 'abort'],
  );
  assert.equal(f.controls[0].nonce, f.controls[1].nonce);
});

function interrupted(phase = 'activating', changes = {}) {
  return {
    nonce: randomUUID(),
    targetRelease: 'b'.repeat(40),
    previousRelease: 'a'.repeat(40),
    deadline: Date.now() - 1_000,
    phase,
    receipts: [],
    ...changes,
  };
}

test('recovery retains the exact interrupted deployment identity and re-verifies every image before complete', async () => {
  const original = interrupted();
  const f = fixture({ control: original, published: true });
  const status = await f.client.recover();
  assert.equal(status.nonce, original.nonce);
  assert.equal(status.phase, 'activating');
  assert.equal('receipts' in status, false);
  await assert.rejects(f.client.complete());
  f.state.rollout = true;
  await assert.rejects(f.client.verifyRollouts());
  f.state.rollout = false;
  await f.client.verifyRollouts();
  await f.client.complete();
  assert.deepEqual(
    f.controls.map((input) => input.action),
    ['status', 'complete'],
  );
  assert.equal(f.controls[1].nonce, original.nonce);
  assert.equal(f.controls[1].deadline, original.deadline);
});

test('explicit recovery preserves existing same-release operations for completion and abort', async () => {
  for (const action of ['complete', 'abort']) {
    const original = interrupted(action === 'complete' ? 'activating' : 'failed', {
      previousRelease: 'b'.repeat(40),
    });
    const f = fixture({ control: original, published: true });
    const status = await f.client.recover();
    assert.equal(status.previousRelease, status.targetRelease);
    if (action === 'complete') await f.client.verifyRollouts();
    await f.client[action]();
    assert.deepEqual(
      f.controls.map((input) => input.action),
      ['status', action],
    );
    const { action: _action, ...identity } = f.controls[1];
    const { phase: _phase, receipts: _receipts, ...expected } = original;
    assert.deepEqual(identity, expected);
  }
});

test('recovery keeps admission closed until every present target has a known matching image', async () => {
  const original = interrupted();
  const f = fixture({
    control: original,
    published: true,
    application: (value) =>
      value.name.includes('browsercomputer')
        ? { ...value, scheduling_hint: { target: { configuration: {} } } }
        : value,
  });
  await f.client.recover();
  await assert.rejects(f.client.verifyRollouts(), /Deployment safety checks did not pass/);
  await assert.rejects(f.client.complete());
  assert.deepEqual(
    f.controls.map((input) => input.action),
    ['status'],
  );
  f.state.application = (value) => ({
    ...value,
    scheduling_hint: { target: { configuration: { image: value.configuration.image } } },
  });
  await f.client.verifyRollouts();
  f.state.application = (value) => ({ ...value, scheduling_hint: { target: {} } });
  await assert.rejects(f.client.verifyRollouts(), /Deployment safety checks did not pass/);
  await assert.rejects(f.client.complete());
  assert.equal(f.controls.length, 1);
  f.state.application = (value) => ({ ...value, scheduling_hint: { target: null } });
  await f.client.verifyRollouts();
  await f.client.complete();
  assert.deepEqual(
    f.controls.map((input) => input.action),
    ['status', 'complete'],
  );
  assert.equal(f.controls[1].nonce, original.nonce);
  assert.equal(f.controls[1].deadline, original.deadline);
});

test('recovery rejects absent, malformed or foreign-release barriers and cannot abort after activation', async () => {
  for (const control of [
    null,
    interrupted('unknown'),
    interrupted('failed', { targetRelease: 'c'.repeat(40) }),
    interrupted('failed', { nonce: 'invalid' }),
  ]) {
    const f = fixture({ control });
    await assert.rejects(f.client.recover());
    assert.deepEqual(
      f.controls.map((input) => input.action),
      ['status'],
    );
  }
  const f = fixture({ control: interrupted() });
  await f.client.recover();
  await assert.rejects(f.client.abort());
  assert.equal(f.controls.length, 1);
});

test('pre-activation recovery can request abort with the original expired deadline without preparing again', async () => {
  const original = interrupted('failed');
  const f = fixture({ control: original });
  await f.client.recover();
  await f.client.abort();
  assert.deepEqual(
    f.controls.map((input) => input.action),
    ['status', 'abort'],
  );
  assert.equal(f.controls[1].nonce, original.nonce);
  assert.equal(f.controls[1].deadline, original.deadline);
});
