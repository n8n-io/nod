import assert from 'node:assert/strict';
import { readFile, stat } from 'node:fs/promises';
import test from 'node:test';
import { deploy as deployRelease, deploymentPlan } from '../scripts/deploy.mjs';
import { verifyDeployment } from '../scripts/smoke.mjs';
import { recoverDeployment } from '../scripts/recover.mjs';

const release = 'a'.repeat(40);
const accountId = 'b'.repeat(32);
const origin = 'https://otto.test.workers.dev';
const variables = {
  CLOUDFLARE_ACCOUNT_ID: accountId,
  CLOUDFLARE_API_TOKEN: 'synthetic-cloudflare-credential',
  OTTO_RELEASE: release,
  OTTO_PUBLIC_URL: origin,
  GATEWAY_ENV: JSON.stringify({
    OTTO_ENVIRONMENT: 'production',
    OTTO_PUBLIC_URL: origin,
    AUTH_SECRET: 'synthetic-gateway-credential',
    OTTO_MASTER_KEY: Buffer.alloc(32, 1).toString('base64'),
    DATABASE_URL: 'postgresql://synthetic:synthetic@db.example.test/otto',
    COMPUTER_PROVIDER: 'cloudflare',
    OBJECT_STORAGE_PROVIDER: 'http',
    OBJECT_STORAGE_ENDPOINT: 'http://otto.storage/v1/objects/',
  }),
};

function configuration() {
  const classes = [
    'GatewayContainer',
    'TenantContainer',
    'BrowserComputerContainer',
    'WorkspaceComputerContainer',
  ];
  return {
    name: 'otto',
    main: 'src/worker.ts',
    assets: { directory: '../../dist/web' },
    env: {
      production: {
        name: 'otto',
        r2_buckets: [
          { binding: 'TENANT_FILES', bucket_name: 'otto-production-files', jurisdiction: 'eu' },
        ],
        containers: classes.map((class_name) => ({
          class_name,
          image: './Dockerfile',
          image_build_context: '../..',
          image_vars: { SYNTHETIC_BUILD: 'unused' },
        })),
      },
    },
  };
}

function deploy(environment, environmentVariables, dependencies) {
  return deployRelease(environment, environmentVariables, {
    ...dependencies,
    request: async (url, options) => {
      if (url.endsWith('/containers/image-preparations'))
        return Response.json({
          success: true,
          result: { image: JSON.parse(options.body).image, status: 'ready' },
        });
      return dependencies.request?.(url, options) ?? workerSettings();
    },
  });
}

function workerSettings(
  bindings = [
    {
      name: 'TENANT_FILES',
      type: 'r2_bucket',
      bucket_name: 'otto-production-files',
      jurisdiction: 'eu',
    },
  ],
) {
  return Response.json({ success: true, result: { bindings } });
}

function lifecycle(events = [], failures = {}) {
  return Object.fromEntries(
    ['prepare', 'activate', 'verifyRollouts', 'initialize', 'complete', 'abort'].map((action) => [
      action,
      async () => {
        events.push(action);
        if (failures[action]) throw new Error('Synthetic control failure.');
      },
    ]),
  );
}

function imageDigest(image) {
  return `${image.slice(0, image.lastIndexOf(':'))}@sha256:${'d'.repeat(64)}`;
}

function planInput() {
  return {
    environment: 'production',
    release,
    accountId,
    publicUrl: origin,
    gatewayEnv: variables.GATEWAY_ENV,
    config: configuration(),
  };
}

