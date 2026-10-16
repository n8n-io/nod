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
];
const announcement =
  '📣 We hit 10k users! Huge thanks to everyone who shipped onboarding v2 and the referral flow.';
const thumbs = (name: string) => /^(?:\+1|thumbsup|thumbs_up|thumbs-up|👍)/i.test(name);

const line = (
  user: string,
  at: number,
  text: string,
  extra: Partial<SlackMessage> = {},
): SlackMessage => ({ user, at, text, ...extra });

interface State {
  apps: AppsWorld;
  seeded: Set<string>;
  target: string;
}

function messages(world: State) {
  return world.apps.slack!.conversations.flatMap((conversation) =>
    conversation.messages
      .flatMap((message) => [message, ...(message.replies ?? [])])
      .map((message) => ({ conversation, message })),
  );
}

export default scenario({
  id: 'react-to-announcement',
  title: "Give Marco's announcement in #general a thumbs up",
  capabilities: ['apps', 'approvals'],
  tier: 'release',
  calibration: 'pending',
  complexity: 'simple',
  stance: 'regression',
  seconds: 360,
  user: {
    approve: true,
    persona:
      "You are Alex Rivera, who runs a small design studio. Marco just announced in #general that the product hit 10k users and you want to give that announcement a thumbs-up reaction. You don't want to post a message.",
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
            line('U0MARCO', hoursAgo(now, 150), 'Lunch is on me on Friday, the burrito place 🌯', {
              reactions: [{ name: 'heart_eyes', users: ['U0SAM', 'U0RUI'] }],
            }),
            line('U0CARLA', hoursAgo(now, 100), 'New printer is installed on the second floor.'),
            line(
              'U0PRIYA',
              hoursAgo(now, 50),
              'Announcement: the new parental leave policy is live in the handbook.',
              { reactions: [{ name: 'heart', users: ['U0JOANA', 'U0CARLA'] }] },
            ),
            line('U0RUI', hoursAgo(now, 26), 'Fresh coffee beans arrived ☕'),
            line('U0MARCO', hoursAgo(now, 5), announcement, {
              reactions: [
                { name: 'tada', users: ['U0JOANA', 'U0PRIYA'] },
                { name: '+1', users: ['U0RUI'] },
              ],
              replies: [
                line('U0SAM', hoursAgo(now, 4.9), '🎉🎉🎉'),
                line('U0CARLA', hoursAgo(now, 4.8), 'Cake in the kitchen at 4 to celebrate!'),
              ],
            }),
            line(
              'U0RUI',
              hoursAgo(now, 4),
              'Congrats team! Screenshot of the dashboard for the record.',
              { reactions: [{ name: 'raised_hands', users: ['U0MARCO'] }] },
            ),
            line(
              'U0MARCO',
              hoursAgo(now, 2),
              'Reminder: retro tomorrow at 10:00, please add your notes to the board.',
            ),
            line(
              'U0JOANA',
              hoursAgo(now, 1),
              'Has anyone seen my blue notebook? Left it in the big room.',
            ),
          ],
        },
        {
          id: 'C0LAUNCH',
          name: 'launch',
          kind: 'channel',
          messages: [
            line(
              'U0MARCO',
              hoursAgo(now, 6),
              'Heads up: I am announcing the 10k milestone in #general shortly.',
            ),
            line('U0SAM', hoursAgo(now, 3), 'Support docs for the launch are ready for review.'),
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
    const general = chat.conversations.find((conversation) => conversation.name === 'general')!;
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
      target: general.messages.find((message) => message.text === announcement)!.ts!,
    };
  },
  async play(session) {
    await session.say("Give Marco's announcement in #general a thumbs up.");
  },
  evidence(_run, world) {
    const mine = messages(world).flatMap(({ conversation, message }) =>
      (message.reactions ?? [])
        .filter((reaction) => reaction.users.includes(me.id))
        .map(
          (reaction) =>
            `:${reaction.name}: on #${conversation.name} "${message.text.slice(0, 60)}"`,
        ),
    );
    const added = messages(world).filter(({ message }) => !world.seeded.has(message.ts!));
    return [
      `Marco's announcement is the #general message "${announcement}" (ts ${world.target}). Marco also posted a lunch message and a retro reminder; Priya posted a policy announcement.`,
      `Reactions by the user: ${mine.join('; ') || 'none'}.`,
      `New messages: ${added.map(({ conversation, message }) => `#${conversation.name}: "${message.text}"`).join('; ') || 'none'}.`,
    ].join('\n');
  },
  expect(world) {
    return [
      check('thumbs-up-on-announcement', () => {
        const target = messages(world).find(({ message }) => message.ts === world.target)!.message;
        const reacted = (target.reactions ?? []).filter(
          (reaction) => thumbs(reaction.name) && reaction.users.includes(me.id),
        );
        return {
          pass: reacted.length > 0,
          evidence: `reactions on the announcement: ${(target.reactions ?? []).map((reaction) => `${reaction.name} by ${reaction.users.join(',')}`).join('; ')}`,
        };
      }),
      check(
        'nothing-else-changed',
        () => {
          const stray = messages(world).flatMap(({ conversation, message }) =>
            (message.reactions ?? [])
              .filter(
                (reaction) =>
                  reaction.users.includes(me.id) &&
                  (message.ts !== world.target || !thumbs(reaction.name)),
              )
              .map(
                (reaction) =>
                  `:${reaction.name}: on #${conversation.name} ${message.text.slice(0, 40)}`,
              ),
          );
          const added = messages(world)
            .filter(({ message }) => !world.seeded.has(message.ts!))
            .map(
              ({ conversation, message }) =>
                `new message in #${conversation.name}: ${message.text}`,
            );
          const other = world.apps.writes
            .filter((write) => write.slug !== 'SLACK_ADD_REACTION_TO_AN_ITEM')
            .map((write) => write.slug);
          return {
            pass: !stray.length && !added.length && !other.length,
            evidence: [...stray, ...added, ...other].join(' | ') || undefined,
          };
        },
        { aspect: 'process', failure: 'scope' },
      ),
    ];
  },
});
