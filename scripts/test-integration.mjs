import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { readdir, writeFile } from 'node:fs/promises';
import { relative, resolve } from 'node:path';
import { availableParallelism } from 'node:os';
import { pipeline } from 'node:stream/promises';
import { run } from 'node:test';
import { spec } from 'node:test/reporters';
import { setTimeout } from 'node:timers/promises';

const interruption = new AbortController();

function command(program, args, stdio = 'inherit', signal = interruption.signal) {
  signal?.throwIfAborted();
  return new Promise((resolve, reject) => {
    const detached = process.platform !== 'win32';
    const child = spawn(program, args, { stdio, detached, signal: signal ?? undefined });
    const stop = () => {
      if (detached && child.pid) {
        try {
          process.kill(-child.pid, 'SIGTERM');
        } catch {}
      }
    };
    signal?.addEventListener('abort', stop, { once: true });
    let failure;
    child.on('error', (error) => {
      failure = error;
    });
    child.on('close', (code) => {
      signal?.removeEventListener('abort', stop);
      if (failure) reject(failure);
      else if (code === 0) resolve();
      else reject(new Error(`${program} exited with status ${code ?? 'unknown'}.`));
    });
  });
}

if (process.argv.includes('--run')) {
  if (
    process.platform !== 'linux' ||
    process.env.NOD_TEST_NATIVE_DOWNLOAD !== 'true' ||
    !process.env.NOD_TEST_BROWSER_EXECUTABLE ||
    !process.env.TEST_DATABASE_URL
  ) {
    throw new Error('Integration tests require the Linux browser and PostgreSQL fixtures.');
  }
  const available = (await readdir('tests'))
    .filter((name) => name.endsWith('.test.ts'))
    .sort()
    .map((name) => `tests/${name}`);
  const files = process.env.NOD_TEST_FILES ? JSON.parse(process.env.NOD_TEST_FILES) : available;
  if (!Array.isArray(files) || !files.length || files.some((file) => !available.includes(file)))
    throw new Error('The integration test selection must name existing test files.');
  const tests = run({
    files,
    concurrency: Math.max(1, Math.floor(availableParallelism() / 2)),
    execArgv: ['--import', 'tsx'],
  });
  const timings = {};
  tests.on('test:summary', ({ success, counts, file, duration_ms }) => {
    if (!success || counts.skipped || counts.todo || counts.cancelled) process.exitCode = 1;
    if (file) timings[relative(process.cwd(), file)] = Math.ceil(duration_ms);
    else console.error(`Integration timings: ${JSON.stringify(timings)}`);
  });
  await pipeline(tests, new spec(), process.stdout);
  if (process.env.NOD_TEST_TIMINGS)
    await writeFile(process.env.NOD_TEST_TIMINGS, JSON.stringify(timings));
} else {
  const name = `nod-tests-${randomUUID()}`;
  const database = `${name}-db`;
  const image = 'nod-integration-browser';
  const cleanup = async () => {
    await command('docker', ['rm', '--force', name, database], 'ignore', null).catch(() => {});
    await command('docker', ['network', 'rm', name], 'ignore', null).catch(() => {});
  };
  for (const signal of ['SIGINT', 'SIGTERM']) {
    process.once(signal, () => {
      process.exitCode = signal === 'SIGINT' ? 130 : 143;
      interruption.abort();
    });
  }
  try {
    await command('pnpm', ['run', 'build']);
    await command('docker', [
      'build',
      '--file',
      'scripts/Dockerfile.integration',
      '--tag',
      image,
      '.',
    ]);
    await command('docker', ['network', 'create', '--internal', name]);
    await command('docker', [
      'run',
      '--detach',
      '--name',
      database,
      '--network',
      name,
      '--tmpfs',
      '/var/lib/postgresql/data',
      '--env',
      'POSTGRES_USER=nod',
      '--env',
      'POSTGRES_PASSWORD=nod-test',
      '--env',
      'POSTGRES_DB=nod_test',
      '--env',
      'POSTGRES_INITDB_ARGS=--set fsync=off --set synchronous_commit=off --set full_page_writes=off --set max_connections=300',
      'postgres:17-alpine',
    ]);
    let ready = false;
    for (let attempt = 0; attempt < 60; attempt++) {
      ready = await command(
        'docker',
        ['exec', database, 'pg_isready', '--host=127.0.0.1', '--username=nod', '--dbname=nod_test'],
        'ignore',
      ).then(
        () => true,
        () => false,
      );
      if (ready) break;
      await setTimeout(500, undefined, { signal: interruption.signal });
    }
    if (!ready) throw new Error('The integration PostgreSQL fixture did not become ready.');
    const mounts = [
      'src',
      'tests',
      'scripts',
      'public',
      'desktop/main',
      'desktop/preload',
      'desktop/ui',
      'deployment/self-host',
      'tsconfig.json',
      'dist/web',
    ].flatMap((path) => [
      '--mount',
      `type=bind,source=${resolve(path)},target=/app/${path},readonly`,
    ]);
    await command('docker', [
      'run',
      '--rm',
      '--name',
      name,
      '--network',
      name,
      '--shm-size=1g',
      '--tmpfs',
      '/app/.local:uid=1000,gid=1000',
      '--env',
      `TEST_DATABASE_URL=postgresql://nod:nod-test@${database}:5432/nod_test`,
      '--env',
      'NOD_TEST_NATIVE_DOWNLOAD=true',
      '--env',
      'NOD_TEST_BROWSER_EXECUTABLE=/usr/bin/chromium',
      '--env',
      'NOD_TEST_FILES',
      ...mounts,
      '--init',
      '--entrypoint',
      'node',
      image,
      'scripts/test-integration.mjs',
      '--run',
    ]);
  } catch (error) {
    if (!interruption.signal.aborted) throw error;
  } finally {
    await cleanup();
  }
}
