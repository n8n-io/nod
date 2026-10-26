import { check, scenario } from '../scenario.ts';
import { createApps, slack, type AppsWorld, type SlackMessage } from '../world/apps.ts';
import { dayLabel, hoursAgo, inDays, nextWeekday } from '../world/time.ts';

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
const months = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec'];

const line = (user: string, at: number, text: string, replies?: SlackMessage[]): SlackMessage => ({
  user,
  at,
  text,
  ...(replies ? { replies } : {}),
});

interface State {
  apps: AppsWorld;
  seeded: Set<string>;
  friday: { label: string; day: number; month: number; iso: string };
}

function fresh(world: State) {
  return world.apps.slack!.conversations.flatMap((conversation) =>
    conversation.messages
      .flatMap((message) => [message, ...(message.replies ?? [])])
      .filter((message) => !world.seeded.has(message.ts!))
      .map((message) => ({ conversation, message })),
  );
}

function namesTheDay(text: string, friday: State['friday']) {
  const { day, month, iso } = friday;
  const name = `${months[month - 1]}[a-z]*\\.?`;
  return [
    /\bfriday\b/i,
    new RegExp(`\\b${day}(?:st|nd|rd|th)?\\s+(?:of\\s+)?${name}`, 'i'),
    new RegExp(`\\b${name}\\s+${day}(?:st|nd|rd|th)?\\b`, 'i'),
    new RegExp(`\\b0?${day}[/.-]0?${month}\\b`),
    new RegExp(`\\b0?${month}/0?${day}\\b`),
    new RegExp(iso),
  ].some((pattern) => pattern.test(text));
}

