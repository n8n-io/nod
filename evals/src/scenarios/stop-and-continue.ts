import { check, judge, scenario } from '../scenario.ts';
import { createApps } from '../world/apps.ts';

const owner = { name: 'Alex Rivera', email: 'alex.rivera@riveradesign.example' };

export default scenario({
  id: 'stop-and-continue',
  title: 'Stop it halfway, say continue, and finish without repeating or losing work',
  linear: 'LAB-445',
  capabilities: ['long-running', 'progress', 'files'],
  tier: 'full',
  complexity: 'medium',
  stance: 'regression',
  seconds: 600,
  calibration: 'pending',
  user: { approve: true },
  world: () => ({ apps: createApps(owner, {}) }),
  async play(session) {
    await session.interruptAfter(
      'Create five files in a folder called batch: file1.txt to file5.txt, each containing its own number. Create them one at a time with a 6 second pause between each so I can watch.',
      14_000,
    );
    await session.say('continue');
  },
  evidence(run) {
    return `Files in the workspace: ${run.files.join(', ') || 'none'}.`;
  },
  expect() {
    return [
      check(
        'all-five-files-exist-exactly-once-with-their-number',
        async (run) => {
          const problems: string[] = [];
          for (const number of [1, 2, 3, 4, 5]) {
            const found = run.files.filter((path) => path.endsWith(`/batch/file${number}.txt`));
            const text = found.length ? (await run.text(found[0])).trim() : '';
            if (found.length !== 1 || text !== String(number))
              problems.push(`file${number}: ${found.length} found, content "${text}"`);
          }
          return { pass: !problems.length, evidence: problems.join('; ') || undefined };
        },
        { failure: 'incomplete' },
      ),
      check(
        'no-extra-files',
        (run) => ({
          pass: run.files.filter((path) => /\/batch\//.test(path)).length === 5,
          evidence: `${run.files.filter((path) => /\/batch\//.test(path)).length} files in batch`,
        }),
        { aspect: 'process', failure: 'scope', required: false },
      ),
      judge(
        'continues-from-where-it-stopped',
        'After the user said continue, the assistant picked up the remaining files without starting over or redoing finished ones, and its final message says what is now in the folder truthfully, including that the work was interrupted if that matters.',
        { aspect: 'process', failure: 'incomplete' },
      ),
    ];
  },
});
