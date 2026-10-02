import { band, passAtK, passPowK } from './aggregate.ts';
import type { AttemptResult, Reviews, RunSummary } from './results.ts';
import { trustLabels } from './report.ts';

export interface ChartRun {
  summary: RunSummary;
  attempts: AttemptResult[];
}

const palette = [
  '#2563eb',
  '#dc2626',
  '#059669',
  '#d97706',
  '#7c3aed',
  '#0891b2',
  '#be185d',
  '#4b5563',
];
const esc = (value: string) =>
  value.replace(
    /[&<>"]/g,
    (char) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[char]!,
  );
const pct = (value: number | null) => (value === null ? 'n/a' : `${Math.round(value * 100)}%`);
const money = (value: number | null) =>
  value === null ? 'n/a' : `$${value < 1 ? value.toFixed(2) : value.toFixed(1)}`;
const secs = (value: number | null) =>
  value === null
    ? 'n/a'
    : value >= 90
      ? `${(value / 60).toFixed(1)} min`
      : `${Math.round(value)} s`;
const short = (run: ChartRun) =>
  run.summary.manifest.model
    .split('/')
    .slice(-1)[0]
    .replace(/^claude-/, '');

function heat(rate: number | null) {
  if (rate === null) return '#f1f5f9';
  const hue = Math.round(rate * 120);
  return `hsl(${hue} 65% ${88 - rate * 28}%)`;
}

function bars(
  runs: ChartRun[],
  values: Array<{ value: number | null; low?: number; high?: number; label: string }>,
  max: number,
  format: (value: number) => string,
) {
  const left = 150;
  const width = 640;
  const rowHeight = 38;
  const height = runs.length * rowHeight + 24;
  const scale = (value: number) =>
    (left + (Math.min(value, max) / max) * (width - left - 80)).toFixed(1);
  const rows = runs
    .map((run, index) => {
      const item = values[index];
      const y = 12 + index * rowHeight;
      const color = palette[index % palette.length];
      if (item.value === null)
        return `<text x="0" y="${y + 18}" class="label">${esc(short(run))}</text><text x="${left}" y="${y + 18}" class="muted">n/a</text>`;
      const whisker =
        item.low !== undefined && item.high !== undefined
          ? `<line x1="${scale(item.low)}" x2="${scale(item.high)}" y1="${y + 12}" y2="${y + 12}" stroke="#0f172a" stroke-width="2"/><line x1="${scale(item.low)}" x2="${scale(item.low)}" y1="${y + 6}" y2="${y + 18}" stroke="#0f172a" stroke-width="2"/><line x1="${scale(item.high)}" x2="${scale(item.high)}" y1="${y + 6}" y2="${y + 18}" stroke="#0f172a" stroke-width="2"/>`
          : '';
      return `<text x="0" y="${y + 17}" class="label">${esc(short(run))}</text><rect x="${left}" y="${y}" width="${Number(scale(item.value)) - left}" height="24" rx="4" fill="${color}" opacity="0.85"/>${whisker}<text x="${Number(scale(item.high ?? item.value)) + 8}" y="${y + 17}" class="value">${esc(format(item.value))}${item.label ? ` <tspan class="muted">${esc(item.label)}</tspan>` : ''}</text>`;
    })
    .join('');
  return `<svg viewBox="0 0 ${width} ${height}" role="img">${rows}</svg>`;
}

function grouped(
  runs: ChartRun[],
  series: Array<{ name: string; value: (run: ChartRun) => number | null }>,
) {
  const left = 150;
  const width = 640;
  const group = 22 * series.length + 14;
  const height = runs.length * group + 36;
  const shades = ['0.95', '0.55'];
  const rows = runs
    .map((run, index) => {
      const y = 8 + index * group;
      const color = palette[index % palette.length];
      return `<text x="0" y="${y + 18}" class="label">${esc(short(run))}</text>${series
        .map((item, position) => {
          const value = item.value(run);
          const yy = y + position * 22;
          if (value === null) return '';
          return `<rect x="${left}" y="${yy}" width="${(value * (width - left - 90)).toFixed(1)}" height="18" rx="3" fill="${color}" opacity="${shades[position]}"/><text x="${left + value * (width - left - 90) + 8}" y="${yy + 14}" class="value">${pct(value)} <tspan class="muted">${esc(item.name)}</tspan></text>`;
        })
        .join('')}`;
    })
    .join('');
  return `<svg viewBox="0 0 ${width} ${height}" role="img">${rows}</svg>`;
}

function scatter(
  runs: ChartRun[],
  axis: { x: (run: ChartRun) => number | null; format: (value: number) => string; label: string },
) {
  const width = 640;
  const height = 360;
  const pad = { left: 60, right: 30, top: 20, bottom: 50 };
  const points = runs
    .map((run, index) => ({
      run,
      index,
      x: run.summary.efficiency.costPerAttempt,
      y: run.summary.regression.percent,
    }))
    .filter(
      (point): point is { run: ChartRun; index: number; x: number; y: number } =>
        point.x !== null && point.y !== null,
    );
  if (!points.length) return '<p class="muted">No cost data.</p>';
  const maxX = Math.max(...points.map((point) => point.x)) * 1.2 || 1;
  const sx = (value: number) => pad.left + (value / maxX) * (width - pad.left - pad.right);
  const sy = (value: number) => height - pad.bottom - value * (height - pad.top - pad.bottom);
  const grid = [0, 0.25, 0.5, 0.75, 1]
    .map(
      (tick) =>
        `<line x1="${pad.left}" x2="${width - pad.right}" y1="${sy(tick)}" y2="${sy(tick)}" stroke="#e2e8f0"/><text x="${pad.left - 8}" y="${sy(tick) + 4}" text-anchor="end" class="muted">${pct(tick)}</text>`,
    )
    .join('');
  const xticks = [0, 0.25, 0.5, 0.75, 1]
    .map(
      (tick) =>
        `<text x="${sx(maxX * tick)}" y="${height - pad.bottom + 18}" text-anchor="middle" class="muted">${axis.format(maxX * tick)}</text>`,
    )
    .join('');
  const frontier = points
    .filter(
      (point) =>
        !points.some(
          (other) =>
            other !== point &&
            other.x <= point.x &&
            other.y >= point.y &&
            (other.x < point.x || other.y > point.y),
        ),
    )
    .sort((a, b) => a.x - b.x);
  const line =
    frontier.length > 1
      ? `<polyline fill="none" stroke="#94a3b8" stroke-dasharray="5 4" points="${frontier.map((point) => `${sx(point.x)},${sy(point.y)}`).join(' ')}"/>`
      : '';
  const dots = points
    .map(
      (point) =>
        `<circle cx="${sx(point.x)}" cy="${sy(point.y)}" r="9" fill="${palette[point.index % palette.length]}" opacity="0.9"/><text x="${sx(point.x) + 14}" y="${sy(point.y) + 4}" class="label">${esc(short(point.run))}</text>`,
    )
    .join('');
  return `<svg viewBox="0 0 ${width} ${height}" role="img">${grid}${xticks}${line}${dots}<text x="${(width + pad.left) / 2}" y="${height - 6}" text-anchor="middle" class="muted">${axis.label}</text><text x="14" y="${height / 2}" transform="rotate(-90 14 ${height / 2})" text-anchor="middle" class="muted">pass rate (higher and further left is better)</text></svg>`;
}

function curves(runs: ChartRun[]) {
  const width = 640;
  const height = 380;
  const pad = { left: 56, right: 190, top: 64, bottom: 56 };
  const maxK = Math.max(1, Math.min(...runs.map((run) => run.summary.manifest.repeat)));
  const mean = (values: Array<number | null>) => {
    const known = values.filter((value): value is number => value !== null);
    return known.length ? known.reduce((a, b) => a + b, 0) / known.length : null;
  };
  const value = (run: ChartRun, k: number, kind: 'at' | 'pow') =>
    mean(
      run.summary.scenarios
        .filter((item) => item.stance === 'regression')
        .map((item) => (kind === 'at' ? passAtK : passPowK)(item.attempts, item.passed, k)),
    );
  const sx = (k: number) =>
    pad.left + (maxK === 1 ? 0.5 : (k - 1) / (maxK - 1)) * (width - pad.left - pad.right);
  const sy = (rate: number) => height - pad.bottom - rate * (height - pad.top - pad.bottom);
  const grid = [0, 0.25, 0.5, 0.75, 1]
    .map(
      (tick) =>
        `<line x1="${pad.left}" x2="${width - pad.right}" y1="${sy(tick)}" y2="${sy(tick)}" stroke="#e2e8f0"/><text x="${pad.left - 8}" y="${sy(tick) + 4}" text-anchor="end" class="muted">${pct(tick)}</text>`,
    )
    .join('');
  const xticks = Array.from({ length: maxK }, (_, index) => index + 1)
    .map(
      (k) =>
        `<text x="${sx(k)}" y="${height - pad.bottom + 20}" text-anchor="middle" class="muted">k = ${k}</text>`,
    )
    .join('');
  const ends = runs.map((run, index) => {
    const atEnd = Array.from({ length: maxK }, (_, i) => i + 1)
      .flatMap((k) => {
        const rate = value(run, k, 'at');
        return rate === null ? [] : [rate];
      })
      .at(-1);
    return { run, index, y: atEnd === undefined ? undefined : sy(atEnd) };
  });
  const placed = new Map<number, number>();
  let floor = -Infinity;
  for (const end of ends.filter((item) => item.y !== undefined).sort((a, b) => a.y! - b.y!)) {
    const y = Math.max(end.y!, floor);
    placed.set(end.index, y);
    floor = y + 17;
  }
  const lines = runs
    .map((run, index) => {
      const color = palette[index % palette.length];
      const points = (kind: 'at' | 'pow') =>
        Array.from({ length: maxK }, (_, i) => i + 1).flatMap((k) => {
          const rate = value(run, k, kind);
          return rate === null ? [] : [{ k, rate }];
        });
      const draw = (kind: 'at' | 'pow') => {
        const list = points(kind);
        if (!list.length) return '';
        const dash = kind === 'pow' ? ' stroke-dasharray="6 4"' : '';
        return `<polyline fill="none" stroke="${color}" stroke-width="2.5"${dash} points="${list.map((point) => `${sx(point.k)},${sy(point.rate)}`).join(' ')}"/>${list.map((point) => `<circle cx="${sx(point.k)}" cy="${sy(point.rate)}" r="4.5" fill="${color}"/>`).join('')}`;
      };
      const last = points('at').at(-1);
      const target = placed.get(index);
      const label =
        last && target !== undefined
          ? `<line x1="${sx(last.k) + 6}" y1="${sy(last.rate)}" x2="${width - pad.right + 8}" y2="${target}" stroke="${color}" stroke-width="1" opacity="0.5"/><text x="${width - pad.right + 12}" y="${target + 4}" class="label" style="fill:${color}">${esc(short(run))}</text>`
          : '';
      return draw('at') + draw('pow') + label;
    })
    .join('');
  return `<svg viewBox="0 0 ${width} ${height}" role="img">${grid}${xticks}${lines}<text x="${(pad.left + width - pad.right) / 2}" y="${height - 8}" text-anchor="middle" class="muted">attempts allowed per task (k)</text><text x="14" y="${height / 2}" transform="rotate(-90 14 ${height / 2})" text-anchor="middle" class="muted">share of tasks</text><g transform="translate(${pad.left},14)"><line x1="0" x2="26" y1="0" y2="0" stroke="#475569" stroke-width="2.5"/><text x="32" y="4" class="muted">pass@k: at least one of k attempts succeeds</text><line x1="0" x2="26" y1="16" y2="16" stroke="#475569" stroke-width="2.5" stroke-dasharray="6 4"/><text x="32" y="20" class="muted">pass^k: all k attempts succeed</text></g></svg>`;
}

function valueBars(
  runs: ChartRun[],
  series: Array<{ name: string; value: (run: ChartRun) => number | null }>,
  format: (value: number) => string,
) {
  const left = 150;
  const width = 640;
  const group = 22 * series.length + 14;
  const height = runs.length * group + 12;
  const max = Math.max(1e-9, ...runs.flatMap((run) => series.map((item) => item.value(run) ?? 0)));
  const shades = ['0.95', '0.5', '0.3'];
  const rows = runs
    .map((run, index) => {
      const y = 6 + index * group;
      const color = palette[index % palette.length];
      return `<text x="0" y="${y + 18}" class="label">${esc(short(run))}</text>${series
        .map((item, position) => {
          const value = item.value(run);
          const yy = y + position * 22;
          if (value === null) return `<text x="${left}" y="${yy + 14}" class="muted">n/a</text>`;
          const length = (value / max) * (width - left - 150);
          return `<rect x="${left}" y="${yy}" width="${Math.max(2, length).toFixed(1)}" height="18" rx="3" fill="${color}" opacity="${shades[position]}"/><text x="${left + length + 8}" y="${yy + 14}" class="value">${esc(format(value))} <tspan class="muted">${esc(item.name)}</tspan></text>`;
        })
        .join('')}`;
    })
    .join('');
  return `<svg viewBox="0 0 ${width} ${height}" role="img">${rows}</svg>`;
}

function table(headers: string[], rows: string[][]) {
  return `<table><thead><tr>${headers.map((header, index) => `<th${index ? ' class="n"' : ''}>${header}</th>`).join('')}</tr></thead><tbody>${rows.map((row) => `<tr>${row.map((cell, index) => `<td${index ? ' class="n"' : ''}>${cell}</td>`).join('')}</tr>`).join('')}</tbody></table>`;
}

function heatmap(
  runs: ChartRun[],
  rows: Array<{ name: string; cells: Array<{ rate: number | null; text: string }>; note?: string }>,
) {
  return `<table class="heat"><thead><tr><th></th>${runs.map((run, index) => `<th><span class="dot" style="background:${palette[index % palette.length]}"></span>${esc(short(run))}</th>`).join('')}</tr></thead><tbody>${rows
    .map(
      (row) =>
        `<tr><td>${esc(row.name)}${row.note ? ` <span class="muted">${esc(row.note)}</span>` : ''}</td>${row.cells.map((cell) => `<td class="cell" style="background:${heat(cell.rate)}">${esc(cell.text)}</td>`).join('')}</tr>`,
    )
    .join('')}</tbody></table>`;
}

export function comparisonChart(
  runs: ChartRun[],
  title = 'Otto capability evals: model comparison',
  reviews: Record<string, Reviews> = {},
) {
  void reviews;
  const first = runs[0].summary.manifest;
  const judges = [...new Set(runs.map((run) => run.summary.manifest.judge))];
  const scenarioIds = [
    ...new Set(runs.flatMap((run) => run.summary.scenarios.map((item) => item.scenario))),
  ].sort();
  const capabilityIds = [
    ...new Set(runs.flatMap((run) => run.summary.capabilities.map((item) => item.capability))),
  ].sort();
  const trustIds = [
    ...new Set(runs.flatMap((run) => run.summary.trust.lines.map((line) => line.id))),
  ];
  const note =
    judges.length === 1 &&
    runs.some((run) => run.summary.manifest.judge === run.summary.manifest.model)
      ? `The judge (${esc(judges[0])}) is also one of the models being judged, which can favour it on the judged criteria. State-based checks are not affected.`
      : '';
  const section = (heading: string, body: string, hint = '') =>
    `<section><h2>${heading}</h2>${hint ? `<p class="muted">${hint}</p>` : ''}${body}</section>`;
  const wrong = runs
    .map((run, index) => {
      const groups = run.summary.wentWrong?.groups.slice(0, 3) ?? [];
      return `<div class="card"><h3><span class="dot" style="background:${palette[index % palette.length]}"></span>${esc(short(run))}</h3>${groups.length ? `<ul>${groups.map((group) => `<li><b>${esc(group.scenario)}</b> <span class="muted">${esc(group.blame === 'agent' ? group.category : `eval? ${group.blame}`)} x${group.count}</span><br>${esc(group.rootCause.slice(0, 180))}</li>`).join('')}</ul>` : '<p class="muted">No diagnosed failures.</p>'}</div>`;
    })
    .join('');
  return `<!doctype html><html lang="en"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${esc(title)}</title>
<style>:root{color-scheme:light}body{font:15px/1.5 system-ui,-apple-system,sans-serif;max-width:1040px;margin:32px auto;padding:0 24px;color:#0f172a;background:#fff}h1{font-size:28px;margin:0 0 4px}h2{font-size:19px;margin:36px 0 4px}h3{font-size:15px;margin:0 0 6px}.muted{color:#64748b;font-size:13px}.label{font:600 13px system-ui;fill:#0f172a}.value{font:600 13px system-ui;fill:#0f172a}svg{width:100%;height:auto;display:block;margin-top:8px}table{border-collapse:collapse;width:100%;margin-top:10px;font-size:14px}th,td{padding:7px 10px;border-bottom:1px solid #e2e8f0;text-align:left}th.n,td.n{text-align:right}.heat td.cell{text-align:center;font-variant-numeric:tabular-nums;border:2px solid #fff;font-weight:600}.heat th{font-size:13px}.dot{display:inline-block;width:10px;height:10px;border-radius:50%;margin-right:6px}.cards{display:grid;grid-template-columns:repeat(auto-fit,minmax(300px,1fr));gap:14px}.card{border:1px solid #e2e8f0;border-radius:10px;padding:12px 14px}.card ul{margin:0;padding-left:18px;font-size:13px}.note{background:#fff7ed;border:1px solid #fed7aa;border-radius:8px;padding:8px 12px;font-size:13px;margin-top:12px}.kpis{display:grid;grid-template-columns:repeat(auto-fit,minmax(170px,1fr));gap:12px;margin-top:16px}.kpi{border:1px solid #e2e8f0;border-radius:10px;padding:10px 12px}.kpi b{display:block;font-size:22px}</style>
<h1>${esc(title)}</h1>
<p class="muted">${runs.length} models · ${scenarioIds.length} scenarios · ${first.repeat} attempts each · judge ${esc(judges.join(', '))} · code ${esc(first.ref ?? first.commit.slice(0, 7))} · ${esc(first.startedAt.slice(0, 10))}</p>
${note ? `<div class="note">${note}</div>` : ''}
<div class="kpis">${runs
    .map(
      (run, index) =>
        `<div class="kpi"><span class="dot" style="background:${palette[index % palette.length]}"></span><span class="muted">${esc(short(run))}</span><b>${pct(run.summary.regression.percent)}</b><span class="muted">${run.summary.regression.passed}/${run.summary.regression.total} attempts · ${money(run.summary.efficiency.costPerPass)}/pass · ${secs(run.summary.efficiency.seconds.p50)} p50</span></div>`,
    )
    .join('')}</div>
${section(
  'Pass rate',
  bars(
    runs,
    runs.map((run) => ({
      value: run.summary.regression.percent,
      low: run.summary.regression.interval?.low,
      high: run.summary.regression.interval?.high,
      label: `${run.summary.regression.passed}/${run.summary.regression.total}`,
    })),
    1,
    pct,
  ),
  'Share of attempts where every required check passed. The line is the 95% interval; overlapping lines mean the difference may be noise.',
)}
${section(
  'Capable versus reliable',
  grouped(runs, [
    {
      name: `pass@${first.k} (can it do it at all)`,
      value: (run) => run.summary.regression.passAtK,
    },
    { name: `pass^${first.k} (every time)`, value: (run) => run.summary.regression.passPowK },
  ]),
  `pass@${first.k} is the chance that at least one of ${first.k} attempts succeeds (can it do it at all). pass^${first.k} is the chance that all ${first.k} succeed (can you rely on it). A big gap means it can do the task but not reliably.`,
)}
${section('Pass@k and pass^k as attempts grow', curves(runs), 'How often a model gets the task done if it may try k times (solid), against how often it gets it right every time (dashed). A steep solid line with a flat dashed line means capable but unreliable.')}
${section(
  'Latency',
  valueBars(
    runs,
    [
      { name: 'p50 task time', value: (run) => run.summary.efficiency.seconds.p50 },
      { name: 'p90', value: (run) => run.summary.efficiency.seconds.p90 },
      { name: 'first reply', value: (run) => run.summary.efficiency.firstReplySeconds.p50 },
    ],
    (value) => secs(value),
  ),
  'Time to finish a task (median and slow tail) and time until the user sees the first reply.',
)}
${section(
  'Cost',
  valueBars(
    runs,
    [
      { name: 'per attempt', value: (run) => run.summary.efficiency.costPerAttempt },
      { name: 'per passing attempt', value: (run) => run.summary.efficiency.costPerPass },
    ],
    (value) => money(value),
  ),
  'Agent cost only. The cost per passing attempt is what a successful task really costs once failures are counted.',
)}
${section('Cost against success', scatter(runs, { x: (run) => run.summary.efficiency.costPerAttempt, format: money, label: 'agent cost per attempt' }), 'Each dot is a model. The dashed line connects the models nobody beats on both cost and pass rate.')}
${section('Speed against success', scatter(runs, { x: (run) => run.summary.efficiency.seconds.p50, format: (value) => secs(value), label: 'median task time' }), 'The same view with latency on the horizontal axis.')}
${section(
  'Latency and cost',
  table(
    [
      'Model',
      'Task time p50',
      'Task time p90',
      'First reply p50',
      'Cost / attempt',
      'Cost / pass',
      'Tokens / attempt',
      'Tool calls',
      'Tool errors',
    ],
    runs.map((run, index) => [
      `<span class="dot" style="background:${palette[index % palette.length]}"></span>${esc(short(run))}`,
      secs(run.summary.efficiency.seconds.p50),
      secs(run.summary.efficiency.seconds.p90),
      secs(run.summary.efficiency.firstReplySeconds.p50),
      money(run.summary.efficiency.costPerAttempt),
      money(run.summary.efficiency.costPerPass),
      run.summary.efficiency.tokensPerAttempt === null
        ? 'n/a'
        : Math.round(run.summary.efficiency.tokensPerAttempt).toLocaleString('en-US'),
      run.summary.efficiency.toolCallsPerAttempt === null
        ? 'n/a'
        : run.summary.efficiency.toolCallsPerAttempt.toFixed(1),
      pct(run.summary.efficiency.toolErrorRate),
    ]),
  ),
)}
${section(
  'By capability',
  heatmap(
    runs,
    capabilityIds.map((id) => ({
      name: id,
      cells: runs.map((run) => {
        const row = run.summary.capabilities.find((item) => item.capability === id);
        return { rate: row?.passAt1 ?? null, text: pct(row?.passAt1 ?? null) };
      }),
    })),
  ),
  'Average pass rate over the scenarios that use each capability.',
)}
${section(
  'By scenario',
  heatmap(
    runs,
    scenarioIds.map((id) => ({
      name: id,
      note:
        band(
          runs[0].summary.scenarios.find((item) => item.scenario === id)?.passAt1 ?? null,
          runs[0].summary.manifest.repeat,
        ) ?? '',
      cells: runs.map((run) => {
        const row = run.summary.scenarios.find((item) => item.scenario === id);
        return { rate: row?.passAt1 ?? null, text: row ? `${row.passed}/${row.attempts}` : '-' };
      }),
    })),
  ),
  'Passed attempts out of completed attempts. Green passes every time, red never.',
)}
${section('Trust profile', table(['', ...runs.map((run) => esc(short(run)))], [['completes the task', ...runs.map((run) => pct(run.summary.regression.percent))], ...trustIds.map((id) => [trustLabels[id] ?? id, ...runs.map((run) => pct(run.summary.trust.lines.find((line) => line.id === id)?.rate ?? null))]), ['safety incidents', ...runs.map((run) => String(run.summary.trust.safetyIncidents))], ['scope incidents', ...runs.map((run) => String(run.summary.trust.scopeIncidents))]]), 'What users feel beyond the task: honesty, voice, proactivity. Safety and scope incidents should be zero.')}
${section('What went wrong', `<div class="cards">${wrong}</div>`)}
</html>`;
}
