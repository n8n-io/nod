import { band } from './aggregate.ts';
import { agreement } from './review.ts';
import type { AttemptResult, Reviews, RunSummary } from './results.ts';

export const trustLabels: Record<string, string> = {
  'honest-completion-claims': 'honest about what it did',
  'sounds-like-otto': 'sounds like Otto',
  'acknowledges-then-works': 'acknowledges, then works',
  'voice-tripwires': 'no filler, em dashes or raw errors',
  'proactive-and-grounded': 'proactive and grounded',
  'asks-only-when-needed': 'asks only when needed',
  'keeps-going-when-blocked': 'keeps going when blocked',
  'no-pointless-loops': 'no pointless loops',
};

const pct = (value: number | null) => (value === null ? 'n/a' : `${Math.round(value * 100)}%`);
const money = (value: number | null) => (value === null ? 'n/a' : `$${value.toFixed(2)}`);
const minutes = (seconds: number) =>
  seconds >= 90 ? `${(seconds / 60).toFixed(1)} min` : `${Math.round(seconds)} s`;

export function terminal(summary: RunSummary, attempts: AttemptResult[], reviews: Reviews = {}) {
  const { manifest, regression, gap } = summary;
  const lines: string[] = [];
  lines.push(
    '',
    `Run ${manifest.label}  ·  agent ${manifest.model}  ·  judge ${manifest.judge}  ·  ${manifest.ref ?? manifest.commit.slice(0, 7)}${manifest.dirty ? '+local changes' : ''}`,
    '',
    regression.total
      ? `${pct(regression.percent)} of regression attempts pass  (${regression.passed}/${regression.total}, 95% interval ${pct(regression.interval!.low)}–${pct(regression.interval!.high)})`
      : 'No completed regression attempts.',
    `  checks passed ${pct(regression.unitPass)}`,
    manifest.k > 1
      ? `  pass@1 ${pct(regression.passAt1)}   pass@${manifest.k} ${pct(regression.passAtK)}   pass^${manifest.k} ${pct(regression.passPowK)}   (${manifest.repeat} attempts per scenario)`
      : `  ${manifest.repeat} attempt per scenario`,
  );
  if (regression.incomplete)
    lines.push(
      `  ${regression.incomplete} attempt${regression.incomplete === 1 ? '' : 's'} incomplete (harness, mock or provider fault), not counted`,
    );
  if (summary.contaminated)
    lines.push(
      '  WARNING: many attempts hit provider or infrastructure errors; treat this run as contaminated.',
    );
  if (gap.total) lines.push(`  Known gaps (not gating): ${gap.passed}/${gap.total} attempts pass`);
  lines.push('');
  const width = Math.max(...summary.scenarios.map((item) => item.scenario.length), 8);
  for (const item of summary.scenarios.sort((a, b) => a.scenario.localeCompare(b.scenario))) {
    const marks = attempts
      .filter((attempt) => attempt.scenario === item.scenario)
      .sort((a, b) => a.attempt - b.attempt)
      .map((attempt) => (attempt.status === 'pass' ? '✓' : attempt.status === 'fail' ? '✗' : '~'))
      .join('');
    const level = band(item.passAt1, item.attempts);
    lines.push(
      `  ${item.scenario.padEnd(width)}  ${marks.padEnd(Math.max(manifest.repeat, 3))}  ${item.passed}/${item.attempts}` +
        `${item.incomplete ? ` (+${item.incomplete} incomplete)` : ''}${level ? `  ${level}` : ''}${item.stance === 'gap' ? '  [gap]' : ''}`,
    );
  }
  lines.push('', 'Trust profile (what users feel):');
  lines.push(`  ${'completes the task'.padEnd(36)} ${pct(regression.percent).padStart(4)}`);
  for (const line of summary.trust.lines)
    lines.push(
      `  ${(trustLabels[line.id] ?? line.id).padEnd(36)} ${pct(line.rate).padStart(4)}   (${line.applicable} judged)`,
    );
  lines.push(
    `  ${'safety incidents'.padEnd(36)} ${String(summary.trust.safetyIncidents).padStart(4)}   attempts that paid, sent or leaked without permission`,
  );
  lines.push(
    `  ${'scope incidents'.padEnd(36)} ${String(summary.trust.scopeIncidents).padStart(4)}   attempts that did more than was asked`,
  );
  const wrong = summary.wentWrong;
  if (wrong && (wrong.groups.length || wrong.undiagnosed)) {
    lines.push('', 'What went wrong:');
    for (const group of wrong.groups.slice(0, 8))
      lines.push(
        `  ${(group.blame === 'agent' ? 'agent' : `eval? (${group.blame})`).padEnd(16)} ${group.category.padEnd(14)} x${group.count}  ${group.scenario}: ${group.rootCause.slice(0, 150)}`,
        `      fix: ${group.fix.slice(0, 160)}`,
      );
    if (wrong.suspectEval.length)
      lines.push(
        `  ${wrong.suspectEval.length} failure${wrong.suspectEval.length === 1 ? '' : 's'} look like a flaw in the evaluation, not the agent. Fix those before trusting the number.`,
      );
    if (wrong.undiagnosed)
      lines.push(
        `  ${wrong.undiagnosed} failed attempts are not diagnosed yet: npm run eval:capability -- diagnose ${summary.manifest.label}`,
      );
  }
  const human = agreement(attempts, reviews);
  if (human.reviewed)
    lines.push(
      '',
      `Human review: ${human.reviewed} attempts reviewed, you agreed with the automatic verdict on ${human.agree} (kappa ${human.kappa === null ? 'n/a' : human.kappa.toFixed(2)}).`,
      ...human.disagreements.map((item) => `  disagreement: ${item}`),
    );
  lines.push('', 'By capability:');
  for (const item of summary.capabilities.sort((a, b) => (a.passAt1 ?? 0) - (b.passAt1 ?? 0)))
    lines.push(
      `  ${item.capability.padEnd(14)} ${pct(item.passAt1).padStart(4)}  (${item.scenarios} scenarios)`,
    );
  if (summary.failures.length)
    lines.push(
      '',
      `Failed checks by class: ${summary.failures.map((item) => `${item.failure} ${item.count}`).join(', ')}`,
    );
  const e = summary.efficiency;
  const secs = (value: number | null) =>
    value === null
      ? 'n/a'
      : value >= 90
        ? `${(value / 60).toFixed(1)} min`
        : `${value.toFixed(0)} s`;
  lines.push(
    '',
    'Latency and cost (per attempt):',
    `  task time          p50 ${secs(e.seconds.p50)}   p90 ${secs(e.seconds.p90)}`,
    `  first reply        p50 ${secs(e.firstReplySeconds.p50)}   p90 ${secs(e.firstReplySeconds.p90)}`,
    `  agent cost         ${money(e.costPerAttempt)} per attempt   ${money(e.costPerPass)} per passing attempt`,
    `  tokens ${e.tokensPerAttempt === null ? 'n/a' : Math.round(e.tokensPerAttempt).toLocaleString('en-US')}   tool calls ${e.toolCallsPerAttempt === null ? 'n/a' : e.toolCallsPerAttempt.toFixed(1)}   tool errors ${e.toolErrorRate === null ? 'n/a' : pct(e.toolErrorRate)}`,
    '',
    `Wall time ${minutes(summary.seconds)} (summed over attempts)  ·  agent cost ${money(summary.costUsd)}  ·  judge and simulated user ${money(e.judgeCostUsd)}`,
    '',
  );
  return lines.join('\n');
}

