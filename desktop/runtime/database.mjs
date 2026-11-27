import { spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import {
  access,
  appendFile,
  mkdir,
  open,
  readdir,
  readFile,
  rename,
  rm,
  statfs,
  writeFile,
} from 'node:fs/promises';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { pipeline } from 'node:stream/promises';
import { setTimeout as delay } from 'node:timers/promises';
import { availablePort, execute } from './index.mjs';

const stateVersion = 1;

function toolEnvironment() {
  if (process.platform !== 'win32') return { PATH: '/usr/bin:/bin', HOME: homedir() };
  const environment = Object.fromEntries(
    ['SYSTEMROOT', 'USERPROFILE', 'LOCALAPPDATA', 'TEMP', 'TMP'].flatMap((key) =>
      process.env[key] ? [[key, process.env[key]]] : [],
    ),
  );
  environment.PATH = join(environment.SYSTEMROOT || 'C:\\Windows', 'System32');
  return environment;
}

async function exists(path) {
  return access(path).then(
    () => true,
    (error) => {
      if (error.code === 'ENOENT') return false;
      throw error;
    },
  );
}

async function writeState(path, state) {
  const temporary = `${path}.${randomBytes(6).toString('hex')}.tmp`;
  await writeFile(temporary, JSON.stringify(state), { mode: 0o600, flag: 'wx', flush: true });
  await rename(temporary, path);
}

async function readState(path) {
  let state;
  try {
    state = JSON.parse(await readFile(path, 'utf8'));
  } catch (error) {
    if (error.code === 'ENOENT') return undefined;
    throw Object.assign(new Error('Nod could not read its database settings.', { cause: error }), {
      code: 'NOD_DATABASE_STATE_INVALID',
    });
  }
  if (
    state?.version !== stateVersion ||
    !/^[a-f0-9]{64}$/.test(state.password) ||
    typeof state.ready !== 'boolean'
  )
    throw Object.assign(new Error('Nod’s database settings are invalid.'), {
      code: 'NOD_DATABASE_STATE_INVALID',
    });
  return state;
}

async function computerDatabaseExists(dataRoot) {
  try {
    const saved = JSON.parse(
      await readFile(join(dataRoot, 'desktop-runtime', 'state.json'), 'utf8'),
    );
    return saved?.initializing !== true;
  } catch (error) {
    return error.code !== 'ENOENT';
  }
}

async function logTail(path) {
  const text = await readFile(path, 'utf8').catch(() => '');
  return text.slice(-4000);
}

const requiredSpace = 256 * 1024 * 1024;

function failure(code, message, cause, details) {
  return Object.assign(new Error(message, { cause }), {
    code,
    details: [cause?.details || cause?.stack || cause?.message, details].filter(Boolean).join('\n'),
  });
}

async function checkSpace(path, bytes = 0, purpose = 'for its database') {
  const required = requiredSpace + bytes;
  const { bavail, bsize } = await statfs(path).catch(() => ({ bavail: Infinity, bsize: 1 }));
  if (bavail * bsize < required)
    throw failure(
      'NOD_DATABASE_STORAGE_FULL',
      `Nod needs about ${Math.round(required / 1024 / 1024)} MB of free disk space ${purpose}. Free some space, then try again.`,
    );
}

async function nativePath(path) {
  if (process.platform !== 'win32' || /^[\x20-\x7e]*$/.test(path)) return path;
  const env = toolEnvironment();
  const short = await execute(
    join(env.SYSTEMROOT || 'C:\\Windows', 'System32/WindowsPowerShell/v1.0/powershell.exe'),
    [
      '-NoProfile',
      '-NonInteractive',
      '-Command',
      '(New-Object -ComObject Scripting.FileSystemObject).GetFolder($env:NOD_LONG_PATH).ShortPath',
    ],
    { env: { ...env, NOD_LONG_PATH: path }, timeout: 60_000 },
  ).catch(() => '');
  return /^[\x20-\x7e]+$/.test(short) ? short : path;
}

async function connect(port, password, database) {
  const { default: pg } = await import('pg');
  const client = new pg.Client({
    host: '127.0.0.1',
    port,
    user: 'nod',
    password,
    database,
    connectionTimeoutMillis: 10_000,
  });
  try {
    await client.connect();
  } catch (error) {
    await client.end().catch(() => {});
    throw error;
  }
  return client;
}

function alive(pid) {
  if (!Number.isSafeInteger(pid) || pid < 1) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error.code === 'EPERM';
  }
}

