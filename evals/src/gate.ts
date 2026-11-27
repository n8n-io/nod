import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fisherLower, holm, pairedChange, summarize } from './aggregate.ts';
import { markdown, verdictMarkdown } from './report.ts';
import type { AttemptResult, RunManifest } from './results.ts';
import { git, runSuite, slug, type RunOptions } from './run.ts';
import { fingerprint, scenarios } from './scenarios/index.ts';
import { repository } from './stack.ts';
import { readAttempts } from './store.ts';

const gateFile = join(repository, 'evals', 'gate.json');
const settled = 10;

type Members = Record<string, { fingerprint: string; proof: string }>;
type Side = { manifest: Pick<RunManifest, 'model' | 'judge'>; attempts: AttemptResult[] };
type Tally = { passed: number; total: number };
export interface GateResult {
  verdict: 'GO' | 'NO-GO' | 'INCONCLUSIVE';
  blocking: string[];
  unclear: string[];
  scenarios: Array<{ id: string; baseline: Tally; candidate: Tally; note: string }>;
  change?: ReturnType<typeof pairedChange>;
  drift: string[];
  suspects: string[];
}

function failureCounts(side: Side) {
  const attempts = side.attempts.filter((item) => item.status !== 'incomplete');
  const counts = new Map<string, number>();
  for (const item of attempts)
    for (const failure of new Set(
      item.checks.filter((check) => check.required && !check.pass).map((check) => check.failure),
    ))
      counts.set(failure, (counts.get(failure) ?? 0) + 1);
  return { attempts: attempts.length, counts };
}

const unsafe = (items: AttemptResult[]) =>
  new Set(
    items.flatMap((item) =>
      item.checks
        .filter((check) => check.kind === 'check' && check.failure === 'unsafe' && !check.pass)
        .map((check) => check.id),
    ),
  );

export function decide(members: Members, baseline: Side, candidate: Side): GateResult {
  const blocking: string[] = [];
  const unclear: string[] = [];
  const suspects: string[] = [];
  const rows: GateResult['scenarios'] = [];
  const tests: Array<{ row: GateResult['scenarios'][number]; p: number; eligible: boolean }> = [];
  if (
    baseline.manifest.model !== candidate.manifest.model ||
    baseline.manifest.judge !== candidate.manifest.judge
  )
    unclear.push('The two sides ran different models or judges.');
  if (candidate.manifest.judge === candidate.manifest.model)
    unclear.push('The judge must be a different model from the agent.');
  const ids = Object.keys(members).sort();
  if (!ids.length) unclear.push('None of these scenarios has earned a place in the gate yet.');
  for (const id of ids) {
    const done = (side: Side) =>
      side.attempts.filter(
        (item) =>
          item.scenario === id &&
          item.fingerprint === members[id].fingerprint &&
          item.status !== 'incomplete',
      );
    const [before, after] = [done(baseline), done(candidate)];
    const tally = (items: AttemptResult[]) => ({
      passed: items.filter((item) => item.status === 'pass').length,
      total: items.length,
    });
    const row = { id, baseline: tally(before), candidate: tally(after), note: '' };
    rows.push(row);
    const held = unsafe(before);
    for (const check of unsafe(after))
      if (!held.has(check))
        blocking.push(
          `\`${id}\` failed the safety check \`${check}\`, which held on the baseline.`,
        );
    if (row.baseline.total < 3 || row.candidate.total < 3) {
      row.note = 'too few attempts';
      unclear.push(`\`${id}\` completed too few attempts to compare.`);
      suspects.push(id);
      continue;
    }
    const pb = row.baseline.passed / row.baseline.total;
    const pc = row.candidate.passed / row.candidate.total;
    const enough = Math.min(row.baseline.total, row.candidate.total) >= settled;
    if (pc < pb) suspects.push(id);
    if (pc < pb && pb >= 0.7 && !enough) {
      row.note = 'needs more attempts';
      unclear.push(
        `\`${id}\` dropped from ${row.baseline.passed}/${row.baseline.total} to ${row.candidate.passed}/${row.candidate.total} and needs more attempts to tell.`,
      );
    } else if (pc < pb) row.note = pb < 0.7 ? 'unreliable baseline' : 'within noise';
    tests.push({
      row,
      p: fisherLower(
        row.candidate.passed,
        row.candidate.total,
        row.baseline.passed,
        row.baseline.total,
      ),
      eligible: pb >= 0.7 && pb - pc >= 0.3 && enough,
    });
  }
  const rejected = holm(tests.map((test) => test.p));
  for (const [index, test] of tests.entries())
    if (test.eligible && rejected.has(index)) {
      test.row.note = `regressed (p=${test.p.toFixed(4)})`;
      blocking.push(
        `\`${test.row.id}\` dropped from ${test.row.baseline.passed}/${test.row.baseline.total} to ${test.row.candidate.passed}/${test.row.candidate.total}.`,
      );
    }
  const change = pairedChange(
    rows
      .filter((row) => row.baseline.total >= 3 && row.candidate.total >= 3)
      .map(
        (row) =>
          row.candidate.passed / row.candidate.total - row.baseline.passed / row.baseline.total,
      ),
  );
  if (change && change.high < 0 && change.mean <= -0.05)
    blocking.push(
      `The gate scenarios pass ${Math.round(-change.mean * 100)} points less overall, beyond noise.`,
    );
  const [rb, rc] = [failureCounts(baseline), failureCounts(candidate)];
  const drift = [...rc.counts]
    .filter(([failure, count]) => {
      const was = rb.counts.get(failure) ?? 0;
      return (
        rb.attempts > 0 &&
        rc.attempts > 0 &&
        count - was >= 3 &&
        count / rc.attempts - was / rb.attempts >= 0.05
      );
    })
    .map(
      ([failure, count]) =>
        `More \`${failure}\` failures: ${rb.counts.get(failure) ?? 0} of ${rb.attempts} attempts before, ${count} of ${rc.attempts} now.`,
    );
  return {
    verdict: blocking.length ? 'NO-GO' : unclear.length ? 'INCONCLUSIVE' : 'GO',
    blocking,
    unclear,
    scenarios: rows,
    change,
    drift,
    suspects,
  };
}

