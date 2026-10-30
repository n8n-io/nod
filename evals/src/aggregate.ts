import type { Capability } from './scenario.ts';
import type {
  AttemptResult,
  Efficiency,
  Rates,
  RunManifest,
  RunSummary,
  ScenarioSummary,
  Trust,
  WentWrong,
} from './results.ts';

function choose(n: number, k: number) {
  if (k < 0 || k > n) return 0;
  let value = 1;
  for (let i = 1; i <= k; i++) value = (value * (n - k + i)) / i;
  return value;
}

export function passAtK(n: number, c: number, k: number) {
  if (n < k) return null;
  return 1 - choose(n - c, k) / choose(n, k);
}

export function passPowK(n: number, c: number, k: number) {
  if (n < k) return null;
  return choose(c, k) / choose(n, k);
}

function wilson(passed: number, total: number, z = 1.96) {
  if (!total) return null;
  const p = passed / total;
  const denominator = 1 + (z * z) / total;
  const center = (p + (z * z) / (2 * total)) / denominator;
  const margin =
    (z * Math.sqrt((p * (1 - p)) / total + (z * z) / (4 * total * total))) / denominator;
  return { low: Math.max(0, center - margin), high: Math.min(1, center + margin) };
}

export function fisherLower(
  passedAfter: number,
  after: number,
  passedBefore: number,
  before: number,
) {
  const successes = passedAfter + passedBefore;
  const total = after + before;
  let sum = 0;
  for (let i = Math.max(0, after - (total - successes)); i <= passedAfter; i++)
    sum += choose(successes, i) * choose(total - successes, after - i);
  return sum / choose(total, after);
}

export function holm(pValues: number[], alpha = 0.05) {
  const order = pValues.map((p, index) => ({ p, index })).sort((a, b) => a.p - b.p);
  const rejected = new Set<number>();
  for (const [rank, item] of order.entries()) {
    if (item.p >= alpha / (order.length - rank)) break;
    rejected.add(item.index);
  }
  return rejected;
}

const studentT = [
  12.7062, 4.3027, 3.1824, 2.7764, 2.5706, 2.4469, 2.3646, 2.306, 2.2622, 2.2281, 2.201, 2.1788,
  2.1604, 2.1448, 2.1314, 2.1199, 2.1098, 2.1009, 2.093, 2.086, 2.0796, 2.0739, 2.0687, 2.0639,
  2.0595, 2.0555, 2.0518, 2.0484, 2.0452, 2.0423,
];

export function pairedChange(differences: number[]) {
  const n = differences.length;
  if (n < 5) return undefined;
  const mean = differences.reduce((sum, value) => sum + value, 0) / n;
  const sd = Math.sqrt(differences.reduce((sum, value) => sum + (value - mean) ** 2, 0) / (n - 1));
  const df = n - 1;
  const z = 1.959964;
  const t =
    studentT[df - 1] ??
    z + (z ** 3 + z) / (4 * df) + (5 * z ** 5 + 16 * z ** 3 + 3 * z) / (96 * df * df);
  const half = (t * sd) / Math.sqrt(n);
  return { n, mean, low: Math.max(-1, mean - half), high: Math.min(1, mean + half) };
}

export function band(passAt1: number | null, attempts: number) {
  if (passAt1 === null || attempts < 3) return null;
  return passAt1 >= 0.95 ? 'anchor' : passAt1 === 0 ? 'frontier' : 'discriminator';
}

function percentile(values: number[], fraction: number) {
  if (!values.length) return null;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.ceil(fraction * sorted.length) - 1)];
}

const mean = (values: Array<number | null>) => {
  const known = values.filter((value): value is number => value !== null);
  return known.length ? known.reduce((total, value) => total + value, 0) / known.length : null;
};

const sum = (values: Array<number | null>) =>
  !values.length || values.some((value) => value === null || !Number.isFinite(value))
    ? null
    : values.reduce<number>((total, value) => total + value!, 0);

const completedTask = (item: AttemptResult) =>
  item.status === 'pass' ||
  (item.status === 'fail' &&
    !item.error &&
    item.checks.every((check) => check.pass || !check.required || check.group === 'product'));

const fullyTrusted = (item: AttemptResult) => item.status === 'pass';

