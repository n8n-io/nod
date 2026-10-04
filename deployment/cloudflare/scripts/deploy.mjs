import { spawn } from 'node:child_process';
import { chmod, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { setTimeout as sleep } from 'node:timers/promises';
import ts from 'typescript';
import { verifyDeployment } from './smoke.mjs';
import { createDeploymentClient, inspectImageDigest, pinDeploymentImages } from './drain.mjs';

const packageDirectory = resolve(dirname(fileURLToPath(import.meta.url)), '..');

async function apiResult(response, limit = 512 * 1024) {
  if (!response.body) throw new Error();
  const length = response.headers.get('content-length');
  if (length !== null && (!/^\d+$/.test(length) || Number(length) > limit)) throw new Error();
  const chunks = [];
  let size = 0;
  for await (const chunk of response.body) {
    size += chunk.byteLength;
    if (size > limit) throw new Error();
    chunks.push(chunk);
  }
  const value = JSON.parse(
    new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks, size)),
  );
  if (
    value?.success !== true ||
    (value.errors !== undefined && (!Array.isArray(value.errors) || value.errors.length !== 0))
  )
    throw new Error();
  return value.result;
}

async function prepareImages(
  plan,
  environment,
  token,
  { request = fetch, now = Date.now, wait = sleep } = {},
) {
  const pending = new Set(plan.config.env[environment].containers.map(({ image }) => image));
  const deadline = now() + 15 * 60_000;
  try {
    while (pending.size) {
      for (const image of pending) {
        const remaining = deadline - now();
        if (remaining <= 0) throw new Error();
        const response = await request(
          `https://api.cloudflare.com/client/v4/accounts/${plan.config.account_id}/containers/image-preparations`,
          {
            method: 'POST',
            headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
            body: JSON.stringify({ image }),
            cache: 'no-store',
            redirect: 'error',
            signal: AbortSignal.timeout(Math.min(10_000, remaining)),
          },
        );
        if (![200, 202].includes(response.status)) throw new Error();
        const result = await apiResult(response, 8192);
        if (now() >= deadline || result?.image !== image) throw new Error();
        if (result.status === 'ready' && response.status === 200) pending.delete(image);
        else if (result.status !== 'pending') throw new Error();
      }
      if (pending.size) {
        const remaining = deadline - now();
        if (remaining <= 0) throw new Error();
        await wait(Math.min(2000, remaining));
      }
    }
  } catch {
    throw new Error('Cloudflare container images are not ready for deployment.');
  }
}

function storageTarget(config, environment) {
  const selected = config.env?.[environment];
  const bindings = selected?.r2_buckets;
  if (
    typeof selected?.name !== 'string' ||
    !/^[a-z0-9][a-z0-9-]{0,62}$/.test(selected.name) ||
    !Array.isArray(bindings) ||
    bindings.length !== 1 ||
    bindings[0]?.binding !== 'TENANT_FILES' ||
    typeof bindings[0].bucket_name !== 'string' ||
    !/^[a-z0-9][a-z0-9-]{1,61}[a-z0-9]$/.test(bindings[0].bucket_name) ||
    bindings[0].jurisdiction !== 'eu'
  )
    throw new Error('Configure an explicit Worker name and one EU private object bucket.');
  return { worker: selected.name, bucket: bindings[0].bucket_name };
}

export async function verifyStorageBinding(plan, environment, token, request = fetch) {
  try {
    const { worker, bucket } = storageTarget(plan.config, environment);
    const accountId = plan.config.account_id;
    if (!/^[a-f0-9]{32}$/.test(accountId) || typeof token !== 'string' || !token) throw new Error();
    const response = await request(
      `https://api.cloudflare.com/client/v4/accounts/${accountId}/workers/scripts/${worker}/settings`,
      {
        method: 'GET',
        headers: { authorization: `Bearer ${token}` },
        cache: 'no-store',
        redirect: 'error',
        signal: AbortSignal.timeout(10_000),
      },
    );
    if (response.status !== 200) throw new Error();
    const settings = await apiResult(response);
    if (!Array.isArray(settings?.bindings)) throw new Error();
    const bindings = settings.bindings.filter((binding) => binding?.name === 'TENANT_FILES');
    if (
      bindings.length !== 1 ||
      bindings[0].type !== 'r2_bucket' ||
      bindings[0].bucket_name !== bucket ||
      bindings[0].jurisdiction !== 'eu'
    )
      throw new Error();
  } catch {
    throw new Error('The deployed private object binding did not pass verification.');
  }
}

