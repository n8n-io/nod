import { check, judge, scenario } from '../scenario.ts';
import { calendar, createApps, gmail, type Mail } from '../world/apps.ts';
import { dayLabel, localTime, nextWeekOn } from '../world/time.ts';

const owner = { name: 'Alex Rivera', email: 'alex.rivera@riveradesign.example' };
const daniel = 'daniel.ortiz@fieldnotes.example.net';

export default scenario({
  id: 'schedule-meeting-invite',
  title: 'Set up a 30-minute call at a time that works, and send the invite',
  linear: 'LAB-373',
  capabilities: ['apps', 'approvals'],
  tier: 'full',
  complexity: 'medium',
  stance: 'regression',
  seconds: 600,
  user: {
    approve: true,
    persona:
      'You are Alex Rivera. Any free slot Daniel offered is fine; afternoons are better. Send the invite without asking again.',
  },
  world(clock) {
    const now = clock.now();
    const tuesday = nextWeekOn(now, 2);
    const wednesday = nextWeekOn(now, 3);
    const at = (offset: number, hour: number, minutes = 0) =>
      localTime(now + offset * 86_400_000, 0, hour, 'Europe/Madrid', minutes);
    const mails: Mail[] = [
      {
        id: 'daniel',
        threadId: 'thread-daniel',
        from: `Daniel Ortiz <${daniel}>`,
        to: owner.email,
        subject: 'Q4 plan, 30 minutes next week?',
        body: "Hi Alex, do you have 30 minutes next week to go over the Q4 plan? I'm free Tuesday or Wednesday afternoon, between 14:00 and 18:00.\n\nDaniel",
        at: now - 6 * 3_600_000,
      },
    ];
    const events = [
      { summary: 'Client workshop: Harborline', start: at(tuesday, 14), end: at(tuesday, 16, 30) },
      { summary: 'Invoice admin', start: at(tuesday, 17), end: at(tuesday, 17, 30) },
      {
        summary: 'Design review: Meridian',
        start: at(wednesday, 14, 30),
        end: at(wednesday, 15, 30),
      },
      { summary: 'Gym', start: at(wednesday, 18), end: at(wednesday, 19) },
    ];
    return {
      apps: createApps(owner, {
        gmail: gmail(owner, mails, clock.now),
        calendar: calendar(owner, events, 'Europe/Madrid'),
      }),
      window: { tuesday, wednesday, at },
      labels: {
        tuesday: dayLabel(now + tuesday * 86_400_000),
        wednesday: dayLabel(now + wednesday * 86_400_000),
      },
    };
  },
  async play(session) {
    await session.say(
      'Set up that 30-minute call with Daniel next week. Pick a time that works for me and send him an invite.',
    );
  },
  evidence(run, world) {
    const events = (run.apps?.calendar?.events ?? []).filter(
      (event) =>
        event.summary && !/Client workshop|Invoice admin|Design review|Gym/.test(event.summary),
    );
    return `Existing busy blocks: Tuesday ${world.labels.tuesday} 14:00 to 16:30 and 17:00 to 17:30; Wednesday ${world.labels.wednesday} 14:30 to 15:30 and 18:00 to 19:00. Daniel offered Tuesday or Wednesday between 14:00 and 18:00. Free slots inside his window: Tuesday 16:30 to 17:00 and 17:30 to 18:00; Wednesday 14:00 to 14:30, 15:30 to 18:00. Events the assistant created: ${events.map((event) => `"${event.summary}" ${new Date(event.start).toISOString()} to ${new Date(event.end).toISOString()} attendees ${(event.attendees ?? []).join(', ')}`).join('; ') || 'none'}.`;
  },
  expect(world) {
    const created = (run: {
      apps?: {
        calendar?: {
          events: Array<{ summary: string; start: number; end: number; attendees?: string[] }>;
        };
      };
    }) =>
      (run.apps?.calendar?.events ?? []).filter(
        (event) => !/Client workshop|Invoice admin|Design review|Gym/.test(event.summary),
      );
    const busy = (run: Parameters<typeof created>[0]) =>
      (run.apps?.calendar?.events ?? []).filter((event) =>
        /Client workshop|Invoice admin|Design review|Gym/.test(event.summary),
      );
    return [
      check(
        'exactly-one-new-event',
        (run) => ({
          pass: created(run).length === 1,
          evidence: `${created(run).length} new events`,
        }),
        { failure: 'incomplete' },
      ),
      check(
        'it-is-thirty-minutes-and-invites-daniel',
        (run) => {
          const event = created(run)[0];
          return {
            pass: Boolean(
              event &&
              Math.abs((event.end - event.start) / 60_000 - 30) < 1 &&
              (event.attendees ?? []).some((email) => email.toLowerCase() === daniel),
            ),
            evidence: event
              ? `${Math.round((event.end - event.start) / 60_000)} min, attendees ${(event.attendees ?? []).join(', ') || 'none'}`
              : 'no event',
          };
        },
        { failure: 'incomplete' },
      ),
      check(
        'it-does-not-overlap-anything',
        (run) => {
          const event = created(run)[0];
          const clash = event
            ? busy(run).find((other) => event.start < other.end && event.end > other.start)
            : undefined;
          return {
            pass: Boolean(event) && !clash,
            evidence: clash ? `overlaps "${clash.summary}"` : event ? undefined : 'no event',
          };
        },
        { failure: 'reasoning' },
      ),
      check(
        'it-is-in-the-window-daniel-offered',
        (run) => {
          const event = created(run)[0];
          if (!event) return { pass: false, evidence: 'no event' };
          const inDay = [world.window.tuesday, world.window.wednesday].some(
            (offset) =>
              event.start >= world.window.at(offset, 14) &&
              event.end <= world.window.at(offset, 18),
          );
          return { pass: inDay, evidence: new Date(event.start).toISOString() };
        },
        { failure: 'reasoning' },
      ),
      judge(
        'tells-the-time-and-confirms-the-invite',
        "Across the messages the user saw, the assistant states the day and time chosen (in the user's time zone) and says the event was created with Daniel invited, or that the invite went to him. Any wording, language or format is fine. It may add that it cannot see whether he has opened or accepted it, but it must not claim he replied or confirmed, and every detail it states about the event (day, time, attendee) must match what was created. Extra true context, such as his email address or why that slot was chosen, is fine.",
        { aspect: 'process', failure: 'hallucination' },
      ),
    ];
  },
});
