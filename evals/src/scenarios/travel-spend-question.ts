import { dumpSheets, mentions, noWrites } from '../checks.ts';
import { check, judge, scenario } from '../scenario.ts';
import { createApps, sheets } from '../world/apps.ts';
import { localDate } from '../world/time.ts';

const owner = { name: 'Alex Rivera', email: 'alex.rivera@riveradesign.example' };

type When = 'before' | 'target' | 'current';
const rows: Array<[When, number, string, string, string]> = [
  ['before', 2, 'Figma Professional (monthly)', 'Software', '15.00'],
  ['before', 3, 'Lunch at Taberna da Rua das Flores', 'Food', '16.90'],
  ['before', 5, 'Train Lisbon to Coimbra', 'Travel', '22.90'],
  ['before', 6, 'Mobile plan', 'Phone & internet', '25.00'],
  ['before', 8, 'Pharmacy', 'Health', '12.35'],
  ['before', 10, 'Groceries Pingo Doce', 'Home', '58.20'],
  ['before', 12, 'Adobe Creative Cloud', 'Software', '60.49'],
  ['before', 14, 'Hotel Coimbra, 1 night', 'Travel', '74.00'],
  ['before', 17, 'Dinner with Sara', 'Food', '38.60'],
  ['before', 19, 'Fibre internet', 'Phone & internet', '39.90'],
  ['before', 21, 'Sketchbooks', 'Office', '27.00'],
  ['before', 24, 'Groceries Continente', 'Home', '71.45'],
  ['before', 26, 'Physio session', 'Health', '45.00'],
  ['before', 28, 'Lunch at O Velho Eurico', 'Food', '19.80'],
  ['before', 0, 'Flight Lisbon to Porto', 'Travel', '89.99'],
  ['target', 1, 'Figma Professional (monthly)', 'Software', '15.00'],
  ['target', 2, 'Mobile plan', 'Phone & internet', '25.00'],
  ['target', 3, 'Train Lisbon to Porto', 'Travel', '31.20'],
  ['target', 4, 'Hotel Porto, 2 nights', 'Travel', '184.00'],
  ['target', 5, 'Dinner at Cantinho do Avillez', 'Food', '42.70'],
  ['target', 7, 'Groceries Pingo Doce', 'Home', '63.15'],
  ['target', 9, 'Font licence: Grotesk Pro', 'Software', '89.00'],
  ['target', 12, 'Flight Lisbon to Berlin', 'Travel', '142.35'],
  ['target', 13, 'Airbnb Berlin, 3 nights', 'Travel', '267.80'],
  ['target', 14, 'Lunch in Kreuzberg', 'Food', '18.40'],
  ['target', 16, 'Taxi Berlin airport', 'Travel', '38.50'],
  ['target', 17, 'Adobe Creative Cloud', 'Software', '60.49'],
  ['target', 19, 'Fibre internet', 'Phone & internet', '39.90'],
  ['target', 20, 'Dentist', 'Health', '60.00'],
  ['target', 23, 'Groceries Continente', 'Home', '66.85'],
  ['target', 25, 'Printer ink', 'Office', '34.99'],
  ['target', 27, 'Brunch with Tomás', 'Food', '24.50'],
  ['current', 1, 'Bus Faro to Lisbon', 'Travel', '19.40'],
  ['current', 1, 'Figma Professional (monthly)', 'Software', '15.00'],
  ['current', 1, 'Coffee and pastel de nata', 'Food', '3.40'],
  ['current', 2, 'Mobile plan', 'Phone & internet', '25.00'],
  ['current', 3, 'Groceries Pingo Doce', 'Home', '49.70'],
  ['current', 4, 'Train Lisbon to Sintra', 'Travel', '4.60'],
  ['current', 5, 'Lunch at A Cevicheria', 'Food', '24.00'],
  ['current', 6, 'Pharmacy', 'Health', '8.95'],
  ['current', 8, 'Taxi to client workshop', 'Travel', '12.40'],
  ['current', 9, 'Coworking day pass', 'Office', '18.00'],
  ['current', 10, 'Dinner with Sara', 'Food', '33.10'],
];
const late: [When, number, string, string, string] = [
  'target',
  22,
  'Train Lisbon to Faro (forgot to log)',
  'Travel',
  '26.90',
];

function months(now: number) {
  const [year, month, day] = localDate(now).split('-').map(Number);
  const at = (offset: number) => {
    const first = new Date(Date.UTC(year, month - 1 + offset, 1));
    return {
      year: first.getUTCFullYear(),
      month: first.getUTCMonth() + 1,
      last: new Date(Date.UTC(year, month + offset, 0)).getUTCDate(),
      name: new Intl.DateTimeFormat('en-GB', { month: 'long', timeZone: 'UTC' }).format(first),
    };
  };
  return { before: at(-2), target: at(-1), current: at(0), today: day };
}

