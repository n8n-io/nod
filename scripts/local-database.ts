import { spawn } from 'node:child_process';
import { createHash, createHmac, pbkdf2Sync, randomBytes, randomUUID } from 'node:crypto';
import { rmdirSync, unlinkSync } from 'node:fs';
import {
  chmod,
  lstat,
  mkdir,
  readFile,
  readdir,
  rename,
  rm,
  rmdir,
  unlink,
  writeFile,
} from 'node:fs/promises';
import { join } from 'node:path';
import { parseEnv } from 'node:util';

export type LocalDatabase = {
  password: string;
  databaseUrl: string;
  serverDatabaseUrl: string;
};

export async function prepareLocalDirectories(dataRoot: string) {
  for (const [directory, mode] of [
    [dataRoot, 0o700],
    [join(dataRoot, 'workspaces'), 0o755],
  ] as const) {
    await mkdir(directory, { recursive: true, mode });
    if (!(await lstat(directory)).isDirectory())
      throw new Error('Local data paths must be directories, not symbolic links.');
    await chmod(directory, mode);
  }
}

function localDatabaseUrl(value: string) {
  try {
    const url = new URL(value);
    return (
      ['postgres:', 'postgresql:'].includes(url.protocol) &&
      ['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname) &&
      url.port === '54329' &&
      url.username === 'nod' &&
      url.pathname === '/nod' &&
      url.searchParams
        .getAll('host')
        .every((host) => ['127.0.0.1', 'localhost', '::1'].includes(host)) &&
      url.searchParams.getAll('port').every((port) => port === '54329') &&
      url.searchParams.getAll('user').every((user) => user === 'nod') &&
      url.searchParams.getAll('dbname').every((database) => database === 'nod') &&
      url.searchParams.getAll('database').every((database) => database === 'nod') &&
      !url.hash
    );
  } catch {
    return false;
  }
}

function replaceSetting(source: string, name: string, value: string) {
  let replaced = false;
  const lines = source.split(/\r?\n/).filter((line) => {
    if (!new RegExp(`^\\s*(?:export\\s+)?${name}\\s*=`).test(line)) return true;
    if (replaced) return false;
    replaced = true;
    return true;
  });
  const text = lines.map((line) =>
    new RegExp(`^\\s*(?:export\\s+)?${name}\\s*=`).test(line) ? `${name}=${value}` : line,
  );
  if (!replaced) text.push(`${name}=${value}`);
  return text.join('\n').replace(/\n*$/, '\n');
}

async function prepareDatabase(
  directory: string,
  environment: NodeJS.ProcessEnv = process.env,
): Promise<LocalDatabase> {
  const path = join(directory, '.env');
  let source: string;
  try {
    try {
      await lstat(path);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      const template = await readFile(join(directory, '.env.example'), 'utf8');
      await writeFile(path, template, { mode: 0o600, flag: 'wx' });
    }
    if (!(await lstat(path)).isFile()) throw new Error();
    await chmod(path, 0o600);
    source = await readFile(path, 'utf8');
  } catch {
    throw new Error('The local .env file must be a regular private file.');
  }
  const saved = parseEnv(source);
  const configured = environment.NOD_POSTGRES_PASSWORD || saved.NOD_POSTGRES_PASSWORD;
  if (configured && !/^[A-Za-z0-9_-]{43,128}$/.test(configured))
    throw new Error(
      'The local PostgreSQL password must contain at least 43 safe random characters.',
    );
  const password = configured || randomBytes(32).toString('base64url');
  const databaseUrl = `postgresql://nod:${password}@127.0.0.1:54329/nod`;
  const currentUrl = environment.DATABASE_URL || saved.DATABASE_URL;
  const local = !currentUrl || localDatabaseUrl(currentUrl);
  const serverUrl = new URL(databaseUrl);
  if (currentUrl && local) {
    serverUrl.search = new URL(currentUrl).search;
    if (serverUrl.searchParams.has('password')) serverUrl.searchParams.set('password', password);
  }
  const serverDatabaseUrl = local ? serverUrl.href : currentUrl!;
  let next = replaceSetting(source, 'NOD_POSTGRES_PASSWORD', password);
  if (local) next = replaceSetting(next, 'DATABASE_URL', serverDatabaseUrl);
  if (next !== source) {
    const temporary = join(directory, `.env.${randomUUID()}.tmp`);
    try {
      await writeFile(temporary, next, { mode: 0o600, flag: 'wx' });
      await rename(temporary, path);
    } finally {
      await unlink(temporary).catch(() => {});
    }
  }
  return { password, databaseUrl, serverDatabaseUrl };
}

async function withSetupLock<T>(directory: string, action: () => Promise<T>): Promise<T> {
  const local = join(directory, '.local');
  await mkdir(local, { recursive: true, mode: 0o700 });
  const path = join(local, 'database-setup.lock');
  const token = randomUUID();
  const owner = `${process.pid}-${token}`;
  const candidate = join(local, `.database-setup-${token}`);
  await mkdir(candidate, { mode: 0o700 });
  await writeFile(join(candidate, owner), '', { mode: 0o600, flag: 'wx' });
  const deadline = Date.now() + 30_000;
  const cleanup = () => {
    try {
      unlinkSync(join(path, owner));
    } catch {}
    try {
      rmdirSync(path);
    } catch {}
  };
  try {
    while (true) {
      try {
        await rename(candidate, path);
        break;
      } catch (error) {
        if (!['EEXIST', 'ENOTEMPTY', 'EPERM'].includes((error as NodeJS.ErrnoException).code || ''))
          throw new Error('The local database setup lock could not be created.');
      }
      let owners: string[];
      try {
        owners = await readdir(path);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') continue;
        throw new Error('The local database setup lock is invalid.');
      }
      if (owners.length === 0) continue;
      const previous = owners.length === 1 && owners[0].match(/^([1-9]\d*)-[0-9a-f-]{36}$/);
      if (!previous) throw new Error('The local database setup lock is invalid.');
      let alive = true;
      try {
        process.kill(Number(previous[1]), 0);
      } catch (error) {
        alive = (error as NodeJS.ErrnoException).code !== 'ESRCH';
      }
      if (!alive) {
        await unlink(join(path, owners[0])).catch(() => {});
        await rmdir(path).catch(() => {});
        continue;
      }
      if (Date.now() >= deadline)
        throw new Error(
          'Local database setup is already running. Wait for it to finish and retry.',
        );
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
    process.once('exit', cleanup);
    try {
      return await action();
    } finally {
      process.removeListener('exit', cleanup);
      cleanup();
    }
  } finally {
    await rm(candidate, { recursive: true, force: true });
  }
}

export function prepareLocalDatabase(
  directory: string,
  environment: NodeJS.ProcessEnv = process.env,
) {
  return withSetupLock(directory, () => prepareDatabase(directory, environment));
}

export function withLocalDatabase<T>(
  directory: string,
  action: (database: LocalDatabase) => Promise<T>,
  environment: NodeJS.ProcessEnv = process.env,
) {
  return withSetupLock(directory, async () =>
    action(await prepareDatabase(directory, environment)),
  );
}

export function localDatabaseEnvironment(
  database: LocalDatabase,
  environment: NodeJS.ProcessEnv = process.env,
): NodeJS.ProcessEnv {
  return {
    ...environment,
    NOD_POSTGRES_PASSWORD: database.password,
    DATABASE_URL: database.serverDatabaseUrl,
  };
}

type DatabaseCommand = (
  command: string,
  args: string[],
  options: { input: string; env: NodeJS.ProcessEnv },
) => Promise<void>;

const runPrivate: DatabaseCommand = (command, args, options) =>
  new Promise((resolve, reject) => {
    const fail = () => reject(new Error('The local database password could not be updated.'));
    const child = spawn(command, args, { env: options.env, stdio: ['pipe', 'ignore', 'ignore'] });
    const timeout = setTimeout(() => child.kill('SIGKILL'), 30_000);
    child.on('error', () => {
      clearTimeout(timeout);
      fail();
    });
    child.stdin.on('error', () => {});
    child.on('close', (code) => {
      clearTimeout(timeout);
      if (code === 0) resolve();
      else fail();
    });
    child.stdin.end(options.input);
  });

export async function rotateLocalDatabase(
  database: LocalDatabase,
  options: { environment?: NodeJS.ProcessEnv; run?: DatabaseCommand } = {},
) {
  if (!/^[A-Za-z0-9_-]{43,128}$/.test(database.password))
    throw new Error('The local PostgreSQL password is invalid.');
  const salt = randomBytes(16);
  const salted = pbkdf2Sync(database.password, salt, 4096, 32, 'sha256');
  const clientKey = createHmac('sha256', salted).update('Client Key').digest();
  const storedKey = createHash('sha256').update(clientKey).digest('base64');
  const serverKey = createHmac('sha256', salted).update('Server Key').digest('base64');
  const verifier = `SCRAM-SHA-256$4096:${salt.toString('base64')}$${storedKey}:${serverKey}`;
  const input = [
    "SET log_statement = 'none';",
    'SET log_min_duration_statement = -1;',
    'SET log_min_duration_sample = -1;',
    'SET log_duration = off;',
    "SET log_min_error_statement = 'panic';",
    `ALTER ROLE nod WITH PASSWORD '${verifier}';`,
    '',
  ].join('\n');
  try {
    await (options.run || runPrivate)(
      'docker',
      [
        'compose',
        'exec',
        '-T',
        '--user',
        'postgres',
        'postgres',
        'psql',
        '--no-psqlrc',
        '--username=nod',
        '--dbname=postgres',
        '--set=ON_ERROR_STOP=1',
        '--quiet',
      ],
      { input, env: localDatabaseEnvironment(database, options.environment) },
    );
  } catch {
    throw new Error(
      'The local database password could not be updated. Existing data was retained.',
    );
  }
}

export async function verifyLocalDatabase(database: LocalDatabase) {
  const { default: pg } = await import('pg');
  const client = new pg.Client({
    connectionString: database.databaseUrl,
    connectionTimeoutMillis: 10_000,
    query_timeout: 10_000,
  });
  try {
    await client.connect();
    await client.query('SELECT 1');
  } catch {
    throw new Error(
      'The local database could not verify its updated password. Existing data was retained.',
    );
  } finally {
    await client.end().catch(() => {});
  }
}

export async function integrationDatabaseUrl(
  directory: string,
  environment: NodeJS.ProcessEnv = process.env,
) {
  if (environment.TEST_DATABASE_URL) return environment.TEST_DATABASE_URL;
  let saved: NodeJS.ProcessEnv = {};
  try {
    saved = parseEnv(await readFile(join(directory, '.env'), 'utf8'));
  } catch {}
  const value = environment.DATABASE_URL || saved.DATABASE_URL;
  if (value && localDatabaseUrl(value) && new URL(value).password) return value;
  throw new Error(
    'Run pnpm run dev to prepare the local database, or set TEST_DATABASE_URL explicitly.',
  );
}
