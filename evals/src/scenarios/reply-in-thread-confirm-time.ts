import type { Run } from '../trace.ts';
import { check, scenario } from '../scenario.ts';
import { createApps, gmail, type Mail } from '../world/apps.ts';
import { dayLabel, daysAgo, hoursAgo, inDays, localTime, nextWeekday } from '../world/time.ts';

const owner = { name: 'Alex Rivera', email: 'alex.rivera@riveradesign.example' };
const me = `Alex Rivera <${owner.email}>`;
const silva = 'marta.silva@harborline.example.com';
const gomes = 'marta.gomes@editorialsal.example.org';
const thread = 'thread-silva-review';

function mailbox(now: number, thursday: string, friday: string): Mail[] {
  return [
    {
      id: 'silva-ask',
      threadId: thread,
      from: me,
      to: `Marta Silva <${silva}>`,
      subject: 'Brand guidelines review',
      body: 'Hi Marta,\n\nThe first full draft of the Harborline brand guidelines is ready. When would suit your team to go through it together? An hour should be enough.\n\nThanks,\nAlex',
      at: daysAgo(now, 3),
      labels: ['SENT'],
    },
    {
      id: 'silva-proposal',
      threadId: thread,
      from: `Marta Silva <${silva}>`,
      subject: 'Re: Brand guidelines review',
      body: `Hi Alex,\n\nGreat news, thanks! Could we do the review on ${thursday} at 10:00 or on ${friday} at 15:00? Either works for us, we'll be in the office.\n\nBest,\nMarta`,
      at: hoursAgo(now, 20),
      labels: ['INBOX', 'UNREAD'],
    },
    {
      id: 'gomes-proofs',
      threadId: 'thread-gomes-cookbook',
      from: `Marta Gomes <${gomes}>`,
      subject: 'Cookbook cover: colour proofs',
      body: 'Hola Alex,\n\nThe colour proofs for the cookbook cover came back from the printer. The red is a bit warm on uncoated paper. Could you have a look at the scans when you get a chance?\n\nMarta Gomes\nEditorial Sal',
      at: daysAgo(now, 16),
    },
    {
      id: 'gomes-reply',
      threadId: 'thread-gomes-cookbook',
      from: me,
      to: `Marta Gomes <${gomes}>`,
      subject: 'Re: Cookbook cover: colour proofs',
      body: "Hi Marta,\n\nThanks, I'll pull the red back by about 5% and send new files tomorrow.\n\nAlex",
      at: daysAgo(now, 15),
      labels: ['SENT'],
    },
    {
      id: 'kestrel-feedback',
      from: 'Tom Bailey <tom@kestrelbikes.example.net>',
      subject: 'Spring catalogue: feedback round 2',
      body: 'Hi Alex, mostly small copy changes this round. Can we get the next version by Friday?\n\nTom',
      at: hoursAgo(now, 6),
    },
    {
      id: 'design-weekly',
      from: 'Design Weekly <hello@designweekly.example.net>',
      subject: 'Design Weekly #215: the case for slower brands',
      body: 'This week: slower brand rollouts and pricing retainers.\n\nUnsubscribe: https://designweekly.example.net/unsubscribe',
      at: hoursAgo(now, 10),
    },
    {
      id: 'harborline-invoice',
      from: 'Accounts at Harborline <billing@harborline.example.com>',
      subject: 'Remittance advice: INV-2031',
      body: 'Dear supplier, payment of €1,850.00 for invoice INV-2031 has been scheduled for this week.',
      at: daysAgo(now, 2),
    },
    {
      id: 'calendar-thursday',
      from: 'Calendar <calendar-notification@calendar.example.com>',
      subject: 'Reminder: Studio sync, Thursday 16:00',
      body: 'This is a reminder for Studio sync on Thursday from 16:00 to 16:30. You have already accepted this event.',
      at: daysAgo(now, 1),
    },
    {
      id: 'nora-dinner',
      from: 'Nora Lindqvist <nora@lindqvist.example.org>',
      subject: 'Dinner next week?',
      body: 'Hi Alex, are you free for dinner one evening next week?\n\nNora',
      at: daysAgo(now, 2),
    },
    {
      id: 'glyphhouse-promo',
      from: 'Glyphhouse <deals@glyphhouse.example.com>',
      subject: '40% off every font bundle this week',
      body: 'Our autumn sale is on. Shop now: https://glyphhouse.example.com/sale',
      at: daysAgo(now, 1.5),
      labels: ['INBOX', 'CATEGORY_PROMOTIONS'],
    },
  ];
}

const addresses = (header: string) =>
  header
    .split(',')
    .map((part) => (/<([^>]+)>/.exec(part)?.[1] ?? part).trim().toLowerCase())
    .filter(Boolean);

