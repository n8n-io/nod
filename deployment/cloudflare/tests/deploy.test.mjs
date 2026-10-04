import assert from 'node:assert/strict';
import { readFile, stat } from 'node:fs/promises';
import test from 'node:test';
import {
  deploy as deployRelease,
  deploymentPlan,
  verifyStorageBinding,
} from '../scripts/deploy.mjs';
import { verifyDeployment } from '../scripts/smoke.mjs';
import { recoverDeployment } from '../scripts/recover.mjs';
import { createDeploymentClient } from '../scripts/drain.mjs';

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

function gatewayValues(changes) {
  return JSON.stringify({ ...JSON.parse(variables.GATEWAY_ENV), ...changes });
}

const e2bGateway = gatewayValues({
  COMPUTER_PROVIDER: 'e2b',
  E2B_API_KEY: 'synthetic-e2b-credential',
  E2B_COMPUTER_TEMPLATE: 'synthetic-computer-template',
});

function configuration(computers = true) {
  const classes = ['GatewayContainer', 'TenantContainer'];
  if (computers) classes.push('BrowserComputerContainer', 'WorkspaceComputerContainer');
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

function planInput(config = configuration()) {
  return {
    environment: 'production',
    release,
    accountId,
    publicUrl: origin,
    gatewayEnv: variables.GATEWAY_ENV,
    config,
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
  assert.equal(
    plan.config.env.production.containers[0].image,
    `registry.cloudflare.com/${accountId}/otto-production:${release}`,
  );
  assert.equal(JSON.parse(plan.secrets.GATEWAY_ENV).OTTO_RELEASE, release);
  assert.equal(JSON.stringify(plan.config).includes('synthetic-gateway-credential'), false);
});

test('deployment requires one explicit EU object binding before publication', () => {
  const valid = configuration().env.production.r2_buckets[0];
  for (const bindings of [
    undefined,
    {},
    [],
    [null],
    [valid, valid],
    [{ ...valid, binding: 'OTHER_FILES' }],
    [{ ...valid, bucket_name: undefined }],
    [{ ...valid, bucket_name: '' }],
    [{ ...valid, bucket_name: 'private/path' }],
    [{ ...valid, jurisdiction: undefined }],
    [{ ...valid, jurisdiction: 'default' }],
  ]) {
    const config = configuration();
    config.env.production.r2_buckets = bindings;
    assert.throws(() => deploymentPlan(planInput(config)));
  }
  for (const name of [
    undefined,
    '',
    '../other-worker',
    'worker?other=true',
    'Otto',
    'otto_production',
    '-otto',
  ]) {
    const config = configuration();
    config.env.production.name = name;
    assert.throws(() => deploymentPlan(planInput(config)));
  }
});

test('routine CI preserves an explicit EU binding without R2 administration and verifies its deployed identity', async () => {
  const events = [];
  const requests = [];
  let deploymentArgs;
  await deploy('production', variables, {
    config: configuration(),
    deploymentControl: lifecycle(events),
    imageDigest,
    report() {},
    command: async (args) => {
      if (args[0] !== 'deploy') return;
      deploymentArgs = args;
      events.push('deploy');
      const config = JSON.parse(await readFile(args[args.indexOf('--config') + 1], 'utf8'));
      assert.deepEqual(config.env.production.r2_buckets, configuration().env.production.r2_buckets);
    },
    request: async (url, options) => {
      requests.push(url);
      events.push('storage');
      assert.equal(
        url,
        `https://api.cloudflare.com/client/v4/accounts/${accountId}/workers/scripts/otto/settings`,
      );
      assert.equal(options.method, 'GET');
      assert.equal(options.headers.authorization, `Bearer ${variables.CLOUDFLARE_API_TOKEN}`);
      assert.equal(options.redirect, 'error');
      assert.equal(options.cache, 'no-store');
      assert.ok(options.signal instanceof AbortSignal);
      return workerSettings();
    },
    smoke: async () => events.push('smoke'),
  });
  assert.equal(requests.length, 1);
  assert.ok(deploymentArgs.includes('--experimental-provision=false'));
  assert.deepEqual(events, [
    'prepare',
    'activate',
    'deploy',
    'storage',
    'verifyRollouts',
    'smoke',
    'initialize',
    'complete',
  ]);
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
    () => new Response(null, { status: 404 }),
    () => Response.json({ success: false, result: { bindings: [valid] } }),
    () =>
      Response.json({
        success: true,
        errors: [{ message: 'private-error' }],
        result: { bindings: [valid] },
      }),
    () => Response.json({ success: true, result: {} }),
    () => workerSettings([]),
    () => workerSettings([valid, valid]),
    () => workerSettings([{ ...valid, type: 'kv_namespace' }]),
    () => workerSettings([{ ...valid, bucket_name: 'foreign-private-bucket' }]),
    () => workerSettings([{ ...valid, jurisdiction: 'default' }]),
    () => workerSettings([{ ...valid, jurisdiction: undefined }]),
    () => new Response('private-invalid-json'),
    () => {
      throw new Error('private-network-error');
    },
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
      (error) => {
        assert.equal(
          error.message,
          'The deployed private object binding did not pass verification.',
        );
        return true;
      },
    );
    assert.deepEqual(events, ['prepare', 'activate', 'abort']);
  }
});

