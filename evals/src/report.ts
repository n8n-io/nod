import { band, pairedChange, requiredScenarios } from './aggregate.ts';
import type { GateResult } from './gate.ts';
import { agreement } from './review.ts';
import type { AttemptResult, Reviews, RunSummary } from './results.ts';

export const trustLabels: Record<string, string> = {
  'honest-completion-claims': 'honest about what it did',
  'sounds-like-nod': 'sounds like Nod',
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

const coverage = (summary: RunSummary) =>
  `${summary.coverage.completed}/${summary.coverage.expected ?? '?'} attempts completed; ${summary.coverage.incomplete} incomplete; ${summary.coverage.missing.length} not run`;

export function terminal(summary: RunSummary, attempts: AttemptResult[], reviews: Reviews = {}) {
  const { manifest, regression, combined } = summary;
  const scenarios = requiredScenarios(manifest.k, attempts);
  const gaps = scenarios.filter((item) => item.stance === 'gap');
  const gap = {
    passed: gaps.reduce((total, item) => total + item.passed, 0),
    total: gaps.reduce((total, item) => total + item.attempts, 0),
  };
  const lines: string[] = [];
  lines.push(
    '',
    `Run ${manifest.label}  ·  agent ${manifest.model}  ·  judge ${manifest.judge}  ·  ${manifest.ref ?? manifest.commit.slice(0, 7)}${manifest.dirty ? '+local changes' : ''}`,
    coverage(summary),
    '',
    combined.total
      ? `${pct(combined.percent)} of regression attempts pass all required checks  (${combined.passed}/${combined.total}, 95% interval ${pct(combined.interval!.low)}–${pct(combined.interval!.high)})`
      : 'No completed regression attempts.',
    `  checks passed ${pct(combined.unitPass)}`,
    manifest.k > 1
      ? `  pass@1 ${pct(combined.passAt1)}   pass@${manifest.k} ${pct(combined.passAtK)}   pass^${manifest.k} ${pct(combined.passPowK)}   (${manifest.repeat} attempts per scenario)`
      : `  ${manifest.repeat} attempt per scenario`,
  );
  if (summary.coverage.missing.length)
    lines.push(`  Attempts not run: ${summary.coverage.missing.join(', ')}`);
  if (combined.incomplete)
    lines.push(
      `  ${combined.incomplete} attempt${combined.incomplete === 1 ? '' : 's'} incomplete (harness, mock or provider fault), not counted`,
    );
  if (summary.contaminated)
    lines.push(
      '  WARNING: many attempts hit provider or infrastructure errors; treat this run as contaminated.',
    );
  if (gap.total) lines.push(`  Known gaps (not gating): ${gap.passed}/${gap.total} attempts pass`);
  lines.push('');
  const width = Math.max(...scenarios.map((item) => item.scenario.length), 8);
  for (const item of scenarios.sort((a, b) => a.scenario.localeCompare(b.scenario))) {
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
  lines.push(`  ${'task completion'.padEnd(36)} ${pct(regression.percent).padStart(4)}`);
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
        `  ${wrong.undiagnosed} failed attempts are not diagnosed yet: pnpm run eval:capability diagnose ${summary.manifest.label}`,
      );
  }
  const human = agreement(attempts, reviews);
  if (human.reviewed)
    lines.push(
      '',
      `Human review: ${human.reviewed} attempts reviewed, you agreed with the automatic verdict on ${human.agree} (kappa ${human.kappa === null ? 'n/a' : human.kappa.toFixed(2)}).`,
      ...human.disagreements.map((item) => `  disagreement: ${item}`),
    );
  lines.push('', 'Task completion by capability:');
  for (const item of [...summary.capabilities].sort((a, b) => (a.passAt1 ?? 0) - (b.passAt1 ?? 0)))
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
    `  agent cost         ${money(e.costPerAttempt)} per attempt   ${money(e.costPerPass)} per completed task`,
    `  tokens ${e.tokensPerAttempt === null ? 'n/a' : Math.round(e.tokensPerAttempt).toLocaleString('en-US')}   tool calls ${e.toolCallsPerAttempt === null ? 'n/a' : e.toolCallsPerAttempt.toFixed(1)}   tool errors ${e.toolErrorRate === null ? 'n/a' : pct(e.toolErrorRate)}`,
    '',
    `Wall time ${minutes(summary.seconds)} (summed over attempts)  ·  agent cost ${money(summary.costUsd)}  ·  judge and simulated user ${money(e.judgeCostUsd)}`,
    '',
  );
  return lines.join('\n');
}

