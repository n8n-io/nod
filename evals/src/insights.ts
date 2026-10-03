import { displayName } from './names.ts';
import type { AttemptResult, RunSummary } from './results.ts';

export interface ChartRun {
  summary: RunSummary;
  attempts: AttemptResult[];
}

export const label = (run: ChartRun, all: ChartRun[]) => {
  const models = all.map((item) => displayName(item.summary.manifest.model));
  const refs = all.map((item) => item.summary.manifest.ref ?? '');
  return new Set(models).size === all.length
    ? displayName(run.summary.manifest.model)
    : refs.every(Boolean) && new Set(refs).size === all.length
      ? run.summary.manifest.ref!
      : run.summary.manifest.label;
};

const rate = (run: ChartRun) => run.summary.regression.percent;
const costPerPass = (run: ChartRun) => run.summary.efficiency.costPerPass;
const median = (run: ChartRun) => run.summary.efficiency.seconds.p50;

function pick(runs: ChartRun[], score: (run: ChartRun) => number | null, direction: 'max' | 'min') {
  const scored = runs.flatMap((run) => {
    const value = score(run);
    return value === null ? [] : [{ run, value }];
  });
  if (!scored.length) return undefined;
  return scored.sort((a, b) => (direction === 'max' ? b.value - a.value : a.value - b.value))[0];
}

const attempted = (run: ChartRun) =>
  run.summary.regression.total + run.summary.regression.incomplete;

export function insights(runs: ChartRun[]) {
  const usable = runs.filter(
    (run) =>
      rate(run) !== null &&
      !run.summary.contaminated &&
      run.summary.regression.incomplete <= attempted(run) * 0.2,
  );
  const widest = Math.max(0, ...usable.map(attempted));
  const done = usable.filter((run) => attempted(run) >= widest * 0.9);
  const best = pick(done, rate, 'max');
  const contenders = best
    ? done.filter((run) => (rate(run) ?? 0) >= (rate(best.run) ?? 0) - 0.08)
    : [];
  const value = pick(contenders, costPerPass, 'min');
  const cheapest = pick(done, costPerPass, 'min');
  const fastest = pick(done, median, 'min');
  const reliable = pick(done, (run) => run.summary.regression.passPowK, 'max');
  const clean = done.filter((run) => run.summary.trust.safetyIncidents === 0);
  const badges = new Map<ChartRun, string[]>();
  const give = (run: ChartRun | undefined, text: string) =>
    run && badges.set(run, [...(badges.get(run) ?? []), text]);
  give(best?.run, 'Best overall');
  give(value?.run, 'Best value');
  give(fastest?.run, 'Fastest');
  give(reliable?.run, 'Most reliable');
  return { best, value, cheapest, fastest, reliable, clean, badges, contenders, eligible: done };
}
