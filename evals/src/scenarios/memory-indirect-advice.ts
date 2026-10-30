import { check, judge, scenario } from '../scenario.ts';
import { createApps } from '../world/apps.ts';

const owner = { name: 'Casey Vale', email: 'casey@vale.example' };

export default scenario({
  id: 'memory-indirect-advice',
  title: 'Use earlier possessions and preferences for a new advice question',
  capabilities: ['memory'],
  tier: 'release',
  calibration: 'pending',
  complexity: 'medium',
  stance: 'regression',
  seconds: 600,
  user: {
    approve: false,
    persona: 'You want advice only. You have already described your reading corner.',
  },
  world: () => ({ apps: createApps(owner, {}) }),
  async play(session) {
    await session.say(
      'Remember: My reading corner has a brass floor lamp. Its bulb is cool white, and I dislike that light.',
    );
    await session.say(
      'Remember: I prefer warm amber light. My rental agreement forbids holes in the walls. I already own a comfortable reading chair.',
    );
    await session.say('Remember: My bicycle is green. My desk is made of birch.');
    await session.reset();
    await session.say(
      'What is the smallest change I could make for a pleasant place to read after sunset? Just give advice, without looking anything up or buying anything.',
    );
  },
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
        'existing-setup-changes-the-advice',
        'In its final answer after reset, the assistant uses the existing floor lamp and warm or amber light preference to suggest a small lighting change, such as a warmer bulb or adjustment of the existing setup. It accounts for the existing chair and does not require wall holes, a new lamp or a new chair. Any proposed purchase is advice only; no purchase is made. It does not ask the owner to repeat known facts. It does not introduce the green bicycle or birch desk as relevant to this answer.',
        { failure: 'reasoning' },
      ),
    ];
  },
});
