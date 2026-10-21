import { spawn, type ChildProcess } from 'node:child_process';
import { createServer } from 'node:http';
import { mkdir, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import {
  loadCases,
  selectCases,
  type BenchCase,
  type BenchRun,
  type CaseIteration,
  type UnitResult,
} from './n8nbench-data.ts';
import { sidecar, type N8nBenchSpec } from './n8nbench-attempt.ts';
import { repository } from './stack.ts';

export interface N8nBenchOptions {
  data: string;
  root: string;
  label: string;
  model: string;
  tier?: string;
  split: 'dev' | 'holdout' | 'all';
  only?: string[];
  sample?: number;
  iterations: number;
  concurrency: number;
  resume: boolean;
  n8nSource: string;
  n8nUrl: string;
  minutes: number;
  verify: boolean;
  budget?: number;
  baseline?: string;
  frame: string;
  beforeVerify?: string;
}

export const infrastructure = (run: BenchRun) =>
  Boolean(run.unavailable) ||
  (Boolean(run.error) && !run.messages.some((message) => message.role === 'assistant'));

const healthy = (url: string) =>
  fetch(new URL('/healthz', url), { signal: AbortSignal.timeout(10_000) }).then(
    (response) => response.ok,
    () => false,
  );

function watchHealth(url: string) {
  const failures: number[] = [];
  let up = true;
  const check = async () => {
    up = await healthy(url);
    if (!up) failures.push(Date.now());
  };
  const timer = setInterval(() => void check(), 15_000);
  return {
    reset: () => {
      failures.length = 0;
      up = false;
    },
    failedSince: (at: number) => failures.some((time) => time >= at),
    async ready() {
      for (const until = Date.now() + 10 * 60_000; Date.now() < until;) {
        if (up && (await healthy(url))) return true;
        await new Promise((done) => setTimeout(done, 15_000));
      }
      return false;
    },
    stop: () => clearInterval(timer),
  };
}

const percent = (part: number, whole: number) =>
  whole ? Math.round((1000 * part) / whole) / 10 : null;

async function startSidecar(options: N8nBenchOptions, directory: string, lane = 0) {
  const child = spawn('pnpm', ['exec', 'tsx', join(repository, 'evals/n8n/sidecar.mjs')], {
    cwd: options.n8nSource,
    env: {
      ...process.env,
      N8N_EVAL_SOURCE: options.n8nSource,
      N8N_BASE_URL: options.n8nUrl,
      N8N_INSTANCE_AI_EVAL_MODEL:
        process.env.N8N_INSTANCE_AI_EVAL_MODEL ?? 'anthropic/claude-sonnet-4-6',
      SIDECAR_PORT: '0',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const log: string[] = [];
  child.stderr.on('data', (chunk) => log.push(String(chunk)));
  const port = await new Promise<number>((resolve, reject) => {
    const timer = setTimeout(
      () => reject(new Error(`The n8n sidecar did not start. ${log.join('').slice(-800)}`)),
      120_000,
    );
    child.stdout.on('data', (chunk) => {
      const match = /SIDECAR_READY (\d+)/.exec(String(chunk));
      if (match) {
        clearTimeout(timer);
        resolve(Number(match[1]));
      }
    });
    child.on('exit', (code) =>
      reject(new Error(`The n8n sidecar exited (${code}). ${log.join('').slice(-800)}`)),
    );
  });
  child.stderr.on('data', (chunk) =>
    writeFile(join(directory, `sidecar-${lane}.log`), log.join('') + String(chunk), {
      flag: 'w',
    }).catch(() => {}),
  );
  return { url: `http://127.0.0.1:${port}`, child };
}

async function attempt(directory: string, spec: N8nBenchSpec, minutes: number) {
  const specPath = join(tmpdir(), `otto-n8nbench-${randomUUID()}.json`);
  await writeFile(specPath, JSON.stringify(spec));
  const child = spawn(
    process.execPath,
    ['--import', 'tsx', join(repository, 'evals/src/n8nbench-attempt.ts'), specPath],
    { cwd: repository, env: process.env, stdio: ['ignore', 'pipe', 'pipe'] },
  );
  let captured = '';
  for (const stream of [child.stdout, child.stderr])
    stream.on('data', (chunk) => (captured = (captured + chunk).slice(-40_000)));
  let grace: NodeJS.Timeout | undefined;
  const timer = setTimeout(
    () => {
      child.kill('SIGTERM');
      grace = setTimeout(() => child.kill('SIGKILL'), 120_000);
    },
    (minutes + 15) * 60_000,
  );
  await new Promise((done) => child.on('close', done));
  clearTimeout(timer);
  clearTimeout(grace);
  const name = `${spec.item.slug}-${spec.iteration}`;
  await writeFile(join(directory, 'logs', `${name}.log`), captured);
  return readFile(spec.outFile, 'utf8')
    .then((text) => JSON.parse(text) as BenchRun)
    .catch((): BenchRun => ({
      slug: spec.item.slug,
      iteration: spec.iteration,
      workflowIds: [],
      messages: [],
      tools: [],
      transcript: [],
      costUsd: 0,
      tokens: 0,
      seconds: 0,
      turns: 0,
      failedTurns: [],
      error: `The attempt process ended without a result. ${captured.slice(-600)}`,
    }));
}

async function serveSuite(dataset: string, slugs: Set<string>) {
  const exported = JSON.parse(await readFile(dataset, 'utf8')) as {
    suite: string;
    files: Record<string, unknown>;
  };
  const files = Object.fromEntries(
    Object.entries(exported.files).filter(([file]) => slugs.has(file.replace(/\.json$/, ''))),
  );
  const server = createServer((request, response) => {
    const body =
      request.url === '/api/v1/suites'
        ? [{ id: 8, slug: exported.suite, name: exported.suite }]
        : request.url === '/api/v1/suites/8/export'
          ? { suite: exported.suite, count: Object.keys(files).length, files }
          : undefined;
    if (!body) response.writeHead(404).end();
    else
      response
        .writeHead(200, { 'content-type': 'application/json' })
        .end(JSON.stringify({ data: body }));
  });
  await new Promise<void>((done) => server.listen(0, '127.0.0.1', done));
  return {
    url: `http://127.0.0.1:${(server.address() as { port: number }).port}`,
    close: () => server.close(),
  };
}

interface VerifiedCase {
  testCaseFile?: string;
  scenarios: Array<{
    name: string;
    runs: Array<{
      passed: boolean;
      incomplete?: boolean;
      reasoning?: string;
      workflowId?: string | null;
    }>;
  }>;
}

async function verifiedIn(out: string) {
  const report = JSON.parse(
    await readFile(join(out, 'eval-results.json'), 'utf8').catch(() => '{"testCases":[]}'),
  ) as { testCases: VerifiedCase[] };
  return report.testCases.flatMap((item) =>
    item.testCaseFile ? [[item.testCaseFile.replace(/\.json$/, ''), item] as const] : [],
  );
}

async function verifyIteration(
  options: N8nBenchOptions,
  directory: string,
  iteration: number,
  runs: BenchRun[],
  cases: Map<string, BenchCase>,
) {
  const root = join(directory, 'verify');
  const results = new Map<string, VerifiedCase>();
  for (const name of (await readdir(root).catch(() => [] as string[])).sort())
    if (name === `iteration-${iteration}` || name.startsWith(`iteration-${iteration}-`))
      for (const [slug, item] of await verifiedIn(join(root, name))) results.set(slug, item);
  const workflowOf = (item: VerifiedCase) => item.scenarios[0]?.runs[0]?.workflowId;
  const missing = runs.filter(
    (run) =>
      run.workflowId &&
      cases.get(run.slug)?.definition.executionScenarios.length &&
      workflowOf(results.get(run.slug) ?? { scenarios: [] }) !== run.workflowId,
  );
  if (!missing.length) return results;
  const manifest = Object.fromEntries(missing.map((run) => [run.slug, [run.workflowId!]]));
  const out = join(root, `iteration-${iteration}-${Date.now()}`);
  await mkdir(out, { recursive: true });
  const manifestPath = join(out, 'manifest.json');
  await writeFile(manifestPath, JSON.stringify(manifest, null, 2));
  const suite = await serveSuite(
    join(options.data, 'dataset.json'),
    new Set(Object.keys(manifest)),
  );
  const { LANGSMITH_API_KEY: _key, ...environment } = process.env;
  const child: ChildProcess = spawn(
    'pnpm',
    [
      'eval:instance-ai',
      '--base-url',
      options.n8nUrl,
      '--source',
      'langtracer',
      '--suite',
      'baseline',
      '--prebuilt-workflows',
      manifestPath,
      '--iterations',
      '1',
      '--concurrency',
      String(Math.max(1, Math.min(options.concurrency, 6))),
      '--timeout-ms',
      '1500000',
      '--output-dir',
      out,
    ],
    {
      cwd: options.n8nSource,
      env: { ...environment, LANGTRACER_URL: suite.url, LANGTRACER_API_KEY: 'lt_local' },
      stdio: ['ignore', 'pipe', 'pipe'],
    },
  );
  let captured = '';
  for (const stream of [child.stdout!, child.stderr!])
    stream.on('data', (chunk) => (captured = (captured + chunk).slice(-200_000)));
  await new Promise((done) => child.on('close', done));
  suite.close();
  await writeFile(join(out, 'verifier.log'), captured);
  for (const [slug, item] of await verifiedIn(out)) results.set(slug, item);
  return results;
}

async function artifactsOf(sidecarUrl: string, run: BenchRun) {
  if (run.projectId || !run.userId) return run;
  const built = await sidecar<{ projectId: string; agents: Array<{ id: string; name?: string }> }>(
    sidecarUrl,
    '/artifacts',
    { userId: run.userId },
  ).catch(() => undefined);
  return built ? { ...run, projectId: built.projectId, agents: built.agents } : run;
}

async function judgeExpectations(
  sidecarUrl: string,
  item: BenchCase,
  run: BenchRun,
  directory: string,
): Promise<UnitResult[]> {
  const kinds = new Map<string, 'outcome' | 'process'>([
    ...(item.definition.outcomeExpectations ?? []).map((name) => [name, 'outcome'] as const),
    ...(item.definition.processExpectations ?? []).map((name) => [name, 'process'] as const),
  ]);
  if (!kinds.size) return [];
  const file = join(directory, 'expectations', `${run.slug}-${run.iteration}.json`);
  const saved = await readFile(file, 'utf8')
    .then((text) => JSON.parse(text) as UnitResult[])
    .catch(() => undefined);
  if (saved) return saved;
  const built = await artifactsOf(sidecarUrl, run);
  const expectations = [...kinds.keys()];
  const verdicts = await sidecar<
    Array<{ expectation: string; pass: boolean; reason: string; incomplete?: boolean }>
  >(sidecarUrl, '/judge', {
    expectations,
    transcript: run.transcript,
    ...(run.workflowId ? { workflowId: run.workflowId } : {}),
    ...(built.projectId ? { projectId: built.projectId, agents: built.agents ?? [] } : {}),
  }).catch((error: Error) =>
    expectations.map((expectation) => ({
      expectation,
      pass: false,
      reason: error.message,
      incomplete: true,
    })),
  );
  const units = verdicts.map((verdict) => ({
    kind: kinds.get(verdict.expectation) ?? ('outcome' as const),
    name: verdict.expectation,
    pass: verdict.pass,
    reason: verdict.reason,
    ...(verdict.incomplete ? { incomplete: true } : {}),
  }));
  if (units.some((unit) => unit.incomplete)) return units;
  await mkdir(join(directory, 'expectations'), { recursive: true });
  await writeFile(file, JSON.stringify(units, null, 2));
  return units;
}

function grade(
  item: BenchCase,
  run: BenchRun,
  verifiedCase: VerifiedCase | undefined,
  expectations: UnitResult[],
): CaseIteration {
  const agentOnly = !run.workflowId && Boolean(run.agents?.length);
  const scenarios = item.definition.executionScenarios.map((scenario): UnitResult => {
    if (agentOnly)
      return {
        kind: 'scenario',
        name: scenario.name,
        pass: false,
        reason: 'Agent scenarios are not run by the prebuilt verifier.',
        incomplete: true,
      };
    const result = verifiedCase?.scenarios.find((item) => item.name === scenario.name)?.runs[0];
    return {
      kind: 'scenario',
      name: scenario.name,
      pass: Boolean(result?.passed),
      reason: result?.reasoning ?? (run.workflowId ? 'Not verified.' : 'No workflow was built.'),
      ...(result?.incomplete ? { incomplete: true } : {}),
    };
  });
  return {
    slug: item.slug,
    iteration: run.iteration,
    built: Boolean(run.workflowId || run.agents?.length),
    units: [...scenarios, ...expectations],
    costUsd: run.costUsd,
    seconds: run.seconds,
  };
}

export function summarize(
  graded: CaseIteration[],
  cases: BenchCase[],
  baseline?: Map<string, { pass: boolean | null; tries?: { passed: number; total: number } }>,
) {
  const bySlug = new Map<string, CaseIteration[]>();
  for (const item of graded) bySlug.set(item.slug, [...(bySlug.get(item.slug) ?? []), item]);
  const scored = (unit: UnitResult) => !unit.incomplete;
  let triesPassed = 0;
  let triesTotal = 0;
  let casesPassed = 0;
  let casesScored = 0;
  const perCase: Record<string, unknown> = {};
  for (const [slug, iterations] of bySlug) {
    const units = iterations.flatMap((iteration) => iteration.units.filter(scored));
    triesPassed += units.filter((unit) => unit.pass).length;
    triesTotal += units.length;
    const names = [...new Set(units.map((unit) => `${unit.kind}:${unit.name}`))];
    const unitPass = names.map((name) =>
      units.some((unit) => `${unit.kind}:${unit.name}` === name && unit.pass),
    );
    const pass = names.length > 0 && unitPass.every(Boolean);
    if (names.length) {
      casesScored++;
      if (pass) casesPassed++;
    }
    perCase[slug] = {
      pass,
      unitsPassed: unitPass.filter(Boolean).length,
      units: names.length,
      tries: { passed: units.filter((unit) => unit.pass).length, total: units.length },
      built: iterations.filter((iteration) => iteration.built).length,
      iterations: iterations.length,
      baseline: baseline?.get(slug) ?? null,
    };
  }
  const slugs = [...bySlug.keys()];
  const compared = baseline ? slugs.filter((slug) => baseline.get(slug)?.tries) : [];
  const baselineTries = compared.reduce(
    (sum, slug) => {
      const tries = baseline!.get(slug)!.tries!;
      return { passed: sum.passed + tries.passed, total: sum.total + tries.total };
    },
    { passed: 0, total: 0 },
  );
  const kinds = new Map(cases.map((item) => [item.slug, item.setKind]));
  return {
    cases: slugs.length,
    iterations: graded.length,
    built: graded.filter((item) => item.built).length,
    perTryUnitPass: percent(triesPassed, triesTotal),
    tries: { passed: triesPassed, total: triesTotal },
    casePass: percent(casesPassed, casesScored),
    casesPassed,
    casesScored,
    costUsd: Math.round(graded.reduce((sum, item) => sum + item.costUsd, 0) * 100) / 100,
    meanSeconds: graded.length
      ? Math.round(graded.reduce((sum, item) => sum + item.seconds, 0) / graded.length)
      : null,
    baseline: baseline
      ? {
          cases: compared.length,
          perTryUnitPass: percent(baselineTries.passed, baselineTries.total),
          casesPassed: compared.filter((slug) => baseline.get(slug)!.pass).length,
          ottoCasesPassedOnSame: compared.filter(
            (slug) => (perCase[slug] as { pass: boolean }).pass,
          ).length,
        }
      : null,
    byKind: Object.fromEntries(
      ['regression', 'capability_gap'].map((kind) => {
        const own = slugs.filter((slug) => kinds.get(slug) === kind);
        return [
          kind,
          {
            cases: own.length,
            passed: own.filter((slug) => (perCase[slug] as { pass: boolean }).pass).length,
          },
        ];
      }),
    ),
    perCase,
  };
}

async function loadBaseline(path: string | undefined) {
  if (!path) return undefined;
  const raw = JSON.parse(await readFile(path, 'utf8')) as {
    data?: {
      units: Array<{
        caseName: string;
        pass: boolean | null;
        tries?: { passed: number; total: number };
      }>;
    };
  };
  return new Map(
    (raw.data?.units ?? []).map((unit) => [unit.caseName, { pass: unit.pass, tries: unit.tries }]),
  );
}

export async function runN8nBench(options: N8nBenchOptions) {
  const directory = join(options.root, options.label);
  for (const sub of ['raw', 'logs', 'verify', 'expectations'])
    await mkdir(join(directory, sub), { recursive: true });
  const cases = selectCases(await loadCases(options.data), options);
  if (!cases.length) throw new Error('No n8n cases match the selection.');
  await writeFile(
    join(directory, 'manifest.json'),
    JSON.stringify(
      { ...options, cases: cases.map((item) => item.slug), startedAt: new Date().toISOString() },
      null,
      2,
    ),
  );
  const lanes = await Promise.all(
    options.n8nUrl
      .split(',')
      .map((url) => url.trim())
      .filter(Boolean)
      .map(async (url, index) => ({
        url,
        side: await startSidecar({ ...options, n8nUrl: url }, directory, index),
        health: watchHealth(url),
      })),
  );
  const laneOf = (run: BenchRun) => lanes.find((lane) => lane.url === run.n8nUrl) ?? lanes[0];
  try {
    const jobs = cases.flatMap((item) =>
      Array.from({ length: options.iterations }, (_, iteration) => ({ item, iteration })),
    );
    const runs: BenchRun[] = [];
    let spent = 0;
    let next = 0;
    const worker = async (slot: number) => {
      const lane = lanes[slot % lanes.length];
      for (;;) {
        const job = jobs[next++];
        if (!job) return;
        const outFile = join(directory, 'raw', `${job.item.slug}-${job.iteration}.json`);
        const existing = options.resume
          ? await readFile(outFile, 'utf8')
              .then((text) => JSON.parse(text) as BenchRun)
              .catch(() => undefined)
          : undefined;
        if (existing && !infrastructure(existing)) {
          runs.push(existing);
          spent += existing.costUsd;
          continue;
        }
        if (options.budget !== undefined && spent >= options.budget) {
          console.log(`Budget of $${options.budget} reached; skipping ${job.item.slug}.`);
          continue;
        }
        if (!(await lane.health.ready())) {
          console.log(`n8n at ${lane.url} stayed unavailable; stopping before ${job.item.slug}.`);
          next = jobs.length;
          return;
        }
        const startedAt = Date.now();
        const run = await attempt(
          directory,
          {
            item: job.item,
            iteration: job.iteration,
            model: options.model,
            outFile,
            sidecar: lane.side.url,
            n8nUrl: lane.url,
            minutes: options.minutes,
            frame: options.frame,
          },
          options.minutes,
        );
        run.n8nUrl = lane.url;
        if (lane.health.failedSince(startedAt)) {
          run.unavailable = 'n8n was unavailable during the attempt.';
          await writeFile(outFile, JSON.stringify(run, null, 2));
          console.log(`${job.item.slug}#${job.iteration} discarded: n8n was unavailable.`);
          continue;
        }
        if (!existsSync(outFile)) await writeFile(outFile, JSON.stringify(run, null, 2));
        runs.push(run);
        spent += run.costUsd;
        console.log(
          `${job.item.slug}#${job.iteration} ${run.workflowId ? 'built' : 'no workflow'} $${run.costUsd.toFixed(2)} ${run.seconds}s${run.error ? ` error: ${run.error.slice(0, 160)}` : ''} (total $${spent.toFixed(2)})`,
        );
      }
    };
    await Promise.all(Array.from({ length: options.concurrency }, (_, slot) => worker(slot)));
    if (!options.verify) return { runs: runs.length, spent };
    if (options.beforeVerify) {
      const hook = spawn('sh', ['-c', options.beforeVerify], { stdio: 'inherit' });
      const code = await new Promise((done) => hook.on('close', done));
      if (code !== 0) throw new Error(`The before-verify command failed (${code}).`);
      for (const lane of lanes) lane.health.reset();
    }
    for (const lane of lanes)
      if (!(await lane.health.ready()))
        throw new Error(`n8n at ${lane.url} is unavailable, so the runs cannot be verified.`);
    const verifyStarted = Date.now();
    const graded: CaseIteration[] = [];
    const lookup = new Map(cases.map((item) => [item.slug, item]));
    for (let iteration = 0; iteration < options.iterations; iteration++) {
      const these = runs.filter((run) => run.iteration === iteration);
      const verifiedCases = new Map<string, VerifiedCase>();
      for (const lane of lanes)
        for (const [slug, item] of await verifyIteration(
          { ...options, n8nUrl: lane.url },
          directory,
          iteration,
          these.filter((run) => laneOf(run) === lane),
          lookup,
        ))
          verifiedCases.set(slug, item);
      for (const run of these) {
        if (infrastructure(run)) continue;
        const item = lookup.get(run.slug)!;
        const expectations = await judgeExpectations(laneOf(run).side.url, item, run, directory);
        graded.push(grade(item, run, verifiedCases.get(run.slug), expectations));
      }
    }
    if (lanes.some((lane) => lane.health.failedSince(verifyStarted))) {
      for (const name of await readdir(join(directory, 'verify')))
        if (Number(name.split('-').at(-1)) >= verifyStarted)
          await rm(join(directory, 'verify', name), { recursive: true, force: true });
      throw new Error(
        'n8n was unavailable during verification. Restart it and resume to verify again.',
      );
    }
    await writeFile(join(directory, 'graded.json'), JSON.stringify(graded, null, 2));
    const incomplete = runs
      .filter(infrastructure)
      .map((run) => `${run.slug}#${run.iteration}: ${run.error?.slice(0, 200)}`);
    if (incomplete.length)
      console.log(`Incomplete (infrastructure) runs, excluded:\n${incomplete.join('\n')}`);
    const summary = summarize(graded, cases, await loadBaseline(options.baseline));
    await writeFile(join(directory, 'summary.json'), JSON.stringify(summary, null, 2));
    const { perCase: _cases, ...headline } = summary;
    console.log(JSON.stringify(headline, null, 2));
    return summary;
  } finally {
    for (const lane of lanes) {
      lane.health.stop();
      lane.side.child.kill('SIGTERM');
    }
  }
}
