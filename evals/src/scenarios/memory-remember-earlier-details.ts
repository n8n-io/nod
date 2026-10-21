import { check, judge, scenario } from '../scenario.ts';
import type { Run } from '../trace.ts';
import { createApps } from '../world/apps.ts';

const owner = { name: 'Alex Rivera', email: 'alex.rivera@riveradesign.example' };
const details =
  'Draft a short note for the courier, just in chat: deliver the parcel to Rua das Flores 12, 4050-262 Porto, and call +351 912 345 678 on arrival.';
const tweak = 'Thanks. Make it a bit more formal.';
const request = 'Please remember that address and number for me.';
const question =
  'What’s my delivery address and the best number to reach me? Answer from what you know.';

interface Memory {
  notes: Array<{ path: string; text: string; status: string }>;
}

const digits = (text: string) => text.replace(/\D/g, '');
const holds = (notes: Memory['notes']) => {
  const text = notes.map((note) => note.text).join(' | ');
  return {
    address:
      /rua das flores,? 12\b/i.test(text) &&
      digits(text).includes('4050262') &&
      /porto/i.test(text),
    phone: digits(text).includes('351912345678'),
    text,
  };
};

export default scenario({
  id: 'memory-remember-earlier-details',
  title: 'Remember the address and number I gave you two messages ago',
  linear: 'LAB-642',
  capabilities: ['memory'],
  tier: 'pr',
  complexity: 'simple',
  stance: 'regression',
  calibration: 'pending',
  seconds: 420,
  timeZone: 'Europe/Lisbon',
  user: {
    approve: false,
    persona:
      'You are Alex Rivera. You gave your delivery address and phone number earlier in the chat and now want the assistant to keep them. If it asks you to repeat them, say they are in your earlier message.',
  },
  world: () => ({ apps: createApps(owner, {}), state: {} as { saved?: Memory } }),
  async play(session, world) {
    await session.say(details);
    await session.say(tweak);
    await session.say(request);
    world.state.saved = (await session.api('GET', '/api/memory')).body;
    await session.reset();
    await session.say(question);
  },
  evidence: (run, world) =>
    `The owner gave a delivery address (Rua das Flores 12, 4050-262 Porto) and a phone number (+351 912 345 678) as details of a one-off courier note, asked for a more formal draft, then asked: "${request}". After a reset they asked: "${question}". Memory right after the request:\n${JSON.stringify(world.state.saved?.notes?.map((note) => note.text) ?? [])}`,
  expect(world) {
    return [
      check(
        'details-saved-on-request',
        () => {
          const found = holds(world.state.saved?.notes ?? []);
          return {
            pass: found.address && found.phone,
            evidence: found.text || 'memory was empty after the request',
          };
        },
        { failure: 'incomplete' },
      ),
      check(
        'no-memory-question',
        (run: Run) => ({
          pass:
            run.approvals.length === 0 &&
            run.interactions.length === 0 &&
            !run.tools.some((call) => JSON.stringify(call.input ?? {}).includes('memory_forget')),
          evidence: `${run.approvals.length} approval records; ${run.interactions.length} questions to the owner; forget calls: ${run.tools.filter((call) => JSON.stringify(call.input ?? {}).includes('memory_forget')).length}.`,
        }),
        { aspect: 'process', failure: 'overcaution' },
      ),
      check('no-external-writes', (run: Run) => run.writes.length === 0, {
        aspect: 'process',
        failure: 'scope',
      }),
      judge(
        'recall-after-reset',
        'After the reset, the final answer gives the delivery address Rua das Flores 12, 4050-262 Porto and the number +351 912 345 678, without asking the owner to repeat them. Equivalent formatting of the address and number passes.',
        { failure: 'reasoning' },
      ),
    ];
  },
});