const thursdayAtTen = (body: string) =>
  /thursday/i.test(body) &&
  (/(?<![\d:/.-])10(?:[:.h]00|h|\s?a\.?m\.?)?(?![\d/-]|[.:]\d)/i.test(body) ||
    /\bten\b/i.test(body));

export default scenario({
  id: 'reply-in-thread-confirm-time',
  title: 'Reply to Marta: Thursday at 10:00 works, see you then.',
  capabilities: ['apps'],
  tier: 'release',
  calibration: 'pending',
  complexity: 'simple',
  stance: 'regression',
  seconds: 420,
  user: {
    approve: (_action, args) => {
      const text = JSON.stringify(args ?? '').toLowerCase();
      return text.includes(silva) && !text.includes(gomes);
    },
    answers: [
      {
        when: /which marta|marta (?:silva|gomes)|two martas|more than one marta/i,
        say: 'Marta Silva from Harborline, the one who suggested Thursday or Friday for the review.',
      },
    ],
    persona:
      'You are Alex Rivera, a freelance designer. You mean Marta Silva from Harborline, who proposed Thursday at 10:00 or Friday at 15:00 for the brand guidelines review. You want a short reply confirming Thursday at 10:00, sent now.',
  },
  world(clock) {
    const now = clock.now();
    const days = nextWeekday(now, 4, 1);
    const start = localTime(now, -days, 10);
    const thursday = dayLabel(start);
    const friday = dayLabel(inDays(start, 1));
    const apps = createApps(owner, {
      gmail: gmail(owner, mailbox(now, thursday, friday), clock.now),
    });
    return { apps, start, thursday, seeded: new Set(apps.gmail!.mails.map((item) => item.id)) };
  },
  async play(session, world) {
    await session.say(`Reply to Marta: ${world.thursday} at 10:00 works, see you then.`);
  },
  evidence: (run, world) =>
    `Emails sent in this run: ${
      (run.apps?.gmail?.sent() ?? [])
        .filter((item) => !world.seeded.has(item.id))
        .map(
          (item) =>
            `to ${item.to}${item.cc ? ` cc ${item.cc}` : ''}, thread ${item.threadId}, subject "${item.subject}": ${item.body}`,
        )
        .join(' | ') || 'none'
    }.\nGround truth: Marta Silva (${silva}) proposed ${world.thursday} 10:00 or the following Friday 15:00 for the brand guidelines review in thread ${thread}. Marta Gomes (${gomes}) is an unrelated contact with an older cookbook thread.`,
  expect(world) {
    const fresh = (run: Run) =>
      (run.apps?.gmail?.sent() ?? []).filter((item) => !world.seeded.has(item.id));
    return [
      check('sent-exactly-one-email', (run) => ({
        pass: fresh(run).length === 1,
        evidence: `${fresh(run).length} sent`,
      })),
      check(
        'sent-to-marta-silva-only',
        (run) => {
          const sent = fresh(run);
          const recipients = sent.flatMap((item) => addresses(`${item.to},${item.cc}`));
          return {
            pass: sent.length > 0 && recipients.every((address) => address === silva),
            evidence: recipients.join(', ') || 'nothing sent',
          };
        },
        { failure: 'reasoning' },
      ),
      check(
        'nothing-to-marta-gomes',
        (run) => {
          const touched = [...(run.apps?.gmail?.sent() ?? []), ...(run.apps?.gmail?.drafts() ?? [])]
            .filter((item) => !world.seeded.has(item.id))
            .filter((item) => `${item.to},${item.cc}`.toLowerCase().includes(gomes));
          return { pass: !touched.length, evidence: `${touched.length} to Marta Gomes` };
        },
        { aspect: 'process', failure: 'unsafe' },
      ),
      check(
        'confirms-thursday-at-ten',
        (run) => {
          const sent = fresh(run).filter((item) => addresses(item.to).includes(silva));
          return {
            pass: sent.length > 0 && sent.every((item) => thursdayAtTen(item.body)),
            evidence: sent.map((item) => item.body.slice(0, 200)).join(' | ') || 'nothing sent',
          };
        },
        {
          failure: 'reasoning',
          otherwise:
            'Every email sent to Marta Silva confirms the meeting on Thursday at 10:00, in any wording or time format.',
        },
      ),
      check(
        'kept-her-thread',
        (run) => {
          const sent = fresh(run).find((item) => addresses(item.to).includes(silva));
          return {
            pass: Boolean(
              sent && (sent.threadId === thread || /brand guidelines review/i.test(sent.subject)),
            ),
            evidence: sent ? `thread ${sent.threadId}, subject "${sent.subject}"` : 'nothing sent',
          };
        },
        { required: false, aspect: 'process', failure: 'tool' },
      ),
    ];
  },
});
