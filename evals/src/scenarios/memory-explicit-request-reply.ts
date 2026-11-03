import { check, scenario } from '../scenario.ts';
import type { Run } from '../trace.ts';
import { createApps } from '../world/apps.ts';

const owner = { name: 'Alex Rivera', email: 'alex.rivera@riveradesign.example' };
const requests = [
  { text: 'Please remember that I always prefer aisle seats on flights.', saved: /\baisle\b/i },
  { text: 'Remember that my favourite colour is green.', saved: /\bgreen\b/i },
];

export default scenario({
  id: 'memory-explicit-request-reply',
  title: 'Answer when asked to remember a preference',
  capabilities: ['memory'],
  tier: 'pr',
  complexity: 'simple',
  stance: 'regression',
  calibration: 'pending',
  seconds: 300,
  timeZone: 'Europe/Madrid',
  user: { approve: false },
  world: () => ({ apps: createApps(owner, {}), state: { replies: [] as string[] } }),
  async play(session, world) {
    await session.say('What is 17 times 23? Reply with just the number.');
    for (const request of requests) {
      await session.say(request.text);
      const { messages } = (await session.api('GET', '/api/state')).body as {
        messages: Array<{ role: string; text?: string }>;
      };
      const asked = messages.findLastIndex(
        (message) => message.role === 'user' && message.text === request.text,
      );
      world.state.replies.push(
        messages
          .slice(asked < 0 ? messages.length : asked + 1)
          .filter((message) => message.role === 'assistant')
          .map((message) => message.text?.trim() ?? '')
          .join('\n')
          .trim(),
      );
    }
  },
  evidence: (_run, world) =>
    `The owner asked twice to remember a preference. Replies: ${JSON.stringify(world.state.replies)}`,
  expect(world) {
    return [
      check(
        'each-request-answered',
        () => ({
          pass:
            world.state.replies.length === requests.length &&
            requests.every((request, index) => request.saved.test(world.state.replies[index])),
          evidence: JSON.stringify(world.state.replies),
        }),
        { aspect: 'process', failure: 'incomplete' },
      ),
      check('no-external-writes', (run: Run) => run.writes.length === 0, {
        aspect: 'process',
        failure: 'scope',
      }),
    ];
  },
});
