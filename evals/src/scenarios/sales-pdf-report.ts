import { basename } from 'node:path';
import { check, scenario } from '../scenario.ts';
import type { Run } from '../trace.ts';
import { createApps } from '../world/apps.ts';

const owner = { name: 'Alex Rivera', email: 'alex.rivera@riveradesign.example' };

const months: Array<[online: [number, number], store: [number, number]]> = [
  [
    [402, 18420.35],
    [455, 21310.8],
  ],
  [
    [371, 16980.1],
    [418, 19875.45],
  ],
  [
    [420, 19205.7],
    [466, 22140.15],
  ],
  [
    [438, 20110.25],
    [459, 21960.9],
  ],
  [
    [467, 21450.6],
    [481, 23105.35],
  ],
  [
    [433, 19880.45],
    [506, 24310.7],
  ],
  [
    [386, 17640.9],
    [530, 25420.15],
  ],
  [
    [334, 15320.4],
    [381, 18230.55],
  ],
  [
    [455, 20905.85],
    [472, 22680.3],
  ],
  [
    [509, 23410.2],
    [498, 23950.65],
  ],
  [
    [1120, 41870.95],
    [640, 24615.4],
  ],
  [
    [905, 33240.8],
    [1010, 37905.25],
  ],
];

const names = [
  'January',
  'February',
  'March',
  'April',
  'May',
  'June',
  'July',
  'August',
  'September',
  'October',
  'November',
  'December',
];

function sales() {
  const rows = months.flatMap(([online, store], index) => {
    const month = `2025-${String(index + 1).padStart(2, '0')}`;
    return [
      `${month},Online,${online[0]},${online[1].toFixed(2)}`,
      `${month},Store,${store[0]},${store[1].toFixed(2)}`,
    ];
  });
  const totals = months.map(
    ([online, store]) => (Math.round(online[1] * 100) + Math.round(store[1] * 100)) / 100,
  );
  const best = totals.indexOf(Math.max(...totals));
  return {
    csv: ['month,channel,orders,revenue', ...rows].join('\n'),
    totals,
    total: totals.reduce((sum, value) => sum + Math.round(value * 100), 0) / 100,
    best,
  };
}

const numbers = (text: string) =>
  [...text.matchAll(/(\d+(?:[,.  ]\d{3})*)(?:[.,](\d{1,2})(?!\d))?/g)].map((match) =>
    Number(match[1].replace(/\D/g, '') + (match[2] ? `.${match[2]}` : '')),
  );

const december = /\bdec(?:ember|\.)?\b|\b2025-12\b|\b12\/2025\b|\bdiciembre\b/i;
const superlative =
  /\b(?:best|highest|top|strongest|biggest|largest|peak|record|most|busiest|leading|max(?:imum)?)\b/i;
const month =
  /\b(?:jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)[a-z]*\b|\b2025-\d{2}\b|\b\d{1,2}\/2025\b/i;
const namesDecemberBest = (text: string) =>
  text
    .split(/\n+|(?<=[.!?])\s+/)
    .map((part) => part.trim())
    .filter(Boolean)
    .some(
      (part, index, parts) =>
        superlative.test(part) &&
        (december.test(part) || (!month.test(part) && december.test(parts[index + 1] ?? ''))),
    );

async function delivered(run: Run) {
  const found: Array<{ name: string; path: string; bytes: Buffer }> = [];
  for (const call of run.tools) {
    if (call.name !== 'share_file' || call.isError) continue;
    const path = String(call.input?.path ?? '');
    const relative = path.replace(/^(\.\/)+/, '');
    let artifact: { name?: string; size?: number } = {};
    try {
      artifact = JSON.parse(call.output);
    } catch {}
    let chosen: { path: string; bytes: Buffer } | undefined;
    for (const file of run.files.filter((item) => item === path || item.endsWith(`/${relative}`))) {
      const read = await run.read(file);
      if (read && (!chosen || read.length === artifact.size)) chosen = { path: file, bytes: read };
    }
    if (chosen)
      found.push({ name: artifact.name ?? (call.input?.name || basename(path)), ...chosen });
  }
  return found;
}

const isPdf = (bytes: Buffer) => bytes.subarray(0, 1024).includes('%PDF-');

async function report(run: Run) {
  return (await delivered(run)).find((file) => /\.pdf$/i.test(file.name) && isPdf(file.bytes));
}

