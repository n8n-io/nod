import { check, scenario } from '../scenario.ts';
import type { Run } from '../trace.ts';
import { calendar, createApps, gmail, type CalendarEvent, type Mail } from '../world/apps.ts';
import { dayLabel, daysAgo, inDays, localTime } from '../world/time.ts';

const owner = { name: 'Alex Rivera', email: 'alex.rivera@riveradesign.example' };
const zone = 'Europe/Madrid';
const ana = 'ana.costa@meridian.example.org';
const reviewId = 'designreviewtmr';

const events = (run: Run) => run.apps?.calendar?.events ?? [];
const seeded = new Set(['ana-materials', 'ana-lopes', 'newsletter']);
const sent = (run: Run) => (run.apps?.gmail?.sent() ?? []).filter((mail) => !seeded.has(mail.id));
const toAna = (to: string) => to.toLowerCase().includes(ana);
const recipients = (mail: { to: string; cc: string }) =>
  [mail.to, mail.cc]
    .flatMap((value) => (value ?? '').split(','))
    .map((value) => (/<([^>]+)>/.exec(value)?.[1] ?? value).trim().toLowerCase())
    .filter(Boolean);
const people = (event: CalendarEvent) =>
  (event.attendees ?? [])
    .map((value) => value.toLowerCase())
    .filter((value) => value !== owner.email)
    .sort()
    .join();
const newTime =
  /\b15[:.h]00\b|\b15\s?h\b|\b3(?:[:.]00)?\s*(?:p\.?\s?m\b|(?:[-–—]|to)\s*4(?:[:.]00)?\s*p\.?\s?m\b)/i;

function mailbox(now: number): Mail[] {
  return [
    {
      id: 'ana-materials',
      threadId: 'thread-ana-review',
      from: `Ana Costa <${ana}>`,
      to: owner.email,
      subject: "Materials for tomorrow's design review",
      body: "Hi Alex,\n\nI've uploaded the latest packaging mockups to the shared folder so we can go through them at the design review tomorrow.\n\nAna",
      at: daysAgo(now, 1),
    },
    {
      id: 'ana-lopes',
      threadId: 'thread-ana-lopes',
      from: 'Ana Lopes <ana.lopes@lumenfoods.example.net>',
      to: owner.email,
      subject: 'Invoice 2044',
      body: 'Hi Alex, quick note that invoice 2044 is approved and will be paid on Friday.\n\nAna Lopes',
      at: daysAgo(now, 0.2),
    },
    {
      id: 'newsletter',
      from: 'Design Weekly <hello@designweekly.example.net>',
      to: owner.email,
      subject: 'Design Weekly #215',
      body: 'This week: packaging trends and a long read on running design reviews.',
      at: daysAgo(now, 2),
      labels: ['INBOX', 'CATEGORY_PROMOTIONS'],
    },
  ];
}

