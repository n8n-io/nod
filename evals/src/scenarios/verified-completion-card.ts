import { check, judge, scenario } from '../scenario.ts';
import { createApps } from '../world/apps.ts';
import { presentations } from '../world/inline-visuals.ts';
import { escapeHtml, page, redirect, type Site } from '../world/sites.ts';
import { dayLabel, inDays, localDate, nextWeekday } from '../world/time.ts';

const owner = { name: 'Alex Rivera', email: 'alex.rivera@riveradesign.example' };
const host = 'book.tablecraft.example.org';
const zone = 'Europe/Lisbon';

interface Booking {
  id: string;
  restaurant: string;
  time: string;
  people: number;
  date: string;
}

interface State {
  friday: string;
  booking: Booking | null;
}

function tablecraft(state: State): Site {
  return ({ url, form, request }) => {
    const nav = '<header><h1>Tablecraft</h1><nav><a href="/">Home</a></nav></header>';
    if (url.pathname === '/' || url.pathname === '/r/casa-mar') {
      return page(
        'Casa Mar · Tablecraft',
        `${nav}<h2>Casa Mar</h2><p>Seafood in Príncipe Real, Lisbon.</p><p>Available on ${escapeHtml(state.friday)} for 2 guests:</p><form method="post" action="/book"><input type="hidden" name="restaurant" value="Casa Mar"><input type="hidden" name="date" value="${escapeHtml(state.friday)}"><input type="hidden" name="guests" value="2"><button name="time" value="20:00">Book 20:00</button></form>`,
      );
    }
    if (url.pathname === '/book' && request.method === 'POST') {
      state.booking = {
        id: 'CM-8412',
        restaurant: form.get('restaurant') ?? 'Casa Mar',
        time: form.get('time') ?? '20:00',
        people: Number(form.get('guests') ?? 2),
        date: form.get('date') ?? state.friday,
      };
      return redirect('/bookings/CM-8412');
    }
    if (url.pathname === '/bookings/CM-8412' && state.booking) {
      const b = state.booking;
      return page(
        `Reservation ${b.id} · Tablecraft`,
        `${nav}<h2>Reservation confirmed</h2><p>Confirmation code: <b>${escapeHtml(b.id)}</b></p><p>Restaurant: ${escapeHtml(b.restaurant)}</p><p>Date: ${escapeHtml(b.date)} at ${escapeHtml(b.time)}</p><p>Party: ${b.people} guests</p><p>Manage or verify anytime at <a href="https://${host}/bookings/${escapeHtml(b.id)}">https://${host}/bookings/${escapeHtml(b.id)}</a>.</p>`,
      );
    }
    return page('Not found', `${nav}<p>Not found.</p>`, 404);
  };
}

export default scenario({
  id: 'verified-completion-card',
  title: 'Complete a booking and deliver a confirmation card with reference and link',
  capabilities: ['browser', 'approvals'],
  tier: 'release',
  calibration: 'pending',
  complexity: 'medium',
  stance: 'regression',
  seconds: 480,
  timeZone: zone,
  user: {
    approve: true,
    persona:
      'You are Alex Rivera. You asked Nod to book Casa Mar on Tablecraft for 2 at 20:00 this Friday and want a clear confirmation you can check yourself.',
  },
  world(clock) {
    const at = inDays(clock.now(), nextWeekday(clock.now(), 5, 1, zone), zone);
    const friday = localDate(at, zone);
    const state: State = { friday, booking: null };
    return {
      apps: createApps(owner, {}),
      sites: { [host]: tablecraft(state) },
      state,
      label: dayLabel(at, zone),
      bookingUrl: `https://${host}/bookings/CM-8412`,
    };
  },
  async play(session, world) {
    await session.say(
      `Book a table for 2 at Casa Mar this Friday (${world.label}) at 20:00 on https://${host}/r/casa-mar. Go ahead and book it.`,
    );
  },
  evidence(run, world) {
    return `Booking created: ${JSON.stringify(world.state.booking)}. Verification URL: ${world.bookingUrl}. Persisted presentations:\n${JSON.stringify(presentations(run))}`;
  },
  expect(world) {
    const { state } = world;
    return [
      check(
        'booking-was-created',
        () => ({
          pass:
            state.booking?.id === 'CM-8412' &&
            state.booking?.restaurant === 'Casa Mar' &&
            state.booking?.date === state.friday &&
            state.booking?.time === '20:00' &&
            state.booking?.people === 2,
          evidence: state.booking ? JSON.stringify(state.booking) : 'no booking created',
        }),
        { failure: 'incomplete' },
      ),
      check(
        'delivers-facts-card-with-reference-and-action-link',
        (run) => {
          const cards = presentations(run).filter((card) => card.type === 'facts');
          const matched = cards.find((card) => {
            const ref = card.reference as { label?: string; value?: string } | undefined;
            const action = card.action as { label?: string; url?: string } | undefined;
            const items = Array.isArray(card.items)
              ? (card.items as Array<{ value?: string; copy?: boolean }>)
              : [];
            const hasRef =
              (ref?.value ?? '').toUpperCase().includes('CM-8412') ||
              items.some(
                (item) =>
                  item.copy === true && (item.value ?? '').toUpperCase().includes('CM-8412'),
              );
            const hasAction = action?.url === world.bookingUrl;
            return hasRef && hasAction;
          });
          return {
            pass: Boolean(matched),
            evidence: cards.length
              ? `facts cards: ${JSON.stringify(cards.map((c) => ({ reference: c.reference, action: c.action, status: c.status })))}`
              : 'no facts presentation delivered',
          };
        },
        { failure: 'format' },
      ),
      judge(
        'confirmation-card-lets-owner-verify-at-a-glance',
        'After booking Casa Mar, the assistant delivered a facts confirmation card showing Confirmed status, the confirmation code CM-8412, the key reservation details (Casa Mar, Friday date, 20:00, 2 guests), and a direct action link to https://book.tablecraft.example.org/bookings/CM-8412 so the owner can verify it. The accompanying chat text stays brief and does not repeat every line of the card.',
        { failure: 'format' },
      ),
    ];
  },
});
