import { execFileSync, spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdir, readFile, readdir, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runProcess } from '../../src/providers/process.ts';
import { agentModels } from '../../src/shared/model-defaults.ts';
import type { ModelEffort } from '../../src/shared/models.ts';
import { summarize } from './aggregate.ts';
import { diagnoseAll } from './diagnose.ts';
import { ensureDatabase, evalImages } from './environment.ts';
import { html, terminal } from './report.ts';
import type { AttemptResult, RunManifest } from './results.ts';
import { scenarios } from './scenarios/index.ts';
import { loadEnvironment, parseModel, repository } from './stack.ts';
import { pruneAttempts, readAttempts, saveRun } from './store.ts';
import { createSpend, mergeAttemptCosts } from './spend.ts';

export const defaultJudge = 'anthropic/claude-sonnet-5-5';

export interface RunOptions {
  root: string;
  model?: string;
  effort?: ModelEffort;
  judge?: string;
  repeat: number;
  k?: number;
  concurrency: number;
  tier: string;
  scenarioIds?: string[];
  capability?: string;
  label?: string;
  ref?: string;
  resume: boolean;
  ignoreWindow: boolean;
  includePending?: boolean;
  retries: number;
  canary?: boolean;
  budget?: number;
  diagnose: boolean;
  quiet?: boolean;
}

const git = (...parts: string[]) =>
  execFileSync('git', parts, { cwd: repository, encoding: 'utf8' }).trim();
const sleep = (ms: number) => new Promise((done) => setTimeout(done, ms));
export const slug = (value: string) =>
  value
    .replace(/[^a-zA-Z0-9.]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 40);

export function defaultModel(environment: Record<string, string | undefined>) {
  const provider = (environment.LLM_PROVIDER ||
    (environment.OPENAI_API_KEY || !environment.ANTHROPIC_API_KEY ? 'openai' : 'anthropic')) as
    'openai' | 'anthropic';
  return `${provider}/${environment.LLM_MODEL || agentModels[provider]}`;
}

export async function prepare(root: string) {
  const environment = await loadEnvironment();
  const daemon = await runProcess('docker', ['info', '--format', '{{.ServerVersion}}']);
  if (daemon.exitCode)
    throw new Error('Docker is not running. Start it, then run: pnpm run eval:capability doctor');
  const database = await ensureDatabase(root, environment, true);
  process.env.TEST_DATABASE_URL = database.url;
  const images = await evalImages(environment);
  process.env.NOD_EVAL_WORKSPACE_IMAGE = images.workspace;
  process.env.NOD_EVAL_BROWSER_IMAGE = images.browser;
  return { ...environment, ...process.env } as Record<string, string | undefined>;
}

export function select(
  options: Pick<
    RunOptions,
    'tier' | 'scenarioIds' | 'capability' | 'ignoreWindow' | 'includePending'
  >,
) {
  const chosen = scenarios.filter(
    (item) =>
      (options.scenarioIds
        ? options.scenarioIds.includes(item.id)
        : item.tier !== 'canary' &&
          (options.tier === 'live' || item.tier !== 'live') &&
          (options.tier === 'release' || item.tier !== 'release') &&
          (options.tier !== 'pr' ||
            options.includePending ||
            item.calibration !== 'pending' ||
            item.stance === 'gap')) &&
      (options.scenarioIds || options.tier !== 'pr' || item.tier === 'pr') &&
      (!options.capability || item.capabilities.includes(options.capability as never)),
  );
  if (
    !chosen.length ||
    options.scenarioIds?.some((id) => !scenarios.some((item) => item.id === id))
  )
    throw new Error('No matching scenario. Use "list" to see the available ones.');
  if (options.scenarioIds)
    chosen.sort((a, b) => options.scenarioIds!.indexOf(a.id) - options.scenarioIds!.indexOf(b.id));
  const hour = Number(
    new Intl.DateTimeFormat('en-GB', {
      hour: 'numeric',
      hourCycle: 'h23',
      timeZone: 'Europe/Madrid',
    }).format(Date.now()),
  );
  const outside = chosen.filter(
    (item) => item.window && (hour < item.window.from || hour >= item.window.to),
  );
  if (outside.length && !options.ignoreWindow) {
    console.log(
      `Skipping ${outside.map((item) => item.id).join(', ')}: they depend on the time of day. Pass --ignore-window to run them anyway.`,
    );
    return chosen.filter((item) => !outside.includes(item));
  }
  return chosen;
}

