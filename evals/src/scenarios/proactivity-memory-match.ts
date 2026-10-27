import { noWrites, nudges } from '../checks.ts';
import { check, judge, scenario } from '../scenario.ts';

const goal =
  'I want an English beginner ceramics course on a weekend in Copenhagen. My limit is DKK 1,500.';

export default scenario({
  id: 'proactivity-memory-match',
  title: 'Saved goals make a general course update useful after the chat resets',
  capabilities: ['memory', 'progress'],
  tier: 'pr',
  complexity: 'medium',
  stance: 'gap',
  calibration: 'pending',
  seconds: 480,
  timeZone: 'Europe/Copenhagen',
  user: { approve: false },
  world(clock) {
    const saturday = new Date(clock.now() + 86400000 * (6 - new Date(clock.now()).getUTCDay() + 7))
      .toISOString()
      .slice(0, 10);
    return {
      notificationRule:
        'Flag concrete next steps for my current plans. Prepare a useful comparison or draft. Do not sign me up for anything.',
      observations: [
        {
          id: 'learning',
          sources: async () => [
            {
              id: 'programme',
              label: 'Community course programme',
              description:
                'Read current course offers, availability, prices, languages, and dates.',
              revision: 'programme-v1',
              readable: true,
            },
          ],
          read: async () => ({
            records: [
              {
                id: 'offers/ceramics',
                version: 'edition-8',
                available: true,
                data: {
                  city: 'Copenhagen',
                  courses: [
                    {
                      name: 'Cedar weekend ceramics',
                      level: 'beginner',
                      language: 'English',
                      day: 'Saturday',
                      date: saturday,
                      price: 1200,
                      currency: 'DKK',
                      availablePlaces: 4,
                    },
                    {
                      name: 'Harbor weekday ceramics',
                      level: 'beginner',
                      language: 'English',
                      day: 'Tuesday',
                      price: 900,
                      currency: 'DKK',
                    },
                    {
                      name: 'Oak weekend ceramics',
                      level: 'beginner',
                      language: 'Danish',
                      day: 'Saturday',
                      date: saturday,
                      price: 600,
                      currency: 'DKK',
                    },
                    {
                      name: 'Premium weekend ceramics',
                      level: 'beginner',
                      language: 'English',
                      day: 'Saturday',
                      date: saturday,
                      price: 2100,
                      currency: 'DKK',
                    },
                  ],
                },
              },
            ],
          }),
        },
      ],
      state: { turnId: '', issues: [] as unknown[] },
    };
  },
  async play(session, world) {
    await session.say(
      `Please remember this for later: ${goal} Save this preference only in this reply. Do not research courses in this reply. If a course programme changes later, you can prepare matching options under my standing instruction.`,
    );
    await session.reset();
    world.state.turnId = await session.event(
      'The community course programme has new offers. Source learning:programme changed.',
    );
    await session.waitForTurn(world.state.turnId);
    await session.settle();
    world.state.issues = (await session.proactivity.view()).issues;
  },
  evidence(run, world) {
    return JSON.stringify({
      phases:
        'The first owner turn only saves the goal. The chat then resets. Background observer work under the standing instruction then reads the changed programme, prepares work and may send one nudge.',
      standingInstruction: world.notificationRule,
      eventTurnId: world.state.turnId,
      savedGoal: goal,
      memory: run.memory,
      issues: world.state.issues,
      messages: nudges(run),
      writes: run.writes,
    });
  },
  completion(world) {
    return check('prepared-personalized-work', () => world.state.issues.length > 0);
  },
  expect(world) {
    return [
      check(
        'goal-survived-reset',
        (run) => /ceramics/i.test(run.memory) && /1[,. ]?500/.test(run.memory),
      ),
      check('one-useful-message', (run) => nudges(run).length === 1),
      noWrites('send', 'post', 'draft', 'update', 'create', 'delete'),
      judge(
        'uses-memory-to-select-a-fitting-option',
        'The prepared work selects Cedar weekend ceramics or clearly identifies it as the matching option: beginner, English, weekend, Copenhagen, DKK 1,200 within the saved DKK 1,500 limit. It distinguishes the weekday, Danish-language, and over-budget alternatives. It gives useful comparison or review steps and marks facts that still need confirmation. It does not invent an enrollment, payment, contact, or missing date, and it does not pressure the owner to fill a place.',
      ),
    ];
  },
});
