import { createLlm, judgeCriteria } from './judge.ts';
import { reviewKey } from './review.ts';
import { criteria as productCriteria, standard } from './product.ts';
import type { AttemptResult, CheckResult, Reviews } from './results.ts';
import type { Expectation } from './scenario.ts';
import { scenarios } from './scenarios/index.ts';
import type { Model } from './stack.ts';

type Judged = Extract<Expectation, { kind: 'judge' }>;

function current(scenario: string, group: 'task' | 'product', at: number) {
  if (group === 'product') return productCriteria as Judged[];
  const definition = scenarios.find((item) => item.id === scenario);
  return definition
    ? definition
        .expect(definition.world({ now: () => at }))
        .filter((item): item is Judged => item.kind === 'judge')
    : [];
}

export async function rejudge(options: {
  attempts: AttemptResult[];
  reviews: Reviews;
  judge: Model;
  only?: string[];
  at: number;
}) {
  const llm = await createLlm(options.judge);
  const next: AttemptResult[] = [];
  let same = 0;
  let compared = 0;
  const human = { old: 0, fresh: 0, total: 0 };
  for (const attempt of options.attempts) {
    if (
      attempt.status === 'incomplete' ||
      !scenarios.some((item) => item.id === attempt.scenario) ||
      (options.only && !options.only.includes(attempt.scenario))
    ) {
      next.push(attempt);
      continue;
    }
    const checks: CheckResult[] = attempt.checks.filter((check) => check.kind === 'check');
    const spentBefore = llm.spent().costUsd;
    const spentSince = () => {
      const now = llm.spent().costUsd;
      return now === null ? null : now - (spentBefore ?? 0);
    };
    const counts = { same: 0, compared: 0, old: 0, fresh: 0, total: 0 };
    try {
      for (const group of ['task', 'product'] as const) {
        const sources = current(attempt.scenario, group, options.at);
        if (!sources.length) continue;
        const verdicts = await judgeCriteria(llm, {
          standard: group === 'product' ? standard : undefined,
          task: attempt.task,
          transcript: attempt.transcript,
          groundTruth: attempt.groundTruth,
          criteria: sources.map((item) => ({ id: item.id, criterion: item.criterion })),
        });
        const review = options.reviews[reviewKey(attempt)];
        for (const source of sources) {
          const verdict = verdicts.find((item) => item.id === source.id)!;
          const check = attempt.checks.find(
            (item) => item.kind === 'judge' && item.group === group && item.id === source.id,
          );
          if (check) {
            counts.compared++;
            if (verdict.pass === check.pass) counts.same++;
            if (review) {
              const truth = review.wrongChecks.includes(check.id) ? !check.pass : check.pass;
              counts.total++;
              if (check.pass === truth) counts.old++;
              if (verdict.pass === truth) counts.fresh++;
            }
          }
          checks.push({
            id: source.id,
            kind: 'judge',
            group,
            criterion: source.criterion,
            required: source.required,
            aspect: source.aspect,
            failure: source.failure,
            pass: verdict.pass,
            na: verdict.na || undefined,
            evidence: verdict.reasoning,
          });
        }
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      next.push({
        ...attempt,
        status: 'incomplete',
        blame: 'infra',
        error: `Re-judging failed: ${message}`,
        judgeCostUsd: spentSince(),
      });
      continue;
    }
    same += counts.same;
    compared += counts.compared;
    human.old += counts.old;
    human.fresh += counts.fresh;
    human.total += counts.total;
    const playFailure =
      attempt.status === 'fail' &&
      attempt.error &&
      !attempt.checks.some((check) => check.required && !check.pass);
    next.push({
      ...attempt,
      checks,
      status:
        playFailure || checks.some((check) => check.required && !check.pass) ? 'fail' : 'pass',
      judgeCostUsd: spentSince(),
    });
  }
  const pct = (value: number, total: number) =>
    total ? `${Math.round((value / total) * 100)}%` : 'n/a';
  const report = [
    `Re-judged ${compared} judge verdicts with ${options.judge.provider}/${options.judge.name}: ${pct(same, compared)} match the original judge.`,
    human.total
      ? `Against your reviews (${human.total} judge verdicts): original judge ${pct(human.old, human.total)}, this judge ${pct(human.fresh, human.total)}.`
      : 'No human reviews yet, so there is nothing to measure the judges against. Run --review first.',
    '',
  ].join('\n');
  return { attempts: next, report };
}
