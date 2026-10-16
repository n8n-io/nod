import { check, scenario } from '../scenario.ts';
import { createApps } from '../world/apps.ts';
import { escapeHtml, page, redirect, type Site } from '../world/sites.ts';
import { dayLabel, inDays, localDate, nextWeekday } from '../world/time.ts';

const owner = { name: 'Alex Rivera', email: 'alex.rivera@riveradesign.example' };
const restaurant = 'tascadorio.example.org';
const widget = 'widget.tablebook.example.net';
const zone = 'Europe/Lisbon';
const times = ['12:00', '12:30', '13:00', '13:30', '14:00', '19:30', '20:00', '21:30'];
const full = ['12:00', '20:00'];

interface Booking {
  date: string;
  time: string;
  party: number;
  name: string;
  email: string;
  code: string;
  at: number;
}

interface State {
  saturday: string;
  bookings: Booking[];
  enquiries: number;
  frames: number;
  rejected: string[];
}

function tasca(state: State): Site {
  const nav =
    '<header><h1>Tasca do Rio</h1><p>Portuguese tavern by the river, Lisbon</p><nav><a href="/">Home</a><a href="/menu">Menu</a><a href="/reservas">Book a table</a><a href="/events">Groups and events</a></nav></header>';
  return ({ url, request }) => {
    if (url.pathname === '/')
      return page(
        'Tasca do Rio',
        `${nav}<h2>Grilled fish, petiscos and river views</h2><p>Open Tuesday to Sunday, 12:00 to 15:00 and 19:00 to 23:00. Closed on Mondays.</p><p><a href="/reservas">Book a table online</a></p>`,
      );
    if (url.pathname === '/menu')
      return page(
        'Menu · Tasca do Rio',
        `${nav}<h2>Menu</h2><ul><li>Grilled sea bream</li><li>Clams Bulhão Pato</li><li>Octopus salad</li><li>Pastel de nata</li></ul>`,
      );
    if (url.pathname === '/reservas')
      return page(
        'Book a table · Tasca do Rio',
        `${nav}<h2>Book a table</h2><p>Reservations for up to 8 people are made online below. For 9 or more, use the <a href="/events">groups and events form</a>.</p><iframe title="TableBook reservations" src="https://${widget}/embed/tasca-do-rio" style="width:100%;height:760px;border:1px solid #ddd"></iframe>`,
      );
    if (url.pathname === '/events' && request.method === 'POST') {
      state.enquiries++;
      return redirect('/events/thanks');
    }
    if (url.pathname === '/events')
      return page(
        'Groups and events · Tasca do Rio',
        `${nav}<h2>Groups and events</h2><p>For parties of 9 or more and private events. We reply within two working days.</p><form method="post" action="/events"><label>Name<input name="name"></label><label>Email<input name="email"></label><label>Date<input type="date" name="date"></label><label>Number of guests<input name="guests"></label><label>Message<textarea name="message"></textarea></label><button>Send enquiry</button></form>`,
      );
    if (url.pathname === '/events/thanks')
      return page(
        'Enquiry sent · Tasca do Rio',
        `${nav}<h2>Thank you</h2><p>We will reply to your enquiry within two working days. This is not a booking.</p>`,
      );
    return page('Not found', `${nav}<p>Page not found.</p>`, 404);
  };
}

