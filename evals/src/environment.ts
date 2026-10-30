import { randomBytes } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { runProcess } from '../../src/providers/process.ts';
import { integrationDatabaseUrl } from '../../scripts/local-database.ts';
import { keyVariables, loadEnvironment, repository } from './stack.ts';

const container = 'nod-evals-pg';
const port = 54398;

interface Check {
  name: string;
  ok: boolean;
  detail: string;
  fix?: string;
}

const docker = (...args: string[]) => runProcess('docker', args);

async function passwordFile(root: string) {
  const path = join(homedir(), '.nod-evals', 'database-password');
  const saved = async (file: string) => (await readFile(file, 'utf8').catch(() => '')).trim();
  const password = (await saved(path)) || (await saved(join(root, 'database-password')));
  if (password) {
    await mkdir(dirname(path), { recursive: true, mode: 0o700 });
    await writeFile(path, password, { mode: 0o600 });
    return { path, password };
  }
  const created = randomBytes(18).toString('base64url');
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  await writeFile(path, created, { mode: 0o600 });
  return { path, password: created };
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

let provisioning: Promise<unknown> = Promise.resolve();

export async function ensureDatabase(
  root: string,
  environment: Record<string, string | undefined>,
  provision: boolean,
) {
  try {
    return { url: await integrationDatabaseUrl(repository, environment), provisioned: false };
  } catch {}
  const turn = provisioning.then(() => provisionDatabase(root, provision));
  provisioning = turn.catch(() => {});
  return turn;
}

async function provisionDatabase(root: string, provision: boolean) {
  const { password } = await passwordFile(root);
  const url = `postgres://nod:${password}@127.0.0.1:${port}/nod`;
  if (await reachable(url)) return { url, provisioned: true };
  if (!provision) throw new Error('No test database. Run: pnpm run eval:capability doctor --fix');
  const state = (
    await docker('ps', '-a', '--filter', `name=^${container}$`, '--format', '{{.State}}')
  ).stdout.trim();
  if (state !== 'running') {
    await docker('rm', '-f', container);
    const started = await docker(
      'run',
      '-d',
      '--name',
      container,
      '-e',
      'POSTGRES_USER=nod',
      '-e',
      `POSTGRES_PASSWORD=${password}`,
      '-e',
      'POSTGRES_DB=nod',
      '-p',
      `127.0.0.1:${port}:5432`,
      'postgres:17-alpine',
    );
    if (started.exitCode)
      throw new Error(`Could not start the test database: ${started.stderr.trim().slice(0, 200)}`);
  }
  for (let attempt = 0; attempt < 60; attempt++) {
    if (await reachable(url)) return { url, provisioned: true };
    await new Promise((done) => setTimeout(done, 1000));
  }
  throw new Error(
    state === 'running'
      ? `The ${container} container is running with another password. Remove it with: docker rm -f ${container}`
      : 'The test database did not become ready.',
  );
}

export async function evalImages(environment: Record<string, string | undefined>) {
  const build = async (
    fromEnv: string | undefined,
    tag: string,
    dockerfile: string,
    target: string[] = [],
  ) => {
    if (fromEnv) {
      if ((await docker('image', 'inspect', fromEnv, '--format', '{{.Id}}')).exitCode)
        throw new Error(`Docker image ${fromEnv} is missing.`);
      return fromEnv;
    }
    const built = await runProcess(
      'docker',
      ['build', '-q', '-f', dockerfile, ...target, '-t', tag, '.'],
      {
        cwd: repository,
        timeoutMs: 1_800_000,
      },
    );
    if (built.exitCode)
      throw new Error(
        `Could not build ${tag} from ${dockerfile}: ${built.stderr.trim().slice(-300)}`,
      );
    return tag;
  };
  return {
    workspace: await build(
      environment.NOD_EVAL_WORKSPACE_IMAGE,
      'nod-eval-workspace',
      'Dockerfile.workspace',
    ),
    browser: await build(
      environment.NOD_EVAL_BROWSER_IMAGE,
      'nod-eval-browser',
      'Dockerfile.browser',
      ['--target', 'eval'],
    ),
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
    let images: Awaited<ReturnType<typeof evalImages>> | undefined;
    let problem = '';
    if (fix)
      images = await evalImages(environment).catch((error: Error) => {
        problem = error.message;
        return undefined;
      });
    checks.push({
      name: 'Images',
      ok: !fix || Boolean(images),
      detail: images
        ? `${images.workspace}, ${images.browser}`
        : problem ||
          'built from Dockerfile.workspace and Dockerfile.browser at the start of each run',
      fix: 'Check that Docker can build Dockerfile.workspace and Dockerfile.browser.',
    });
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
        fix: 'Run: pnpm run eval:capability doctor --fix',
      });
    }
  }
  const provider =
    environment.LLM_PROVIDER ||
    (environment.OPENAI_API_KEY || !environment.ANTHROPIC_API_KEY ? 'openai' : 'anthropic');
  const variable = (keyVariables as Record<string, string | undefined>)[provider];
  const ready =
    Boolean(variable && environment[variable]) &&
    (provider !== 'openrouter' || Boolean(environment.LLM_MODEL));
  const others = Object.entries(keyVariables)
    .filter(([name, key]) => name !== provider && environment[key])
    .map(([name]) => name);
  checks.push({
    name: 'Model keys',
    ok: ready,
    detail: !variable
      ? `LLM_PROVIDER=${provider} is not supported (use openai, anthropic or openrouter)`
      : provider === 'openrouter' && !environment.LLM_MODEL
        ? 'LLM_PROVIDER=openrouter needs LLM_MODEL, for example moonshotai/kimi-k3'
        : ready
          ? `${variable} set for ${provider}${others.length ? `; also ${others.join(', ')}` : ''}${environment.ANTHROPIC_API_KEY ? '' : '; the judge falls back to the agent model (set ANTHROPIC_API_KEY for an independent judge)'}`
          : `${variable} is not set, and ${provider} is the model provider`,
    fix: `export ${variable ?? 'OPENAI_API_KEY'}=... in your shell or .env (or set LLM_PROVIDER)`,
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
    .filter((name) => /^nod-(workspace|browser)-eval-[a-f0-9]+$/.test(name));
  if (orphans.length) await docker('rm', '-f', ...orphans);
  let schemas = 0;
  const url = await loadEnvironment()
    .then((environment) => ensureDatabase(root, environment, false))
    .then((database) => database.url)
    .catch(() => undefined);
  if (url) {
    if (!['127.0.0.1', 'localhost'].includes(new URL(url).hostname))
      throw new Error('Cleanup only touches a local PostgreSQL database.');
    try {
      const pg = (await import('pg')).default;
      const pool = new pg.Pool({ connectionString: url, max: 1 });
      const found = await pool.query(
        "SELECT nspname FROM pg_namespace WHERE nspname ~ '^eval_(boss_)?[a-f0-9]{12}$'",
      );
      for (const row of found.rows)
        await pool.query(`DROP SCHEMA IF EXISTS ${row.nspname} CASCADE`);
      schemas = found.rowCount ?? 0;
      await pool.end();
    } catch {}
  }
  return { containers: orphans.length, schemas };
}
