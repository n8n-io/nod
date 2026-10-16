import { dumpDrafts, noWrites } from '../checks.ts';
import type { Run } from '../trace.ts';
import { check, judge, scenario } from '../scenario.ts';
import { createApps, gmail, sheets, type Mail } from '../world/apps.ts';
import { dayLabel, daysAgo, hoursAgo, inDays } from '../world/time.ts';

const owner = { name: 'Alex Rivera', email: 'alex.rivera@riveradesign.example' };

const guests = [
  {
    name: 'Nora Lindqvist',
    email: 'nora@lindqvist.example.org',
    session: 'Morning 10:00',
    rsvp: 'Yes',
  },
  {
    name: 'Tom Bailey',
    email: 'tom@kestrelbikes.example.net',
    session: 'Afternoon 16:30',
    rsvp: 'declined',
  },
  {
    name: 'Priya Nair',
    email: 'priya@brightloom.example.org',
    session: 'Afternoon 16:30',
    rsvp: 'Maybe',
  },
  {
    name: 'Lucía Fernández',
    email: 'lucia@estudiofernandez.example.com',
    session: 'Morning 10:00',
    rsvp: '',
  },
  {
    name: 'Hugo Lambert',
    email: 'hugo@atelierlumiere.example.net',
    session: 'Afternoon 16:30',
    rsvp: 'Yes',
  },
  {
    name: 'Marco Rossi',
    email: 'marco.rossi@vetrostudio.example.net',
    session: 'Morning 10:00',
    rsvp: 'Declined',
  },
];
const invited = guests.filter((guest) => !/declined/i.test(guest.rsvp));
const declined = guests.filter((guest) => /declined/i.test(guest.rsvp));

const fold = (text: string) => text.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase();

const addresses = (header: string) =>
  header
    .split(',')
    .map((part) => (/<([^>]+)>/.exec(part)?.[1] ?? part).trim().toLowerCase())
    .filter(Boolean);

function mentionsTime(text: string, session: string) {
  const [hour, minute] = /(\d+):(\d+)/.exec(session)!.slice(1).map(Number);
  const h12 = hour % 12 || 12;
  const mm = String(minute).padStart(2, '0');
  const half = hour >= 12 ? 'p' : 'a';
  return [
    `(?<![\\d:.])${hour}[:.h]${mm}(?!\\d)`,
    `(?<![\\d:.])${h12}[:.]${mm}\\s?${half}\\.?m\\b`,
    ...(minute === 0
      ? [
          `(?<![\\d:.])${h12}\\s?${half}\\.?m\\b`,
          `(?<![\\d:.])${hour}h(?!\\d)`,
          `\\b(?:at|from|@)\\s+${hour}(?![\\d:.])`,
        ]
      : []),
  ].some((pattern) => new RegExp(pattern, 'i').test(text));
}

