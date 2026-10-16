import { noWrites } from '../checks.ts';
import { check, judge, scenario } from '../scenario.ts';
import { createApps, slack, type SlackMessage } from '../world/apps.ts';
import { hoursAgo, localTime } from '../world/time.ts';

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
const decision = "Final call: we're going with option B, the teal one. Sending to print Monday.";

const line = (user: string, at: number, text: string, replies?: SlackMessage[]): SlackMessage => ({
  user,
  at,
  text,
  ...(replies ? { replies } : {}),
});

export default scenario({
  id: 'slack-decision-lookup',
  title: 'What did we decide about the logo?',
  capabilities: ['apps'],
  tier: 'release',
  calibration: 'pending',
  complexity: 'medium',
  stance: 'regression',
  seconds: 600,
  user: {
    approve: (action) => /^SLACK_(?:AUTH|LIST|FETCH|SEARCH|FIND|DOWNLOAD)/.test(action),
    persona:
      'You are Alex Rivera, who runs a small design studio. The team has been discussing the new studio logo in #design on Slack over the last couple of days, and you missed the outcome. You only want to know what was decided; you do not want anything posted.',
  },
  world(clock) {
    const now = clock.now();
    const day = (back: number, hour: number, minute = 0) =>
      localTime(now, back, hour, 'Europe/Madrid', minute);
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
                  day(2, 10, 5),
                  'Logo round 2 is in the Brand file: option A is the coral wordmark, option B is the teal monogram. Gut reactions?',
                ),
                line('U0RUI', day(2, 10, 20), 'A for me, the coral feels warmer and more like us.'),
                line(
                  'U0PRIYA',
                  day(2, 10, 34),
                  '+1 for A. B reads a bit corporate at small sizes.',
                ),
                line(
                  'U0MARCO',
                  day(2, 11, 2),
                  'A! The wordmark is way more legible on the van mockup.',
                ),
                line(
                  'U0CARLA',
                  day(2, 12, 15),
                  'Can someone send me the van mockup for the quote?',
                ),
                line(
                  'U0SAM',
                  day(2, 14, 15),
                  "Leaning A too, but let's see what the client says tomorrow.",
                ),
                line('U0CARLA', day(2, 16, 40), 'Client review is booked for tomorrow at 11:00.'),
                line(
                  'U0JOANA',
                  day(1, 12, 10),
                  "Client feedback on the logo: they like A but worry the coral clashes with their packaging. Let's settle it here today.",
                  [
                    line('U0RUI', day(1, 12, 25), 'Could we try A in a darker coral?'),
                    line('U0JOANA', day(1, 12, 40), 'Tried it, it goes muddy on kraft paper.'),
                    line(
                      'U0PRIYA',
                      day(1, 13, 5),
                      'B on the kraft mockup looks really sharp, honestly.',
                    ),
                    line('U0MARCO', day(1, 13, 30), 'If packaging is the constraint, B wins.'),
                    line('U0JOANA', day(1, 15, 45), decision),
                  ],
                ),
                line('U0SAM', day(1, 16, 0), 'Updated the moodboard with the new packaging shots.'),
                line(
                  'U0RUI',
                  day(1, 17, 20),
                  'Honestly I still have a soft spot for option A, the coral wordmark was lovely 😅',
                ),
                line('U0PRIYA', hoursAgo(now, 3), 'Who has the Pantone swatch book?'),
                line('U0CARLA', hoursAgo(now, 1), 'Reminder: timesheets are due Friday.'),
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
              messages: [
                line('U0SAM', hoursAgo(now, 8), 'Board game night next Thursday, who is in?'),
              ],
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
              messages: [
                line('U0PRIYA', hoursAgo(now, 24), 'Standup notes are in the usual doc.'),
                line(
                  'U0JOANA',
                  hoursAgo(now, 20),
                  'Print shop confirmed they can take the logo files on Monday.',
                ),
              ],
            },
          ],
          clock.now,
        ),
      }),
    };
  },
  async play(session) {
    await session.say('What did we decide about the logo?');
  },
  evidence: () =>
    `In #design two days ago, Joana Ferreira (design lead) posted logo round 2: option A, the coral wordmark, and option B, the teal monogram. Rui, Priya, Marco and Sam all leaned towards A that day. Yesterday Joana shared client feedback (the coral clashes with the client's packaging) and opened a thread; in that thread the team moved to B and Joana closed it with: "${decision}" Later that evening Rui posted top-level that he still has a soft spot for option A; that is a personal comment, not a reversal. The decision is option B, the teal monogram, going to print on Monday.`,
  expect() {
    return [
      check(
        'answers-option-b-teal',
        (run) => {
          const text = run.said;
          const optionB = /\boption\s*b\b/i.test(text) || /\bB\b/.test(text);
          const teal = /\bteal\b/i.test(text);
          return {
            pass: optionB || teal,
            evidence: `${optionB ? '' : 'option B not named; '}${teal ? '' : 'teal not named'}`,
          };
        },
        {
          otherwise:
            'The assistant answers that the team decided on option B, the teal monogram, in any wording.',
        },
      ),
      noWrites('post', 'send', 'create', 'update', 'delete'),
      judge(
        'does-not-present-option-a-as-decided',
        "The assistant does not present option A (the coral wordmark) as the decision or as still being the team's choice. Saying that the team first leaned towards A, or that Rui still likes A, is fine as long as option B (teal) is clearly given as the final decision. Fails if the answer says A was chosen, or presents the outcome as undecided or split.",
      ),
      check('mentions-print-monday', (run) => /\bmonday\b|\bprint/i.test(run.said), {
        required: false,
        failure: 'incomplete',
      }),
    ];
  },
});
