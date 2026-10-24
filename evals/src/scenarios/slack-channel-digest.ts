import { noWrites } from '../checks.ts';
import { check, judge, scenario } from '../scenario.ts';
import { createApps, slack, type SlackMessage } from '../world/apps.ts';
import { duringToday, hoursAgo, localTime } from '../world/time.ts';

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
const highlights = [
  { name: 'Figma library v3', pattern: /\blibrar(?:y|ies)\b|\bv3\b|\btokens?\b/i },
  { name: 'hero illustration', pattern: /\bhero\b|\billustration\b/i },
  { name: 'Friday crit', pattern: /\bcrit(?:ique)?s?\b|\b11[:.]30\b/i },
];

const line = (user: string, at: number, text: string, replies?: SlackMessage[]): SlackMessage => ({
  user,
  at,
  text,
  ...(replies ? { replies } : {}),
});

export default scenario({
  id: 'slack-channel-digest',
  title: 'Catch me up on #design from today',
  capabilities: ['apps', 'progress'],
  tier: 'release',
  calibration: 'pending',
  complexity: 'medium',
  stance: 'regression',
  seconds: 600,
  user: {
    approve: (action) => /^SLACK_(?:AUTH|LIST|FETCH|SEARCH|FIND|DOWNLOAD)/.test(action),
    persona:
      'You are Alex Rivera, who runs a small design studio. You were in workshops all day and want a short catch-up on what happened in #design today only. You do not want anything posted.',
  },
  world(clock) {
    const now = clock.now();
    const today = (fraction: number) => duringToday(now, fraction);
    const yesterday = (hour: number, minute = 0) =>
      localTime(now, 1, hour, 'Europe/Madrid', minute);
    return {
      apps: createApps(owner, {
        slack: slack(
          me,
          team,
          [
            {
              id: 'C0DESIGN',
              name: 'design',
              kind: 'channel',
              messages: [
                line(
                  'U0JOANA',
                  yesterday(9, 30),
                  'Brand audit for the Harbor & Pine bakery is done, findings are in the Brand Audit doc.',
                  [line('U0RUI', yesterday(9, 50), 'Great work, the type section is spot on.')],
                ),
                line(
                  'U0MARCO',
                  yesterday(11, 15),
                  'Icon set refresh: 40 of 64 icons redrawn, the rest by Thursday.',
                ),
                line(
                  'U0PRIYA',
                  yesterday(12, 40),
                  'Moodboard for the bakery pitch is up in the Pitch folder.',
                  [line('U0SAM', yesterday(13, 0), 'Love the tile textures.')],
                ),
                line(
                  'U0SAM',
                  yesterday(15, 20),
                  'Workshop with the bakery team is confirmed for Wednesday at 10:00.',
                ),
                line(
                  'U0CARLA',
                  yesterday(17, 5),
                  'Expense reports for the month are due on the 30th.',
                ),
                line(
                  'U0RUI',
                  yesterday(18, 30),
                  'Pushed the icon grid template to the shared drive.',
                ),
                line(
                  'U0RUI',
                  today(0.05),
                  'Morning! Figma library v3 is published: new spacing tokens, the rebuilt button set and dark mode colours. Please switch your files over by next week.',
                  [
                    line(
                      'U0JOANA',
                      today(0.1),
                      'Amazing, thanks Rui! Switching the Launch file now.',
                    ),
                    line('U0PRIYA', today(0.12), 'Do the old v2 components break when we switch?'),
                    line(
                      'U0RUI',
                      today(0.15),
                      'They stay linked until you accept the update, so no rush.',
                    ),
                  ],
                ),
                line(
                  'U0JOANA',
                  today(0.3),
                  'First pass of the hero illustration for the landing page is in the Launch file. Feedback by tomorrow noon please 🙏',
                  [
                    line('U0MARCO', today(0.35), 'Love it. Could the sky be a touch less purple?'),
                    line('U0SAM', today(0.4), 'The figure on the left feels small on mobile.'),
                  ],
                ),
                line(
                  'U0SAM',
                  today(0.55),
                  'Heads up: Friday crit moves to 11:30 because of the all-hands. Same room.',
                ),
                line(
                  'U0CARLA',
                  today(0.65),
                  'Whoever borrowed the Pantone fan deck, please bring it back to the studio shelf.',
                ),
                line(
                  'U0MARCO',
                  today(0.75),
                  'Exporting the app store screenshots now, will drop them here by end of day.',
                ),
                line(
                  'U0PRIYA',
                  today(0.85),
                  'Quick poll for the crit: present the hero illustration or the onboarding screens first?',
                  [line('U0JOANA', today(0.9), 'Hero first, it needs the most eyes.')],
                ),
              ],
            },
            {
              id: 'C0GENERAL',
              name: 'general',
              kind: 'channel',
              messages: [
                line('U0CARLA', hoursAgo(now, 40), 'New printer is installed on the second floor.'),
                line('U0RUI', today(0.2), 'Fresh coffee beans arrived ☕'),
              ],
            },
            {
              id: 'C0LAUNCH',
              name: 'launch',
              kind: 'channel',
              messages: [line('U0MARCO', today(0.4), 'Staging is green after the migration fix.')],
            },
            {
              id: 'C0RANDOM',
              name: 'random',
              kind: 'channel',
              messages: [line('U0SAM', today(0.5), 'Board game night next Thursday, who is in?')],
            },
            {
              id: 'C0SUPPORT',
              name: 'support',
              kind: 'channel',
              messages: [line('U0SAM', today(0.6), 'Two tickets about invoice PDFs.')],
            },
            {
              id: 'C0TEAM',
              name: 'team',
              kind: 'channel',
              messages: [line('U0PRIYA', today(0.1), 'Standup notes are in the usual doc.')],
            },
          ],
          clock.now,
        ),
      }),
    };
  },
  async play(session) {
    await session.say('Catch me up on #design from today.');
  },
  evidence: () =>
    [
      "Today's #design messages (12, threads included): Rui published Figma library v3 (spacing tokens, rebuilt button set, dark mode colours; switch files by next week; old v2 components stay linked until the update is accepted). Joana posted the first pass of the hero illustration for the landing page, feedback by tomorrow noon; Marco asked for a less purple sky and Sam said the left figure feels small on mobile. Sam: Friday crit moves to 11:30 because of the all-hands, same room. Carla asked for the Pantone fan deck back. Marco is exporting the app store screenshots by end of day. Priya polled whether to present the hero illustration or the onboarding screens first at the crit; Joana said hero first.",
      "Yesterday's #design messages (8), not today: Joana finished the brand audit for the Harbor & Pine bakery; Marco's icon set refresh (40 of 64 icons, the rest by Thursday); Priya's moodboard for the bakery pitch; Sam confirmed the bakery workshop for Wednesday at 10:00; Carla's expense report reminder; Rui pushed the icon grid template.",
    ].join('\n'),
  expect() {
    return [
      check(
        'covers-todays-highlights',
        (run) => {
          const missing = highlights.filter((item) => !item.pattern.test(run.said));
          return {
            pass: !missing.length,
            evidence: missing.length
              ? `missing ${missing.map((item) => item.name).join(', ')}`
              : undefined,
          };
        },
        {
          otherwise:
            "The catch-up covers all three of today's #design highlights in any wording: Rui publishing Figma library v3, Joana's first pass of the hero illustration, and Friday crit moving to 11:30.",
        },
      ),
      noWrites('post', 'send', 'create', 'update', 'delete'),
      judge(
        'keeps-yesterday-out-of-today',
        "The assistant does not present any of yesterday's items as having happened today: the brand audit for the bakery, the icon set refresh, the bakery moodboard, the bakery workshop confirmation, the expense report reminder, or the icon grid template. It may leave them out, or mention them only if it clearly labels them as earlier than today. Fails if any of them appears in the catch-up as today's news.",
      ),
    ];
  },
});