async function lockOwner(data) {
  const lock = await readFile(join(data, 'postmaster.pid'), 'utf8').catch(() => undefined);
  if (lock === undefined) return undefined;
  const lines = lock.split('\n');
  return { pid: Number(lines[0]), port: Number(lines[3]) };
}

async function stopLeftover({ data, password, pgCtl, env, signal }) {
  const lock = await lockOwner(data);
  if (!lock) return;
  for (let attempt = 0; alive(lock.pid) && attempt < 30; attempt++) {
    const client = await connect(lock.port, password, 'postgres').catch((error) => {
      if (error.code !== '57P03') return null;
    });
    if (client === null) break;
    if (client) {
      const directory = await client
        .query("SELECT current_setting('data_directory') AS value")
        .then(
          (result) => result.rows[0].value,
          () => undefined,
        )
        .finally(() => client.end().catch(() => {}));
      if (directory && resolve(directory).toLowerCase() === resolve(data).toLowerCase()) {
        await execute(
          pgCtl,
          ['stop', '--pgdata', data, '--mode', 'fast', '--wait', '--timeout', '60'],
          { env, signal, timeout: 90_000 },
        );
        return;
      }
      break;
    }
    await delay(1000, undefined, { signal });
  }
  await rm(join(data, 'postmaster.pid'), { force: true });
}

