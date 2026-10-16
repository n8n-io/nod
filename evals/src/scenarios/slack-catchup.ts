import { calendar, createApps, slack } from '../world/apps.ts';
import { asksAtMost, noWrites } from '../checks.ts';
import { check, judge, scenario } from '../scenario.ts';
import { dayLabel, inDays, localTime } from '../world/time.ts';

const owner = { name: 'Alex Rivera', email: 'alex.rivera@riveradesign.example' };

export default scenario({
  id: 'slack-catchup',
  title: 'Slack catch-up: what did I miss and what needs my reply',
  linear: 'LAB-376',
  capabilities: ['apps', 'progress'],
  tier: 'pr',
  complexity: 'simple',
  stance: 'regression',
  seconds: 420,
  user: {},
  world(clock) {
    const now = clock.now();
    const cutoff = localTime(now, 1, 18);
    const before = (hours: number) => cutoff - hours * 3_600_000;
    const after = (fraction: number) => cutoff + (now - cutoff) * fraction;
    const me = { id: 'U01ALEX', ...owner };
    const people = [
      { id: 'U02PRIYA', name: 'Priya Nair' },
      { id: 'U03MARCUS', name: 'Marcus Webb' },
      { id: 'U04ELENA', name: 'Elena Costa' },
    ];
    const apps = createApps(owner, {
      slack: slack(
        me,
        people,
        [
          {
            name: 'product',
            kind: 'channel',
            messages: [
              {
                user: 'U04ELENA',
                at: before(20),
                text: '@Alex can you send the pricing deck to finance? They need it before the board call.',
              },
              {
                user: 'U02PRIYA',
                at: after(0.2),
                text: `Heads up: we are moving the launch review to ${dayLabel(inDays(now, 3))} at 11:00.`,
              },
              {
                user: 'U03MARCUS',
                at: after(0.35),
                text: 'Beta feedback is in. 14 of 20 testers finished onboarding, the rest dropped at the calendar step.',
              },
              {
                user: 'U02PRIYA',
                at: after(0.45),
                text: `@Alex can you confirm the launch date for the press note by end of day ${dayLabel(inDays(now, 1))}?`,
                replies: [
                  {
                    user: 'U03MARCUS',
                    at: after(0.5),
                    text: 'Marketing is waiting on this one too.',
                  },
                ],
              },
              {
                user: 'U04ELENA',
                at: after(0.52),
                text: '@Alex can you confirm that the beta export is approved for the launch?',
                replies: [
                  {
                    user: me.id,
                    at: after(0.56),
                    text: 'Yes, approved. Please use this version for the launch.',
                  },
                ],
              },
              {
                user: 'U04ELENA',
                at: after(0.6),
                text: 'Marcus, did you get the beta export from the analytics team?',
              },
              {
                user: 'U03MARCUS',
                at: after(0.65),
                text: 'Yes, got it, thanks.',
              },
              {
                user: 'U02PRIYA',
                at: after(0.75),
                text: 'Thanks all. Retro notes are in the shared doc if you want to add anything.',
              },
            ],
          },
          {
            name: 'random',
            kind: 'channel',
            messages: [
              { user: 'U04ELENA', at: after(0.55), text: 'Anyone want to join a walk at 15:00?' },
            ],
          },
          {
            name: 'Marcus Webb',
            kind: 'dm',
            with: 'U03MARCUS',
            messages: [
              {
                user: 'U03MARCUS',
                at: before(30),
                text: 'Welcome back! Let me know when you have a minute to sync.',
              },
              {
                user: 'U03MARCUS',
                at: after(0.4),
                text: `Could you review the onboarding copy in the beta doc by ${dayLabel(inDays(now, 2))}? I would like your edits on the calendar step.`,
              },
            ],
          },
          {
            name: 'Elena Costa',
            kind: 'dm',
            with: 'U04ELENA',
            messages: [
              {
                user: 'U04ELENA',
                at: after(0.8),
                text: 'Thanks for covering the standup yesterday, much appreciated.',
              },
            ],
          },
        ],
        clock.now,
      ),
      calendar: calendar(owner, [], 'Europe/Madrid'),
    });
    return {
      apps,
      dates: {
        review: dayLabel(inDays(now, 3)),
        launch: dayLabel(inDays(now, 1)),
        copy: dayLabel(inDays(now, 2)),
      },
    };
  },
  async play(session) {
    await session.say(
      'Summarise what I missed in #product and my DMs since yesterday 18:00. What needs a reply from me?',
    );
  },
  expect(world) {
    return [
      check(
        'read-both-sources',
        (run) => {
          const text = JSON.stringify(run.apps?.calls.map((call) => call.slug));
          return text.includes('FETCH_CONVERSATION_HISTORY') || text.includes('SEARCH_MESSAGES');
        },
        { aspect: 'process', failure: 'tool' },
      ),
      judge(
        'names-both-replies-needed',
        'Across the messages the user saw, the assistant tells them that two people are waiting for their reply: Priya Nair, who asked them to confirm the launch date for the press note, and Marcus Webb, who asked them to review the onboarding copy in the beta doc. Names may be given in full or by first name, and any wording, order or format (prose, list, table) is fine. Missing either request fails.',
        { failure: 'reasoning' },
      ),
      noWrites('post', 'send', 'create', 'update', 'delete'),
      judge(
        'summarises-the-updates',
        `Across the messages the user saw, the assistant summarises what happened since yesterday 18:00 and not only the reply requests: the launch review moving to ${world.dates.review} at 11:00, and the beta onboarding result (14 of 20 testers finished, the rest dropped at the calendar step), in any wording. Stating the drop-off as 6 of 20 is equivalent, a paraphrase without the figures (most testers finished, the rest dropped at the calendar step) passes, and any figure it gives must match.`,
      ),
      judge(
        'replies-needed-are-exactly-right',
        `The assistant identifies exactly two items that need the user's reply. Priya needs the launch date for the press note confirmed by end of day ${world.dates.launch}. Marcus needs the onboarding copy reviewed by ${world.dates.copy}. The older pricing-deck request was posted before the cutoff. The user already approved Elena's beta export request in its thread. The export delivery question was answered, and Elena's thanks need no reply. The assistant must not list these four items as needing the user's reply. It can mention the pricing-deck request separately if it clearly states that the request is older than the window. Each stated deadline must match the source message.`,
        { failure: 'reasoning' },
      ),
      judge(
        'brief-and-skimmable',
        'The answer is short and easy to skim on a phone: no long preamble, no restating the question, and no raw tool or access narration such as which API was queried.',
        { aspect: 'process', failure: 'format', required: false },
      ),
      asksAtMost(0),
    ];
  },
});