export function deploymentPlan({ environment, release, accountId, publicUrl, gatewayEnv, config }) {
  if (!['development', 'production'].includes(environment))
    throw new Error('Choose the development or production deployment environment.');
  if (!/^[a-f0-9]{40}$/.test(release ?? ''))
    throw new Error('Set OTTO_RELEASE to the tested Git commit.');
  if (!/^[a-f0-9]{32}$/.test(accountId ?? ''))
    throw new Error('Set CLOUDFLARE_ACCOUNT_ID to the selected account.');
  let origin;
  let values;
  try {
    origin = new URL(publicUrl);
    values = JSON.parse(gatewayEnv);
  } catch {
    throw new Error('Configure the application origin and gateway environment.');
  }
  if (
    origin.protocol !== 'https:' ||
    origin.pathname !== '/' ||
    origin.search ||
    origin.hash ||
    origin.username ||
    origin.password ||
    origin.hostname.includes('.example.')
  )
    throw new Error('Set OTTO_PUBLIC_URL to the canonical production HTTPS origin.');
  if (
    !values ||
    Array.isArray(values) ||
    typeof values !== 'object' ||
    Object.keys(values).length === 0 ||
    Object.keys(values).length > 100 ||
    Buffer.byteLength(gatewayEnv) > 48 * 1024 ||
    Object.entries(values).some(
      ([key, value]) =>
        !/^[A-Z][A-Z0-9_]*$/.test(key) ||
        key === 'OTTO_IMAGE_RELEASE' ||
        typeof value !== 'string' ||
        value.includes('\0') ||
        value.length > 32768,
    )
  )
    throw new Error('GATEWAY_ENV must contain bounded server environment strings.');
  if (values.OTTO_ENVIRONMENT && values.OTTO_ENVIRONMENT !== environment)
    throw new Error('The gateway configuration belongs to another environment.');
  if (values.OTTO_PUBLIC_URL && values.OTTO_PUBLIC_URL !== origin.origin)
    throw new Error('The gateway configuration uses another application origin.');
  if (!['cloudflare', 'e2b'].includes(values.COMPUTER_PROVIDER))
    throw new Error('Set COMPUTER_PROVIDER to cloudflare or e2b for this deployment.');
  if (
    values.COMPUTER_PROVIDER === 'e2b' &&
    ['E2B_API_KEY', 'E2B_COMPUTER_TEMPLATE'].some((key) => !values[key]?.trim())
  )
    throw new Error('Configure the E2B API key and computer template.');
  if (
    values.OBJECT_STORAGE_PROVIDER !== 'http' ||
    values.OBJECT_STORAGE_ENDPOINT !== 'http://otto.storage/v1/objects/'
  )
    throw new Error(
      'Set OBJECT_STORAGE_PROVIDER to http and OBJECT_STORAGE_ENDPOINT to http://otto.storage/v1/objects/.',
    );
  const selected = config.env?.[environment];
  if (!selected?.containers?.length)
    throw new Error('The selected environment has no container configuration.');
  storageTarget(config, environment);
  const classes = selected.containers.map((container) => container.class_name);
  if (
    classes.some(
      (name) =>
        ![
          'GatewayContainer',
          'TenantContainer',
          'BrowserComputerContainer',
          'WorkspaceComputerContainer',
        ].includes(name),
    )
  )
    throw new Error('The deployment has an unsupported container class.');
  const requiredClasses = ['GatewayContainer', 'TenantContainer'];
  if (values.COMPUTER_PROVIDER === 'cloudflare')
    requiredClasses.push('BrowserComputerContainer', 'WorkspaceComputerContainer');
  if (
    new Set(classes).size !== classes.length ||
    requiredClasses.some((name) => !classes.includes(name))
  )
    throw new Error('The deployment is missing a required container class or repeats one.');
  const localImage = `otto-${environment}:${release}`;
  const classImages = new Map([
    ['GatewayContainer', localImage],
    ['TenantContainer', localImage],
    ['BrowserComputerContainer', `otto-${environment}-browser:${release}`],
    ['WorkspaceComputerContainer', `otto-${environment}-workspace:${release}`],
  ]);
  const localImages = new Set();
  const gatewaySecret = JSON.stringify({ ...values, OTTO_RELEASE: release });
  if (Buffer.byteLength(gatewaySecret) > 5 * 1024)
    throw new Error('The compact gateway configuration exceeds the Worker secret size limit.');
  const deployment = structuredClone(config);
  delete deployment.$schema;
  deployment.main = resolve(packageDirectory, deployment.main);
  deployment.assets.directory = resolve(packageDirectory, deployment.assets.directory);
  deployment.account_id = accountId;
  deployment.env = {
    [environment]: {
      ...selected,
      vars: {
        ...selected.vars,
        OTTO_ENVIRONMENT: environment,
        OTTO_PUBLIC_URL: origin.origin,
        OTTO_DEPLOYMENT_MANAGED: 'true',
      },
      containers: selected.containers.map((container) => {
        const selectedImage = classImages.get(container.class_name);
        if (!selectedImage) throw new Error('The deployment has an unsupported container class.');
        localImages.add(selectedImage);
        const result = {
          ...container,
          name:
            container.name ||
            `${selected.name || config.name}-${container.class_name}-${environment}`
              .toLowerCase()
              .replaceAll(' ', '-'),
          image: `registry.cloudflare.com/${accountId}/${selectedImage}`,
        };
        delete result.image_build_context;
        delete result.image_vars;
        return result;
      }),
    },
  };
  return {
    config: deployment,
    localImage,
    localImages: [...localImages],
    origin: origin.origin,
    release,
    secrets: { GATEWAY_ENV: gatewaySecret },
  };
}

