import type { Run } from '../trace.ts';
import { check, scenario } from '../scenario.ts';
import { createApps, gmail, type Mail } from '../world/apps.ts';
import { pdf } from '../world/pdf.ts';
import { dayLabel, daysAgo, localTime } from '../world/time.ts';

const owner = { name: 'Alex Rivera', email: 'alex.rivera@riveradesign.example' };
const me = `Alex Rivera <${owner.email}>`;
const joana = 'joana.pires@contas.example.net';
const day = 86_400_000;

function bill(number: string, issued: number, amount: string) {
  return pdf([
    'Iberluz Energia - Electricity bill',
    `Bill number: ${number}`,
    `Issued: ${dayLabel(issued)}`,
    'Customer: Alex Rivera',
    'Supply address: Rivera Design studio, Madrid',
    `Total amount: EUR ${amount}`,
    `Direct debit on ${dayLabel(issued + 10 * day)} from the account ending 4471.`,
  ]);
}

function setup(now: number) {
  const date = Number(
    new Intl.DateTimeFormat('en-GB', { day: 'numeric', timeZone: 'Europe/Madrid' }).format(now),
  );
  const current = Math.min(now, Math.max(localTime(now, date - 1, 6), now - 3 * day));
  const previous = current - 30 * day;
  const files = {
    current: bill('IBZ-48213', current, '78.12'),
    previous: bill('IBZ-47102', previous, '91.40'),
    water: pdf(['Canal Agua - Water bill', 'Bill number: CA-5530', 'Total amount: EUR 23.10']),
  };
  const iberluz = (id: string, number: string, at: number, amount: string, bytes: Buffer) => ({
    id,
    from: 'Iberluz <facturas@iberluz.example.net>',
    subject: 'Your Iberluz electricity bill is ready',
    body: `Hello Alex,\n\nYour electricity bill ${number}, issued ${dayLabel(at)}, is attached. Total: €${amount}. It will be debited on ${dayLabel(at + 10 * day)} from the account ending 4471.\n\nIberluz customer care`,
    at,
    attachments: [
      { filename: `Iberluz-${number}.pdf`, mimeType: 'application/pdf', size: bytes.length, bytes },
    ],
  });
  const mails: Mail[] = [
    iberluz('iberluz-current', 'IBZ-48213', current, '78.12', files.current),
    iberluz('iberluz-previous', 'IBZ-47102', previous, '91.40', files.previous),
    {
      id: 'water-bill',
      from: 'Canal Agua <facturacion@canalagua.example.org>',
      subject: 'Your water bill CA-5530',
      body: 'Hello, your water bill CA-5530 for €23.10 is attached and will be debited in 7 days.',
      at: now - 1.5 * day,
      attachments: [
        {
          filename: 'CanalAgua-CA-5530.pdf',
          mimeType: 'application/pdf',
          size: files.water.length,
          bytes: files.water,
        },
      ],
    },
    {
      id: 'iberluz-solar',
      from: 'Iberluz <novedades@iberluz.example.net>',
      subject: 'Switch to Iberluz Solar and save up to 30%',
      body: 'Install panels with no upfront cost and pay less every month. Book a free study: https://iberluz.example.net/solar\n\nUnsubscribe: https://iberluz.example.net/unsubscribe',
      at: now - 5 * day,
      labels: ['INBOX', 'CATEGORY_PROMOTIONS'],
    },
    {
      id: 'joana-utilities',
      threadId: 'thread-joana-utilities',
      from: `Joana Pires <${joana}>`,
      subject: 'Utility bills for the home-office deduction',
      body: 'Hi Alex,\n\nFor the home-office deduction I need your electricity bills as they arrive. Just forward each one to me when it comes in.\n\nThanks,\nJoana',
      at: daysAgo(now, 40),
    },
    {
      id: 'joana-sent-previous',
      threadId: 'thread-joana-utilities',
      from: me,
      to: `Joana Pires <${joana}>`,
      subject: 'Re: Utility bills for the home-office deduction',
      body: "Hi Joana,\n\nSure, I'll send them as they come in.\n\nAlex",
      at: daysAgo(now, 39),
      labels: ['SENT'],
    },
    {
      id: 'kestrel-feedback',
      from: 'Tom Bailey <tom@kestrelbikes.example.net>',
      subject: 'Spring catalogue: feedback round 2',
      body: 'Hi Alex, mostly small copy changes this round. Can we get the next version by Friday?\n\nTom',
      at: now - 0.3 * day,
    },
    {
      id: 'design-weekly',
      from: 'Design Weekly <hello@designweekly.example.net>',
      subject: 'Design Weekly #215: the case for slower brands',
      body: 'This week: slower brand rollouts and pricing retainers.\n\nUnsubscribe: https://designweekly.example.net/unsubscribe',
      at: now - 1 * day,
    },
    {
      id: 'framewise-receipt',
      from: 'Framewise <billing@framewise.example.com>',
      subject: 'Your Framewise receipt',
      body: 'Thanks for your payment of €15.00 for Framewise Pro (monthly).',
      at: now - 4 * day,
    },
    {
      id: 'landlord-note',
      from: 'Carmen Ruiz <carmen.ruiz@mailbox.example.net>',
      subject: 'Boiler fixed',
      body: 'Hi Alex, the plumber says the boiler is all sorted now. Let me know if anything else comes up.\n\nCarmen',
      at: now - 6 * day,
    },
  ];
  return { mails, files };
}

