import { amounts } from '../checks.ts';
import { check, scenario } from '../scenario.ts';
import { createApps } from '../world/apps.ts';

const owner = { name: 'Alex Rivera', email: 'alex.rivera@riveradesign.example' };

function note(words: number, seed: string) {
  const vocabulary = [
    'river',
    'planning',
    'budget',
    'client',
    'sketch',
    'draft',
    'review',
    'colour',
    'layout',
    'deadline',
    'proof',
    'brand',
  ];
  return (
    Array.from(
      { length: words },
      (_, index) => vocabulary[(index * 7 + seed.length * 3 + index) % vocabulary.length],
    ).join(' ') + '.\n'
  );
}

const files = [
  { name: 'ideas.txt', words: 412 },
  { name: 'meeting-notes.txt', words: 1180 },
  { name: 'shopping.txt', words: 96 },
  { name: 'draft-pitch.txt', words: 703 },
  { name: 'journal.txt', words: 2250 },
].map((file) => ({ ...file, text: note(file.words, file.name) }));

export default scenario({
  id: 'steering-mid-task',
  title: 'Take a new instruction in the middle of a task',
  linear: 'LAB-374',
  capabilities: ['progress', 'files'],
  tier: 'pr',
  complexity: 'simple',
  stance: 'regression',
  seconds: 480,
  calibration: 'pending',
  user: { approve: true },
  world: () => ({ apps: createApps(owner, {}) }),
  async play(session) {
    const ids: string[] = [];
    for (const file of files)
      ids.push(await session.upload(file.name, Buffer.from(file.text), 'text/plain'));
    await session.sayDuringWithAttachments(
      'Count the words in each of the notes I attached and give me a table.',
      'Also add the character count of each, and put the longest one first.',
      ids,
    );
  },
  expect() {
    const sorted = [...files].sort((a, b) => b.words - a.words);
    return [
      check(
        'every-file-has-its-exact-word-count',
        (run) => {
          const wrong = files.filter((file) => {
            const line =
              run.said
                .split('\n')
                .find((row) =>
                  row.toLowerCase().includes(file.name.replace('.txt', '').toLowerCase()),
                ) ?? '';
            return !amounts(line).includes(file.words);
          });
          return {
            pass: !wrong.length,
            evidence: wrong.length
              ? `wrong or missing: ${wrong.map((f) => f.name).join(', ')}`
              : undefined,
          };
        },
        {
          failure: 'reasoning',
          otherwise: `The answer gives each note's exact word count, ${files.map((file) => `${file.name} ${file.words}`).join(', ')}, in any format.`,
        },
      ),
      check(
        'the-added-instruction-was-followed-character-counts',
        (run) => {
          const wrong = files.filter((file) => {
            const line =
              run.said
                .split('\n')
                .find((row) =>
                  row.toLowerCase().includes(file.name.replace('.txt', '').toLowerCase()),
                ) ?? '';
            const chars = file.text.length;
            return !amounts(line).some((value) => value === chars || value === chars - 1);
          });
          return {
            pass: !wrong.length,
            evidence: wrong.length
              ? `no character count for ${wrong.map((f) => f.name).join(', ')}`
              : undefined,
          };
        },
        {
          failure: 'incomplete',
          otherwise: `The answer also gives each note's character count, ${files.map((file) => `${file.name} ${file.text.length}`).join(', ')}, or one less for each (without the final newline), in any format.`,
        },
      ),
      check(
        'the-added-instruction-was-followed-longest-first',
        (run) => {
          const final = run.replies.at(-1) ?? '';
          const positions = sorted.map((file) =>
            final.toLowerCase().indexOf(file.name.replace('.txt', '').toLowerCase()),
          );
          const ok = positions.every(
            (position, index) => position >= 0 && (index === 0 || position > positions[index - 1]),
          );
          return { pass: ok, evidence: positions.join(', ') };
        },
        {
          failure: 'incomplete',
          otherwise: `The last reply lists the notes longest first: ${sorted.map((file) => file.name).join(', ')}.`,
        },
      ),
    ];
  },
});
