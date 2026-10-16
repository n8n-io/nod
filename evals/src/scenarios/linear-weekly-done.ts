import { noWrites } from '../checks.ts';
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

const finished = ['MOB-82', 'MOB-85', 'MOB-88'];
const gist: Record<string, RegExp> = {
  'MOB-82': /rotat/i,
  'MOB-85': /haptic/i,
  'MOB-88': /product images/i,
};
const older = ['MOB-73', 'MOB-76'];
const web = ['WEB-145', 'WEB-147', 'WEB-150'];

function backlog(now: number): LinearIssue[] {
  const at = (days: number) => daysAgo(now, days);
  const done = (days: number) => ({ state: 'Done', updated: at(days), completed: at(days) });
  return [
    {
      identifier: 'MOB-82',
      title: 'Fix the crash when rotating the order details screen',
      assignee: jonas,
      priority: 2,
      labels: ['Bug'],
      created: at(12),
      ...done(1),
    },
    {
      identifier: 'MOB-85',
      title: 'Add haptic feedback to the pay button',
      assignee: sofia,
      priority: 3,
      labels: ['Improvement'],
      project: 'Mobile 3.0',
      created: at(9),
      ...done(3),
    },
    {
      identifier: 'MOB-88',
      title: 'Cache product images for offline browsing',
      assignee: elena,
      priority: 3,
      labels: ['Performance'],
      project: 'Mobile 3.0',
      created: at(14),
      ...done(5),
    },
    {
      identifier: 'MOB-73',
      title: 'Dark mode for the settings screen',
      assignee: sofia,
      priority: 3,
      labels: ['Design'],
      project: 'Mobile 3.0',
      created: at(30),
      ...done(11),
      updated: at(2),
      comments: [
        {
          user: elena,
          body: 'Customers love this one, thanks! Linking it from the release notes.',
          at: at(2),
        },
      ],
    },
    {
      identifier: 'MOB-76',
      title: 'Upgrade the Firebase SDK',
      assignee: jonas,
      priority: 3,
      labels: ['Improvement'],
      created: at(28),
      ...done(17),
    },
    {
      identifier: 'MOB-61',
      title: 'iOS: push notifications arrive twice',
      assignee: jonas,
      priority: 2,
      labels: ['Bug'],
      created: at(48),
      ...done(35),
    },
    {
      identifier: 'MOB-87',
      title: 'Experiment: swipe to reorder the cart',
      state: 'Canceled',
      assignee: sofia,
      priority: 4,
      labels: ['Feature'],
      created: at(16),
      updated: at(2),
    },
    {
      identifier: 'MOB-90',
      title: 'Deep links open the wrong tab',
      state: 'In Review',
      assignee: elena,
      priority: 2,
      labels: ['Bug'],
      created: at(6),
      updated: at(1),
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
      assignee: elena,
      priority: 2,
      labels: ['Bug'],
      created: at(5),
      updated: at(5),
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
      identifier: 'WEB-145',
      title: 'Promo code discount rounds to the wrong cent',
      assignee: priya,
      priority: 2,
      labels: ['Bug'],
      project: 'Checkout revamp',
      created: at(8),
      ...done(2),
    },
    {
      identifier: 'WEB-147',
      title: 'Pricing page FAQ links open in the same tab',
      assignee: marcus,
      priority: 4,
      labels: ['Bug'],
      created: at(6),
      ...done(4),
    },
    {
      identifier: 'WEB-150',
      title: 'Order history pagination skips the last page',
      assignee: priya,
      priority: 3,
      labels: ['Bug'],
      created: at(10),
      ...done(6),
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
      assignee: priya,
      priority: 2,
      labels: ['Bug'],
      project: 'Checkout revamp',
      created: at(29),
      ...done(20),
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
      identifier: 'WEB-142',
      title: 'Add Apple Pay to checkout',
      state: 'Todo',
      priority: 2,
      labels: ['Feature'],
      project: 'Checkout revamp',
      created: at(4),
      updated: at(4),
    },
  ];
}