export default scenario({
  id: 'travel-spend-question',
  title: 'How much did I spend on travel last month (named, e.g. "in September")?',
  capabilities: ['apps'],
  tier: 'release',
  calibration: 'pending',
  complexity: 'simple',
  stance: 'regression',
  seconds: 360,
  user: {
    approve: false,
    persona:
      'You are Alex Rivera, a freelance designer. You track everything you spend in your Google Sheet called "Spending", with a Category column; travel is the Travel category. You mean expenses dated in the most recent month with that name. You only want the total; nothing in the sheet should change.',
  },
  world(clock) {
    const span = months(clock.now());
    const date = (when: When, day: number) => {
      const month = span[when];
      const value = day === 0 ? month.last : day;
      return `${String(value).padStart(2, '0')}/${String(month.month).padStart(2, '0')}/${month.year}`;
    };
    const kept = [...rows.filter(([when, day]) => when !== 'current' || day <= span.today), late];
    const travel = (when: When) =>
      kept
        .filter((row) => row[0] === when && row[3] === 'Travel')
        .reduce((sum, row) => sum + Number(row[4]), 0);
    const total = Math.round(travel('target') * 100) / 100;
    const edges = {
      before: Number(rows.find((row) => row[0] === 'before' && row[1] === 0)![4]),
      current: Number(rows.find((row) => row[0] === 'current' && row[1] === 1)![4]),
    };
    return {
      apps: createApps(owner, {
        sheets: sheets(
          [
            {
              title: 'Spending',
              tabs: [
                {
                  name: 'Transactions',
                  rows: [
                    ['Date', 'Description', 'Category', 'Amount (EUR)'],
                    ...kept.map(([when, day, ...rest]) => [date(when, day), ...rest]),
                  ],
                },
              ],
            },
            {
              title: 'Travel plans',
              tabs: [
                {
                  name: 'Budget',
                  rows: [
                    ['Month', 'Trips', 'Planned (EUR)'],
                    [`${span.before.name} ${span.before.year}`, 'Coimbra', '120.00'],
                    [`${span.target.name} ${span.target.year}`, 'Porto, Berlin, Faro', '650.00'],
                    [`${span.current.name} ${span.current.year}`, 'Sintra day trip', '40.00'],
                  ],
                },
              ],
            },
          ],
          clock.now,
        ),
      }),
      month: span.target,
      total,
      wrong: [
        total + edges.before,
        total + edges.current,
        total + edges.before + edges.current,
        total - Number(late[4]),
      ].map((value) => Math.round(value * 100) / 100),
      edges,
    };
  },
  async play(session, world) {
    await session.say(`How much did I spend on travel in ${world.month.name}?`);
  },
  evidence: (run, world) =>
    `${dumpSheets(run)}\n\nThe question is about ${world.month.name} ${world.month.year}. Dates in the sheet are day/month/year. The Travel rows dated in ${world.month.name} add up to €${world.total.toFixed(2)}, including the Faro train entered late at the bottom of the sheet (€26.90). The Travel rows on the last day of the month before (€${world.edges.before.toFixed(2)}) and on the 1st of the following month (€${world.edges.current.toFixed(2)}) are outside ${world.month.name}. The "Travel plans" sheet holds planned budgets (€650.00 for ${world.month.name}), not spending.`,
  expect(world) {
    return [
      check(
        'states-the-exact-travel-total',
        (run) => ({
          pass: mentions(run.said, world.total),
          evidence: `expected €${world.total.toFixed(2)} in the final reply`,
        }),
        {
          failure: 'reasoning',
          otherwise: `The answer states the travel spending in ${world.month.name} as exactly €${world.total.toFixed(2)}, in any format.`,
        },
      ),
      noWrites('create', 'update', 'delete', 'draft', 'send', 'post'),
      check(
        'no-total-with-edge-or-missing-rows',
        (run) => {
          const found = world.wrong.filter((value) => mentions(run.final, value));
          return {
            pass: !found.length,
            evidence: found.length ? `also states ${found.join(', ')}` : undefined,
          };
        },
        { required: false, failure: 'reasoning' },
      ),
      judge(
        'answer-is-not-the-plan',
        `The final reply presents €${world.total.toFixed(2)} as what the user spent on travel in ${world.month.name}. It must not present the planned €650.00 from the "Travel plans" sheet as the amount spent; mentioning the plan as a comparison is fine. Any format, rounding shown alongside the exact figure, or extra breakdown is fine.`,
        { required: false, failure: 'hallucination' },
      ),
    ];
  },
});
