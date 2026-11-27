import { execFile, spawn } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseEnv, promisify } from 'node:util';
import {
  localDatabaseEnvironment,
  prepareLocalDirectories,
  rotateLocalDatabase,
  verifyLocalDatabase,
  withLocalDatabase,
} from './local-database.ts';
import { sourceAnalyticsVersion } from './source-version.ts';

process.chdir(fileURLToPath(new URL('..', import.meta.url)));
const production = process.argv.includes('--production');
const launch = (command, args, options) =>
  process.platform === 'win32'
    ? spawn([command, ...args].join(' '), { ...options, shell: true })
    : spawn(command, args, options);
const run = (command, args, env = process.env) =>
  new Promise((resolve, reject) => {
    const child = launch(command, args, { stdio: 'inherit', env });
    child.on('error', reject);
    child.on('exit', (code) =>
      code === 0 ? resolve() : reject(new Error(`${command} failed (${code}).`)),
    );
  });
try {
  const [major, minor] = process.versions.node.split('.').map(Number);
  if (major < 24 || (major === 24 && minor < 21)) throw new Error('Use Node.js 24.21.0 or newer.');
  const [wanted, installed] = await Promise.all([
    readFile('pnpm-lock.yaml', 'utf8'),
    readFile('node_modules/.pnpm/lock.yaml', 'utf8').catch(() => ''),
  ]);
  if (wanted !== installed) await run('pnpm', ['install', '--frozen-lockfile', '--prod=false']);
  if (production) await run('pnpm', ['run', 'build']);
  const { stdout } = await promisify(execFile)('docker', ['info', '--format', '{{json .}}']);
  const info = JSON.parse(stdout);
  const dockerCpus = Number(info.NCPU ?? info.host?.cpus);
  if (!Number.isInteger(dockerCpus) || dockerCpus < 1)
    throw new Error('Docker did not report a usable CPU count.');
  const components = await promisify(execFile)('docker', [
    'version',
    '--format',
    '{{json .Server.Components}}',
  ]).then(
    (result) => JSON.parse(result.stdout) ?? [],
    () => [],
  );
  const podman =
    info.host?.cpus !== undefined ||
    info.BuildahVersion !== undefined ||
    components.some((component) => component.Name === 'Podman Engine');
  const compose = podman ? ['-f', 'compose.yaml', '-f', 'compose.podman.yaml'] : [];
  const environment = await withLocalDatabase(process.cwd(), async (database) => {
    const settings = parseEnv(await readFile('.env', 'utf8'));
    const cpuLimit = (name, fallback) => {
      const requested = Number(process.env[name] ?? settings[name] ?? fallback);
      if (!Number.isFinite(requested) || requested < 0.01)
        throw new Error(`${name} must be at least 0.01 CPUs.`);
      return String(Math.min(requested, dockerCpus));
    };
    const appVersion = await sourceAnalyticsVersion(
      process.cwd(),
      production,
      process.env.NOD_APP_VERSION,
      settings.NOD_APP_VERSION,
    );
    const environment = {
      ...localDatabaseEnvironment(database),
      NOD_BROWSER_CPUS: cpuLimit('NOD_BROWSER_CPUS', 6),
      NOD_WORKSPACE_CPUS: cpuLimit('NOD_WORKSPACE_CPUS', 4),
      NOD_DATA_ROOT: resolve(process.env.NOD_DATA_ROOT || settings.NOD_DATA_ROOT || '.local'),
      ...(appVersion !== undefined ? { NOD_APP_VERSION: appVersion } : {}),
    };
    await prepareLocalDirectories(environment.NOD_DATA_ROOT);
    await run('docker', ['compose', ...compose, 'up', '-d', '--wait', 'postgres'], environment);
    await rotateLocalDatabase(database, { environment });
    await verifyLocalDatabase(database);
    await run('docker', ['compose', ...compose, 'build'], environment);
    if (podman) {
      const image = (
        await promisify(execFile)('docker', [
          'image',
          'inspect',
          'nod-local-workspace',
          '--format',
          '{{.Id}}',
        ])
      ).stdout.trim();
      const running = await promisify(execFile)('docker', [
        'inspect',
        'nod-workspace',
        '--format',
        '{{.Image}}',
      ])
        .then((result) => result.stdout.trim())
        .catch(() => undefined);
      if (running !== undefined && running !== image)
        await run('docker', ['compose', ...compose, 'rm', '-sf', 'workspace'], environment);
    }
    const up = () =>
      run('docker', ['compose', ...compose, 'up', '-d', '--wait', '--remove-orphans'], environment);
    try {
      await up();
    } catch (error) {
      if (!podman) throw error;
      console.error('The containers did not start. Removing the workspace containers to retry.');
      await run(
        'docker',
        ['compose', ...compose, 'rm', '-sf', 'workspace', 'workspace-network'],
        environment,
      );
      await up();
    }
    return environment;
  });
  console.log('\nNod is starting. Open the link it prints when it is ready.\n');
  const child = launch(
    'pnpm',
    ['exec', 'tsx', ...(production ? [] : ['watch']), 'src/server/index.ts'],
    {
      stdio: 'inherit',
      env: { ...environment, NODE_ENV: production ? 'production' : 'development' },
    },
  );
  for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => child.kill(signal));
  child.on('exit', (code) => process.exit(code || 0));
} catch (error) {
  console.error(error.message);
  process.exitCode = 1;
}
