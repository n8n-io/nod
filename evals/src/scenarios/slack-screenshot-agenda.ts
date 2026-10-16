import { setTimeout as sleep } from 'node:timers/promises';
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
                  text: "Tomorrow's offsite is on, 10:00 to 13:00. Agenda to follow here.",
                },
              ],
            },
          ],
          clock.now,
        ),
      }),
      now: clock.now,
      marks: { setup: 0, run: 0 },
    };
  },
  async play(session, world) {
    const due = Math.ceil((world.now() + 180_000) / 60_000) * 60_000;
    const at = new Intl.DateTimeFormat('en-GB', {
      timeZone: 'Europe/Madrid',
      hour: '2-digit',
      minute: '2-digit',
    }).format(due);
    const posted = sleep(Math.max(0, due - 60_000 - Date.now())).then(() =>
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
      }),
    );
    await session.say(
      `Claudia is about to post tomorrow's offsite agenda in #leadership. At ${at}, check the channel and send me the agenda so I can prepare. Don't post anything in Slack.`,
    );
    world.marks.setup = await session.assistantCount();
    await posted;
    await sleep(Math.max(0, due - Date.now()));
    await session.fireSchedules();
    await session.settle();
    world.marks.run = await session.assistantCount();
  },
  evidence(run, world) {
    return [
      `Agenda screenshot: ${topics.join('; ')}. Open items screenshot: ${openItems.join('; ')}. The message text names neither.`,
      `Scheduled runs started: ${run.scheduleRuns.length}.`,
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
      check('scheduled-run-fired', (run) => run.scheduleRuns.length > 0, { aspect: 'process' }),
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
      check('delivers-agenda-topics', mentions(['quokka', 'harbor', 'hiring']), {
        otherwise:
          'The message from the scheduled run gives the three agenda topics from the screenshot, Quokka pricing reset, Harbor expansion 2027 and Studio hiring plan, in any wording.',
      }),
      check('delivers-open-items', mentions(['vendor', 'retainer']), {
        otherwise:
          'The message from the scheduled run gives the two open items from the second screenshot, vendor consolidation and the retainer minimum, in any wording.',
      }),
      noWrites('post', 'send'),
    ];
  },
});
