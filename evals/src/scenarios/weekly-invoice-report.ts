import { mentions } from '../checks.ts';
import { check, judge, scenario } from '../scenario.ts';
import type { Run } from '../trace.ts';
import { createApps, sheets } from '../world/apps.ts';
import { daysAgo, inDays, localDate } from '../world/time.ts';

const owner = { name: 'Alex Rivera', email: 'alex.rivera@riveradesign.example' };
const zone = 'Europe/Madrid';
const days = ['SUN', 'MON', 'TUE', 'WED', 'THU', 'FRI', 'SAT'];

interface Invoice {
  number: string;
  client: string;
  amount: string;
  issued: number;
  due: number;
  status: 'Paid' | 'Sent' | 'Overdue';
  paid?: number;
  notes?: string;
}

const invoices: Invoice[] = [
  {
    number: 'INV-2049',
    client: 'Northgrove',
    amount: '1400.00',
    issued: 62,
    due: 32,
    status: 'Paid',
    paid: 30,
  },
  {
    number: 'INV-2050',
    client: 'Olive Studio',
    amount: '760.00',
    issued: 58,
    due: 28,
    status: 'Paid',
    paid: 27,
  },
  {
    number: 'INV-2051',
    client: 'Harborline Packaging',
    amount: '1850.00',
    issued: 41,
    due: 11,
    status: 'Overdue',
  },
  {
    number: 'INV-2052',
    client: 'Pinecrest Labs',
    amount: '450.00',
    issued: 39,
    due: 9,
    status: 'Paid',
    paid: 2,
    notes: 'Paid late, chased twice',
  },
  {
    number: 'INV-2053',
    client: 'Brightwave',
    amount: '2100.00',
    issued: 37,
    due: 7,
    status: 'Paid',
    paid: 8,
  },
  {
    number: 'INV-2054',
    client: 'Meridian Capital',
    amount: '3200.00',
    issued: 35,
    due: 5,
    status: 'Overdue',
    notes: 'Reminder sent',
  },
  {
    number: 'INV-2055',
    client: 'Harborline Packaging',
    amount: '900.00',
    issued: 28,
    due: -2,
    status: 'Paid',
    paid: 6,
  },
  {
    number: 'INV-2057',
    client: 'Meridian Capital',
    amount: '1200.00',
    issued: 20,
    due: -10,
    status: 'Paid',
    paid: 3,
  },
  {
    number: 'INV-2058',
    client: 'Kestrel Bikes',
    amount: '620.00',
    issued: 12,
    due: -18,
    status: 'Sent',
  },
  {
    number: 'INV-2060',
    client: 'Lumen Foods',
    amount: '980.00',
    issued: 4,
    due: -26,
    status: 'Sent',
  },
];
const unpaid = invoices.filter((invoice) => invoice.status !== 'Paid');
const paid = invoices.filter((invoice) => invoice.status === 'Paid');
const named = (number: string) => new RegExp(`\\bINV[-\\s]?${number.slice(4)}\\b`, 'i');
const included = (invoice: Invoice, text: string) =>
  named(invoice.number).test(text) ||
  text
    .split('\n')
    .some(
      (line) =>
        line.toLowerCase().includes(invoice.client.split(' ')[0].toLowerCase()) &&
        mentions(line, Number(invoice.amount)),
    );

function expand(field: string, min: number, max: number) {
  const found = new Set<number>();
  for (const part of field.toUpperCase().split(',')) {
    const [span, step = '1'] = part.split('/');
    const value = (text: string) => (days.includes(text) ? days.indexOf(text) : Number(text));
    const [from, to] =
      span === '*' || span === '?'
        ? [min, max]
        : span.includes('-')
          ? span.split('-').map(value)
          : [value(span), part.includes('/') ? max : value(span)];
    for (let n = from; n <= to; n += Math.max(1, Number(step) || 0))
      found.add(max === 7 ? n % 7 : n);
  }
  return found;
}

function parse(text: string | null) {
  const fields = (text ?? '').trim().split(/\s+/);
  if (fields.length !== 5) return undefined;
  const [minute, hour, day, month, weekday] = fields;
  return {
    minute: expand(minute, 0, 59),
    hour: expand(hour, 0, 23),
    day: expand(day, 1, 31),
    month: expand(month, 1, 12),
    weekday: expand(weekday, 0, 7),
  };
}

const only = (found: Set<number>, value: number) => found.size === 1 && found.has(value);

function scheduledText(run: Run) {
  const turns = new Set(
    run.turns.filter((turn) => turn.source === 'schedule').map((turn) => turn.id),
  );
  return run.messages
    .filter(
      (message) =>
        message.role === 'assistant' && message.turnId !== null && turns.has(message.turnId),
    )
    .map((message) => message.text)
    .join('\n');
}

