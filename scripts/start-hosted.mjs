import { spawn } from 'node:child_process';
import { access, mkdir, readFile, stat } from 'node:fs/promises';
import { resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { parseEnv } from 'node:util';

const repository = fileURLToPath(new URL('..', import.meta.url));
const operatingSystemKeys =
  /^(PATH|HOME|USERPROFILE|SYSTEMROOT|TEMP|TMP|TMPDIR|SHELL|LANG|LC_ALL|TERM|COLORTERM)$/;

export function hostedEnvironment(
  values,
  { root = repository, envFile, inherited = process.env } = {},
) {
  const computerProvider = values.COMPUTER_PROVIDER || 'cloudflare';
  const missing = [
    'DATABASE_URL',
    'OTTO_MASTER_KEY',
    'BETTER_AUTH_SECRET',
    'GOOGLE_CLIENT_ID',
    'GOOGLE_CLIENT_SECRET',
    ...(computerProvider === 'e2b' ? ['E2B_API_KEY', 'E2B_COMPUTER_TEMPLATE'] : []),
  ].filter((key) => !values[key]?.trim());
  if (missing.length) throw new Error(`Missing configuration: ${missing.join(', ')}.`);
  const invalid = new Set();
  const environment = values.OTTO_ENVIRONMENT || 'development';
  if (environment.toLowerCase() === 'production' || !/^[a-z][a-z0-9-]{0,31}$/.test(environment))
    invalid.add('OTTO_ENVIRONMENT');
  if (values.OTTO_MODE && values.OTTO_MODE !== 'gateway') invalid.add('OTTO_MODE');
  if (values.OTTO_RUNTIME_URL) invalid.add('OTTO_RUNTIME_URL');
  if (values.PORT && values.PORT !== '4330') invalid.add('PORT');
  if (values.OTTO_PUBLIC_URL && values.OTTO_PUBLIC_URL !== 'http://localhost:4330')
    invalid.add('OTTO_PUBLIC_URL');
  if (!['e2b', 'cloudflare'].includes(computerProvider)) invalid.add('COMPUTER_PROVIDER');
  if (values.BETTER_AUTH_SECRET.length < 32) invalid.add('BETTER_AUTH_SECRET');
  if (
    !/^[A-Za-z0-9+/]+={0,2}$/.test(values.OTTO_MASTER_KEY) ||
    Buffer.from(values.OTTO_MASTER_KEY, 'base64').length !== 32 ||
    Buffer.from(values.OTTO_MASTER_KEY, 'base64').toString('base64') !== values.OTTO_MASTER_KEY
  )
    invalid.add('OTTO_MASTER_KEY');
  if (values.LLM_PROVIDER && !['openai', 'anthropic'].includes(values.LLM_PROVIDER))
    invalid.add('LLM_PROVIDER');
  if (
    values.OTTO_MAX_USERS &&
    (!/^[1-9][0-9]*$/.test(values.OTTO_MAX_USERS) || Number(values.OTTO_MAX_USERS) > 400)
  )
    invalid.add('OTTO_MAX_USERS');
  try {
    const database = new URL(values.DATABASE_URL);
    if (
      !['postgres:', 'postgresql:'].includes(database.protocol) ||
      !database.hostname ||
      database.pathname.length < 2 ||
      (['localhost', '127.0.0.1', '[::1]'].includes(database.hostname) && database.port === '54329')
    )
      invalid.add('DATABASE_URL');
  } catch {
    invalid.add('DATABASE_URL');
  }
  if (values.OTTO_WEBHOOK_ORIGIN) {
    try {
      const origin = new URL(values.OTTO_WEBHOOK_ORIGIN);
      if (
        origin.protocol !== 'https:' ||
        origin.pathname !== '/' ||
        origin.search ||
        origin.hash ||
        origin.username ||
        origin.password
      )
        invalid.add('OTTO_WEBHOOK_ORIGIN');
    } catch {
      invalid.add('OTTO_WEBHOOK_ORIGIN');
    }
  }
  if (invalid.size) throw new Error(`Invalid configuration: ${[...invalid].join(', ')}.`);
  return {
    ...Object.fromEntries(
      Object.entries(inherited).filter(
        ([key, value]) => value !== undefined && operatingSystemKeys.test(key),
      ),
    ),
    ...values,
    DOTENV_CONFIG_PATH: envFile || resolve(root, '.env.hosted.local'),
    OTTO_MODE: 'gateway',
    OTTO_ENVIRONMENT: environment,
    OTTO_PUBLIC_URL: 'http://localhost:4330',
    OTTO_BIND_HOST: '127.0.0.1',
    OTTO_DATA_ROOT: resolve(root, '.local/hosted'),
    PORT: '4330',
    NODE_ENV: 'development',
    COMPUTER_PROVIDER: computerProvider,
    OBJECT_STORAGE_PROVIDER: computerProvider === 'cloudflare' ? 'http' : 'postgres',
    ...(computerProvider === 'cloudflare'
      ? { OBJECT_STORAGE_ENDPOINT: 'http://otto.storage/v1/objects/' }
      : {}),
  };
}

export async function readHostedEnvironment(
  envFile,
  { root = repository, inherited = process.env, warn = console.warn } = {},
) {
  let values;
  let metadata;
  try {
    metadata = await stat(envFile);
    if (!metadata.isFile()) throw new Error();
    values = parseEnv(await readFile(envFile, 'utf8'));
  } catch {
    throw new Error('The hosted environment file could not be read.');
  }
  if (
    process.platform !== 'win32' &&
    ((metadata.mode & 0o077) !== 0 || (process.getuid && metadata.uid !== process.getuid()))
  )
    warn(
      'The hosted environment file is not private to its owner. Set its owner to your account and permissions to 600.',
    );
  return hostedEnvironment(values, { root, envFile, inherited });
}

export async function startHosted(args = process.argv.slice(2)) {
  let envFile = resolve(repository, '.env.hosted.local');
  let check = false;
  let resume = false;
  for (let index = 0; index < args.length; index++) {
    if (args[index] === '--check') check = true;
    else if (args[index] === '--resume') resume = true;
    else if (args[index] === '--env' && args[index + 1] && !args[index + 1].startsWith('--'))
      envFile = resolve(args[++index]);
    else
      throw new Error('Usage: node scripts/start-hosted.mjs [--env <file>] [--check | --resume]');
  }
  if (check && resume) throw new Error('Choose either --check or --resume.');
  const [major, minor] = process.versions.node.split('.').map(Number);
  if (major < 24 || (major === 24 && minor < 21)) throw new Error('Use Node.js 24.21.0 or newer.');
  const environment = await readHostedEnvironment(envFile);
  if (resume) {
    if (environment.COMPUTER_PROVIDER !== 'cloudflare')
      throw new Error('The --resume command requires the Cloudflare computer provider.');
    const { resumeCloudflareLocal } = await import('./start-cloudflare-local.mjs');
    await resumeCloudflareLocal(environment);
    return;
  }
  if (check) {
    console.log('Hosted development configuration is valid.');
    return;
  }
  try {
    await access(resolve(repository, 'node_modules/.package-lock.json'));
  } catch {
    throw new Error('Install repository dependencies with npm ci first.');
  }
  await mkdir(environment.OTTO_DATA_ROOT, { recursive: true, mode: 0o700 });
  if (environment.COMPUTER_PROVIDER === 'cloudflare') {
    const { startCloudflareLocal } = await import('./start-cloudflare-local.mjs');
    await startCloudflareLocal(environment);
    return;
  }
  const child = spawn(process.execPath, ['--import', 'tsx', 'src/server/index.ts'], {
    cwd: repository,
    env: environment,
    stdio: 'inherit',
  });
  const handlers = new Map(
    ['SIGINT', 'SIGTERM'].map((signal) => [signal, () => child.kill(signal)]),
  );
  for (const [signal, handler] of handlers) process.on(signal, handler);
  await new Promise((complete, reject) => {
    child.once('error', () => reject(new Error('Hosted development could not start.')));
    child.once('exit', (code) => {
      process.exitCode = code ?? 1;
      complete();
    });
  }).finally(() => {
    for (const [signal, handler] of handlers) process.off(signal, handler);
  });
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href)
  startHosted().catch((error) => {
    console.error(error.message);
    process.exitCode = 1;
  });