async function attemptOnce(options: {
  directory: string;
  model: string;
  effort?: ModelEffort;
  judge: string;
  task: { item: (typeof scenarios)[number]; attempt: number };
}) {
  const { directory, model, effort, judge, task } = options;
  const file = join(directory, 'attempts', `${task.item.id}.${task.attempt}.json`);
  const specPath = join(tmpdir(), `nod-eval-${randomUUID()}.json`);
  await writeFile(
    specPath,
    JSON.stringify({
      scenario: task.item.id,
      attempt: task.attempt,
      outFile: file,
      model,
      effort,
      judge,
    }),
  );
  const child = spawn(
    process.execPath,
    ['--import', 'tsx', join(repository, 'evals/src/attempt.ts'), specPath],
    { cwd: repository, env: process.env, stdio: ['ignore', 'pipe', 'pipe'] },
  );
  let captured = '';
  for (const stream of [child.stdout, child.stderr])
    stream.on('data', (chunk) => (captured = (captured + chunk).slice(-20_000)));
  let grace: NodeJS.Timeout | undefined;
  const timer = setTimeout(
    () => {
      child.kill('SIGTERM');
      grace = setTimeout(() => child.kill('SIGKILL'), 120_000);
    },
    (task.item.seconds + 600) * 1000,
  );
  await new Promise((done) => child.on('close', done));
  clearTimeout(timer);
  clearTimeout(grace);
  await writeFile(join(directory, 'logs', `${task.item.id}.${task.attempt}.log`), captured);
  return readFile(file, 'utf8')
    .then((text) => JSON.parse(text) as AttemptResult)
    .catch(async () => {
      const failure: AttemptResult = {
        scenario: task.item.id,
        title: task.item.title,
        capabilities: task.item.capabilities,
        tier: task.item.tier,
        complexity: task.item.complexity,
        stance: task.item.stance,
        fingerprint: '',
        attempt: task.attempt,
        task: '',
        status: 'incomplete',
        blame: 'harness',
        error: `The attempt process ended without a result. ${captured.slice(-400)}`,
        checks: [],
        seconds: 0,
        toolCalls: 0,
        modelCalls: 0,
        tokens: 0,
        costUsd: null,
        toolErrors: 0,
        firstReplySeconds: null,
        judgeCostUsd: null,
        final: '',
        transcript: '',
        groundTruth: '',
      };
      await writeFile(file, JSON.stringify(failure, null, 2));
      return failure;
    });
}

async function checkHarness(model: string, judge: string) {
  const item = scenarios.find((entry) => entry.id === 'harness-canary')!;
  const directory = join(tmpdir(), `nod-eval-canary-${randomUUID()}`);
  await mkdir(join(directory, 'attempts'), { recursive: true });
  await mkdir(join(directory, 'logs'), { recursive: true });
  let broken = '';
  let failures = 0;
  let faults = 0;
  for (let attempt = 1; failures < 2; attempt++) {
    const result = await attemptOnce({ directory, model, judge, task: { item, attempt } });
    if (result.status === 'incomplete' && result.blame === 'infra' && faults < 2) {
      await sleep(Math.min(30_000 * 3 ** faults++, 90_000));
      continue;
    }
    broken =
      result.status === 'incomplete'
        ? (result.error ?? 'incomplete')
        : result.checks
            .filter((check) => check.kind === 'check' && check.required && !check.pass)
            .map((check) => check.id)
            .join(', ');
    if (!broken) return console.log('✓ harness canary');
    failures++;
  }
  throw new Error(
    `The harness canary failed twice (${broken}), so nothing was scored. Its logs are in ${directory}.`,
  );
}

