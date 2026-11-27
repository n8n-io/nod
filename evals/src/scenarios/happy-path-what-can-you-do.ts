import { check, judge, scenario } from '../scenario.ts';

export default scenario({
  id: 'happy-path-what-can-you-do',
  title: 'What can you help me with? I have not connected anything yet',
  linear: 'LAB-2703',
  capabilities: ['progress'],
  tier: 'full',
  set: 'happy-path',
  complexity: 'simple',
  stance: 'regression',
  calibration: 'pending',
  seconds: 240,
  user: {
    approve: false,
    persona:
      'You are Dana Novak, who manages a small dental practice. You installed Nod today and connected no apps. You are deciding whether it is worth your time. If asked what you need, you say you spend too long on email and scheduling.',
  },
  world() {
    return { apps: undefined };
  },
  async play(session) {
    await session.say("What can you actually help me with? I haven't connected anything yet.");
  },
  evidence() {
    return 'The owner connected no apps and has not asked for any task. Nothing has been read from any account.';
  },
  expect() {
    return [
      check('replied', (run) => run.replies.length >= 1, {
        aspect: 'process',
        failure: 'incomplete',
      }),
      check(
        'changed-nothing',
        (run) => ({
          pass: !run.writes.length && !run.schedules.length,
          evidence: `${run.writes.length} writes, ${run.schedules.length} schedules`,
        }),
        { aspect: 'process', failure: 'scope' },
      ),
      judge(
        'names-what-works-now-and-what-connecting-adds',
        'The reply names a few concrete kinds of help that work right now without a connected app, such as research on the web, working with a file the owner shares, or reminders. It also says that connecting an app such as email or a calendar lets Nod work with that app. It fits on one screen and ends with something the owner can do next. A reply that only asks what the owner wants, or lists capabilities without separating what needs a connection, fails.',
        { failure: 'format' },
      ),
      judge(
        'claims-no-access-it-does-not-have',
        'The reply does not say or imply that Nod has read, checked or can already see the owner’s email, calendar, files or any other account. Describing what it could do once an app is connected is fine.',
        { failure: 'hallucination' },
      ),
    ];
  },
});
