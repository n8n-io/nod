import { spawn } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseEnv } from 'node:util';
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
const run = (command, args, env = process.env) =>
  new Promise((resolve, reject) => {
    const child = spawn(command, args, { stdio: 'inherit', env });
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
  const environment = await withLocalDatabase(process.cwd(), async (database) => {
    const settings = parseEnv(await readFile('.env', 'utf8'));
    const appVersion = await sourceAnalyticsVersion(
      process.cwd(),
      production,
      process.env.NOD_APP_VERSION,
      settings.NOD_APP_VERSION,
    );
    const environment = {
      ...localDatabaseEnvironment(database),
      NOD_DATA_ROOT: resolve(process.env.NOD_DATA_ROOT || settings.NOD_DATA_ROOT || '.local'),
      ...(appVersion !== undefined ? { NOD_APP_VERSION: appVersion } : {}),
    };
    await prepareLocalDirectories(environment.NOD_DATA_ROOT);
    await run('docker', ['compose', 'up', '-d', '--wait', 'postgres'], environment);
    await rotateLocalDatabase(database, { environment });
    await verifyLocalDatabase(database);
    await run(
      'docker',
      ['compose', 'up', '-d', '--build', '--wait', '--remove-orphans'],
      environment,
    );
    return environment;
  });
  console.log('\nNod is starting. Open the link it prints when it is ready.\n');
  const child = spawn(
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
