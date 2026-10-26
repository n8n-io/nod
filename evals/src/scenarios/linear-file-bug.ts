import { check, scenario } from '../scenario.ts';
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
  const done = (days: number) => ({ updated: at(days), completed: at(days) });
  return [
    {
      identifier: 'WEB-104',
      title: 'Newsletter signup form ignores the double opt-in setting',
      state: 'Done',
      assignee: marcus,
      priority: 3,
      labels: ['Bug'],
      created: at(70),
      ...done(52),
    },
    {
      identifier: 'WEB-109',
      title: 'Password reset link expires after 5 minutes',
      state: 'Todo',
      assignee: priya,
      priority: 2,
      labels: ['Bug'],
      created: at(40),
      updated: at(12),
    },
    {
      identifier: 'WEB-112',
      title: 'Pricing page FAQ accordion does not close on mobile',
      state: 'Done',
      assignee: marcus,
      priority: 4,
      labels: ['Bug', 'Design'],
      created: at(38),
      ...done(30),
    },
    {
      identifier: 'WEB-115',
      title: 'Checkout: show the VAT breakdown before payment',
      description: 'Customers in the EU want to see VAT as its own line before they pay.',
      state: 'In Progress',
      assignee: priya,
      priority: 2,
      labels: ['Feature'],
      project: 'Checkout revamp',
      created: at(33),
      updated: at(2),
    },
    {
      identifier: 'WEB-118',
      title: 'Password reset emails not delivered',
      state: 'Todo',
      assignee: marcus,
      priority: 1,
      labels: ['Bug'],
      created: at(9),
      updated: at(3),
    },
    {
      identifier: 'WEB-121',
      title: 'Promo code field accepts expired codes',
      description: 'Expired promo codes still apply a discount at checkout.',
      state: 'Done',
      assignee: priya,
      priority: 2,
      labels: ['Bug'],
      project: 'Checkout revamp',
      created: at(29),
      ...done(20),
    },
    {
      identifier: 'WEB-124',
      title: 'Add Google Pay to checkout',
      state: 'Backlog',
      priority: 3,
      labels: ['Feature'],
      project: 'Checkout revamp',
      created: at(26),
      updated: at(26),
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
      identifier: 'WEB-139',
      title: 'Cart total rounds incorrectly for JPY',
      state: 'Todo',
      assignee: priya,
      priority: 2,
      labels: ['Bug'],
      project: 'Checkout revamp',
      created: at(6),
      updated: at(6),
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
      ...done(35),
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
      identifier: 'MOB-68',
      title: 'Offline mode for saved carts',
      state: 'Backlog',
      priority: 4,
      labels: ['Feature'],
      project: 'Mobile 3.0',
      created: at(44),
      updated: at(44),
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
      assignee: elena,
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
    issue.comments.length,
  ]);
const describe = (issue: Stored) =>
  `${issue.identifier} [${issue.state}, priority ${issue.priority}, labels ${issue.labels.join('/') || 'none'}${issue.project ? `, project ${issue.project}` : ''}${issue.assignee ? `, assignee ${issue.assignee}` : ''}] "${issue.title}": ${issue.description.slice(0, 300)}`;

export default scenario({
  id: 'linear-file-bug',
  title:
    "File a bug in Linear: the checkout page crashes on Safari when the promo code field is empty. It's urgent",
  capabilities: ['apps'],
  tier: 'release',
  calibration: 'pending',
  complexity: 'simple',
  stance: 'regression',
  seconds: 420,
  user: {
    approve: true,
    persona:
      'You are Alex Rivera, product lead at Rivera Design. The checkout page is part of the website, so its bugs belong to the Web team; the Mobile team only works on the native iOS and Android apps. You saw it yourself: in Safari on a Mac and on an iPhone, leaving the promo code field empty and pressing Pay makes the checkout page crash to a blank screen. It is urgent because customers cannot pay. You do not mind who it is assigned to or which project it sits in.',
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
      "File a bug in Linear: the checkout page crashes on Safari when the promo code field is empty. It's urgent.",
    );
  },
  evidence: (_run, world) => {
    const created = world.tracker.issues.filter((issue) => !(issue.identifier in world.before));
    const changed = world.tracker.issues.filter(
      (issue) =>
        issue.identifier in world.before && world.before[issue.identifier] !== shape(issue),
    );
    return `Issues created: ${created.map(describe).join(' | ') || 'none'}.\nExisting issues changed: ${changed.map(describe).join(' | ') || 'none'}.\nGround truth: the checkout page is a website page, so the bug belongs in the Web team (WEB). Priority 1 means Urgent. A "Bug" label exists. No existing issue describes this crash: WEB-121 (expired promo codes, Done) and MOB-71 (Android app crash with an empty cart) are different bugs.`;
  },
  expect(world) {
    const created = () =>
      world.tracker.issues.filter((issue) => !(issue.identifier in world.before));
    const text = (issue: Stored) => `${issue.title}\n${issue.description}`;
    return [
      check(
        'one-new-issue',
        () => {
          const found = created();
          return {
            pass: found.length === 1,
            evidence: `${found.length} new: ${found.map((issue) => `${issue.identifier} "${issue.title}"`).join(', ') || 'none'}`,
          };
        },
        { failure: 'incomplete' },
      ),
      check(
        'filed-in-web-team',
        () => {
          const found = created();
          return {
            pass: found.length > 0 && found.every((issue) => issue.team === 'WEB'),
            evidence: found.map((issue) => issue.identifier).join(', ') || 'no issue',
          };
        },
        { failure: 'reasoning' },
      ),
      check(
        'describes-safari-and-promo',
        () => {
          const found = created();
          const vague = found.filter(
            (issue) => !/safari/i.test(text(issue)) || !/promo/i.test(text(issue)),
          );
          return {
            pass: found.length > 0 && !vague.length,
            evidence: vague.length
              ? `missing Safari or promo in ${vague.map((issue) => `"${issue.title}"`).join(', ')}`
              : undefined,
          };
        },
        {
          failure: 'reasoning',
          otherwise:
            'Every new Linear issue Nod filed describes, in its title or description and in any wording, the checkout page crashing on Safari when the promo code field is empty.',
        },
      ),
      check(
        'priority-urgent',
        () => {
          const found = created();
          return {
            pass: found.length > 0 && found.every((issue) => issue.priority === 1),
            evidence: found
              .map((issue) => `${issue.identifier} priority ${issue.priority}`)
              .join(', '),
          };
        },
        { failure: 'reasoning' },
      ),
      check(
        'bug-label',
        () => {
          const found = created();
          return found.length > 0 && found.every((issue) => issue.labels.includes('Bug'));
        },
        { required: false, failure: 'reasoning' },
      ),
      check(
        'existing-issues-unchanged',
        () => {
          const changed = world.tracker.issues.filter(
            (issue) =>
              issue.identifier in world.before && world.before[issue.identifier] !== shape(issue),
          );
          return {
            pass: !changed.length,
            evidence: changed.length
              ? `changed ${changed.map((issue) => issue.identifier).join(', ')}`
              : undefined,
          };
        },
        { required: false, failure: 'scope' },
      ),
      check(
        'reply-names-the-issue',
        (run) => {
          const found = created();
          return (
            found.length > 0 &&
            found.every((issue) =>
              new RegExp(`(?<![A-Za-z0-9-])${issue.identifier}(?!\\d)`, 'i').test(run.said),
            )
          );
        },
        { required: false, aspect: 'process', failure: 'format' },
      ),
    ];
  },
});
