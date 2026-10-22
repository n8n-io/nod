import { dumpSheets, mentions } from '../checks.ts';
import { check, judge, scenario } from '../scenario.ts';
import type { Run } from '../trace.ts';
import { createApps, gmail, sheets, type Mail } from '../world/apps.ts';
import { localDate, localTime } from '../world/time.ts';

const owner = { name: 'Alex Rivera', email: 'alex.rivera@riveradesign.example' };
const me = `Alex Rivera <${owner.email}>`;
const book = '1vQx7InvoicesTracker2026Rivera';
const archive = '1vQx7InvoiceArchive2025Rivera';
const zone = 'Europe/Madrid';
const day = 86_400_000;

const clients = [
  {
    number: 'INV-3101',
    client: 'Harborline Logistics',
    to: 'billing@harborline.example.co',
    amount: 1840,
  },
  {
    number: 'INV-3102',
    client: 'Kestrel Bikes',
    to: 'tom@kestrelbikes.example.net',
    amount: 2375.5,
  },
  { number: 'INV-3103', client: 'Lumen Foods', to: 'accounts@lumenfoods.example.org', amount: 960 },
  { number: 'INV-3104', client: 'Northgrove', to: 'ops@northgrove.example.com', amount: 4120 },
  {
    number: 'INV-3105',
    client: 'Pinecrest Labs',
    to: 'hello@pinecrestlabs.example.com',
    amount: 615.25,
  },
  { number: 'INV-3106', client: 'Olive Studio', to: 'anna@olivestudio.example.org', amount: 1290 },
  {
    number: 'INV-3107',
    client: 'Brightwave',
    to: 'finance@brightwave.example.net',
    amount: 3450.75,
  },
  { number: 'INV-3108', client: 'Casa Velha', to: 'ines@casavelha.example.org', amount: 780 },
  {
    number: 'INV-3109',
    client: 'Fieldnotes',
    to: 'daniel.ortiz@fieldnotes.example.net',
    amount: 2210.4,
  },
  {
    number: 'INV-3110',
    client: 'Meridian Capital',
    to: 'ap@meridiancapital.example.org',
    amount: 535,
  },
  {
    number: 'INV-3111',
    client: 'Tidewater Hotels',
    to: 'payables@tidewater.example.com',
    amount: 1675.9,
  },
  {
    number: 'INV-3112',
    client: 'Saltmarsh Records',
    to: 'label@saltmarsh.example.net',
    amount: 3980,
  },
];
const previous = [
  {
    number: 'INV-3089',
    client: 'Lumen Foods',
    to: 'accounts@lumenfoods.example.org',
    amount: 1150,
    before: 18,
  },
  {
    number: 'INV-3093',
    client: 'Kestrel Bikes',
    to: 'tom@kestrelbikes.example.net',
    amount: 845.6,
    before: 6,
  },
];

const euro = (value: number) => `€${value.toLocaleString('en-GB', { minimumFractionDigits: 2 })}`;
const longDate = (at: number) =>
  new Intl.DateTimeFormat('en-GB', {
    day: 'numeric',
    month: 'long',
    year: 'numeric',
    timeZone: zone,
  }).format(at);
const months = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec'];

function hasDate(text: string, iso: string) {
  const [year, month, date] = iso.split('-').map(Number);
  const lower = text.toLowerCase();
  const years = `(?:${year}|${String(year).slice(2)})`;
  const name = months[month - 1];
  return (
    lower.includes(iso) ||
    new RegExp(`(^|\\D)0?${date}[/.-]0?${month}[/.-]${years}(\\D|$)`).test(lower) ||
    new RegExp(`(^|\\D)0?${month}[/.-]0?${date}[/.-]${years}(\\D|$)`).test(lower) ||
    new RegExp(`(^|\\D)0?${date}(?:st|nd|rd|th)?\\s+(?:of\\s+)?${name}`).test(lower) ||
    new RegExp(`${name}[a-z]*\\.?\\s+0?${date}(\\D|$)`).test(lower)
  );
}

