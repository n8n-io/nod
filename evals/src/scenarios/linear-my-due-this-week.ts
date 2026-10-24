import { noWrites } from '../checks.ts';
import { check, judge, scenario } from '../scenario.ts';
import { createApps } from '../world/apps.ts';
import { linear, type LinearIssue } from '../world/linear.ts';
import { dayLabel, daysAgo, inDays, localDate } from '../world/time.ts';

const owner = { name: 'Alex Rivera', email: 'alex.rivera@riveradesign.example' };
const people = [
  { name: 'Priya Nair', email: 'priya.nair@riveradesign.example' },
  { name: 'Marcus Webb', email: 'marcus.webb@riveradesign.example' },
  { name: 'Alex Moreno', email: 'alex.moreno@riveradesign.example' },
  { name: 'Jonas Weber', email: 'jonas.weber@riveradesign.example' },
  { name: 'Sofia Lindqvist', email: 'sofia.lindqvist@riveradesign.example' },
];
const [priya, marcus, moreno, jonas, sofia] = people.map((person) => person.email);
const me = owner.email;

const mine = ['WEB-148', 'MOB-86', 'WEB-151'];
const gist: Record<string, RegExp> = {
  'WEB-148': /saved payment methods/i,
  'MOB-86': /app store screenshots/i,
  'WEB-151': /pricing page/i,
};
const later = ['WEB-144', 'MOB-79'];
const others = ['WEB-146', 'MOB-84', 'WEB-149'];

