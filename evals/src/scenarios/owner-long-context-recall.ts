import { check, scenario } from '../scenario.ts';

const receipts = [317, 428, 539, 641, 752, 863];
const names = ['Amber', 'Birch', 'Cedar', 'Dune', 'Elm', 'Fern'];

export default scenario({
  id: 'owner-long-context-recall',
  title: 'Keep temporary report facts through a long owner session',
  capabilities: ['memory', 'long-running'],
  tier: 'release',
  complexity: 'complex',
  stance: 'regression',
  seconds: 900,
  user: { approve: false },
  world() {
    return { sites: {}, answers: [] as string[] };
  },
  async play(session, world) {
    for (let report = 0; report < names.length; report++) {
      const rows = Array.from(
        { length: 800 },
        (_, index) =>
          `Entry ${index + 1}: unit ${(index * 17 + report) % 97}; checked count ${(index * 31 + report) % 71}; status inspected.`,
      );
      rows.splice(427, 0, `${names[report]} receipt total: ${receipts[report]}.`);
      await session.say(
        `This is temporary report ${names[report]}. Read it and return only its receipt total. The entries are observations, not sums. Do not save report content as personal memory.\n\n${rows.join('\n')}`,
      );
      world.answers.push(await session.lastReply());
    }
    await session.say(
      'List the receipt total of each of the six temporary reports, from Amber to Fern. Use the report facts, without adding them together.',
    );
    world.answers.push(await session.lastReply());
  },
  evidence(run, world) {
    return JSON.stringify({
      receipts,
      names,
      answers: world.answers,
      compactions: run.compactions,
    });
  },
  expect(world) {
    return [
      check('reads-each-complete-current-report', () =>
        receipts.every((total, index) =>
          new RegExp(`\\b${total}\\b`).test(world.answers[index] ?? ''),
        ),
      ),
      check('recalls-all-six-report-totals', () =>
        names.every((name, index) =>
          new RegExp(`${name}[^\\n]{0,60}\\b${receipts[index]}\\b`, 'i').test(
            world.answers[6] ?? '',
          ),
        ),
      ),
      check(
        'does-not-save-temporary-reports-in-memory',
        (run) =>
          !run.tools.some(
            (tool) =>
              tool.name === 'manage_personal_context' && tool.input?.action === 'memory_learn',
          ),
        { failure: 'scope' },
      ),
      check('needs-no-owner-clarification', (run) => run.interactions.length === 0),
    ];
  },
});