function command(args, environment) {
  return new Promise((complete, reject) => {
    const child = spawn(
      process.execPath,
      [join(packageDirectory, 'node_modules/wrangler/bin/wrangler.js'), ...args],
      {
        cwd: packageDirectory,
        env: environment,
        stdio: 'ignore',
        timeout: 15 * 60 * 1000,
        killSignal: 'SIGTERM',
      },
    );
    child.once('error', () =>
      reject(new Error('The Cloudflare deployment command could not start.')),
    );
    child.once('exit', (code) => {
      if (code === 0) complete();
      else
        reject(
          new Error(
            'The Cloudflare deployment command failed. No automatic rollback was attempted.',
          ),
        );
    });
  });
}

export async function deploy(environment, variables = process.env, dependencies = {}) {
  const run = dependencies.command ?? command;
  const smoke = dependencies.smoke ?? verifyDeployment;
  const report = dependencies.report ?? ((message) => process.stdout.write(`${message}\n`));
  let configuration = dependencies.config;
  if (!configuration) {
    const parsed = ts.parseConfigFileTextToJson(
      'wrangler.jsonc',
      await readFile(join(packageDirectory, 'wrangler.jsonc'), 'utf8'),
    );
    if (parsed.error) throw new Error('The Cloudflare deployment configuration is invalid.');
    configuration = parsed.config;
  }
  if (!variables.CLOUDFLARE_API_TOKEN)
    throw new Error('Configure the Cloudflare deployment token.');
  const plan = deploymentPlan({
    environment,
    release: variables.OTTO_RELEASE,
    accountId: variables.CLOUDFLARE_ACCOUNT_ID,
    publicUrl: variables.OTTO_PUBLIC_URL,
    gatewayEnv: variables.GATEWAY_ENV,
    config: configuration,
  });
  const lifecycle =
    dependencies.deploymentControl ?? createDeploymentClient({ environment, plan, variables });
  const digest = dependencies.imageDigest ?? inspectImageDigest;
  const privateDirectory = await mkdtemp(join(tmpdir(), 'otto-deploy-'));
  await chmod(privateDirectory, 0o700);
  try {
    const configPath = join(privateDirectory, 'wrangler.json');
    const secretPath = join(privateDirectory, 'secrets.json');
    await writeFile(configPath, JSON.stringify(plan.config), { mode: 0o600 });
    await writeFile(secretPath, JSON.stringify(plan.secrets), { mode: 0o600 });
    const childEnvironment = Object.fromEntries(
      Object.entries(variables).filter(
        ([key, value]) =>
          value !== undefined &&
          /^(PATH|HOME|USERPROFILE|SYSTEMROOT|TEMP|TMP|TMPDIR|DOCKER_HOST|DOCKER_CONFIG|DOCKER_CONTEXT|XDG_CONFIG_HOME|CLOUDFLARE_API_TOKEN|CLOUDFLARE_ACCOUNT_ID)$/.test(
            key,
          ),
      ),
    );
    childEnvironment.CI = 'true';
    childEnvironment.WRANGLER_SEND_METRICS = 'false';
    childEnvironment.WRANGLER_LOG_PATH = join(privateDirectory, 'wrangler.log');
    report('Publishing the verified container images.');
    for (const image of plan.localImages)
      await run(
        ['containers', 'push', image, '--env', environment, '--config', configPath],
        childEnvironment,
      );
    report('Verifying the published image digests.');
    await pinDeploymentImages(plan, environment, childEnvironment, digest);
    await writeFile(configPath, JSON.stringify(plan.config), { mode: 0o600 });
    report('Waiting for Cloudflare container images to be ready.');
    await prepareImages(plan, environment, variables.CLOUDFLARE_API_TOKEN, dependencies);
    report('Pausing admission and waiting for clean tenant checkpoints.');
    await lifecycle.prepare();
    await lifecycle.activate();
    report('Deploying Worker code, the image reference and gateway secrets.');
    await run(
      [
        'deploy',
        '--env',
        environment,
        '--config',
        configPath,
        '--secrets-file',
        secretPath,
        '--containers-rollout',
        'immediate',
        '--experimental-provision=false',
        '--tag',
        plan.release,
        '--message',
        `Commit ${plan.release}`,
      ],
      childEnvironment,
    );
    report('Verifying the deployed private object binding.');
    await verifyStorageBinding(
      plan,
      environment,
      variables.CLOUDFLARE_API_TOKEN,
      dependencies.request,
    );
    report('Waiting for every container role to finish its image rollout.');
    await lifecycle.verifyRollouts();
    report('Waiting for the new release and checking public authorization.');
    await smoke({ origin: plan.origin, release: plan.release });
    await lifecycle.initialize();
    await lifecycle.complete();
    report('The deployed release passed health and unauthenticated boundary checks.');
  } catch (error) {
    await lifecycle.abort().catch(() => {});
    throw error;
  } finally {
    await rm(privateDirectory, { recursive: true, force: true });
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try {
    await deploy(process.argv[2]);
  } catch {
    process.stderr.write(
      'Deployment or verification failed. Inspect deployment status before a controlled retry; no rollback was attempted.\n',
    );
    process.exitCode = 1;
  }
}