export function compareTable(runs: Array<{ summary: RunSummary; attempts?: AttemptResult[] }>) {
  const names = runs.map((run) => run.summary.manifest.label);
  const scenarios = [
    ...new Set(runs.flatMap((run) => run.summary.scenarios.map((item) => item.scenario))),
  ].sort();
  const width = Math.max(...scenarios.map((id) => id.length), 8);
  const column = 18;
  const row = (label: string, cells: string[]) =>
    `  ${label.padEnd(width + 4)}${cells.map((cell) => cell.padEnd(column)).join('')}`;
  const lines = [
    '',
    row(
      '',
      names.map((name) => name.slice(0, column - 2)),
    ),
  ];
  lines.push(
    row(
      'agent',
      runs.map((run) => run.summary.manifest.model.slice(0, column - 2)),
    ),
  );
  lines.push(
    row(
      'source',
      runs.map((run) =>
        (run.summary.manifest.ref ?? run.summary.manifest.commit.slice(0, 7)).slice(0, column - 2),
      ),
    ),
    row(
      'pass rate',
      runs.map(
        (run) =>
          `${pct(run.summary.regression.percent)} (${run.summary.regression.passed}/${run.summary.regression.total})`,
      ),
    ),
    row(
      '95% interval',
      runs.map((run) =>
        run.summary.regression.interval
          ? `${pct(run.summary.regression.interval.low)}–${pct(run.summary.regression.interval.high)}`
          : 'n/a',
      ),
    ),
    row(
      'checks passed',
      runs.map((run) => pct(run.summary.regression.unitPass)),
    ),
    row(
      'pass@k',
      runs.map((run) => pct(run.summary.regression.passAtK)),
    ),
    row(
      'safety incidents',
      runs.map((run) => String(run.summary.trust.safetyIncidents)),
    ),
    row(
      'scope incidents',
      runs.map((run) => String(run.summary.trust.scopeIncidents)),
    ),
    ...[...new Set(runs.flatMap((run) => run.summary.trust.lines.map((line) => line.id)))].map(
      (id) =>
        row(
          trustLabels[id] ?? id,
          runs.map((run) =>
            pct(run.summary.trust.lines.find((line) => line.id === id)?.rate ?? null),
          ),
        ),
    ),
    row(
      'pass^k',
      runs.map((run) => pct(run.summary.regression.passPowK)),
    ),
    '',
    row(
      'task time p50',
      runs.map((run) => minutes(run.summary.efficiency.seconds.p50 ?? 0)),
    ),
    row(
      'task time p90',
      runs.map((run) => minutes(run.summary.efficiency.seconds.p90 ?? 0)),
    ),
    row(
      'first reply p50',
      runs.map((run) =>
        run.summary.efficiency.firstReplySeconds.p50 === null
          ? 'n/a'
          : `${run.summary.efficiency.firstReplySeconds.p50.toFixed(1)} s`,
      ),
    ),
    row(
      'cost / attempt',
      runs.map((run) => money(run.summary.efficiency.costPerAttempt)),
    ),
    row(
      'cost / pass',
      runs.map((run) => money(run.summary.efficiency.costPerPass)),
    ),
    row(
      'tokens / attempt',
      runs.map((run) =>
        run.summary.efficiency.tokensPerAttempt === null
          ? 'n/a'
          : Math.round(run.summary.efficiency.tokensPerAttempt).toLocaleString('en-US'),
      ),
    ),
    row(
      'tool calls',
      runs.map((run) =>
        run.summary.efficiency.toolCallsPerAttempt === null
          ? 'n/a'
          : run.summary.efficiency.toolCallsPerAttempt.toFixed(1),
      ),
    ),
    row(
      'tool errors',
      runs.map((run) => pct(run.summary.efficiency.toolErrorRate)),
    ),
    '',
  );
  for (const id of scenarios) {
    const cells = runs.map((run) => run.summary.scenarios.find((item) => item.scenario === id));
    const prints = new Set(cells.filter(Boolean).map((cell) => cell!.fingerprint));
    lines.push(
      row(
        id,
        cells.map((cell) => (cell ? `${cell.passed}/${cell.attempts}` : '-')),
      ) + (prints.size > 1 ? '  (scenario changed between runs)' : ''),
    );
  }
  if (runs.length === 2) {
    const [a, b] = runs.map((run) => run.summary.regression);
    if (a.interval && b.interval) {
      const overlap = a.interval.low <= b.interval.high && b.interval.low <= a.interval.high;
      const delta = Math.round(((b.percent ?? 0) - (a.percent ?? 0)) * 100);
      lines.push(
        '',
        `  Difference ${delta >= 0 ? '+' : ''}${delta} points. ${overlap ? 'The 95% intervals overlap, so this is within noise at this sample size.' : 'The 95% intervals do not overlap.'}`,
      );
    }
  }
  if (runs.length === 2 && runs[0].attempts && runs[1].attempts)
    lines.push(...changes(runs[0], runs[1]));
  lines.push('');
  return lines.join('\n');
}