type Loaded = { summary: RunSummary; attempts: AttemptResult[] };

function metrics(runs: Loaded[]): Array<[string, string[]] | undefined> {
  const each = (cell: (summary: RunSummary) => string) => runs.map((run) => cell(run.summary));
  return [
    ['agent', each((summary) => summary.manifest.model)],
    [
      'attempts completed',
      each((summary) => `${summary.coverage.completed}/${summary.coverage.expected ?? '?'}`),
    ],
    ['attempts incomplete', each((summary) => String(summary.coverage.incomplete))],
    ['attempts not run', each((summary) => String(summary.coverage.missing.length))],
    [
      'source',
      each((summary) =>
        summary.manifest.ref && !summary.manifest.commit.startsWith(summary.manifest.ref)
          ? summary.manifest.ref
          : summary.manifest.commit.slice(0, 7),
      ),
    ],
    [
      'all required checks',
      each(
        (summary) =>
          `${pct(summary.combined.percent)} (${summary.combined.passed}/${summary.combined.total})`,
      ),
    ],
    [
      '95% interval',
      each((summary) =>
        summary.combined.interval
          ? `${pct(summary.combined.interval.low)}–${pct(summary.combined.interval.high)}`
          : 'n/a',
      ),
    ],
    ['checks passed', each((summary) => pct(summary.combined.unitPass))],
    ['pass@1', each((summary) => pct(summary.combined.passAt1))],
    ['pass@k', each((summary) => pct(summary.combined.passAtK))],
    ['safety incidents', each((summary) => String(summary.trust.safetyIncidents))],
    ['scope incidents', each((summary) => String(summary.trust.scopeIncidents))],
    ...[...new Set(runs.flatMap((run) => run.summary.trust.lines.map((line) => line.id)))].map(
      (id): [string, string[]] => [
        trustLabels[id] ?? id,
        each((summary) => pct(summary.trust.lines.find((line) => line.id === id)?.rate ?? null)),
      ],
    ),
    ['pass^k', each((summary) => pct(summary.combined.passPowK))],
    [
      'task completion',
      each(
        (summary) =>
          `${pct(summary.regression.percent)} (${summary.regression.passed}/${summary.regression.total})`,
      ),
    ],
    undefined,
    ['task time p50', each((summary) => minutes(summary.efficiency.seconds.p50 ?? 0))],
    ['task time p90', each((summary) => minutes(summary.efficiency.seconds.p90 ?? 0))],
    [
      'first reply p50',
      each((summary) =>
        summary.efficiency.firstReplySeconds.p50 === null
          ? 'n/a'
          : `${summary.efficiency.firstReplySeconds.p50.toFixed(1)} s`,
      ),
    ],
    ['cost / attempt', each((summary) => money(summary.efficiency.costPerAttempt))],
    ['cost / completed task', each((summary) => money(summary.efficiency.costPerPass))],
    [
      'tokens / attempt',
      each((summary) =>
        summary.efficiency.tokensPerAttempt === null
          ? 'n/a'
          : Math.round(summary.efficiency.tokensPerAttempt).toLocaleString('en-US'),
      ),
    ],
    [
      'tool calls',
      each((summary) =>
        summary.efficiency.toolCallsPerAttempt === null
          ? 'n/a'
          : summary.efficiency.toolCallsPerAttempt.toFixed(1),
      ),
    ],
    ['tool errors', each((summary) => pct(summary.efficiency.toolErrorRate))],
  ];
}

const scenarioIds = (runs: Loaded[]) =>
  [
    ...new Set(
      runs.flatMap((run) => [
        ...(run.summary.manifest.scenarioIds ?? []),
        ...run.summary.scenarios.map((item) => item.scenario),
      ]),
    ),
  ].sort();

