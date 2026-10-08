import { spawn } from 'node:child_process';
import { access, readFile } from 'node:fs/promises';
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
  try {
    await Promise.all(
      ['tsx', 'tsc', 'vite'].map((command) => access(`node_modules/.bin/${command}`)),
    );
  } catch {
    await run('npm', ['ci', '--include=dev']);
  }
  if (production) await run('npm', ['run', 'build']);
  const environment = await withLocalDatabase(process.cwd(), async (database) => {
    const settings = parseEnv(await readFile('.env', 'utf8'));
    const environment = {
      ...localDatabaseEnvironment(database),
      OTTO_DATA_ROOT: resolve(process.env.OTTO_DATA_ROOT || settings.OTTO_DATA_ROOT || '.local'),
    };
    await prepareLocalDirectories(environment.OTTO_DATA_ROOT);
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
  console.log('\nOtto is starting. Open the link it prints when it is ready.\n');
  const child = spawn(
    'npx',
    ['--no-install', 'tsx', ...(production ? [] : ['watch']), 'src/server/index.ts'],
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
