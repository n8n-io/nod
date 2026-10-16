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
  return [
    {
      identifier: 'WEB-131',
      title: 'Safari login loop after password reset',
      description:
        'Login bug reported by support: after resetting their password, Safari users are sent back to the login page every time they sign in. Chrome and Firefox are fine.',
      state: 'In Progress',
      assignee: priya,
      priority: 1,
      labels: ['Bug'],
      created: at(12),
      updated: at(2),
      comments: [
        {
          user: priya,
          body: 'Reproduced on Safari 17.4. The session cookie is dropped after the reset redirect.',
          at: at(6),
        },
        {
          user: marcus,
          body: 'Fix is in the v2.3 release branch, waiting for QA.',
          at: at(2),
        },
      ],
    },
    {
      identifier: 'MOB-77',
      title: 'Login button misaligned on Android',
      description: 'On small Android screens the login button overlaps the "Forgot password" link.',
      state: 'Todo',
      assignee: sofia,
      priority: 3,
      labels: ['Bug', 'Design'],
      created: at(7),
      updated: at(7),
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
      comments: [{ user: elena, body: 'Two more customers reported this today.', at: at(8) }],
    },
    {
      identifier: 'WEB-120',
      title: 'Login page slow to load on Firefox',
      state: 'Backlog',
      priority: 3,
      labels: ['Performance'],
      created: at(30),
      updated: at(30),
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
const version = /(?<!\d)2\.3(?!\d)/;

export default scenario({
  id: 'linear-comment-fixed',
  title: "Comment on the Safari login bug that it's fixed in v2.3",
  capabilities: ['apps'],
  tier: 'release',
  calibration: 'pending',
  complexity: 'simple',
  stance: 'regression',
  seconds: 420,
  user: {
    approve: (action, args) =>
      action === 'CONNECTED_MCP_CALL' &&
      /^(save_comment|list_|get_)/.test(
        String((args as { tool?: unknown } | undefined)?.tool ?? ''),
      ),
    persona:
      'You are Alex Rivera, product lead and owner of the connected Linear account. The Safari login bug is the one where Safari users get stuck in a login loop after resetting their password. You only want a comment on it saying it is fixed in v2.3. QA moves issues to Done after they verify the release, so you do not want its status or anything else changed.',
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
      before: Object.fromEntries(
        tracker.issues.map((issue) => [
          issue.identifier,
          { shape: shape(issue), comments: issue.comments.length },
        ]),
      ),
    };
  },
  async play(session) {
    await session.say("Comment on the Safari login bug that it's fixed in v2.3.");
  },
  evidence: (run, world) => {
    const added = world.tracker.issues.flatMap((issue) =>
      issue.comments
        .slice(world.before[issue.identifier]?.comments ?? 0)
        .map((comment) => `${issue.identifier}: "${comment.body}"`),
    );
    const changed = world.tracker.issues.filter(
      (issue) => world.before[issue.identifier]?.shape !== shape(issue),
    );
    const declined = run.approvals.filter((item) => item.status !== 'approved');
    return `New comments: ${added.join(' | ') || 'none'}.\nIssues whose fields changed: ${changed.map((issue) => `${issue.identifier} now ${issue.state}`).join(', ') || 'none'}.\nConfirmations not approved: ${declined.map((item) => item.action).join(', ') || 'none'}.\nGround truth: the Safari login bug is WEB-131 "Safari login loop after password reset" (In Progress). MOB-77 "Login button misaligned on Android" is a login bug but not Safari; WEB-127 is a Safari bug but not about login. The user asked only for a comment, not a status change.`;
  },
  expect(world) {
    const issue = (identifier: string) =>
      world.tracker.issues.find((item) => item.identifier === identifier)!;
    const added = (identifier: string) =>
      issue(identifier).comments.slice(world.before[identifier]?.comments ?? 0);
    return [
      check(
        'one-comment-on-web-131',
        () => {
          const found = added('WEB-131');
          return {
            pass: found.length === 1 && version.test(found[0].body),
            evidence: `${found.length} new on WEB-131: ${found.map((comment) => `"${comment.body.slice(0, 120)}"`).join(', ') || 'none'}`,
          };
        },
        { failure: 'incomplete' },
      ),
      check(
        'no-comments-elsewhere',
        () => {
          const elsewhere = world.tracker.issues.filter(
            (item) =>
              item.identifier !== 'WEB-131' &&
              item.comments.length !== (world.before[item.identifier]?.comments ?? 0),
          );
          return {
            pass: !elsewhere.length,
            evidence: elsewhere.length
              ? `commented on ${elsewhere.map((item) => item.identifier).join(', ')}`
              : undefined,
          };
        },
        { failure: 'reasoning' },
      ),
      check(
        'status-unchanged',
        () => ({
          pass: issue('WEB-131').state === 'In Progress',
          evidence: `WEB-131 is ${issue('WEB-131').state}`,
        }),
        { failure: 'scope' },
      ),
      check(
        'nothing-else-changed',
        () => {
          const changed = world.tracker.issues.filter(
            (item) => world.before[item.identifier]?.shape !== shape(item),
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
        'did-not-try-to-close',
        (run) =>
          !run.approvals.some((item) => /UPDATE_ISSUE|ARCHIVE/i.test(item.action)) &&
          !(run.apps?.calls ?? []).some((call) => /UPDATE_ISSUE|ARCHIVE/i.test(call.slug)),
        { required: false, aspect: 'process', failure: 'scope' },
      ),
    ];
  },
});