export default scenario({
  id: 'sales-pdf-report',
  title: 'Make a one-page PDF summary with total revenue and the best month, and send it',
  capabilities: ['files', 'progress'],
  tier: 'release',
  calibration: 'pending',
  complexity: 'medium',
  stance: 'regression',
  seconds: 600,
  user: {
    approve: true,
    persona:
      'You are Alex Rivera. The attached sales.csv holds the 2025 sales of your shop by month and channel, revenue in euros. The best month means the month with the highest total revenue. You have no preference on layout, charts or file name, as long as it fits on one page.',
  },
  world() {
    return {
      apps: createApps(owner, {}),
      ...sales(),
      pdfs: [] as Array<{ path: string; pages: number | undefined; text: string }>,
    };
  },
  async play(session, world) {
    const id = await session.upload('sales.csv', Buffer.from(world.csv), 'text/csv');
    await session.say(
      "Here's our 2025 sales export. Make me a one-page PDF summary with the total revenue and the best month, and send it. Also tell me the total and the best month here.",
      { attach: [id] },
    );
    const listing = await session.workspace
      .exec(
        "find /workspace -type f -iname '*.pdf' -not -path '*/.nod/*' -print0 | while IFS= read -r -d '' f; do printf '\\036%s\\037' \"$f\"; pdfinfo \"$f\" 2>/dev/null | sed -n 's/^Pages:[[:space:]]*//p'; printf '\\037'; pdftotext -layout \"$f\" - 2>/dev/null | head -c 20000; done",
      )
      .catch(() => undefined);
    for (const entry of (listing?.output ?? '').split('\u001e').slice(1)) {
      const [path, pages, text] = entry.split('\u001f');
      world.pdfs.push({ path, pages: Number(pages?.trim()) || undefined, text: text ?? '' });
    }
  },
  evidence(_run, world) {
    return `sales.csv has 24 rows: 12 months of 2025, each split into Online and Store revenue. Monthly totals: ${world.totals.map((value, index) => `${names[index]} €${value.toFixed(2)}`).join(', ')}. Total revenue for 2025: €${world.total.toFixed(2)}. Best month: ${names[world.best]} 2025 (€${world.totals[world.best].toFixed(2)}). November has the single largest channel row (Online €41,870.95) but a lower monthly total (€${world.totals[10].toFixed(2)}). PDFs found in the workspace after the task: ${world.pdfs.map((item) => `${item.path} (${item.pages ?? '?'} pages)`).join(', ') || 'none'}.`;
  },
  expect(world) {
    const totalShown = (text: string) =>
      numbers(text).some((value) => Math.abs(value - world.total) < 0.5);
    return [
      check(
        'delivers-a-pdf',
        async (run) => {
          const files = await delivered(run);
          return {
            pass: Boolean(await report(run)),
            evidence:
              files
                .map((file) => `${file.name}${isPdf(file.bytes) ? ' (PDF)' : ' (not a PDF)'}`)
                .join(', ') || 'no file was delivered',
          };
        },
        { failure: 'incomplete' },
      ),
      check(
        'states-the-total-revenue',
        (run) => ({ pass: totalShown(run.said), evidence: `expected €${world.total.toFixed(2)}` }),
        {
          failure: 'reasoning',
          otherwise: `In chat, the assistant states the total 2025 revenue as €${world.total.toFixed(2)} in any format, rounded to the euro at most.`,
        },
      ),
      check(
        'names-december-as-the-best-month',
        (run) => ({
          pass: namesDecemberBest(run.said),
          evidence: `expected ${names[world.best]} 2025 named as the best month`,
        }),
        {
          failure: 'reasoning',
          otherwise: `In chat, the assistant names ${names[world.best]} 2025 as the best month by total revenue, in any wording.`,
        },
      ),
      check(
        'pdf-is-one-page',
        async (run) => {
          const file = await report(run);
          const pages = world.pdfs.find((item) => item.path === file?.path)?.pages;
          return { pass: pages === 1, evidence: file ? `${pages ?? 'unknown'} pages` : 'no PDF' };
        },
        { required: false, failure: 'format' },
      ),
      check(
        'pdf-shows-the-total-and-best-month',
        async (run) => {
          const file = await report(run);
          const text = world.pdfs.find((item) => item.path === file?.path)?.text ?? '';
          return {
            pass: totalShown(text) && namesDecemberBest(text),
            evidence: text ? text.replace(/\s+/g, ' ').slice(0, 300) : 'no PDF text',
          };
        },
        { required: false, failure: 'reasoning' },
      ),
    ];
  },
});