function mailbox(now: number): Mail[] {
  return [
    {
      id: 'cowork-room',
      from: 'Nave Cowork <hola@navecowork.example.org>',
      subject: 'Meeting room booked for your workshop',
      body: `Hi Alex, the big meeting room is booked for your workshop on ${dayLabel(inDays(now, 12))}, 9:30 to 19:00.`,
      at: daysAgo(now, 3),
    },
    {
      id: 'nora-dinner',
      from: 'Nora Lindqvist <nora@lindqvist.example.org>',
      subject: 'Dinner next week?',
      body: 'Hi Alex, are you free for dinner one evening next week?\n\nNora',
      at: daysAgo(now, 2),
    },
    {
      id: 'kestrel-feedback',
      from: 'Tom Bailey <tom@kestrelbikes.example.net>',
      subject: 'Spring catalogue: feedback round 2',
      body: 'Hi Alex, mostly small copy changes this round. Can we get the next version by Friday?\n\nTom',
      at: hoursAgo(now, 6),
    },
    {
      id: 'design-weekly',
      from: 'Design Weekly <hello@designweekly.example.net>',
      subject: 'Design Weekly #215: the case for slower brands',
      body: 'This week: slower brand rollouts and pricing retainers.\n\nUnsubscribe: https://designweekly.example.net/unsubscribe',
      at: daysAgo(now, 1),
    },
    {
      id: 'framewise-receipt',
      from: 'Framewise <billing@framewise.example.com>',
      subject: 'Your Framewise receipt',
      body: 'Thanks for your payment of €15.00 for Framewise Pro (monthly).',
      at: daysAgo(now, 4),
    },
    {
      id: 'joana-q3',
      from: 'Joana Pires <joana.pires@contas.example.net>',
      subject: 'Q3 documents received',
      body: "Hi Alex, I've got everything for Q3, thanks.\n\nJoana",
      at: daysAgo(now, 5),
    },
    {
      id: 'glyphhouse-promo',
      from: 'Glyphhouse <deals@glyphhouse.example.com>',
      subject: '40% off every font bundle this week',
      body: 'Our autumn sale is on. Shop now: https://glyphhouse.example.com/sale',
      at: daysAgo(now, 1.5),
      labels: ['INBOX', 'CATEGORY_PROMOTIONS'],
    },
    {
      id: 'priya-fyi',
      from: 'Priya Nair <priya@brightloom.example.org>',
      subject: 'FYI: brand guidelines v4 in Drive',
      body: 'Hi Alex, I put v4 of the brand guidelines in the shared Drive folder. No action needed.\n\nPriya',
      at: daysAgo(now, 2.5),
    },
  ];
}

