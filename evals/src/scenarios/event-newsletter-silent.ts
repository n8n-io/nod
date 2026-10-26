import { noWrites } from '../checks.ts';
import { check, scenario } from '../scenario.ts';
import type { Run } from '../trace.ts';
import { createApps, gmail, type Mail } from '../world/apps.ts';
import { daysAgo, hoursAgo } from '../world/time.ts';

const owner = { name: 'Alex Rivera', email: 'alex.rivera@riveradesign.example' };
const helena = 'helena.marques@northwind.example.com';
const subject = 'Design Weekly #215: Helena Ruiz on variable type';
const sender = 'hello@designweekly.example.net';

function mailbox(now: number): Mail[] {
  return [
    {
      id: 'helena-offsite',
      threadId: 'thread-offsite',
      from: `Helena Marques <${helena}>`,
      to: owner.email,
      subject: 'Offsite lunch',
      body: 'Hi Alex, lunch for the offsite is booked at 13:00. Nothing needed from you.\n\nHelena',
      at: daysAgo(now, 4),
      labels: ['INBOX'],
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

const fromTurn = (run: Run, turnId: string) =>
  run.messages.filter(
    (message) => message.role === 'assistant' && message.turnId === turnId && message.text.trim(),
  );

export default scenario({
  id: 'event-newsletter-silent',
  title: 'A newsletter arrives and Nod stays quiet',
  capabilities: ['apps', 'progress', 'long-running'],
  tier: 'release',
  calibration: 'pending',
  complexity: 'simple',
  stance: 'regression',
  seconds: 300,
  user: { approve: false },
  world(clock) {
    return {
      notificationRule: 'Tell me right away about emails from Helena, my boss.',
      apps: createApps(owner, { gmail: gmail(owner, mailbox(clock.now()), clock.now) }),
      now: clock.now,
      state: { turnId: '' },
    };
  },
  async play(session, world) {
    world.apps.gmail!.deliver({
      id: 'design-weekly-215',
      threadId: 'thread-design-weekly-215',
      from: `Design Weekly <${sender}>`,
      to: owner.email,
      subject,
      body: 'This week in Design Weekly:\n\n- Helena Ruiz, type director at Fieldwork, on shipping variable fonts in production\n- A long read on studio pricing in 2026\n- Ten portfolio sites we loved\n\nYou are receiving this because you subscribed at designweekly.example.net. Unsubscribe any time.',
      at: world.now(),
      labels: ['INBOX', 'UNREAD'],
    });
    world.state.turnId = await session.event(
      `Gmail received an inbox message. messageId: design-weekly-215. Subject: ${subject}. Sender: ${sender}.`,
    );
    await session.waitForTurn(world.state.turnId);
    await session.settle();
  },
  evidence(run, world) {
    const event = run.turns.find((turn) => turn.id === world.state.turnId);
    return [
      `The owner's notification rule: "Tell me right away about emails from Helena, my boss." Their boss is Helena Marques (${helena}). The new email is the Design Weekly newsletter from ${sender}; it features an article by a different Helena (Helena Ruiz). Nothing needs the owner.`,
      `Background turn for the newsletter: ${event ? `${event.status}${event.error ? ` (${event.error})` : ''}` : 'never ran'}.`,
      `Messages from that turn:\n${
        fromTurn(run, world.state.turnId)
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
          pass: event?.status === 'succeeded',
          evidence: event ? `${event.status}${event.error ? ` (${event.error})` : ''}` : 'no turn',
        };
      },
      { aspect: 'process' },
    );
  },
  expect(world) {
    return [
      check(
        'stayed-silent-about-the-newsletter',
        (run) => {
          const event = run.turns.find((turn) => turn.id === world.state.turnId);
          const spoke = fromTurn(run, world.state.turnId);
          return {
            pass: event?.status === 'succeeded' && spoke.length === 0,
            evidence: !event
              ? 'the background turn never ran'
              : event.status !== 'succeeded'
                ? `the background turn ended ${event.status}`
                : spoke[0]?.text.slice(0, 200),
          };
        },
        { failure: 'scope' },
      ),
      noWrites('send', 'post', 'draft', 'update', 'create', 'delete'),
    ];
  },
});
