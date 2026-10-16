import { check, judge, scenario } from '../scenario.ts';
import { createApps } from '../world/apps.ts';
import { escapeHtml, page, type Site } from '../world/sites.ts';
import { dayLabel, inDays, localDate, nextWeekday } from '../world/time.ts';

const owner = { name: 'Alex Rivera', email: 'alex.rivera@riveradesign.example' };

interface Venue {
  host: string;
  name: string;
  pattern: RegExp;
  capacity: number;
  about: string;
  bookedOnTarget: boolean;
  booking: 'calendar' | 'form';
}

const venues: Venue[] = [
  {
    host: 'quintadomoinho.example.org',
    name: 'Quinta do Moinho Velho',
    pattern: /moinho\s+velho/i,
    capacity: 90,
    about:
      'A restored 18th-century farm estate 30 minutes from Lisbon, with a main hall, a walled garden and on-site catering. The main hall seats up to 90 guests for dinner, or 140 standing.',
    bookedOnTarget: false,
    booking: 'calendar',
  },
  {
    host: 'armazem16.example.net',
    name: 'Armazém 16',
    pattern: /armaz[eé]m\s*16/i,
    capacity: 45,
    about:
      'A former riverside warehouse in Marvila turned into an event space, with exposed brick, a long communal table and a bar. It hosts up to 45 guests for seated dinners, workshops and team days.',
    bookedOnTarget: false,
    booking: 'form',
  },
  {
    host: 'salaazul.example.com',
    name: 'Sala Azul',
    pattern: /sala\s+azul/i,
    capacity: 25,
    about:
      'An intimate private dining room above our restaurant in Príncipe Real, decorated with blue azulejo tiles. Sala Azul takes up to 25 guests, seated or standing, with a set menu from our kitchen.',
    bookedOnTarget: false,
    booking: 'calendar',
  },
  {
    host: 'casadorio.example.org',
    name: 'Casa do Rio',
    pattern: /casa\s+do\s+rio/i,
    capacity: 60,
    about:
      'A riverside villa in Belém with a terrace over the Tagus and two connecting salons. Casa do Rio hosts up to 60 guests for dinners, receptions and company events.',
    bookedOnTarget: true,
    booking: 'calendar',
  },
  {
    host: 'terracoalto.example.net',
    name: 'Terraço Alto',
    pattern: /terra[cç]o\s+alto/i,
    capacity: 120,
    about:
      'A rooftop terrace and glass pavilion above Avenida da Liberdade with views across the city. Terraço Alto holds up to 120 guests seated, with a retractable roof for cooler evenings.',
    bookedOnTarget: true,
    booking: 'form',
  },
];

const longDate = (at: number) =>
  new Intl.DateTimeFormat('en-GB', {
    weekday: 'long',
    day: 'numeric',
    month: 'long',
    year: 'numeric',
    timeZone: 'Europe/Madrid',
  }).format(at);

function parseDate(value: string) {
  const text = value.trim();
  const iso = /^(\d{4})-(\d{1,2})-(\d{1,2})$/.exec(text);
  if (iso) return `${iso[1]}-${iso[2].padStart(2, '0')}-${iso[3].padStart(2, '0')}`;
  const european = /^(\d{1,2})[/.-](\d{1,2})[/.-](\d{4})$/.exec(text);
  if (european)
    return `${european[3]}-${european[2].padStart(2, '0')}-${european[1].padStart(2, '0')}`;
  return undefined;
}

function venueSite(
  venue: Venue,
  days: Array<{ iso: string; label: string; booked: boolean }>,
): Site {
  return ({ url }) => {
    const header = `<header><h1>${venue.name}</h1><nav><a href="/">The venue</a> <a href="/availability">Availability</a> <a href="/contact">Contact</a></nav></header>`;
    if (url.pathname === '/')
      return page(
        `${venue.name} · Events in Lisbon`,
        `${header}<main><article><h2>About ${venue.name}</h2><p>${venue.about}</p><p><b>Capacity: up to ${venue.capacity} guests.</b></p><p>We host private dinners, company events and celebrations, and every booking has the whole venue to itself. Check the <a href="/availability">availability</a> page for open dates, then write to us to hold a date.</p></article></main>`,
      );
    if (url.pathname === '/availability' && venue.booking === 'calendar')
      return page(
        `Availability · ${venue.name}`,
        `${header}<main><article><h2>Availability</h2><p>Dates for private events at ${venue.name} (up to ${venue.capacity} guests). The venue takes one event per day.</p><ul>${days
          .map((day) => `<li>${day.label}: ${day.booked ? 'Booked' : 'Available'}</li>`)
          .join(
            '',
          )}</ul><p>To hold an available date, write to events@${venue.host}.</p></article></main>`,
      );
    if (url.pathname === '/availability') {
      const raw = url.searchParams.get('date');
      const form = `<form method="get" action="/availability"><label>Event date (dd/mm/yyyy)<input name="date" placeholder="dd/mm/yyyy" value="${escapeHtml(raw ?? '')}"></label><button type="submit">Check availability</button></form>`;
      if (raw === null)
        return page(
          `Availability · ${venue.name}`,
          `${header}<main><article><h2>Check a date</h2><p>Enter the date of your event to see if ${venue.name} is free. We take one private event per day, for up to ${venue.capacity} guests.</p>${form}</article></main>`,
        );
      const iso = parseDate(raw);
      const day = iso ? days.find((item) => item.iso === iso) : undefined;
      const result = !iso
        ? '<p class="error">Please enter the date as dd/mm/yyyy.</p>'
        : !day
          ? '<p class="error">We can only show dates in the next few weeks. Write to us for later dates.</p>'
          : day.booked
            ? `<p><b>${day.label}: booked.</b> ${venue.name} already has an event on this date. Try another date or join the waiting list.</p>`
            : `<p><b>${day.label}: available.</b> ${venue.name} is free for a private event of up to ${venue.capacity} guests on this date.</p>`;
      return page(
        `Availability · ${venue.name}`,
        `${header}<main><article><h2>Check a date</h2>${form}${result}</article></main>`,
      );
    }
    if (url.pathname === '/contact')
      return page(
        `Contact · ${venue.name}`,
        `${header}<main><p>Write to events@${venue.host} and we will answer within one working day.</p></main>`,
      );
    return page(`Not found · ${venue.name}`, `${header}<p>Page not found.</p>`, 404);
  };
}

