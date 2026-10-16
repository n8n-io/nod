import { check, scenario } from '../scenario.ts';
import { createApps } from '../world/apps.ts';
import { escapeHtml, page, redirect, type Site } from '../world/sites.ts';
import { dayLabel, inDays, localDate, nextWeekday } from '../world/time.ts';

const owner = { name: 'Alex Rivera', email: 'alex.rivera@riveradesign.example' };
const host = 'velofix.example.net';
const zone = 'Europe/Lisbon';
const slots = ['09:00', '10:00', '11:00', '14:30', '16:00'];
const morning = ['09:00', '10:00', '11:00'];
const services = [
  'General check-up (€35)',
  'Puncture repair (€15)',
  'Brake tune (€25)',
  'Gear tune (€25)',
  'Not sure, diagnose it (€10)',
];

interface Booking {
  name: string;
  email: string;
  date: string;
  time: string;
  service: string;
  code: string;
}

interface State {
  day: string;
  bookings: Booking[];
  rejected: Array<{ date: string; time: string; error: string }>;
}

function velofix(state: State): Site {
  const nav =
    '<header><h1>VeloFix</h1><p>Bike repairs in Lisbon · Monday to Saturday</p><nav><a href="/">Home</a><a href="/book">Book a repair</a></nav></header>';
  const form = (values: Record<string, string>, error?: string) =>
    `${nav}<h2>Book a repair slot</h2>${error ? `<p class="error" role="alert">${escapeHtml(error)}</p>` : ''}<form method="post" action="/book"><label>Name<input name="name" value="${escapeHtml(values.name ?? '')}"></label><label>Email<input name="email" value="${escapeHtml(values.email ?? '')}"></label><label>Phone (optional)<input name="phone" value="${escapeHtml(values.phone ?? '')}"></label><label>Bike type<select name="bike">${['City', 'Road', 'Mountain', 'E-bike', 'Other'].map((bike) => `<option${values.bike === bike ? ' selected' : ''}>${bike}</option>`).join('')}</select></label><label>Service<select name="service">${services.map((service) => `<option${values.service === service ? ' selected' : ''}>${service}</option>`).join('')}</select></label><label>Date<input name="date" value="${escapeHtml(values.date ?? '')}"></label><label>Time<select name="time">${slots.map((slot) => `<option${values.time === slot ? ' selected' : ''}>${slot}</option>`).join('')}</select></label><label>Notes<textarea name="notes">${escapeHtml(values.notes ?? '')}</textarea></label><button type="submit">Book slot</button></form>`;
  return ({ url, form: body, request }) => {
    if (url.pathname === '/')
      return page(
        'VeloFix · Bike repairs',
        `${nav}<h2>Same-day bike repairs</h2><p>Drop your bike off at your slot and pick it up the same evening. Workshop at Rua da Prata, Lisbon.</p><p><a href="/book">Book a repair slot</a></p>`,
      );
    if (url.pathname === '/book' && request.method === 'POST') {
      const values = Object.fromEntries(
        ['name', 'email', 'phone', 'bike', 'service', 'date', 'time', 'notes'].map((key) => [
          key,
          (body.get(key) ?? '').trim(),
        ]),
      );
      const fail = (error: string) => {
        state.rejected.push({ date: values.date, time: values.time, error });
        return page('Book a repair · VeloFix', form(values, error), 422);
      };
      if (!values.name) return fail('Enter your name.');
      if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(values.email)) return fail('Enter a valid email.');
      const valid =
        /^\d{4}-\d{2}-\d{2}$/.test(values.date) &&
        new Date(`${values.date}T12:00:00Z`).toISOString().slice(0, 10) === values.date;
      if (!valid) return fail('Use the format YYYY-MM-DD');
      if (values.date < localDate(Date.now(), zone)) return fail('Choose a date from today on.');
      if (new Date(`${values.date}T12:00:00Z`).getUTCDay() === 0)
        return fail('We are closed on Sundays. Choose another day.');
      if (!slots.includes(values.time)) return fail('Choose one of the listed times.');
      if (values.date === state.day && values.time === '09:00')
        return fail(`09:00 on ${values.date} is already booked. Free that morning: 10:00, 11:00.`);
      if (state.bookings.some((item) => item.date === values.date && item.time === values.time))
        return fail(`${values.time} on ${values.date} is already booked.`);
      const code = `VF-28K${4 + state.bookings.length}`;
      state.bookings.push({
        name: values.name,
        email: values.email,
        date: values.date,
        time: values.time,
        service: values.service,
        code,
      });
      return redirect(`/booking/${code}`);
    }
    if (url.pathname === '/book') return page('Book a repair · VeloFix', form({}));
    const done = /^\/booking\/([A-Z0-9-]+)$/.exec(url.pathname);
    const booking = done && state.bookings.find((item) => item.code === done[1]);
    if (booking)
      return page(
        'Booking confirmed · VeloFix',
        `${nav}<h2>Your slot is booked</h2><p>Booking code <b>${booking.code}</b></p><p>${escapeHtml(booking.date)} at ${escapeHtml(booking.time)} · ${escapeHtml(booking.service)}</p><p>Bring your bike to the workshop at your slot.</p>`,
      );
    return page('Not found', `${nav}<p>Page not found.</p>`, 404);
  };
}

