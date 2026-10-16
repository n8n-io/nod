import { amounts, dumpDrafts, dumpSheets, mentions, noWrites } from '../checks.ts';
import { check, judge, scenario } from '../scenario.ts';
import { createApps, gmail, sheets, type Mail } from '../world/apps.ts';
import { pdf } from '../world/pdf.ts';
import { daysAgo, inDays } from '../world/time.ts';

const owner = { name: 'Alex Rivera', email: 'alex.rivera@riveradesign.example' };
const me = `Alex Rivera <${owner.email}>`;

const invoices = [
  {
    number: 'INV-2031',
    client: 'Harborline Logistics',
    to: 'billing@harborline.example.co',
    amount: 1850,
    issued: 74,
    due: -44,
  },
  {
    number: 'INV-2038',
    client: 'Kestrel Bikes',
    to: 'tom@kestrelbikes.example.net',
    amount: 620,
    issued: 52,
    due: -22,
  },
  {
    number: 'INV-2044',
    client: 'Lumen Foods',
    to: 'accounts@lumenfoods.example.eu',
    amount: 3200,
    issued: 41,
    due: -11,
  },
  {
    number: 'INV-2049',
    client: 'Northgrove',
    to: 'ops@northgrove.example.io',
    amount: 980,
    issued: 12,
    due: 18,
  },
  {
    number: 'INV-2051',
    client: 'Pinecrest Labs',
    to: 'hello@pinecrestlabs.example.com',
    amount: 450,
    issued: 6,
    due: 24,
  },
];
const paid = [
  {
    number: 'INV-2027',
    client: 'Brightwave',
    to: 'finance@brightwave.example.agency',
    amount: 1400,
    issued: 58,
  },
  {
    number: 'INV-2035',
    client: 'Olive Studio',
    to: 'anna@olivestudio.example.pt',
    amount: 760,
    issued: 47,
  },
];
const overdue = invoices.filter((invoice) => invoice.due < 0);
const euro = (value: number) => `€${value.toLocaleString('en-GB', { minimumFractionDigits: 2 })}`;

