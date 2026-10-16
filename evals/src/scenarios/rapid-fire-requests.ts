import { check, scenario } from '../scenario.ts';
import { createApps } from '../world/apps.ts';

const owner = { name: 'Alex Rivera', email: 'alex.rivera@riveradesign.example' };
const answer = /\b397[.,]80?(?!\d)/;

export default scenario({
  id: 'rapid-fire-requests',
  title: 'Three requests sent back to back are all answered once and correctly',
  linear: 'LAB-375',
  capabilities: ['progress', 'long-running', 'files'],
  tier: 'pr',
  complexity: 'simple',
  stance: 'regression',
  seconds: 600,
  calibration: 'pending',
  user: { approve: true },
  world: () => ({ apps: createApps(owner, {}) }),
  async play(session) {
    await session.sayTogether([
      'What is 17% of 2,340?',
      'Also create a file called alpha.txt that contains the single word alpha.',
      'Third thing: what day of the week is 3 January 2027?',
    ]);
  },
  expect() {
    return [
      check('answers-the-calculation', (run) => ({ pass: answer.test(run.said) }), {
        failure: 'reasoning',
        otherwise: 'The assistant answers that 17% of 2,340 is 397.8, in any format.',
      }),
      check(
        'creates-the-file-exactly-once-with-the-right-content',
        async (run) => {
          const found = run.files.filter((path) => /alpha\.txt$/.test(path));
          const text = found.length ? (await run.text(found[0])).trim() : '';
          return {
            pass: found.length === 1 && text === 'alpha',
            evidence: `${found.length} files, content "${text}"`,
          };
        },
        { failure: 'incomplete' },
      ),
      check('answers-the-day-of-the-week', (run) => ({ pass: /sunday/i.test(run.said) }), {
        failure: 'reasoning',
        otherwise: 'The assistant answers that 3 January 2027 is a Sunday, in any wording.',
      }),
      check(
        'nothing-was-dropped-or-repeated',
        (run) => ({
          pass:
            run.turns.every((turn) => turn.status === 'succeeded' || turn.status === 'cancelled') &&
            run.replies.filter((reply) => answer.test(reply)).length <= 2,
          evidence: run.turns.map((turn) => turn.status).join(', '),
        }),
        { aspect: 'process', failure: 'incomplete', required: false },
      ),
    ];
  },
});
