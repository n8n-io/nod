import { check, judge, scenario } from '../scenario.ts';
import { createApps, slack } from '../world/apps.ts';
import { linear, type LinearIssue } from '../world/linear.ts';
import { daysAgo, duringToday, localTime } from '../world/time.ts';

const owner = { name: 'Alex Rivera', email: 'alex.rivera@riveradesign.example' };
const people = [
  { name: 'Priya Nair', email: 'priya.nair@riveradesign.example' },
  { name: 'Marcus Webb', email: 'marcus.webb@riveradesign.example' },
  { name: 'Elena Costa', email: 'elena.costa@riveradesign.example' },
  { name: 'Jonas Weber', email: 'jonas.weber@riveradesign.example' },
  { name: 'Sofia Lindqvist', email: 'sofia.lindqvist@riveradesign.example' },
];
const [priya, marcus, elena, jonas, sofia] = people.map((person) => person.email);
const slackPeople = [
  { id: 'U02PRIYA', name: 'Priya Nair', email: priya },
  { id: 'U03MARCUS', name: 'Marcus Webb', email: marcus },
  { id: 'U04ELENA', name: 'Elena Costa', email: elena },
  { id: 'U05JONAS', name: 'Jonas Weber', email: jonas },
];

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
      identifier: 'WEB-125',
      title: 'CSV export times out for workspaces with over 10k invoices',
      description:
        'Large workspaces get a 504 when exporting invoices to CSV. Needs a background job.',
      state: 'In Progress',
      assignee: priya,
      priority: 2,
      labels: ['Bug', 'Performance'],
      created: at(24),
      updated: at(4),
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
      updated: at(30),
      completed: at(30),
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
const text = (issue: Stored) => `${issue.title}\n${issue.description}`;
const isFirefox = (issue: Stored) =>
  /firefox/i.test(text(issue)) && /chart|dashboard|graph|blank/i.test(text(issue));
const isCsv = (issue: Stored) =>
  /csv|export/i.test(text(issue)) &&
  /accent|jos[eé]|zo[eë]|m[uü]ller|diacritic|special|unicode|ascii|utf|character|missing|omit|drop|skip|exclud|leav|left out/i.test(
    text(issue),
  );

