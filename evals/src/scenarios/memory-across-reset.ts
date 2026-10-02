import { asksAtMost } from '../checks.ts';
import { check, judge, scenario } from '../scenario.ts';
import { createApps } from '../world/apps.ts';

const owner = { name: 'Alex Rivera', email: 'alex.rivera@riveradesign.example' };

export default scenario({
  id: 'memory-across-reset',
  title: 'Remember what I told you and never ask twice',
  linear: 'LAB-370',
  capabilities: ['memory', 'progress'],
  tier: 'pr',
  complexity: 'simple',
  stance: 'regression',
  seconds: 420,
  user: {
    approve: true,
    persona: 'You are Alex Rivera. You live in Lisbon and are vegetarian. You like short replies.',
  },
  world: () => ({ apps: createApps(owner, {}) }),
  async play(session) {
    await session.say(
      "Remember this about me: I live in Lisbon, I'm vegetarian, and I like short replies, three sentences at most. My dog is called Biscuit.",
    );
    await session.reset();
    await session.say('Suggest three lunch ideas for this Saturday near me.');
  },
  evidence: (run) => `Saved memory:\n${run.memory.slice(0, 3000)}`,
  expect() {
    return [
      check(
        'memory-holds-city-and-diet',
        (run) => /lisbon/i.test(run.memory) && /vegetarian/i.test(run.memory),
        { failure: 'incomplete' },
      ),
      check(
        'never-asks-for-what-it-was-told',
        (run) => {
          const asked = run.interactions.filter((item) => item.kind === 'question');
          const text = run.replies.slice(-2).join('\n');
          return {
            pass:
              !asked.length &&
              !/(which|what) city|where (do you|are you) (live|located|based)|any dietary|dietary (preferences|restrictions)|are you vegetarian/i.test(
                text,
              ),
            evidence: asked[0]?.text.slice(0, 160),
          };
        },
        { failure: 'overcaution', aspect: 'process' },
      ),
      judge(
        'suggestions-fit-the-person',
        'The three lunch ideas are all vegetarian (no meat or fish) and make sense for Lisbon on a Saturday. The answer uses what it knows about the user without asking for it again and without reciting it awkwardly (for example, no "as you told me earlier, you are vegetarian and live in Lisbon").',
        { failure: 'reasoning' },
      ),
      judge(
        'keeps-it-short',
        'The reply after the reset is short, at most about three sentences or a very short list, as the user asked.',
        { aspect: 'process', failure: 'format' },
      ),
      asksAtMost(0),
    ];
  },
});
