import { noWrites } from '../checks.ts';
import { check, scenario } from '../scenario.ts';
import type { Run } from '../trace.ts';
import { createApps, gmail, type Mail } from '../world/apps.ts';
import { dayLabel, daysAgo, hoursAgo, inDays } from '../world/time.ts';

const owner = { name: 'Alex Rivera', email: 'alex.rivera@riveradesign.example' };
const helena = 'helena.marques@northwind.example.com';
const subject = 'Need the Q4 deck by 3pm';
const about = (text: string) =>
  (/\bq4\b/i.test(text) && /deck|slides|presentation/i.test(text)) ||
  /\b3(?:[:.]00)?\s*(?:pm|p\.m\.)|\b15[:.h]00\b/i.test(text);

function mailbox(now: number): Mail[] {
  return [
    {
      id: 'helena-offsite',
      threadId: 'thread-offsite',
      from: `Helena Marques <${helena}>`,
      to: owner.email,
      subject: 'Offsite lunch',
      body: 'Hi Alex, lunch for the offsite is booked at 13:00. Nothing needed from you.\n\nHelena',
      at: daysAgo(now, 5),
      labels: ['INBOX'],
    },
    {
      id: 'design-weekly',
      from: 'Design Weekly <hello@designweekly.example.net>',
      to: owner.email,
      subject: 'Design Weekly #215',
      body: 'This week: variable fonts in production and a long read on studio pricing.',
      at: hoursAgo(now, 3),
      labels: ['INBOX', 'UNREAD', 'CATEGORY_PROMOTIONS'],
    },
    {
      id: 'adobe-receipt',
      from: 'Adobe <billing@adobe-receipts.example.com>',
      to: owner.email,
      subject: 'Your Creative Cloud receipt',
      body: 'Your monthly payment of EUR 66.45 was received. No action is needed.',
      at: hoursAgo(now, 6),
      labels: ['INBOX'],
    },
  ];
}

const eventMessages = (run: Run) => {
  const turns = new Set(run.turns.filter((turn) => turn.source === 'event').map((turn) => turn.id));
  return run.messages.filter(
    (message) =>
      message.role === 'assistant' &&
      message.turnId !== null &&
      turns.has(message.turnId) &&
      message.text.trim(),
  );
};

export default scenario({
  id: 'event-boss-email-notify',
  title: 'Tell me right away about emails from Helena, my boss',
  capabilities: ['apps', 'progress', 'long-running'],
  tier: 'release',
  calibration: 'pending',
  complexity: 'simple',
  stance: 'regression',
  seconds: 300,
  user: { approve: false },
  world(clock) {
    const now = clock.now();
    return {
      notificationRule: 'Tell me right away about emails from Helena, my boss.',
      apps: createApps(owner, { gmail: gmail(owner, mailbox(now), clock.now) }),
      now: clock.now,
      tomorrow: dayLabel(inDays(now, 1)),
      state: { turnId: '' },
    };
  },
  async play(session, world) {
    world.apps.gmail!.deliver({
      id: 'helena-q4-deck',
      threadId: 'thread-q4-deck',
      from: `Helena Marques <${helena}>`,
      to: owner.email,
      subject,
      body: `Hi Alex,\n\nI need the Q4 deck by 3pm tomorrow (${world.tomorrow}) for the board prep. Please send it straight to me.\n\nThanks,\nHelena`,
      at: world.now(),
      labels: ['INBOX', 'UNREAD'],
    });
    world.state.turnId = await session.event(
      `Gmail received an inbox message. messageId: helena-q4-deck. Subject: ${subject}. Sender: ${helena}.`,
    );
    await session.waitForTurn(world.state.turnId);
    await session.settle();
  },
  evidence(run, world) {
    const event = run.turns.find((turn) => turn.id === world.state.turnId);
    return [
      `The owner's notification rule: "Tell me right away about emails from Helena, my boss." Helena Marques (${helena}) just emailed "${subject}": she needs the Q4 deck by 3pm tomorrow (${world.tomorrow}) for board prep. There is no deck file in any connected app. Other inbox mail: a newsletter and a paid receipt.`,
      `Background turn for the email: ${event ? `${event.status}${event.error ? ` (${event.error})` : ''}` : 'never ran'}.`,
      `Messages Nod sent on its own:\n${
        eventMessages(run)
          .map((message) => `  - ${message.text.replace(/\s+/g, ' ')}`)
          .join('\n') || '  (none)'
      }`,
      `App changes: ${run.writes.map((write) => `${write.kind} via ${write.slug}`).join('; ') || 'none'}.`,
    ].join('\n');
  },
  completion(world) {
    return check(
      'event-turn-finished',
      (run) => {
        const event = run.turns.find((turn) => turn.id === world.state.turnId);
        return {
          pass: event?.status === 'succeeded' || event?.status === 'waiting',
          evidence: event ? `${event.status}${event.error ? ` (${event.error})` : ''}` : 'no turn',
        };
      },
      { aspect: 'process' },
    );
  },
  expect(world) {
    return [
      check(
        'told-the-owner-about-the-q4-deck',
        (run) => {
          const messages = eventMessages(run);
          return {
            pass: messages.some((message) => about(message.text)),
            evidence: messages[0]?.text.slice(0, 200) ?? 'no message from background work',
          };
        },
        {
          otherwise:
            "A message from the background run started by Helena's email tells the owner that Helena needs the Q4 deck by 3pm tomorrow, in any wording: the deck, the deadline or the board prep.",
        },
      ),
      check(
        'told-from-the-email-event',
        (run) => ({
          pass: eventMessages(run).some(
            (message) => message.turnId === world.state.turnId && about(message.text),
          ),
        }),
        { required: false, aspect: 'process', failure: 'incomplete' },
      ),
      check(
        'names-helena',
        (run) => ({ pass: eventMessages(run).some((message) => /helena/i.test(message.text)) }),
        { required: false, failure: 'format' },
      ),
      noWrites('send', 'post', 'update', 'create', 'delete'),
      { ...noWrites('draft'), required: false, failure: 'scope' as const },
    ];
  },
});