export async function openDatabase({ dataRoot, resourcesPath, signal, onEvent }) {
  const root = join(resolve(dataRoot), 'database');
  const statePath = join(root, 'state.json');
  const env = toolEnvironment();
  await mkdir(root, { recursive: true, mode: 0o700 });
  for (const entry of await readdir(root))
    if (/\.[a-f0-9]{12}\.(?:tmp|password)$/.test(entry))
      await rm(join(root, entry), { recursive: true, force: true });
  let state = await readState(statePath);
  if (!state) {
    await checkSpace(root);
    state = {
      version: stateVersion,
      password: randomBytes(32).toString('hex'),
      ready: !(await computerDatabaseExists(dataRoot)),
    };
    await writeState(statePath, state);
  }
  const nativeRoot = await nativePath(root);
  const data = join(nativeRoot, 'data');
  const log = join(nativeRoot, 'postgres.log');
  const tools = await nativePath(join(resolve(resourcesPath), 'postgres', 'bin'));
  const tool = (name) => join(tools, process.platform === 'win32' ? `${name}.exe` : name);
  const pgCtl = tool('pg_ctl');
  if (!(await exists(join(data, 'PG_VERSION')))) {
    await checkSpace(root);
    const suffix = randomBytes(6).toString('hex');
    const temporary = join(nativeRoot, `data.${suffix}.tmp`);
    const passwordFile = join(nativeRoot, `state.${suffix}.password`);
    await writeFile(passwordFile, `${state.password}\n`, { mode: 0o600, flag: 'wx' });
    try {
      await execute(
        tool('initdb'),
        [
          '--pgdata',
          temporary,
          '--username',
          'nod',
          '--auth',
          'scram-sha-256',
          '--pwfile',
          passwordFile,
          '--encoding',
          'UTF8',
          '--no-locale',
          '--locale-provider',
          'builtin',
          '--builtin-locale',
          'C.UTF-8',
          '--no-instructions',
        ],
        { env, signal, timeout: 600_000 },
      );
      await appendFile(
        join(temporary, 'postgresql.conf'),
        "\nlisten_addresses = '127.0.0.1'\nunix_socket_directories = ''\ntimezone = 'UTC'\nlog_timezone = 'UTC'\n",
      );
      await rm(data, { recursive: true, force: true });
      await rename(temporary, data);
    } catch (cause) {
      await rm(temporary, { recursive: true, force: true }).catch(() => {});
      signal?.throwIfAborted();
      await checkSpace(root);
      throw failure('NOD_DATABASE_SETUP_FAILED', 'Nod could not create its database.', cause);
    } finally {
      await rm(passwordFile, { force: true });
    }
  }
  await stopLeftover({ data, password: state.password, pgCtl, env, signal }).catch(() => {});
  let port;
  const start = async (abort) => {
    abort?.throwIfAborted();
    await rm(log, { force: true }).catch(() => {});
    const output = await open(`${log}.start`, 'w');
    try {
      const code = await new Promise((resolveStart, reject) => {
        const child = spawn(
          pgCtl,
          [
            'start',
            '--pgdata',
            data,
            '--log',
            log,
            '--wait',
            '--timeout',
            '300',
            '--options',
            `-p ${port}`,
          ],
          { env, stdio: ['ignore', output.fd, output.fd], windowsHide: true },
        );
        const stop = () => child.kill();
        const timer = setTimeout(stop, 330_000);
        const settle = () => {
          clearTimeout(timer);
          abort?.removeEventListener('abort', stop);
        };
        abort?.addEventListener('abort', stop, { once: true });
        child.once('error', (error) => {
          settle();
          reject(error);
        });
        child.once('exit', (exitCode) => {
          settle();
          resolveStart(exitCode);
        });
      });
      abort?.throwIfAborted();
      if (code !== 0)
        throw Object.assign(new Error(`pg_ctl start failed (${code ?? 'stopped'}).`), {
          exitCode: code,
          details: (await readFile(`${log}.start`, 'utf8').catch(() => '')).slice(-4000),
        });
    } finally {
      await output.close();
    }
  };
  const running = async () => alive((await lockOwner(data))?.pid);
  for (let attempt = 1; ; attempt++) {
    port = await availablePort();
    try {
      await start(signal);
      break;
    } catch (cause) {
      signal?.throwIfAborted();
      const details = await logTail(log);
      if (attempt < 3) {
        await stopLeftover({ data, password: state.password, pgCtl, env, signal }).catch(() => {});
        continue;
      }
      await checkSpace(root);
      throw failure(
        'NOD_DATABASE_START_FAILED',
        'Nod could not start its database.',
        cause,
        details,
      );
    }
  }
  let closing = false;
  let restarting;
  let restart;
  const watchdog = setInterval(() => {
    restarting ??= running()
      .then(async (up) => {
        if (up || closing) return;
        restart = new AbortController();
        await start(restart.signal);
        onEvent?.({ event: 'database_restarted' });
      })
      .catch(async (error) => {
        if (!closing)
          onEvent?.({ event: 'database_restart_failed', error, details: await logTail(log) });
      })
      .finally(() => {
        restarting = undefined;
        restart = undefined;
      });
  }, 5000);
  watchdog.unref?.();
  const close = async () => {
    closing = true;
    clearInterval(watchdog);
    restart?.abort();
    await restarting;
    try {
      await execute(
        pgCtl,
        ['stop', '--pgdata', data, '--mode', 'fast', '--wait', '--timeout', '60'],
        { env, timeout: 90_000 },
      );
    } catch (error) {
      if (await running()) throw error;
    }
  };
  try {
    const client = await connect(port, state.password, 'postgres');
    try {
      if (!(await client.query("SELECT 1 FROM pg_database WHERE datname='nod'")).rowCount)
        await client.query('CREATE DATABASE nod');
    } finally {
      await client.end().catch(() => {});
    }
  } catch (cause) {
    await close().catch(() => {});
    throw failure(
      'NOD_DATABASE_CONNECTION_FAILED',
      'Nod could not open its database.',
      cause,
      await logTail(log),
    );
  }
  return {
    url: `postgresql://nod:${state.password}@127.0.0.1:${port}/nod`,
    password: state.password,
    get pendingMove() {
      return !state.ready;
    },
    ensureSpace: (bytes) => checkSpace(root, bytes * 2, 'to move your saved data'),
    async moved() {
      state = { ...state, ready: true };
      await writeState(statePath, state);
    },
    close,
  };
}

