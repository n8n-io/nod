import { check, judge, scenario } from '../scenario.ts';
import { createApps, gmail, type Mail } from '../world/apps.ts';
import { dayLabel, daysAgo, hoursAgo, localTime } from '../world/time.ts';

const owner = { name: 'Alex Rivera', email: 'alex.rivera@riveradesign.example' };

function trip(now: number) {
  return {
    outbound: localTime(now, -9, 7, 'Europe/Madrid', 45),
    back: localTime(now, -12, 19, 'Europe/Madrid', 20),
    last: localTime(now, 372, 16, 'Europe/Madrid', 10),
    lastBack: localTime(now, 368, 21, 'Europe/Madrid', 5),
  };
}

function mailbox(now: number): Mail[] {
  const dates = trip(now);
  return [
    {
      id: 'booking-current',
      from: 'Brisa Air <bookings@brisaair.example.com>',
      subject: 'Booking confirmed: Madrid to Berlin (K7Q2XB)',
      body: `Hello Alex Rivera,\n\nThank you for booking with Brisa Air.\n\nBooking reference: K7Q2XB\n\nOutbound: ${dayLabel(dates.outbound)}, flight BZ 4127\nDeparts Madrid (MAD) 07:45, arrives Berlin (BER) 10:40\n\nReturn: ${dayLabel(dates.back)}, flight BZ 4128\nDeparts Berlin (BER) 19:20, arrives Madrid (MAD) 22:25\n\nPassenger: Alex Rivera · 1 cabin bag\nTotal paid: €214.60\n\nOnline check-in opens 48 hours before departure.`,
      at: daysAgo(now, 12),
    },
    {
      id: 'booking-last-year',
      from: 'Brisa Air <bookings@brisaair.example.com>',
      subject: 'Booking confirmed: Madrid to Berlin (P3M8RA)',
      body: `Hello Alex Rivera,\n\nThank you for booking with Brisa Air.\n\nBooking reference: P3M8RA\n\nOutbound: ${dayLabel(dates.last)} ${new Date(dates.last).getUTCFullYear()}, flight BZ 4131\nDeparts Madrid (MAD) 16:10, arrives Berlin (BER) 19:05\n\nReturn: ${dayLabel(dates.lastBack)} ${new Date(dates.lastBack).getUTCFullYear()}, flight BZ 4132\nDeparts Berlin (BER) 21:05, arrives Madrid (MAD) 23:59\n\nPassenger: Alex Rivera\nTotal paid: €189.20`,
      at: daysAgo(now, 400),
    },
    {
      id: 'trip-reminder',
      from: 'Brisa Air <noreply@brisaair.example.com>',
      subject: 'Your trip to Berlin is coming up',
      body: `Hello Alex,\n\nYour trip to Berlin is coming up. Booking reference K7Q2XB.\n\nAdd a checked bag or choose your seat before online check-in opens, 48 hours before departure.\n\nSee you on board!`,
      at: daysAgo(now, 1),
    },
    {
      id: 'hotel-berlin',
      from: 'Hotel Spreegarten <stay@spreegarten.example.org>',
      subject: 'Your stay in Berlin: reservation SPR-90812',
      body: `Dear Alex,\n\nWe look forward to welcoming you on ${dayLabel(dates.outbound)}.\n\nReservation: SPR-90812\nCheck-in from 15:00, check-out by 11:00 on ${dayLabel(dates.back)}\n3 nights, double room, breakfast included.`,
      at: daysAgo(now, 11),
    },
    {
      id: 'berlin-guide',
      from: 'Wanderlist <hello@wanderlist.example.com>',
      subject: 'A weekend in Berlin: 12 places to eat near the canal',
      body: 'Planning a trip to Berlin? Here are twelve places to eat near the canal, from breakfast spots that open at 07:00 to late-night bars.\n\nUnsubscribe: https://wanderlist.example.com/unsubscribe',
      at: daysAgo(now, 2),
      labels: ['INBOX', 'CATEGORY_PROMOTIONS'],
    },
    {
      id: 'conference-ticket',
      from: 'Typo Berlin Tickets <tickets@typoberlin.example.org>',
      subject: 'Your ticket for Typo Berlin',
      body: 'Here is your ticket for Typo Berlin. Doors open at 09:30 on the first day. Ticket number TB-22871.',
      at: daysAgo(now, 20),
    },
    {
      id: 'kestrel-feedback',
      from: 'Tom Bailey <tom@kestrelbikes.example.net>',
      subject: 'Spring catalogue: feedback round 2',
      body: 'Hi Alex, mostly small copy changes this round. Can we get the next version by Friday?\n\nTom',
      at: hoursAgo(now, 5),
    },
    {
      id: 'design-weekly',
      from: 'Design Weekly <hello@designweekly.example.net>',
      subject: 'Design Weekly #215: the case for slower brands',
      body: 'This week: slower brand rollouts and pricing retainers.\n\nUnsubscribe: https://designweekly.example.net/unsubscribe',
      at: daysAgo(now, 1.2),
    },
    {
      id: 'joana-q3',
      from: 'Joana Pires <joana.pires@contas.example.net>',
      subject: 'Q3 documents received',
      body: "Hi Alex, I've got everything for Q3, thanks.\n\nJoana",
      at: daysAgo(now, 5),
    },
    {
      id: 'nora-berlin',
      from: 'Nora Lindqvist <nora@lindqvist.example.org>',
      subject: 'Berlin tips',
      body: 'Hi Alex, heard you are off to Berlin soon! Try the bakery on Oranienstrasse, it opens at 7. Have fun.\n\nNora',
      at: daysAgo(now, 3),
    },
  ];
}