type Loaded = { summary: RunSummary; attempts?: AttemptResult[] };

export function changes(a: Loaded, b: Loaded) {
  const rate = (run: Loaded, scenario: string, id: string) => {
    const rows = (run.attempts ?? [])
      .filter((item) => item.scenario === scenario && item.status !== 'incomplete')
      .flatMap((item) => item.checks.filter((check) => check.id === id && !check.na));
    return rows.length
      ? { passed: rows.filter((check) => check.pass).length, total: rows.length }
      : undefined;
  };
  const same = new Map(a.summary.scenarios.map((item) => [item.scenario, item.fingerprint]));
  const moved: Array<{ text: string; size: number; better: boolean }> = [];
  for (const scenario of b.summary.scenarios) {
    if (same.get(scenario.scenario) !== scenario.fingerprint) continue;
    const ids = new Set(
      [...(a.attempts ?? []), ...(b.attempts ?? [])]
        .filter((item) => item.scenario === scenario.scenario)
        .flatMap((item) => item.checks.map((check) => check.id)),
    );
    for (const id of ids) {
      const before = rate(a, scenario.scenario, id);
      const after = rate(b, scenario.scenario, id);
      if (!before || !after) continue;
      const delta = after.passed / after.total - before.passed / before.total;
      if (Math.abs(delta) >= 0.33)
        moved.push({
          text: `${scenario.scenario} / ${id}: ${before.passed}/${before.total} → ${after.passed}/${after.total}`,
          size: Math.abs(delta),
          better: delta > 0,
        });
    }
  }
  moved.sort((x, y) => y.size - x.size);
  const out: string[] = [];
  const worse = moved.filter((item) => !item.better);
  const better = moved.filter((item) => item.better);
  if (worse.length)
    out.push(
      '',
      `  Got worse (${worse.length}):`,
      ...worse.slice(0, 8).map((item) => `    - ${item.text}`),
    );
  if (better.length)
    out.push(
      '',
      `  Got better (${better.length}):`,
      ...better.slice(0, 8).map((item) => `    + ${item.text}`),
    );
  if (!moved.length) out.push('', '  No check moved by a third or more between these runs.');
  out.push(
    '',
    '  Small runs are noisy: treat a single check moving by one attempt as a hint, not a finding.',
  );
  return out;
}

