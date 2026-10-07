import { noWrites } from '../checks.ts';
import { check, scenario } from '../scenario.ts';
import type { Run } from '../trace.ts';
import { createApps, slack } from '../world/apps.ts';
import { textPng } from '../world/png.ts';
import { hoursAgo } from '../world/time.ts';

const owner = { name: 'Alex Rivera', email: 'alex.rivera@riveradesign.example' };
const topics = ['Quokka pricing reset', 'Harbor expansion 2027', 'Studio hiring plan'];
const openItems = ['Vendor consolidation', 'Retainer minimum: 3k?'];

export default scenario({
  id: 'slack-screenshot-agenda',
  title: 'A scheduled check reads the agenda that only exists in Slack screenshots',
  linear: 'LAB-477',
  capabilities: ['schedules', 'apps', 'files'],
  tier: 'full',
  complexity: 'medium',
  stance: 'regression',
  seconds: 600,
  calibration: 'pending',
  user: {
    approve: true,
    persona: 'You are Alex Rivera, who runs a small design studio. You answer briefly.',
  },
  world(clock) {
    const now = clock.now();
    const me = { id: 'U01ALEX', ...owner };
    const people = [
      { id: 'U05CLAUDIA', name: 'Claudia Brandt' },
      { id: 'U03MARCUS', name: 'Marcus Webb' },
    ];
    return {
      apps: createApps(owner, {
        slack: slack(
          me,
          people,
          [
            {
              name: 'leadership',
              kind: 'channel',
              messages: [
                {
                  user: 'U05CLAUDIA',
                  at: hoursAgo(now, 3),
                  text: "Tomorrow's offsite is on, 10:00 to 13:00. I'll post the agenda here tonight.",
                },
              ],
            },
          ],
          clock.now,
        ),
      }),
      now: clock.now,
      marks: { setup: 0, fired: 0, run: 0 },
    };
  },
  async play(session, world) {
    await session.say(
      "Claudia will post tomorrow's offsite agenda in #leadership tonight. Tomorrow at 7:30, check the channel and send me the agenda so I can prepare. Don't post anything in Slack.",
    );
    world.marks.setup = await session.assistantCount();
    world.apps.slack!.post('leadership', {
      user: 'U05CLAUDIA',
      at: world.now(),
      text: 'Hi team, agenda for tomorrow: these three topic cards. For the first topic, please focus on the open items in the second screenshot. Happy to refine in the room.',
      files: [
        {
          name: 'Screenshot agenda.png',
          mimeType: 'image/png',
          bytes: textPng([
            'Offsite agenda',
            ...topics.map((topic, index) => `${index + 1}. ${topic}`),
          ]),
        },
        {
          name: 'Screenshot open items.png',
          mimeType: 'image/png',
          bytes: textPng(['Open items', ...openItems.map((item) => `- ${item}`)]),
        },
      ],
    });
    world.marks.fired = await session.fireSchedules();
    world.marks.run = await session.assistantCount();
  },
  evidence(run, world) {
    return [
      `Agenda screenshot: ${topics.join('; ')}. Open items screenshot: ${openItems.join('; ')}. The message text names neither.`,
      `Scheduled runs started: ${world.marks.fired}.`,
      `Messages from the scheduled run:\n${run.replies.slice(world.marks.setup, world.marks.run).join('\n') || '(none)'}`,
    ].join('\n');
  },
  expect(world) {
    const delivered = (run: Run) =>
      run.replies.slice(world.marks.setup, world.marks.run).join('\n').toLowerCase();
    const mentions = (words: string[]) => (run: Run) => {
      const text = delivered(run);
      const missing = words.filter((word) => !text.includes(word));
      return { pass: !missing.length, evidence: missing.length ? `missing ${missing}` : undefined };
    };
    return [
      check('scheduled-run-fired', () => world.marks.fired > 0, { aspect: 'process' }),
      check(
        'opened-both-screenshots',
        (run) => {
          const ids = world.apps
            .slack!.conversations.flatMap((conversation) => conversation.messages)
            .flatMap((message) => message.files ?? [])
            .map((file) => file.id);
          const opened = new Set(
            (run.apps?.calls ?? [])
              .filter((call) => call.slug === 'SLACK_DOWNLOAD_SLACK_FILE' && !call.error)
              .map((call) => call.args.file),
          );
          return {
            pass: ids.length === 2 && ids.every((id) => opened.has(id)),
            evidence: `opened ${[...opened].join(', ') || 'none'} of ${ids.join(', ')}`,
          };
        },
        { aspect: 'process', failure: 'tool' },
      ),
      check('delivers-agenda-topics', mentions(['quokka', 'harbor', 'hiring'])),
      check('delivers-open-items', mentions(['vendor', 'retainer'])),
      noWrites('post', 'send'),
    ];
  },
});
