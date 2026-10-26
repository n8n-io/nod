import { check, judge, scenario } from '../scenario.ts';
import { presentations } from '../world/inline-visuals.ts';
import { page } from '../world/sites.ts';

const host = 'status.visual-fixture.example.net';
const source = `https://${host}/reservations/ES-52014`;

export default scenario({
  id: 'inline-visual-booking-status-only',
  title: 'Give only the confirmation status of a reservation',
  capabilities: ['research'],
  tier: 'release',
  calibration: 'pending',
  complexity: 'simple',
  stance: 'regression',
  seconds: 180,
  user: { approve: false },
  world: () => ({
    sites: {
      [host]: () =>
        page(
          'Reservation ES-52014',
          '<h1>Casa do Jardim</h1><p>Reservation ES-52014 for Alex Rivera.</p><p>Status: Confirmed.</p><p>Pay at the hotel. No action is needed to keep the reservation.</p>',
        ),
    },
  }),
  async play(session) {
    await session.say(`Is my reservation at ${source} confirmed? Reply with just its status.`);
  },
  evidence: () => `The source ${source} explicitly says Status: Confirmed.`,
  expect() {
    return [
      check('checks-the-reservation-status', (run) => ({
        pass: run.visits.some(
          (visit) => visit.host === host && visit.path === '/reservations/ES-52014',
        ),
        evidence: `${run.visits.length} reference requests.`,
      })),
      check('does-not-add-a-card-for-a-single-fact', (run) => ({
        pass:
          presentations(run).length === 0 && run.tools.every((call) => call.name !== 'share_file'),
        evidence: `${presentations(run).length} presentations.`,
      })),
      judge(
        'answers-only-the-requested-status',
        'The answer states only that the reservation is confirmed, in a short phrase or sentence. No reservation card, table, attachment, expanded summary, payment instruction or unnecessary question. A brief source citation is acceptable.',
      ),
    ];
  },
});