test('deployed storage readback uses the selected environment and refuses an inherited or foreign binding', async () => {
  const config = configuration();
  config.env.development = {
    ...config.env.production,
    name: 'otto-development',
    r2_buckets: [
      { binding: 'TENANT_FILES', bucket_name: 'otto-development-files', jurisdiction: 'eu' },
    ],
  };
  const plan = deploymentPlan({
    ...planInput(config),
    environment: 'development',
    gatewayEnv: gatewayValues({ OTTO_ENVIRONMENT: 'development' }),
  });
  const read = async (url) => {
    assert.equal(
      url,
      `https://api.cloudflare.com/client/v4/accounts/${accountId}/workers/scripts/otto-development/settings`,
    );
    return workerSettings([
      {
        name: 'TENANT_FILES',
        type: 'r2_bucket',
        bucket_name: 'otto-development-files',
        jurisdiction: 'eu',
      },
    ]);
  };
  await verifyStorageBinding(plan, 'development', variables.CLOUDFLARE_API_TOKEN, read);
  await assert.rejects(
    verifyStorageBinding(plan, 'development', variables.CLOUDFLARE_API_TOKEN, async () =>
      workerSettings(),
    ),
    { message: 'The deployed private object binding did not pass verification.' },
  );
});

test('deployed storage readback bounds and cancels oversized or invalid response bodies', async () => {
  const plan = deploymentPlan(planInput());
  let cancelled = false;
  const oversized = new Response(
    new ReadableStream({
      pull(controller) {
        controller.enqueue(new Uint8Array(64 * 1024));
      },
      cancel() {
        cancelled = true;
      },
    }),
  );
  for (const response of [
    oversized,
    new Response(new Uint8Array([0xff])),
    new Response('{}', { headers: { 'content-length': '524289' } }),
  ])
    await assert.rejects(
      verifyStorageBinding(
        plan,
        'production',
        variables.CLOUDFLARE_API_TOKEN,
        async () => response,
      ),
      { message: 'The deployed private object binding did not pass verification.' },
    );
  assert.equal(cancelled, true);
});

