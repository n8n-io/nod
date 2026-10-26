import { check, scenario } from '../scenario.ts';
import {
  createApps,
  gmail,
  slack,
  type AppsWorld,
  type Mail,
  type SlackMessage,
} from '../world/apps.ts';
import { dayLabel, daysAgo, hoursAgo, inDays } from '../world/time.ts';

const owner = { name: 'Alex Rivera', email: 'alex.rivera@riveradesign.example' };
const me = { id: 'U0ALEX', ...owner };
const team = [
  { id: 'U0PRIYA', name: 'Priya Nair', email: 'priya.nair@riveradesign.example' },
  { id: 'U0MARCO', name: 'Marco Bellini', email: 'marco.bellini@riveradesign.example' },
  { id: 'U0JOANA', name: 'Joana Ferreira', email: 'joana.ferreira@riveradesign.example' },
  { id: 'U0RUI', name: 'Rui Almeida', email: 'rui.almeida@riveradesign.example' },
  { id: 'U0CARLA', name: 'Carla Mendes', email: 'carla.mendes@riveradesign.example' },
  { id: 'U0SAM', name: 'Sam Okafor', email: 'sam.okafor@riveradesign.example' },
];
const items = [
  {
    owner: 'Priya',
    id: 'U0PRIYA',
    task: 'send the revised vendor shortlist',
    word: /shortlist/i,
    days: 2,
  },
  {
    owner: 'Marco',
    id: 'U0MARCO',
    task: 'book the venue for the client workshop',
    word: /\bvenue\b/i,
    days: 5,
  },
  {
    owner: 'Sam',
    id: 'U0SAM',
    task: 'update the hiring tracker with the two new roles',
    word: /\btracker\b/i,
    days: 8,
  },
];
const decoys = /case stud|footer|summer campaign|font licen/i;

const line = (user: string, at: number, text: string, replies?: SlackMessage[]): SlackMessage => ({
  user,
  at,
  text,
  ...(replies ? { replies } : {}),
});

interface State {
  apps: AppsWorld;
  seeded: Set<string>;
  due: Array<{ label: string; day: number }>;
}

function fresh(world: State) {
  return world.apps.slack!.conversations.flatMap((conversation) =>
    conversation.messages
      .flatMap((message) => [message, ...(message.replies ?? [])])
      .filter((message) => !world.seeded.has(message.ts!))
      .map((message) => ({ conversation, message })),
  );
}

function mailbox(now: number): Mail[] {
  const due = (days: number) => dayLabel(inDays(now, days));
  return [
    {
      id: 'q4-notes',
      from: 'Carla Mendes <carla.mendes@riveradesign.example>',
      to: 'team@riveradesign.example',
      subject: 'Notes: Q4 planning sync',
      body: [
        'Hi all,',
        '',
        "Notes from today's Q4 planning sync (Alex, Priya, Marco, Sam and me).",
        '',
        'Discussion',
        '- We keep the Lisbon studio and revisit the lease in January.',
        '- Revenue is on track; the bakery rebrand is the biggest Q4 project.',
        '- We will hire two roles this quarter: a motion designer and a studio coordinator.',
        '',
        'Action items',
        ...items.map(
          (item, index) => `${index + 1}. ${item.owner}: ${item.task} by ${due(item.days)}.`,
        ),
        '',
        'Next sync in two weeks.',
        '',
        'Carla',
      ].join('\n'),
      at: hoursAgo(now, 3),
    },
    {
      id: 'retro-notes',
      from: 'Marco Bellini <marco.bellini@riveradesign.example>',
      to: 'team@riveradesign.example',
      subject: 'Meeting notes: website retro',
      body: `Hi team,\n\nQuick notes from the website retro.\n\nWhat went well: the new case study layout, faster image loading.\nWhat to improve: footer links broke twice.\n\nAction items\n1. Joana: archive the old case studies by ${dayLabel(daysAgo(now, 1))}.\n2. Rui: fix the footer links by ${dayLabel(inDays(now, 1))}.\n\nMarco`,
      at: daysAgo(now, 6),
    },
    {
      id: 'q3-notes',
      from: 'Carla Mendes <carla.mendes@riveradesign.example>',
      to: 'team@riveradesign.example',
      subject: 'Notes: Q3 planning sync',
      body: `Hi all,\n\nNotes from the Q3 planning sync.\n\nAction items\n1. Joana: finalise the summer campaign visuals by ${dayLabel(daysAgo(now, 80))}.\n2. Rui: renew the font licences by ${dayLabel(daysAgo(now, 75))}.\n\nCarla`,
      at: daysAgo(now, 91),
    },
    {
      id: 'lunch',
      from: 'Carla Mendes <carla.mendes@riveradesign.example>',
      to: owner.email,
      subject: 'Lunch on Friday?',
      body: 'Hi Alex, fancy lunch on Friday at the place by the river? Carla',
      at: daysAgo(now, 1),
    },
    {
      id: 'newsletter',
      from: 'Design Weekly <hello@designweekly.example.net>',
      to: owner.email,
      subject: 'Design Weekly #214: meeting notes that people actually read',
      body: 'This week: how to write meeting notes with clear owners and dates, and ten templates for action items.',
      at: daysAgo(now, 2),
      labels: ['INBOX', 'CATEGORY_PROMOTIONS'],
    },
  ];
}