const restrictLine = /^\\(?:un)?restrict [A-Za-z0-9]+$/gm;

export async function moveDatabase({ source, target, schema, signal, space }) {
  const { default: pg } = await import('pg');
  const { from: copyFrom, to: copyTo } = await import('pg-copy-streams');
  const [pre, post] = await Promise.all([schema('pre-data'), schema('post-data')]);
  const legacy = new pg.Client({ connectionString: source, connectionTimeoutMillis: 10_000 });
  const host = new pg.Client({ connectionString: target, connectionTimeoutMillis: 10_000 });
  await legacy.connect();
  try {
    await host.connect();
    try {
      const copied = await host.query(
        "SELECT EXISTS (SELECT 1 FROM pg_tables WHERE schemaname NOT IN ('pg_catalog', 'information_schema')) AS value",
      );
      if (copied.rows[0].value) return;
      await space?.(
        Number(
          (await legacy.query('SELECT pg_database_size(current_database())::text AS bytes')).rows[0]
            .bytes,
        ),
      );
      await legacy.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
      await host.query('BEGIN');
      try {
        await host.query(pre.replace(restrictLine, ''));
        const tables = (
          await legacy.query(`
            SELECT format('%I.%I', n.nspname, c.relname) AS name,
              string_agg(format('%I', a.attname), ',' ORDER BY a.attnum) AS columns
            FROM pg_class c
            JOIN pg_namespace n ON n.oid = c.relnamespace
            JOIN pg_attribute a ON a.attrelid = c.oid AND a.attnum > 0
              AND NOT a.attisdropped AND a.attgenerated = ''
            WHERE c.relkind = 'r'
              AND n.nspname NOT IN ('pg_catalog', 'information_schema')
              AND n.nspname NOT LIKE 'pg\\_%'
              AND NOT EXISTS (
                SELECT 1 FROM pg_depend d
                WHERE d.classid = 'pg_class'::regclass AND d.objid = c.oid AND d.deptype = 'e'
              )
            GROUP BY 1 ORDER BY 1`)
        ).rows;
        for (const { name, columns } of tables) {
          signal?.throwIfAborted();
          await pipeline(
            legacy.query(copyTo(`COPY ${name} (${columns}) TO STDOUT (FORMAT binary)`)),
            host.query(copyFrom(`COPY ${name} (${columns}) FROM STDIN (FORMAT binary)`)),
            { signal },
          );
          const [copied, original] = await Promise.all([
            host.query(`SELECT count(*)::text AS count FROM ${name}`),
            legacy.query(`SELECT count(*)::text AS count FROM ${name}`),
          ]);
          if (copied.rows[0].count !== original.rows[0].count)
            throw new Error(
              `The copy of ${name} has ${copied.rows[0].count} rows instead of ${original.rows[0].count}.`,
            );
        }
        const sequences = (
          await legacy.query(`
            SELECT format('%I.%I', schemaname, sequencename) AS name
            FROM pg_sequences
            WHERE schemaname NOT IN ('pg_catalog', 'information_schema')`)
        ).rows;
        for (const { name } of sequences) {
          const sequence = (
            await legacy.query(`SELECT last_value::text AS value, is_called FROM ${name}`)
          ).rows[0];
          await host.query('SELECT pg_catalog.setval($1::regclass, $2::bigint, $3)', [
            name,
            sequence.value,
            sequence.is_called,
          ]);
        }
        await host.query(post.replace(restrictLine, ''));
        await host.query('COMMIT');
      } catch (error) {
        await host.query('ROLLBACK').catch(() => {});
        throw error;
      } finally {
        await legacy.query('ROLLBACK').catch(() => {});
      }
    } finally {
      await host.end().catch(() => {});
    }
  } finally {
    await legacy.end().catch(() => {});
  }
}