test('incomplete hosted computer and storage configuration is rejected before any publication', async (t) => {
  for (const [name, changes] of [
    ['missing computer', { COMPUTER_PROVIDER: undefined }],
    ['empty computer', { COMPUTER_PROVIDER: '' }],
    ['local computer', { COMPUTER_PROVIDER: 'docker' }],
    ['unknown computer', { COMPUTER_PROVIDER: 'synthetic-private-provider' }],
    ['missing storage', { OBJECT_STORAGE_PROVIDER: undefined }],
    ['process storage', { OBJECT_STORAGE_PROVIDER: 'postgres' }],
    ['filesystem storage', { OBJECT_STORAGE_PROVIDER: 'filesystem' }],
    ['missing endpoint', { OBJECT_STORAGE_ENDPOINT: undefined }],
    ['empty endpoint', { OBJECT_STORAGE_ENDPOINT: '' }],
    ['host-only endpoint', { OBJECT_STORAGE_ENDPOINT: 'http://otto.storage' }],
    ['foreign endpoint', { OBJECT_STORAGE_ENDPOINT: 'https://synthetic-private-host/v1/objects/' }],
    [
      'endpoint query',
      {
        OBJECT_STORAGE_ENDPOINT: 'http://otto.storage/v1/objects/?token=synthetic-private-token',
      },
    ],
    ['E2B missing key', { ...JSON.parse(e2bGateway), E2B_API_KEY: undefined }],
    ['E2B missing computer', { ...JSON.parse(e2bGateway), E2B_COMPUTER_TEMPLATE: undefined }],
    ['E2B empty computer', { ...JSON.parse(e2bGateway), E2B_COMPUTER_TEMPLATE: '  ' }],
  ]) {
    await t.test(name, async () => {
      const reports = [];
      await assert.rejects(
        deploy(
          'production',
          { ...variables, GATEWAY_ENV: gatewayValues(changes) },
          {
            config: configuration(),
            command: () => assert.fail('Provider validation must happen before publication.'),
            smoke: () => assert.fail('Provider validation must happen before smoke checks.'),
            report: (message) => reports.push(message),
          },
        ),
        (error) => {
          assert.ok(error instanceof Error);
          assert.doesNotMatch(error.message, /synthetic|credential|token=/);
          return true;
        },
      );
      assert.deepEqual(reports, []);
    });
  }
});

test('explicit hosted providers remain supported in both deployment environments', () => {
  for (const environment of ['development', 'production']) {
    for (const computerProvider of ['cloudflare', 'e2b']) {
      const config = configuration(computerProvider === 'cloudflare');
      config.env[environment] = config.env.production;
      const gatewayEnv = gatewayValues({
        ...(computerProvider === 'e2b' ? JSON.parse(e2bGateway) : {}),
        OTTO_ENVIRONMENT: environment,
      });
      const plan = deploymentPlan({ ...planInput(config), environment, gatewayEnv });
      const values = JSON.parse(plan.secrets.GATEWAY_ENV);
      assert.equal(values.COMPUTER_PROVIDER, computerProvider);
      assert.equal(values.OBJECT_STORAGE_PROVIDER, 'http');
      assert.equal(values.OBJECT_STORAGE_ENDPOINT, 'http://otto.storage/v1/objects/');
      assert.equal(plan.localImages.length, computerProvider === 'cloudflare' ? 3 : 1);
    }
  }
});

test('unsupported container classes fail before publishing without echoing configuration', async () => {
  for (const className of ['UnknownContainer', '__proto__', undefined]) {
    const config = configuration(false);
    config.env.production.containers.push({ class_name: className });
    await assert.rejects(
      deploy('production', variables, {
        config,
        command: () => assert.fail('Invalid classes must not publish.'),
      }),
      { message: 'The deployment has an unsupported container class.' },
    );
  }
});