function tablebook(state: State): Site {
  const brand = '<p><small>Reservations by TableBook</small></p>';
  const base = '/embed/tasca-do-rio';
  return ({ url, form, request }) => {
    const query = url.searchParams;
    if (url.pathname === base) {
      state.frames++;
      const date = query.get('date') ?? '';
      const party = Number(query.get('party') ?? '2');
      const picker = `<h2>Book at Tasca do Rio</h2><form method="get" action="${base}"><label>Date<input type="date" name="date" value="${escapeHtml(date)}"></label><label>Guests<select name="party">${[1, 2, 3, 4, 5, 6, 7, 8].map((n) => `<option${n === party ? ' selected' : ''}>${n}</option>`).join('')}</select></label><button>Find a time</button></form>`;
      if (!date) return page('TableBook', `${picker}${brand}`);
      if (!/^\d{4}-\d{2}-\d{2}$/.test(date))
        return page('TableBook', `${picker}<p class="error">Choose a valid date.</p>${brand}`, 400);
      if (new Date(`${date}T12:00:00Z`).getUTCDay() === 1)
        return page('TableBook', `${picker}<p>Tasca do Rio is closed on Mondays.</p>${brand}`);
      const slots = times
        .map((time) =>
          full.includes(time)
            ? `<li>${time} · Fully booked</li>`
            : `<li><a href="${base}/details?date=${date}&party=${party}&time=${encodeURIComponent(time)}">${time}</a></li>`,
        )
        .join('');
      return page(
        'TableBook',
        `${picker}<h3>Available times on ${escapeHtml(date)} for ${party}</h3><ul>${slots}</ul>${brand}`,
      );
    }
    if (url.pathname === `${base}/details`)
      return page(
        'TableBook',
        `<h2>Your details</h2><p>Tasca do Rio · ${escapeHtml(query.get('date') ?? '')} at ${escapeHtml(query.get('time') ?? '')} · ${escapeHtml(query.get('party') ?? '')} guests</p><form method="post" action="${base}/book"><input type="hidden" name="date" value="${escapeHtml(query.get('date') ?? '')}"><input type="hidden" name="time" value="${escapeHtml(query.get('time') ?? '')}"><input type="hidden" name="party" value="${escapeHtml(query.get('party') ?? '')}"><label>Name<input name="name"></label><label>Email<input name="email"></label><label>Phone (optional)<input name="phone"></label><label>Requests (optional)<textarea name="notes"></textarea></label><button>Confirm booking</button></form><p><a href="${base}?date=${encodeURIComponent(query.get('date') ?? '')}">Change time</a></p>${brand}`,
      );
    if (url.pathname === `${base}/book` && request.method === 'POST') {
      const date = form.get('date') ?? '';
      const time = form.get('time') ?? '';
      const party = Number(form.get('party') ?? '0');
      const name = (form.get('name') ?? '').trim();
      const email = (form.get('email') ?? '').trim();
      const error = !/^\d{4}-\d{2}-\d{2}$/.test(date)
        ? 'Choose a valid date.'
        : !times.includes(time) || full.includes(time)
          ? 'That time is not available.'
          : !(party >= 1 && party <= 8)
            ? 'Choose between 1 and 8 guests.'
            : !name
              ? 'Enter your name.'
              : !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)
                ? 'Enter a valid email address.'
                : undefined;
      if (error) {
        state.rejected.push(error);
        return page(
          'TableBook',
          `<p class="error" role="alert">${error}</p><p><a href="${base}/details?date=${encodeURIComponent(date)}&party=${party}&time=${encodeURIComponent(time)}">Go back</a></p>${brand}`,
          422,
        );
      }
      const code = `TBK-7Q${4 + state.bookings.length}M`;
      state.bookings.push({ date, time, party, name, email, code, at: Date.now() });
      return redirect(`${base}/confirmed?code=${code}`);
    }
    if (url.pathname === `${base}/confirmed`) {
      const booking = state.bookings.find((item) => item.code === query.get('code'));
      if (!booking) return page('TableBook', `<p>Booking not found.</p>${brand}`, 404);
      return page(
        'Booking confirmed · TableBook',
        `<h2>Booking confirmed</h2><p>Tasca do Rio · ${booking.date} at ${booking.time} · ${booking.party} guests</p><p>Confirmation code <b>${booking.code}</b></p><p>We sent the details to ${escapeHtml(booking.email)}.</p>${brand}`,
      );
    }
    return page('Not found', '<p>Page not found.</p>', 404);
  };
}

export default scenario({
  id: 'iframe-booking-widget',
  title: 'Book a table for 2 at Tasca do Rio this Saturday at 13:00, via tascadorio.example.org.',
  capabilities: ['browser'],
  tier: 'release',
  calibration: 'pending',
  complexity: 'complex',
  stance: 'regression',
  seconds: 900,
  timeZone: zone,
  user: {
    approve: true,
    persona:
      'You are Alex Rivera. The booking is for you and one friend, under your name, email alex.rivera@riveradesign.example, phone +351 910 000 123. No special requests. You want exactly 13:00; if it were not available you would want to hear the options first.',
  },
  world(clock) {
    const now = clock.now();
    const at = inDays(now, nextWeekday(now, 6, 1, zone), zone);
    const state: State = {
      saturday: localDate(at, zone),
      bookings: [],
      enquiries: 0,
      frames: 0,
      rejected: [],
    };
    return {
      apps: createApps(owner, {}),
      sites: { [restaurant]: tasca(state), [widget]: tablebook(state) },
      state,
      label: dayLabel(at, zone),
    };
  },
  async play(session, world) {
    await session.say(
      `Book a table for 2 at Tasca do Rio this Saturday (${world.label}) at 13:00, via tascadorio.example.org.`,
    );
  },
  evidence(_run, world) {
    const s = world.state;
    return `Saturday is ${world.label} (${s.saturday}). Tasca do Rio's booking page embeds a TableBook widget from ${widget} in an iframe; times on that day include 13:00 (12:00 and 20:00 are fully booked). After booking, the widget shows the confirmation code. The restaurant also has a groups and events enquiry form for 9 or more people, which is not a booking. Bookings in the widget: ${s.bookings.map((b) => `${b.code}: ${b.party} guests on ${b.date} at ${b.time} for ${b.name} <${b.email}>`).join('; ') || 'none'}. Widget loads: ${s.frames}. Event enquiries: ${s.enquiries}. Rejected widget submissions: ${s.rejected.join(' | ') || 'none'}.`;
  },
  expect(world) {
    const s = world.state;
    return [
      check(
        'one-booking-for-two-on-saturday-at-13',
        () => ({
          pass:
            s.bookings.length === 1 &&
            s.bookings[0].party === 2 &&
            s.bookings[0].date === s.saturday &&
            s.bookings[0].time === '13:00',
          evidence:
            s.bookings.map((b) => `${b.party} on ${b.date} at ${b.time}`).join('; ') ||
            'no booking in the widget',
        }),
        { failure: 'incomplete' },
      ),
      check(
        'reports-the-confirmation-code',
        (run) => {
          const code = s.bookings.at(-1)?.code;
          return {
            pass:
              Boolean(code) &&
              run.said
                .replace(/[^a-z0-9]/gi, '')
                .toUpperCase()
                .includes(code!.replace(/-/g, '')),
            evidence: code ? `needs ${code}` : 'no confirmation code was issued',
          };
        },
        { failure: 'incomplete' },
      ),
      check(
        'did-not-use-the-events-enquiry-form',
        () => ({ pass: s.enquiries === 0, evidence: `${s.enquiries} event enquiries` }),
        { required: false, aspect: 'process', failure: 'scope' },
      ),
    ];
  },
});
