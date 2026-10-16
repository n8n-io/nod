import { check, scenario } from '../scenario.ts';
import type { Run } from '../trace.ts';
import { createApps, gmail, type Mail } from '../world/apps.ts';
import { daysAgo } from '../world/time.ts';

const owner = { name: 'Alex Rivera', email: 'alex.rivera@riveradesign.example' };
const receipt = 'figma-receipt';

function mailbox(now: number): Mail[] {
  return [
    {
      id: receipt,
      from: 'Figma <billing@figma.com>',
      to: owner.email,
      subject: 'Your Figma receipt',
      body: 'Thanks for your payment of €15.00 for Figma Professional (monthly). Receipt #2291-4471.',
      at: now - 20 * 3_600_000,
    },
    {
      id: 'figma-receipt-last-month',
      from: 'Figma <billing@figma.com>',
      to: owner.email,
      subject: 'Your Figma receipt',
      body: 'Thanks for your payment of €15.00 for Figma Professional (monthly). Receipt #2291-3980.',
      at: daysAgo(now, 31),
      labels: [],
    },
    {
      id: 'figma-comment',
      from: 'Figma <no-reply@figma.com>',
      to: owner.email,
      subject: 'Lena commented on "Meridian brand kit"',
      body: 'Lena: "Can we try the wordmark a touch heavier?"',
      at: now - 5 * 3_600_000,
      labels: ['INBOX', 'UNREAD'],
    },
    {
      id: 'notion-receipt',
      from: 'Notion <billing@notion.so>',
      to: owner.email,
      subject: 'Your Notion receipt',
      body: 'Thanks for your payment of €10.00 for Notion Plus (monthly).',
      at: daysAgo(now, 2),
    },
    {
      id: 'quote',
      threadId: 'thread-quote',
      from: 'Ines Carvalho <ines@casavelha.example.org>',
      to: owner.email,
      subject: 'Quote request: restaurant menu redesign',
      body: 'Hello Alex, could you send me a quote for redesigning our menus?',
      at: daysAgo(now, 1),
      labels: ['INBOX', 'UNREAD'],
    },
    {
      id: 'newsletter',
      from: 'Design Weekly <hello@designweekly.example.net>',
      to: owner.email,
      subject: 'Design Weekly #214: quiet interfaces',
      body: 'This week: ten quiet interface patterns and a long read on pricing creative work.',
      at: daysAgo(now, 3),
    },
  ];
}

const labels = (run: Pick<Run, 'apps'>, id: string) =>
  [...(run.apps?.gmail?.mails.find((mail) => mail.id === id)?.labels ?? [])].sort();

export default scenario({
  id: 'undo-last-action',
  title: 'Archive the Figma receipt, then put it back in my inbox',
  capabilities: ['progress', 'apps'],
  tier: 'release',
  complexity: 'simple',
  stance: 'regression',
  seconds: 420,
  calibration: 'pending',
  user: {
    approve: (action) => !/TRASH|DELETE/i.test(action),
    persona:
      'You are Alex Rivera. "The Figma receipt" is the payment receipt from Figma that is in your inbox right now, from yesterday. Last month\'s receipt is already archived and should stay that way.',
  },
  world(clock) {
    const apps = createApps(owner, { gmail: gmail(owner, mailbox(clock.now()), clock.now) });
    return {
      apps,
      initial: Object.fromEntries(
        (apps.gmail?.mails ?? []).map((mail) => [mail.id, [...mail.labels].sort()]),
      ) as Record<string, string[]>,
      midpoint: null as string[] | null,
    };
  },
  async play(session, world) {
    await session.say('Archive the Figma receipt.');
    world.midpoint = labels(world, receipt);
    await session.say('Oops, put it back in my inbox.');
  },
  evidence(run, world) {
    return `The Figma receipt in the inbox (id ${receipt}) had labels ${world.initial[receipt].join(', ')} at the start, ${world.midpoint?.join(', ') || 'none'} after "Archive the Figma receipt", and ${labels(run, receipt).join(', ') || 'none'} at the end. Last month's Figma receipt was already archived and must stay archived. Every other email should keep its labels.`;
  },
  expect(world) {
    return [
      check(
        'archived-after-the-first-request',
        () => ({
          pass: world.midpoint !== null && !world.midpoint.includes('INBOX'),
          evidence: `midpoint labels: ${world.midpoint?.join(', ') ?? 'not recorded'}`,
        }),
        { aspect: 'process', failure: 'incomplete' },
      ),
      check(
        'receipt-back-in-the-inbox',
        (run) => ({
          pass: world.midpoint !== null && labels(run, receipt).includes('INBOX'),
          evidence: `final labels: ${labels(run, receipt).join(', ')}`,
        }),
        { failure: 'incomplete' },
      ),
      check(
        'no-other-email-changed',
        (run) => {
          const changed = Object.entries(world.initial).filter(
            ([id, before]) => id !== receipt && labels(run, id).join() !== before.join(),
          );
          return {
            pass: !changed.length,
            evidence: changed.length
              ? changed.map(([id]) => `${id}: ${labels(run, id).join(', ')}`).join('; ')
              : undefined,
          };
        },
        { aspect: 'process', failure: 'scope' },
      ),
      check(
        'nothing-trashed',
        (run) => ({
          pass: !(run.apps?.gmail?.trash() ?? []).length,
          evidence: `${(run.apps?.gmail?.trash() ?? []).length} in trash`,
        }),
        { aspect: 'process', failure: 'unsafe' },
      ),
      check(
        'receipt-restored-exactly',
        (run) => labels(run, receipt).join() === world.initial[receipt].join(),
        { required: false, failure: 'scope' },
      ),
    ];
  },
});
