import { randomBytes } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { runProcess } from '../../src/providers/process.ts';
import { integrationDatabaseUrl } from '../../scripts/local-database.ts';
import { loadEnvironment, repository } from './stack.ts';

const container = 'otto-evals-pg';
const port = 54398;

export interface Check {
  name: string;
  ok: boolean;
  detail: string;
  fix?: string;
}

const docker = (...args: string[]) => runProcess('docker', args);

async function passwordFile(root: string) {
  const path = join(root, 'database-password');
  const existing = await readFile(path, 'utf8').catch(() => '');
  if (existing.trim()) return { path, password: existing.trim(), created: false };
  const password = randomBytes(18).toString('base64url');
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, password, { mode: 0o600 });
  return { path, password, created: true };
}

async function reachable(url: string) {
  const pg = (await import('pg')).default;
  const pool = new pg.Pool({ connectionString: url, max: 1, connectionTimeoutMillis: 3000 });
  try {
    await pool.query('SELECT 1');
    return true;
  } catch {
    return false;
  } finally {
    await pool.end().catch(() => {});
  }
}

export async function ensureDatabase(
  root: string,
  environment: Record<string, string | undefined>,
  provision: boolean,
) {
  try {
    return { url: await integrationDatabaseUrl(repository, environment), provisioned: false };
  } catch {}
  const { password } = await passwordFile(root);
  const url = `postgres://otto:${password}@127.0.0.1:${port}/otto`;
  if (await reachable(url)) return { url, provisioned: true };
  if (!provision) throw new Error('No test database. Run: npm run eval:capability -- doctor --fix');
  await docker('rm', '-f', container);
  const started = await docker(
    'run',
    '-d',
    '--name',
    container,
    '-e',
    'POSTGRES_USER=otto',
    '-e',
    `POSTGRES_PASSWORD=${password}`,
    '-e',
    'POSTGRES_DB=otto',
    '-p',
    `127.0.0.1:${port}:5432`,
    'postgres:17-alpine',
  );
  if (started.exitCode)
    throw new Error(`Could not start the test database: ${started.stderr.trim().slice(0, 200)}`);
  for (let attempt = 0; attempt < 60; attempt++) {
    if (await reachable(url)) return { url, provisioned: true };
    await new Promise((done) => setTimeout(done, 1000));
  }
  throw new Error('The test database did not become ready.');
}

export async function imageNames(environment: Record<string, string | undefined>) {
  const has = async (name: string) =>
    (await docker('image', 'inspect', name, '--format', '{{.Id}}')).exitCode === 0;
  const pick = async (fromEnv: string | undefined, candidates: string[]) => {
    if (fromEnv) return fromEnv;
    for (const name of candidates) if (await has(name)) return name;
    return candidates[0];
  };
  return {
    workspace: await pick(environment.OTTO_EVAL_WORKSPACE_IMAGE, [
      'otto-local-workspace',
      'otto-eval-workspace',
    ]),
    browser: await pick(environment.OTTO_EVAL_BROWSER_IMAGE, [
      'otto-local-browser',
      'otto-eval-browser',
    ]),
    has,
  };
}

export async function doctor(root: string, fix: boolean) {
  const environment = await loadEnvironment();
  const checks: Check[] = [];
  const daemon = await docker('info', '--format', '{{.ServerVersion}}');
  checks.push({
    name: 'Docker',
    ok: daemon.exitCode === 0,
    detail:
      daemon.exitCode === 0 ? `engine ${daemon.stdout.trim()}` : 'the Docker engine is not running',
    fix: 'Start Docker Desktop (or the Docker daemon).',
  });
  if (daemon.exitCode === 0) {
    const names = await imageNames(environment);
    for (const [label, name, dockerfile] of [
      ['Workspace image', names.workspace, 'Dockerfile.workspace'],
      ['Browser image', names.browser, 'Dockerfile.browser'],
    ] as const) {
      let ok = await names.has(name);
      if (!ok && fix) {
        const tag = name.startsWith('otto-local') ? name.replace('otto-local', 'otto-eval') : name;
        const built = await runProcess('docker', ['build', '-f', dockerfile, '-t', tag, '.'], {
          cwd: repository,
          timeoutMs: 1_800_000,
        });
        ok = built.exitCode === 0;
        if (ok)
          process.env[
            label.startsWith('Workspace') ? 'OTTO_EVAL_WORKSPACE_IMAGE' : 'OTTO_EVAL_BROWSER_IMAGE'
          ] = tag;
      }
      checks.push({
        name: label,
        ok,
        detail: ok ? name : `${name} is missing`,
        fix: `Run npm run dev once, or: npm run eval:capability -- doctor --fix (builds ${dockerfile})`,
      });
    }
    try {
      const database = await ensureDatabase(root, environment, fix);
      checks.push({
        name: 'Test database',
        ok: true,
        detail: database.provisioned
          ? `disposable container ${container} on port ${port}`
          : 'your configured database (only eval_* schemas are touched)',
      });
    } catch (error) {
      checks.push({
        name: 'Test database',
        ok: false,
        detail: (error as Error).message,
        fix: 'Run: npm run eval:capability -- doctor --fix',
      });
    }
  }
  const keys = ['OPENAI_API_KEY', 'ANTHROPIC_API_KEY'].filter((name) => environment[name]);
  checks.push({
    name: 'Model keys',
    ok: keys.length > 0,
    detail: keys.length
      ? `${keys.join(' and ')} set${environment.ANTHROPIC_API_KEY ? '' : '; the judge falls back to the agent model (set ANTHROPIC_API_KEY for an independent judge)'}`
      : 'neither OPENAI_API_KEY nor ANTHROPIC_API_KEY is set',
    fix: 'export OPENAI_API_KEY=... (or ANTHROPIC_API_KEY=...) in your shell or .env',
  });
  return checks;
}

export function printChecks(checks: Check[]) {
  for (const check of checks)
    console.log(
      `${check.ok ? '✓' : '✗'} ${check.name.padEnd(16)} ${check.detail}${check.ok || !check.fix ? '' : `\n    → ${check.fix}`}`,
    );
  return checks.every((check) => check.ok);
}

export async function cleanup(root: string) {
  const listed = await docker('ps', '-a', '--format', '{{.Names}}');
  const orphans = listed.stdout
    .split('\n')
    .filter((name) => /^otto-(workspace|browser)-eval-[a-f0-9]+$/.test(name));
  if (orphans.length) await docker('rm', '-f', ...orphans);
  let schemas = 0;
  try {
    const environment = await loadEnvironment();
    const { url } = await ensureDatabase(root, environment, false);
    const pg = (await import('pg')).default;
    const pool = new pg.Pool({ connectionString: url, max: 1 });
    const found = await pool.query(
      "SELECT nspname FROM pg_namespace WHERE nspname ~ '^eval_(boss_)?[a-f0-9]{12}$'",
    );
    for (const row of found.rows) await pool.query(`DROP SCHEMA IF EXISTS ${row.nspname} CASCADE`);
    schemas = found.rowCount ?? 0;
    await pool.end();
  } catch {}
  return { containers: orphans.length, schemas };
}