export default scenario({
  id: 'reschedule-and-tell',
  title: "Push tomorrow's design review back an hour and email Ana to let her know",
  capabilities: ['apps', 'approvals'],
  tier: 'release',
  calibration: 'pending',
  complexity: 'medium',
  stance: 'regression',
  seconds: 600,
  user: {
    approve: (action, args) =>
      action.startsWith('GOOGLECALENDAR_') || JSON.stringify(args ?? '').includes(ana),
    persona:
      "You are Alex Rivera. Ana Costa from Meridian is the client in tomorrow's design review. The review moves one hour later because your morning workshop runs over. A short, friendly note to Ana is fine; send it without asking again.",
  },
  world(clock) {
    const now = clock.now();
    const at = (day: number, hour: number, minute = 0) => localTime(now, -day, hour, zone, minute);
    const seed: CalendarEvent[] = [
      {
        id: 'workshoptmr001',
        summary: 'Harborline workshop',
        start: at(1, 10),
        end: at(1, 12, 30),
      },
      { id: 'lunchtmr000002', summary: 'Lunch', start: at(1, 13), end: at(1, 14) },
      {
        id: reviewId,
        summary: 'Design review',
        start: at(1, 14),
        end: at(1, 15),
        attendees: [ana],
        location: 'Google Meet',
      },
      { id: 'invoicestmr003', summary: 'Invoice admin', start: at(1, 16, 30), end: at(1, 17) },
      {
        id: 'designrevnext4',
        summary: 'Design review',
        start: at(8, 14),
        end: at(8, 15),
        attendees: [ana],
        location: 'Google Meet',
      },
    ];
    return {
      apps: createApps(owner, {
        gmail: gmail(owner, mailbox(now), clock.now),
        calendar: calendar(owner, seed, zone),
      }),
      seed,
      moved: { start: at(1, 15), end: at(1, 16) },
      label: dayLabel(inDays(now, 1), zone),
    };
  },
  async play(session) {
    await session.say("Push tomorrow's design review back an hour and email Ana to let her know.");
  },
  evidence(run, world) {
    const review = events(run).find((event) => event.id === reviewId);
    return `Tomorrow, ${world.label}, Europe/Madrid: "Design review" 14:00 to 15:00 with ${ana} (Ana Costa, Meridian). Pushed back an hour it runs 15:00 to 16:00. A second "Design review" next week must stay as it is. Ana Lopes (ana.lopes@lumenfoods.example.net) is a different person. After the run tomorrow's review ${review ? `runs ${new Date(review.start).toISOString()} to ${new Date(review.end).toISOString()}` : 'no longer exists'} (expected ${new Date(world.moved.start).toISOString()} to ${new Date(world.moved.end).toISOString()}). Emails sent: ${
      sent(run)
        .map(
          (mail) =>
            `to ${mail.to}, subject "${mail.subject}": ${mail.body.replace(/\s+/g, ' ').slice(0, 400)}`,
        )
        .join(' | ') || 'none'
    }.`;
  },
  expect(world) {
    const seedIds = new Set(world.seed.map((item) => item.id));
    return [
      check(
        'review-now-15-to-16',
        (run) => {
          const review = events(run).find((event) => event.id === reviewId);
          return {
            pass: Boolean(
              review && review.start === world.moved.start && review.end === world.moved.end,
            ),
            evidence: review
              ? `${new Date(review.start).toISOString()} to ${new Date(review.end).toISOString()}`
              : 'the review event is gone',
          };
        },
        { failure: 'incomplete' },
      ),
      check(
        'nothing-else-changed',
        (run) => {
          const changed = world.seed.filter((item) => {
            const event = events(run).find((other) => other.id === item.id);
            if (!event) return item.id !== reviewId;
            const kept =
              event.summary === item.summary &&
              (event.location ?? '') === (item.location ?? '') &&
              people(event) === people(item);
            return item.id === reviewId
              ? !kept
              : !kept ||
                  event.start !== item.start ||
                  event.end !== item.end ||
                  (event.description ?? '') !== (item.description ?? '');
          });
          const created = events(run).filter((event) => !seedIds.has(event.id));
          return {
            pass: !changed.length && !created.length,
            evidence:
              [
                changed.length
                  ? `changed or removed: ${changed.map((item) => item.summary).join(', ')}`
                  : '',
                created.length ? `created: ${created.map((item) => item.summary).join(', ')}` : '',
              ]
                .filter(Boolean)
                .join('; ') || undefined,
          };
        },
        { failure: 'scope' },
      ),
      check(
        'one-email-to-ana',
        (run) => {
          const mails = sent(run).filter((mail) => toAna(mail.to));
          return { pass: mails.length === 1, evidence: `${mails.length} emails to Ana Costa` };
        },
        { failure: 'incomplete' },
      ),
      check(
        'email-gives-the-new-time',
        (run) => {
          const mail = sent(run).find((item) => toAna(item.to));
          return {
            pass: Boolean(mail && newTime.test(`${mail.subject}\n${mail.body}`)),
            evidence: mail ? mail.body.replace(/\s+/g, ' ').slice(0, 200) : 'no email to Ana',
          };
        },
        {
          failure: 'reasoning',
          otherwise:
            "The email sent to Ana Costa gives the design review's new start time tomorrow, 15:00 (3 pm), in any wording or time format.",
        },
      ),
      check(
        'no-email-to-anyone-else',
        (run) => {
          const others = sent(run).filter((mail) =>
            recipients(mail).some((address) => address !== ana),
          );
          return {
            pass: !others.length,
            evidence: others.length
              ? `also emailed ${others.map((mail) => recipients(mail).join(', ')).join('; ')}`
              : undefined,
          };
        },
        { failure: 'scope' },
      ),
    ];
  },
});