test('deployment publishes all images before uploading code and secrets, cleans private files', async () => {
  const commands = [];
  const events = [];
  const reports = [];
  let temporaryConfig;
  let secretPath;
  let smoke;
  await deploy('production', variables, {
    config: configuration(),
    deploymentControl: lifecycle(events),
    imageDigest: async (image) => {
      events.push('digest');
      return imageDigest(image);
    },
    report: (message) => reports.push(message),
    command: async (args, env) => {
      commands.push(args);
      events.push(args[0] === 'deploy' ? 'deploy' : 'push');
      assert.equal(env.GATEWAY_ENV, undefined);
      assert.equal(env.AUTH_SECRET, undefined);
      assert.equal(env.CLOUDFLARE_API_TOKEN, variables.CLOUDFLARE_API_TOKEN);
      assert.equal(args.join(' ').includes('synthetic'), false);
      temporaryConfig = args[args.indexOf('--config') + 1];
      assert.equal((await stat(temporaryConfig)).mode & 0o777, 0o600);
      const configuration = JSON.parse(await readFile(temporaryConfig, 'utf8'));
      assert.equal(configuration.env.production.containers.length, 4);
      assert.equal(configuration.env.development, undefined);
      assert.ok(
        configuration.env.production.containers.every((value) =>
          value.image.endsWith(args[0] === 'deploy' ? `@sha256:${'d'.repeat(64)}` : `:${release}`),
        ),
      );
      if (args[0] === 'deploy') {
        secretPath = args[args.indexOf('--secrets-file') + 1];
        assert.equal((await stat(secretPath)).mode & 0o777, 0o600);
        assert.equal(
          JSON.parse(JSON.parse(await readFile(secretPath, 'utf8')).GATEWAY_ENV).AUTH_SECRET,
          'synthetic-gateway-credential',
        );
      }
    },
    smoke: async (input) => {
      events.push('smoke');
      smoke = input;
    },
  });
  assert.deepEqual(
    commands.map((args) => args[0]),
    ['containers', 'containers', 'containers', 'deploy'],
  );
  assert.deepEqual(
    commands.slice(0, 3).map((args) => args[2]),
    [
      `otto-production:${release}`,
      `otto-production-browser:${release}`,
      `otto-production-workspace:${release}`,
    ],
  );
  assert.deepEqual(smoke, { origin, release });
  assert.deepEqual(events, [
    'push',
    'push',
    'push',
    'digest',
    'digest',
    'digest',
    'prepare',
    'activate',
    'deploy',
    'verifyRollouts',
    'smoke',
    'initialize',
    'complete',
  ]);
  assert.equal(reports.join(' ').includes('synthetic'), false);
  await assert.rejects(stat(temporaryConfig), { code: 'ENOENT' });
  await assert.rejects(stat(secretPath), { code: 'ENOENT' });
});

test('pending image preparation keeps admission open until every unique pinned image is ready', async () => {
  const images = [
    `registry.cloudflare.com/${accountId}/otto-production@sha256:${'d'.repeat(64)}`,
    `registry.cloudflare.com/${accountId}/otto-production-browser@sha256:${'d'.repeat(64)}`,
    `registry.cloudflare.com/${accountId}/otto-production-workspace@sha256:${'d'.repeat(64)}`,
  ];
  const ready = new Set();
  const calls = new Map();
  const events = [];
  let elapsed = 0;
  const control = lifecycle(events);
  control.prepare = async () => {
    assert.deepEqual([...ready].sort(), [...images].sort());
    events.push('prepare');
  };
  await deployRelease('production', variables, {
    config: configuration(),
    deploymentControl: control,
    imageDigest,
    report() {},
    now: () => elapsed,
    wait: async (duration) => {
      assert.equal(events.includes('prepare'), false);
      assert.equal(events.includes('deploy'), false);
      elapsed += duration;
    },
    command: async (args) => {
      events.push(args[0] === 'deploy' ? 'deploy' : 'push');
    },
    request: async (url, options) => {
      if (url.endsWith('/workers/scripts/otto/settings')) return workerSettings();
      assert.equal(
        url,
        `https://api.cloudflare.com/client/v4/accounts/${accountId}/containers/image-preparations`,
      );
      assert.equal(options.method, 'POST');
      assert.equal(options.headers.authorization, `Bearer ${variables.CLOUDFLARE_API_TOKEN}`);
      assert.equal(options.headers['content-type'], 'application/json');
      assert.equal(options.redirect, 'error');
      assert.equal(options.cache, 'no-store');
      assert.ok(options.signal instanceof AbortSignal);
      const { image } = JSON.parse(options.body);
      assert.ok(images.includes(image));
      assert.deepEqual(JSON.parse(options.body), { image });
      assert.equal(events.includes('prepare'), false);
      const count = (calls.get(image) ?? 0) + 1;
      calls.set(image, count);
      const prepared = count >= images.indexOf(image) + 1;
      if (prepared) ready.add(image);
      return Response.json(
        { success: true, result: { image, status: prepared ? 'ready' : 'pending' } },
        { status: prepared ? 200 : 202 },
      );
    },
    smoke: async () => events.push('smoke'),
  });
  assert.deepEqual(
    [...calls],
    images.map((image, index) => [image, index + 1]),
  );
  assert.deepEqual(events, [
    'push',
    'push',
    'push',
    'prepare',
    'activate',
    'deploy',
    'verifyRollouts',
    'smoke',
    'initialize',
    'complete',
  ]);
  assert.ok(elapsed > 0 && elapsed < 15 * 60_000);
});

