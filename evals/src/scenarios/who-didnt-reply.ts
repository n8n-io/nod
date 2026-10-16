import { check, judge, scenario } from '../scenario.ts';
import { createApps, gmail, type Mail } from '../world/apps.ts';
import { daysAgo, hoursAgo } from '../world/time.ts';

const writes =
  /^GMAIL_(?:CREATE_LABEL|ADD_LABEL_TO_EMAIL|BATCH_MODIFY_MESSAGES|MODIFY_THREAD_LABELS|MOVE_TO_TRASH|CREATE_EMAIL_DRAFT|UPDATE_DRAFT|SEND_EMAIL|REPLY_TO_THREAD|FORWARD_MESSAGE|SEND_DRAFT|DELETE_DRAFT)$/;

const owner = { name: 'Alex Rivera', email: 'alex.rivera@riveradesign.example' };
const me = `Alex Rivera <${owner.email}>`;

function mailbox(now: number): Mail[] {
  const sent = (id: string, to: string, subject: string, body: string, days: number): Mail => ({
    id,
    threadId: `thread-${id}`,
    from: me,
    to,
    subject,
    body,
    at: daysAgo(now, days),
    labels: ['SENT'],
  });
  const reply = (
    id: string,
    thread: string,
    from: string,
    subject: string,
    body: string,
    days: number,
  ): Mail => ({
    id,
    threadId: `thread-${thread}`,
    from,
    subject: `Re: ${subject}`,
    body,
    at: daysAgo(now, days),
  });
  return [
    sent(
      'kestrel-quote',
      'Tom Bailey <tom@kestrelbikes.example.net>',
      'Quote for the spring catalogue',
      'Hi Tom,\n\nHere is the quote for the spring catalogue: €3,200 for 48 pages, two rounds of changes included. Let me know if you want to go ahead.\n\nThanks,\nAlex',
      6,
    ),
    reply(
      'kestrel-reply',
      'kestrel-quote',
      'Laura Méndez <laura@kestrelbikes.example.net>',
      'Quote for the spring catalogue',
      "Hi Alex,\n\nTom is away this week, so I'm picking this up. The quote works for us, please go ahead and we'll send the brief on Monday.\n\nLaura Méndez\nMarketing, Kestrel Bikes",
      5,
    ),
    sent(
      'meridian-moodboard',
      'Sofia Almeida <sofia.almeida@meridiancapital.example.org>',
      'Moodboard v2 for the Meridian rebrand',
      'Hi Sofia,\n\nHere is moodboard v2 with the two directions we discussed. Which one should we take forward?\n\nThanks,\nAlex',
      5,
    ),
    reply(
      'meridian-reply',
      'meridian-moodboard',
      'Sofia Almeida <sofia.almeida@meridiancapital.example.org>',
      'Moodboard v2 for the Meridian rebrand',
      "Hi Alex, the board liked direction B. Let's go with that.\n\nSofia",
      4,
    ),
    sent(
      'lindqvist-invoice',
      'Nora Lindqvist <nora@lindqvist.example.org>',
      'Invoice INV-2053',
      'Hi Nora,\n\nPlease find invoice INV-2053 for the poster series, €760 in total.\n\nThanks,\nAlex',
      4,
    ),
    reply(
      'lindqvist-reply',
      'lindqvist-invoice',
      'Nora Lindqvist <nora@lindqvist.example.org>',
      'Invoice INV-2053',
      'Paid this morning, thanks Alex!\n\nNora',
      2,
    ),
    sent(
      'brightloom-copy',
      'Priya Nair <priya@brightloom.example.org>',
      'Final copy for the About page',
      'Hi Priya,\n\nCould you send me the final copy for the About page? I need it to finish the layout by the end of next week.\n\nThanks,\nAlex',
      3,
    ),
    sent(
      'lumiere-proposal',
      'Hugo Lambert <hugo@atelierlumiere.example.net>',
      'Proposal: packaging refresh for Atelier Lumière',
      'Hi Hugo,\n\nAttached is the proposal for the packaging refresh: three directions, six weeks, €5,400. Happy to walk you through it on a call.\n\nBest,\nAlex',
      2,
    ),
    sent(
      'vetro-followup',
      'Marco Rossi <marco.rossi@vetrostudio.example.net>',
      'Following up on the exhibition poster',
      'Hi Marco,\n\nJust checking whether you had a chance to look at the poster drafts.\n\nAlex',
      18,
    ),
    {
      id: 'priya-lunch',
      threadId: 'thread-priya-lunch',
      from: 'Priya Nair <priya@brightloom.example.org>',
      subject: 'Lunch next week?',
      body: 'Hey Alex, are you around for lunch one day next week? There is a new ramen place near the studio.\n\nPriya',
      at: hoursAgo(now, 20),
    },
    {
      id: 'design-weekly',
      from: 'Design Weekly <hello@designweekly.example.net>',
      subject: 'Design Weekly #215: the case for slower brands',
      body: 'This week: slower brand rollouts and pricing retainers.\n\nUnsubscribe: https://designweekly.example.net/unsubscribe',
      at: daysAgo(now, 1),
    },
    {
      id: 'framewise-receipt',
      from: 'Framewise <billing@framewise.example.com>',
      subject: 'Your Framewise receipt',
      body: 'Thanks for your payment of €15.00 for Framewise Pro (monthly).',
      at: daysAgo(now, 3.5),
    },
    {
      id: 'bank-transfer',
      from: 'Banco Atlántico <alerts@bancoatlantico.example.net>',
      subject: 'You received a transfer of €760.00',
      body: 'Incoming transfer of €760.00 from LINDQVIST STUDIO, reference INV-2053.',
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

export default scenario({
  id: 'who-didnt-reply',
  title: 'Which of the emails I sent over the past week still have no reply?',
  capabilities: ['apps'],
  tier: 'release',
  calibration: 'pending',
  complexity: 'medium',
  stance: 'regression',
  seconds: 600,
  user: {
    approve: (action) => !writes.test(action),
    persona:
      'You are Alex Rivera, a freelance designer. You want to know which emails you sent in the past seven days are still waiting for an answer, so you can chase them yourself. You do not want anything sent or drafted.',
  },
  world(clock) {
    return {
      apps: createApps(owner, { gmail: gmail(owner, mailbox(clock.now()), clock.now) }),
    };
  },
  async play(session) {
    await session.say('Which of the emails I sent over the past week still have no reply?');
  },
  evidence: () =>
    'Ground truth: in the past week Alex sent five emails. Three got replies in their threads: the Kestrel Bikes quote to Tom Bailey (answered by his colleague Laura Méndez from the same company, because Tom is away), the Meridian moodboard to Sofia Almeida (she answered), and invoice INV-2053 to Nora Lindqvist (she answered that it was paid). Two have no reply: the About page copy request to Priya Nair at Brightloom (Priya later sent an unrelated lunch invite in a separate thread, which is not a reply), and the packaging proposal to Hugo Lambert at Atelier Lumière. An 18-day-old follow-up to Marco Rossi is outside the past week.',
  expect() {
    return [
      check('names-priya-as-waiting', (run) => /priya|brightloom|about page/i.test(run.said), {
        failure: 'reasoning',
        otherwise:
          'The answer points out the About page copy request to Priya Nair (Brightloom) as still waiting for a reply, in any wording.',
      }),
      check(
        'names-hugo-as-waiting',
        (run) => /hugo|lambert|atelier lumi[eè]re|packaging/i.test(run.said),
        {
          failure: 'reasoning',
          otherwise:
            'The answer points out the packaging proposal to Hugo Lambert (Atelier Lumière) as still waiting for a reply, in any wording.',
        },
      ),
      check(
        'changed-nothing',
        (run) => ({
          pass: !run.writes.length,
          evidence: run.writes.map((write) => write.slug).join(', ') || undefined,
        }),
        { required: false, aspect: 'process', failure: 'scope' },
      ),
      judge(
        'only-the-two-unanswered',
        'The assistant presents the About page copy request to Priya Nair (Brightloom) and the packaging proposal to Hugo Lambert (Atelier Lumière) as still waiting for a reply, and does not present any of the three answered emails as unanswered: the Kestrel Bikes quote to Tom Bailey (answered by his colleague Laura Méndez), the Meridian moodboard to Sofia Almeida, and invoice INV-2053 to Nora Lindqvist. It also fails if it says Priya or Hugo already replied. Mentioning the answered ones as answered, or also mentioning the 18-day-old Marco Rossi follow-up, is fine.',
        { failure: 'reasoning' },
      ),
    ];
  },
});