export default scenario({
  id: 'post-office-closed',
  title: 'Post in #general that the office is closed on Friday for the holiday',
  capabilities: ['apps', 'approvals'],
  tier: 'release',
  calibration: 'pending',
  complexity: 'simple',
  stance: 'regression',
  seconds: 360,
  user: {
    approve: true,
    persona:
      'You are Alex Rivera, who runs a small design studio. The office is closed this coming Friday for the local holiday and you want the whole team told in #general. Any short, friendly wording is fine.',
  },
  world(clock): State {
    const now = clock.now();
    const at = inDays(now, nextWeekday(now, 5, 1));
    const date = new Date(at).toLocaleDateString('en-CA', { timeZone: 'Europe/Madrid' });
    const [, month, day] = date.split('-').map(Number);
    const chat = slack(
      me,
      team,
      [
        {
          id: 'C0GENERAL',
          name: 'general',
          kind: 'channel',
          messages: [
            line(
              'U0CARLA',
              hoursAgo(now, 220),
              'Reminder: the office is closed on Monday for the bank holiday. Enjoy the long weekend!',
              [line('U0SAM', hoursAgo(now, 219), 'Thanks Carla, much needed 🙌')],
            ),
            line(
              'U0MARCO',
              hoursAgo(now, 170),
              'Please welcome Lea, who joins the design crew as a junior designer today 👋',
              [
                line('U0JOANA', hoursAgo(now, 169), 'Welcome Lea! Shout if you need anything.'),
                line('U0PRIYA', hoursAgo(now, 168), 'Welcome aboard!'),
              ],
            ),
            line('U0RUI', hoursAgo(now, 140), 'Wi-Fi in the big meeting room is back up.'),
            line(
              'U0PRIYA',
              hoursAgo(now, 98),
              'All-hands slides from this morning are in the shared drive under Company/All-hands.',
            ),
            line(
              'U0JOANA',
              hoursAgo(now, 75),
              'Lunch & learn on accessible colour palettes next Thursday at 13:00, kitchen area. Bring your lunch.',
            ),
            line(
              'U0SAM',
              hoursAgo(now, 50),
              'Whoever finished the oat milk, the spare cartons are in the top cupboard.',
            ),
            line(
              'U0CARLA',
              hoursAgo(now, 30),
              'New printer is installed on the second floor, it shows up as "Studio Printer 2".',
              [line('U0MARCO', hoursAgo(now, 29), 'Finally, thank you!')],
            ),
            line('U0RUI', hoursAgo(now, 6), 'Fresh coffee beans arrived, the good ones ☕'),
            line(
              'U0MARCO',
              hoursAgo(now, 3),
              'Reminder: timesheets for this month are due by the end of next week.',
            ),
          ],
        },
        {
          id: 'C0DESIGN',
          name: 'design',
          kind: 'channel',
          messages: [
            line('U0JOANA', hoursAgo(now, 26), 'Hero illustration v2 is in the Launch file.'),
            line(
              'U0RUI',
              hoursAgo(now, 20),
              'Figma library update is published, please accept it.',
            ),
            line('U0PRIYA', hoursAgo(now, 4), 'Can someone review the icon grid before lunch?'),
          ],
        },
        {
          id: 'C0LAUNCH',
          name: 'launch',
          kind: 'channel',
          messages: [
            line('U0MARCO', hoursAgo(now, 30), 'Staging is green after the migration fix.'),
            line('U0SAM', hoursAgo(now, 8), 'Support docs for the launch are ready for review.'),
          ],
        },
        {
          id: 'C0RANDOM',
          name: 'random',
          kind: 'channel',
          messages: [
            line('U0SAM', hoursAgo(now, 28), 'Board game night next Thursday, who is in?'),
            line('U0CARLA', hoursAgo(now, 5), 'Plant swap table is up by the kitchen 🌿'),
          ],
        },
        {
          id: 'C0SUPPORT',
          name: 'support',
          kind: 'channel',
          messages: [
            line('U0SAM', hoursAgo(now, 9), 'Two tickets about invoice PDFs, looking into it.'),
          ],
        },
        {
          id: 'C0TEAM',
          name: 'team',
          kind: 'channel',
          messages: [
            line('U0PRIYA', hoursAgo(now, 24), 'Standup notes are in the usual doc.'),
            line('U0JOANA', hoursAgo(now, 2), 'Out for a dentist appointment 15:00 to 16:00.'),
          ],
        },
        {
          id: 'D0CARLA',
          name: 'Carla Mendes',
          kind: 'dm',
          with: 'U0CARLA',
          messages: [
            line(
              'U0CARLA',
              hoursAgo(now, 7),
              'Do you want me to tell everyone about Friday or will you post it?',
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
      friday: { label: dayLabel(at), day, month, iso: date },
    };
  },
  async play(session, world) {
    await session.say(
      `Post in #general that the office is closed on ${world.friday.label} for the holiday.`,
    );
  },
  evidence(_run, world) {
    const posted = fresh(world);
    return [
      `The office is closed on ${world.friday.label} (${world.friday.iso}) for the holiday.`,
      `New Slack messages: ${posted.map(({ conversation, message }) => `${conversation.kind === 'dm' ? `DM with ${conversation.name}` : `#${conversation.name}`}${message.threadTs ? ' (thread reply)' : ''}: "${message.text}"`).join('; ') || 'none'}.`,
    ].join('\n');
  },
  expect(world) {
    const posts = () =>
      fresh(world).filter(
        ({ conversation, message }) => conversation.name === 'general' && !message.threadTs,
      );
    return [
      check('one-post-in-general', () => {
        const found = posts();
        return {
          pass: found.length === 1,
          evidence: found.length
            ? found.map(({ message }) => message.text).join(' | ')
            : 'no new top-level message in #general',
        };
      }),
      check(
        'post-names-friday',
        () => {
          const found = posts();
          return {
            pass: found.some(({ message }) => namesTheDay(message.text, world.friday)),
            evidence: found.length
              ? found.map(({ message }) => message.text).join(' | ')
              : 'no new top-level message in #general',
          };
        },
        {
          otherwise: `The new top-level message Nod posted in #general names ${world.friday.label} as the day the office is closed, in any wording or date format.`,
        },
      ),
      check(
        'says-the-office-is-closed',
        () => {
          const found = posts();
          return {
            pass:
              found.length > 0 &&
              found.every(({ message }) =>
                /\bclos|\bshut|(?:\bnot|n['’]t)\s+(?:be\s+)?open|\bno\s+office\b/i.test(
                  message.text,
                ),
              ),
            evidence: found.map(({ message }) => message.text).join(' | ') || 'no post',
          };
        },
        {
          failure: 'reasoning',
          otherwise:
            'The new top-level message Nod posted in #general tells people the office will be closed, in any wording.',
        },
      ),
      check(
        'nothing-posted-elsewhere',
        () => {
          const elsewhere = fresh(world).filter(
            ({ conversation, message }) => conversation.name !== 'general' || message.threadTs,
          );
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
    ];
  },
});