test('unavailable image preparation cannot close admission or publish Worker code', async (t) => {
  const prepared = (image, changes = {}) => ({
    success: true,
    result: { image, status: 'ready', ...changes },
  });
  for (const [name, response] of [
    ['terminal error', (image) => Response.json(prepared(image, { status: 'error' }))],
    ['unknown status', (image) => Response.json(prepared(image, { status: 'unknown' }))],
    ['missing status', (image) => Response.json(prepared(image, { status: undefined }))],
    ['foreign image', () => Response.json(prepared('registry.cloudflare.com/foreign'))],
    ['missing result', () => Response.json({ success: true })],
    ['failed envelope', (image) => Response.json({ ...prepared(image), success: false })],
    [
      'nonempty errors',
      (image) => Response.json({ ...prepared(image), errors: [{ message: 'private-api-error' }] }),
    ],
    ['denied', () => new Response('private-api-error', { status: 403 })],
    [
      'redirect',
      () => new Response(null, { status: 302, headers: { location: 'https://foreign.test/' } }),
    ],
    ['accepted but not ready', (image) => Response.json(prepared(image), { status: 202 })],
    ['invalid JSON', () => new Response('private-invalid-json')],
    [
      'oversized declared body',
      (image) => Response.json(prepared(image), { headers: { 'content-length': '8193' } }),
    ],
    [
      'oversized streamed body',
      (image) => Response.json(prepared(image, { reason: 'x'.repeat(8192) })),
    ],
    ['empty body', () => new Response(null)],
    [
      'network failure',
      () => {
        throw new Error('private-network-error');
      },
    ],
    [
      'pending past deadline',
      (image) => Response.json(prepared(image, { status: 'pending' }), { status: 202 }),
    ],
  ]) {
    await t.test(name, async () => {
      const events = [];
      let elapsed = 0;
      let requests = 0;
      await assert.rejects(
        deployRelease('production', variables, {
          config: configuration(),
          deploymentControl: lifecycle(events),
          imageDigest,
          report() {},
          now: () => elapsed,
          wait: async (duration) => {
            assert.equal(events.includes('prepare'), false);
            elapsed += duration;
          },
          command: async (args) => events.push(args[0] === 'deploy' ? 'deploy' : 'push'),
          request: async (url, options) => {
            assert.ok(url.endsWith('/containers/image-preparations'));
            requests += 1;
            return response(JSON.parse(options.body).image);
          },
          smoke: async () => assert.fail('An unprepared image must not reach smoke checks.'),
        }),
        (error) => {
          assert.equal(/private-|synthetic-cloudflare-credential/.test(error.message), false);
          return true;
        },
      );
      assert.deepEqual(events, ['push', 'push', 'push', 'abort']);
      if (name === 'pending past deadline') {
        assert.equal(elapsed, 15 * 60_000);
        assert.ok(requests > 3);
      } else {
        assert.equal(elapsed, 0);
        assert.equal(requests, 1);
      }
    });
  }
});

test('changed gateway configuration cannot publish Worker secrets under the running release', async () => {
  const changed = {
    ...variables,
    GATEWAY_ENV: gatewayValues({ COMPOSIO_GMAIL_AUTH_CONFIG_ID: 'ac_synthetic_custom' }),
  };
  const plan = deploymentPlan({ ...planInput(), gatewayEnv: changed.GATEWAY_ENV });
  const requests = [];
  const commands = [];
  let temporaryConfig;
  const control = createDeploymentClient({
    environment: 'production',
    plan,
    variables: changed,
    fetcher: async (raw, options) => {
      const url = new URL(raw);
      requests.push({ path: url.pathname, method: options.method ?? 'GET' });
      if (url.hostname === 'api.cloudflare.com' && url.pathname.endsWith('/settings'))
        return workerSettings();
      if (url.origin === origin && url.pathname === '/api/health')
        return Response.json({ ok: true, release });
      assert.fail('The existing release must not receive a deployment control request.');
    },
  });
  await assert.rejects(
    deploy('production', changed, {
      config: configuration(),
      deploymentControl: control,
      imageDigest,
      report() {},
      request: async () => assert.fail('Worker verification requires publication.'),
      command: async (args) => {
        commands.push(args);
        temporaryConfig = args[args.indexOf('--config') + 1];
      },
      smoke: async () => assert.fail('Same-release configuration must not pass smoke checks.'),
    }),
    { message: 'Deployment safety checks did not pass; admission remains unchanged or closed.' },
  );
  assert.deepEqual(
    commands.map((args) => args[0]),
    ['containers', 'containers', 'containers'],
  );
  assert.deepEqual(requests, [
    { path: `/client/v4/accounts/${accountId}/workers/scripts/otto/settings`, method: 'GET' },
    { path: '/api/health', method: 'GET' },
  ]);
  await assert.rejects(stat(temporaryConfig), { code: 'ENOENT' });
});

