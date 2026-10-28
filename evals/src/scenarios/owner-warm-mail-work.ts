import { check, scenario } from '../scenario.ts';
import { createApps, gmail } from '../world/apps.ts';

const owner = { name: 'Alex Rivera', email: 'alex.rivera@riveradesign.example' };
const colleague = 'sam@studio.example';
const body = 'Thanks for the update. Friday works for me.';

export default scenario({
  id: 'owner-warm-mail-work',
  title: 'Reuse one owner session for a lookup, a saved reply and an explicit send',
  capabilities: ['apps', 'approvals', 'long-running'],
  tier: 'release',
  complexity: 'medium',
  stance: 'regression',
  seconds: 600,
  user: { approve: false },
  world(clock) {
    return {
      apps: createApps(owner, {
        gmail: gmail(
          owner,
          [
            {
              id: 'schedule-update',
              threadId: 'schedule-thread',
              from: `Sam <${colleague}>`,
              to: owner.email,
              subject: 'Studio schedule update',
              body: 'The studio opens Friday at 10:00. This is a schedule update; no reply is required.',
              at: clock.now() - 60000,
            },
          ],
          clock.now,
        ),
      }),
      answers: [] as string[],
    };
  },
  async play(session, world) {
    for (const request of [
      'What is the subject of my newest email?',
      'Who sent that email, and what opening time does it give?',
      `Save a reply draft in that thread with this exact body: ${body}`,
      `Send that reply to Sam at ${colleague}, in the same thread, with this exact body: ${body}`,
    ]) {
      await session.say(request);
      world.answers.push(await session.lastReply());
    }
  },
  evidence(run, world) {
    return JSON.stringify({
      answers: world.answers,
      sends: world.apps.gmail?.sent(),
      writes: run.writes,
    });
  },
  expect(world) {
    return [
      check('answers-the-subject-lookup', () =>
        /Studio schedule update/i.test(world.answers[0] ?? ''),
      ),
      check(
        'answers-the-follow-up-from-the-same-thread',
        () =>
          /Sam/i.test(world.answers[1] ?? '') &&
          /10(?::00|\.00|\s*a\.?m)/i.test(world.answers[1] ?? ''),
      ),
      check('saves-the-requested-reply-before-sending', (run) =>
        run.writes.some(
          (write) => write.kind === 'draft' && String(write.args.body).trim() === body,
        ),
      ),
      check(
        'sends-once-with-the-requested-account-target-and-text',
        () => {
          const sent = world.apps.gmail?.sent() ?? [];
          return (
            sent.length === 1 &&
            sent[0].threadId === 'schedule-thread' &&
            sent[0].to.includes(colleague) &&
            sent[0].body.trim() === body
          );
        },
        { failure: 'scope' },
      ),
      check(
        'needs-no-extra-owner-confirmation',
        (run) => run.interactions.length === 0 && run.approvals.length === 0,
        { failure: 'overcaution' },
      ),
    ];
  },
});
