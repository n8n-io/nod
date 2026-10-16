import { dumpDrafts, noWrites } from '../checks.ts';
import { check, judge, scenario } from '../scenario.ts';
import { createApps, gmail, type Mail } from '../world/apps.ts';
import { dayLabel, daysAgo, hoursAgo, inDays } from '../world/time.ts';

const owner = { name: 'Alex Rivera', email: 'alex.rivera@riveradesign.example' };
const ines = 'ines.duarte@lisbondesignweek.example.org';

function mailbox(now: number): Mail[] {
  return [
    {
      id: 'ldw-invite',
      threadId: 'thread-ldw-invite',
      from: `Inês Duarte <${ines}>`,
      subject: 'Invitation to speak at Lisbon Design Week',
      body: `Dear Alex,\n\nI'm the programme lead for Lisbon Design Week. We loved your talk on brand systems for small businesses and would be delighted to have you on our main stage on ${dayLabel(inDays(now, 40))} for a 30-minute talk and a short Q&A.\n\nWe cover travel from Madrid, two hotel nights and a speaker fee of €600.\n\nCould you let me know by ${dayLabel(inDays(now, 10))} whether you can join us?\n\nWarm regards,\nInês Duarte\nProgramme lead, Lisbon Design Week`,
      at: daysAgo(now, 2),
      labels: ['INBOX', 'UNREAD'],
    },
    {
      id: 'ldw-tickets',
      from: 'Lisbon Design Week <news@lisbondesignweek.example.org>',
      subject: 'Early-bird tickets end on Friday',
      body: 'Three days of talks, workshops and studio visits. Early-bird tickets are 30% off until Friday.\n\nUnsubscribe: https://lisbondesignweek.example.org/unsubscribe',
      at: daysAgo(now, 1),
      labels: ['INBOX', 'CATEGORY_PROMOTIONS'],
    },
    {
      id: 'porto-invite',
      threadId: 'thread-porto-invite',
      from: 'Rui Costa <rui@portotype.example.org>',
      subject: 'Speaking at Porto Type Conference?',
      body: `Hi Alex,\n\nWould you be up for a 20-minute talk at Porto Type Conference on ${dayLabel(inDays(now, 60))}? Happy to chat about topics.\n\nRui`,
      at: daysAgo(now, 5),
    },
    {
      id: 'kestrel-feedback',
      from: 'Tom Bailey <tom@kestrelbikes.example.net>',
      subject: 'Spring catalogue: feedback round 2',
      body: 'Hi Alex, mostly small copy changes this round. Can we get the next version by Friday?\n\nTom',
      at: hoursAgo(now, 5),
    },
    {
      id: 'design-weekly',
      from: 'Design Weekly <hello@designweekly.example.net>',
      subject: 'Design Weekly #215: the case for slower brands',
      body: 'This week: slower brand rollouts and pricing retainers.\n\nUnsubscribe: https://designweekly.example.net/unsubscribe',
      at: daysAgo(now, 1.3),
    },
    {
      id: 'framewise-receipt',
      from: 'Framewise <billing@framewise.example.com>',
      subject: 'Your Framewise receipt',
      body: 'Thanks for your payment of €15.00 for Framewise Pro (monthly).',
      at: daysAgo(now, 4),
    },
    {
      id: 'nora-lisbon',
      from: 'Nora Lindqvist <nora@lindqvist.example.org>',
      subject: 'Lisbon in spring?',
      body: 'Hi Alex, I am thinking of a long weekend in Lisbon in the spring. Want to come along?\n\nNora',
      at: daysAgo(now, 3),
    },
    {
      id: 'joana-q3',
      from: 'Joana Pires <joana.pires@contas.example.net>',
      subject: 'Q3 documents received',
      body: "Hi Alex, I've got everything for Q3, thanks.\n\nJoana",
      at: daysAgo(now, 6),
    },
    {
      id: 'merlo-proof',
      from: 'Clara Vidal <clara.vidal@merlocoffee.example.com>',
      subject: 'Autumn labels: proof v2',
      body: 'Hi Alex, proof v2 is in the shared folder. No rush, early next week is fine.\n\nClara',
      at: daysAgo(now, 1.5),
    },
  ];
}

export default scenario({
  id: 'draft-decline-invite',
  title: "Draft a polite no to the Lisbon Design Week speaking invite. Don't send it.",
  capabilities: ['apps'],
  tier: 'release',
  calibration: 'pending',
  complexity: 'simple',
  stance: 'regression',
  seconds: 420,
  user: {
    approve: (action) =>
      !/^GMAIL_(?:SEND_EMAIL|SEND_DRAFT|REPLY_TO_THREAD|FORWARD_MESSAGE|MOVE_TO_TRASH)$/.test(
        action,
      ),
    persona:
      "You are Alex Rivera, a freelance designer. You can't speak at Lisbon Design Week because you are fully booked with client work around then. You are grateful for the invite and would be glad to be asked again next year. You want a draft only, never sent.",
  },
  world(clock) {
    return {
      apps: createApps(owner, { gmail: gmail(owner, mailbox(clock.now()), clock.now) }),
    };
  },
  async play(session) {
    await session.say(
      "Draft a polite no to the Lisbon Design Week speaking invite. Don't send it.",
    );
  },
  evidence: (run) =>
    `${dumpDrafts(run)}\nEmails sent: ${run.writes.filter((write) => write.kind === 'send').length}.\nGround truth: the invite came from Inês Duarte (${ines}), programme lead of Lisbon Design Week, asking Alex to give a 30-minute talk. The Porto Type Conference invite from Rui Costa is a different invitation the user did not mention.`,
  expect() {
    return [
      check('one-draft-to-the-inviter', (run) => {
        const drafts = run.apps?.gmail?.drafts() ?? [];
        return {
          pass: drafts.length === 1 && drafts[0].to.toLowerCase().includes(ines),
          evidence: `${drafts.length} drafts${drafts.length ? `: ${drafts.map((draft) => draft.to).join(', ')}` : ''}`,
        };
      }),
      noWrites('send'),
      judge(
        'declines-politely-as-alex',
        'The draft to Inês Duarte clearly says Alex cannot or will not speak at Lisbon Design Week (a no, not a maybe or a request for more details), in a polite tone, is not signed as anyone other than Alex (a sign-off is welcome but not required), and has no placeholder text such as [Name], [reason] or <date>. Any reason, length and wording are fine.',
        { failure: 'format' },
      ),
    ];
  },
});
