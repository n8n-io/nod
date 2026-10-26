import { check, judge, scenario } from '../scenario.ts';
import { createApps } from '../world/apps.ts';
import { linear, type LinearIssue } from '../world/linear.ts';
import { daysAgo } from '../world/time.ts';

const owner = { name: 'Alex Rivera', email: 'alex.rivera@riveradesign.example' };
const people = [
  { name: 'Priya Nair', email: 'priya.nair@riveradesign.example' },
  { name: 'Marcus Webb', email: 'marcus.webb@riveradesign.example' },
  { name: 'Elena Costa', email: 'elena.costa@riveradesign.example' },
  { name: 'Jonas Weber', email: 'jonas.weber@riveradesign.example' },
  { name: 'Sofia Lindqvist', email: 'sofia.lindqvist@riveradesign.example' },
];
const [priya, marcus, elena, jonas, sofia] = people.map((person) => person.email);

function backlog(now: number): LinearIssue[] {
  const at = (days: number) => daysAgo(now, days);
  return [
    {
      identifier: 'WEB-118',
      title: 'Password reset emails not delivered',
      description:
        'Customers who request a password reset say the email never arrives, not even in spam. Started after the switch to the new email provider.',
      state: 'Todo',
      assignee: marcus,
      priority: 1,
      labels: ['Bug'],
      created: at(9),
      updated: at(3),
      comments: [{ user: elena, body: 'Four more tickets about this today.', at: at(3) }],
    },
    {
      identifier: 'WEB-109',
      title: 'Password reset link expires after 5 minutes',
      description:
        'The reset link in the email stops working after five minutes; it should last an hour.',
      state: 'Todo',
      assignee: priya,
      priority: 2,
      labels: ['Bug'],
      created: at(40),
      updated: at(12),
    },
    {
      identifier: 'WEB-95',
      title: 'Welcome email lands in spam for Outlook users',
      state: 'Done',
      assignee: marcus,
      priority: 3,
      labels: ['Bug'],
      created: at(80),
      updated: at(61),
      completed: at(61),
    },
    {
      identifier: 'WEB-104',
      title: 'Newsletter signup form ignores the double opt-in setting',
      state: 'Done',
      assignee: marcus,
      priority: 3,
      labels: ['Bug'],
      created: at(70),
      updated: at(52),
      completed: at(52),
    },
    {
      identifier: 'WEB-115',
      title: 'Checkout: show the VAT breakdown before payment',
      state: 'In Progress',
      assignee: priya,
      priority: 2,
      labels: ['Feature'],
      project: 'Checkout revamp',
      created: at(33),
      updated: at(2),
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
      identifier: 'WEB-131',
      title: 'Safari login loop after password reset',
      state: 'In Progress',
      assignee: priya,
      priority: 1,
      labels: ['Bug'],
      created: at(12),
      updated: at(2),
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
      identifier: 'WEB-136',
      title: 'Serve marketing site images as AVIF',
      state: 'In Progress',
      assignee: marcus,
      priority: 3,
      labels: ['Performance'],
      created: at(11),
      updated: at(4),
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
      identifier: 'MOB-61',
      title: 'iOS: push notifications arrive twice',
      state: 'Done',
      assignee: jonas,
      priority: 2,
      labels: ['Bug'],
      created: at(48),
      updated: at(35),
      completed: at(35),
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
      created: at(10),
      updated: at(5),
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

type Stored = ReturnType<typeof linear>['issues'][number];
const shape = (issue: Stored) =>
  JSON.stringify([
    issue.title,
    issue.description,
    issue.state,
    issue.assignee ?? null,
    issue.priority,
    issue.labels,
    issue.project ?? null,
    issue.dueDate ?? null,
    issue.archived,
  ]);

export default scenario({
  id: 'linear-dedupe-before-filing',
  title: "Log a bug: password reset email never arrives. Check it's not already in Linear first",
  capabilities: ['apps'],
  tier: 'release',
  calibration: 'pending',
  complexity: 'simple',
  stance: 'regression',
  seconds: 420,
  user: {
    approve: true,
    persona:
      'You are Alex Rivera, product lead and owner of the connected Linear account. A customer told you the password reset email never arrives. If Linear already has an issue for that same problem, you do not want a duplicate filed, you just want to know which issue it is. If nothing matches, file it in the Web team.',
  },
  world(clock) {
    const tracker = linear(
      owner,
      {
        teams: [
          { key: 'WEB', name: 'Web' },
          { key: 'MOB', name: 'Mobile' },
        ],
        users: people,
        labels: ['Bug', 'Feature', 'Improvement', 'Design', 'Performance'],
        projects: [
          { name: 'Checkout revamp', team: 'WEB' },
          { name: 'Mobile 3.0', team: 'MOB' },
        ],
        issues: backlog(clock.now()),
      },
      clock.now,
    );
    return {
      apps: createApps(owner, { linear: tracker }),
      tracker,
      before: Object.fromEntries(tracker.issues.map((issue) => [issue.identifier, shape(issue)])),
    };
  },
  async play(session) {
    await session.say(
      "Log a bug: password reset email never arrives. Check it's not already in Linear first.",
    );
  },
  evidence: (run, world) => {
    const created = world.tracker.issues.filter((issue) => !(issue.identifier in world.before));
    const changed = world.tracker.issues.filter(
      (issue) =>
        issue.identifier in world.before && world.before[issue.identifier] !== shape(issue),
    );
    const comments = run.writes.filter((write) => write.slug === 'save_comment');
    return `Issues created: ${created.map((issue) => `${issue.identifier} "${issue.title}"`).join('; ') || 'none'}.\nExisting issues changed: ${changed.map((issue) => issue.identifier).join(', ') || 'none'}.\nComments added: ${comments.map((write) => `${write.args.issueId ?? write.args.issue_id}: ${String(write.args.body).slice(0, 160)}`).join(' | ') || 'none'}.\nGround truth: WEB-118 "Password reset emails not delivered" (Todo, assigned to Marcus Webb) already covers this bug; its description says the reset email never arrives. WEB-109 (reset link expires too soon) and MOB-64 (reset screen crashes on Android) are different bugs. The correct outcome is no new issue and telling the user it is already WEB-118.`;
  },
  expect(world) {
    return [
      check(
        'no-duplicate-filed',
        () => {
          const created = world.tracker.issues.filter(
            (issue) => !(issue.identifier in world.before),
          );
          return {
            pass: !created.length,
            evidence: created.length
              ? `created ${created.map((issue) => `${issue.identifier} "${issue.title}"`).join('; ')}`
              : undefined,
          };
        },
        { failure: 'reasoning' },
      ),
      check(
        'points-to-web-118',
        (run) =>
          /(?<![A-Za-z0-9-])WEB[-\s]?118(?!\d)|password reset emails? (?:are )?not delivered/i.test(
            run.said,
          ),
        {
          failure: 'incomplete',
          otherwise:
            'Nod tells the owner the password reset bug is already filed in Linear as WEB-118 ("Password reset emails not delivered"), naming it by its identifier, its title or a paraphrase of it.',
        },
      ),
      check(
        'existing-issues-unchanged',
        () =>
          world.tracker.issues.every(
            (issue) =>
              !(issue.identifier in world.before) ||
              world.before[issue.identifier] === shape(issue),
          ),
        { required: false, failure: 'scope' },
      ),
      judge(
        'explains-the-match',
        'Across the messages the user saw, the assistant says the bug is already filed as WEB-118 ("Password reset emails not delivered") and that it did not file a new one. It must not claim it created an issue. Mentioning related issues such as WEB-109 or MOB-64 as different bugs is fine. Any wording or format is fine.',
        { required: false, aspect: 'process', failure: 'hallucination' },
      ),
    ];
  },
});