function quarterStart(now: number) {
  const [year, month, date] = localDate(now, zone).split('-').map(Number);
  const first = Math.floor((month - 1) / 3) * 3;
  const back = Math.round((Date.UTC(year, month - 1, date) - Date.UTC(year, first, 1)) / day);
  return localTime(now, back, 0, zone);
}

const digits = (number: string) => new RegExp(`(^|\\D)${number.replace(/\D/g, '')}(\\D|$)`);

function invoiceMail(
  item: { number: string; client: string; to: string; amount: number },
  at: number,
): Mail {
  return {
    id: `sent-${item.number}`,
    threadId: `thread-${item.number}`,
    from: me,
    to: item.to,
    subject: `Invoice ${item.number} · ${item.client}`,
    body: `Hi,\n\nPlease find invoice ${item.number} for ${item.client}.\n\nAmount: ${euro(item.amount)}\nDue date: ${longDate(at + 30 * day)}\n\nPayment by bank transfer to the account on the invoice.\n\nThanks,\nAlex`,
    at,
    labels: ['SENT'],
  };
}

function build(now: number) {
  const start = quarterStart(now);
  const span = now - start;
  const from = start + Math.min(1.2 * day, span * 0.1);
  const to = now - Math.min(2 * 3_600_000, span * 0.05);
  const invoices = clients.map((item, index) => {
    const at = Math.round(from + ((to - from) * index) / (clients.length - 1));
    return { ...item, at, due: localDate(at + 30 * day, zone) };
  });
  const mails: Mail[] = [
    ...invoices.map((item) => invoiceMail(item, item.at)),
    ...previous.map((item) => invoiceMail(item, start - item.before * day)),
    {
      id: 'reminder-3103',
      threadId: 'thread-INV-3103',
      from: me,
      to: 'accounts@lumenfoods.example.org',
      subject: `Re: Invoice INV-3103 · Lumen Foods`,
      body: `Hi,\n\nA friendly reminder that invoice INV-3103 (${euro(960)}) is due on ${longDate(invoices[2].at + 30 * day)}.\n\nThanks,\nAlex`,
      at: Math.round((invoices[2].at + now) / 2),
      labels: ['SENT'],
    },
    {
      id: 'reply-3106',
      threadId: 'thread-INV-3106',
      from: 'Anna Ferreira <anna@olivestudio.example.org>',
      to: owner.email,
      subject: 'Re: Invoice INV-3106 · Olive Studio',
      body: 'Hi Alex, thanks, received. Finance will pay it with the next batch.\n\nAnna',
      at: Math.round((invoices[5].at + now) / 2),
    },
    {
      id: 'newsletter',
      from: 'Design Weekly <hello@designweekly.example.net>',
      to: owner.email,
      subject: 'Design Weekly #214: pricing creative work',
      body: 'This week: how to price creative work, and invoicing tips for freelancers.',
      at: now - 3 * 3_600_000,
    },
    {
      id: 'recruiter',
      from: 'Nadia Perez <nadia@talentbridge.example.org>',
      to: owner.email,
      subject: 'Senior brand designer role in Lisbon',
      body: 'Hi Alex, would you have 15 minutes this week to hear about a role?',
      at: now - 26 * 3_600_000,
    },
  ];
  return { start, invoices, mails };
}

const invoiceRows = (run: Run) =>
  (run.apps?.sheets?.books.find((item) => item.id === book)?.tabs ?? []).flatMap((tab) =>
    tab.rows.map((row) => row.join(' | ')).filter((row) => /\d{4}/.test(row)),
  );