function backlog(now: number): LinearIssue[] {
  const at = (days: number) => daysAgo(now, days);
  const due = (days: number) => localDate(inDays(now, days));
  return [
    {
      identifier: 'WEB-148',
      title: 'Write acceptance criteria for saved payment methods',
      state: 'In Progress',
      assignee: me,
      priority: 2,
      labels: ['Feature'],
      project: 'Checkout revamp',
      dueDate: due(1),
      created: at(9),
      updated: at(1),
    },
    {
      identifier: 'MOB-86',
      title: 'Review the App Store screenshots for 3.0',
      state: 'Todo',
      assignee: me,
      priority: 3,
      labels: ['Design'],
      project: 'Mobile 3.0',
      dueDate: due(3),
      created: at(6),
      updated: at(2),
    },
    {
      identifier: 'WEB-151',
      title: 'Sign off the new pricing page copy',
      state: 'In Review',
      assignee: me,
      priority: 2,
      labels: [],
      dueDate: due(5),
      created: at(4),
      updated: at(1),
    },
    {
      identifier: 'WEB-144',
      title: 'Draft the Q1 roadmap for checkout',
      state: 'Todo',
      assignee: me,
      priority: 3,
      labels: [],
      project: 'Checkout revamp',
      dueDate: due(12),
      created: at(10),
      updated: at(3),
    },
    {
      identifier: 'MOB-79',
      title: 'Plan beta tester recruitment for 3.0',
      state: 'Backlog',
      assignee: me,
      priority: 4,
      labels: [],
      project: 'Mobile 3.0',
      dueDate: due(19),
      created: at(20),
      updated: at(8),
    },
    {
      identifier: 'WEB-140',
      title: 'Collect feedback on the onboarding emails',
      state: 'In Progress',
      assignee: me,
      priority: 3,
      labels: [],
      created: at(15),
      updated: at(5),
    },
    {
      identifier: 'WEB-137',
      title: 'Prepare the checkout usability test plan',
      state: 'Done',
      assignee: me,
      priority: 2,
      labels: [],
      project: 'Checkout revamp',
      dueDate: due(-3),
      created: at(16),
      updated: at(4),
      completed: at(4),
    },
    {
      identifier: 'WEB-146',
      title: 'Fix the flaky checkout end-to-end test',
      state: 'In Progress',
      assignee: priya,
      priority: 2,
      labels: ['Bug'],
      project: 'Checkout revamp',
      dueDate: due(2),
      created: at(7),
      updated: at(1),
    },
    {
      identifier: 'MOB-84',
      title: 'Crash-free sessions dashboard for the mobile apps',
      state: 'Todo',
      assignee: jonas,
      priority: 3,
      labels: ['Improvement'],
      dueDate: due(1),
      created: at(8),
      updated: at(2),
    },
    {
      identifier: 'WEB-149',
      title: 'Prepare the analytics review deck',
      state: 'Todo',
      assignee: moreno,
      priority: 3,
      labels: [],
      dueDate: due(4),
      created: at(5),
      updated: at(2),
    },
    {
      identifier: 'WEB-118',
      title: 'Password reset emails not delivered',
      state: 'Todo',
      assignee: marcus,
      priority: 1,
      labels: ['Bug'],
      dueDate: due(8),
      created: at(9),
      updated: at(3),
    },
    {
      identifier: 'WEB-121',
      title: 'Promo code field accepts expired codes',
      state: 'Done',
      assignee: priya,
      priority: 2,
      labels: ['Bug'],
      project: 'Checkout revamp',
      created: at(29),
      updated: at(20),
      completed: at(20),
    },
    {
      identifier: 'WEB-127',
      title: 'Safari: date picker overlaps the footer on the booking page',
      state: 'Todo',
      assignee: marcus,
      priority: 3,
      labels: ['Bug'],
      created: at(21),
      updated: at(8),
    },
    {
      identifier: 'WEB-130',
      title: 'Checkout button stays disabled after editing the shipping address',
      state: 'In Review',
      assignee: priya,
      priority: 2,
      labels: ['Bug'],
      project: 'Checkout revamp',
      created: at(14),
      updated: at(1),
    },
    {
      identifier: 'WEB-133',
      title: 'Dark mode contrast on the invoice table',
      state: 'Backlog',
      priority: 4,
      labels: ['Design'],
      created: at(13),
      updated: at(13),
    },
    {
      identifier: 'WEB-142',
      title: 'Add Apple Pay to checkout',
      state: 'Todo',
      priority: 2,
      labels: ['Feature'],
      project: 'Checkout revamp',
      created: at(4),
      updated: at(4),
    },
    {
      identifier: 'WEB-150',
      title: 'Order history pagination skips the last page',
      state: 'Todo',
      assignee: moreno,
      priority: 3,
      labels: ['Bug'],
      dueDate: due(13),
      created: at(3),
      updated: at(3),
    },
    {
      identifier: 'MOB-64',
      title: 'Password reset screen crashes on Android 12',
      state: 'In Progress',
      assignee: sofia,
      priority: 1,
      labels: ['Bug'],
      created: at(15),
      updated: at(2),
    },
    {
      identifier: 'MOB-71',
      title: 'Android app crashes at checkout when the cart is empty',
      state: 'Todo',
      assignee: jonas,
      priority: 2,
      labels: ['Bug'],
      dueDate: due(10),
      created: at(10),
      updated: at(5),
    },
    {
      identifier: 'MOB-74',
      title: 'iOS widget shows a stale order status',
      state: 'In Review',
      assignee: sofia,
      priority: 3,
      labels: ['Bug'],
      project: 'Mobile 3.0',
      created: at(18),
      updated: at(1),
    },
    {
      identifier: 'MOB-77',
      title: 'Login button misaligned on Android',
      state: 'Todo',
      assignee: sofia,
      priority: 3,
      labels: ['Bug', 'Design'],
      created: at(7),
      updated: at(7),
    },
    {
      identifier: 'MOB-80',
      title: 'Upgrade React Native to 0.76',
      state: 'In Progress',
      assignee: jonas,
      priority: 3,
      labels: ['Improvement'],
      project: 'Mobile 3.0',
      created: at(25),
      updated: at(3),
    },
    {
      identifier: 'MOB-82',
      title: 'Fix the crash when rotating the order details screen',
      state: 'Done',
      assignee: moreno,
      priority: 2,
      labels: ['Bug'],
      created: at(12),
      updated: at(2),
      completed: at(2),
    },
    {
      identifier: 'MOB-83',
      title: 'Biometric login toggle resets after an app update',
      state: 'Todo',
      assignee: sofia,
      priority: 2,
      labels: ['Bug'],
      created: at(5),
      updated: at(5),
    },
  ];
}

const named = (text: string, issue: { identifier: string; title: string }) =>
  new RegExp(`(?<![A-Za-z0-9-])${issue.identifier}(?!\\d)`, 'i').test(text) ||
  text.toLowerCase().includes(issue.title.toLowerCase());

