import { mentions } from '../checks.ts';
import { check, scenario } from '../scenario.ts';
import type { Run } from '../trace.ts';
import { createApps } from '../world/apps.ts';

const owner = { name: 'Alex Rivera', email: 'alex.rivera@riveradesign.example' };
const request = 'Convert 250 US dollars to euros at a rate of 0.92 and round to cents.';

interface Memory {
  notes: Array<{ path: string; text: string; status: string }>;
  archive: Array<{ path: string; text: string; reason: string }>;
}

const memory = (run: Run): Memory => JSON.parse(run.memory);
const learns = (run: Run) =>
  run.tools.filter(
    (call) => call.name === 'manage_personal_context' && call.input?.action === 'memory_learn',
  );

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
  id: 'memory-not-for-tasks',
  title: 'Convert 250 US dollars to euros at 0.92',
  capabilities: ['memory'],
  tier: 'release',
  calibration: 'pending',
  complexity: 'simple',
  stance: 'regression',
  seconds: 300,
  user: {
    approve: true,
    persona: 'You are Alex Rivera. You only want the converted amount.',
  },
  world: () => ({ apps: createApps(owner, {}) }),
  async play(session) {
    await session.say(request);
  },
  evidence: (run) =>
    `250 × 0.92 = 230.00 euros. The message is a one-off task, not a lasting fact about the owner, so nothing should be saved to memory.\nmemory_learn calls: ${learns(run).length}\nSaved memory:\n${run.memory.slice(0, 1500)}`,
  expect() {
    return [
      check(
        'answers-230',
        (run) => {
          const answer = answerTo(run, request);
          return { pass: mentions(answer, 230), evidence: answer.slice(0, 200) || 'no answer' };
        },
        { failure: 'reasoning' },
      ),
      check(
        'task-not-saved',
        (run) => {
          const { notes, archive } = memory(run);
          const saved = [...notes, ...archive].filter((entry) =>
            /250|0[.,]92|dollar|usd|euro|convert/i.test(entry.text),
          );
          return {
            pass: !saved.length,
            evidence: saved.length
              ? `saved: ${saved.map((entry) => entry.text).join(' | ')}`
              : undefined,
          };
        },
        { failure: 'scope' },
      ),
      check(
        'no-memory-learn',
        (run) => ({
          pass: !learns(run).length,
          evidence: learns(run).length
            ? `memory_learn: ${JSON.stringify(learns(run)[0].input).slice(0, 200)}`
            : undefined,
        }),
        { aspect: 'process', failure: 'scope' },
      ),
    ];
  },
});
