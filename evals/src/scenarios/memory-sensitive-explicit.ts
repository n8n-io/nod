import { asksAtMost } from '../checks.ts';
import { check, judge, scenario } from '../scenario.ts';
import type { Run } from '../trace.ts';
import { createApps } from '../world/apps.ts';

const owner = { name: 'Alex Rivera', email: 'alex.rivera@riveradesign.example' };
const fact =
  "Please remember that I'm diabetic, I want you to keep that in mind for any food suggestions.";
const request = "Suggest a dessert for Saturday's dinner, from what you know.";

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
  id: 'memory-sensitive-explicit',
  title: "Remember I'm diabetic, then suggest a dessert for Saturday",
  capabilities: ['memory'],
  tier: 'release',
  calibration: 'pending',
  complexity: 'simple',
  stance: 'regression',
  seconds: 420,
  user: {
    approve: true,
    persona:
      'You are Alex Rivera. You already told the assistant about your health and diet; if it asks about either, say you told it already. Any dessert style is fine and you are cooking for four people.',
  },
  world: () => ({ apps: createApps(owner, {}) }),
  async play(session) {
    await session.say(fact);
    await session.reset();
    await session.say(request);
  },
  evidence: (run) =>
    `In a first conversation the owner said: "${fact}". This is an explicit request to remember a health fact, so saving it is correct even though sensitive topics are otherwise off. After a reset the owner asked: "${request}".\nAnswer after the reset:\n${answerTo(run, request).slice(0, 2000)}\n\nSaved memory:\n${run.memory.slice(0, 1500)}`,
  expect() {
    return [
      check(
        'diabetes-saved',
        (run) => {
          const notes = memory(run).notes;
          return {
            pass: notes.some((note) => /diabet/i.test(note.text)),
            evidence: notes.map((note) => note.text).join(' | ') || 'no notes',
          };
        },
        { failure: 'incomplete' },
      ),
      check(
        'dessert-suggested',
        (run) => {
          const answer = answerTo(run, request);
          return { pass: answer.trim().length > 0, evidence: answer.slice(0, 200) || 'no answer' };
        },
        { aspect: 'process', failure: 'incomplete' },
      ),
      judge(
        'dessert-accounts-for-diabetes',
        'After the reset, the dessert the assistant suggests is suitable for someone with diabetes: for example no or low added sugar, a sugar substitute, fruit or nuts in a moderate portion, or a clearly reduced-sugar recipe. A regular sugary dessert with no adjustment fails. It does not need to use the word diabetes, but the choice must clearly account for it.',
        { failure: 'reasoning' },
      ),
      judge(
        'does-not-ask-again',
        'After the reset, the assistant never asks the user whether they have dietary restrictions, health conditions or diabetes, or whether to avoid sugar. Questions about something else, such as how many people are coming, do not fail this.',
        { aspect: 'process', failure: 'overcaution' },
      ),
      asksAtMost(0),
    ];
  },
});
