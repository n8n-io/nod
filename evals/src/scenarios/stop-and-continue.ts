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
  world: () => ({ apps: createApps(owner, {}), filesBeforeStop: [] as string[] }),
  async play(session, world) {
    await session.interruptWhen(
      'Create five files in a folder called batch: file1.txt to file5.txt, each containing its own number. Create them one at a time with a 6 second pause between each so I can watch.',
      async () => {
        world.filesBeforeStop = (await session.workspace.list()).filter((path) =>
          /\/batch\//.test(path),
        );
        return world.filesBeforeStop.some((path) => path.endsWith('/batch/file2.txt'));
      },
    );
    await session.say('continue');
  },
  evidence(run) {
    return `Files in the workspace: ${run.files.join(', ') || 'none'}.`;
  },
  expect(world) {
    return [
      check(
        'work-was-stopped-before-all-files-were-created',
        (run) => ({
          pass:
            world.filesBeforeStop.length >= 2 &&
            world.filesBeforeStop.length < 5 &&
            run.turns.some((turn) => turn.status === 'cancelled'),
          evidence: `${world.filesBeforeStop.length} files before Stop`,
        }),
        { aspect: 'process', failure: 'incomplete' },
      ),
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
        'After the user said continue, the assistant picked up the remaining files without starting over or redoing finished ones, and anything its final message says about the folder or the work is true. Listing the files or mentioning the interruption is welcome but not required.',
        { aspect: 'process', failure: 'incomplete' },
      ),
    ];
  },
});
