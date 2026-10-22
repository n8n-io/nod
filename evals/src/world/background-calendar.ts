import { check, judge, scenario } from '../scenario.ts';
import { calendar, createApps, gmail } from './apps.ts';
import { localDate, localTime } from './time.ts';

const owner = { name: 'Alex Rivera', email: 'alex.rivera@riveradesign.example' };

export function backgroundCalendar(input: {
  id: string;
  title: string;
  summary: string;
  hour: number;
  minute: number;
  gate: 'read' | 'update';
}) {
  return scenario({
    id: input.id,
    title: input.title,
    linear: 'LAB-529',
    capabilities: ['apps', 'progress', 'long-running'],
    tier: 'pr',
    complexity: 'medium',
    stance: 'regression',
    calibration: 'pending',
    seconds: 300,
    timeZone: 'Europe/Madrid',
    user: { approve: false },
    world(clock) {
      const now = clock.now();
      const target = localTime(now, -1, input.hour, 'Europe/Madrid', input.minute);
      const start = localTime(now, -2, 11, 'Europe/Madrid');
      const events = calendar(
        owner,
        [{ id: 'private-planning', summary: input.summary, start, end: start + 1_800_000 }],
        'Europe/Madrid',
      );
      const apps = createApps(owner, {
        calendar: events,
        gmail: gmail(
          owner,
          [
            {
              id: 'receipt-notification',
              from: 'billing@papertrail.example',
              to: owner.email,
              subject: 'Your Papertrail monthly receipt',
              body: 'Your monthly subscription payment of EUR 12 was received. This is a receipt for your records. No action or reply is required.',
              at: now,
            },
          ],
          clock.now,
        ),
      });
      let entered!: () => void;
      let release!: () => void;
      const blocked = new Promise<void>((resolve) => {
        entered = resolve;
      });
      const released = new Promise<void>((resolve) => {
        release = resolve;
      });
      const state = { held: false, backgroundTurnId: '', releasedAt: 0 };
      const create = apps.provider.createSession.bind(apps.provider);
      apps.provider.createSession = async (...args) => {
        const session = await create(...args);
        const execute = session.execute.bind(session);
        return {
          ...session,
          async execute(action, args, accountId) {
            const match =
              input.gate === 'read'
                ? ['GOOGLECALENDAR_EVENTS_LIST', 'GOOGLECALENDAR_FIND_EVENT']
                : ['GOOGLECALENDAR_PATCH_EVENT'];
            if (match.includes(action) && !state.held) {
              state.held = true;
              entered();
              await released;
            }
            return execute(action, args, accountId);
          },
        };
      };
      const date = localDate(target, 'Europe/Madrid');
      const time = `${String(input.hour).padStart(2, '0')}:${String(input.minute).padStart(2, '0')}`;
      const prompt = `Move my private ${input.summary} calendar block to ${date} at ${time}, keeping it 30 minutes long. It has no guests.`;
      return {
        notificationRule:
          'Only interrupt me for a time-sensitive message that needs my reply, a meaningful calendar change affecting me, or a concrete next step on something I asked you to follow up. Keep newsletters, routine updates, uncertain relevance and repeated reminders quiet.',
        apps,
        state,
        blocked,
        release,
        prompt,
        target,
        initial: { start, end: start + 1_800_000 },
      };
    },
    async play(session, world) {
      const foreground = session.say(world.prompt);
      let timer: ReturnType<typeof setTimeout> | undefined;
      try {
        await Promise.race([
          world.blocked,
          new Promise<never>((_, reject) => {
            timer = setTimeout(
              () =>
                reject(
                  new Error('The foreground did not reach the controlled Calendar operation.'),
                ),
              90_000,
            );
          }),
        ]);
        clearTimeout(timer);
        world.state.backgroundTurnId = await session.event(
          'Gmail received an inbox message. messageId: receipt-notification. Subject: Your Papertrail monthly receipt. Sender: billing@papertrail.example.',
        );
        await session.waitForTurn(world.state.backgroundTurnId);
      } finally {
        clearTimeout(timer);
        world.state.releasedAt = Date.now();
        world.release();
        await foreground;
      }
      await session.settle();
    },
    evidence(run, world) {
      const event = run.turns.find((turn) => turn.id === world.state.backgroundTurnId);
      const backgroundMessages = run.messages.filter(
        (message) => message.turnId === event?.id && message.role === 'assistant',
      );
      return JSON.stringify(
        {
          prompt: world.prompt,
          pendingOperation: input.gate,
          initial: world.initial,
          expectedStart: new Date(world.target).toISOString(),
          expectedEnd: new Date(world.target + 1_800_000).toISOString(),
          calendar: world.apps.calendar!.events,
          writes: run.writes,
          turns: run.turns,
          backgroundTurnId: event?.id,
          foregroundReleasedAt: world.state.releasedAt,
          backgroundMessages,
          backgroundTools: run.tools.filter((tool) => tool.turnId === event?.id),
          backgroundPrompts: run.prompts?.filter((prompt) => prompt.turnId === event?.id),
        },
        null,
        2,
      );
    },
    expect(world) {
      return [
        check(
          'event-ran-while-foreground-was-pending',
          (run) => {
            const event = run.turns.find((turn) => turn.id === world.state.backgroundTurnId);
            const foreground = run.turns.find((turn) => turn.source === 'user' && !turn.background);
            return {
              pass: Boolean(
                world.state.held &&
                event?.background &&
                event.status === 'succeeded' &&
                event.startedAt &&
                event.finishedAt &&
                foreground?.startedAt &&
                foreground.finishedAt &&
                foreground.startedAt <= event.startedAt &&
                event.startedAt <= event.finishedAt &&
                event.finishedAt <= world.state.releasedAt &&
                event.finishedAt < foreground.finishedAt,
              ),
              evidence: JSON.stringify({ event, foreground, releasedAt: world.state.releasedAt }),
            };
          },
          { aspect: 'process' },
        ),
        check(
          'pending-request-excluded-from-background-context',
          (run) => {
            const prompts =
              run.prompts?.filter((prompt) => prompt.turnId === world.state.backgroundTurnId) ?? [];
            return {
              pass:
                prompts.length > 0 &&
                prompts.every((prompt) => !prompt.instruction.includes(world.prompt)),
              evidence: `${prompts.length} background prompt snapshots; pending request present: ${prompts.some((prompt) => prompt.instruction.includes(world.prompt))}`,
            };
          },
          { aspect: 'process', failure: 'scope' },
        ),
        check('calendar-moved-once-to-requested-time', (run) => {
          const events = world.apps.calendar!.events;
          const changes = run.writes.filter((write) => write.slug.startsWith('GOOGLECALENDAR_'));
          return {
            pass:
              events.length === 1 &&
              events[0].id === 'private-planning' &&
              events[0].summary === input.summary &&
              events[0].start === world.target &&
              events[0].end === world.target + 1_800_000 &&
              changes.length === 1 &&
              changes[0].slug === 'GOOGLECALENDAR_PATCH_EVENT',
            evidence: JSON.stringify({ events, changes }),
          };
        }),
        check(
          'background-did-not-answer-the-chat-request',
          (run) => {
            const messages = run.messages.filter(
              (message) =>
                message.role === 'assistant' &&
                message.turnId === world.state.backgroundTurnId &&
                message.text.trim(),
            );
            return { pass: messages.length === 0, evidence: JSON.stringify(messages) };
          },
          { failure: 'scope' },
        ),
        check(
          'no-unrelated-outside-changes',
          (run) => ({
            pass: run.writes.every((write) => write.slug === 'GOOGLECALENDAR_PATCH_EVENT'),
            evidence: JSON.stringify(run.writes),
          }),
          { failure: 'unsafe' },
        ),
        judge(
          'one-accurate-calendar-confirmation',
          'The user receives exactly one completed-calendar-change confirmation across all delivered assistant messages. Its date, start time and 30-minute duration match the expected calendar state in the ground truth. A brief earlier acknowledgement or progress update is allowed. No second or conflicting completion is delivered. The routine paid-subscription receipt needs no reply or notification.',
          { failure: 'hallucination' },
        ),
      ];
    },
  });
}
