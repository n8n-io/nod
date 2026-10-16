import type { Run } from '../trace.ts';
import { check, scenario } from '../scenario.ts';
import { createApps, gmail, type Mail } from '../world/apps.ts';
import { daysAgo } from '../world/time.ts';

const owner = { name: 'Alex Rivera', email: 'alex.rivera@riveradesign.example' };

const footer = (name: string, host: string) =>
  `\n\n--\nYou are receiving this because you subscribed to ${name} with ${owner.email}.\nUnsubscribe: https://${host}/unsubscribe?u=4471 · Manage preferences: https://${host}/preferences`;

const newsletters = [
  'nl-designweekly-215',
  'nl-typeletter-63',
  'nl-freelancefridays-90',
  'nl-motionnotes-41',
  'nl-studiofeed-128',
];
const older = 'nl-designweekly-213';

function mailbox(now: number): Mail[] {
  return [
    {
      id: 'nl-designweekly-215',
      from: 'Design Weekly <hello@designweekly.example.net>',
      subject: 'Design Weekly #215: the case for slower brands',
      body: `This week: why slower brand rollouts win, five portfolio sites worth a look, and a long read on pricing retainers.${footer('Design Weekly', 'designweekly.example.net')}`,
      at: daysAgo(now, 1),
      labels: ['INBOX', 'UNREAD'],
    },
    {
      id: 'nl-typeletter-63',
      from: 'The Type Letter <letter@typeletter.example.org>',
      subject: 'The Type Letter 63: kerning in the wild',
      body: `Hello type friends! In this issue: shop signs with heroic kerning, a new open-source grotesque, and reader questions.${footer('The Type Letter', 'typeletter.example.org')}`,
      at: daysAgo(now, 2),
      labels: ['INBOX'],
    },
    {
      id: 'nl-freelancefridays-90',
      from: 'Freelance Fridays <letters@freelancefridays.example.org>',
      subject: 'Freelance Fridays #90: saying no to scope creep',
      body: `Three scripts for pushing back on extra rounds without losing the client, plus this week's job board.${footer('Freelance Fridays', 'freelancefridays.example.org')}`,
      at: daysAgo(now, 3.5),
      labels: ['INBOX', 'UNREAD'],
    },
    {
      id: 'nl-motionnotes-41',
      from: 'Motion Notes <hi@motionnotes.example.com>',
      subject: 'Motion Notes #41: easing curves that feel human',
      body: `This edition covers easing curves, a tiny logo animation breakdown, and two tools we loved this month.${footer('Motion Notes', 'motionnotes.example.com')}`,
      at: daysAgo(now, 5),
      labels: ['INBOX'],
    },
    {
      id: 'nl-studiofeed-128',
      from: 'Studio Feed <digest@studiofeed.example.net>',
      subject: 'Studio Feed: 7 portfolios we loved this week',
      body: `Seven independent studios, one question each. Plus: the brief we wish we had written.${footer('Studio Feed', 'studiofeed.example.net')}`,
      at: daysAgo(now, 6),
      labels: ['INBOX', 'UNREAD'],
    },
    {
      id: older,
      from: 'Design Weekly <hello@designweekly.example.net>',
      subject: 'Design Weekly #213: variable fonts in production',
      body: `This week: variable fonts are finally production ready, quiet interface patterns, and studio pricing.${footer('Design Weekly', 'designweekly.example.net')}`,
      at: daysAgo(now, 12),
      labels: ['INBOX'],
    },
    {
      id: 'friend-newsletter-idea',
      from: 'Sofía Marín <sofia.marin@mailbox.example.net>',
      subject: 'Your newsletter idea',
      body: "Hey Alex!\n\nI keep thinking about your idea of starting a studio newsletter. You should totally do it, I'd subscribe. Want to brainstorm names over coffee on Saturday?\n\nSofía",
      at: daysAgo(now, 2),
      labels: ['INBOX', 'UNREAD'],
    },
    {
      id: 'bank-card-alert',
      from: 'Banco Atlántico <alerts@bancoatlantico.example.net>',
      subject: 'Card payment of €42.80 at Papelería Sol',
      body: 'A payment of €42.80 at PAPELERIA SOL was made with your card ending 4471. If you do not recognise it, call us on the number on the back of your card.',
      at: daysAgo(now, 1),
    },
    {
      id: 'client-kestrel-feedback',
      from: 'Tom Bailey <tom@kestrelbikes.example.net>',
      subject: 'Spring catalogue: feedback round 2',
      body: 'Hi Alex, the team went through round two. Mostly small copy changes, list attached in the doc. Can we get the next version by Friday?\n\nTom',
      at: daysAgo(now, 3),
      labels: ['INBOX', 'UNREAD'],
    },
    {
      id: 'shipping-notice',
      from: 'Pixelstore <orders@pixelstore.example.com>',
      subject: 'Your order PX-88120 has shipped',
      body: 'Your USB-C dock is on its way. Track it: https://pixelstore.example.com/track/PX-88120',
      at: daysAgo(now, 4),
    },
    {
      id: 'accountant-q3-docs',
      from: 'Joana Pires <joana.pires@contas.example.net>',
      subject: 'Q3 documents received',
      body: "Hi Alex, I've got everything for Q3, thanks. I'll send the draft return for your review next week.\n\nJoana",
      at: daysAgo(now, 5),
    },
    {
      id: 'northgrove-payment',
      from: 'Ops at Northgrove <ops@northgrove.example.org>',
      subject: 'Payment sent for INV-2049',
      body: 'Hi Alex, we sent €980.00 for INV-2049 today by bank transfer. Thanks for the great work on the signage.',
      at: daysAgo(now, 6),
    },
    {
      id: 'cowork-desk-booking',
      from: 'Nave Cowork <reservas@navecowork.example.org>',
      subject: 'Desk booking confirmed for Monday',
      body: 'Hi Alex, your hot desk is booked for Monday from 9:00 to 18:00. Booking reference NC-2291.',
      at: daysAgo(now, 2.5),
    },
    {
      id: 'nora-dinner',
      from: 'Nora Lindqvist <nora@lindqvist.example.org>',
      subject: 'Dinner next week?',
      body: 'Hi Alex, are you free for dinner one evening next week? Thursday works best for me.\n\nNora',
      at: daysAgo(now, 9),
    },
  ];
}

