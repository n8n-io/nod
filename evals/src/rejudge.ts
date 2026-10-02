import { createLlm, judgeCriteria } from './judge.ts';
import { reviewKey } from './review.ts';
import { standard } from './product.ts';
import type { AttemptResult, CheckResult, Reviews } from './results.ts';
import type { Model } from './stack.ts';

export async function rejudge(options: {
  attempts: AttemptResult[];
  reviews: Reviews;
  judge: Model;
}) {
  const llm = await createLlm(options.judge);
  const next: AttemptResult[] = [];
  let same = 0;
  let compared = 0;
  const human = { old: 0, fresh: 0, total: 0 };
  for (const attempt of options.attempts) {
    if (attempt.status === 'incomplete') {
      next.push(attempt);
      continue;
    }
    const checks: CheckResult[] = attempt.checks.filter((check) => check.kind === 'check');
    for (const group of ['task', 'product'] as const) {
      const old = attempt.checks.filter(
        (check) => check.kind === 'judge' && check.group === group && check.criterion,
      );
      if (!old.length) continue;
      const verdicts = await judgeCriteria(llm, {
        standard: group === 'product' ? standard : undefined,
        task: attempt.task,
        transcript: attempt.transcript,
        groundTruth: attempt.groundTruth,
        criteria: old.map((check) => ({ id: check.id, criterion: check.criterion! })),
      });
      const review = options.reviews[reviewKey(attempt)];
      for (const check of old) {
        const verdict = verdicts.find((item) => item.id === check.id)!;
        compared++;
        if (verdict.pass === check.pass) same++;
        if (review) {
          const truth = review.wrongChecks.includes(check.id) ? !check.pass : check.pass;
          human.total++;
          if (check.pass === truth) human.old++;
          if (verdict.pass === truth) human.fresh++;
        }
        checks.push({
          ...check,
          pass: verdict.pass,
          na: verdict.na || undefined,
          evidence: verdict.reasoning,
        });
      }
    }
    const playFailure =
      attempt.status === 'fail' &&
      attempt.error &&
      !attempt.checks.some((check) => check.required && !check.pass);
    next.push({
      ...attempt,
      checks,
      status:
        playFailure || checks.some((check) => check.required && !check.pass) ? 'fail' : 'pass',
      judgeCostUsd: llm.spent().costUsd,
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