test('a failed publication of any image prevents Worker activation and smoke checks', async () => {
  for (const failure of [1, 2, 3]) {
    const commands = [];
    let temporaryConfig;
    await assert.rejects(
      deploy('production', variables, {
        config: configuration(),
        report() {},
        command: async (args) => {
          commands.push(args);
          temporaryConfig = args[args.indexOf('--config') + 1];
          if (commands.length === failure) throw new Error('Synthetic image failure.');
        },
        smoke: async () => assert.fail('Smoke must not run after a failed push.'),
      }),
    );
    assert.equal(commands.length, failure);
    assert.ok(commands.every((args) => args[0] === 'containers'));
    await assert.rejects(stat(temporaryConfig), { code: 'ENOENT' });
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

test('a manifest from another repository fails before maintenance or activation', async () => {
  const events = [];
  const commands = [];
  await assert.rejects(
    deploy('production', variables, {
      config: configuration(),
      report() {},
      deploymentControl: lifecycle(events),
      imageDigest: async () =>
        `registry.cloudflare.com/${accountId}/foreign@sha256:${'d'.repeat(64)}`,
      command: async (args) => commands.push(args[0]),
    }),
  );
  assert.equal(events.includes('prepare'), false);
  assert.equal(commands.includes('deploy'), false);
});

test('recovery completion never publishes images and verifies storage, rollout and public smoke before reopening', async () => {
  const events = [];
  const control = lifecycle(events);
  control.recover = async () => {
    events.push('recover');
    return { phase: 'activating' };
  };
  await recoverDeployment('production', 'complete', variables, {
    config: configuration(),
    deploymentControl: control,
    imageDigest: async (image, environment) => {
      events.push('digest');
      assert.equal(environment.GATEWAY_ENV, undefined);
      assert.equal(environment.CLOUDFLARE_API_TOKEN, undefined);
      return imageDigest(image);
    },
    request: async (url, options) => {
      events.push('storage');
      assert.equal(
        url,
        `https://api.cloudflare.com/client/v4/accounts/${accountId}/workers/scripts/otto/settings`,
      );
      assert.equal(options.method, 'GET');
      return workerSettings();
    },
    smoke: async () => events.push('smoke'),
    report: () => {},
  });
  assert.deepEqual(events, [
    'recover',
    'digest',
    'digest',
    'digest',
    'storage',
    'verifyRollouts',
    'smoke',
    'complete',
  ]);
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
        { message: 'The deployed private object binding did not pass verification.' },
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

test('recovery abort and status preserve the existing control identity without image or smoke operations', async () => {
  for (const action of ['abort', 'status']) {
    const events = [];
    const reports = [];
    const control = lifecycle(events);
    const state = { nonce: 'synthetic-metadata', phase: 'failed' };
    control.recover = async () => state;
    await recoverDeployment('production', action, variables, {
      config: configuration(),
      deploymentControl: control,
      imageDigest: () => assert.fail('Abort and status are independent of images.'),
      request: () => assert.fail('Abort and status are independent of storage readback.'),
      smoke: () => assert.fail('Abort and status must not run release smoke.'),
      report: (value) => reports.push(value),
    });
    assert.deepEqual(events, action === 'abort' ? ['abort'] : []);
    if (action === 'status') assert.deepEqual(JSON.parse(reports[0]), state);
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
    /new gateway release/,
  );
  await assert.rejects(
    verifyDeployment({ origin, release, fetcher: smokeFetch({ exposedState: true }), attempts: 1 }),
    /authorization boundary/,
  );
});
