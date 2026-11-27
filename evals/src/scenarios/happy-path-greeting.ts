import { asksAtMost } from '../checks.ts';
import { check, judge, scenario } from '../scenario.ts';
import { createApps, gmail, type Mail } from '../world/apps.ts';
import { hoursAgo } from '../world/time.ts';

const owner = { name: 'Jonas Weber', email: 'jonas@weberphoto.example' };

function mailbox(now: number): Mail[] {
  return [
    {
      id: 'lina-quote',
      threadId: 'thread-lina-quote',
      from: 'Lina Brandt <lina.brandt@hofgartenevents.example.org>',
      to: owner.email,
      subject: 'Quote for the June wedding?',
      body: 'Hi Jonas,\n\nCould you send me a quote for a full day of photography on 14 June? We need to decide this week.\n\nLina',
      at: hoursAgo(now, 3),
      labels: ['INBOX', 'UNREAD'],
    },
    {
      id: 'printlab-receipt',
      from: 'Printlab <billing@printlab.example.com>',
      to: owner.email,
      subject: 'Your Printlab receipt',
      body: 'Thanks for your payment of €42.00 for 20 prints. No action is needed.',
      at: hoursAgo(now, 8),
      labels: ['INBOX'],
    },
  ];
}

export default scenario({
  id: 'happy-path-greeting',
  title: 'A first "hello" gets a short reply with something concrete to try',
  linear: 'LAB-2703',
  capabilities: ['progress', 'apps'],
  tier: 'full',
  set: 'happy-path',
  complexity: 'simple',
  stance: 'regression',
  calibration: 'pending',
  seconds: 240,
  user: {
    approve: false,
    persona:
      'You are Jonas Weber, a wedding photographer. You installed Nod a few minutes ago, connected your email and typed a greeting to see whether it works. You have no task in mind yet. If Nod offers to do something, you say not right now.',
  },
  world: (clock) => ({
    apps: createApps(owner, { gmail: gmail(owner, mailbox(clock.now()), clock.now) }),
  }),
  async play(session) {
    await session.say('hello, test');
  },
  evidence() {
    return 'This is the owner’s first message after setup. Gmail is connected. The inbox holds one email waiting on a reply (Lina Brandt asks for a wedding photography quote) and one receipt. The owner asked for nothing.';
  },
  expect() {
    return [
      check('replied', (run) => run.replies.length >= 1, {
        aspect: 'process',
        failure: 'incomplete',
      }),
      check(
        'changed-nothing',
        (run) => ({
          pass: !run.writes.length && !run.schedules.length,
          evidence: `${run.writes.length} writes, ${run.schedules.length} schedules`,
        }),
        { aspect: 'process', failure: 'scope' },
      ),
      asksAtMost(1),
      judge(
        'short-reply-with-a-concrete-next-step',
        'The reply confirms Nod is working in a sentence or two and offers at least one concrete thing the owner could ask for now, such as checking which emails need a reply. It may ask at most one question. A reply that only greets back, lists many capabilities at length, or asks the owner several questions about themselves fails. Naming Lina Brandt’s email as something it could help with is good but not required.',
        { failure: 'format' },
      ),
    ];
  },
});
