import { noWrites } from '../checks.ts';
import { check, scenario } from '../scenario.ts';
import { createApps, gmail } from '../world/apps.ts';

const owner = { name: 'Robin Chen', email: 'robin.chen@example.test' };

export default scenario({
  id: 'proactivity-resolved-travel-holdout',
  title: 'An urgent-looking travel thread already handled by the owner needs no nudge',
  capabilities: ['apps', 'progress'],
  tier: 'pr',
  complexity: 'simple',
  stance: 'gap',
  calibration: 'pending',
  seconds: 300,
  timeZone: 'Europe/Madrid',
  user: { approve: false },
  world(clock) {
    return {
      notificationRule:
        'Flag travel problems that still need me. Prepare useful work and keep resolved matters quiet.',
      apps: createApps(owner, {
        gmail: gmail(
          owner,
          [
            {
              id: 'cancelled-leg',
              threadId: 'handled-travel',
              from: 'Example Rail <service@example-rail.test>',
              to: owner.email,
              subject: 'URGENT: your train is cancelled',
              body: 'The train on booking L8V3TR is cancelled. Please contact us to choose a refund or another service.',
              at: clock.now() - 3600000,
              labels: ['INBOX', 'UNREAD'],
            },
            {
              id: 'owner-resolved',
              threadId: 'handled-travel',
              from: owner.email,
              to: 'service@example-rail.test',
              subject: 'Re: URGENT: your train is cancelled',
              body: 'Thank you. I received the full refund and booked another train. This is resolved. No further action is needed.',
              at: clock.now() - 60000,
              labels: ['SENT'],
            },
          ],
          clock.now,
        ),
      }),
      state: { turnId: '' },
    };
  },
  async play(session, world) {
    world.state.turnId = await session.event(
      'Gmail received activity for threadId handled-travel. Subject: URGENT: your train is cancelled.',
    );
    await session.waitForTurn(world.state.turnId);
    await session.settle();
  },
  completion(world) {
    return check('assessment-finished', (run) =>
      run.turns.some((turn) => turn.id === world.state.turnId && turn.status === 'succeeded'),
    );
  },
  expect(world) {
    return [
      check(
        'current-thread-was-read',
        (run) =>
          run.turns.some((turn) => turn.id === world.state.turnId && turn.screened) ||
          run.tools.some(
            (tool) =>
              tool.turnId === world.state.turnId &&
              tool.name === 'read_source' &&
              !tool.isError &&
              tool.output.includes('handled-travel') &&
              tool.output.includes('This is resolved'),
          ),
      ),
      check(
        'no-stale-nudge',
        (run) =>
          !run.messages.some(
            (message) => message.role === 'assistant' && message.turnId === world.state.turnId,
          ),
      ),
      noWrites('send', 'post', 'draft', 'update', 'create', 'delete'),
    ];
  },
});