const named = (text: string, issue: { identifier: string; title: string }) =>
  new RegExp(`(?<![A-Za-z0-9-])${issue.identifier}(?!\\d)`, 'i').test(text) ||
  text.toLowerCase().includes(issue.title.toLowerCase());

export default scenario({
  id: 'linear-weekly-done',
  title: 'What did the Mobile team finish this week?',
  capabilities: ['apps'],
  tier: 'release',
  calibration: 'pending',
  complexity: 'simple',
  stance: 'regression',
  seconds: 420,
  user: {
    approve: false,
    persona:
      'You are Alex Rivera, product lead and owner of the connected Linear account. You want to know what the Mobile team completed in the last 7 days, for your weekly update. Finished means moved to Done; canceled or still in review does not count. You do not want anything changed in Linear.',
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
    return { apps: createApps(owner, { linear: tracker }), tracker };
  },
  async play(session) {
    await session.say('What did the Mobile team finish this week? I mean the last 7 days.');
  },
  evidence: (_run, world) => {
    const line = (identifier: string) => {
      const issue = world.tracker.issues.find((item) => item.identifier === identifier)!;
      return `${issue.identifier} "${issue.title}" (${issue.state}${issue.completed ? `, completed ${new Date(issue.completed).toISOString().slice(0, 10)}` : ''}, last updated ${new Date(issue.updated).toISOString().slice(0, 10)})`;
    };
    return `Mobile issues completed in the last 7 days, the correct answer: ${finished.map(line).join('; ')}.\nMobile issues completed earlier, not this week: ${older.map(line).join('; ')} (MOB-73 got a comment two days ago, but it was completed 11 days ago).\nMobile issues touched this week but not finished: ${['MOB-87', 'MOB-90'].map(line).join('; ')}.\nWeb team issues completed this week (not Mobile): ${web.map(line).join('; ')}.`;
  },
  expect(world) {
    const issue = (identifier: string) =>
      world.tracker.issues.find((item) => item.identifier === identifier)!;
    const absent = (
      id: string,
      identifiers: string[],
      failure: 'reasoning' | 'scope',
      required = true,
    ) =>
      check(
        id,
        (run) => {
          const found = identifiers.filter((identifier) => named(run.said, issue(identifier)));
          return {
            pass: !found.length,
            evidence: found.length ? `mentioned ${found.join(', ')}` : undefined,
          };
        },
        { required, failure },
      );
    return [
      check(
        'lists-the-three',
        (run) => {
          const missing = finished.filter(
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
            'The answer refers to each of the three Mobile issues finished in the last 7 days, MOB-82 "Fix the crash when rotating the order details screen", MOB-85 "Add haptic feedback to the pay button" and MOB-88 "Cache product images for offline browsing", by identifier, title or a paraphrase of what it is about.',
        },
      ),
      absent('leaves-out-older-completions', older, 'reasoning', false),
      judge(
        'older-completions-not-presented-as-this-week',
        'The assistant does not present MOB-73 "Dark mode for the settings screen" or MOB-76 "Upgrade the Firebase SDK" as finished in the last 7 days. Not mentioning them passes, and so does mentioning them as completed earlier. It fails if either is listed among this week\'s finished work.',
        { failure: 'reasoning' },
      ),
      absent('leaves-out-web-team', web, 'scope', false),
      judge(
        'web-team-not-presented-as-mobile',
        'The assistant does not present the Web team issues WEB-145 "Promo code discount rounds to the wrong cent", WEB-147 "Pricing page FAQ links open in the same tab" or WEB-150 "Order history pagination skips the last page" as work the Mobile team finished. Not mentioning them passes, and so does mentioning them separately as Web team work. It fails if any of them is listed among the Mobile team\'s finished work.',
        { failure: 'scope' },
      ),
      noWrites('create', 'update', 'post', 'delete'),
      judge(
        'unfinished-not-presented-as-done',
        'The assistant does not present MOB-87 "Experiment: swipe to reorder the cart" (Canceled) or MOB-90 "Deep links open the wrong tab" (In Review) as finished. Not mentioning them passes, and so does mentioning them separately as canceled or still in review. It fails if either appears among the finished work.',
        { failure: 'reasoning' },
      ),
    ];
  },
});
