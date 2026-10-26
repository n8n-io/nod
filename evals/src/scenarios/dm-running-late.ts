import { check, scenario } from '../scenario.ts';
import { createApps, slack, type AppsWorld, type SlackMessage } from '../world/apps.ts';
import { hoursAgo } from '../world/time.ts';

const owner = { name: 'Alex Rivera', email: 'alex.rivera@riveradesign.example' };
const me = { id: 'U0ALEX', ...owner };
const team = [
  { id: 'U0PRIYA', name: 'Priya Nair', email: 'priya.nair@riveradesign.example' },
  { id: 'U0MARCO', name: 'Marco Bellini', email: 'marco.bellini@riveradesign.example' },
  { id: 'U0JOANA', name: 'Joana Ferreira', email: 'joana.ferreira@riveradesign.example' },
  { id: 'U0RUI', name: 'Rui Almeida', email: 'rui.almeida@riveradesign.example' },
  { id: 'U0CARLA', name: 'Carla Mendes', email: 'carla.mendes@riveradesign.example' },
  { id: 'U0SAM', name: 'Sam Okafor', email: 'sam.okafor@riveradesign.example' },
  { id: 'U0PRIYANKA', name: 'Priyanka Rao', email: 'priyanka@raostudio.example.net' },
];

const line = (user: string, at: number, text: string, replies?: SlackMessage[]): SlackMessage => ({
  user,
  at,
  text,
  ...(replies ? { replies } : {}),
});

interface State {
  apps: AppsWorld;
  seeded: Set<string>;
}

function fresh(world: State) {
  return world.apps.slack!.conversations.flatMap((conversation) =>
    conversation.messages
      .flatMap((message) => [message, ...(message.replies ?? [])])
      .filter((message) => !world.seeded.has(message.ts!))
      .map((message) => ({ conversation, message })),
  );
}

const toPriya = (conversation: { kind: string; with?: string }) =>
  conversation.kind === 'dm' && conversation.with === 'U0PRIYA';