const changedScenario = (runs: Loaded[], id: string) =>
  new Set(
    runs.flatMap((run) =>
      run.summary.scenarios.filter((item) => item.scenario === id).map((item) => item.fingerprint),
    ),
  ).size > 1;

const points = (value: number) =>
  `${value >= 0 ? '+' : ''}${Math.round(value * 100)} point${Math.abs(Math.round(value * 100)) === 1 ? '' : 's'}`;

function difference(runs: Loaded[]) {
  if (runs.length !== 2) return undefined;
  const [before, after] = runs.map((run) =>
    requiredScenarios(run.summary.manifest.k, run.attempts).filter(
      (item) => item.stance === 'regression' && item.attempts > 0,
    ),
  );
  const differences = after.flatMap((item) => {
    const other = before.find(
      (entry) =>
        Boolean(item.fingerprint) &&
        entry.scenario === item.scenario &&
        entry.fingerprint === item.fingerprint,
    );
    return other ? [item.passed / item.attempts - other.passed / other.attempts] : [];
  });
  if (!differences.length) return undefined;
  const mean = differences.reduce((sum, value) => sum + value, 0) / differences.length;
  const change = pairedChange(differences);
  const left =
    new Set([...before, ...after].map((item) => item.scenario)).size - differences.length;
  return {
    delta: Math.round(mean * 100),
    text: `Difference ${points(mean)} on the ${differences.length} scenario${differences.length === 1 ? '' : 's'} unchanged in both runs${left ? ` (${left} new or changed left out)` : ''}${change ? `, paired by scenario: 95% interval ${points(change.low)} to ${points(change.high)}, ${change.low <= 0 && change.high >= 0 ? 'so within noise' : 'beyond noise'}` : ''}.`,
  };
}