test('deployment validation rejects another environment, origin and invalid revision before publishing', () => {
  const input = planInput();
  for (const change of [
    { environment: 'unknown' },
    { release: 'main' },
    { publicUrl: 'http://otto.test' },
    { publicUrl: `${origin}/app` },
    { gatewayEnv: JSON.stringify({ OTTO_ENVIRONMENT: 'development' }) },
    { gatewayEnv: JSON.stringify({ OTTO_PUBLIC_URL: 'https://other.example' }) },
    { gatewayEnv: JSON.stringify({ AUTH_SECRET: 42 }) },
    { gatewayEnv: JSON.stringify({ OTTO_IMAGE_RELEASE: release }) },
    { gatewayEnv: JSON.stringify({ AUTH_SECRET: 'x'.repeat(6000) }) },
  ])
    assert.throws(() => deploymentPlan({ ...input, ...change }));
  const plan = deploymentPlan(input);
  assert.equal(JSON.parse(plan.secrets.GATEWAY_ENV).OTTO_RELEASE, release);
  assert.equal(JSON.stringify(plan.config).includes('synthetic-gateway-credential'), false);
});

test('missing, denied or mismatched deployed storage never permits admission completion', async () => {
  const valid = {
    name: 'TENANT_FILES',
    type: 'r2_bucket',
    bucket_name: 'otto-production-files',
    jurisdiction: 'eu',
  };
  for (const response of [
    () => new Response('private-api-error', { status: 403 }),
    () => workerSettings([]),
    () => workerSettings([{ ...valid, bucket_name: 'foreign-private-bucket' }]),
    () => workerSettings([{ ...valid, jurisdiction: 'default' }]),
  ]) {
    const events = [];
    await assert.rejects(
      deploy('production', variables, {
        config: configuration(),
        deploymentControl: lifecycle(events),
        imageDigest,
        report() {},
        command: async () => {},
        request: async () => response(),
        smoke: async () => assert.fail('Storage verification must precede smoke.'),
      }),
    );
    assert.equal(events.includes('complete'), false);
  }
});

test('deployment keeps secrets out of arguments, child environments and reports, pins images and removes private files', async () => {
  const reports = [];
  let temporaryConfig;
  let secretPath;
  await deploy('production', variables, {
    config: configuration(),
    deploymentControl: lifecycle(),
    imageDigest,
    report: (message) => reports.push(message),
    command: async (args, env) => {
      assert.equal(env.GATEWAY_ENV, undefined);
      assert.equal(env.AUTH_SECRET, undefined);
      assert.equal(args.join(' ').includes('synthetic'), false);
      temporaryConfig = args[args.indexOf('--config') + 1];
      assert.equal((await stat(temporaryConfig)).mode & 0o777, 0o600);
      if (args[0] === 'deploy') {
        const configuration = JSON.parse(await readFile(temporaryConfig, 'utf8'));
        assert.ok(
          configuration.env.production.containers.every((value) =>
            value.image.endsWith(`@sha256:${'d'.repeat(64)}`),
          ),
        );
        secretPath = args[args.indexOf('--secrets-file') + 1];
        assert.equal((await stat(secretPath)).mode & 0o777, 0o600);
      }
    },
    smoke: async () => {},
  });
  assert.equal(reports.join(' ').includes('synthetic'), false);
  await assert.rejects(stat(temporaryConfig), { code: 'ENOENT' });
  await assert.rejects(stat(secretPath), { code: 'ENOENT' });
});

test('unavailable image preparation cannot close admission or publish Worker code', async (t) => {
  const prepared = (image, changes = {}) => ({
    success: true,
    result: { image, status: 'ready', ...changes },
  });
  for (const [name, response] of [
    ['foreign image', () => Response.json(prepared('registry.cloudflare.com/foreign'))],
    ['denied', () => new Response('private-api-error', { status: 403 })],
    ['accepted but not ready', (image) => Response.json(prepared(image), { status: 202 })],
    [
      'pending past deadline',
      (image) => Response.json(prepared(image, { status: 'pending' }), { status: 202 }),
    ],
  ]) {
    await t.test(name, async () => {
      const events = [];
      let elapsed = 0;
      await assert.rejects(
        deployRelease('production', variables, {
          config: configuration(),
          deploymentControl: lifecycle(events),
          imageDigest,
          report() {},
          now: () => elapsed,
          wait: async (duration) => {
            elapsed += duration;
          },
          command: async (args) => events.push(args[0]),
          request: async (_url, options) => response(JSON.parse(options.body).image),
          smoke: async () => assert.fail('An unprepared image must not reach smoke checks.'),
        }),
        (error) => {
          assert.equal(/private-|synthetic-cloudflare-credential/.test(error.message), false);
          return true;
        },
      );
      assert.equal(events.includes('prepare'), false);
      assert.equal(events.includes('deploy'), false);
    });
  }
});

