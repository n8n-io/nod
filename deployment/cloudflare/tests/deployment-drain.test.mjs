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
process.stdout.write(fixture.output);
`,
    { mode: 0o700 },
  );
  return {
    reference: `${image.slice(0, image.lastIndexOf(':'))}@sha256:${'c'.repeat(64)}`,
    async inspect(manifest) {
      await writeFile(
        fixturePath,
        JSON.stringify({
          args: ['manifest', 'inspect', '-v', image],
          output: JSON.stringify(manifest),
        }),
        { mode: 0o600 },
      );
      return inspectImageDigest(image, {
        PATH: directory,
        OTTO_MANIFEST_FIXTURE: fixturePath,
      });
    },
  };
}

function manifestEntry(mediaType) {
  return {
    Descriptor: {
      mediaType,
      digest: `sha256:${'c'.repeat(64)}`,
      platform: { os: 'linux', architecture: 'amd64' },
    },
  };
}

test('registry inspection pins an individual amd64 image from OCI and Docker object responses', async (t) => {
  const f = await manifestFixture(t);
  for (const mediaType of [
    'application/vnd.oci.image.manifest.v1+json',
    'application/vnd.docker.distribution.manifest.v2+json',
  ])
    assert.equal(await f.inspect(manifestEntry(mediaType)), f.reference);
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
  const controls = [];
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
    emptyRegistry: async () => !state.occupied,
    fetcher: async (raw, options) => {
      const url = new URL(raw);
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
  return { client, controls, state, containers };
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
  const changes = { rollout: (value) => value };
  const f = fixture({
    application: (value) =>
      value.name.includes('tenantcontainer')
        ? {
            ...value,
            ...structuredClone(identity),
            version: 10,
            configuration: { image: 'previous-image' },
            active_rollout_id: rolloutId,
          }
        : value,
    api: (url) => {
      if (!url.pathname.includes('/containers/applications/')) return;
      const resource = url.pathname.endsWith(`/rollouts/${rolloutId}`) ? 'rollout' : 'detail';
      observations.push(resource);
      const container = f.containers[1];
      const result =
        resource === 'detail'
          ? {
              ...structuredClone(identity),
              name: container.name,
              version: 11,
              configuration: { image: container.image, vcpu: 1, memory_mib: 4096 },
            }
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
  assert.equal(new Set(f.controls.map((input) => input.nonce)).size, 1);
});

test('the completed rollout fallback requires terminal progress for every instance and step', async (t) => {
  for (const [name, change] of [
    ['pending rollout', (value) => (value.status = 'running')],
    ['wrong target image', (value) => (value.target_configuration.image = 'wrong')],
    ['failed instance', (value) => (value.health.instances.failed = 1)],
    [
      'old-version instance',
      (value) => (value.progress.version_distribution.current_version_instances = 1),
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
    });
});

test('a later failed verification invalidates earlier completed rollout proof before recovery can reopen', async () => {
  const f = completedRolloutFixture();
  const original = interrupted();
  f.state.control = original;
  await f.client.recover();
  await assert.rejects(f.client.complete());
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
});

test('ordinary deployment refuses the already running release without opening a control operation', async () => {
  const f = fixture({ published: true });
  await assert.rejects(f.client.prepare());
  await assert.rejects(f.client.activate());
  await assert.rejects(f.client.complete());
  await assert.rejects(f.client.abort());
  assert.deepEqual(f.controls, []);
});

test('initial deployment requires confirmed absent Worker, absent applications and empty database registry', async () => {
  const f = fixture({ missing: true });
  await f.client.prepare();
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
    ['target without image', { scheduling_hint: { target: { configuration: {} } } }],
    ['wrong target image', { scheduling_hint: { target: { configuration: { image: 'wrong' } } } }],
    ['pending rollout', { active_rollout_id: 'pending' }],
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
      await assert.rejects(f.client.verifyRollouts());
      await assert.rejects(f.client.initialize());
      await assert.rejects(f.client.complete());
      assert.equal(f.controls.length, 0);
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