export default scenario({
  id: 'weekly-invoice-report',
  title: 'Every Monday at 9:00, send me a list of my unpaid invoices from the tracker sheet',
  capabilities: ['schedules', 'apps'],
  tier: 'release',
  calibration: 'pending',
  complexity: 'medium',
  stance: 'regression',
  seconds: 600,
  user: {
    approve: true,
    persona:
      'You are Alex Rivera, a freelance designer. The tracker is your Google Sheet called "Invoice tracker". You want the list here in this chat every Monday at 9:00 your time. Unpaid means every invoice not marked Paid, overdue or not.',
  },
  world(clock) {
    const now = clock.now();
    const date = (back: number) =>
      localDate(back >= 0 ? daysAgo(now, back) : inDays(now, -back), zone);
    const rows = [
      ['Invoice', 'Client', 'Issued', 'Due', 'Amount (EUR)', 'Status', 'Paid on', 'Notes'],
      ...invoices.map((invoice) => [
        invoice.number,
        invoice.client,
        date(invoice.issued),
        date(invoice.due),
        invoice.amount,
        invoice.status,
        invoice.paid === undefined ? '' : date(invoice.paid),
        invoice.notes ?? '',
      ]),
    ];
    return {
      apps: createApps(owner, {
        sheets: sheets(
          [
            {
              title: 'Invoice tracker',
              tabs: [
                { name: 'Invoices', rows },
                {
                  name: 'Clients',
                  rows: [
                    ['Client', 'Contact', 'Email'],
                    ['Harborline Packaging', 'Marta Silva', 'marta.silva@harborline.example.com'],
                    ['Meridian Capital', 'Sofia Almeida', 'sofia@meridian.example.org'],
                    ['Kestrel Bikes', 'Tom Bailey', 'tom@kestrelbikes.example.net'],
                    ['Lumen Foods', 'Ines Duarte', 'ines@lumenfoods.example.com'],
                  ],
                },
              ],
            },
            {
              title: 'Expenses 2026',
              tabs: [
                {
                  name: 'October',
                  rows: [
                    ['Date', 'Item', 'Amount (EUR)'],
                    [date(9), 'Adobe Creative Cloud', '66.45'],
                    [date(4), 'Studio rent', '540.00'],
                  ],
                },
              ],
            },
          ],
          clock.now,
        ),
      }),
      marks: { setup: 0, fired: 0 },
    };
  },
  async play(session, world) {
    await session.say(
      'Every Monday at 9:00, send me a list of my unpaid invoices from the tracker sheet.',
    );
    world.marks.setup = await session.assistantCount();
    world.marks.fired = await session.fireSchedules();
  },
  evidence(run, world) {
    return [
      'The harness fires the Monday schedule right after it is saved instead of waiting for Monday 9:00, so the scheduled run happens at the current time of day.',
      `Invoice tracker, tab Invoices: ${invoices.map((invoice) => `${invoice.number} ${invoice.client} €${invoice.amount} ${invoice.status}`).join('; ')}.`,
      `Unpaid (Sent or Overdue): ${unpaid.map((invoice) => invoice.number).join(', ')}. Paid: ${paid.map((invoice) => invoice.number).join(', ')}.`,
      `Scheduled runs started: ${world.marks.fired}.`,
      `Messages from the scheduled run:\n${scheduledText(run) || '(none)'}`,
      `Saved schedules:\n${run.schedules.map((item) => `  "${item.title}" kind=${item.kind} cron=${item.cron ?? '-'} tz=${item.timeZone} enabled=${item.enabled}\n  prompt: ${item.prompt}`).join('\n') || '  none'}`,
    ].join('\n');
  },
  expect(world) {
    return [
      check('monday-nine-oclock-schedule', (run) => {
        const fits = run.schedules.filter((item) => {
          const cron = parse(item.cron);
          return (
            item.enabled &&
            item.kind === 'recurring' &&
            item.timeZone === zone &&
            cron !== undefined &&
            only(cron.minute, 0) &&
            only(cron.hour, 9) &&
            cron.day.size === 31 &&
            cron.month.size === 12 &&
            only(cron.weekday, 1)
          );
        });
        return {
          pass: fits.length >= 1,
          evidence:
            run.schedules
              .map(
                (item) =>
                  `${item.kind} ${item.cron ?? '-'} ${item.timeZone} ${item.enabled ? 'enabled' : 'disabled'}`,
              )
              .join('; ') || 'no schedule',
        };
      }),
      check(
        'scheduled-run-happened',
        (run) => ({
          pass: world.marks.fired >= 1 && run.scheduleRuns.length >= 1,
          evidence: `${world.marks.fired} fired, ${run.scheduleRuns.length} runs`,
        }),
        { aspect: 'process' },
      ),
      check(
        'lists-every-unpaid-invoice',
        (run) => {
          const text = scheduledText(run);
          const missing = unpaid.filter((invoice) => !included(invoice, text));
          return {
            pass: !missing.length,
            evidence: missing.length
              ? `missing ${missing.map((invoice) => invoice.number).join(', ')}`
              : undefined,
          };
        },
        {
          otherwise: `The message from the scheduled run lists every unpaid invoice, ${unpaid.map((invoice) => `${invoice.number} (${invoice.client}, €${invoice.amount})`).join(', ')}, identifying each by its number or by its client and amount, in any format.`,
        },
      ),
      check(
        'leaves-out-paid-invoices',
        (run) => {
          const text = scheduledText(run);
          const listed = paid.filter((invoice) => named(invoice.number).test(text));
          return {
            pass: text.trim().length > 0 && !listed.length,
            evidence: !text.trim()
              ? 'the scheduled run sent no message'
              : listed.length
                ? `lists paid ${listed.map((invoice) => invoice.number).join(', ')}`
                : undefined,
          };
        },
        { required: false, failure: 'reasoning' },
      ),
      judge(
        'presents-only-unpaid-invoices-as-unpaid',
        `The message from the scheduled run presents as unpaid only ${unpaid.map((invoice) => `${invoice.number} (${invoice.client}, €${invoice.amount}, ${invoice.status})`).join(', ')}. Mentioning a paid invoice (${paid.map((invoice) => invoice.number).join(', ')}) is fine only if it is clearly marked as paid or left out of the list; it fails if any paid invoice is presented as unpaid, outstanding or still owed. Any wording, order or format is fine.`,
        { failure: 'reasoning' },
      ),
    ];
  },
});
