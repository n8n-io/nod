import { noWrites } from '../checks.ts';
import { check, judge, scenario } from '../scenario.ts';
import { createApps, sheets } from '../world/apps.ts';
import { daysAgo, localDate, localTime } from '../world/time.ts';

const owner = { name: 'Alex Rivera', email: 'alex.rivera@riveradesign.example' };
const budget: Record<string, number> = {
  Groceries: 400,
  Dining: 150,
  Transport: 90,
  Entertainment: 80,
  Health: 60,
};

interface Row {
  at: number;
  category: string;
  merchant: string;
  amount: number;
}

function transactions(now: number): Row[] {
  const monthStart =
    localTime(now, 0, 0, 'Europe/Madrid', 5) -
    (Number(
      new Intl.DateTimeFormat('en-GB', { day: 'numeric', timeZone: 'Europe/Madrid' }).format(now),
    ) -
      1) *
      86_400_000;
  const recent = (days: number, category: string, merchant: string, amount: number): Row => ({
    at: daysAgo(now, days) - 3 * 3_600_000,
    category,
    merchant,
    amount,
  });
  return [
    { at: monthStart, category: 'Dining', merchant: 'Restaurante Lúcio', amount: 190 },
    { at: monthStart + 3_600_000, category: 'Groceries', merchant: 'Mercadona', amount: 92.3 },
    {
      at: monthStart + 7_200_000,
      category: 'Transport',
      merchant: 'Metro monthly pass',
      amount: 40,
    },
    { at: monthStart + 10_800_000, category: 'Health', merchant: 'Farmacia Central', amount: 18.9 },
    recent(0, 'Groceries', 'Mercadona', 34.2),
    recent(2, 'Groceries', 'Lidl', 58.75),
    recent(5, 'Groceries', 'Mercadona', 21.1),
    recent(1, 'Dining', 'Café Central', 27.5),
    recent(3, 'Dining', 'Tasca do Zé', 42),
    recent(2, 'Transport', 'Taxi', 12.4),
    recent(4, 'Transport', 'Metro top-up', 8.6),
    recent(3, 'Entertainment', 'Cinema Nimas', 15.99),
    recent(6, 'Entertainment', 'Streaming service', 11.99),
    recent(9, 'Dining', 'Pizzeria Napoli', 55),
    recent(10, 'Groceries', 'Pingo Doce', 77.4),
    recent(14, 'Entertainment', 'Concert tickets', 48),
    recent(12, 'Health', 'Dentist copay', 25),
    recent(20, 'Groceries', 'Mercadona', 66.8),
    recent(32, 'Dining', 'Sushi Bar', 61),
    recent(40, 'Groceries', 'Lidl', 88),
  ].sort((a, b) => a.at - b.at);
}

const iso = (at: number) => localDate(at);
const money = (value: number) => value.toFixed(2);