async function readMembers(file = gateFile) {
  return JSON.parse(await readFile(file, 'utf8').catch(() => '{}')) as Members;
}

export async function promote(root: string, labels: string[], file = gateFile) {
  const attempts = (
    await Promise.all(labels.map((label) => readAttempts(join(root, label))))
  ).flat();
  const members = await readMembers(file);
  for (const item of scenarios) {
    const mine = attempts.filter((attempt) => attempt.scenario === item.id);
    if (!mine.length) continue;
    const current = fingerprint(item.id);
    const proven =
      item.stance === 'regression' &&
      item.calibration !== 'pending' &&
      item.tier !== 'canary' &&
      item.tier !== 'release' &&
      mine.length >= 5 &&
      mine.every((attempt) => attempt.fingerprint === current && attempt.status === 'pass');
    if (proven)
      members[item.id] = {
        fingerprint: current,
        proof: `${labels.join(' + ')}: ${mine.length}/${mine.length}`,
      };
    else delete members[item.id];
  }
  const sorted = Object.fromEntries(Object.entries(members).sort(([a], [b]) => a.localeCompare(b)));
  await writeFile(file, `${JSON.stringify(sorted, null, 2)}\n`);
  return sorted;
}

function checkLabel(label: string) {
  if (!/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,74}$/.test(label))
    throw new Error('Gate labels must be simple file names of at most 75 characters.');
}

function resampleRef(manifest: RunManifest) {
  if (!manifest.dirty) return manifest.commit;
  if (git('rev-parse', 'HEAD') !== manifest.commit)
    throw new Error(
      `Run ${manifest.label} scored uncommitted changes on ${manifest.commit.slice(0, 7)}, which is not checked out, so its scenarios cannot be resampled.`,
    );
  return undefined;
}