export default scenario({
  id: 'parallel-venue-research',
  title: 'Check which of these five venues can host 40 people on a date',
  capabilities: ['research', 'browser', 'progress'],
  tier: 'release',
  calibration: 'pending',
  stance: 'regression',
  complexity: 'complex',
  seconds: 900,
  user: {
    approve: true,
    persona:
      'You are Alex Rivera, organising a company dinner for 40 people in Lisbon. Any of these venues is fine if it is free on the date and can take 40 guests. You only want to know which ones work; do not contact or book anything.',
  },
  world(clock) {
    const offset = nextWeekday(clock.now(), 5, 10);
    const target = inDays(clock.now(), offset);
    const span = Array.from({ length: 21 }, (_, index) => inDays(clock.now(), offset - 10 + index));
    const schedules = venues.map((venue, position) =>
      span.map((at, index) => ({
        iso: localDate(at),
        label: longDate(at),
        booked:
          index === 10
            ? venue.bookedOnTarget
            : Math.abs(index - 10) > 1 && (index + position) % 4 === 0,
      })),
    );
    const date = { iso: localDate(target), label: dayLabel(target) };
    return {
      apps: createApps(owner, {}),
      sites: Object.fromEntries(
        venues.map((venue, position) => [venue.host, venueSite(venue, schedules[position])]),
      ),
      date,
    };
  },
  async play(session, world) {
    await session.say(
      `Check which of these five venues can host 40 people on ${world.date.label} and tell me which ones work: ${venues.map((venue) => `https://${venue.host}`).join(', ')}`,
    );
  },
  evidence(run, world) {
    const checked = venues
      .filter((venue) =>
        run.visits.some((visit) => visit.host === venue.host && visit.path === '/availability'),
      )
      .map((venue) => venue.name);
    return [
      `Target date: ${world.date.label} (${world.date.iso}), for 40 guests.`,
      ...venues.map(
        (venue) =>
          `- ${venue.name} (${venue.host}): capacity ${venue.capacity}, ${venue.bookedOnTarget ? 'booked' : 'available'} on the date${venue.booking === 'form' ? ' (date checked with a form)' : ' (date in an availability table)'}. ${venue.capacity >= 40 && !venue.bookedOnTarget ? 'WORKS.' : 'Does not work.'}`,
      ),
      'Only Quinta do Moinho Velho and Armazém 16 work. Sala Azul is free but takes at most 25 guests; Casa do Rio and Terraço Alto are booked on that date (Casa do Rio is free on the days around it).',
      `Availability pages opened: ${checked.join(', ') || 'none'}. Delegated subtasks: ${run.tools.filter((tool) => tool.name === 'delegate').length}.`,
    ].join('\n');
  },
  expect() {
    const working = venues.filter((venue) => venue.capacity >= 40 && !venue.bookedOnTarget);
    return [
      check(
        'names-both-venues-that-work',
        (run) => {
          const missing = working.filter((venue) => !venue.pattern.test(run.said));
          return {
            pass: !missing.length,
            evidence: missing.length
              ? `missing: ${missing.map((venue) => venue.name).join(', ')}`
              : undefined,
          };
        },
        {
          failure: 'reasoning',
          otherwise:
            'The answer presents both Quinta do Moinho Velho and Armazém 16 as venues that work for 40 people on the date, in any wording.',
        },
      ),
      judge(
        'no-unsuitable-venue-presented-as-working',
        'The final answer presents only Quinta do Moinho Velho and Armazém 16 as venues that work for 40 people on the date. It fails if it presents Sala Azul (free that day but takes at most 25 guests), Casa do Rio (booked that day) or Terraço Alto (booked that day) as an option that works. Mentioning them with the reason they do not work is fine.',
        { failure: 'reasoning' },
      ),
      check(
        'checked-every-venue',
        (run) => {
          const missed = venues.filter(
            (venue) => !run.visits.some((visit) => visit.host === venue.host),
          );
          return {
            pass: !missed.length,
            evidence: missed.length
              ? `never opened: ${missed.map((venue) => venue.name).join(', ')}`
              : undefined,
          };
        },
        { required: false, aspect: 'process', failure: 'incomplete' },
      ),
      check(
        'checked-the-venues-in-parallel',
        (run) => {
          const delegated = run.tools.filter((tool) => tool.name === 'delegate').length;
          return { pass: delegated >= 1, evidence: `${delegated} delegate calls` };
        },
        { required: false, aspect: 'process', failure: 'tool' },
      ),
    ];
  },
});
