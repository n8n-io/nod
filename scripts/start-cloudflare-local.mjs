import { spawn } from 'node:child_process';
import { access, chmod, readFile, rm, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';
import {
  assertLocalCloudflarePortFree,
  openLocalCloudflareControl,
  superviseLocalCloudflare,
} from './cloudflare-local-control.mjs';

const repository = fileURLToPath(new URL('..', import.meta.url));
const systemKeys =
  /^(PATH|HOME|USERPROFILE|SYSTEMROOT|TEMP|TMP|TMPDIR|SHELL|LANG|LC_ALL|TERM|COLORTERM)$/;

export function cloudflareLocalPlan(environment, config, root = repository, release) {
  if (
    environment.COMPUTER_PROVIDER !== 'cloudflare' ||
    environment.OTTO_ENVIRONMENT === 'production' ||
    environment.OTTO_PUBLIC_URL !== 'http://localhost:4330' ||
    !/^[a-f0-9]{40}$/.test(release ?? '')
  )
    throw new Error('Configure an isolated local Cloudflare development environment.');
  const { env, $schema, ...common } = config;
  const selected = env?.development;
  if (!selected?.containers?.length)
    throw new Error('The development container configuration is missing.');
  const directory = resolve(root, 'deployment/cloudflare');
  const gateway = Object.fromEntries(
    Object.entries(environment).filter(
      ([key, value]) =>
        value &&
        !systemKeys.test(key) &&
        ![
          'DOTENV_CONFIG_PATH',
          'OTTO_DATA_ROOT',
          'OTTO_BIND_HOST',
          'PORT',
          'NODE_ENV',
          'CLOUDFLARE_API_TOKEN',
          'CLOUDFLARE_ACCOUNT_ID',
          'OTTO_IMAGE_RELEASE',
        ].includes(key),
    ),
  );
  const secret = JSON.stringify({
    ...gateway,
    OTTO_RELEASE: release,
    OBJECT_STORAGE_PROVIDER: 'http',
    OBJECT_STORAGE_ENDPOINT: 'http://otto.storage/v1/objects/',
  });
  if (Buffer.byteLength(secret) > 5 * 1024)
    throw new Error('The compact gateway configuration exceeds the Worker secret size limit.');
  const local = {
    ...common,
    ...selected,
    name: 'otto-development-local',
    main: resolve(directory, common.main),
    assets: { ...common.assets, directory: resolve(directory, common.assets.directory) },
    dev: { ip: '127.0.0.1', port: 4330, inspector_port: 9330 },
    vars: {
      OTTO_ENVIRONMENT: environment.OTTO_ENVIRONMENT,
      OTTO_PUBLIC_URL: 'http://localhost:4330',
    },
    containers: selected.containers.map((container) => ({
      ...container,
      image: resolve(directory, container.image),
      image_build_context: resolve(directory, container.image_build_context),
      ...(['GatewayContainer', 'TenantContainer'].includes(container.class_name) && {
        image_vars: { ...container.image_vars, OTTO_RELEASE: release },
      }),
    })),
  };
  delete local.triggers;
  delete local.account_id;
  return {
    config: local,
    secret,
    devVars: `GATEWAY_ENV='${secret.replace(/'/g, '\\u0027')}'\n`,
    environment: Object.fromEntries(
      Object.entries(environment).filter(([key]) => systemKeys.test(key)),
    ),
  };
}

export async function startCloudflareLocal(
  environment,
  {
    root = repository,
    assertPortFree = assertLocalCloudflarePortFree,
    writeSecret = (path, value) => writeFile(path, value, { mode: 0o600 }),
  } = {},
) {
  if (process.platform === 'win32')
    throw new Error('Checkpoint-safe local Cloudflare shutdown requires macOS or Linux.');
  const packageDirectory = resolve(root, 'deployment/cloudflare');
  const wrangler = join(packageDirectory, 'node_modules/wrangler/bin/wrangler.js');
  try {
    await access(wrangler);
    await access(resolve(root, 'dist/web/index.html'));
  } catch {
    throw new Error(
      'Run pnpm run build and pnpm --dir deployment/cloudflare install --frozen-lockfile first.',
    );
  }
  const parsed = ts.parseConfigFileTextToJson(
    'wrangler.jsonc',
    await readFile(join(packageDirectory, 'wrangler.jsonc'), 'utf8'),
  );
  if (parsed.error) throw new Error('The Cloudflare development configuration is invalid.');
  const directory = resolve(root, '.local/cloudflare-development');
  const control = await openLocalCloudflareControl(directory, environment);
  const configFile = join(directory, 'wrangler.json');
  const secretFile = join(directory, '.dev.vars');
  let wroteSecret = false;
  try {
    const plan = cloudflareLocalPlan(environment, parsed.config, root, control.release);
    await assertPortFree();
    await writeFile(configFile, JSON.stringify(plan.config, null, 2), { mode: 0o600 });
    wroteSecret = true;
    await writeSecret(secretFile, plan.devVars);
    await chmod(secretFile, 0o600);
    const child = spawn(
      process.execPath,
      [wrangler, 'dev', '--config', configFile, '--local', '--show-interactive-dev-session=false'],
      {
        cwd: root,
        env: { ...plan.environment, WRANGLER_SEND_METRICS: 'false', WRANGLER_LOG_LEVEL: 'warn' },
        stdio: ['ignore', 'inherit', 'inherit'],
        detached: true,
      },
    );
    console.log('Starting the local Cloudflare stack at http://localhost:4330.');
    process.exitCode = await superviseLocalCloudflare(child, control);
  } finally {
    try {
      if (wroteSecret) await rm(secretFile, { force: true });
    } finally {
      await control.close();
    }
  }
}

export async function resumeCloudflareLocal(environment, { root = repository } = {}) {
  const control = await openLocalCloudflareControl(
    resolve(root, '.local/cloudflare-development'),
    environment,
    { resume: true },
  );
  try {
    await control.resume();
    console.log('The recorded local shutdown was safely resumed. The stack remains running.');
  } finally {
    await control.close();
  }
}
