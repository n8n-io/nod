import { cards, esc, money, pct, type Card, type ChartRun } from './chart.ts';
import { insights, label } from './insights.ts';

export interface StoryNotes {
  headline?: string;
  learned?: string[];
}

interface Suite {
  total: number;
  calibrating: number;
  gaps: number;
}

const others = (eligible: ChartRun[], best: ChartRun) => {
  const rest = eligible
    .filter((run) => run !== best)
    .map((run) => run.summary.combined.percent)
    .filter((value): value is number => value !== null);
  return rest.length
    ? `The rest pass between ${pct(Math.min(...rest))} and ${pct(Math.max(...rest))}.`
    : '';
};

const sections: Array<{ id: string; kicker: string; lead: (runs: ChartRun[]) => string }> = [
  {
    id: '01-scoreboard',
    kicker: '1 · The scoreboard',
    lead: (runs) => {
      const found = insights(runs);
      return found.best
        ? `${label(found.best.run, runs)} passes the most attempts with every required check (${pct(found.best.value)}). ${others(found.eligible, found.best.run)}`
        : 'How often each model passes every required check.';
    },
  },
  {
    id: '03-pass-at-k',
    kicker: '2 · Capable is not the same as reliable',
    lead: (runs) =>
      `Compare passing all required checks at least once in ${runs[0].summary.manifest.k} tries with passing every try.`,
  },
  {
    id: '04-cost-vs-quality',
    kicker: '3 · What it costs',
    lead: (runs) => {
      const found = insights(runs);
      return found.value && found.cheapest
        ? `${label(found.value.run, runs)} is the best value at ${money(found.value.value)} per all-required pass. ${label(found.cheapest.run, runs)} is the cheapest at ${money(found.cheapest.value)}.`
        : 'Quality against cost per all-required pass.';
    },
  },
  {
    id: '07-scenarios',
    kicker: '4 · Where each model wins and loses',
    lead: () => 'Passed attempts per task. Some tasks are easy for everyone, some for no one.',
  },
  {
    id: '08-capabilities-and-trust',
    kicker: '5 · How it feels to use',
    lead: () =>
      'Beyond finishing the task: is it honest about what it did, does it sound like Nod, does it stay out of trouble.',
  },
];

const extra = `
.story{width:1600px;background:#fff}
.story .card{height:auto;min-height:0;padding:6px 72px 26px;background:#fff}
.story .card .eyebrow,.story .card .foot{display:none}
.story .card h1{display:none}
.story .card .sub{font-size:19px;margin-top:0}
.story .card .body{margin-top:20px}
.sec{border-top:1px solid #e2e8f0;padding-top:46px}
.sec>.kicker,.sec>.lead{margin-left:72px;margin-right:72px}
.kicker{font-size:15px;font-weight:700;letter-spacing:.12em;text-transform:uppercase;color:#6366f1;margin-bottom:8px}
.lead{font-size:27px;line-height:1.35;font-weight:640;letter-spacing:-.01em;color:#0f172a;max-width:1360px;margin-bottom:6px}
.hero{padding:72px 72px 44px;background:linear-gradient(180deg,#eef2ff 0%,#fff 100%)}
.hero h1{font-size:68px;line-height:1.04;max-width:1300px}
.hero .sub{font-size:26px;max-width:1260px;margin-top:20px}
.chips{display:flex;gap:16px;margin-top:34px;flex-wrap:wrap}
.chip{background:#fff;border:1px solid #e2e8f0;border-radius:16px;padding:14px 22px;box-shadow:0 2px 8px rgba(15,23,42,.05)}
.chip b{display:block;font-size:34px;letter-spacing:-.02em}.chip span{font-size:15px;color:#64748b}
.how{display:flex;gap:20px;padding:26px 72px 40px}
.step{flex:1;background:#f8fafc;border:1px solid #e2e8f0;border-radius:16px;padding:20px 22px}
.step b{display:block;font-size:20px;margin-bottom:6px}.step span{font-size:17px;line-height:1.4;color:#475569}
.learned{padding:44px 72px 36px;border-top:1px solid #e2e8f0;background:#f8fafc}
.learned h2{font-size:34px;letter-spacing:-.02em;margin-bottom:18px}
.learned li{font-size:23px;line-height:1.42;margin:0 0 12px 26px;color:#1e293b;max-width:1380px}
.credit{padding:22px 72px 34px;font-size:15px;color:#94a3b8;line-height:1.5}`;

