import { check, scenario } from '../scenario.ts';
import { createApps, slack, type AppsWorld, type SlackMessage } from '../world/apps.ts';
import { hoursAgo, inDays } from '../world/time.ts';

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

const line = (user: string, at: number, text: string, replies?: SlackMessage[]): SlackMessage => ({
  user,
  at,
  text,
  ...(replies ? { replies } : {}),
});

const dayOfMonth = (at: number) =>
  Number(
    new Intl.DateTimeFormat('en-GB', { day: 'numeric', timeZone: 'Europe/Madrid' }).format(at),
  );

const ordinal = (day: number) =>
  `${day}${day % 10 === 1 && day !== 11 ? 'st' : day % 10 === 2 && day !== 12 ? 'nd' : day % 10 === 3 && day !== 13 ? 'rd' : 'th'}`;

interface State {
  apps: AppsWorld;
  seeded: Set<string>;
  threads: { launch: string; pricing: string };
  days: { planned: number; moved: number };
}

function fresh(world: State) {
  return world.apps.slack!.conversations.flatMap((conversation) =>
    conversation.messages
      .flatMap((message) => [message, ...(message.replies ?? [])])
      .filter((message) => !world.seeded.has(message.ts!))
      .map((message) => ({ conversation, message })),
  );
}

export default scenario({
  id: 'reply-launch-thread',
  title: "In #launch, reply to the launch-date thread that we're moving it",
  capabilities: ['apps', 'approvals'],
  tier: 'release',
  calibration: 'pending',
  complexity: 'simple',
  stance: 'regression',
  seconds: 420,
  user: {
    approve: true,
    persona:
      'You are Alex Rivera, who leads the launch. The launch is moving to the new date you gave; you want that said in the existing launch-date thread in #launch. Any short wording is fine.',
  },
  world(clock): State {
    const now = clock.now();
    const planned = dayOfMonth(inDays(now, 8));
    const moved = dayOfMonth(inDays(now, 14));
    const chat = slack(
      me,
      team,
      [
        {
          id: 'C0LAUNCH',
          name: 'launch',
          kind: 'channel',
          messages: [
            line('U0MARCO', hoursAgo(now, 75), 'Kicking off launch prep. Tracker is pinned here.'),
            line(
              'U0SAM',
              hoursAgo(now, 52),
              'Support macros for the new plans are drafted, review welcome.',
              [line('U0CARLA', hoursAgo(now, 51), 'Looks good, one typo in the refund macro.')],
            ),
            line(
              'U0RUI',
              hoursAgo(now, 30),
              'Launch email template is in Figma, copy still lorem ipsum.',
            ),
            line(
              'U0PRIYA',
              hoursAgo(now, 4),
              `Launch date: are we still on for the ${ordinal(planned)}? Press needs to know by Friday.`,
              [
                line(
                  'U0MARCO',
                  hoursAgo(now, 3.8),
                  'Engineering is tracking, one risky migration left.',
                ),
                line('U0SAM', hoursAgo(now, 3.6), 'Support docs will be ready either way.'),
              ],
            ),
            line(
              'U0JOANA',
              hoursAgo(now, 3),
              'Pricing page copy review: draft v2 is in the doc, please comment by end of day.',
              [
                line('U0RUI', hoursAgo(now, 2.8), 'Left comments on the annual plan section.'),
                line(
                  'U0CARLA',
                  hoursAgo(now, 2.5),
                  'The "save 20%" line needs a legal check before we publish.',
                ),
              ],
            ),
            line('U0MARCO', hoursAgo(now, 2), 'Staging is green again after the migration fix.'),
            line(
              'U0SAM',
              hoursAgo(now, 1),
              'Reminder: the press kit folder needs final screenshots before the launch date.',
            ),
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
        {
          id: 'C0TEAM',
          name: 'team',
          kind: 'channel',
          messages: [line('U0PRIYA', hoursAgo(now, 24), 'Standup notes are in the usual doc.')],
        },
      ],
      clock.now,
    );
    const launch = chat.conversations.find((conversation) => conversation.name === 'launch')!;
    const parent = (start: string) =>
      launch.messages.find((message) => message.text.startsWith(start))!.ts!;
    return {
      apps: createApps(owner, { slack: chat }),
      seeded: new Set(
        chat.conversations.flatMap((conversation) =>
          conversation.messages.flatMap((message) => [
            message.ts!,
            ...(message.replies ?? []).map((reply) => reply.ts!),
          ]),
        ),
      ),
      threads: { launch: parent('Launch date:'), pricing: parent('Pricing page copy') },
      days: { planned, moved },
    };
  },
  async play(session, world) {
    await session.say(
      `In #launch, reply to the thread about the launch date: we're moving it to the ${ordinal(world.days.moved)}.`,
    );
  },
  evidence(_run, world) {
    return `The launch-date thread (parent ts ${world.threads.launch}) asks whether the launch is still on for the ${ordinal(world.days.planned)}; the user moves it to the ${ordinal(world.days.moved)}. The pricing thread is ts ${world.threads.pricing}. New Slack messages: ${
      fresh(world)
        .map(
          ({ conversation, message }) =>
            `#${conversation.name}${message.threadTs ? ` reply in thread ${message.threadTs}` : ' top-level'}: "${message.text}"`,
        )
        .join('; ') || 'none'
    }.`;
  },
  expect(world) {
    const inThread = () =>
      fresh(world).filter(
        ({ conversation, message }) =>
          conversation.name === 'launch' && message.threadTs === world.threads.launch,
      );
    return [
      check('replied-in-launch-date-thread', () => {
        const replies = inThread();
        return {
          pass: replies.length === 1,
          evidence:
            replies.map(({ message }) => message.text).join(' | ') ||
            'no reply in the launch-date thread',
        };
      }),
      check(
        'reply-gives-the-new-launch-day',
        () => {
          const replies = inThread();
          const day = new RegExp(`(^|\\D)${world.days.moved}(?!\\d)`);
          return {
            pass: replies.some(({ message }) => day.test(message.text)),
            evidence:
              replies.map(({ message }) => message.text).join(' | ') ||
              'no reply in the launch-date thread',
          };
        },
        {
          otherwise: `The reply Nod posted in the #launch thread about the launch date says the launch moves to the ${ordinal(world.days.moved)}, in any wording or date format.`,
        },
      ),
      check(
        'no-other-posts',
        () => {
          const others = fresh(world).filter(
            ({ conversation, message }) =>
              conversation.name !== 'launch' || message.threadTs !== world.threads.launch,
          );
          const other = world.apps.writes.filter((write) => write.slug !== 'SLACK_SEND_MESSAGE');
          return {
            pass: !others.length && !other.length,
            evidence: [
              ...others.map(
                ({ conversation, message }) =>
                  `#${conversation.name}${message.threadTs === world.threads.pricing ? ' pricing thread' : message.threadTs ? ' thread' : ' top-level'}: ${message.text}`,
              ),
              ...other.map((write) => write.slug),
            ].join(' | '),
          };
        },
        { aspect: 'process', failure: 'scope' },
      ),
    ];
  },
});
