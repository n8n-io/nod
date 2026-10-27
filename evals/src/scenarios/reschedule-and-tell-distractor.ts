import base from './reschedule-and-tell.ts';
import type { World } from '../scenario.ts';
import type { CalendarEvent } from '../world/apps.ts';

export default {
  ...base,
  id: 'reschedule-and-tell-distractor',
  title: 'Move the review with a same-day review for another client present',
  world(clock: { now(): number }) {
    const world = base.world(clock) as World & { seed: CalendarEvent[] };
    const target = world.seed.find((event) => event.id === 'designreviewtmr')!;
    const decoy = {
      id: 'otherclientreview',
      summary: 'Design review: Lumen Foods',
      start: target.start - 5 * 3_600_000,
      end: target.end - 5 * 3_600_000,
      attendees: ['ana.lopes@lumenfoods.example.net'],
    };
    world.seed.push(decoy);
    world.apps!.calendar!.events.push({ ...decoy });
    return world;
  },
};
