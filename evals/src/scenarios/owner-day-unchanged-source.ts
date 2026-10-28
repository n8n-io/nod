import { check, scenario } from '../scenario.ts';

export default scenario({
  id: 'owner-day-unchanged-source',
  title: 'Check a native source for one simulated day without rereading unchanged records',
  capabilities: ['schedules', 'memory'],
  tier: 'release',
  complexity: 'simple',
  stance: 'regression',
  seconds: 300,
  user: { approve: false },
  world() {
    const state = { reads: 0, initialReads: 0, polls: 0, repeatedTurns: 0 };
    return {
      state,
      observations: [
        {
          id: 'fixture',
          sources: async () => [
            {
              id: 'records',
              label: 'Saved records',
              description: 'Owned current records.',
              revision: 'v1',
              readable: true,
              changeToken: 'unchanged-v1',
              pollIntervalMs: 30 * 60000,
            },
          ],
          read: async () => {
            state.reads++;
            return { records: [] };
          },
        },
      ],
    };
  },
  async play(session, world) {
    await session.proactivity.poll();
    await session.settle();
    world.state.initialReads = world.state.reads;
    for (let index = 0; index < 48; index++) {
      if (await session.proactivity.poll()) world.state.repeatedTurns++;
      await session.settle();
      world.state.polls++;
    }
  },
  evidence(_run, world) {
    return `Simulated 48 half-hour polls by advancing saved poll deadlines. Source data and change token stay fixed. This is not a real 24-hour soak. ${JSON.stringify(world.state)}`;
  },
  completion: () =>
    check(
      'finished',
      (run) =>
        run.turns.length > 0 &&
        run.turns.every((turn) => turn.status === 'succeeded') &&
        run.interactions.length === 0,
    ),
  expect(world) {
    return [
      check('reads-the-initial-source', () => world.state.initialReads > 0),
      check('checks-all-48-poll-deadlines', () => world.state.polls === 48),
      check('unchanged-polls-start-no-new-turns', () => world.state.repeatedTurns === 0),
      check(
        'does-not-reread-an-unchanged-source',
        () => world.state.reads === world.state.initialReads,
      ),
      check(
        'does-not-interrupt-the-owner',
        (run) =>
          run.interactions.length === 0 &&
          run.messages.every((message) => message.role !== 'assistant'),
      ),
    ];
  },
});