export default scenario({
  id: 'linear-my-due-this-week',
  title: "What's assigned to me in Linear that's due this week?",
  capabilities: ['apps'],
  tier: 'release',
  calibration: 'pending',
  complexity: 'simple',
  stance: 'regression',
  seconds: 420,
  user: {
    approve: false,
    persona:
      'You are Alex Rivera (alex.rivera@riveradesign.example), product lead and the owner of the connected Linear account. Alex Moreno is a different person on the team. By "this week" you mean today and the next six days, as you said. You only want to know what is on your own plate; you do not want anything changed in Linear.',
  },
  world(clock) {
    const now = clock.now();
    const tracker = linear(
      owner,
      {
        teams: [
          { key: 'WEB', name: 'Web' },
          { key: 'MOB', name: 'Mobile' },
        ],
        users: people,
        labels: ['Bug', 'Feature', 'Improvement', 'Design'],
        projects: [
          { name: 'Checkout revamp', team: 'WEB' },
          { name: 'Mobile 3.0', team: 'MOB' },
        ],
        issues: backlog(now),
      },
      clock.now,
    );
    return {
      apps: createApps(owner, { linear: tracker }),
      tracker,
      end: dayLabel(inDays(now, 6)),
    };
  },
  async play(session, world) {
    await session.say(
      `What's assigned to me in Linear that's due this week (today through ${world.end})?`,
    );
  },
  evidence: (_run, world) => {
    const line = (identifier: string) => {
      const issue = world.tracker.issues.find((item) => item.identifier === identifier)!;
      return `${issue.identifier} "${issue.title}" (${issue.state}, assignee ${issue.assignee}, due ${issue.dueDate})`;
    };
    return `The question covers today through ${world.end}.\nAssigned to the user (Alex Rivera) and due in that window, the correct answer: ${mine.map(line).join('; ')}.\nAssigned to the user but due later, not this week: ${later.map(line).join('; ')}.\nDue this week but assigned to someone else (not the user; Alex Moreno is a different person): ${others.map(line).join('; ')}.\nThe user also has WEB-140 with no due date and WEB-137, already Done with a past due date.`;
  },
  expect(world) {
    const issue = (identifier: string) =>
      world.tracker.issues.find((item) => item.identifier === identifier)!;
    return [
      check(
        'lists-my-three',
        (run) => {
          const missing = mine.filter(
            (identifier) => !named(run.said, issue(identifier)) && !gist[identifier].test(run.said),
          );
          return {
            pass: !missing.length,
            evidence: missing.length ? `missing ${missing.join(', ')}` : undefined,
          };
        },
        {
          failure: 'incomplete',
          otherwise:
            'The answer refers to each of the owner\'s three issues due this week, WEB-148 "Write acceptance criteria for saved payment methods", MOB-86 "Review the App Store screenshots for 3.0" and WEB-151 "Sign off the new pricing page copy", by identifier, title or a paraphrase of what it is about.',
        },
      ),
      check(
        'leaves-out-others-issues',
        (run) => {
          const found = others.filter((identifier) => named(run.said, issue(identifier)));
          return {
            pass: !found.length,
            evidence: found.length ? `mentioned ${found.join(', ')}` : undefined,
          };
        },
        { required: false, failure: 'reasoning' },
      ),
      judge(
        'others-issues-not-presented-as-mine',
        "The assistant does not present WEB-146 (Priya Nair), MOB-84 (Jonas Weber) or WEB-149 (Alex Moreno) as assigned to the user. Not mentioning them, or mentioning them as someone else's, passes. It fails if any of them is listed among the user's own items due this week.",
        { failure: 'reasoning' },
      ),
      noWrites('create', 'update', 'post', 'delete'),
      judge(
        'later-items-not-due-this-week',
        `The assistant does not present WEB-144 "Draft the Q1 roadmap for checkout" (due ${issue('WEB-144').dueDate}) or MOB-79 "Plan beta tester recruitment for 3.0" (due ${issue('MOB-79').dueDate}) as due this week. Not mentioning them passes, and so does mentioning them as coming up later, after ${world.end}. It fails if either is listed among the items due this week.`,
        { failure: 'reasoning' },
      ),
      judge(
        'due-dates-right',
        `Where the assistant gives a due date or weekday for an issue, it matches Linear: WEB-148 due ${issue('WEB-148').dueDate}, MOB-86 due ${issue('MOB-86').dueDate}, WEB-151 due ${issue('WEB-151').dueDate}. Any date format or a correct weekday name is fine. Giving no dates also passes.`,
        { required: false, failure: 'hallucination' },
      ),
    ];
  },
});