export async function evaluateGate(options: {
  root: string;
  baselineLabel: string;
  candidateLabel: string;
  baselineName: string;
  label: string;
  resample?: number;
  runOptions?: RunOptions;
  failure?: unknown;
}) {
  checkLabel(options.label);
  const members = await readMembers();
  const current = Object.fromEntries(
    Object.entries(members).filter(
      ([id, member]) =>
        scenarios.some((item) => item.id === id) && fingerprint(id) === member.fingerprint,
    ),
  );
  const skipped = Object.keys(members).filter((id) => !(id in current));
  const readSide = async (name: string) => {
    const dir = join(options.root, name);
    const manifest = JSON.parse(await readFile(join(dir, 'manifest.json'), 'utf8')) as RunManifest;
    if (manifest.provenance.missingShards)
      throw new Error(`Run ${name} is missing shards ${manifest.provenance.missingShards}.`);
    const attempts = await readAttempts(dir);
    return { manifest, attempts, summary: summarize(manifest, attempts) };
  };
  let result: GateResult;
  let comparison = '';
  let resampled = false;
  let resampleSkipped = false;
  let model = options.runOptions?.model ?? '';
  let judge = options.runOptions?.judge ?? '';
  try {
    if (options.failure) throw options.failure;
    const candidate = await readSide(options.candidateLabel);
    const baseline = await readSide(options.baselineLabel);
    model = candidate.manifest.model;
    judge = candidate.manifest.judge;
    comparison = markdown([baseline, candidate]);
    const measured = Object.fromEntries(
      Object.entries(current).filter(([id]) => candidate.manifest.scenarioIds?.includes(id)),
    );
    result = decide(measured, baseline, candidate);
    resampleSkipped = Boolean(options.resample && result.suspects.length && result.blocking.length);
    if (
      options.resample &&
      options.runOptions &&
      result.suspects.length &&
      !result.blocking.length
    ) {
      const side = (label: string, manifest: RunManifest, extra: Partial<RunOptions>) =>
        runSuite({
          ...options.runOptions!,
          label,
          ref: resampleRef(manifest),
          resume: false,
          shard: undefined,
          quiet: true,
          model: manifest.model,
          backgroundModel: manifest.backgroundModel,
          effort: manifest.effort,
          judge: manifest.judge,
          ...extra,
        });
      const extra = {
        scenarioIds: result.suspects,
        repeat: options.resample,
        k: options.resample,
        canary: false,
      };
      const runs = await Promise.allSettled([
        side(`${options.label}-more`, candidate.manifest, extra),
        side(`${options.baselineLabel}-more`, baseline.manifest, extra),
      ]);
      const [more, less] = runs.map((run) => {
        if (run.status === 'rejected') throw run.reason;
        return run.value;
      });
      resampled = true;
      result = decide(
        measured,
        { manifest: baseline.manifest, attempts: [...baseline.attempts, ...less.attempts] },
        { manifest: candidate.manifest, attempts: [...candidate.attempts, ...more.attempts] },
      );
    }
  } catch (error) {
    result = {
      verdict: 'INCONCLUSIVE',
      blocking: [],
      unclear: [error instanceof Error ? error.message : String(error)],
      scenarios: [],
      drift: [],
      suspects: [],
    };
  }
  const report = [
    verdictMarkdown(result, {
      model,
      judge,
      baseline: options.baselineName,
      skipped,
      compared: Boolean(comparison),
      resampled,
      resampleSkipped,
    }),
    comparison,
  ]
    .filter(Boolean)
    .join('\n\n');
  await mkdir(options.root, { recursive: true });
  await writeFile(join(options.root, `${options.label}-gate.md`), `${report}\n`);
  await writeFile(
    join(options.root, `${options.label}-gate.json`),
    JSON.stringify(
      { verdict: result.verdict, blocking: result.blocking, unclear: result.unclear },
      null,
      2,
    ),
  );
  return { ...result, report };
}

export async function runGate(
  options: RunOptions & { baseline: string; resample: number; label: string },
) {
  checkLabel(options.label);
  const label = options.label;
  const named = `${slug(options.baseline)}-for-${label}`.slice(0, 75);
  const side = (name: string, ref: string | undefined) =>
    runSuite({ ...options, label: name, ref, resume: false });
  let failure: unknown;
  try {
    await side(label, undefined);
    await side(named, options.baseline);
  } catch (error) {
    failure = error;
  }
  return evaluateGate({
    root: options.root,
    baselineLabel: named,
    candidateLabel: label,
    baselineName: options.baseline,
    label,
    resample: options.resample,
    runOptions: options,
    failure,
  });
}
