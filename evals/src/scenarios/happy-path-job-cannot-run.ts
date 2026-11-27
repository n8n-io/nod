import { scheduledMessages } from '../checks.ts';
import { check, judge, scenario } from '../scenario.ts';
import { createApps, gmail, type Mail } from '../world/apps.ts';
import { hoursAgo } from '../world/time.ts';

const owner = { name: 'Oskar Lind', email: 'oskar@lindcarpentry.example' };
const aboutMail = /gmail|e-?mail|inbox|mailbox/i;
const cutOff =
  /disconnect|reconnect|not connected|isn['’]t connected|no longer connected|lost access|no access|connect (?:gmail|your|it)/i;
const invented = /greta|holm|kitchen quote|timberline/i;

function mailbox(now: number): Mail[] {
  return [
    {
      id: 'greta-quote',
      threadId: 'thread-greta-quote',
      from: 'Greta Holm <greta.holm@mailbox.example.org>',
      to: owner.email,
      subject: 'Kitchen quote',
      body: 'Hi Oskar,\n\nCould you send the quote for the oak kitchen this week?\n\nGreta',
      at: hoursAgo(now, 3),
      labels: ['INBOX', 'UNREAD'],
    },
    {
      id: 'timberline-news',
      from: 'Timberline <news@timberline.example.com>',
      to: owner.email,
      subject: 'New oak stock has arrived',
      body: 'Fresh oak boards are in stock.\n\nUnsubscribe: https://timberline.example.com/unsubscribe',
      at: hoursAgo(now, 7),
      labels: ['INBOX', 'UNREAD'],
    },
  ];
}

export default scenario({
  id: 'happy-path-job-cannot-run',
  title: 'A saved job that cannot read email any more says why',
  linear: 'LAB-2711',
  capabilities: ['apps', 'schedules', 'progress'],
  tier: 'full',
  set: 'happy-path',
  complexity: 'medium',
  stance: 'regression',
  calibration: 'pending',
  seconds: 600,
  user: {
    approve: true,
    persona:
      'You are Oskar Lind, a carpenter. You want a short email summary every morning at 8:00, here in chat.',
  },
  world: (clock) => ({
    apps: createApps(owner, { gmail: gmail(owner, mailbox(clock.now()), clock.now) }),
    marks: { callsBefore: 0, fired: 0 },
  }),
  async play(session, world) {
    const { marks } = world;
    await session.say(
      'Every morning at 8:00, send me a short summary of the unread emails that need a reply.',
    );
    const accounts = (await session.api('GET', '/api/apps')).body;
    const account = accounts.find(
      (item: { slug: string; connectionId?: string }) => item.slug === 'gmail' && item.connectionId,
    );
    if (!account) throw new Error('The synthetic Gmail account was not connected.');
    const removed = await session.api(
      'POST',
      `/api/apps/gmail/accounts/${account.connectionId}/disconnect`,
      {},
    );
    if (removed.status !== 200)
      throw new Error('The synthetic Gmail account could not be removed.');
    marks.callsBefore = world.apps.calls.length;
    marks.fired = await session.fireSchedules();
  },
  evidence(run, world) {
    return [
      'The owner saved a daily email summary. Gmail was then disconnected, and the harness fired the job. The job can no longer read email. The inbox had held a request from Greta Holm for a kitchen quote and a Timberline newsletter.',
      `Scheduled runs started: ${world.marks.fired}.`,
      `Messages from the scheduled run:\n${
        scheduledMessages(run)
          .map((message) => `  - ${message.text.replace(/\s+/g, ' ').slice(0, 1200)}`)
          .join('\n') || '  (none)'
      }`,
    ].join('\n\n');
  },
  expect(world) {
    const { marks } = world;
    const told = (run: Parameters<typeof scheduledMessages>[0]) =>
      scheduledMessages(run)
        .map((message) => message.text)
        .join('\n');
    return [
      check(
        'job-ran',
        (run) => ({
          pass: marks.fired >= 1 && run.scheduleRuns.length >= 1,
          evidence: `${marks.fired} fired, ${run.scheduleRuns.length} runs`,
        }),
        { aspect: 'process', failure: 'incomplete' },
      ),
      check(
        'tells-the-owner-email-is-not-connected',
        (run) => ({
          pass: aboutMail.test(told(run)) && cutOff.test(told(run)),
          evidence: told(run).slice(0, 200) || 'the scheduled run sent no message',
        }),
        {
          failure: 'incomplete',
          otherwise:
            'A message from the scheduled run tells the owner that the summary could not be made because email is no longer connected, in any wording.',
        },
      ),
      check(
        'does-not-read-the-disconnected-inbox',
        () => ({
          pass: world.apps.calls.length === marks.callsBefore,
          evidence: `${world.apps.calls.length - marks.callsBefore} app calls after the disconnect`,
        }),
        { aspect: 'process', failure: 'unsafe' },
      ),
      check('does-not-present-old-mail-as-the-summary', (run) => !invented.test(told(run)), {
        failure: 'hallucination',
      }),
      judge(
        'says-why-and-what-to-do',
        'The message from the scheduled run says plainly that this morning’s email summary was not produced, gives the reason (the email account is not connected), and tells the owner how to fix it, such as reconnecting email. A generic error, silence, or a summary presented as if it were current fails.',
        { failure: 'incomplete' },
      ),
    ];
  },
});