export function runsTable(
  runs: Array<{
    label: string;
    manifest: { model: string; ref?: string; commit: string; startedAt: string; judge: string };
    summary: RunSummary;
  }>,
) {
  if (!runs.length)
    return 'No saved runs yet. Start with: npm run eval:capability -- run --tier pr';
  const width = Math.max(...runs.map((run) => run.label.length), 5);
  return [
    `  ${'label'.padEnd(width)}  ${'when'.padEnd(16)}  ${'agent'.padEnd(28)} ${'source'.padEnd(12)} pass rate`,
    ...runs.map(
      (run) =>
        `  ${run.label.padEnd(width)}  ${run.manifest.startedAt.slice(0, 16).replace('T', ' ')}  ${run.manifest.model.padEnd(28)} ${(run.manifest.ref ?? run.manifest.commit.slice(0, 7)).slice(0, 12).padEnd(12)} ${pct(run.summary.regression.percent)} (${run.summary.regression.passed}/${run.summary.regression.total}), ${money(run.summary.costUsd)}, ${minutes(run.summary.seconds)}`,
    ),
  ].join('\n');
}

const escape = (value: string) =>
  value.replace(/[&<>]/g, (char) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' })[char]!);

export function html(summary: RunSummary, attempts: AttemptResult[], reviews: Reviews = {}) {
  const { manifest, regression } = summary;
  const rows = summary.scenarios
    .map((item) => {
      const mine = attempts
        .filter((attempt) => attempt.scenario === item.scenario)
        .sort((a, b) => a.attempt - b.attempt);
      return `<section><h3>${escape(item.scenario)} <small>${item.passed}/${item.attempts} passed${item.incomplete ? `, ${item.incomplete} incomplete` : ''}</small></h3><p>${escape(item.title)}</p>${mine
        .map(
          (
            attempt,
          ) => `<details><summary class="${attempt.status}">attempt ${attempt.attempt}: ${attempt.status}${attempt.blame ? ` (${attempt.blame})` : ''} · ${minutes(attempt.seconds)} · ${attempt.toolCalls} tool calls · ${money(attempt.costUsd)}</summary>
<ul>${attempt.checks.map((check) => `<li class="${check.pass ? 'pass' : 'fail'}"><b>${check.na ? 'n/a' : check.pass ? 'pass' : 'FAIL'}</b> ${escape(check.id)} <i>${check.kind}, ${check.group}, ${check.aspect}${check.required ? '' : ', optional'}</i>${check.evidence ? ` — ${escape(check.evidence)}` : ''}</li>`).join('')}</ul>
${reviews[`${attempt.scenario}.${attempt.attempt}`] ? `<p><b>Human review:</b> ${reviews[`${attempt.scenario}.${attempt.attempt}`].verdict}${reviews[`${attempt.scenario}.${attempt.attempt}`].note ? ` — ${escape(reviews[`${attempt.scenario}.${attempt.attempt}`].note)}` : ''}</p>` : ''}
${attempt.error ? `<p class="fail">${escape(attempt.error)}</p>` : ''}${attempt.diagnosis ? `<p><b>Diagnosis (${attempt.diagnosis.blame}, ${attempt.diagnosis.category}):</b> ${escape(attempt.diagnosis.rootCause)}<br><i>Turning point:</i> ${escape(attempt.diagnosis.turningPoint)}<br><i>Fix:</i> ${escape(attempt.diagnosis.fix)}</p>` : ''}<h4>Final answer</h4><pre>${escape(attempt.final)}</pre><h4>Ground truth</h4><pre>${escape(attempt.groundTruth)}</pre><h4>Transcript</h4><pre>${escape(attempt.transcript)}</pre></details>`,
        )
        .join('')}</section>`;
    })
    .join('');
  return `<!doctype html><meta charset="utf-8"><title>${escape(manifest.label)}</title><style>body{font:15px/1.5 system-ui;max-width:980px;margin:32px auto;padding:0 20px}pre{white-space:pre-wrap;background:#f6f6f8;padding:10px;border-radius:6px;max-height:420px;overflow:auto}.pass{color:#0a7a3d}.fail{color:#b00020}.incomplete{color:#8a6d00}summary{cursor:pointer}small{color:#666;font-weight:400}</style>
<h1>${escape(manifest.label)}</h1><p>${escape(manifest.model)} · judge ${escape(manifest.judge)} · ${escape(manifest.ref ?? manifest.commit)} · ${manifest.startedAt}</p>
<h2>${pct(regression.percent)} pass (${regression.passed}/${regression.total}) · pass@${manifest.k} ${pct(regression.passAtK)} · pass^${manifest.k} ${pct(regression.passPowK)}</h2>${rows}`;
}
