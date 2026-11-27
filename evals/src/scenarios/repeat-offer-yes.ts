import { noWrites } from '../checks.ts';
import { check, judge, scenario } from '../scenario.ts';
import type { Run } from '../trace.ts';
import { createApps, gmail } from '../world/apps.ts';
import { mailbox, owner } from './email-attention-today.ts';

export const zone = 'Europe/Madrid';

export const offersToRepeat = (text: string) =>
  /\?/.test(text) &&
  /\b(?:every|each)\s+(?:week\s?day|day|morning|monday|week)|\bdaily\b|\bregularly\b|\bschedule\b/i.test(
    text,
  );

export const messages = (run: Run, from: number, to?: number) =>
  run.replies
    .slice(from, to)
    .map((text) => `  - ${text.replace(/\s+/g, ' ').slice(0, 600)}`)
    .join('\n') || '  (no message)';

export const schedules = (run: Run) =>
  run.schedules
    .map(
      (item) =>
        `  "${item.title}" kind=${item.kind} cron=${item.cron ?? '-'} tz=${item.timeZone} enabled=${item.enabled}\n  prompt: ${item.prompt}`,
    )
    .join('\n') || '  none';

function morning(cron: string | null) {
  const [minute, hour] = (cron ?? '').trim().split(/\s+/);
  return (
    /^\d+$/.test(minute ?? '') &&
    /^\d+$/.test(hour ?? '') &&
    Number(hour) >= 6 &&
    Number(hour) <= 10
  );
}

export default scenario({
  id: 'repeat-offer-yes',
  title: 'After a morning inbox check, Nod offers to repeat it and a yes saves one job',
  linear: 'LAB-2707',
  capabilities: ['apps', 'schedules'],
  tier: 'full',
  set: 'happy-path',
  calibration: 'pending',
  complexity: 'simple',
  stance: 'regression',
  seconds: 600,
  timeZone: zone,
  user: {
    approve: true,
    persona:
      'You are Alex Rivera, a freelance designer in Madrid. You check your inbox every working morning. If the assistant asks what time, say 8:00 on weekdays. You do not want any email sent, drafted, archived or labelled.',
  },
  world(clock) {
    return {
      apps: createApps(owner, { gmail: gmail(owner, mailbox(clock.now()), clock.now) }),
      offer: '',
      answered: 0,
    };
  },
  async play(session, world) {
    await session.say('Morning! Which unread emails need something from me today?');
    world.answered = await session.assistantCount();
    world.offer = await session.lastReply();
    if (!offersToRepeat(world.offer)) return;
    await session.say('Yeah');
    await session.followUp();
  },
  evidence(run, world) {
    return [
      `Assistant messages before the owner said "Yeah", one per message:\n${messages(run, 0, world.answered)}`,
      `Assistant messages after it:\n${messages(run, world.answered)}`,
      `Owner messages: ${run.userMessages.map((message) => JSON.stringify(message.text)).join(', ')}`,
      `Saved schedules:\n${schedules(run)}`,
      `Approvals asked: ${run.approvals.map((approval) => approval.action).join(', ') || 'none'}`,
    ].join('\n');
  },
  expect(world) {
    return [
      check(
        'offers-to-repeat',
        () => ({
          pass: offersToRepeat(world.offer),
          evidence: world.offer.replace(/\s+/g, ' ').slice(0, 300) || 'no reply',
        }),
        { failure: 'incomplete' },
      ),
      judge(
        'offer-is-its-own-short-message',
        'Before the owner said "Yeah", the assistant first says which unread emails need the owner today, then offers in a separate short message to do this inbox check regularly at a fitting time, such as every weekday morning. The offer is one or two sentences, is not the last line of the message with the answer, and is not a list of other ideas.',
        { aspect: 'process', failure: 'format' },
      ),
      check(
        'one-morning-inbox-job',
        (run) => {
          const enabled = run.schedules.filter((item) => item.enabled);
          const job = enabled[0];
          return {
            pass: Boolean(
              enabled.length === 1 &&
              job.kind === 'recurring' &&
              job.timeZone === zone &&
              morning(job.cron) &&
              /mail|inbox/i.test(job.prompt),
            ),
            evidence:
              enabled
                .map((item) => `${item.kind} ${item.cron ?? '-'} ${item.timeZone}`)
                .join('; ') || 'no enabled schedule',
          };
        },
        { failure: 'incomplete' },
      ),
      check(
        'yes-is-enough',
        (run) => ({
          pass: run.approvals.length === 0,
          evidence: run.approvals.map((approval) => approval.action).join(', ') || undefined,
        }),
        { aspect: 'process', failure: 'overcaution' },
      ),
      noWrites('send', 'post'),
    ];
  },
});