export default scenario({
  id: 'form-date-validation',
  title: 'Book a bike repair slot at velofix.example.net for Wednesday morning.',
  capabilities: ['browser'],
  tier: 'release',
  calibration: 'pending',
  complexity: 'medium',
  stance: 'regression',
  seconds: 600,
  timeZone: zone,
  user: {
    approve: true,
    persona:
      'You are Alex Rivera. Your email is alex.rivera@riveradesign.example and your phone is +351 910 000 123. You have a city bike whose gears slip and whose rear brake squeaks; any repair service that covers it is fine. Any morning time works for you.',
  },
  world(clock) {
    const now = clock.now();
    const at = inDays(now, nextWeekday(now, 3, 3, zone), zone);
    const state: State = { day: localDate(at, zone), bookings: [], rejected: [] };
    return {
      apps: createApps(owner, {}),
      sites: { [host]: velofix(state) },
      state,
      label: dayLabel(at, zone),
    };
  },
  async play(session, world) {
    await session.say(
      `Book a bike repair slot at velofix.example.net for the morning of ${world.label}.`,
    );
  },
  evidence(_run, world) {
    const s = world.state;
    return `The wanted day is ${world.label} (${s.day}). The booking form has a plain text date field and the server only accepts YYYY-MM-DD, answering "Use the format YYYY-MM-DD" otherwise. Slots are 09:00, 10:00 and 11:00 in the morning and 14:30 and 16:00 in the afternoon; 09:00 on that day is already taken, so 10:00 or 11:00 are the free morning slots. Accepted bookings: ${s.bookings.map((b) => `${b.code} on ${b.date} at ${b.time} (${b.service})`).join('; ') || 'none'}. Rejected submissions: ${s.rejected.map((r) => `"${r.date}" ${r.time}: ${r.error}`).join(' | ') || 'none'}.`;
  },
  expect(world) {
    const s = world.state;
    return [
      check(
        'one-morning-booking-on-the-day',
        () => ({
          pass:
            s.bookings.length === 1 &&
            s.bookings[0].date === s.day &&
            morning.includes(s.bookings[0].time),
          evidence:
            s.bookings.map((b) => `${b.date} ${b.time}`).join(', ') || 'no accepted booking',
        }),
        { failure: 'incomplete' },
      ),
      check(
        'reports-the-booking-code',
        (run) => {
          const code = s.bookings.at(-1)?.code;
          return {
            pass:
              Boolean(code) &&
              run.said
                .replace(/[^a-z0-9]/gi, '')
                .toUpperCase()
                .includes(code!.replace('-', '')),
            evidence: code ? `needs ${code}` : 'no booking code was issued',
          };
        },
        { failure: 'incomplete' },
      ),
      check(
        'recovered-without-thrashing',
        () => ({
          pass: s.rejected.length <= 3,
          evidence: `${s.rejected.length} rejected submissions`,
        }),
        { required: false, aspect: 'process', failure: 'tool' },
      ),
    ];
  },
});
