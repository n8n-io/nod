import { check, judge, scenario } from '../scenario.ts';
import { presentations } from '../world/inline-visuals.ts';

export default scenario({
  id: 'inline-visual-text-only',
  title: 'Answer a simple arithmetic question without an unnecessary visual',
  capabilities: ['research'],
  tier: 'release',
  calibration: 'pending',
  complexity: 'simple',
  stance: 'regression',
  seconds: 120,
  user: { approve: false },
  world: () => ({}),
  async play(session) {
    await session.say('What is 18% of €240? Just the amount, please.');
  },
  expect() {
    return [
      check('answers-the-question', (run) => /\b43[.,]20?\b/.test(run.final), {
        otherwise: 'The answer gives forty-three euros and twenty cents, the correct result.',
      }),
      check('does-not-add-an-unhelpful-visual', (run) => ({
        pass:
          presentations(run).length === 0 && run.tools.every((call) => call.name !== 'share_file'),
        evidence: `${presentations(run).length} presentations, ${run.tools.filter((call) => call.name === 'share_file').length} shared files.`,
      })),
      judge(
        'keeps-the-answer-brief',
        'Answer only the amount €43.20, in equivalent local numeric formatting if needed. No visual, file, lesson or unnecessary question.',
      ),
    ];
  },
});