export async function runSuite(options: RunOptions) {
  const environment = await prepare(options.root);
  const model = options.model ?? defaultModel(environment);
  const judge = options.judge ?? (environment.ANTHROPIC_API_KEY ? defaultJudge : model);
  parseModel(model, environment);
  parseModel(judge, environment);
  const k = options.k ?? options.repeat;
  if (k > options.repeat) throw new Error('--k cannot exceed --repeat.');
  const selected = select(options);
  const stamp = new Date().toISOString().slice(0, 16).replace(/[:T]/g, '-');
  const label = options.label ?? `${slug(model.split('/').pop()!)}-${stamp}`;
  if (!/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,79}$/.test(label))
    throw new Error('Labels must be simple file names.');
  const directory = join(options.root, label);
  const existing = await readdir(join(directory, 'attempts')).catch(() => [] as string[]);
  if (existing.length && !options.resume)
    throw new Error(`Run ${label} already exists. Choose another --label or pass --resume.`);

  let source = repository;
  let refCommit: string | undefined;
  if (options.ref) {
    if (options.ref.startsWith('-')) throw new Error('A git ref cannot start with a dash.');
    refCommit = git('rev-parse', '--verify', `${options.ref}^{commit}`);
    source = join(tmpdir(), `nod-eval-ref-${refCommit.slice(0, 10)}-${randomUUID().slice(0, 6)}`);
    git('worktree', 'add', '--detach', source, refCommit);
    await symlink(join(repository, 'node_modules'), join(source, 'node_modules'));
    process.env.NOD_EVAL_SOURCE = source;
  } else delete process.env.NOD_EVAL_SOURCE;
  try {
    if (options.canary !== false && selected.some((item) => item.tier !== 'canary'))
      await checkHarness(model, judge);
    const digest = async (image: string) =>
      (await runProcess('docker', ['image', 'inspect', image, '--format', '{{.Id}}'])).stdout
        .trim()
        .slice(0, 19);
    const pkg = JSON.parse(await readFile(join(source, 'package.json'), 'utf8')) as {
      dependencies: Record<string, string>;
    };
    const manifest: RunManifest = {
      label,
      startedAt: new Date().toISOString(),
      commit: refCommit ?? git('rev-parse', 'HEAD'),
      dirty: options.ref ? false : git('status', '--porcelain', '--', 'src', 'evals').length > 0,
      ...(options.ref ? { ref: options.ref } : {}),
      model,
      effort: options.effort ?? 'high',
      judge,
      repeat: options.repeat,
      scenarioIds: selected.map((item) => item.id),
      k,
      provenance: {
        workspaceImage: await digest(environment.NOD_EVAL_WORKSPACE_IMAGE!),
        browserImage: await digest(environment.NOD_EVAL_BROWSER_IMAGE!),
        pi: pkg.dependencies['@earendil-works/pi-coding-agent'] ?? '',
        node: process.version,
      },
    };
    await mkdir(join(directory, 'attempts'), { recursive: true });
    await mkdir(join(directory, 'logs'), { recursive: true });
    await saveRun(directory, manifest, []);

    const tasks = selected.flatMap((item) =>
      Array.from({ length: options.repeat }, (_, index) => ({ item, attempt: index + 1 })),
    );
    const results: AttemptResult[] = [];
    let next = 0;
    let stopped = false;
    const accounting = createSpend();
    const stoppedForBudget = () => {
      if (stopped) return;
      stopped = true;
      console.log(
        accounting.unpriced()
          ? 'Stopped: completed model usage has no valid price. Remaining attempts and retries were not run.'
          : `Stopped: spent $${accounting.knownCostUsd().toFixed(2)} of the $${options.budget} budget. Remaining attempts were not run.`,
      );
    };
    const started = Date.now();
    async function worker() {
      while (next < tasks.length && !stopped) {
        if (options.budget !== undefined && accounting.blocked(options.budget)) {
          stoppedForBudget();
          break;
        }
        const task = tasks[next++];
        const file = join(directory, 'attempts', `${task.item.id}.${task.attempt}.json`);
        const previous = await readFile(file, 'utf8')
          .then((text) => JSON.parse(text) as AttemptResult)
          .catch(() => undefined);
        if (options.resume && previous) accounting.add(previous);
        let result =
          options.resume && previous && previous.status !== 'incomplete' ? previous : undefined;
        if (
          options.resume &&
          previous?.status === 'incomplete' &&
          options.budget !== undefined &&
          accounting.blocked(options.budget)
        ) {
          stoppedForBudget();
          result = previous;
        }
        const discarded: AttemptResult[] =
          options.resume && previous?.status === 'incomplete' && !result ? [previous] : [];
        let attempted = false;
        for (let tries = 0; !result && tries <= options.retries; tries++) {
          if (tries > 0 && accounting.blocked(options.budget)) {
            stoppedForBudget();
            break;
          }
          result = await attemptOnce({
            directory,
            model,
            effort: options.effort ?? 'high',
            judge,
            task,
          });
          attempted = true;
          if (
            result.status === 'incomplete' &&
            result.blame !== 'agent' &&
            tries < options.retries
          ) {
            accounting.add(result);
            if (accounting.blocked(options.budget)) {
              stoppedForBudget();
              break;
            }
            console.log(
              `~ ${task.item.id} #${task.attempt}  incomplete (${result.blame}: ${(result.error ?? '').replace(/\s+/g, ' ').slice(0, 160)}), trying again`,
            );
            discarded.push(result);
            result = undefined;
            await sleep(Math.min(30_000 * 3 ** tries, 90_000));
          } else accounting.add(result);
        }
        if (discarded.length && attempted) {
          result = mergeAttemptCosts([...discarded, ...(result ? [result] : [])]);
          await writeFile(file, JSON.stringify(result, null, 2));
        }
        results.push(result!);
        const mark = result!.status === 'pass' ? '✓' : result!.status === 'fail' ? '✗' : '~';
        const failed = result!.checks
          .filter((check) => !check.pass && check.required)
          .map((check) => check.id);
        console.log(
          `${options.quiet ? `[${label}] ` : ''}${mark} ${task.item.id} #${task.attempt}  ${Math.round(result!.seconds)}s${result!.costUsd === null ? '' : `  $${result!.costUsd.toFixed(2)}`}` +
            (failed.length ? `  failed: ${failed.join(', ')}` : '') +
            (result!.status === 'incomplete'
              ? `  incomplete (${result!.blame}): ${(result!.error ?? '').slice(0, 140)}`
              : ''),
        );
      }
    }
    console.log(
      `Running ${tasks.length} attempts (${selected.length} scenarios × ${options.repeat}) with ${model}, judge ${judge}, concurrency ${options.concurrency}${options.ref ? `, code at ${options.ref}` : ''}`,
    );
    await Promise.all(Array.from({ length: Math.min(options.concurrency, tasks.length) }, worker));
    await pruneAttempts(
      directory,
      tasks.map((task) => `${task.item.id}.${task.attempt}`),
    );
    results.splice(0, results.length, ...(await readAttempts(directory)));

    if (options.diagnose && results.some((item) => item.status === 'fail')) {
      console.log('Diagnosing failures...');
      const outcome = await diagnoseAll(parseModel(judge, environment), results).catch((error) => {
        console.log(`Diagnosis skipped: ${(error as Error).message}`);
        return undefined;
      });
      if (outcome) await saveRun(directory, manifest, results);
    }
    const summary = summarize(manifest, results);
    await saveRun(directory, manifest, [], summary);
    await writeFile(join(directory, 'report.html'), html(summary, results));
    if (!options.quiet) {
      console.log(terminal(summary, results));
      console.log(
        `Saved ${join(directory, 'report.html')} (${Math.round((Date.now() - started) / 60_000)} min)`,
      );
      console.log(`Next: review it as a user would: pnpm run eval:capability review ${label}`);
    }
    return { label, directory, manifest, attempts: results, summary };
  } finally {
    if (options.ref) {
      try {
        execFileSync('git', ['worktree', 'remove', '--force', source], { cwd: repository });
      } catch {}
    }
  }
}