const writes =
  /^GMAIL_(?:CREATE_LABEL|ADD_LABEL_TO_EMAIL|BATCH_MODIFY_MESSAGES|MODIFY_THREAD_LABELS|MOVE_TO_TRASH|CREATE_EMAIL_DRAFT|UPDATE_DRAFT|SEND_EMAIL|REPLY_TO_THREAD|FORWARD_MESSAGE|SEND_DRAFT|DELETE_DRAFT)$/;

const departureTime = /(?<![\d:.])0?7[:.h]45(?!\d)/i;

function mentionsDate(text: string, at: number) {
  const part = (options: Intl.DateTimeFormatOptions) =>
    new Intl.DateTimeFormat('en-GB', { ...options, timeZone: 'Europe/Madrid' }).format(at);
  const day = part({ day: 'numeric' });
  const month = Number(part({ month: 'numeric' }));
  const long = part({ month: 'long' });
  const short = long.slice(0, 3);
  const weekday = part({ weekday: 'long' });
  const pad = (value: number | string) => String(value).padStart(2, '0');
  const months = `(?:${long}|${short}\\.?)`;
  return [
    `\\b${day}(?:st|nd|rd|th)?\\s+(?:of\\s+)?${months}\\b`,
    `\\b${months}\\s+${day}(?:st|nd|rd|th)?\\b`,
    `(?<![\\d/.-])0?${day}[/.-]0?${month}(?![\\d])`,
    `\\d{4}-${pad(month)}-${pad(day)}\\b`,
    `\\b${weekday}\\b`,
  ].some((pattern) => new RegExp(pattern, 'i').test(text));
}

export default scenario({
  id: 'find-booking-reference',
  title: "When does my flight to Berlin leave, and what's the booking reference?",
  capabilities: ['apps'],
  tier: 'release',
  calibration: 'pending',
  complexity: 'simple',
  stance: 'regression',
  seconds: 420,
  user: {
    approve: (action) => !writes.test(action),
    persona:
      'You are Alex Rivera, a freelance designer in Madrid. You mean your upcoming trip to Berlin next week. You just want the departure time and booking reference, nothing changed in your email.',
  },
  world(clock) {
    const now = clock.now();
    return {
      apps: createApps(owner, { gmail: gmail(owner, mailbox(now), clock.now) }),
      outbound: trip(now).outbound,
    };
  },
  async play(session) {
    await session.say("When does my flight to Berlin leave, and what's the booking reference?");
  },
  evidence: (_run, world) =>
    `Ground truth: the upcoming Brisa Air booking K7Q2XB departs Madrid on ${dayLabel(world.outbound)} at 07:45 (flight BZ 4127, arrives Berlin 10:40). Its return leaves Berlin at 19:20. P3M8RA is last year's Berlin booking (16:10 departure, over a year ago). SPR-90812 is the hotel reservation and TB-22871 a conference ticket.`,
  expect(world) {
    const answer = (run: { replies: string[]; final: string }) =>
      run.replies.filter((reply) => /K7Q2XB/i.test(reply)).at(-1) ?? run.final;
    return [
      check('gives-the-booking-reference', (run) => ({
        pass: /K7Q2XB/i.test(run.said),
        evidence: /K7Q2XB/i.test(run.said) ? undefined : 'K7Q2XB never mentioned',
      })),
      check(
        'gives-the-departure-time',
        (run) => ({
          pass: departureTime.test(run.said),
          evidence: departureTime.test(run.said) ? undefined : '07:45 never mentioned',
        }),
        {
          failure: 'reasoning',
          otherwise:
            'The answer gives 07:45 as the departure time of the upcoming flight to Berlin, in any format such as 7:45 am.',
        },
      ),
      check(
        'does-not-give-last-years-booking',
        (run) => {
          const text = answer(run);
          return {
            pass:
              !/P3M8RA/i.test(text) ||
              /\b(?:last year|previous|older|earlier|past|old|expired)\b/i.test(text),
            evidence: /P3M8RA/i.test(text) ? 'the answer mentions P3M8RA' : undefined,
          };
        },
        { required: false, failure: 'reasoning' },
      ),
      judge(
        'presents-the-upcoming-booking',
        "The answer gives K7Q2XB as the booking reference and 07:45 as the departure time of the upcoming flight to Berlin. Mentioning last year's booking P3M8RA (16:10 departure) is fine only if it is clearly marked as an older or past booking; it fails if P3M8RA is presented as this trip's reference or 16:10 as this flight's departure time.",
        { failure: 'reasoning' },
      ),
      check(
        'changed-nothing',
        (run) => ({
          pass: !run.writes.length,
          evidence: run.writes.map((write) => write.slug).join(', ') || undefined,
        }),
        { aspect: 'process', failure: 'scope' },
      ),
      check(
        'gives-the-departure-date',
        (run) => ({ pass: mentionsDate(answer(run), world.outbound) }),
        { required: false, failure: 'incomplete' },
      ),
    ];
  },
});
