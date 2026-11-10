import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { appendFile, copyFile, mkdir, readFile, stat, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { checkRelease, checkReleasePlan } from './prepare-desktop-release.mjs';

const sourcePattern = /^[a-f0-9]{40}$/;
const digestPattern = /^[a-f0-9]{64}$/;
const versionPattern = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/;
const runPattern = /^[1-9]\d{0,19}$/;
const contextFile = 'desktop-release-context.json';
const planFile = 'desktop-release-plan.json';
const requiredJobs = [
  'Check release prerequisites',
  'Check arm64 Mac updates',
  'Check x64 Mac updates',
  'Package the arm64 Mac app',
  'Package the x64 Mac app',
  'Build the Windows runtime',
  'Check Windows updates',
  'Package and check the Windows installer',
];
const publisherJob = 'Verify uploaded assets and prepare the release';

function validRefresh(value) {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const date = new Date(`${value}T00:00:00Z`);
  return (
    Number.isFinite(date.getTime()) &&
    date.toISOString().slice(0, 10) === value &&
    date.getUTCDay() === 1
  );
}

function validUpdateSource(value) {
  if (value === '') return true;
  if (typeof value !== 'string' || value.length > 2048 || !URL.canParse(value)) return false;
  const url = new URL(value);
  return (
    url.protocol === 'https:' &&
    !url.username &&
    !url.password &&
    !url.search &&
    !url.hash &&
    !/[\r\n\0]/.test(value)
  );
}

function runtimeReuse(matrix) {
  const include = JSON.parse(matrix).include;
  if (!Array.isArray(include) || include.length !== 2)
    throw new Error('The original runtime matrix is invalid.');
  const values = {};
  for (const entry of include) {
    if (
      !['arm64', 'x64'].includes(entry?.arch) ||
      values[entry.arch] !== undefined ||
      !['true', 'false'].includes(entry.runtime_reused)
    )
      throw new Error('The original runtime matrix is invalid.');
    values[entry.arch] = entry.runtime_reused === 'true';
  }
  return values;
}

export function recoveryContext(value) {
  if (
    !value ||
    typeof value !== 'object' ||
    Array.isArray(value) ||
    Object.keys(value).sort().join(',') !==
      'metadataSha256,privateRepository,repository,runAttempt,runId,runtimeRefresh,runtimeReused,source,updateSourceUrl,version' ||
    typeof value.repository !== 'string' ||
    !/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(value.repository) ||
    typeof value.runId !== 'string' ||
    !runPattern.test(value.runId) ||
    typeof value.runAttempt !== 'string' ||
    !runPattern.test(value.runAttempt) ||
    !sourcePattern.test(value.source) ||
    typeof value.version !== 'string' ||
    !versionPattern.test(value.version) ||
    !validRefresh(value.runtimeRefresh) ||
    !value.runtimeReused ||
    typeof value.runtimeReused !== 'object' ||
    Array.isArray(value.runtimeReused) ||
    Object.keys(value.runtimeReused).sort().join(',') !== 'arm64,x64' ||
    typeof value.runtimeReused.arm64 !== 'boolean' ||
    typeof value.runtimeReused.x64 !== 'boolean' ||
    typeof value.metadataSha256 !== 'string' ||
    (value.metadataSha256 !== '' && !digestPattern.test(value.metadataSha256)) ||
    typeof value.updateSourceUrl !== 'string' ||
    !validUpdateSource(value.updateSourceUrl) ||
    typeof value.privateRepository !== 'boolean' ||
    value.privateRepository !== Boolean(value.updateSourceUrl)
  )
    throw new Error('The original release context is invalid.');
  return value;
}

export function checkRecoveryJobs(context, attempts) {
  if (!Array.isArray(attempts) || !attempts.length)
    throw new Error('The original build jobs are unavailable.');
  const latest = new Map();
  for (const jobs of attempts) {
    if (!Array.isArray(jobs)) throw new Error('The original build jobs are unavailable.');
    const names = new Set();
    for (const job of jobs) {
      if (typeof job?.name !== 'string' || names.has(job.name))
        throw new Error('The original build jobs are invalid.');
      names.add(job.name);
      if (!latest.has(job.name)) latest.set(job.name, job.conclusion);
    }
  }
  if (requiredJobs.some((name) => latest.get(name) !== 'success'))
    throw new Error('The selected build run has failed or missing platform checks.');
  if (latest.get(publisherJob) !== 'failure')
    throw new Error('The selected build run has no failed release publisher.');
  for (const arch of ['arm64', 'x64']) {
    const conclusion = latest.get(`Build ${arch} Mac runtime images`);
    if (
      (!context.runtimeReused[arch] && conclusion !== 'success') ||
      (context.runtimeReused[arch] &&
        conclusion !== undefined &&
        !['success', 'skipped'].includes(conclusion))
    )
      throw new Error(`The ${arch} runtime image build does not match the original release.`);
  }
  const known = new Set([
    ...requiredJobs,
    publisherJob,
    'Build arm64 Mac runtime images',
    'Build x64 Mac runtime images',
  ]);
  for (const [name, conclusion] of latest) {
    if (known.has(name) || conclusion === 'success') continue;
    if (
      context.runtimeReused.arm64 &&
      context.runtimeReused.x64 &&
      conclusion === 'skipped' &&
      ['Build ${{ matrix.arch }} Mac runtime images', 'Build Mac runtime images'].includes(name)
    )
      continue;
    throw new Error('The selected build run has an unexpected unsuccessful job.');
  }
}

async function exists(path) {
  try {
    return (await stat(path)).isFile();
  } catch (error) {
    if (error.code === 'ENOENT') return false;
    throw error;
  }
}

export async function bindRecovery({ root, artifacts, expected, getAttemptJobs }) {
  const context = recoveryContext(
    JSON.parse(await readFile(join(artifacts, 'desktop-release-context', contextFile), 'utf8')),
  );
  if (
    context.repository !== expected.repository ||
    context.runId !== expected.runId ||
    typeof expected.runAttempt !== 'string' ||
    !runPattern.test(expected.runAttempt) ||
    BigInt(context.runAttempt) > BigInt(expected.runAttempt) ||
    context.source !== expected.source
  )
    throw new Error('The release context does not belong to the selected build run.');
  if (context.privateRepository !== expected.privateRepository)
    throw new Error('Repository visibility changed since the build. Start a new desktop release.');
  for (const [arch, platform, path] of [
    ['arm64', 'darwin-arm64', 'dist/desktop/arm64/release.json'],
    ['x64', 'darwin-x64', 'dist/desktop/x64/release.json'],
    [null, 'win32-x64', 'dist/desktop/win32-x64/release-win32-x64.json'],
  ]) {
    const manifest = JSON.parse(await readFile(join(root, path), 'utf8'));
    if (
      manifest.platform !== platform ||
      manifest.version !== context.version ||
      manifest.source !== context.source ||
      manifest.updateSourceUrl !== (context.updateSourceUrl || undefined)
    )
      throw new Error(`The ${platform} release does not match the original build context.`);
    if (arch) {
      const runtime = JSON.parse(
        await readFile(join(root, `dist/desktop/${arch}/runtime-release.json`), 'utf8'),
      );
      if (
        context.runtimeReused[arch] !==
        (runtime.releaseTag !== undefined && runtime.releaseTag !== `nod-v${context.version}`)
      )
        throw new Error(`The ${arch} runtime does not match the original build context.`);
    }
  }
  const plan = join(artifacts, 'desktop-release-plan', planFile);
  if ((await exists(plan)) !== Boolean(context.metadataSha256))
    throw new Error('The release plan artifact does not match the original build context.');
  if (typeof getAttemptJobs !== 'function')
    throw new Error('The original build jobs are unavailable.');
  const attempts = [];
  for (let attempt = BigInt(expected.runAttempt); attempt >= BigInt(context.runAttempt); attempt--)
    attempts.push(await getAttemptJobs(attempt.toString()));
  checkRecoveryJobs(context, attempts);
  const environment = {
    NOD_RELEASE_SOURCE: context.source,
    NOD_RELEASE_VERSION: context.version,
    NOD_RUNTIME_REFRESH: context.runtimeRefresh,
    NOD_DESKTOP_UPDATE_SOURCE_URL: context.updateSourceUrl,
  };
  if (context.metadataSha256) {
    const bytes = await readFile(plan);
    if (createHash('sha256').update(bytes).digest('hex') !== context.metadataSha256)
      throw new Error('The original release plan failed its checksum.');
    await checkReleasePlan(root, context.version, plan, context.metadataSha256);
    const target = join(root, '.local', planFile);
    await mkdir(dirname(target), { recursive: true });
    await copyFile(plan, target);
    environment.NOD_RELEASE_PLAN = `.local/${planFile}`;
    environment.NOD_RELEASE_PLAN_SHA256 = context.metadataSha256;
  } else await checkRelease(root, context.version);
  return environment;
}

async function main() {
  const [command, ...extra] = process.argv.slice(2);
  if (extra.length) throw new Error('Expected create or bind.');
  if (command === 'create') {
    const context = recoveryContext({
      repository: process.env.GITHUB_REPOSITORY,
      runId: process.env.GITHUB_RUN_ID,
      runAttempt: process.env.GITHUB_RUN_ATTEMPT,
      source: process.env.NOD_CONTEXT_SOURCE,
      version: process.env.NOD_CONTEXT_VERSION,
      runtimeRefresh: process.env.NOD_CONTEXT_RUNTIME_REFRESH,
      runtimeReused: runtimeReuse(process.env.NOD_CONTEXT_MAC_MATRIX),
      metadataSha256: process.env.NOD_CONTEXT_PLAN_SHA256 || '',
      updateSourceUrl: process.env.NOD_CONTEXT_UPDATE_SOURCE_URL || '',
      privateRepository: process.env.NOD_CONTEXT_PRIVATE === 'true',
    });
    const destination = resolve('.local', contextFile);
    await mkdir(dirname(destination), { recursive: true });
    await writeFile(destination, JSON.stringify(context) + '\n');
    return;
  }
  if (command === 'bind') {
    const root = process.cwd();
    const environment = await bindRecovery({
      root,
      artifacts: join(root, '.local/desktop-release-artifacts'),
      expected: {
        repository: process.env.GITHUB_REPOSITORY,
        runId: process.env.RELEASE_RUN_ID,
        runAttempt: process.env.RELEASE_RUN_ATTEMPT,
        source: process.env.NOD_RELEASE_SOURCE,
        privateRepository: process.env.CURRENT_REPOSITORY_PRIVATE === 'true',
      },
      getAttemptJobs: async (attempt) => {
        const result = JSON.parse(
          execFileSync(
            'gh',
            [
              'api',
              `repos/${process.env.GITHUB_REPOSITORY}/actions/runs/${process.env.RELEASE_RUN_ID}/attempts/${attempt}/jobs?per_page=100`,
            ],
            { encoding: 'utf8' },
          ),
        );
        if (!Array.isArray(result.jobs) || result.total_count !== result.jobs.length)
          throw new Error('The original build job list is incomplete.');
        return result.jobs;
      },
    });
    if (!process.env.GITHUB_ENV) throw new Error('The recovery environment file is unavailable.');
    await appendFile(
      process.env.GITHUB_ENV,
      Object.entries(environment)
        .map(([name, value]) => `${name}=${value}\n`)
        .join(''),
    );
    return;
  }
  throw new Error('Expected create or bind.');
}

if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1]))
  main().catch((error) => {
    process.stderr.write(`${error.message}\n`);
    process.exitCode = 1;
  });