export function verdictMarkdown(
  result: GateResult,
  context: {
    model: string;
    judge: string;
    baseline: string;
    skipped: string[];
    compared: boolean;
    resampled: boolean;
  },
) {
  const lines = [`### ${result.verdict} against \`${context.baseline}\``];
  if (context.compared)
    lines.push(
      '',
      `Both sides ran in this job with \`${context.model}\` and judge \`${context.judge}\`. The verdict uses the gate scenarios${context.resampled ? ', counting the extra attempts for gate scenarios that needed more evidence' : ''}; the comparison below shows every scenario at the same number of attempts.`,
    );
  const reasons = [...result.blocking, ...result.unclear];
  if (reasons.length) lines.push('', ...reasons.map((reason) => `- ${reason}`));
  if (result.scenarios.length)
    lines.push(
      '',
      '| Gate scenario | Baseline | Candidate | Note |',
      '| --- | --- | --- | --- |',
      ...result.scenarios.map(
        (row) =>
          `| \`${row.id}\` | ${row.baseline.passed}/${row.baseline.total} | ${row.candidate.passed}/${row.candidate.total} | ${row.note} |`,
      ),
    );
  if (result.change)
    lines.push(
      '',
      `Across the gate scenarios, paired by scenario: ${points(result.change.mean)} (95% interval ${points(result.change.low)} to ${points(result.change.high)}).`,
    );
  if (result.drift.length) lines.push('', ...result.drift.map((line) => `- ${line}`));
  if (context.skipped.length)
    lines.push(
      '',
      `Out of the gate until proven again because they changed: ${context.skipped.map((id) => `\`${id}\``).join(', ')}.`,
    );
  return lines.join('\n');
}

export function compareTable(runs: Loaded[]) {
  const scenarios = scenarioIds(runs);
  const scored = runs.map((run) => requiredScenarios(run.summary.manifest.k, run.attempts));
  const values = metrics(runs);
  const width = Math.max(
    ...scenarios.map((id) => id.length),
    ...values.map((metric) => metric?.[0].length ?? 0),
    8,
  );
  const column = 18;
  const row = (label: string, cells: string[], clip = false) =>
    `  ${label.padEnd(width + 4)}${cells.map((cell) => (clip ? cell.slice(0, column - 2) : cell).padEnd(column)).join('')}`;
  const lines = [
    '',
    row(
      '',
      runs.map((run) => run.summary.manifest.label),
      true,
    ),
    ...values.map((metric) =>
      metric ? row(...metric, metric[0] === 'agent' || metric[0] === 'source') : '',
    ),
    '',
  ];
  for (const id of scenarios)
    lines.push(
      row(
        id,
        scored.map((rows) => {
          const cell = rows.find((item) => item.scenario === id);
          return cell ? `${cell.passed}/${cell.attempts}` : 'not run';
        }),
      ) + (changedScenario(runs, id) ? '  (scenario changed between runs)' : ''),
    );
  const moved = difference(runs);
  if (moved) lines.push('', `  ${moved.text}`);
  if (runs.length === 2) lines.push(...changes(runs[0], runs[1]));
  lines.push('');
  return lines.join('\n');
}

export function markdown(runs: Loaded[]) {
  const latest = runs.at(-1)!.summary;
  const scored = runs.map((run) => requiredScenarios(run.summary.manifest.k, run.attempts));
  const moved = difference(runs);
  const table = (rows: string[][]) =>
    [rows[0], rows[0].map(() => '---'), ...rows.slice(1)]
      .map(
        (cells) =>
          `| ${cells.map((cell) => cell.replace(/\|/g, '\\|').replace(/\r?\n/g, '<br>')).join(' | ')} |`,
      )
      .join('\n');
  const marks = (run: Loaded, id: string) =>
    run.attempts
      .filter((attempt) => attempt.scenario === id)
      .sort((a, b) => a.attempt - b.attempt)
      .map((attempt) => (attempt.status === 'pass' ? '✓' : attempt.status === 'fail' ? '✗' : '~'))
      .join('');
  const costs = runs.flatMap((run) => [run.summary.costUsd, run.summary.efficiency.judgeCostUsd]);
  const spent = costs.every((cost) => cost !== null)
    ? costs.reduce<number>((total, cost) => total + cost!, 0)
    : null;
  const safety = latest.trust.safetyIncidents;
  const lines = [
    latest.coverage.missing.length || latest.coverage.incomplete
      ? `### Incomplete run: ${coverage(latest)}`
      : `### ${pct(latest.combined.percent)} of regression attempts pass all required checks (${latest.combined.passed}/${latest.combined.total})${moved ? `, ${moved.delta >= 0 ? '+' : ''}${moved.delta} points vs ${runs[0].summary.manifest.label}` : ''}`,
    '',
    `\`${latest.manifest.model}\` · judge \`${latest.manifest.judge}\` · ${latest.manifest.repeat} attempt${latest.manifest.repeat === 1 ? '' : 's'} per scenario · ${safety} safety incident${safety === 1 ? '' : 's'} · ${money(spent)} on models`,
    '',
  ];
  for (const run of runs) {
    lines.push(`\`${run.summary.manifest.label}\`: ${coverage(run.summary)}.`, '');
    if (run.summary.coverage.missing.length)
      lines.push(
        `Attempts not run: ${run.summary.coverage.missing.map((id) => `\`${id}\``).join(', ')}.`,
        '',
      );
  }
  if (moved) lines.push(moved.text, '');
  if (runs.some((run) => run.summary.contaminated))
    lines.push(
      '> [!WARNING]',
      '> Many attempts hit provider or infrastructure errors. Treat this run as contaminated.',
      '',
    );
  lines.push(
    table([
      ['Scenario', ...runs.map((run) => run.summary.manifest.label)],
      ...scenarioIds(runs).map((id) => [
        `\`${id}\`${latest.scenarios.find((item) => item.scenario === id)?.stance === 'gap' ? ' (known gap)' : ''}${changedScenario(runs, id) ? ' (scenario changed)' : ''}`,
        ...runs.map((run, index) => {
          const cell = scored[index].find((item) => item.scenario === id);
          return cell
            ? `${marks(run, id)} ${cell.passed}/${cell.attempts}${cell.incomplete ? ` (+${cell.incomplete} incomplete)` : ''}`
            : 'not run';
        }),
      ]),
    ]),
  );
  if (runs.length === 2) lines.push(...changes(runs[0], runs[1]).map((line) => line.trim()));
  const wrong = latest.wentWrong;
  if (wrong.groups.length || wrong.undiagnosed) {
    lines.push('', `#### What went wrong in ${latest.manifest.label}`, '');
    for (const group of wrong.groups.slice(0, 8))
      lines.push(
        `- \`${group.scenario}\` ${group.blame === 'agent' ? 'agent' : `eval? (${group.blame})`}, ${group.category} ×${group.count}: ${group.rootCause.replace(/\s+/g, ' ')}`,
      );
    if (wrong.suspectEval.length)
      lines.push(
        '',
        `${wrong.suspectEval.length === 1 ? '1 failure looks' : `${wrong.suspectEval.length} failures look`} like a flaw in the evaluation, not the agent.`,
      );
    if (wrong.undiagnosed)
      lines.push(
        '',
        `${wrong.undiagnosed === 1 ? '1 failed attempt is' : `${wrong.undiagnosed} failed attempts are`} not diagnosed.`,
      );
  }
  lines.push(
    '',
    '<details><summary>All metrics</summary>',
    '',
    table([
      ['', ...runs.map((run) => run.summary.manifest.label)],
      ...metrics(runs).flatMap((metric) => (metric ? [[metric[0], ...metric[1]]] : [])),
    ]),
    '',
    '</details>',
  );
  lines.push('');
  return lines.join('\n');
}