export default scenario({
  id: 'email-to-slack-notes',
  title: "Post the action items from Carla's meeting notes email in #team",
  capabilities: ['apps', 'approvals'],
  tier: 'release',
  calibration: 'pending',
  complexity: 'medium',
  stance: 'regression',
  seconds: 600,
  user: {
    approve: true,
    persona:
      "You are Alex Rivera, who runs a small design studio. Carla Mendes sent notes from today's Q4 planning sync by email; you want its action items, with owners and dates, posted in #team as one message. Any clear format is fine.",
  },
  world(clock): State {
    const now = clock.now();
    const chat = slack(
      me,
      team,
      [
        {
          id: 'C0TEAM',
          name: 'team',
          kind: 'channel',
          messages: [
            line('U0PRIYA', hoursAgo(now, 75), 'Standup notes are in the usual doc.'),
            line(
              'U0SAM',
              hoursAgo(now, 52),
              'Two new candidates for the coordinator role this week.',
              [line('U0CARLA', hoursAgo(now, 51), 'Great, add them to the pipeline please.')],
            ),
            line('U0MARCO', hoursAgo(now, 49), 'Client workshop is likely the week after next.'),
            line('U0JOANA', hoursAgo(now, 30), 'Out for a dentist appointment 15:00 to 16:00.'),
            line('U0RUI', hoursAgo(now, 26), 'Font licences renewed for another year.'),
            line('U0CARLA', hoursAgo(now, 6), 'Q4 planning sync at 11:00 in the big room.'),
            line('U0PRIYA', hoursAgo(now, 2), 'Thanks all for a good planning session!'),
          ],
        },
        {
          id: 'C0GENERAL',
          name: 'general',
          kind: 'channel',
          messages: [
            line('U0CARLA', hoursAgo(now, 40), 'New printer is installed on the second floor.'),
            line('U0RUI', hoursAgo(now, 6), 'Fresh coffee beans arrived ☕'),
          ],
        },
        {
          id: 'C0DESIGN',
          name: 'design',
          kind: 'channel',
          messages: [
            line('U0JOANA', hoursAgo(now, 20), 'Hero illustration v2 is in the Launch file.'),
          ],
        },
        {
          id: 'C0LAUNCH',
          name: 'launch',
          kind: 'channel',
          messages: [
            line('U0MARCO', hoursAgo(now, 22), 'Staging is green after the migration fix.'),
          ],
        },
        {
          id: 'C0RANDOM',
          name: 'random',
          kind: 'channel',
          messages: [line('U0SAM', hoursAgo(now, 8), 'Board game night next Thursday, who is in?')],
        },
        {
          id: 'C0SUPPORT',
          name: 'support',
          kind: 'channel',
          messages: [line('U0SAM', hoursAgo(now, 9), 'Two tickets about invoice PDFs.')],
        },
      ],
      clock.now,
    );
    return {
      apps: createApps(owner, { gmail: gmail(owner, mailbox(now), clock.now), slack: chat }),
      seeded: new Set(
        chat.conversations.flatMap((conversation) =>
          conversation.messages.flatMap((message) => [
            message.ts!,
            ...(message.replies ?? []).map((reply) => reply.ts!),
          ]),
        ),
      ),
      due: items.map((item) => {
        const at = inDays(now, item.days);
        return {
          label: dayLabel(at),
          day: Number(
            new Intl.DateTimeFormat('en-GB', { day: 'numeric', timeZone: 'Europe/Madrid' }).format(
              at,
            ),
          ),
        };
      }),
    };
  },
  async play(session) {
    await session.say("Post the action items from Carla's meeting notes email in #team.");
  },
  evidence(_run, world) {
    return [
      `Carla's newest meeting notes email ("Notes: Q4 planning sync", 3 hours ago) has three action items: ${items.map((item, index) => `${item.owner}: ${item.task} by ${world.due[index].label}`).join('; ')}.`,
      'Decoys: Carla\'s "Notes: Q3 planning sync" from three months ago (Joana: summer campaign visuals; Rui: font licences) and Marco\'s "Meeting notes: website retro" (Joana: old case studies; Rui: footer links).',
      `New Slack messages: ${
        fresh(world)
          .map(({ conversation, message }) => `#${conversation.name}: "${message.text}"`)
          .join('; ') || 'none'
      }.`,
    ].join('\n');
  },
  expect(world) {
    const posts = () => fresh(world).filter(({ conversation }) => conversation.name === 'team');
    return [
      check('one-post', () => posts().length === 1, {
        required: false,
        aspect: 'process',
        failure: 'format',
      }),
      check(
        'team-posts-cover-all-three-items',
        () => {
          const found = posts();
          const text = found.map(({ message }) => message.text).join('\n');
          const missing = items.filter(
            (item) =>
              !item.word.test(text) ||
              !(
                new RegExp(`\\b${item.owner}\\b`, 'i').test(text) || text.includes(`<@${item.id}>`)
              ),
          );
          return {
            pass: found.length >= 1 && !missing.length,
            evidence: !found.length
              ? 'no new message in #team'
              : missing.length
                ? `missing ${missing.map((item) => `${item.owner} (${item.task})`).join(', ')}`
                : undefined,
          };
        },
        {
          otherwise:
            "The message Nod posted in #team covers all three action items from Carla's Q4 notes with their owners, in any wording: Priya sends the revised vendor shortlist, Marco books the venue for the client workshop, and Sam updates the hiring tracker.",
        },
      ),
      check(
        'only-the-q4-items',
        () => {
          const wrong = posts().filter(({ message }) => decoys.test(message.text));
          return {
            pass: !wrong.length,
            evidence: wrong.map(({ message }) => message.text).join(' | ') || undefined,
          };
        },
        {
          failure: 'reasoning',
          otherwise:
            'The message Nod posted in #team does not present any item from the older notes (the summer campaign visuals, the font licences, the old case studies, the footer links) as an action item; mentioning them only as excluded passes.',
        },
      ),
      check(
        'nothing-else-posted-or-sent',
        () => {
          const elsewhere = fresh(world).filter(({ conversation }) => conversation.name !== 'team');
          const other = world.apps.writes.filter((write) => write.slug !== 'SLACK_SEND_MESSAGE');
          return {
            pass: !elsewhere.length && !other.length,
            evidence: [
              ...elsewhere.map(
                ({ conversation, message }) => `#${conversation.name}: ${message.text}`,
              ),
              ...other.map((write) => write.slug),
            ].join(' | '),
          };
        },
        { aspect: 'process', failure: 'scope' },
      ),
      check(
        'keeps-the-due-dates',
        () => {
          const text = posts()[0]?.message.text ?? '';
          return world.due.every((due) => new RegExp(`(^|\\D)${due.day}(?!\\d)`).test(text));
        },
        { required: false, failure: 'incomplete' },
      ),
    ];
  },
});