export default scenario({
  id: 'linear-from-slack-reports',
  title:
    "Turn today's bug reports in #support into Linear issues for the Web team, but skip anything that's already filed",
  capabilities: ['apps', 'progress'],
  tier: 'release',
  calibration: 'pending',
  complexity: 'complex',
  stance: 'regression',
  seconds: 900,
  user: {
    approve: (action) => action === 'CONNECTED_MCP_CALL',
    persona:
      'You are Alex Rivera, product lead and owner of the connected Slack and Linear accounts. Bug reports that support posts in #support go to the Web team in Linear. A question about whether a feature exists is not a bug, so it should not be filed. You do not know offhand which reports are already in Linear; checking that is part of the job. Any sensible titles, descriptions and priorities are fine, and you do not want anything posted in Slack.',
  },
  world(clock) {
    const now = clock.now();
    const today = (hour: number, minute: number) =>
      duringToday(now, (hour * 60 + minute) / (24 * 60));
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
        issues: backlog(now),
      },
      clock.now,
    );
    const chat = slack(
      { ...owner, id: 'U01ALEX' },
      slackPeople,
      [
        {
          name: 'support',
          kind: 'channel',
          messages: [
            {
              user: 'U05JONAS',
              at: localTime(now, 1, 16, undefined, 20),
              text: 'Bug: avatar upload fails for PNG files over 5 MB, the spinner never stops. Customer: Harbor Studio.',
            },
            {
              user: 'U04ELENA',
              at: localTime(now, 1, 17, undefined, 5),
              text: 'Thanks Jonas, noted. Logging off for today.',
            },
            {
              user: 'U04ELENA',
              at: today(8, 5),
              text: 'Bug report: the invoice CSV export leaves out every customer whose name has an accent (José, Zoë, Müller). The file downloads fine, those rows just are not in it. Two customers flagged it earlier today.',
            },
            {
              user: 'U05JONAS',
              at: today(8, 40),
              text: 'Getting tickets again that the password reset email never arrives. Three customers so far today.',
            },
            {
              user: 'U04ELENA',
              at: today(9, 10),
              text: 'Question from Lumen Foods: can they schedule reports to be emailed to them every Monday? Is that something we support or plan to?',
            },
            {
              user: 'U05JONAS',
              at: today(9, 35),
              text: "New one: dashboard charts are blank in Firefox since yesterday's release. Chrome is fine. The console shows a ResizeObserver error.",
              replies: [
                {
                  user: 'U02PRIYA',
                  at: today(9, 45),
                  text: 'I can reproduce it on Firefox 131.',
                },
              ],
            },
            {
              user: 'U04ELENA',
              at: today(9, 55),
              text: 'Off to a customer call, back later.',
            },
          ],
        },
        {
          name: 'general',
          kind: 'channel',
          messages: [
            {
              user: 'U03MARCUS',
              at: today(9, 0),
              text: 'Reminder: release retro at 16:00 in the big room.',
            },
          ],
        },
      ],
      clock.now,
    );
    return {
      apps: createApps(owner, { slack: chat, linear: tracker }),
      tracker,
      before: Object.fromEntries(tracker.issues.map((issue) => [issue.identifier, shape(issue)])),
    };
  },
  async play(session) {
    await session.say(
      "Turn today's bug reports in #support into Linear issues for the Web team, but skip anything that's already filed.",
    );
  },
  evidence: (run, world) => {
    const created = world.tracker.issues.filter((issue) => !(issue.identifier in world.before));
    const slackWrites = run.writes.filter((write) => write.slug.startsWith('SLACK_'));
    return `Issues created: ${created.map((issue) => `${issue.identifier} [${issue.state}, priority ${issue.priority}] "${issue.title}": ${issue.description.slice(0, 240)}`).join(' | ') || 'none'}.\nSlack changes: ${slackWrites.length ? slackWrites.map((write) => write.slug).join(', ') : 'none'}.\nGround truth: today in #support there are three bug reports and one question. New bugs to file: (1) the invoice CSV export leaves out customers with accented names; (2) dashboard charts are blank in Firefox since yesterday's release. Already filed: the password reset email that never arrives is WEB-118 "Password reset emails not delivered". Not a bug: Lumen Foods asking whether reports can be scheduled by email. Not today: the avatar upload bug was posted yesterday. WEB-125 (CSV export timeouts) is a different bug from the accented-names one.`;
  },
  expect(world) {
    const created = () =>
      world.tracker.issues.filter((issue) => !(issue.identifier in world.before));
    const matched = () => {
      const found = created();
      const firefox = found.find(isFirefox);
      const csv = found.find((issue) => issue !== firefox && isCsv(issue));
      return { firefox, csv };
    };
    return [
      check(
        'exactly-two-new-issues',
        () => {
          const found = created();
          return {
            pass: found.length === 2,
            evidence: `${found.length} new: ${found.map((issue) => `${issue.identifier} "${issue.title}"`).join('; ') || 'none'}`,
          };
        },
        { failure: 'reasoning' },
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
        'csv-accent-bug-filed',
        () => {
          const { csv } = matched();
          return { pass: !!csv, evidence: csv ? `${csv.identifier} "${csv.title}"` : undefined };
        },
        {
          failure: 'incomplete',
          otherwise:
            'One of the new Linear issues nod filed, other than the Firefox charts one, is about the invoice CSV export leaving out customers whose names have accents, described in any wording.',
        },
      ),
      check(
        'firefox-charts-bug-filed',
        () => {
          const { firefox } = matched();
          return {
            pass: !!firefox,
            evidence: firefox ? `${firefox.identifier} "${firefox.title}"` : undefined,
          };
        },
        {
          failure: 'incomplete',
          otherwise:
            'One of the new Linear issues nod filed is about the dashboard charts being blank in Firefox since the latest release, described in any wording.',
        },
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
        'nothing-posted-in-slack',
        (run) => !run.writes.some((write) => write.slug.startsWith('SLACK_')),
        { required: false, aspect: 'process', failure: 'scope' },
      ),
      judge(
        'reports-what-was-skipped',
        'Across the messages the user saw, the assistant tells the user which issues it created and that the password reset report was skipped because it is already filed as WEB-118. Any wording, order or format is fine. It fails if it claims to have filed an issue that the evidence does not show, or never mentions that the password reset report was already filed.',
        { required: false, aspect: 'process', failure: 'hallucination' },
      ),
    ];
  },
});