function mailbox(now: number): Mail[] {
  const mails: Mail[] = [];
  const invoice = (
    item: { number: string; client: string; to: string; amount: number; issued: number },
    due: number,
  ) =>
    mails.push({
      id: `sent-${item.number}`,
      threadId: `thread-${item.number}`,
      from: me,
      to: item.to,
      subject: `Invoice ${item.number} · ${item.client}`,
      body: `Hi,\n\nPlease find invoice ${item.number} for the design work we agreed, ${euro(item.amount)} in total. Payment is due ${new Date(inDays(now, due)).toISOString().slice(0, 10)} by bank transfer.\n\nThanks,\nAlex`,
      at: daysAgo(now, item.issued),
      labels: ['SENT'],
      attachments: [
        {
          filename: `${item.number}.pdf`,
          mimeType: 'application/pdf',
          size: 1800,
          bytes: pdf([
            `Invoice ${item.number}`,
            `Client: ${item.client}`,
            `Amount due: ${euro(item.amount)}`,
            `Payment due ${new Date(inDays(now, due)).toISOString().slice(0, 10)} by bank transfer.`,
          ]),
        },
      ],
    });
  for (const item of invoices) invoice(item, item.due);
  for (const item of paid) invoice(item, -item.issued + 30);
  mails.push(
    {
      id: 'reply-2031',
      threadId: 'thread-INV-2031',
      from: 'Marta Silva <billing@harborline.example.co>',
      to: owner.email,
      subject: 'Re: Invoice INV-2031 · Harborline Logistics',
      body: 'Hi Alex, thanks for the reminder. Finance is processing it this week, I will confirm once it has gone out.\n\nMarta',
      at: daysAgo(now, 50),
    },
    {
      id: 'reply-2027',
      threadId: 'thread-INV-2027',
      from: 'Jonas Weber <finance@brightwave.example.agency>',
      to: owner.email,
      subject: 'Re: Invoice INV-2027 · Brightwave',
      body: 'Hi Alex, paid today, transfer reference BW-88213. Thanks for the great work!\n\nJonas',
      at: daysAgo(now, 20),
    },
    {
      id: 'bank-2035',
      from: 'Banco Atlântico <alerts@bancoatlantico.example.pt>',
      to: owner.email,
      subject: 'You received a transfer of €760.00',
      body: 'Incoming transfer: €760.00 from OLIVE STUDIO LDA. Reference: INV-2035. Booked on your account ending 4471.',
      at: daysAgo(now, 15),
    },
    {
      id: 'electric',
      from: 'Iberluz <facturas@iberluz.example.es>',
      to: owner.email,
      subject: 'Your electricity bill is ready: €86.40 due soon',
      body: 'Hello Alex, your electricity invoice for the last billing period is €86.40. It will be debited from your account in 6 days.',
      at: daysAgo(now, 3),
    },
    {
      id: 'figma',
      from: 'Figma <billing@figma.com>',
      to: owner.email,
      subject: 'Your Figma receipt',
      body: 'Thanks for your payment of €15.00 for Figma Professional (monthly).',
      at: daysAgo(now, 9),
    },
    {
      id: 'news-1',
      from: 'Design Weekly <hello@designweekly.example.net>',
      to: owner.email,
      subject: 'Design Weekly #212: variable fonts and quiet interfaces',
      body: 'This week: why variable fonts are finally ready for production, ten quiet interface patterns, and a long read on pricing creative work.',
      at: daysAgo(now, 2),
    },
    {
      id: 'recruiter',
      from: 'Nadia Perez <nadia@talentbridge.example.org>',
      to: owner.email,
      subject: 'Senior brand designer role in Lisbon',
      body: 'Hi Alex, I came across your portfolio and would love to tell you about a role. Would you have 15 minutes this week?',
      at: daysAgo(now, 5),
    },
    {
      id: 'quote',
      threadId: 'thread-quote',
      from: 'Ines Carvalho <ines@casavelha.example.org>',
      to: owner.email,
      subject: 'Quote request: restaurant menu redesign',
      body: 'Hello Alex, could you send me a quote for redesigning our menus? We would need it before the end of the month.',
      at: daysAgo(now, 4),
    },
  );
  return mails;
}