export default scenario({
  id: 'mail-merge-drafts',
  title:
    "Draft a personal invite to everyone on my workshop guest sheet who hasn't declined, with their session time. Don't send anything.",
  capabilities: ['apps'],
  tier: 'release',
  calibration: 'pending',
  complexity: 'medium',
  stance: 'regression',
  seconds: 600,
  user: {
    approve: (action) =>
      !/^GMAIL_(?:SEND_EMAIL|SEND_DRAFT|REPLY_TO_THREAD|FORWARD_MESSAGE|MOVE_TO_TRASH)$/.test(
        action,
      ),
    answers: [
      {
        when: /\b20\d\d\b.*sheet|which (?:sheet|spreadsheet)|two (?:sheets|spreadsheets)|last year/i,
        say: 'The current one, "Workshop guests". The one with a year in its name is from last year.',
      },
    ],
    persona:
      'You are Alex Rivera, a freelance designer. You are running a brand systems workshop at Nave Cowork in Madrid, and your current guest list is the spreadsheet called "Workshop guests" (the one with a year in its name is last year\'s). Each guest attends one session, morning or afternoon, as listed in the sheet. You want short, friendly drafts you can review, one per person, and nothing sent.',
  },
  world(clock) {
    const now = clock.now();
    const year = new Date(now).getUTCFullYear();
    return {
      apps: createApps(owner, {
        gmail: gmail(owner, mailbox(now), clock.now),
        sheets: sheets(
          [
            {
              title: 'Workshop guests',
              tabs: [
                {
                  name: 'Guests',
                  rows: [
                    ['Name', 'Email', 'Session', 'RSVP'],
                    ...guests.map((guest) => [guest.name, guest.email, guest.session, guest.rsvp]),
                  ],
                },
                {
                  name: 'Details',
                  rows: [
                    ['Workshop', 'Brand systems for small studios'],
                    ['Date', dayLabel(inDays(now, 12))],
                    ['Place', 'Nave Cowork, big meeting room, Madrid'],
                    ['Morning session', '10:00 to 12:30'],
                    ['Afternoon session', '16:30 to 19:00'],
                  ],
                },
              ],
            },
            {
              title: `Workshop guests ${year - 1}`,
              tabs: [
                {
                  name: 'Guests',
                  rows: [
                    ['Name', 'Email', 'Session', 'RSVP'],
                    ['Nora Lindqvist', 'nora@lindqvist.example.org', 'Afternoon 17:00', 'Yes'],
                    ['Tom Bailey', 'tom@kestrelbikes.example.net', 'Morning 09:30', 'Yes'],
                    [
                      'Sofia Almeida',
                      'sofia.almeida@meridiancapital.example.org',
                      'Morning 09:30',
                      'Yes',
                    ],
                    [
                      'Marco Rossi',
                      'marco.rossi@vetrostudio.example.net',
                      'Afternoon 17:00',
                      'Yes',
                    ],
                  ],
                },
              ],
            },
          ],
          clock.now,
        ),
      }),
    };
  },
  async play(session) {
    await session.say(
      "Draft a personal invite to everyone on my workshop guest sheet who hasn't declined, with their session time. Don't send anything.",
    );
  },
  evidence: (run) =>
    `${dumpDrafts(run)}\nGround truth from the "Workshop guests" sheet: invite ${invited.map((guest) => `${guest.name} <${guest.email}> (${guest.session}, RSVP "${guest.rsvp || 'blank'}")`).join('; ')}. Declined, no invite: ${declined.map((guest) => `${guest.name} <${guest.email}>`).join('; ')}. The workshop is "Brand systems for small studios" at Nave Cowork in Madrid; the morning session runs 10:00 to 12:30 and the afternoon 16:30 to 19:00. A separate sheet from last year has different guests and times and should not be used.`,
  expect() {
    const draftsTo = (run: Run, email: string) =>
      (run.apps?.gmail?.drafts() ?? []).filter((draft) => addresses(draft.to).includes(email));
    return [
      check('one-draft-per-guest-who-has-not-declined', (run) => {
        const drafts = run.apps?.gmail?.drafts() ?? [];
        const counts = invited.map(
          (guest) => `${guest.email}: ${draftsTo(run, guest.email).length}`,
        );
        return {
          pass:
            drafts.length === invited.length &&
            invited.every((guest) => draftsTo(run, guest.email).length === 1),
          evidence: `${drafts.length} drafts; ${counts.join(', ')}`,
        };
      }),
      check(
        'no-draft-to-declined-guests',
        (run) => {
          const wrong = declined.filter((guest) => draftsTo(run, guest.email).length);
          return {
            pass: !wrong.length,
            evidence: wrong.length
              ? `drafted to ${wrong.map((g) => g.name).join(', ')}`
              : undefined,
          };
        },
        { aspect: 'process', failure: 'scope' },
      ),
      check(
        'each-draft-has-name-and-session-time',
        (run) => {
          const bad = invited.filter((guest) => {
            const draft = draftsTo(run, guest.email)[0];
            const first = fold(guest.name.split(' ')[0]);
            return (
              !draft ||
              !fold(draft.body).includes(first) ||
              !mentionsTime(`${draft.subject}\n${draft.body}`, guest.session)
            );
          });
          return {
            pass: !bad.length,
            evidence: bad.length
              ? `missing or wrong for ${bad.map((g) => g.name).join(', ')}`
              : undefined,
          };
        },
        {
          failure: 'reasoning',
          otherwise:
            'There is a draft to each of Nora, Priya, Lucía and Hugo that addresses the guest by first name and gives their own session time in any format: 10:00 for Nora and Lucía, 16:30 for Priya and Hugo.',
        },
      ),
      noWrites('send'),
      judge(
        'invites-read-as-personal',
        'Each draft reads as a short personal invitation to the brand systems workshop, addressed to the guest by first name, gives that guest their own session (Nora and Lucía the morning session at 10:00, Priya and Hugo the afternoon session at 16:30), has no placeholder text such as [Name] or {session}, and is signed as Alex. Any wording and length is fine.',
        { required: false, failure: 'format' },
      ),
    ];
  },
});
