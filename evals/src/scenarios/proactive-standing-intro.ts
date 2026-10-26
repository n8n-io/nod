import { noWrites } from '../checks.ts';
import { check, judge, scenario } from '../scenario.ts';
import { calendar, createApps } from '../world/apps.ts';
import { localTime } from '../world/time.ts';

const owner = { name: 'Alex Rivera', email: 'alex.rivera@riveradesign.example' };
const niklas = 'niklas.berg@northwind.example.org';
const priya = 'priya@brightloom.example.org';
const zone = 'Europe/Madrid';

export default scenario({
  id: 'proactive-standing-intro',
  title: 'The first unprompted update says Nod will keep doing it, once',
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
        pass: delivered[0] >= 1 && delivered[0] <= 2 && delivered[1] === 1,
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
      judge(
        'first-update-says-it-will-keep-doing-this',
        'The first update reports that the 1:1 with Niklas moved from 10:00 to 09:00 tomorrow (Europe/Madrid), and is not held back behind a question. It also says, once, in the same message or a short separate one, that Nod will keep flagging calendar changes like this and that the owner can tell it to stop. When a message ends with a question, that line comes before the question. No message lists other things Nod can do.',
        { failure: 'format' },
      ),
      judge(
        'second-update-does-not-repeat-it',
        'The second update reports that the design review with Priya moved to tomorrow at 09:15 and now overlaps the 09:00 to 09:30 1:1 with Niklas, and no message in it repeats that Nod will keep flagging calendar changes or how to stop it.',
        { failure: 'format' },
      ),
      judge(
        'second-update-is-one-message',
        'The second update arrives as a single message, without a follow-up correction or restatement.',
        { required: false, failure: 'format' },
      ),
    ];
  },
});
