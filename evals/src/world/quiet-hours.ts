import type { ObservationProvider, ObservationRecord } from '../../../src/ports/proactivity.ts';
import { nudges } from '../checks.ts';
import { check, scenario } from '../scenario.ts';
import type { Session } from '../session.ts';

const timeZone = 'Europe/Madrid';
const minute = 60_000;
const clock = (at: number) =>
  new Intl.DateTimeFormat('en-GB', {
    timeZone,
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23',
  }).format(at);

export function quietHoursScenario(urgent: boolean) {
  const reference = urgent ? 'RV-617' : 'LS-204';
  return scenario({
    id: urgent ? 'quiet-hours-urgent-nudge' : 'quiet-hours-wait',
    title: urgent
      ? 'An urgent matter during quiet hours reaches the owner at once'
      : 'A matter that can wait during quiet hours reaches the owner when they end',
    capabilities: ['progress'],
    tier: 'release',
    complexity: 'medium',
    stance: 'regression',
    seconds: 1200,
    timeZone,
    user: { approve: false },
    world(time) {
      const replyBy = new Date(time.now() + (urgent ? 45 * minute : 3 * 1440 * minute));
      const record: ObservationRecord = {
        id: 'r-f19',
        version: 'v1',
        available: true,
        data: {
          reference,
          owner: 'Alex',
          state: 'awaiting_choice',
          replyBy: replyBy.toISOString(),
          ...(urgent
            ? {
                options: ['free collection', 'courier for EUR 12'],
                text: 'The equipment is reserved for an accepted job tomorrow morning. The supplier releases the reservation unless Alex returns the collection or courier choice before replyBy. No preference or delivery address is recorded.',
              }
            : {
                options: ['renew for 12 months at EUR 1,450 a month', 'end the lease'],
                text: 'The studio lease renewal needs Alex to choose one option before replyBy. After that the unit goes back on the market. No choice is recorded.',
              }),
        },
      };
      const provider: ObservationProvider = {
        id: 'records',
        async sources() {
          return [
            {
              id: 'current',
              revision: 'r1',
              label: 'Current owner records',
              readable: true,
              description: 'Current structured records. Exact reads return current state.',
            },
          ];
        },
        async read(_source, query) {
          return {
            records: query.ids ? [record].filter((item) => query.ids!.includes(item.id)) : [record],
          };
        },
      };
      return {
        notificationRule:
          'Watch my records for commitments with deadlines and prepare useful work for my review. Do not send, submit or change anything.',
        observations: [provider],
        state: { quietEnd: 0, turnIds: [] as string[] },
      };
    },
    async play(session: Session, world) {
      const end = Date.now() + (urgent ? 120 : 9) * minute;
      world.state.quietEnd = end - (end % minute);
      await session.api('PATCH', '/api/preferences', {
        quietHoursEnabled: true,
        quietStart: clock(Date.now() - minute),
        quietEnd: clock(end),
      });
      const fire = async () => {
        const id = await session.event('Current records changed in source records:current.', [
          'records:current',
        ]);
        world.state.turnIds.push(id);
        await session.waitForTurn(id);
        await session.settle();
      };
      await fire();
      if (urgent) return;
      while (Date.now() < world.state.quietEnd + 30_000)
        await new Promise((done) => setTimeout(done, 5_000));
      const id = await session.proactivity.poll();
      if (id) {
        world.state.turnIds.push(id);
        await session.waitForTurn(id);
      }
      await session.settle();
    },
    completion(world) {
      return check('checks-ran', (run) =>
        world.state.turnIds.every((id) => run.turns.some((turn) => turn.id === id)),
      );
    },
    expect(world) {
      const about = (text: string) => text.replaceAll('\\', '').includes(reference);
      return urgent
        ? [
            check('urgent-nudge-during-quiet-hours', (run) =>
              nudges(run).some(
                (message) => about(message.text) && message.at < world.state.quietEnd,
              ),
            ),
          ]
        : [
            check('no-nudge-during-quiet-hours', (run) =>
              nudges(run).every((message) => message.at >= world.state.quietEnd),
            ),
            check('nudge-after-quiet-hours', (run) =>
              nudges(run).some(
                (message) => about(message.text) && message.at >= world.state.quietEnd,
              ),
            ),
          ];
    },
    evidence(run, world) {
      return JSON.stringify({
        quietEnd: new Date(world.state.quietEnd).toISOString(),
        nudges: nudges(run).map((message) => ({
          at: new Date(message.at).toISOString(),
          text: message.text,
        })),
      });
    },
  });
}