function scenarioSummary(
  k: number,
  items: AttemptResult[],
  succeeded: (item: AttemptResult) => boolean = completedTask,
): ScenarioSummary {
  const completed = items.filter((item) => item.status !== 'incomplete');
  const passed = completed.filter(succeeded).length;
  return {
    scenario: items[0].scenario,
    title: items[0].title,
    capabilities: items[0].capabilities,
    stance: items[0].stance,
    fingerprint: items[0].fingerprint,
    attempts: completed.length,
    passed,
    incomplete: items.length - completed.length,
    unitPass: mean(
      completed.map((item) => {
        const required = item.checks.filter((check) => check.required);
        return required.length
          ? required.filter((check) => check.pass).length / required.length
          : null;
      }),
    ),
    passAt1: completed.length ? passed / completed.length : null,
    passAtK: passAtK(completed.length, passed, k),
    passPowK: passPowK(completed.length, passed, k),
    seconds: items.reduce((total, item) => total + item.seconds, 0),
    medianSeconds: percentile(
      completed.map((item) => item.seconds),
      0.5,
    ),
    costUsd: sum(items.map((item) => item.costUsd)),
  };
}

function scenarioSummaries(
  k: number,
  attempts: AttemptResult[],
  succeeded: (item: AttemptResult) => boolean,
) {
  const grouped = new Map<string, AttemptResult[]>();
  for (const attempt of attempts)
    grouped.set(attempt.scenario, [...(grouped.get(attempt.scenario) ?? []), attempt]);
  return [...grouped.values()].map((items) => scenarioSummary(k, items, succeeded));
}

export const requiredScenarios = (k: number, attempts: AttemptResult[]) =>
  scenarioSummaries(k, attempts, fullyTrusted);

export function costPerRequiredPass(attempts: AttemptResult[]) {
  const regression = attempts.filter((item) => item.stance === 'regression');
  const cost = sum(regression.map((item) => item.costUsd));
  const passed = regression.filter(fullyTrusted).length;
  return cost !== null && passed ? cost / passed : null;
}

function efficiency(attempts: AttemptResult[]): Efficiency {
  const done = attempts.filter((item) => item.status !== 'incomplete');
  const passed = done.filter(completedTask).length;
  const cost = sum(attempts.map((item) => item.costUsd));
  const toolCalls = done.reduce((total, item) => total + item.toolCalls, 0);
  return {
    seconds: {
      p50: percentile(
        done.map((item) => item.seconds),
        0.5,
      ),
      p90: percentile(
        done.map((item) => item.seconds),
        0.9,
      ),
    },
    firstReplySeconds: {
      p50: percentile(
        done.flatMap((item) => (item.firstReplySeconds === null ? [] : [item.firstReplySeconds])),
        0.5,
      ),
      p90: percentile(
        done.flatMap((item) => (item.firstReplySeconds === null ? [] : [item.firstReplySeconds])),
        0.9,
      ),
    },
    costPerAttempt: cost !== null && attempts.length ? cost / attempts.length : null,
    costPerPass: cost !== null && passed ? cost / passed : null,
    tokensPerAttempt: done.length
      ? done.reduce((total, item) => total + item.tokens, 0) / done.length
      : null,
    toolCallsPerAttempt: done.length ? toolCalls / done.length : null,
    toolErrorRate: toolCalls
      ? done.reduce((total, item) => total + item.toolErrors, 0) / toolCalls
      : null,
    judgeCostUsd: sum(attempts.map((item) => item.judgeCostUsd)),
  };
}

function trust(attempts: AttemptResult[]): Trust {
  const done = attempts.filter(
    (item) => item.status !== 'incomplete' && item.stance === 'regression',
  );
  const ids = [
    ...new Set(
      done.flatMap((item) =>
        item.checks.filter((check) => check.group === 'product').map((check) => check.id),
      ),
    ),
  ];
  const failedWith = (item: AttemptResult, failure: string) =>
    item.checks.some((check) => !check.pass && check.required && check.failure === failure);
  return {
    lines: ids.map((id) => {
      const rows = done.flatMap((item) =>
        item.checks.filter((check) => check.group === 'product' && check.id === id && !check.na),
      );
      return {
        id,
        applicable: rows.length,
        rate: rows.length ? rows.filter((check) => check.pass).length / rows.length : null,
      };
    }),
    trustedRate: done.length
      ? done.filter(
          (item) =>
            !item.checks.some(
              (check) => check.group === 'product' && check.required && !check.pass,
            ),
        ).length / done.length
      : null,
    safetyIncidents: done.filter((item) => failedWith(item, 'unsafe')).length,
    scopeIncidents: done.filter((item) => failedWith(item, 'scope')).length,
  };
}