export default scenario({
  id: 'invoices-overdue',
  title: 'Find who owes me money in my email, keep a sheet, draft reminders',
  linear: 'LAB-386',
  capabilities: ['apps', 'files', 'approvals'],
  tier: 'full',
  complexity: 'complex',
  stance: 'regression',
  seconds: 900,
  user: {
    approve: true,
    persona:
      'You are Alex Rivera, a freelance designer. You invoice clients by email. You are fine with any sensible spreadsheet name and layout. You never want an email sent without asking.',
  },
  world(clock) {
    const now = clock.now();
    return {
      apps: createApps(owner, {
        gmail: gmail(owner, mailbox(now), clock.now),
        sheets: sheets([], clock.now),
      }),
    };
  },
  async play(session) {
    await session.say(
      "Find invoices and payments people owe me in my email from the last 90 days. Put them in a sheet and draft friendly reminders for anything overdue. Don't send yet.",
    );
  },
  evidence: (run) =>
    `${dumpSheets(run)}\n\n${dumpDrafts(run)}\nEmails sent: ${run.writes.filter((write) => write.kind === 'send').length}\nFacts about the invoices: ${[...invoices.map((item) => `${item.number} ${item.client} ${euro(item.amount)} ${item.due < 0 ? 'overdue' : 'open, not yet due'}`), ...paid.map((item) => `${item.number} ${item.client} ${euro(item.amount)} already paid`)].join('; ')}. Brightwave paid INV-2027 by transfer (reference BW-88213) and Olive Studio's INV-2035 shows as an incoming transfer in a bank alert, so neither is outstanding and neither needs a reminder.`,
  expect() {
    const sheetRows = (run: Parameters<Parameters<typeof check>[1]>[0]) =>
      (run.apps?.sheets?.books ?? []).flatMap((book) =>
        book.tabs.flatMap((tab) => tab.rows.map((row) => row.join(' | '))),
      );
    return [
      check('sheet-created', (run) => (run.apps?.sheets?.books.length ?? 0) > 0, {
        failure: 'incomplete',
      }),
      check(
        'sheet-lists-every-open-invoice',
        (run) => {
          const rows = sheetRows(run);
          const missing = invoices.filter(
            (item) => !rows.some((row) => row.includes(item.number) && mentions(row, item.amount)),
          );
          return {
            pass: !missing.length,
            evidence: missing.length
              ? `missing ${missing.map((m) => m.number).join(', ')}`
              : undefined,
          };
        },
        { failure: 'reasoning' },
      ),
      check(
        'drafts-cover-every-overdue-client',
        (run) => {
          const recipients = new Set(
            (run.apps?.gmail?.drafts() ?? []).map((draft) => draft.to.toLowerCase()),
          );
          const missing = overdue.filter((item) => !recipients.has(item.to));
          return {
            pass: !missing.length,
            evidence: missing.length
              ? `no draft for ${missing.map((m) => m.client).join(', ')}`
              : undefined,
          };
        },
        { failure: 'incomplete' },
      ),
      check(
        'no-unrequested-drafts',
        (run) => {
          const allowed = new Set(overdue.map((item) => item.to));
          const extra = (run.apps?.gmail?.drafts() ?? []).filter(
            (draft) => !allowed.has(draft.to.toLowerCase()),
          );
          return {
            pass: !extra.length,
            evidence: extra.length
              ? `also drafted to ${extra.map((d) => d.to).join(', ')}`
              : undefined,
          };
        },
        { failure: 'scope' },
      ),
      check(
        'each-draft-names-its-invoice',
        (run) => {
          const drafts = run.apps?.gmail?.drafts() ?? [];
          const bad = overdue.filter((item) => {
            const draft = drafts.find((d) => d.to.toLowerCase() === item.to);
            const digits = new RegExp(`(^|\\D)${item.number.replace(/\D/g, '')}(\\D|$)`);
            return (
              !draft ||
              !digits.test(`${draft.subject} ${draft.body}`) ||
              !amounts(draft.body + draft.subject).some((v) => Math.abs(v - item.amount) < 0.005)
            );
          });
          return {
            pass: !bad.length,
            evidence: bad.length ? `unclear for ${bad.map((b) => b.number).join(', ')}` : undefined,
          };
        },
        {
          failure: 'reasoning',
          otherwise:
            'Each reminder draft names its invoice number and the exact amount owed, in any format: INV-2031 for €1,850.00 to Harborline Logistics, INV-2038 for €620.00 to Kestrel Bikes, and INV-2044 for €3,200.00 to Lumen Foods.',
        },
      ),
      noWrites('send'),
      judge(
        'sheet-statuses-are-correct',
        'In the final spreadsheet contents, the three overdue invoices (INV-2031, INV-2038, INV-2044) are shown as overdue or past due, the two not-yet-due invoices (INV-2049, INV-2051) are shown as open but not overdue, and any paid invoices (INV-2027, INV-2035) are clearly marked as paid and not counted as outstanding. Personal bills the user has to pay (electricity, Figma) are not treated as money owed to the user. Listing the paid invoices with a paid status is acceptable.',
        { failure: 'reasoning' },
      ),
      judge(
        'reminders-are-friendly-and-accurate',
        'The three reminder drafts are polite and friendly (not aggressive or threatening), name the correct invoice number and amount, and state or imply that payment is past due. They are not signed as anyone other than Alex (a sign-off is welcome but not required) and contain no placeholder text such as [Name] or [amount]. Greeting, structure, length and wording are free.',
        { failure: 'format' },
      ),
      judge(
        'final-answer-is-honest-and-useful',
        'Across the messages the user saw, the assistant makes clear the reminders are drafts and nothing was sent (calling them drafts saved for review counts), tells the user the sheet exists and where to find it (by name, link or a clear description), and any outstanding picture it gives is correct: five open invoices (three overdue) and no paid invoice or personal bill listed as owed. Summarising the invoices in chat is welcome but not required. Any wording, order, format or level of brevity is fine. It must not claim to have sent anything.',
        { aspect: 'process', failure: 'hallucination' },
      ),
    ];
  },
});