test('failed drain, activation or verification cannot publish or reopen prematurely', async () => {
  for (const failure of ['prepare', 'activate', 'verifyRollouts', 'smoke', 'initialize']) {
    const events = [];
    const commands = [];
    await assert.rejects(
      deploy('production', variables, {
        config: configuration(),
        report() {},
        imageDigest,
        deploymentControl: lifecycle(events, { [failure]: true }),
        command: async (args) => commands.push(args[0]),
        smoke: async () => {
          if (failure === 'smoke') throw new Error('Synthetic smoke failure.');
        },
      }),
    );
    assert.equal(events.includes('complete'), false);
    assert.equal(commands.includes('deploy'), !['prepare', 'activate'].includes(failure));
  }
});

test('recovery completion cannot bypass a denied or mismatched deployed storage binding', async () => {
  for (const phase of ['activating', 'complete']) {
    for (const response of [
      () => new Response('private-api-error', { status: 403 }),
      () => workerSettings([]),
      () =>
        workerSettings([
          {
            name: 'TENANT_FILES',
            type: 'r2_bucket',
            bucket_name: 'foreign-bucket',
            jurisdiction: 'eu',
          },
        ]),
    ]) {
      const events = [];
      const control = lifecycle(events);
      control.recover = async () => ({ phase });
      await assert.rejects(
        recoverDeployment('production', 'complete', variables, {
          config: configuration(),
          deploymentControl: control,
          imageDigest,
          request: async () => response(),
          smoke: () => assert.fail('Invalid storage must not reach smoke.'),
          report() {},
        }),
      );
      assert.deepEqual(events, []);
    }
  }
});

test('recovery refuses completion before activation and abort after activation', async () => {
  for (const [action, phase] of [
    ['complete', 'prepared'],
    ['abort', 'activating'],
  ]) {
    const events = [];
    const control = lifecycle(events);
    control.recover = async () => ({ phase });
    await assert.rejects(
      recoverDeployment('production', action, variables, {
        config: configuration(),
        deploymentControl: control,
        imageDigest: () => assert.fail('Invalid recovery phase must not inspect images.'),
        report: () => {},
      }),
    );
    assert.deepEqual(events, []);
  }
});

function smokeFetch({ incorrectRelease = false, exposedState = false } = {}) {
  return async (url, options) => {
    assert.equal(options.redirect, 'error');
    assert.equal(options.headers?.cookie, undefined);
    if (url.pathname === '/api/health')
      return Response.json({ ok: true, release: incorrectRelease ? 'old' : release });
    if (url.pathname === '/api/session')
      return Response.json({
        auth: { mode: 'google', googleAvailable: true },
        user: null,
        settings: null,
        capabilities: { developer: false },
      });
    return new Response(null, {
      status:
        url.pathname === '/api/state'
          ? exposedState
            ? 200
            : 401
          : url.pathname === '/api/login'
            ? 403
            : 404,
    });
  };
}

test('smoke checks require the new release and public authorization denials', async () => {
  await verifyDeployment({ origin, release, fetcher: smokeFetch(), attempts: 1 });
  await assert.rejects(
    verifyDeployment({
      origin,
      release,
      fetcher: smokeFetch({ incorrectRelease: true }),
      attempts: 1,
    }),
  );
  await assert.rejects(
    verifyDeployment({ origin, release, fetcher: smokeFetch({ exposedState: true }), attempts: 1 }),
  );
});