export function storyCard(runs: ChartRun[], suite: Suite, notes: StoryNotes = {}): Card {
  const all = new Map(cards(runs).map((card) => [card.id, card]));
  const first = runs[0].summary.manifest;
  const attempts = runs.reduce(
    (sum, run) =>
      sum +
      run.summary.combined.total +
      run.summary.combined.incomplete +
      run.summary.gap.total +
      run.summary.gap.incomplete,
    0,
  );
  const tasks = Math.max(
    ...runs.map(
      (run) => run.summary.scenarios.filter((item) => item.stance === 'regression').length,
    ),
  );
  const k = first.k;
  const repeat = first.repeat;
  const spent = runs.reduce((sum, run) => sum + (run.summary.costUsd ?? 0), 0);
  const found = insights(runs);
  const learned = notes.learned?.length
    ? notes.learned
    : [
        found.best
          ? `${label(found.best.run, runs)} passes the most attempts with every required check, at ${pct(found.best.value)}.`
          : '',
      ].filter(Boolean);
  const chips: Array<[string, string]> = [
    [String(runs.length), 'models compared'],
    [String(attempts), 'real end-to-end attempts'],
    [String(tasks), 'tasks per model'],
    [`$${Math.round(spent)}`, `for these ${attempts} attempts`],
  ];
  const steps: Array<[string, string]> = [
    ['Real Nod', 'The real agent, a real model, a Docker workspace and a real Chromium browser.'],
    [
      'A fake outside world',
      'Stateful Gmail, Slack, Sheets and Calendar, plus lookalike bank, shop, booking and 2FA sites.',
    ],
    [
      'Graded on what happened',
      'Emails sent, baskets filled, payments made, files saved. Then an independent judge and Nod’s own rules.',
    ],
    [
      `Tried ${repeat} times`,
      `Among ${k} tries, pass@${k} passes every required check at least once. pass^${k} passes every time.`,
    ],
  ];
  const body = sections
    .map((section) => {
      const card = all.get(section.id);
      return card
        ? `<div class="sec"><div class="kicker">${esc(section.kicker)}</div><div class="lead">${esc(section.lead(runs))}</div>${card.html}</div>`
        : '';
    })
    .join('');
  const html = `<div class="story">
<div class="hero"><div class="eyebrow">Nod capability evals</div><h1>${esc(notes.headline ?? 'Can you trust Nod to finish the job?')}</h1><div class="sub">We run real tasks end to end against a fake world, grade what actually happened, and compare models. This is how ${runs.length} of them do on ${tasks} tasks.</div><div class="chips">${chips.map(([value, text]) => `<div class="chip"><b>${esc(value)}</b><span>${esc(text)}</span></div>`).join('')}</div></div>
<div class="how">${steps.map(([title, text]) => `<div class="step"><b>${esc(title)}</b><span>${esc(text)}</span></div>`).join('')}</div>
${body}
<div class="learned"><h2>What we learned</h2><ul>${learned.map((line) => `<li>${esc(line)}</li>`).join('')}</ul></div>
<div class="credit">Approach borrowed from n8n’s LangTracer: real scenarios, state-based grading, an independent judge, pass@k and pass^k, failure attribution and human review. Every model ran at Nod’s shipped reasoning setting (high). The full suite has ${suite.total} scenarios; ${suite.calibrating} are still being calibrated and ${suite.gaps} are stretch goals Nod cannot do yet. Judge: ${esc(first.judge.split('/').pop() ?? '')}. Code: evals/ in n8n-io/nod.</div>
</div><script>document.title=String(document.documentElement.scrollHeight)</script>`;
  return { id: '00-the-story', html: `<style>${extra}</style>${html}` };
}
