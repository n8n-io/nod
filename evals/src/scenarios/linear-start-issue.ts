import { check, scenario } from '../scenario.ts';
import { createApps } from '../world/apps.ts';
import { linear, type LinearIssue } from '../world/linear.ts';
import { daysAgo } from '../world/time.ts';

const owner = { name: 'Alex Rivera', email: 'alex.rivera@riveradesign.example' };
const people = [
  { name: 'Priya Nair', email: 'priya.nair@riveradesign.example' },
  { name: 'Marcus Webb', email: 'marcus.webb@riveradesign.example' },
  { name: 'Alex Moreno', email: 'alex.moreno@riveradesign.example' },
  { name: 'Jonas Weber', email: 'jonas.weber@riveradesign.example' },
  { name: 'Sofia Lindqvist', email: 'sofia.lindqvist@riveradesign.example' },
];
const [priya, marcus, moreno, jonas, sofia] = people.map((person) => person.email);

function backlog(now: number): LinearIssue[] {
  const at = (days: number) => daysAgo(now, days);
  return [
    {
      identifier: 'WEB-142',
      title: 'Add Apple Pay to checkout',
      description:
        'Offer Apple Pay as a payment method on the checkout page for Safari users. Merchant validation is already set up.',
      state: 'Todo',
      priority: 2,
      labels: ['Feature'],
      project: 'Checkout revamp',
      created: at(4),
      updated: at(4),
    },
    {
      identifier: 'WEB-124',
      title: 'Spike: Apple Pay merchant validation',
      description:
        'Find out what the payment provider needs from us to validate the Apple Pay merchant.',
      state: 'Todo',
      priority: 3,
      labels: ['Feature'],
      project: 'Checkout revamp',
      created: at(26),
      updated: at(9),
    },
    {
      identifier: 'WEB-141',
      title: 'Add Google Pay to checkout',
      state: 'Todo',
      priority: 3,
      labels: ['Feature'],
      project: 'Checkout revamp',
      created: at(4),
      updated: at(4),
    },
    {
      identifier: 'WEB-143',
      title: 'Show saved cards first in the payment step',
      state: 'Backlog',
      priority: 4,
      labels: ['Improvement'],
      project: 'Checkout revamp',
      created: at(3),
      updated: at(3),
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
      identifier: 'WEB-136',
      title: 'Serve marketing site images as AVIF',
      state: 'In Progress',
      assignee: moreno,
      priority: 3,
      labels: ['Improvement'],
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
      identifier: 'WEB-140',
      title: 'Collect feedback on the onboarding emails',
      state: 'In Progress',
      assignee: owner.email,
      priority: 3,
      labels: [],
      created: at(15),
      updated: at(5),
    },
    {
      identifier: 'MOB-42',
      title: 'Apple Pay sheet does not open on iPad',
      state: 'Todo',
      priority: 2,
      labels: ['Bug'],
      created: at(30),
      updated: at(6),
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
      identifier: 'MOB-83',
      title: 'Biometric login toggle resets after an app update',
      state: 'Todo',
      assignee: moreno,
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
const fields = (issue: Stored) =>
  JSON.stringify([
    issue.title,
    issue.description,
    issue.priority,
    issue.labels,
    issue.project ?? null,
    issue.dueDate ?? null,
    issue.archived,
  ]);

export default scenario({
  id: 'linear-start-issue',
  title: 'Move WEB-142 to In Progress and assign it to me',
  capabilities: ['apps'],
  tier: 'release',
  calibration: 'pending',
  complexity: 'simple',
  stance: 'regression',
  seconds: 360,
  user: {
    approve: true,
    persona:
      'You are Alex Rivera (alex.rivera@riveradesign.example), product lead and the owner of the connected Linear account. Alex Moreno is a different person on the team. You want WEB-142, the Apple Pay checkout issue, started and assigned to yourself; nothing else should change.',
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
        labels: ['Bug', 'Feature', 'Improvement', 'Design'],
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
      target: fields(tracker.issues.find((issue) => issue.identifier === 'WEB-142')!),
    };
  },
  async play(session) {
    await session.say('Move WEB-142 to In Progress and assign it to me.');
  },
  evidence: (_run, world) => {
    const line = (issue: Stored) =>
      `${issue.identifier} "${issue.title}" state ${issue.state}, assignee ${issue.assignee ?? 'none'}`;
    const issue = (identifier: string) =>
      world.tracker.issues.find((item) => item.identifier === identifier)!;
    const changed = world.tracker.issues.filter(
      (item) => world.before[item.identifier] !== shape(item),
    );
    return `After the run: ${line(issue('WEB-142'))}; ${line(issue('WEB-124'))}.\nIssues that changed in any way: ${changed.map(line).join('; ') || 'none'}.\nGround truth: the user is Alex Rivera (alex.rivera@riveradesign.example); Alex Moreno is a different teammate. Before the run WEB-142 "Add Apple Pay to checkout" was Todo and unassigned. WEB-124 and MOB-42 are similar Apple Pay issues that must stay as they were.`;
  },
  expect(world) {
    const issue = (identifier: string) =>
      world.tracker.issues.find((item) => item.identifier === identifier)!;
    return [
      check(
        'web-142-in-progress',
        () => ({
          pass: issue('WEB-142').state === 'In Progress',
          evidence: `WEB-142 is ${issue('WEB-142').state}`,
        }),
        { failure: 'incomplete' },
      ),
      check(
        'web-142-assigned-to-me',
        () => ({
          pass: issue('WEB-142').assignee === owner.email,
          evidence: `WEB-142 assignee ${issue('WEB-142').assignee ?? 'none'}`,
        }),
        { failure: 'reasoning' },
      ),
      check(
        'decoy-untouched',
        () => ({
          pass: world.before['WEB-124'] === shape(issue('WEB-124')),
          evidence: `WEB-124 is ${issue('WEB-124').state}, assignee ${issue('WEB-124').assignee ?? 'none'}`,
        }),
        { failure: 'reasoning' },
      ),
      check(
        'nothing-else-changed',
        () => {
          const changed = world.tracker.issues.filter(
            (item) =>
              item.identifier !== 'WEB-142' && world.before[item.identifier] !== shape(item),
          );
          return {
            pass: !changed.length,
            evidence: changed.length
              ? `changed ${changed.map((item) => item.identifier).join(', ')}`
              : undefined,
          };
        },
        { failure: 'scope' },
      ),
      check('web-142-otherwise-unchanged', () => fields(issue('WEB-142')) === world.target, {
        failure: 'scope',
      }),
    ];
  },
});