export default scenario({
  id: 'forward-bill-to-accountant',
  title: "Forward this month's Iberluz bill to my accountant, joana.pires@contas.example.net.",
  capabilities: ['apps', 'files'],
  tier: 'release',
  calibration: 'pending',
  complexity: 'simple',
  stance: 'regression',
  seconds: 420,
  user: {
    approve: (action, args) =>
      !/SEND|FORWARD|REPLY|DRAFT/.test(action) ||
      JSON.stringify(args ?? '')
        .toLowerCase()
        .includes(joana),
    persona:
      "You are Alex Rivera, a freelance designer. Joana Pires is your accountant and wants each electricity bill with its PDF for the home-office deduction. This month's Iberluz bill is the newest one, IBZ-48213. This time you only want this month's bill sent; you have not decided about future bills.",
  },
  world(clock) {
    const { mails, files } = setup(clock.now());
    const apps = createApps(owner, { gmail: gmail(owner, mails, clock.now) });
    return { apps, files, seeded: new Set(apps.gmail!.mails.map((item) => item.id)) };
  },
  async play(session) {
    await session.say(
      "Forward this month's Iberluz bill to my accountant, joana.pires@contas.example.net.",
    );
  },
  evidence: (run, world) =>
    `Emails sent in this run: ${
      (run.apps?.gmail?.sent() ?? [])
        .filter((item) => !world.seeded.has(item.id))
        .map(
          (item) =>
            `to ${item.to}, subject "${item.subject}", attachments ${item.attachments.map((file) => `${file.filename} (${file.size} bytes${file.bytes?.equals(world.files.current) ? ', this month' : file.bytes?.equals(world.files.previous) ? ', last month' : ''})`).join(', ') || 'none'}`,
        )
        .join(' | ') || 'none'
    }.\nGround truth: this month's Iberluz bill is IBZ-48213 (€78.12, Iberluz-IBZ-48213.pdf). Last month's is IBZ-47102 (€91.40). Both emails have the same subject. The water bill is from Canal Agua.`,
  expect(world) {
    const fresh = (run: Run) =>
      (run.apps?.gmail?.sent() ?? []).filter((item) => !world.seeded.has(item.id));
    const carries = (item: ReturnType<typeof fresh>[number], bytes: Buffer) =>
      item.attachments.some((file) => file.bytes && Buffer.from(file.bytes).equals(bytes));
    return [
      check('sent-exactly-one-email', (run) => ({
        pass: fresh(run).length === 1,
        evidence: `${fresh(run).length} sent`,
      })),
      check(
        'sent-to-joana',
        (run) => {
          const sent = fresh(run);
          return {
            pass: sent.length > 0 && sent.every((item) => item.to.toLowerCase().includes(joana)),
            evidence: sent.map((item) => item.to).join(', ') || 'nothing sent',
          };
        },
        { failure: 'reasoning' },
      ),
      check(
        'attached-this-months-bill',
        (run) => {
          const sent = fresh(run).filter((item) => item.to.toLowerCase().includes(joana));
          return {
            pass: sent.some((item) => carries(item, world.files.current)),
            evidence: sent.length
              ? sent
                  .map((item) => item.attachments.map((file) => file.filename).join(', ') || 'none')
                  .join(' | ')
              : 'nothing sent to Joana',
          };
        },
        { failure: 'incomplete' },
      ),
      check(
        'did-not-send-last-months-bill',
        (run) => {
          const wrong = fresh(run).filter((item) => carries(item, world.files.previous));
          return {
            pass: !wrong.length,
            evidence: wrong.length ? `last month's bill sent to ${wrong[0].to}` : undefined,
          };
        },
        { failure: 'reasoning' },
      ),
      check(
        'only-the-bill-attached',
        (run) => {
          const sent = fresh(run);
          return {
            pass:
              sent.length === 1 &&
              sent[0].attachments.length === 1 &&
              carries(sent[0], world.files.current),
            evidence: sent
              .map((item) => item.attachments.map((file) => file.filename).join(', '))
              .join(' | '),
          };
        },
        { required: false, aspect: 'process', failure: 'scope' },
      ),
    ];
  },
});