export default scenario({
  id: 'status-question-mid-task',
  title:
    'Add a row to my Invoices sheet for each invoice email this quarter, and tell me how far along you are',
  capabilities: ['progress', 'apps', 'long-running'],
  tier: 'release',
  complexity: 'medium',
  stance: 'regression',
  seconds: 600,
  calibration: 'pending',
  user: {
    approve: true,
    persona:
      'You are Alex Rivera, a freelance brand designer. You email invoices to your clients from Gmail and track them in the Google Sheet called "Invoices". Any sensible format for amounts and dates is fine. You only want the invoices you sent this quarter.',
  },
  world(clock) {
    const now = clock.now();
    const { start, invoices, mails } = build(now);
    return {
      apps: createApps(owner, {
        gmail: gmail(owner, mails, clock.now),
        sheets: sheets(
          [
            {
              id: book,
              title: 'Invoices',
              tabs: [{ name: 'Invoices', rows: [['Number', 'Client', 'Amount', 'Due date']] }],
            },
            {
              id: archive,
              title: 'Invoice archive 2025',
              tabs: [
                {
                  name: 'Sheet1',
                  rows: [
                    ['Number', 'Client', 'Amount', 'Due date'],
                    ['INV-2031', 'Harborline Logistics', '1850', '2025-11-20'],
                  ],
                },
              ],
            },
          ],
          clock.now,
        ),
      }),
      since: new Intl.DateTimeFormat('en-GB', {
        day: 'numeric',
        month: 'long',
        timeZone: zone,
      }).format(start),
      invoices,
    };
  },
  async play(session, world) {
    await session.sayDuringWithAttachments(
      `For each invoice email from this quarter (since ${world.since}), add a row to my Invoices sheet with number, client, amount and due date.`,
      'How far along are you?',
      [],
    );
  },
  evidence(run, world) {
    return `${dumpSheets(run)}\n\nThe ${world.invoices.length} invoices sent this quarter: ${world.invoices.map((item) => `${item.number} ${item.client} ${euro(item.amount)} due ${item.due}`).join('; ')}. ${previous.map((item) => item.number).join(' and ')} were sent last quarter and do not belong. A reminder about INV-3103 and a client reply about INV-3106 are not new invoices. Midway the user asked "How far along are you?".`;
  },
  expect(world) {
    return [
      check(
        'every-invoice-has-one-row-with-its-amount',
        (run) => {
          const rows = invoiceRows(run);
          const wrong = world.invoices.filter((item) => {
            const found = rows.filter((row) => digits(item.number).test(row));
            return found.length !== 1 || !mentions(found[0], item.amount);
          });
          return {
            pass: !wrong.length,
            evidence: wrong.length
              ? `missing, duplicated or wrong amount: ${wrong.map((item) => item.number).join(', ')}`
              : undefined,
          };
        },
        { failure: 'incomplete' },
      ),
      check(
        'only-this-quarters-invoices',
        (run) => {
          const rows = invoiceRows(run);
          const extra = rows.filter(
            (row) =>
              previous.some((item) => digits(item.number).test(row)) ||
              (/INV-?\s?\d/i.test(row) &&
                !world.invoices.some((item) => digits(item.number).test(row))),
          );
          return {
            pass: !extra.length && rows.length > 0,
            evidence: extra.length
              ? `extra rows: ${extra.join(' ; ').slice(0, 200)}`
              : `${rows.length} rows`,
          };
        },
        { failure: 'reasoning' },
      ),
      check(
        'due-dates-and-clients-filled-in',
        (run) => {
          const rows = invoiceRows(run);
          const wrong = world.invoices.filter((item) => {
            const row = rows.find((line) => digits(item.number).test(line)) ?? '';
            return (
              !hasDate(row, item.due) ||
              !row.toLowerCase().includes(item.client.split(' ')[0].toLowerCase())
            );
          });
          return {
            pass: !wrong.length,
            evidence: wrong.length
              ? `incomplete: ${wrong.map((item) => item.number).join(', ')}`
              : undefined,
          };
        },
        { required: false, failure: 'incomplete' },
      ),
      check(
        'archive-untouched',
        (run) =>
          (run.apps?.sheets?.books.find((item) => item.id === archive)?.tabs ?? []).every(
            (tab) => tab.rows.length === 2,
          ),
        { required: false, aspect: 'process', failure: 'scope' },
      ),
      judge(
        'answers-the-status-question',
        'After the user asked "How far along are you?" while the work was running, the assistant gave a truthful progress update at some point (what it had done or how many invoices were in, or that it had already finished), and carried on with the work instead of stopping or starting over.',
        { required: false, aspect: 'process', failure: 'incomplete' },
      ),
    ];
  },
});
