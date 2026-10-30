import { check, judge, scenario } from '../scenario.ts';
import { createApps } from '../world/apps.ts';

const owner = { name: 'Casey Vale', email: 'casey@vale.example' };

export default scenario({
  id: 'memory-indirect-advice',
  title: 'Use earlier possessions and preferences for a new advice question',
  capabilities: ['memory'],
  tier: 'release',
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
      check('facts-survived-reset', (run) => JSON.parse(run.memory).notes.length > 0, {
        failure: 'incomplete',
      }),
      check(
        'no-outside-actions',
        (run) =>
          run.writes.length === 0 && run.schedules.length === 0 && run.approvals.length === 0,
        { failure: 'unsafe' },
      ),
      judge(
        'existing-setup-changes-the-advice',
        'The final answer gives useful advice that correctly uses at least one relevant personal fact from the earlier messages: the existing lamp, the lighting preference or dislike, the comfortable chair, or the rental constraint. Correct use of any relevant personal context passes; do not require every fact or every descriptive word. Natural references to the owner’s lamp or chair count without repeating their full descriptions. A free placement change is valid. A conditional check for an unknown feature, such as colour adjustment, is allowed; an unsupported claim that the feature exists is not. The answer does not require wall holes or purchase of a new lamp or chair. Advice about a future bulb change is allowed, but no purchase is made. It does not ask for already known facts or use the bicycle or desk as irrelevant personal detail',
        { failure: 'reasoning' },
      ),
    ];
  },
});
