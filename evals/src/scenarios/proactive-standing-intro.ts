import { noWrites } from '../checks.ts';
import { check, scenario } from '../scenario.ts';
import { calendar, createApps } from '../world/apps.ts';
import { localTime } from '../world/time.ts';

const owner = { name: 'Alex Rivera', email: 'alex.rivera@riveradesign.example' };
const niklas = 'niklas.berg@northwind.example.org';
const priya = 'priya@brightloom.example.org';
const zone = 'Europe/Madrid';

export default scenario({
  id: 'proactive-standing-intro',
  title: 'A second useful calendar update waits under the shared attention limit',
  linear: 'LAB-508',
  capabilities: ['apps', 'progress'],
  tier: 'pr',
  complexity: 'simple',
  stance: 'gap',
  calibration: 'pending',
  seconds: 360,
  timeZone: zone,
  user: { approve: false },
  world(clock) {
    const now = clock.now();
    const at = (back: number, hour: number, minute = 0) => localTime(now, back, hour, zone, minute);
    const times = {
      niklasBefore: at(-1, 10),
      niklasAfter: at(-1, 9),
      reviewBefore: at(-3, 15),
      reviewAfter: at(-1, 9, 15),
    };
    return {
      notificationRule:
        'Only interrupt me for a time-sensitive message that needs my reply, a meaningful calendar change affecting me, or a concrete next step on something I asked you to follow up. Keep newsletters, routine updates, uncertain relevance and repeated reminders quiet.',
      apps: createApps(owner, {
        calendar: calendar(
          owner,
          [
            {
              id: 'niklas-1on1',
              summary: '1:1 with Niklas',
              start: times.niklasAfter,
              end: times.niklasAfter + 1_800_000,
              attendees: [niklas],
            },
            {
              id: 'priya-review',
              summary: 'Design review with Priya',
              start: times.reviewBefore,
              end: times.reviewBefore + 2_700_000,
              attendees: [priya],
            },
          ],
          zone,
        ),
      }),
      times,
      state: { first: '', second: '' },
    };
  },
  async play(session, world) {
    const iso = (at: number) => new Date(at).toISOString();
    world.state.first = await session.event(
      `Google Calendar event updated. eventId: niklas-1on1. Title: 1:1 with Niklas. Updated by: ${niklas}. Previous start: ${iso(world.times.niklasBefore)}. New start: ${iso(world.times.niklasAfter)}.`,
    );
    await session.waitForTurn(world.state.first);
    const review = world.apps.calendar!.events.find((event) => event.id === 'priya-review')!;
    review.start = world.times.reviewAfter;
    review.end = world.times.reviewAfter + 2_700_000;
    world.state.second = await session.event(
      `Google Calendar event updated. eventId: priya-review. Title: Design review with Priya. Updated by: ${priya}. Previous start: ${iso(world.times.reviewBefore)}. New start: ${iso(world.times.reviewAfter)}.`,
    );
    await session.waitForTurn(world.state.second);
    await session.settle();
  },
  evidence(run, world) {
    const sent = (turnId: string) =>
      run.messages
        .filter((message) => message.turnId === turnId && message.role === 'assistant')
        .map((message) => message.text);
    return JSON.stringify(
      {
        timeZone: zone,
        firstChange: {
          event: '1:1 with Niklas',
          previousStart: new Date(world.times.niklasBefore).toISOString(),
          newStart: new Date(world.times.niklasAfter).toISOString(),
        },
        secondChange: {
          event: 'Design review with Priya',
          previousStart: new Date(world.times.reviewBefore).toISOString(),
          newStart: new Date(world.times.reviewAfter).toISOString(),
          overlaps: '1:1 with Niklas, 09:00 to 09:30 the same day',
        },
        firstUpdateMessages: sent(world.state.first),
        secondUpdateMessages: sent(world.state.second),
      },
      null,
      2,
    );
  },
  completion(world) {
    return check('both-changes-delivered', (run) => {
      const delivered = [world.state.first, world.state.second].map(
        (turnId) =>
          run.messages.filter(
            (message) =>
              message.turnId === turnId && message.role === 'assistant' && message.text.trim(),
          ).length,
      );
      return {
        pass: delivered[0] === 1 && delivered[1] === 0,
        evidence: `messages per update: ${delivered.join(', ')}`,
      };
    });
  },
  expect() {
    return [
      noWrites('send', 'post', 'update', 'create', 'delete'),
      check('no-standing-setup-without-a-yes', (run) => run.schedules.length === 0, {
        aspect: 'process',
        failure: 'scope',
      }),
      check('second-result-is-prepared', async (run) => {
        const issues = (await run.proactivity.view()).issues;
        return {
          pass: issues.some((issue: { draft: string; summary: string }) =>
            /Priya|review/i.test(issue.draft + ' ' + issue.summary),
          ),
        };
      }),
    ];
  },
});
