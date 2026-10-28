import type { Connection } from '../../../src/shared/contracts.ts';
import type { ProactiveIssue } from '../../../src/shared/proactivity.ts';
import { noWrites } from '../checks.ts';
import { check, judge, scenario } from '../scenario.ts';
import { createApps, slack, type SlackMessage } from '../world/apps.ts';
import { hoursAgo } from '../world/time.ts';

const owner = { name: 'Alex Rivera', email: 'alex.rivera@riveradesign.example' };
const me = { id: 'U0ALEX', ...owner };
const team = [
  { id: 'U0LENA', name: 'Lena Park', email: 'lena.park@juniper-foods.example' },
  { id: 'U0MARCO', name: 'Marco Bellini', email: 'marco.bellini@riveradesign.example' },
  { id: 'U0SAM', name: 'Sam Okafor', email: 'sam.okafor@riveradesign.example' },
];
const line = (user: string, at: number, text: string): SlackMessage => ({ user, at, text });

export default scenario({
  id: 'proactivity-app-tools',
  title: 'Prepare help from an app read only through its own read tools',
  capabilities: ['apps', 'progress'],
  tier: 'pr',
  complexity: 'medium',
  stance: 'gap',
  calibration: 'pending',
  seconds: 420,
  timeZone: 'Europe/Madrid',
  user: { approve: false },
  world(clock) {
    const now = clock.now();
    return {
      notificationRule: '',
      apps: createApps(owner, {
        slack: slack(
          me,
          team,
          [
            {
              id: 'C0GENERAL',
              name: 'general',
              kind: 'channel',
              messages: [
                line(
                  'U0MARCO',
                  hoursAgo(now, 30),
                  'I saved four ideas from our team discussion in the backlog: search filters, export formats, team templates and an activity view.',
                ),
                line(
                  'U0SAM',
                  hoursAgo(now, 3),
                  'Thanks. These are possible future work, with no assignee or delivery date yet.',
                ),
              ],
            },
            {
              id: 'D0LENA',
              name: 'Lena Park',
              kind: 'dm',
              with: 'U0LENA',
              messages: [
                line(
                  'U0LENA',
                  hoursAgo(now, 1),
                  'Hi Alex, could you send me a revised quote for the Juniper rebrand by tomorrow at 12:00? Our budget meeting is then. The last quote was EUR 4,800 for three logo concepts; we now only need two concepts and the same brand guidelines.',
                ),
              ],
            },
          ],
          clock.now,
        ),
      }),
      state: { turnId: '', issues: [] as ProactiveIssue[] },
    };
  },
  async play(session, world) {
    const slackAccount = ((await session.api('GET', '/api/apps')).body as Connection[]).find(
      (app) => app.slug === 'slack' && app.connectionId,
    );
    if (!slackAccount?.connectionId) throw new Error('The Slack fixture is not connected.');
    world.state.turnId = await session.event('New Slack activity in a direct message.', [
      slackAccount.connectionId,
    ]);
    await session.waitForTurn(world.state.turnId);
    await session.settle();
    world.state.issues = (await session.proactivity.view()).issues;
  },
  evidence(run, world) {
    return JSON.stringify({
      issues: world.state.issues,
      reads: run.tools.filter((tool) => tool.name === 'read_source'),
      messages: run.messages.filter((message) => message.turnId === world.state.turnId),
      writes: run.writes,
    });
  },
  completion(world) {
    return check('prepared-an-actual-result', () => world.state.issues.length > 0);
  },
  expect(world) {
    return [
      check('read-through-its-own-tools', (run) =>
        run.tools.some(
          (tool) =>
            tool.turnId === world.state.turnId &&
            tool.name === 'read_source' &&
            typeof (tool.input as { tool?: unknown }).tool === 'string' &&
            !tool.isError &&
            tool.output.includes('Juniper'),
        ),
      ),
      check('cites-the-slack-account', () =>
        world.state.issues.some((issue) =>
          issue.sources.some((source) => source.sourceId.startsWith('connections:')),
        ),
      ),
      check(
        'one-useful-notification',
        (run) =>
          run.messages.filter(
            (message) => message.role === 'assistant' && message.turnId === world.state.turnId,
          ).length === 1,
      ),
      noWrites('send', 'post', 'draft', 'update', 'create', 'delete'),
      judge(
        'prepared-work-is-useful-and-factual',
        'The saved work prepares a reply to Lena Park about a revised Juniper rebrand quote that she needs by tomorrow at 12:00. It keeps the supplied facts: the earlier EUR 4,800 for three logo concepts and the new scope of two concepts with the same brand guidelines. It does not invent the new price or claim anything was sent; the new price is stated as a decision still needed. The owner message is short, says what is ready and offers the next step without pressure. The unassigned backlog ideas need no plan, draft or notification.',
      ),
    ];
  },
});
