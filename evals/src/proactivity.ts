import type { AttemptResult } from './results.ts';

interface PopulationMetrics {
  cohort: number;
  arm: 'engine' | 'baseline';
  records: number;
  readRecords: number;
  expected: number;
  found: number;
  criticalMissed: boolean;
  prepared: number;
  falsePrepared: number;
  notified: number;
  relevantNotified: number;
  unwanted: number;
  duplicateNudges: number;
}

export function summarizePopulation(attempts: AttemptResult[]) {
  const rows = attempts
    .filter((a) => a.scenario.startsWith('proactivity-population-'))
    .map((a) => {
      const check = a.checks.find((c) => c.id === 'population-metrics');
      let metrics: PopulationMetrics | null = null;
      try {
        if (check?.evidence) metrics = JSON.parse(check.evidence) as PopulationMetrics;
      } catch {}
      return {
        scenario: a.scenario,
        attempt: a.attempt,
        status: a.status,
        metrics,
        costUsd: a.costUsd,
        judgeCostUsd: a.judgeCostUsd,
        seconds: a.seconds,
        grounded: a.checks.find((c) => c.id === 'complete-grounded-work')?.pass ?? null,
      };
    });
  const cohortOf = (r: { scenario: string; metrics?: PopulationMetrics | null }) =>
    r.metrics?.cohort ?? Number(/population-(\d+)-/.exec(r.scenario)?.[1] ?? 0);
  const arms = (['engine', 'baseline'] as const).map((arm) => {
    const all = rows.filter((r) => r.scenario.endsWith(`-${arm}`));
    const measured = all.flatMap((r) => (r.metrics ? [r.metrics] : []));
    const sum = (key: keyof PopulationMetrics) => measured.reduce((n, m) => n + Number(m[key]), 0);
    const ratio = (a: number, b: number) => (b ? a / b : null);
    const durations = all
      .filter((r) => r.status !== 'incomplete')
      .map((r) => r.seconds)
      .sort((a, b) => a - b);
    return {
      arm,
      attempts: all.length,
      measured: measured.length,
      incomplete: all.filter((r) => r.status === 'incomplete').length,
      passed: all.filter((r) => r.status === 'pass').length,
      expected: sum('expected'),
      found: sum('found'),
      recall: ratio(sum('found'), sum('expected')),
      prepared: sum('prepared'),
      falsePrepared: sum('falsePrepared'),
      precision: ratio(sum('prepared') - sum('falsePrepared'), sum('prepared')),
      criticalMissed: sum('criticalMissed'),
      notifications: sum('notified'),
      relevantNotified: sum('relevantNotified'),
      unwanted: sum('unwanted'),
      duplicates: sum('duplicateNudges'),
      groundedAttempts: all.filter((r) => r.grounded === true).length,
      costUsd: all.some((r) => r.costUsd === null)
        ? null
        : all.reduce((n, r) => n + (r.costUsd ?? 0), 0),
      judgeCostUsd: all.some((r) => r.judgeCostUsd === null)
        ? null
        : all.reduce((n, r) => n + (r.judgeCostUsd ?? 0), 0),
      medianSeconds: durations.length
        ? (durations[Math.floor((durations.length - 1) / 2)] +
            durations[Math.floor(durations.length / 2)]) /
          2
        : null,
      populations: [...new Set(all.map(cohortOf))].map((cohort) => {
        const cluster = all.filter((r) => cohortOf(r) === cohort);
        return {
          cohort,
          attempts: cluster.length,
          passed: cluster.filter((r) => r.status === 'pass').length,
          allPassed: cluster.every((r) => r.status === 'pass'),
        };
      }),
    };
  });
  return {
    claim:
      'Controlled fixture evidence only. Four source populations and repeated model runs do not establish product superiority or human value.',
    arms,
    rows,
  };
}
