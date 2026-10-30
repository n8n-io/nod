import { costPerRequiredPass } from './aggregate.ts';
import { insights, label, valueBand, type ChartRun } from './insights.ts';

const pct = (value: number | null) => (value === null ? 'n/a' : `${Math.round(value * 100)}%`);
const money = (value: number | null) =>
  value === null ? 'n/a' : value < 0.1 ? `$${value.toFixed(3)}` : `$${value.toFixed(2)}`;
const secs = (value: number | null) =>
  value === null
    ? 'n/a'
    : value >= 90
      ? `${(value / 60).toFixed(1)} min`
      : `${Math.round(value)} s`;

export function leaderboard(runs: ChartRun[]) {
  const k = runs[0].summary.manifest.k;
  const rows = [...runs].sort(
    (a, b) => (b.summary.combined.percent ?? -1) - (a.summary.combined.percent ?? -1),
  );
  return [
    `\`${'Model'.padEnd(14)} ${'Pass'.padStart(5)} ${`pass^${k}`.padStart(7)} ${'$/success'.padStart(10)} ${'Median'.padStart(8)}\``,
    ...rows.map(
      (run) =>
        `\`${label(run, runs).padEnd(14)} ${pct(run.summary.combined.percent).padStart(5)} ${pct(run.summary.combined.passPowK).padStart(7)} ${money(costPerRequiredPass(run.attempts)).padStart(10)} ${secs(run.summary.efficiency.seconds.p50).padStart(8)}\``,
    ),
  ].join('\n');
}

export function facts(runs: ChartRun[]) {
  const found = insights(runs);
  const name = (run?: ChartRun) => (run ? label(run, runs) : 'n/a');
  const out: string[] = [];
  if (found.best)
    out.push(
      `*Best overall:* ${name(found.best.run)}, ${pct(found.best.value)} of attempts passed every required check.`,
    );
  if (found.value)
    out.push(
      `*Best value:* ${name(found.value.run)}, ${money(found.value.value)} per all-required pass${found.value.run === found.best?.run ? '' : ` while staying within ${valueBand} points of the leader`}.`,
    );
  if (found.cheapest && found.cheapest.run !== found.value?.run)
    out.push(
      `*Cheapest per success:* ${name(found.cheapest.run)} at ${money(found.cheapest.value)}.`,
    );
  if (found.fastest)
    out.push(
      `*Fastest:* ${name(found.fastest.run)}, ${secs(found.fastest.value)} for a typical task.`,
    );
  if (found.reliable)
    out.push(
      `*Most reliable:* ${name(found.reliable.run)}, passes every required check on all ${runs[0].summary.manifest.k} tries ${pct(found.reliable.value)} of the time.`,
    );
  const unsafe = runs.filter((run) => run.summary.trust.safetyIncidents > 0);
  out.push(
    unsafe.length
      ? `*Safety incidents* (paid, sent or leaked without permission): ${unsafe.map((run) => `${name(run)} ${run.summary.trust.safetyIncidents}`).join(', ')}.`
      : '*Safety:* no model paid, sent or leaked anything without permission.',
  );
  return out;
}

export function slackMessage(
  runs: ChartRun[],
  suite: { total: number; frozen: number; pending: number; gaps: number },
) {
  const first = runs[0].summary.manifest;
  const attempts = runs[0].summary.combined.total + runs[0].summary.combined.incomplete;
  return `*Nod capability evals: what we built and how the models do*

We built an eval harness that checks whether Nod actually *finishes real tasks*, not just whether it talks well. We borrowed the approach from n8n's LangTracer: real task scenarios, state-based grading, an independent judge, pass@k / pass^k, failure attribution (agent vs. eval vs. infra) and human review to calibrate the judge.

*How it works*
• Each attempt boots an isolated Nod (real Pi, real model, Docker workspace, real Chromium) against a fake outside world: stateful Gmail / Calendar / Sheets / Slack fakes and lookalike sites (banks, shops, 2FA logins, bookings).
• We grade what actually happened (emails sent, baskets filled, payments made, files saved), plus Nod's own rules: honest about what it did, short and result-first voice, asks only when needed, never pays or sends without permission.
• Each task runs ${first.repeat} times. *pass@${first.k}* = passes every required check at least once in ${first.k} tries, *pass^${first.k}* = passes all ${first.k} tries (the one that matters for trust).
• One command to run: \`pnpm run eval:capability doctor --fix\`, then \`run\`, \`models a b c\`, \`refs main my-branch\`, \`compare\`.

*The suite:* ${suite.total} scenarios from the Linear capability tasks (inbox, Slack, spreadsheets, bank and portal logins with 2FA, booking, subscriptions, price watches, competitor digests, memory). ${suite.frozen} are calibrated and scored below. ${suite.pending} are still being calibrated. ${suite.gaps} are deliberate stretch goals Nod can't do yet (e.g. paying with a saved card, hosted apps), so we can watch them turn green.

*Results* (${runs.length} models, ${runs[0].summary.scenarios.length} scenarios × ${first.repeat} tries = ${attempts} attempts each, same judge for all)
${leaderboard(runs)}

${facts(runs)
  .map((line) => `• ${line}`)
  .join('\n')}

Charts attached. Full report with every transcript and a "what went wrong" diagnosis per failure is in the PR.`;
}
