import type { Connection } from '../../../src/shared/contracts.ts';
import type { ProactiveIssue } from '../../../src/shared/proactivity.ts';
import { noWrites } from '../checks.ts';
import { check, scenario } from '../scenario.ts';
import { createApps } from '../world/apps.ts';
import { linear } from '../world/linear.ts';

const owner = { name: 'Alex Rivera', email: 'alex.rivera@riveradesign.example' };

export default scenario({
  id: 'proactivity-backlog-silent',
  title: 'New and updated backlog ideas start no unsolicited project',
  capabilities: ['apps', 'progress'],
  tier: 'pr',
  complexity: 'medium',
  stance: 'regression',
  seconds: 420,
  user: { approve: false },
  world(clock) {
    return {
      notificationRule: '',
      apps: createApps(owner, {
        linear: linear(
          owner,
          {
            teams: [{ key: 'OPS', name: 'Operations' }],
            issues: ['Stock reports', 'Order batching', 'Supplier returns', 'Demand charts'].map(
              (title, i) => ({
                identifier: `OPS-${310 + i}`,
                title,
                state: 'Backlog',
                description:
                  'Idea from a team discussion for possible future work. Current reports do not separate returned stock from other stock. We could measure that before choosing which idea to develop.',
                created: clock.now() - 60000,
                updated: clock.now() - 60000,
              }),
            ),
          },
          clock.now,
        ),
      }),
      now: clock.now,
      state: {
        turns: [] as string[],
        reads: [] as Array<{ turnId: string; output: string }>,
        issues: [] as ProactiveIssue[],
      },
    };
  },
  async play(session, world) {
    const connection = ((await session.api('GET', '/api/apps')).body as Connection[]).find(
      (app) => app.slug === 'linear' && app.connectionId,
    );
    if (!connection?.connectionId)
      throw new Error('The synthetic Linear account is not connected.');
    const outputs: string[] = [];
    for (const tool of world.apps.linear!.tools) {
      const run = tool.run;
      tool.run = (args) => {
        const result = run(args);
        outputs.push(JSON.stringify(result));
        return result;
      };
    }
    for (let phase = 0; phase < 2; phase++) {
      if (phase) {
        const issue = world.apps.linear!.issues[0]!;
        issue.description += ' The team added this as a possible question for future planning.';
        issue.updated = world.now();
      }
      const before = outputs.length;
      const turn = await session.event('Linear backlog ideas changed.', [connection.connectionId]);
      world.state.turns.push(turn);
      await session.waitForTurn(turn);
      await session.settle();
      world.state.reads.push(...outputs.slice(before).map((output) => ({ turnId: turn, output })));
    }
    world.state.issues = (await session.proactivity.view()).issues;
  },
  completion(world) {
    return check(
      'both-source-checks-finished',
      (run) =>
        world.state.turns.length === 2 &&
        world.state.turns.every((id) =>
          run.turns.some((turn) => turn.id === id && turn.status === 'succeeded'),
        ),
    );
  },
  evidence(run, world) {
    return JSON.stringify({
      issues: world.state.issues,
      reads: world.state.reads,
      turns: run.turns,
      messages: run.messages,
      writes: run.writes,
    });
  },
  expect(world) {
    return [
      check(
        'read-the-connected-backlog',
        () =>
          world.state.turns.length === 2 &&
          world.state.turns.every((turnId) =>
            [310, 311, 312, 313].every((id) =>
              world.state.reads.some(
                (read) => read.turnId === turnId && read.output.includes(`OPS-${id}`),
              ),
            ),
          ),
      ),
      check('no-private-plan', () => world.state.issues.length === 0),
      check(
        'no-nudge-or-question',
        (run) =>
          run.messages.every((message) => message.role !== 'assistant') &&
          run.interactions.length === 0,
      ),
      check(
        'no-new-task',
        (run) => !run.tools.some((tool) => tool.name === 'task' && tool.input.action === 'start'),
      ),
      noWrites('send', 'post', 'draft', 'update', 'create', 'delete'),
    ];
  },
});
