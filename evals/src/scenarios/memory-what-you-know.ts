import { check, judge, scenario } from '../scenario.ts';
import type { Run } from '../trace.ts';
import { createApps } from '../world/apps.ts';

const owner = { name: 'Alex Rivera', email: 'alex.rivera@riveradesign.example' };
const first = "Remember: I'm vegetarian and I go climbing every Tuesday evening.";
const second = 'Also, my partner is called Sam.';
const question = 'What do you remember about me?';
const facts = [
  { name: 'vegetarian', pattern: /vegetarian/i },
  { name: 'climbing on Tuesdays', pattern: /climb|tuesday/i },
  { name: 'partner Sam', pattern: /\bsam\b/i },
];

interface Memory {
  notes: Array<{ path: string; text: string; status: string }>;
  archive: Array<{ path: string; text: string; reason: string }>;
}

const memory = (run: Run): Memory => JSON.parse(run.memory);

function answerTo(run: Run, text: string) {
  const background = new Set(run.turns.filter((turn) => turn.background).map((turn) => turn.id));
  const start = run.messages.findLastIndex(
    (message) => message.role === 'user' && message.text.trim() === text,
  );
  if (start < 0) return '';
  return run.messages
    .slice(start + 1)
    .filter((message) => message.role === 'assistant' && !background.has(message.turnId ?? ''))
    .map((message) => message.text)
    .join('\n\n');
}

export default scenario({
  id: 'memory-what-you-know',
  title: 'What do you remember about me?',
  capabilities: ['memory'],
  tier: 'release',
  calibration: 'pending',
  complexity: 'medium',
  stance: 'regression',
  seconds: 600,
  user: {
    approve: true,
    persona:
      'You are Alex Rivera. You told the assistant you are vegetarian, climb every Tuesday evening and that your partner is called Sam. You have nothing else to add.',
  },
  world: () => ({ apps: createApps(owner, {}) }),
  async play(session) {
    await session.say(first);
    await session.say(second);
    await session.reset();
    await session.say(question);
  },
  evidence: (run) =>
    `Before the reset the owner told the assistant exactly three things about themselves: they are vegetarian, they go climbing every Tuesday evening, and their partner is called Sam. Nothing else was said about them. The assistant also knows the owner's time zone from settings.\nAnswer after the reset:\n${answerTo(run, question).slice(0, 2000)}\n\nSaved memory:\n${run.memory.slice(0, 1500)}`,
  expect() {
    return [
      check(
        'recalls-all-three',
        (run) => {
          const answer = answerTo(run, question);
          const missing = facts.filter((fact) => !fact.pattern.test(answer));
          return {
            pass: answer.length > 0 && !missing.length,
            evidence: missing.length
              ? `missing: ${missing.map((fact) => fact.name).join(', ')}`
              : undefined,
          };
        },
        {
          failure: 'incomplete',
          otherwise:
            "After the reset, the answer to 'What do you remember about me?' says the owner is vegetarian, climbs on Tuesday evenings and has a partner called Sam, in any wording.",
        },
      ),
      check(
        'facts-saved',
        (run) => {
          const text = memory(run)
            .notes.map((note) => note.text)
            .join('\n');
          return /vegetarian/i.test(text) && /\bsam\b/i.test(text);
        },
        { required: false, aspect: 'process', failure: 'incomplete' },
      ),
      judge(
        'invents-nothing',
        'In its answer after the reset, everything the assistant presents as remembered about the user is one of: vegetarian, climbing every Tuesday evening, partner called Sam, or the time zone or region from settings. It fails if it states any other personal fact as remembered, such as a city, job, age, pet, allergy, or details about Sam beyond the name. Pronouns, a brief offer to remember more, and saying what it does not know are fine.',
        { failure: 'hallucination' },
      ),
    ];
  },
});
