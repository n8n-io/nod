import { check, judge, scenario } from '../scenario.ts';
import { createApps } from '../world/apps.ts';

const owner = { name: 'Casey Vale', email: 'casey@vale.example' };
const date = (days: number) => new Date(Date.now() + days * 86_400_000).toISOString().slice(0, 10);

export default scenario({
  id: 'memory-event-scope',
  title: 'Count completed events and use their event dates after a reset',
  capabilities: ['memory'],
  tier: 'release',
  complexity: 'medium',
  stance: 'regression',
  seconds: 600,
  timeZone: 'UTC',
  user: {
    approve: false,
    persona:
      'You want a count and date calculation from your earlier statements. You have no further facts to supply.',
  },
  world: () => ({
    apps: createApps(owner, {}),
    state: { first: date(-14), second: date(-9), cancelled: date(-4), end: date(0) },
  }),
  async play(session, world) {
    const { first, second, cancelled, end } = world.state;
    await session.say(`Remember: On ${first} I attended Cedar Print Fair.`);
    await session.say(
      `Remember: On ${second} I attended Maple Print Fair. I bought a poster from Birch Print Fair online, but I did not attend Birch.`,
    );
    await session.say(
      `Remember: I planned to attend Elm Print Fair on ${cancelled}, but cancelled and stayed home. I plan to attend Pine Print Fair next week.`,
    );
    await session.reset();
    await session.say(
      `How many print fairs did I actually attend before ${end}? Name them and calculate the days between the first and second. Answer from our conversations, without external research.`,
    );
  },
  evidence: (_run, world) =>
    `Cedar attendance: ${world.state.first}. Maple attendance: ${world.state.second}. These are the only completed visits. Birch was an online poster purchase, Elm was cancelled, and Pine is a future plan. The interval is five calendar days, independent of when the statements were sent.`,
  expect() {
    return [
      check(
        'all-four-requests-finished',
        (run) =>
          run.turns.filter((turn) => turn.source === 'user').length === 4 &&
          run.turns.every((turn) => turn.status === 'succeeded'),
        { failure: 'incomplete' },
      ),
      check(
        'no-outside-actions',
        (run) =>
          run.writes.length === 0 && run.schedules.length === 0 && run.approvals.length === 0,
        { failure: 'unsafe' },
      ),
      judge(
        'completed-events-and-reference-dates',
        'The final answer after reset gives exactly two attended print fairs: Cedar and Maple. It gives five days between their visits. It does not count the Birch poster purchase, the cancelled Elm visit or the future Pine plan as attendance. It calculates from the event dates, not the dates of the messages or the final question. Equivalent wording passes; no fixed tool route is required.',
        { failure: 'reasoning' },
      ),
    ];
  },
});
