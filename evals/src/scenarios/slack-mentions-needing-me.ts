import { noWrites } from '../checks.ts';
import { check, judge, scenario } from '../scenario.ts';
import { createApps, slack, type SlackMessage } from '../world/apps.ts';
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

const line = (user: string, at: number, text: string, replies?: SlackMessage[]): SlackMessage => ({
  user,
  at,
  text,
  ...(replies ? { replies } : {}),
});

export default scenario({
  id: 'slack-mentions-needing-me',
  title: 'Did anyone mention me in Slack in the last day and need something from me?',
  capabilities: ['apps'],
  tier: 'release',
  calibration: 'pending',
  complexity: 'medium',
  stance: 'regression',
  seconds: 600,
  user: {
    approve: (action) => /^SLACK_(?:AUTH|LIST|FETCH|SEARCH|FIND|DOWNLOAD)/.test(action),
    persona:
      'You are Alex Rivera, who runs a small design studio. You want to know which Slack mentions from the last 24 hours still need something from you. You do not want anything posted or reacted to.',
  },
  world(clock) {
    const now = clock.now();
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
                  'U0RUI',
                  hoursAgo(now, 30),
                  'Figma library v3 is published, please accept the update.',
                ),
                line('U0PRIYA', hoursAgo(now, 12), 'Who has the Pantone swatch book?'),
                line(
                  'U0JOANA',
                  hoursAgo(now, 5),
                  '<@U0ALEX> could you send me the brand deck for the Harbor & Pine pitch by tomorrow at 10:00? I want to rehearse with it.',
                ),
                line(
                  'U0CARLA',
                  hoursAgo(now, 4),
                  '<@U0PRIYA> can you share the van mockup? I need it for the print quote.',
                ),
                line(
                  'U0SAM',
                  hoursAgo(now, 2),
                  'Hero illustration v2 looks great, nice one Joana.',
                ),
              ],
            },
            {
              id: 'C0LAUNCH',
              name: 'launch',
              kind: 'channel',
              messages: [
                line('U0MARCO', hoursAgo(now, 26), 'Staging is green after the migration fix.'),
                line(
                  'U0MARCO',
                  hoursAgo(now, 18),
                  '<@U0ALEX> can you give feedback on the onboarding flow v2 before we hand it to engineering?',
                  [
                    line(
                      me.id,
                      hoursAgo(now, 16),
                      'Done, left my comments in Figma. Looks great, ship it after the copy tweaks.',
                    ),
                    line('U0MARCO', hoursAgo(now, 15.5), 'Perfect, thanks! Handing it over now.'),
                  ],
                ),
                line(
                  'U0SAM',
                  hoursAgo(now, 7),
                  'Support docs for the launch are ready for review.',
                ),
              ],
            },
            {
              id: 'C0GENERAL',
              name: 'general',
              kind: 'channel',
              messages: [
                line('U0CARLA', hoursAgo(now, 40), 'New printer is installed on the second floor.'),
                line(
                  'U0RUI',
                  hoursAgo(now, 9),
                  "FYI <@U0ALEX>: the client moved Thursday's kickoff to 14:00. No action needed, the calendar is already updated.",
                ),
                line(
                  'U0PRIYA',
                  hoursAgo(now, 6),
                  'The talk at the design meetup last night was great, slides are in the shared drive.',
                ),
                line('U0MARCO', hoursAgo(now, 3), 'Reminder: timesheets are due Friday.'),
              ],
            },
            {
              id: 'C0SUPPORT',
              name: 'support',
              kind: 'channel',
              messages: [
                line(
                  'U0SAM',
                  hoursAgo(now, 75),
                  '<@U0ALEX> can you approve the refund for the Lisbon print order when you get a sec?',
                ),
                line('U0SAM', hoursAgo(now, 8), 'Two tickets about invoice PDFs, looking into it.'),
              ],
            },
            {
              id: 'C0RANDOM',
              name: 'random',
              kind: 'channel',
              messages: [
                line('U0SAM', hoursAgo(now, 10), 'Board game night next Thursday, who is in?'),
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
          ],
          clock.now,
        ),
      }),
    };
  },
  async play(session) {
    await session.say('Did anyone mention me in Slack in the last day and need something from me?');
  },
  evidence: () =>
    [
      'Mentions of the user (<@U0ALEX>) in the last 24 hours:',
      '1. Joana Ferreira in #design, 5 hours ago: asks for the brand deck for the Harbor & Pine pitch by tomorrow at 10:00. No reply yet, so it is open.',
      '2. Marco Bellini in #launch, 18 hours ago: asked for feedback on onboarding flow v2. Alex already replied in the thread 16 hours ago ("Done, left my comments in Figma...") and Marco thanked him, so it is closed.',
      "3. Rui Almeida in #general, 9 hours ago: FYI that the client moved Thursday's kickoff to 14:00, no action needed.",
      'Not in the window or not a mention of the user: Sam asked the user to approve a refund in #support about 75 hours ago (older than a day); Carla asked Priya (not the user) for the van mockup.',
      "The only mention from the last day that still needs something from the user is Joana's brand deck request.",
    ].join('\n'),
  expect() {
    return [
      check(
        'names-joana-brand-deck',
        (run) => {
          const joana = /\bjoana\b/i.test(run.said);
          const deck = /\bdeck\b|\bharbor\b|\bpitch\b/i.test(run.said);
          return {
            pass: joana && deck,
            evidence: `${joana ? '' : 'Joana not named; '}${deck ? '' : 'brand deck not named'}`,
          };
        },
        {
          otherwise:
            'The assistant tells the user that Joana Ferreira needs the brand deck for the Harbor & Pine pitch from them, in any wording.',
        },
      ),
      noWrites('post', 'send', 'create', 'update', 'delete'),
      judge(
        'marco-request-not-open',
        "The assistant does not present Marco's request for feedback on onboarding flow v2 as something the user still needs to do. The user already replied in that thread with their feedback. Mentioning it as already handled or answered is fine, and leaving it out is fine. Fails if it is listed as open, pending, or needing a reply or action from the user.",
      ),
      judge(
        'rui-fyi-not-a-task',
        "The assistant does not present Rui's FYI about Thursday's kickoff moving to 14:00 as something the user needs to act on. Mentioning it as an FYI with no action needed is fine, and leaving it out is fine.",
        { required: false },
      ),
      check(
        'gives-joana-deadline',
        (run) => /\btomorrow\b|\b10[:.]00\b|\b10 ?am\b/i.test(run.said),
        {
          required: false,
          failure: 'incomplete',
        },
      ),
    ];
  },
});