export default scenario({
  id: 'finance-sheet',
  title: 'Spending by category vs budget from my sheet, then a daily check',
  linear: 'LAB-380',
  capabilities: ['apps', 'files', 'schedules', 'approvals'],
  tier: 'full',
  complexity: 'complex',
  stance: 'regression',
  seconds: 720,
  user: {
    approve: true,
    persona:
      'You are Alex Rivera. For the daily check you want it every morning around 8:00 in your time zone, and you only want a message when you are over a monthly budget. "Last 7 days" means the seven days up to now.',
  },
  world(clock) {
    const now = clock.now();
    const rows = transactions(now);
    const month = new Intl.DateTimeFormat('en-GB', {
      month: 'numeric',
      year: 'numeric',
      timeZone: 'Europe/Madrid',
    }).format(now);
    const week: Record<string, number> = {};
    const monthToDate: Record<string, number> = {};
    for (const row of rows) {
      if (row.at >= now - 7 * 86_400_000 && row.at <= now)
        week[row.category] = (week[row.category] ?? 0) + row.amount;
      if (
        new Intl.DateTimeFormat('en-GB', {
          month: 'numeric',
          year: 'numeric',
          timeZone: 'Europe/Madrid',
        }).format(row.at) === month &&
        row.at <= now
      )
        monthToDate[row.category] = (monthToDate[row.category] ?? 0) + row.amount;
    }
    const over = Object.keys(budget).filter(
      (category) => (monthToDate[category] ?? 0) > budget[category],
    );
    const book = {
      title: 'Spending 2026',
      tabs: [
        {
          name: 'Transactions',
          rows: [
            ['Date', 'Category', 'Merchant', 'Amount EUR'],
            ...rows.map((row) => [iso(row.at), row.category, row.merchant, money(row.amount)]),
          ],
        },
        {
          name: 'Budget',
          rows: [
            ['Category', 'Monthly budget EUR'],
            ...Object.entries(budget).map(([category, amount]) => [category, money(amount)]),
          ],
        },
      ],
    };
    const archive = {
      title: 'Spending 2025 (archive)',
      tabs: [
        {
          name: 'Transactions',
          rows: [
            ['Date', 'Category', 'Merchant', 'Amount EUR'],
            ['2025-11-04', 'Groceries', 'Mercadona', '71.20'],
            ['2025-11-05', 'Dining', 'Café Central', '33.00'],
            ['2025-11-07', 'Transport', 'Taxi', '19.50'],
          ],
        },
        {
          name: 'Budget',
          rows: [
            ['Category', 'Monthly budget EUR'],
            ['Groceries', '350.00'],
            ['Dining', '120.00'],
            ['Transport', '80.00'],
          ],
        },
      ],
    };
    return {
      apps: createApps(owner, { sheets: sheets([book, archive], clock.now) }),
      week,
      monthToDate,
      over,
    };
  },
  async play(session) {
    await session.say(
      "Using my spending Google Sheet, tell me what I spent in the last 7 days by category and how that compares with my monthly budget. Then check it every morning and tell me if I'm over.",
    );
  },
  evidence(run, world) {
    const fmt = (values: Record<string, number>) =>
      Object.entries(values)
        .map(([category, value]) => `${category} ${money(value)}`)
        .join(', ');
    return [
      `Correct last-7-day totals: ${fmt(world.week)}.`,
      `Correct month-to-date totals: ${fmt(world.monthToDate)}. Monthly budgets: ${fmt(budget)}.`,
      `Categories over their monthly budget so far this month: ${world.over.join(', ') || 'none'}.`,
      `Saved schedules:\n${run.schedules.map((item) => `  "${item.title}" ${item.kind} cron=${item.cron ?? '-'} tz=${item.timeZone} enabled=${item.enabled}\n  prompt: ${item.prompt}`).join('\n') || '  none'}`,
    ].join('\n');
  },
  expect(world) {
    return [
      check(
        'reads-the-right-spreadsheet',
        (run) => {
          const book = (run.apps?.sheets?.books ?? []).find(
            (item) => item.title === 'Spending 2026',
          );
          const reads = (run.apps?.calls ?? []).filter(
            (call) =>
              call.slug === 'GOOGLESHEETS_BATCH_GET' &&
              !call.error &&
              Boolean(book) &&
              String(call.args.spreadsheet_id).includes(book!.id),
          );
          return {
            pass: reads.length > 0,
            evidence: `${reads.length} successful range reads of Spending 2026`,
          };
        },
        { aspect: 'process', failure: 'tool' },
      ),
      judge(
        'weekly-totals-are-exact',
        `For the last 7 days, the messages the user saw give each category's spending as: ${Object.entries(
          world.week,
        )
          .map(([category, total]) => `${category} €${money(total)}`)
          .join(
            ', ',
          )}. Any format is fine (table, list or prose), as is rounding to the nearest euro. A figure attached to the wrong category, a wrong total, or a total for another period such as month-to-date fails. A category with no spending in the last 7 days may be left out or shown as zero.`,
        { failure: 'reasoning' },
      ),
      judge(
        'identifies-the-sheet-it-used',
        'In the messages the user saw, the assistant makes clear which spreadsheet the figures came from: the one titled "Spending 2026" (naming it or linking to it both count). It must not present the figures as coming from "Spending 2025 (archive)" or leave the user unable to tell which of the two sheets was used.',
        { failure: 'hallucination', required: false },
      ),
      check(
        'creates-a-daily-morning-schedule',
        (run) => {
          const schedule = run.schedules.find((item) => item.enabled && item.cron);
          const match = schedule && /^(\d+) (\d+) \* \* \*$/.exec(schedule.cron!);
          return {
            pass:
              Boolean(match) &&
              Number(match![2]) >= 5 &&
              Number(match![2]) <= 10 &&
              schedule!.timeZone === 'Europe/Madrid',
            evidence: schedule
              ? `cron ${schedule.cron} ${schedule.timeZone}`
              : 'no recurring schedule',
          };
        },
        { failure: 'incomplete' },
      ),
      noWrites('create', 'update', 'post', 'send', 'delete'),
      judge(
        'comparison-with-budget-is-right',
        `In the messages the user saw, spending is compared with each category's monthly budget correctly, and the categories over budget so far this month are identified as: ${world.over.join(', ') || 'none'}. Any format and any wording is fine. It must not call a category over budget when it is not, and the period used for the comparison must be stated or clear from the figures.`,
        { failure: 'reasoning' },
      ),
      judge(
        'schedule-prompt-can-run-alone',
        'The saved schedule prompt is complete enough to run later without this conversation: it names the spreadsheet (Spending 2026) and enough about where the data sits to find it, says to compare month-to-date spending with the monthly budget per category, or another comparison only if the user explicitly changed the recurring check to it, and says to message the user only when that comparison is over budget and otherwise stay silent.',
        { aspect: 'process', failure: 'incomplete' },
      ),
    ];
  },
});