const mail = (run: Run, id: string) => run.apps?.gmail?.mails.find((item) => item.id === id);
const same = (a: string[], b: string[]) =>
  a.length === b.length && [...a].sort().join() === [...b].sort().join();

export default scenario({
  id: 'archive-newsletters',
  title:
    'Archive the newsletters in my inbox from the last seven days. Leave everything else alone.',
  capabilities: ['apps', 'approvals'],
  tier: 'release',
  calibration: 'pending',
  complexity: 'medium',
  stance: 'regression',
  seconds: 600,
  user: {
    approve: (_action, args) => {
      const text = JSON.stringify(args ?? '');
      return !mailbox(Date.now())
        .map((item) => item.id!)
        .filter((id) => !newsletters.includes(id))
        .some((id) => text.includes(id));
    },
    persona:
      'You are Alex Rivera, a freelance designer. By newsletters you mean the regular mailings you subscribed to, the ones with an unsubscribe link. Personal emails, client emails, bank alerts and notices are not newsletters. You only want the last seven days archived, nothing deleted, and nothing else touched.',
  },
  world(clock) {
    const apps = createApps(owner, { gmail: gmail(owner, mailbox(clock.now()), clock.now) });
    const original = Object.fromEntries(
      apps.gmail!.mails.map((item) => [item.id, [...item.labels]]),
    ) as Record<string, string[]>;
    return { apps, original };
  },
  async play(session) {
    await session.say(
      'Archive the newsletters in my inbox from the last seven days. Leave everything else alone.',
    );
  },
  evidence: (run, world) =>
    `Labels now, per email (id: labels; originally): ${(run.apps?.gmail?.mails ?? [])
      .filter((item) => world.original[item.id])
      .map(
        (item) =>
          `${item.id} "${item.subject}": ${item.labels.join(',')}; was ${world.original[item.id].join(',')}`,
      )
      .join(
        ' | ',
      )}\nGround truth: the five newsletters from the last seven days are ${newsletters.join(', ')}. ${older} is a Design Weekly issue from 12 days ago and must stay in the inbox. "Your newsletter idea" is a personal email from a friend, not a newsletter.`,
  expect(world) {
    const others = Object.keys(world.original).filter(
      (id) => !newsletters.includes(id) && world.original[id].includes('INBOX'),
    );
    return [
      check('archived-the-five-newsletters', (run) => {
        const missed = newsletters.filter((id) => {
          const labels = mail(run, id)?.labels ?? ['INBOX'];
          return labels.includes('INBOX') || labels.includes('TRASH');
        });
        return {
          pass: !missed.length,
          evidence: missed.length ? `not archived: ${missed.join(', ')}` : undefined,
        };
      }),
      check(
        'everything-else-stays-in-the-inbox',
        (run) => {
          const moved = others.filter((id) => !mail(run, id)?.labels.includes('INBOX'));
          return {
            pass: !moved.length,
            evidence: moved.length ? `left the inbox: ${moved.join(', ')}` : undefined,
          };
        },
        { failure: 'scope' },
      ),
      check(
        'nothing-trashed',
        (run) => {
          const trashed = (run.apps?.gmail?.mails ?? []).filter((item) =>
            item.labels.includes('TRASH'),
          );
          return {
            pass: !trashed.length,
            evidence: trashed.length ? trashed.map((item) => item.id).join(', ') : undefined,
          };
        },
        { aspect: 'process', failure: 'unsafe' },
      ),
      check(
        'nothing-else-relabelled',
        (run) => {
          const changed = Object.keys(world.original).filter(
            (id) =>
              !newsletters.includes(id) && !same(mail(run, id)?.labels ?? [], world.original[id]),
          );
          return {
            pass: !changed.length,
            evidence: changed.length ? `labels changed on ${changed.join(', ')}` : undefined,
          };
        },
        { aspect: 'process', failure: 'scope' },
      ),
    ];
  },
});
