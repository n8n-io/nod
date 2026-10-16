import { setTimeout as sleep } from 'node:timers/promises';
import { check, scenario } from '../scenario.ts';
import type { Run } from '../trace.ts';
import { createApps } from '../world/apps.ts';

const owner = { name: 'Alex Rivera', email: 'alex.rivera@riveradesign.example' };
const mum = /\b(mum|mom|mother|mam|mummy|mommy)\b/i;

function scheduledMessages(run: Run) {
  const turns = new Set(
    run.turns.filter((turn) => turn.source === 'schedule').map((turn) => turn.id),
  );
  return run.messages.filter(
    (message) =>
      message.role === 'assistant' &&
      message.turnId !== null &&
      turns.has(message.turnId) &&
      message.text.trim(),
  );
}

const clock = (at: number) =>
  new Intl.DateTimeFormat('en-GB', {
    timeZone: 'Europe/Madrid',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  }).format(at);

export default scenario({
  id: 'remind-in-minutes',
  title: 'Remind me in 4 minutes to call my mum',
  capabilities: ['schedules', 'long-running'],
  tier: 'release',
  calibration: 'pending',
  complexity: 'medium',
  stance: 'regression',
  seconds: 600,
  user: {
    approve: true,
    persona:
      'You are Alex Rivera. You want one reminder here in this chat, 4 minutes from when you asked, telling you to call your mum. Nothing else.',
  },
  world() {
    return {
      apps: createApps(owner, {}),
      state: { sentAt: 0, due: 0, setup: 0, fired: 0, after: 0, runs: 0 },
    };
  },
  async play(session, world) {
    const { state } = world;
    state.sentAt = Date.now();
    await session.say('Remind me in 4 minutes to call my mum.');
    state.setup = await session.assistantCount();
    const listed = await session.api('GET', '/api/schedules');
    const due = (Array.isArray(listed.body) ? listed.body : [])
      .filter((item: any) => item.enabled && item.kind === 'once' && item.runAt)
      .map((item: any) => Date.parse(item.runAt))
      .filter((value: number) => Number.isFinite(value));
    if (!due.length) return;
    state.due = Math.min(...due);
    await sleep(Math.max(0, Math.min(state.due, state.sentAt + 400_000) + 5_000 - Date.now()));
    state.fired = await session.fireSchedules();
    const until = Date.now() + 120_000;
    while (Date.now() < until) {
      const runs = (await session.api('GET', '/api/schedule-runs')).body?.runs ?? [];
      if (
        runs.length &&
        runs.every((item: any) => item.status !== 'queued' && item.status !== 'running')
      ) {
        state.runs = runs.length;
        break;
      }
      await sleep(1_000);
    }
    await session.settle();
    state.after = await session.assistantCount();
  },
  evidence(run, world) {
    const { state } = world;
    return [
      `The user asked at ${clock(state.sentAt)} Europe/Madrid, so the reminder was due at about ${clock(state.sentAt + 240_000)}. The harness waited until the saved time had passed (${state.due ? clock(state.due) : 'no one-off schedule was saved'}) and then let the scheduled run happen.`,
      `Saved schedules:\n${run.schedules.map((item) => `  "${item.title}" kind=${item.kind} runAt=${item.runAt ? clock(item.runAt) : '-'} cron=${item.cron ?? '-'} tz=${item.timeZone} enabled=${item.enabled}\n  prompt: ${item.prompt}`).join('\n') || '  none'}`,
      `Scheduled runs: ${run.scheduleRuns.length}.`,
      `Messages from the scheduled run:\n${
        scheduledMessages(run)
          .map((message) => `  - [${clock(message.at)}] ${message.text.replace(/\s+/g, ' ')}`)
          .join('\n') || '  (none)'
      }`,
    ].join('\n');
  },
  expect(world) {
    const { state } = world;
    return [
      check('one-off-reminder-about-four-minutes-out', (run) => {
        const fits = run.schedules.filter(
          (item) =>
            item.kind === 'once' &&
            item.runAt !== null &&
            item.runAt >= state.sentAt + 180_000 &&
            item.runAt <= state.sentAt + 360_000,
        );
        return {
          pass: fits.length >= 1,
          evidence:
            run.schedules
              .map(
                (item) =>
                  `${item.kind} ${item.runAt ? `${Math.round((item.runAt - state.sentAt) / 1000)}s after the request` : item.cron}`,
              )
              .join('; ') || 'no schedule',
        };
      }),
      check(
        'scheduled-run-happened',
        (run) => ({
          pass: run.scheduleRuns.length >= 1,
          evidence: `${run.scheduleRuns.length} scheduled runs`,
        }),
        { aspect: 'process' },
      ),
      check(
        'reminder-delivered-when-due',
        (run) => {
          const messages = scheduledMessages(run);
          const hit = messages.find((message) => mum.test(message.text));
          return {
            pass: Boolean(hit),
            evidence: hit
              ? undefined
              : messages[0]?.text.slice(0, 200) || 'the scheduled run sent no message',
          };
        },
        {
          otherwise:
            'A message from the scheduled reminder run reminds the user to call their mum, in any wording.',
        },
      ),
      check(
        'only-one-reminder-saved',
        (run) => ({
          pass: run.schedules.length === 1 && run.schedules[0].kind === 'once',
          evidence: `${run.schedules.length} schedules`,
        }),
        { required: false, aspect: 'process', failure: 'scope' },
      ),
    ];
  },
});