export default scenario({
  id: 'dm-running-late',
  title: "DM Priya on Slack that I'm running 10 minutes late for our 3pm",
  capabilities: ['apps', 'approvals'],
  tier: 'release',
  calibration: 'pending',
  complexity: 'simple',
  stance: 'regression',
  seconds: 360,
  user: {
    approve: true,
    answers: [
      {
        when: /priyanka|which priya|priya nair|two (?:people|users|priyas)/i,
        say: 'Priya Nair, my colleague. Priyanka is the freelance illustrator.',
      },
    ],
    persona:
      'You are Alex Rivera, who runs a small design studio. You have a 3pm roadmap review with your colleague Priya Nair and you are running about 10 minutes late. Priyanka Rao is a freelance illustrator, not the Priya you mean. Any short wording is fine.',
  },
  world(clock): State {
    const now = clock.now();
    const chat = slack(
      me,
      team,
      [
        {
          id: 'C0GENERAL',
          name: 'general',
          kind: 'channel',
          messages: [
            line('U0CARLA', hoursAgo(now, 50), 'New printer is installed on the second floor.'),
            line('U0RUI', hoursAgo(now, 26), 'Fresh coffee beans arrived ☕'),
            line(
              'U0MARCO',
              hoursAgo(now, 4),
              'Reminder: timesheets are due by the end of next week.',
            ),
          ],
        },
        {
          id: 'C0DESIGN',
          name: 'design',
          kind: 'channel',
          messages: [
            line('U0JOANA', hoursAgo(now, 30), 'Hero illustration v2 is in the Launch file.', [
              line('U0PRIYANKA', hoursAgo(now, 29), 'I can do a v3 with a warmer sky by Friday.'),
            ]),
            line('U0PRIYA', hoursAgo(now, 6), 'Roadmap numbers for the review are in the deck.'),
          ],
        },
        {
          id: 'C0LAUNCH',
          name: 'launch',
          kind: 'channel',
          messages: [
            line('U0MARCO', hoursAgo(now, 22), 'Staging is green after the migration fix.'),
            line(
              'U0PRIYA',
              hoursAgo(now, 5),
              'Roadmap review is in the small room today, I booked it until 4.',
            ),
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
        {
          id: 'D0PRIYA',
          name: 'Priya Nair',
          kind: 'dm',
          with: 'U0PRIYA',
          messages: [
            line(
              'U0PRIYA',
              hoursAgo(now, 27),
              'Can we keep our 3pm for the roadmap review? I want to walk you through the Q1 numbers.',
            ),
            line(me.id, hoursAgo(now, 26.5), 'Yes, 3pm works. See you then.'),
            line('U0PRIYA', hoursAgo(now, 5), 'Booked the small room for us 👍'),
          ],
        },
        {
          id: 'D0PRIYANKA',
          name: 'Priyanka Rao',
          kind: 'dm',
          with: 'U0PRIYANKA',
          messages: [
            line(
              'U0PRIYANKA',
              hoursAgo(now, 48),
              'Sent over the invoice for the hero illustration, let me know if anything is off.',
            ),
            line(me.id, hoursAgo(now, 47), 'Got it, thanks Priyanka!'),
          ],
        },
        {
          id: 'D0MARCO',
          name: 'Marco Bellini',
          kind: 'dm',
          with: 'U0MARCO',
          messages: [
            line(
              'U0MARCO',
              hoursAgo(now, 3),
              'Are you joining the 3pm with Priya? I might drop in.',
            ),
          ],
        },
      ],
      clock.now,
    );
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
    };
  },
  async play(session) {
    await session.say("DM Priya on Slack that I'm running 10 minutes late for our 3pm.");
  },
  evidence(_run, world) {
    return `Priya Nair is U0PRIYA (DM D0PRIYA). Priyanka Rao (U0PRIYANKA) is a freelance illustrator, not the intended Priya. New Slack messages: ${
      fresh(world)
        .map(
          ({ conversation, message }) =>
            `${conversation.kind === 'dm' ? `DM with ${conversation.name}` : `#${conversation.name}`}: "${message.text}"`,
        )
        .join('; ') || 'none'
    }.`;
  },
  expect(world) {
    return [
      check('one-dm-to-priya', () => {
        const sent = fresh(world).filter(({ conversation }) => toPriya(conversation));
        return {
          pass: sent.length === 1,
          evidence: sent.map(({ message }) => message.text).join(' | ') || 'no DM to Priya Nair',
        };
      }),
      check(
        'dm-says-10-minutes',
        () => {
          const sent = fresh(world).filter(({ conversation }) => toPriya(conversation));
          return {
            pass: sent.some(({ message }) => /\b10(?:\b|\s*min)|\bten\b/i.test(message.text)),
            evidence: sent.map(({ message }) => message.text).join(' | ') || 'no DM to Priya Nair',
          };
        },
        {
          otherwise:
            'The DM Nod sent to Priya Nair says the owner is running 10 minutes late, in any wording or number format.',
        },
      ),
      check(
        'nothing-sent-elsewhere',
        () => {
          const elsewhere = fresh(world).filter(({ conversation }) => !toPriya(conversation));
          const other = world.apps.writes.filter((write) => write.slug !== 'SLACK_SEND_MESSAGE');
          return {
            pass: !elsewhere.length && !other.length,
            evidence: [
              ...elsewhere.map(
                ({ conversation, message }) => `${conversation.name}: ${message.text}`,
              ),
              ...other.map((write) => write.slug),
            ].join(' | '),
          };
        },
        { aspect: 'process', failure: 'scope' },
      ),
      check(
        'says-running-late',
        () =>
          fresh(world).some(
            ({ conversation, message }) =>
              toPriya(conversation) && /\blate\b|\bbehind\b|\bdelay/i.test(message.text),
          ),
        { required: false, failure: 'reasoning' },
      ),
    ];
  },
});