export function changes(a: Loaded, b: Loaded) {
  const rate = (run: Loaded, scenario: string, id: string) => {
    const rows = run.attempts
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
      [...a.attempts, ...b.attempts]
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
  if (!runs.length) return 'No saved runs yet. Start with: pnpm run eval:capability run --tier pr';
  const width = Math.max(...runs.map((run) => run.label.length), 5);
  return [
    `  ${'label'.padEnd(width)}  ${'when'.padEnd(16)}  ${'agent'.padEnd(28)} ${'source'.padEnd(12)} all required checks`,
    ...runs.map(
      (run) =>
        `  ${run.label.padEnd(width)}  ${run.manifest.startedAt.slice(0, 16).replace('T', ' ')}  ${run.manifest.model.padEnd(28)} ${(run.manifest.ref ?? run.manifest.commit.slice(0, 7)).slice(0, 12).padEnd(12)} ${pct(run.summary.combined.percent)} (${run.summary.combined.passed}/${run.summary.combined.total}), ${money(run.summary.costUsd)}, ${minutes(run.summary.seconds)}`,
    ),
  ].join('\n');
}

const escape = (value: string) =>
  value.replace(/[&<>]/g, (char) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' })[char]!);

export function html(summary: RunSummary, attempts: AttemptResult[], reviews: Reviews = {}) {
  const { manifest, regression, combined } = summary;
  const rows = requiredScenarios(manifest.k, attempts)
    .map((item) => {
      const mine = attempts
        .filter((attempt) => attempt.scenario === item.scenario)
        .sort((a, b) => a.attempt - b.attempt);
      return `<section><h3>${escape(item.scenario)} <small>${item.passed}/${item.attempts} passed${item.stance === 'gap' ? ' (known gap, not gating)' : ''}${item.incomplete ? `, ${item.incomplete} incomplete` : ''}</small></h3><p>${escape(item.title)}</p>${mine
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
<p class="${summary.coverage.missing.length || summary.coverage.incomplete ? 'incomplete' : 'pass'}"><b>${coverage(summary)}</b></p>${summary.coverage.missing.length ? `<details><summary>Attempts not run</summary><ul>${summary.coverage.missing.map((id) => `<li>${escape(id)}</li>`).join('')}</ul></details>` : ''}
<h2>${pct(combined.percent)} pass all required checks (${combined.passed}/${combined.total}) · pass@${manifest.k} ${pct(combined.passAtK)} · pass^${manifest.k} ${pct(combined.passPowK)}</h2><p>Task completion: ${pct(regression.percent)} (${regression.passed}/${regression.total})</p>${rows}`;
}
