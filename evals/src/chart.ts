import { band, passAtK, passPowK } from './aggregate.ts';
import { insights, label, type ChartRun } from './insights.ts';
import { colorFor } from './names.ts';
import { trustLabels } from './report.ts';

export type { ChartRun } from './insights.ts';

export interface Card {
  id: string;
  html: string;
}

const esc = (value: string) =>
  value.replace(
    /[&<>"]/g,
    (char) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[char]!,
  );
const pct = (value: number | null) => (value === null ? 'n/a' : `${Math.round(value * 100)}%`);
const money = (value: number | null) =>
  value === null ? 'n/a' : value < 0.1 ? `$${value.toFixed(3)}` : `$${value.toFixed(2)}`;
const secs = (value: number | null) =>
  value === null
    ? 'n/a'
    : value >= 90
      ? `${(value / 60).toFixed(1)} min`
      : `${Math.round(value)} s`;

const css = `*{box-sizing:border-box;margin:0}body{background:#fff;font-family:Inter,-apple-system,BlinkMacSystemFont,"SF Pro Display","Segoe UI",system-ui,sans-serif;color:#0f172a;-webkit-font-smoothing:antialiased}
.card{width:1600px;height:900px;padding:60px 72px 44px;background:linear-gradient(180deg,#fff 0%,#f8fafc 100%);display:flex;flex-direction:column;position:relative;overflow:hidden}
.eyebrow{font-size:15px;font-weight:700;letter-spacing:.14em;color:#6366f1;text-transform:uppercase}
h1{font-size:46px;line-height:1.08;font-weight:780;letter-spacing:-.025em;margin-top:10px}
.sub{font-size:22px;line-height:1.4;color:#475569;margin-top:12px;max-width:1380px}
.body{flex:1;margin-top:34px;display:flex;flex-direction:column;justify-content:center;min-height:0}
.foot{font-size:15px;color:#94a3b8;display:flex;justify-content:space-between;margin-top:10px}
.row{display:flex;align-items:center;height:78px}
.name{width:300px;font-size:27px;font-weight:650;display:flex;align-items:center;gap:14px;white-space:nowrap}
.dot{width:16px;height:16px;border-radius:50%;flex:none}
.track{position:relative;flex:1;height:40px;background:#eef2f7;border-radius:12px}
.fill{position:absolute;left:0;top:0;bottom:0;border-radius:12px}
.whisk{position:absolute;top:50%;height:3px;background:#0f172a;opacity:.75;transform:translateY(-50%)}
.cap{position:absolute;top:8px;bottom:8px;width:3px;background:#0f172a;opacity:.75}
.val{width:210px;padding-left:22px;font-size:34px;font-weight:760;letter-spacing:-.02em}
.val small{font-size:18px;font-weight:500;color:#64748b;margin-left:8px;letter-spacing:0}
.axis{display:flex;justify-content:space-between;margin-left:300px;margin-right:210px;font-size:15px;color:#94a3b8;margin-top:6px}
.pill{display:inline-block;font-size:13px;font-weight:700;letter-spacing:.04em;padding:4px 10px;border-radius:999px;background:#eef2ff;color:#4338ca;margin-left:4px}
.pill.v{background:#ecfdf5;color:#047857}.pill.f{background:#fff7ed;color:#c2410c}.pill.r{background:#f5f3ff;color:#6d28d9}
table.score{width:100%;border-collapse:collapse}
table.score th{font-size:15px;font-weight:650;color:#64748b;text-align:left;padding:0 14px 12px;letter-spacing:.04em;text-transform:uppercase}
table.score td{height:84px;padding:0 14px;border-top:1px solid #e2e8f0;font-size:28px;font-weight:650;letter-spacing:-.01em}
table.score td.m{font-size:20px;font-weight:500;color:#475569}
.grid{display:grid;gap:5px;font-size:17px}
.cell{height:30px;border-radius:7px;display:flex;align-items:center;justify-content:center;font-weight:650;font-size:15px}
.hd{display:flex;align-items:center;justify-content:center;gap:8px;font-weight:700;font-size:16px;height:40px}
.sn{display:flex;align-items:center;font-size:16px;color:#334155;white-space:nowrap}
.two{display:flex;gap:64px;align-items:flex-start}.two>div{flex:1}
.panel-title{font-size:20px;font-weight:700;margin-bottom:12px;color:#334155}
svg text{font-family:inherit}`;

function frame(runs: ChartRun[], title: string, subtitle: string, body: string, note = '') {
  const first = runs[0].summary.manifest;
  const judges = [...new Set(runs.map((run) => run.summary.manifest.judge.split('/').pop()!))];
  const scenarios = Math.max(...runs.map((run) => run.summary.scenarios.length));
  return `<div class="card"><div><div class="eyebrow">Otto capability evals</div><h1>${esc(title)}</h1><div class="sub">${esc(subtitle)}</div></div><div class="body">${body}</div><div class="foot"><span>${scenarios} scenarios × ${first.repeat} attempts per model · judge ${esc(judges.join(', '))} · ${esc(first.ref ?? first.commit.slice(0, 7))} · ${esc(first.startedAt.slice(0, 10))}</span><span>${esc(note)}</span></div></div>`;
}

const colorOf = (run: ChartRun, runs: ChartRun[]) =>
  colorFor(run.summary.manifest.model, runs.indexOf(run));
const tag = (run: ChartRun, runs: ChartRun[]) =>
  `<span class="dot" style="background:${colorOf(run, runs)}"></span>${esc(label(run, runs))}`;
const sorted = (runs: ChartRun[], by: (run: ChartRun) => number | null, direction: 1 | -1 = -1) =>
  [...runs].sort(
    (a, b) => ((by(a) ?? -Infinity) - (by(b) ?? -Infinity)) * (direction === -1 ? -1 : 1),
  );

function barRows(
  runs: ChartRun[],
  value: (run: ChartRun) => number | null,
  extra: (run: ChartRun) => { low?: number; high?: number; text: string; small?: string },
  max: number,
  order: 1 | -1 = -1,
  valueWidth = 210,
) {
  return sorted(runs, value, order)
    .map((run) => {
      const v = value(run);
      const info = extra(run);
      const color = colorOf(run, runs);
      const at = (n: number) => `${Math.min(100, (n / max) * 100)}%`;
      const whisker =
        info.low !== undefined && info.high !== undefined
          ? `<div class="whisk" style="left:${at(info.low)};width:calc(${at(info.high)} - ${at(info.low)})"></div><div class="cap" style="left:${at(info.low)}"></div><div class="cap" style="left:calc(${at(info.high)} - 3px)"></div>`
          : '';
      return `<div class="row"><div class="name">${tag(run, runs)}</div><div class="track">${v === null ? '' : `<div class="fill" style="width:${at(v)};background:${color}"></div>`}${whisker}</div><div class="val" style="width:${valueWidth}px">${esc(info.text)}${info.small ? `<small>${esc(info.small)}</small>` : ''}</div></div>`;
    })
    .join('');
}

function takeaways(runs: ChartRun[]) {
  const found = insights(runs);
  const name = (run?: ChartRun) => (run ? label(run, runs) : 'n/a');
  const parts: string[] = [];
  if (found.best) parts.push(`${name(found.best.run)} leads at ${pct(found.best.value)}`);
  if (found.value && found.value.run !== found.best?.run)
    parts.push(
      `${name(found.value.run)} is the best value at ${money(found.value.value)} per success`,
    );
  if (found.fastest)
    parts.push(`${name(found.fastest.run)} is fastest (${secs(found.fastest.value)})`);
  return parts.join('. ') + '.';
}

function scoreboard(runs: ChartRun[]): Card {
  const found = insights(runs);
  const k = runs[0].summary.manifest.k;
  const rows = sorted(runs, (run) => run.summary.regression.percent)
    .map((run) => {
      const r = run.summary.regression;
      const badges = (found.badges.get(run) ?? [])
        .map(
          (text) =>
            `<span class="pill ${text === 'Best value' ? 'v' : text === 'Fastest' ? 'f' : text === 'Most reliable' ? 'r' : ''}">${esc(text)}</span>`,
        )
        .join('');
      const color = colorOf(run, runs);
      return `<tr><td style="width:430px"><span class="dot" style="background:${color};display:inline-block;margin-right:14px"></span>${esc(label(run, runs))}<div style="margin:6px 0 0 30px">${badges}</div></td>
<td style="width:330px"><div style="display:flex;align-items:center;gap:14px"><div class="track" style="height:22px;width:170px;flex:none"><div class="fill" style="width:${(r.percent ?? 0) * 100}%;background:${color}"></div></div><span style="font-size:32px;font-weight:780">${pct(r.percent)}</span></div></td>
<td>${pct(r.passAtK)}</td><td>${pct(r.passPowK)}</td><td>${money(run.summary.efficiency.costPerPass)}</td><td>${secs(run.summary.efficiency.seconds.p50)}</td><td class="m">${run.summary.trust.safetyIncidents === 0 ? 'none' : String(run.summary.trust.safetyIncidents)}</td></tr>`;
    })
    .join('');
  return {
    id: '01-scoreboard',
    html: frame(
      runs,
      'Which model should run Otto?',
      takeaways(runs),
      `<table class="score"><thead><tr><th>Model</th><th>Tasks completed</th><th>pass@${k}</th><th>pass^${k}</th><th>Cost per success</th><th>Median time</th><th>Safety incidents</th></tr></thead><tbody>${rows}</tbody></table>`,
      `pass@${k}: succeeds at least once in ${k} tries · pass^${k}: succeeds every time`,
    ),
  };
}

function passRate(runs: ChartRun[]): Card {
  const best = insights(runs).best;
  return {
    id: '02-pass-rate',
    html: frame(
      runs,
      'Share of tasks completed',
      best
        ? `Every attempt is a real task run end to end. ${label(best.run, runs)} completes ${pct(best.value)}. Lines show the 95% interval, so overlapping lines are a tie.`
        : 'Share of attempts where every required check passed.',
      `${barRows(
        runs,
        (run) => run.summary.regression.percent,
        (run) => ({
          low: run.summary.regression.interval?.low,
          high: run.summary.regression.interval?.high,
          text: pct(run.summary.regression.percent),
          small: `${run.summary.regression.passed}/${run.summary.regression.total}`,
        }),
        1,
      )}<div class="axis"><span>0%</span><span>25%</span><span>50%</span><span>75%</span><span>100%</span></div>`,
    ),
  };
}

function curves(runs: ChartRun[]): Card {
  const k = Math.max(1, Math.min(...runs.map((run) => run.summary.manifest.repeat)));
  const mean = (values: Array<number | null>) => {
    const known = values.filter((value): value is number => value !== null);
    return known.length ? known.reduce((a, b) => a + b, 0) / known.length : null;
  };
  const at = (run: ChartRun, n: number, kind: 'at' | 'pow') =>
    mean(
      run.summary.scenarios
        .filter((item) => item.stance === 'regression')
        .map((item) => (kind === 'at' ? passAtK : passPowK)(item.attempts, item.passed, n)),
    );
  const width = 800;
  const height = 560;
  const pad = { left: 56, right: 215, top: 20, bottom: 50 };
  const sx = (n: number) =>
    pad.left + (k === 1 ? 0.5 : (n - 1) / (k - 1)) * (width - pad.left - pad.right);
  const sy = (value: number) => height - pad.bottom - value * (height - pad.top - pad.bottom);
  const grid = [0, 0.25, 0.5, 0.75, 1]
    .map(
      (tick) =>
        `<line x1="${pad.left}" x2="${width - pad.right}" y1="${sy(tick)}" y2="${sy(tick)}" stroke="#e2e8f0"/><text x="${pad.left - 12}" y="${sy(tick) + 6}" text-anchor="end" fill="#94a3b8" font-size="16">${pct(tick)}</text>`,
    )
    .join('');
  const ticks = Array.from({ length: k }, (_, i) => i + 1)
    .map(
      (n) =>
        `<text x="${sx(n)}" y="${height - pad.bottom + 30}" text-anchor="middle" fill="#64748b" font-size="17">${n === 1 ? '1 try' : `${n} tries`}</text>`,
    )
    .join('');
  const ends = sorted(
    runs.filter((run) => at(run, k, 'at') !== null),
    (run) => at(run, k, 'at'),
  ).map((run) => ({
    run,
    y: sy(at(run, k, 'at') ?? 0),
  }));
  let floor = -Infinity;
  const labelY = new Map<ChartRun, number>();
  for (const item of [...ends].sort((a, b) => a.y - b.y)) {
    const y = Math.max(item.y, floor);
    labelY.set(item.run, y);
    floor = y + 22;
  }
  const lines = runs
    .filter((run) => at(run, k, 'at') !== null)
    .map((run) => {
      const color = colorOf(run, runs);
      const list = (kind: 'at' | 'pow') =>
        Array.from({ length: k }, (_, i) => i + 1).flatMap((n) => {
          const v = at(run, n, kind);
          return v === null ? [] : [{ n, v }];
        });
      const path = (kind: 'at' | 'pow') => {
        const points = list(kind);
        if (!points.length) return '';
        const dash = kind === 'pow' ? ' stroke-dasharray="3 8" stroke-linecap="round"' : '';
        return `<polyline fill="none" stroke="${color}" stroke-width="${kind === 'at' ? 4 : 3}" opacity="${kind === 'at' ? 1 : 0.7}"${dash} points="${points.map((p) => `${sx(p.n)},${sy(p.v)}`).join(' ')}"/>${
          kind === 'at'
            ? points
                .map((p) => `<circle cx="${sx(p.n)}" cy="${sy(p.v)}" r="6" fill="${color}"/>`)
                .join('')
            : points
                .map(
                  (p) =>
                    `<circle cx="${sx(p.n)}" cy="${sy(p.v)}" r="5" fill="#fff" stroke="${color}" stroke-width="3"/>`,
                )
                .join('')
        }`;
      };
      const last = list('at').at(-1);
      const target = labelY.get(run);
      const name =
        last && target !== undefined
          ? `<line x1="${sx(last.n) + 10}" y1="${sy(last.v)}" x2="${width - pad.right + 14}" y2="${target}" stroke="${color}" opacity=".45"/><text x="${width - pad.right + 20}" y="${target + 6}" font-size="19" font-weight="700" fill="${color}">${esc(label(run, runs))}</text>`
          : '';
      return path('at') + path('pow') + name;
    })
    .join('');
  const dumbbells = sorted(
    runs.filter((run) => at(run, k, 'at') !== null),
    (run) => at(run, k, 'pow'),
  )
    .map((run) => {
      const lo = at(run, k, 'pow') ?? 0;
      const hi = at(run, k, 'at') ?? 0;
      const color = colorOf(run, runs);
      return `<div class="row" style="height:64px"><div class="name" style="width:190px;font-size:22px">${tag(run, runs)}</div><div class="track" style="height:10px;background:#e2e8f0"><div style="position:absolute;left:${lo * 100}%;width:${Math.max(0, hi - lo) * 100}%;top:0;bottom:0;background:${color};opacity:.35;border-radius:5px"></div><div style="position:absolute;left:calc(${lo * 100}% - 11px);top:-6px;width:22px;height:22px;border-radius:50%;background:#fff;border:4px solid ${color}"></div><div style="position:absolute;left:calc(${hi * 100}% - 11px);top:-6px;width:22px;height:22px;border-radius:50%;background:${color}"></div></div><div class="val" style="width:150px;font-size:20px;font-weight:650;padding-left:16px">${pct(lo)} <span style="color:#94a3b8">to</span> ${pct(hi)}</div></div>`;
    })
    .join('');
  return {
    id: '03-pass-at-k',
    html: frame(
      runs,
      `Capable is not the same as reliable`,
      `Solid lines: chance that at least one of k tries succeeds (pass@k). Dotted: chance that every try succeeds (pass^k). The wider the gap, the less you can trust a single run.`,
      `<div class="two"><div><div class="panel-title">As the number of tries grows</div><svg viewBox="0 0 ${width} ${height}" width="${width}" height="${height}">${grid}${ticks}${lines}</svg></div><div style="max-width:620px"><div class="panel-title">At ${k} tries: every time to at least once</div>${dumbbells}<div style="font-size:15px;color:#94a3b8;margin-top:14px">Hollow dot: succeeds on all ${k} tries. Solid dot: succeeds on at least one.</div></div></div>`,
    ),
  };
}

function scatter(
  runs: ChartRun[],
  id: string,
  title: string,
  subtitle: string,
  axis: {
    x: (run: ChartRun) => number | null;
    format: (value: number) => string;
    label: string;
    log: boolean;
  },
): Card {
  const width = 1456;
  const height = 560;
  const pad = { left: 70, right: 60, top: 20, bottom: 66 };
  const points = runs.flatMap((run) => {
    const x = axis.x(run);
    const y = run.summary.regression.percent;
    return x === null || y === null || x <= 0 ? [] : [{ run, x, y }];
  });
  if (!points.length) return { id, html: frame(runs, title, subtitle, '<p>No data.</p>') };
  const xs = points.map((point) => point.x);
  const lo = Math.min(...xs) / (axis.log ? 1.6 : 1.4);
  const hi = Math.max(...xs) * (axis.log ? 1.6 : 1.25);
  const t = (x: number) =>
    axis.log ? (Math.log(x) - Math.log(lo)) / (Math.log(hi) - Math.log(lo)) : x / hi;
  const sx = (x: number) => pad.left + t(x) * (width - pad.left - pad.right);
  const sy = (y: number) => height - pad.bottom - y * (height - pad.top - pad.bottom);
  const ticks = axis.log
    ? [0.003, 0.01, 0.03, 0.1, 0.3, 1, 3, 10, 30, 100].filter((tick) => tick >= lo && tick <= hi)
    : Array.from({ length: 5 }, (_, i) => (hi * (i + 1)) / 5);
  const grid =
    [0, 0.25, 0.5, 0.75, 1]
      .map(
        (tick) =>
          `<line x1="${pad.left}" x2="${width - pad.right}" y1="${sy(tick)}" y2="${sy(tick)}" stroke="#e2e8f0"/><text x="${pad.left - 12}" y="${sy(tick) + 6}" text-anchor="end" fill="#94a3b8" font-size="16">${pct(tick)}</text>`,
      )
      .join('') +
    ticks
      .map(
        (tick) =>
          `<line x1="${sx(tick)}" x2="${sx(tick)}" y1="${pad.top}" y2="${height - pad.bottom}" stroke="#f1f5f9"/><text x="${sx(tick)}" y="${height - pad.bottom + 28}" text-anchor="middle" fill="#94a3b8" font-size="16">${esc(axis.format(tick))}</text>`,
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
      ? `<polyline fill="none" stroke="#cbd5e1" stroke-width="3" stroke-dasharray="3 9" stroke-linecap="round" points="${frontier.map((point) => `${sx(point.x)},${sy(point.y)}`).join(' ')}"/>`
      : '';
  const dots = points
    .map(
      (point) =>
        `<circle cx="${sx(point.x)}" cy="${sy(point.y)}" r="15" fill="${colorOf(point.run, runs)}" stroke="#fff" stroke-width="4"/><text x="${sx(point.x) + 26}" y="${sy(point.y) - 4}" font-size="22" font-weight="750" fill="#0f172a">${esc(label(point.run, runs))}</text><text x="${sx(point.x) + 26}" y="${sy(point.y) + 20}" font-size="16" fill="#64748b">${pct(point.y)} · ${esc(axis.format(point.x))}</text>`,
    )
    .join('');
  return {
    id,
    html: frame(
      runs,
      title,
      subtitle,
      `<svg viewBox="0 0 ${width} ${height}" width="${width}" height="${height}">${grid}${line}${dots}<text x="${(pad.left + width - pad.right) / 2}" y="${height - 8}" text-anchor="middle" fill="#475569" font-size="18" font-weight="600">${esc(axis.label)}</text><text x="${pad.left + 8}" y="${pad.top + 18}" fill="#16a34a" font-size="16" font-weight="700">better: up and to the left</text></svg>`,
      axis.log ? 'logarithmic cost axis' : '',
    ),
  };
}

function latency(runs: ChartRun[]): Card {
  const max = Math.max(...runs.map((run) => run.summary.efficiency.seconds.p90 ?? 0), 1);
  const fastest = insights(runs).fastest;
  return {
    id: '05-latency',
    html: frame(
      runs,
      'How long a task takes',
      `${fastest ? `${label(fastest.run, runs)} is the quickest at ${secs(fastest.value)} for a typical task. ` : ''}Bars are the median. The line reaches to the slowest 10% of tasks.`,
      barRows(
        runs,
        (run) => run.summary.efficiency.seconds.p50,
        (run) => {
          const e = run.summary.efficiency;
          return {
            low: e.seconds.p50 ?? 0,
            high: e.seconds.p90 ?? 0,
            text: secs(e.seconds.p50),
            small: `slowest 10%: ${secs(e.seconds.p90)} · first reply ${secs(e.firstReplySeconds.p50)}`,
          };
        },
        max,
        1,
        430,
      ),
      'time from message to final answer, including every tool call',
    ),
  };
}

function cost(runs: ChartRun[]): Card {
  const max = Math.max(
    ...runs.map(
      (run) => run.summary.efficiency.costPerPass ?? run.summary.efficiency.costPerAttempt ?? 0,
    ),
    0.01,
  );
  const cheapest = insights(runs).cheapest;
  return {
    id: '06-cost',
    html: frame(
      runs,
      'What a successful task costs',
      `${cheapest ? `${label(cheapest.run, runs)} is cheapest at ${money(cheapest.value)} per completed task. ` : ''}Cost per success is total spend divided by tasks that actually passed, so failures are paid for too.`,
      barRows(
        runs,
        (run) => run.summary.efficiency.costPerPass,
        (run) => ({
          text: money(run.summary.efficiency.costPerPass),
          small: `${money(run.summary.efficiency.costPerAttempt)} per try · ${Math.round((run.summary.efficiency.tokensPerAttempt ?? 0) / 1000)}k tokens`,
        }),
        max,
        1,
        430,
      ),
      'agent cost only; judge cost not included',
    ),
  };
}

function heat(rate: number | null) {
  if (rate === null) return { bg: '#f1f5f9', fg: '#94a3b8' };
  return {
    bg: `hsl(${Math.round(rate * 140)} ${rate === 0 ? 70 : 62}% ${rate === 1 ? 52 : 92 - rate * 34}%)`,
    fg: rate === 1 ? '#fff' : '#0f172a',
  };
}

function scenarioGrid(runs: ChartRun[]): Card {
  const ids = [
    ...new Set(runs.flatMap((run) => run.summary.scenarios.map((item) => item.scenario))),
  ].sort((a, b) => {
    const mean = (id: string) =>
      runs.reduce(
        (sum, run) =>
          sum + (run.summary.scenarios.find((item) => item.scenario === id)?.passAt1 ?? 0),
        0,
      );
    return mean(a) - mean(b);
  });
  const cols = `grid-template-columns:330px repeat(${runs.length},1fr)`;
  const rowHeight = Math.max(16, Math.min(30, Math.floor(540 / (ids.length + 1)) - 4));
  const header = `<div class="grid" style="${cols};gap:4px 5px"><div></div>${runs.map((run) => `<div class="hd"><span class="dot" style="background:${colorOf(run, runs)}"></span>${esc(label(run, runs))}</div>`).join('')}`;
  const rows = ids
    .map((id) => {
      const level = band(
        runs[0].summary.scenarios.find((item) => item.scenario === id)?.passAt1 ?? null,
        runs[0].summary.manifest.repeat,
      );
      return `<div class="sn">${esc(id)}${level === 'frontier' ? ' <span class="pill f" style="margin-left:8px">hard</span>' : ''}</div>${runs
        .map((run) => {
          const row = run.summary.scenarios.find((item) => item.scenario === id);
          const c = heat(row?.passAt1 ?? null);
          return `<div class="cell" style="height:${rowHeight}px;background:${c.bg};color:${c.fg}">${row ? `${row.passed}/${row.attempts}` : '-'}</div>`;
        })
        .join('')}`;
    })
    .join('');
  return {
    id: '07-scenarios',
    html: frame(
      runs,
      'Where each model wins and loses',
      'Passed attempts per task, hardest first. Green means it gets the task right every time, red means never.',
      `${header}${rows}</div>`,
    ),
  };
}

function capabilities(runs: ChartRun[]): Card {
  const ids = [
    ...new Set(runs.flatMap((run) => run.summary.capabilities.map((item) => item.capability))),
  ].sort();
  const trustIds = [
    ...new Set(runs.flatMap((run) => run.summary.trust.lines.map((line) => line.id))),
  ].filter((id) => id !== 'no-pointless-loops');
  const cols = `grid-template-columns:230px repeat(${runs.length},1fr)`;
  const head = `<div></div>${runs.map((run) => `<div class="hd" style="font-size:14px"><span class="dot" style="background:${colorOf(run, runs)};width:12px;height:12px"></span>${esc(label(run, runs))}</div>`).join('')}`;
  const grid = (
    rows: Array<{ name: string; values: Array<number | null> }>,
    text: (value: number | null) => string,
  ) =>
    `<div class="grid" style="${cols}">${head}${rows
      .map(
        (row) =>
          `<div class="sn">${esc(row.name)}</div>${row.values
            .map((value) => {
              const c = heat(value);
              return `<div class="cell" style="background:${c.bg};color:${c.fg}">${text(value)}</div>`;
            })
            .join('')}`,
      )
      .join('')}</div>`;
  const left = ids.map((id) => ({
    name: id,
    values: runs.map(
      (run) => run.summary.capabilities.find((item) => item.capability === id)?.passAt1 ?? null,
    ),
  }));
  const right = [
    { name: 'completes the task', values: runs.map((run) => run.summary.regression.percent) },
    ...trustIds.map((id) => ({
      name: trustLabels[id] ?? id,
      values: runs.map(
        (run) => run.summary.trust.lines.find((line) => line.id === id)?.rate ?? null,
      ),
    })),
  ];
  return {
    id: '08-capabilities-and-trust',
    html: frame(
      runs,
      'Strengths, and how it feels to use',
      'Left: pass rate by capability. Right: the trust profile, covering honesty, voice and proactivity on every task.',
      `<div class="two"><div><div class="panel-title">By capability</div>${grid(left, pct)}</div><div><div class="panel-title">Trust profile</div>${grid(right, pct)}</div></div>`,
    ),
  };
}

export function cards(runs: ChartRun[]): Card[] {
  return [
    scoreboard(runs),
    passRate(runs),
    curves(runs),
    scatter(
      runs,
      '04-cost-vs-quality',
      'Quality for the price',
      'Each dot is a model. Up is more tasks completed, left is cheaper per success. The dotted line connects models nobody beats on both.',
      {
        x: (run) => run.summary.efficiency.costPerPass,
        format: money,
        label: 'cost per completed task',
        log: true,
      },
    ),
    latency(runs),
    cost(runs),
    scenarioGrid(runs),
    capabilities(runs),
    scatter(
      runs,
      '09-speed-vs-quality',
      'Speed against quality',
      'The same view with the typical task time on the horizontal axis.',
      {
        x: (run) => run.summary.efficiency.seconds.p50,
        format: (value) => secs(value),
        label: 'median time per task',
        log: false,
      },
    ),
  ];
}

export function cardPage(card: Card) {
  return `<!doctype html><html><meta charset="utf-8"><style>${css}</style>${card.html}</html>`;
}

export function comparisonChart(runs: ChartRun[], title = 'Otto capability evals') {
  const sections = cards(runs)
    .map((card) => `<div class="wrap">${card.html}</div>`)
    .join('');
  return `<!doctype html><html><meta charset="utf-8"><title>${esc(title)}</title><style>${css}body{background:#e2e8f0;padding:32px 0}.wrap{width:1040px;height:585px;margin:0 auto 28px;overflow:hidden;border-radius:18px;box-shadow:0 10px 30px rgba(15,23,42,.12)}.wrap .card{zoom:.65}</style>${sections}</html>`;
}
