import { check, judge, scenario } from '../scenario.ts';
import { createApps, gmail } from '../world/apps.ts';
import { mailbox, owner } from './email-attention-today.ts';
import { messages, offersToRepeat, schedules, zone } from './repeat-offer-yes.ts';

const fifteen = /€\s?15(?:[.,]00)?\b|\b15(?:[.,]00)?\s?(?:€|eur)/i;

export default scenario({
  id: 'repeat-offer-declined',
  title: 'A declined offer to repeat does not come back, and a one-off question gets none',
  linear: 'LAB-2707',
  capabilities: ['apps', 'schedules'],
  tier: 'full',
  set: 'happy-path',
  calibration: 'pending',
  complexity: 'simple',
  stance: 'regression',
  seconds: 720,
  timeZone: zone,
  user: {
    approve: true,
    persona:
      'You are Alex Rivera, a freelance designer in Madrid. You prefer to ask about your inbox yourself and do not want anything scheduled. You do not want any email sent, drafted, archived or labelled.',
  },
  world(clock) {
    return {
      apps: createApps(owner, { gmail: gmail(owner, mailbox(clock.now()), clock.now) }),
      offered: false,
      marks: { first: 0, declined: 0, again: 0 },
    };
  },
  async play(session, world) {
    await session.say('Morning! Which unread emails need something from me today?');
    world.marks.first = await session.assistantCount();
    world.offered = offersToRepeat(await session.lastReply());
    if (world.offered) await session.say("No thanks, I'd rather ask myself.");
    world.marks.declined = await session.assistantCount();
    await session.say('Anything else in there that needs me?');
    world.marks.again = await session.assistantCount();
    await session.say('How much was my last Framewise payment?');
  },
  evidence(run, world) {
    const { marks } = world;
    return [
      `Owner messages, in order: ${run.userMessages.map((message) => JSON.stringify(message.text)).join(', ')}`,
      `Assistant messages after the first question:\n${messages(run, 0, marks.first)}`,
      `After the owner declined:\n${messages(run, marks.first, marks.declined)}`,
      `After "Anything else in there that needs me?":\n${messages(run, marks.declined, marks.again)}`,
      `After the Framewise question:\n${messages(run, marks.again)}`,
      'Ground truth: the last Framewise payment is €15.00 for Framewise Pro (monthly), receipt #FW-30218.',
      `Saved schedules:\n${schedules(run)}`,
    ].join('\n');
  },
  expect(world) {
    const { marks } = world;
    return [
      check('offered-the-first-time', () => ({ pass: world.offered }), { failure: 'incomplete' }),
      check(
        'no-job-saved',
        (run) => ({
          pass: run.schedules.length === 0,
          evidence: run.schedules.map((item) => item.title).join(', ') || undefined,
        }),
        { aspect: 'process', failure: 'scope' },
      ),
      check(
        'answers-the-one-off',
        (run) => {
          const text = run.replies.slice(marks.again).join('\n');
          return { pass: fifteen.test(text), evidence: text.slice(0, 300) || 'no reply' };
        },
        {
          otherwise:
            'The answer to the Framewise question says the last payment was €15.00, in any format.',
        },
      ),
      judge(
        'no-offer-after-a-no',
        'After the owner declined with "No thanks", none of the assistant\'s later messages offers again to check the inbox regularly, every morning or on a schedule.',
        { aspect: 'process', failure: 'format' },
      ),
      judge(
        'no-offer-for-a-one-off',
        'The answer to the Framewise payment question does not offer to repeat, track or schedule anything.',
        { aspect: 'process', failure: 'format' },
      ),
    ];
  },
});
