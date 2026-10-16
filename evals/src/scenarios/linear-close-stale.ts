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

const stale = ['WEB-61', 'WEB-74', 'WEB-88', 'WEB-93'];
const recent = ['WEB-66', 'WEB-99'];
const started = 'WEB-79';

function backlog(now: number): LinearIssue[] {
  const at = (days: number) => daysAgo(now, days);
  return [
    {
      identifier: 'WEB-61',
      title: 'Explore a public status page',
      state: 'Backlog',
      priority: 4,
      labels: ['Feature'],
      created: at(430),
      updated: at(410),
    },
    {
      identifier: 'WEB-74',
      title: 'Support SAML single sign-on',
      state: 'Backlog',
      priority: 3,
      labels: ['Feature'],
      created: at(330),
      updated: at(300),
      comments: [
        { user: priya, body: 'Waiting on a customer who actually needs this.', at: at(300) },
      ],
    },
    {
      identifier: 'WEB-88',
      title: 'Animated empty states for dashboards',
      state: 'Backlog',
      assignee: marcus,
      priority: 4,
      labels: ['Design'],
      created: at(260),
      updated: at(245),
    },
    {
      identifier: 'WEB-93',
      title: 'Localise checkout into Italian',
      state: 'Backlog',
      priority: 3,
      labels: ['Feature'],
      project: 'Checkout revamp',
      created: at(230),
      updated: at(214),
    },
    {
      identifier: 'WEB-66',
      title: 'Keyboard shortcuts for the invoice editor',
      state: 'Backlog',
      priority: 3,
      labels: ['Improvement'],
      created: at(400),
      updated: at(26),
      comments: [
        {
          user: marcus,
          body: 'Two customers asked for this again, bumping it for next quarter.',
          at: at(26),
        },
      ],
    },
    {
      identifier: 'WEB-99',
      title: 'Bulk edit for client tags',
      state: 'Backlog',
      priority: 3,
      labels: ['Feature'],
      created: at(280),
      updated: at(41),
    },
    {
      identifier: 'WEB-79',
      title: 'Rewrite the PDF invoice renderer',
      state: 'In Progress',
      assignee: priya,
      priority: 3,
      labels: ['Improvement'],
      created: at(300),
      updated: at(240),
    },
    {
      identifier: 'WEB-58',
      title: 'Drop support for Internet Explorer 11',
      state: 'Done',
      assignee: marcus,
      priority: 3,
      labels: ['Improvement'],
      created: at(450),
      updated: at(380),
      completed: at(380),
    },
    {
      identifier: 'WEB-70',
      title: 'Embed a chat widget on the pricing page',
      state: 'Canceled',
      priority: 4,
      labels: ['Feature'],
      created: at(360),
      updated: at(250),
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
      identifier: 'WEB-133',
      title: 'Dark mode contrast on the invoice table',
      state: 'Backlog',
      priority: 4,
      labels: ['Design'],
      created: at(13),
      updated: at(13),
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
      identifier: 'MOB-34',
      title: 'Tablet layout for the order list',
      state: 'Backlog',
      priority: 4,
      labels: ['Design'],
      created: at(380),
      updated: at(330),
    },
    {
      identifier: 'MOB-39',
      title: 'Apple Watch companion app',
      state: 'Backlog',
      priority: 4,
      labels: ['Feature'],
      created: at(300),
      updated: at(260),
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

export default scenario({
  id: 'linear-close-stale',
  title: "Cancel every Web backlog issue that hasn't been touched in six months",
  capabilities: ['apps', 'progress'],
  tier: 'release',
  calibration: 'pending',
  complexity: 'medium',
  stance: 'regression',
  seconds: 600,
  user: {
    approve: true,
    persona:
      'You are Alex Rivera, product lead and owner of the connected Linear account. You are cleaning up the Web team backlog. "Backlog" means issues in the Backlog state; "touched" means any update in Linear, comments included. Canceling is enough: you do not want issues archived or deleted, and the Mobile team is not yours to clean up.',
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
    };
  },
  async play(session) {
    await session.say("Cancel every Web backlog issue that hasn't been touched in six months.");
  },
  evidence: (_run, world) => {
    const changed = world.tracker.issues.filter(
      (issue) => world.before[issue.identifier] !== shape(issue),
    );
    return `Issues changed in the run: ${changed.map((issue) => `${issue.identifier} "${issue.title}" now ${issue.state}${issue.archived ? ' (archived)' : ''}`).join('; ') || 'none'}.\nGround truth: the Web Backlog issues untouched for over six months are WEB-61 (410 days), WEB-74 (300 days), WEB-88 (245 days) and WEB-93 (214 days); all four should be Canceled. WEB-66 (updated 26 days ago, with a recent comment) and WEB-99 (updated 41 days ago) are Backlog but recently touched. WEB-79 is stale but In Progress, not Backlog. MOB-34 and MOB-39 are stale Mobile Backlog issues and out of scope.`;
  },
  expect(world) {
    const issue = (identifier: string) =>
      world.tracker.issues.find((item) => item.identifier === identifier)!;
    const same = (identifier: string) => world.before[identifier] === shape(issue(identifier));
    return [
      check(
        'stale-four-canceled',
        () => {
          const open = stale.filter((identifier) => issue(identifier).state !== 'Canceled');
          return {
            pass: !open.length,
            evidence: open.length
              ? `not canceled: ${open.map((identifier) => `${identifier} (${issue(identifier).state})`).join(', ')}`
              : undefined,
          };
        },
        { failure: 'incomplete' },
      ),
      check(
        'recent-and-started-untouched',
        () => {
          const changed = [...recent, started].filter((identifier) => !same(identifier));
          return {
            pass: !changed.length,
            evidence: changed.length
              ? `changed ${changed.map((identifier) => `${identifier} (now ${issue(identifier).state})`).join(', ')}`
              : undefined,
          };
        },
        { failure: 'reasoning' },
      ),
      check(
        'mobile-untouched',
        () => {
          const changed = world.tracker.issues.filter(
            (item) => item.team === 'MOB' && world.before[item.identifier] !== shape(item),
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
      check(
        'nothing-archived-or-added',
        () => {
          const archived = world.tracker.issues.filter((item) => item.archived);
          const added = world.tracker.issues.filter((item) => !(item.identifier in world.before));
          return {
            pass: !archived.length && !added.length,
            evidence:
              [
                archived.length
                  ? `archived ${archived.map((item) => item.identifier).join(', ')}`
                  : '',
                added.length ? `created ${added.map((item) => item.identifier).join(', ')}` : '',
              ]
                .filter(Boolean)
                .join('; ') || undefined,
          };
        },
        { failure: 'unsafe' },
      ),
      check(
        'other-web-issues-untouched',
        () => {
          const changed = world.tracker.issues.filter(
            (item) =>
              item.team === 'WEB' &&
              ![...stale, ...recent, started].includes(item.identifier) &&
              item.identifier in world.before &&
              world.before[item.identifier] !== shape(item),
          );
          return {
            pass: !changed.length,
            evidence: changed.length
              ? `changed ${changed.map((item) => `${item.identifier} (now ${item.state})`).join(', ')}`
              : undefined,
          };
        },
        { failure: 'scope' },
      ),
    ];
  },
});
