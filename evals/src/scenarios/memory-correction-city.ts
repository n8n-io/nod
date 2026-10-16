import { asksAtMost } from '../checks.ts';
import { check, judge, scenario } from '../scenario.ts';
import type { Run } from '../trace.ts';
import { createApps } from '../world/apps.ts';

const owner = { name: 'Alex Rivera', email: 'alex.rivera@riveradesign.example' };
const fact = 'I live in Lisbon.';
const correction = 'Actually, I moved to Porto last month.';
const question =
  'Suggest a nice brunch spot for this Sunday near where I live, just from what you know, no lookups.';
const lisbon = /lisbo[an]/i;
const porto = /\b(?:o?porto|matosinhos|foz do douro|vila nova de gaia|boavista|cedofeita)\b/i;

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
  id: 'memory-correction-city',
  title: 'I told you I moved: suggest a brunch spot near where I live now',
  capabilities: ['memory'],
  tier: 'release',
  calibration: 'pending',
  complexity: 'medium',
  stance: 'regression',
  seconds: 600,
  timeZone: 'Europe/Lisbon',
  user: {
    approve: true,
    answers: [
      {
        when: /where (?:do )?you live|which city|what city|where are you (?:based|living)/i,
        say: 'I already told you where I live. Use that.',
      },
    ],
    persona:
      'You are Alex Rivera. You already told the assistant where you live and that you moved; if it asks where you live, say you told it already and it should use that. Any brunch style and neighbourhood are fine.',
  },
  world: () => ({ apps: createApps(owner, {}), state: {} as { first?: Memory } }),
  async play(session, world) {
    await session.say(fact);
    world.state.first = (await session.api('GET', '/api/memory')).body;
    await session.reset();
    await session.say(correction);
    await session.reset();
    await session.say(question);
  },
  evidence: (run, world) =>
    `The owner said "${fact}" in a first conversation, then after a reset said "${correction}", then after another reset asked: "${question}". The owner now lives in Porto, not Lisbon. Memory right after the first message:\n${JSON.stringify(world.state.first?.notes?.map((note) => note.text) ?? [])}\n\nSaved memory at the end:\n${run.memory.slice(0, 2500)}`,
  expect(world) {
    return [
      check(
        'lisbon-saved-at-first',
        () => {
          const notes = world.state.first?.notes ?? [];
          return {
            pass: notes.some((note) => lisbon.test(note.text)),
            evidence: notes.length
              ? notes.map((note) => note.text).join(' | ')
              : 'memory was empty after the first message',
          };
        },
        { aspect: 'process', failure: 'incomplete' },
      ),
      check(
        'porto-saved',
        (run) => {
          const notes = memory(run).notes;
          return {
            pass: notes.some((note) => /\bporto\b/i.test(note.text)),
            evidence: notes.map((note) => note.text).join(' | ') || 'no notes',
          };
        },
        { failure: 'incomplete' },
      ),
      check(
        'lisbon-no-longer-active',
        (run) => {
          const stale = memory(run).notes.filter(
            (note) => lisbon.test(note.text) && !porto.test(note.text),
          );
          return {
            pass: !stale.length,
            evidence: stale.length
              ? `still active: ${stale.map((note) => note.text).join(' | ')}`
              : undefined,
          };
        },
        { failure: 'reasoning' },
      ),
      check(
        'answer-is-about-porto',
        (run) => {
          const answer = answerTo(run, question);
          return { pass: porto.test(answer), evidence: answer.slice(0, 300) || 'no answer' };
        },
        {
          failure: 'reasoning',
          otherwise:
            'After the last reset, the brunch suggestion is for a place in Porto, where the owner now lives, in any wording; naming a Porto neighbourhood or a Porto venue counts.',
        },
      ),
      judge(
        'no-lisbon-suggestions',
        'After the last reset, the brunch suggestion is for Porto, where the owner now lives. It does not suggest a place in Lisbon and does not say or imply that the owner lives in Lisbon. Mentioning that the owner moved from Lisbon is fine. Which brunch spot it picks, and its wording, do not matter.',
        { failure: 'reasoning' },
      ),
      asksAtMost(0),
    ];
  },
});
