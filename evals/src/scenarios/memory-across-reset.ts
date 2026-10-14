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
  timeZone: 'Europe/Lisbon',
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
    await session.say(
      'Suggest three lunch ideas for this Saturday near me. Just from what you know, no need to look anything up.',
    );
  },
  evidence: (run) => `Saved memory:\n${run.memory.slice(0, 3000)}`,
  expect() {
    return [
      check(
        'memory-holds-city-and-diet',
        (run) => {
          return /lisbon/i.test(run.memory) && /vegetarian/i.test(run.memory);
        },
        { failure: 'incomplete' },
      ),
      judge(
        'never-asks-for-what-it-was-told',
        'After the reset, none of the assistant messages ask the user for their city or where they live, or for their diet or dietary restrictions (or whether they are vegetarian), in any wording. A question about something else, such as a preferred neighbourhood or time, does not fail this.',
        { failure: 'overcaution', aspect: 'process' },
      ),
      judge(
        'suggestions-fit-the-person',
        'The lunch ideas given after the reset are all vegetarian (no meat or fish) and make sense for Lisbon on a Saturday, so the assistant is clearly using what the user saved (Lisbon, vegetarian) instead of asking again. It gives three distinct ideas. Their format and how the reply is worded do not matter.',
        { failure: 'reasoning' },
      ),
      judge(
        'keeps-it-short',
        'The reply after the reset is short, as the user asked (three sentences at most). Count the sentences as written: each bullet or numbered item counts as one sentence, and a short lead-in ending in a colon is not counted. Several ideas inside one sentence are still one sentence. It fails if the total is more than three.',
        { aspect: 'process', failure: 'format' },
      ),
      asksAtMost(0),
    ];
  },
});
