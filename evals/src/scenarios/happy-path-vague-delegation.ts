import { asksAtMost, noWrites } from '../checks.ts';
import { check, judge, scenario } from '../scenario.ts';
import { createApps, gmail, type Mail } from '../world/apps.ts';
import { hoursAgo } from '../world/time.ts';

const owner = { name: 'Sofia Marin', email: 'sofia@marinceramics.example' };
const concrete = /hugo|wholesale|mugs|claywork|invoice|€?\s?318/i;

function mailbox(now: number): Mail[] {
  return [
    {
      id: 'hugo-wholesale',
      threadId: 'thread-hugo-wholesale',
      from: 'Hugo Lambert <hugo@cafelumiere.example.net>',
      to: owner.email,
      subject: 'Wholesale price for 40 mugs?',
      body: 'Hi Sofia,\n\nWe would like 40 of the speckled mugs for the café. Do you have a wholesale price, and could they be ready by the end of next month?\n\nHugo',
      at: hoursAgo(now, 5),
      labels: ['INBOX', 'UNREAD'],
    },
    {
      id: 'claywork-invoice',
      threadId: 'thread-claywork-invoice',
      from: 'Claywork Supplies <accounts@claywork.example.com>',
      to: owner.email,
      subject: 'Invoice CW-5512 is due on Friday',
      body: 'Invoice CW-5512 for €318.00 (stoneware clay, 150 kg) is due on Friday. Please pay by bank transfer.',
      at: hoursAgo(now, 20),
      labels: ['INBOX', 'UNREAD'],
    },
    {
      id: 'kilnclub-news',
      from: 'Kiln Club <news@kilnclub.example.org>',
      to: owner.email,
      subject: 'Kiln Club: glaze tests of the month',
      body: 'Ten glaze tests from members this month.\n\nUnsubscribe: https://kilnclub.example.org/unsubscribe',
      at: hoursAgo(now, 30),
      labels: ['INBOX'],
    },
  ];
}

export default scenario({
  id: 'happy-path-vague-delegation',
  title: 'Run the whole business for me: one concrete first step, not a questionnaire',
  linear: 'LAB-2703',
  capabilities: ['progress', 'apps'],
  tier: 'full',
  set: 'happy-path',
  complexity: 'medium',
  stance: 'regression',
  calibration: 'pending',
  seconds: 420,
  user: {
    approve: false,
    persona:
      'You are Sofia Marin, who makes and sells ceramics on her own. You set up Nod today and connected your email. You have no plan for how to use it and you do not want to fill in a form. If asked one clear question, you answer briefly. You do not want anything sent or paid today.',
  },
  world: (clock) => ({
    apps: createApps(owner, { gmail: gmail(owner, mailbox(clock.now()), clock.now) }),
  }),
  async play(session) {
    await session.say('I run a small ceramics shop on my own. Just run the whole business for me.');
  },
  evidence() {
    return 'Gmail is connected. The inbox holds a wholesale enquiry from Hugo Lambert for 40 mugs that needs a reply, a supplier invoice from Claywork Supplies for €318.00 due on Friday, and a newsletter. The owner gave no specific task and approved no action.';
  },
  expect() {
    return [
      check('replied', (run) => run.replies.length >= 1, {
        aspect: 'process',
        failure: 'incomplete',
      }),
      noWrites('send', 'post', 'delete'),
      check(
        'no-job-saved-without-a-yes',
        (run) => ({
          pass: !run.schedules.length,
          evidence: `${run.schedules.length} schedules`,
        }),
        { aspect: 'process', failure: 'scope' },
      ),
      asksAtMost(1),
      check('names-something-real-from-the-inbox', (run) => concrete.test(run.said), {
        required: false,
        failure: 'reasoning',
        otherwise:
          'The reply refers to the wholesale enquiry from Hugo Lambert or to the Claywork Supplies invoice, in any wording.',
      }),
      judge(
        'one-concrete-first-step',
        'The reply turns the vague request into something the owner can say yes to now: it proposes one to three specific first jobs, or has already done a harmless one such as listing what in the inbox needs her. It asks at most one question. It does not promise to run the business unattended, and it does not answer with a list of several questions about the business before doing anything.',
        { failure: 'overcaution' },
      ),
    ];
  },
});