function wentWrong(attempts: AttemptResult[]): WentWrong {
  const failed = attempts.filter((item) => item.status === 'fail');
  const groups = new Map<string, WentWrong['groups'][number]>();
  for (const item of failed) {
    const diagnosis = item.diagnosis;
    if (!diagnosis) continue;
    const key = `${item.scenario}|${diagnosis.category}|${diagnosis.blame}`;
    const existing = groups.get(key);
    if (existing) existing.count++;
    else
      groups.set(key, {
        scenario: item.scenario,
        category: diagnosis.category,
        blame: diagnosis.blame,
        count: 1,
        rootCause: diagnosis.rootCause,
        fix: diagnosis.fix,
      });
  }
  return {
    groups: [...groups.values()].sort((a, b) => b.count - a.count),
    suspectEval: failed
      .filter((item) => item.diagnosis && item.diagnosis.blame !== 'agent')
      .map((item) => ({
        scenario: item.scenario,
        attempt: item.attempt,
        blame: item.diagnosis!.blame,
        rootCause: item.diagnosis!.rootCause,
      })),
    undiagnosed: failed.filter((item) => !item.diagnosis).length,
  };
}

function rates(summaries: ScenarioSummary[]): Rates {
  const total = summaries.reduce((count, item) => count + item.attempts, 0);
  const passed = summaries.reduce((count, item) => count + item.passed, 0);
  return {
    passed,
    total,
    incomplete: summaries.reduce((count, item) => count + item.incomplete, 0),
    percent: total ? passed / total : null,
    interval: wilson(passed, total),
    unitPass: mean(summaries.map((item) => item.unitPass)),
    passAt1: mean(summaries.map((item) => item.passAt1)),
    passAtK: mean(summaries.map((item) => item.passAtK)),
    passPowK: mean(summaries.map((item) => item.passPowK)),
  };
}

export function summarize(manifest: RunManifest, attempts: AttemptResult[]): RunSummary {
  const planned = manifest.scenarioIds?.flatMap((id) =>
    Array.from({ length: manifest.repeat }, (_, index) => `${id}.${index + 1}`),
  );
  const recorded = new Map(
    attempts.map((item) => [`${item.scenario}.${item.attempt}`, item.status]),
  );
  const slots = planned ?? [...recorded.keys()];
  const scenarios = scenarioSummaries(manifest.k, attempts, completedTask);
  const regression = scenarios.filter((item) => item.stance === 'regression');
  const combined = requiredScenarios(manifest.k, attempts).filter(
    (item) => item.stance === 'regression',
  );
  const names = [...new Set(scenarios.flatMap((item) => item.capabilities))] as Capability[];
  const failing = attempts
    .filter((item) => item.status === 'fail')
    .flatMap((item) => item.checks.filter((check) => !check.pass && check.required));
  const counts = new Map<string, number>();
  for (const check of failing) counts.set(check.failure, (counts.get(check.failure) ?? 0) + 1);
  const infra = attempts.filter((item) => item.status === 'incomplete' && item.blame === 'infra');
  return {
    manifest,
    coverage: {
      expected: planned?.length ?? null,
      completed: slots.filter((id) => recorded.has(id) && recorded.get(id) !== 'incomplete').length,
      incomplete: slots.filter((id) => recorded.get(id) === 'incomplete').length,
      missing: slots.filter((id) => !recorded.has(id)),
    },
    regression: rates(regression),
    combined: rates(combined),
    gap: rates(scenarios.filter((item) => item.stance === 'gap')),
    contaminated: attempts.length >= 3 && infra.length / attempts.length >= 0.3,
    efficiency: efficiency(attempts),
    trust: trust(attempts),
    wentWrong: wentWrong(attempts),
    scenarios,
    capabilities: names.map((capability) => {
      const matching = regression.filter((item) => item.capabilities.includes(capability));
      return {
        capability,
        passAt1: mean(matching.map((item) => item.passAt1)),
        scenarios: matching.length,
      };
    }),
    failures: [...counts.entries()]
      .map(([failure, count]) => ({ failure: failure as never, count }))
      .sort((a, b) => b.count - a.count),
    seconds: attempts.reduce((total, item) => total + item.seconds, 0),
    costUsd: sum(attempts.map((item) => item.costUsd)),
  };
}
