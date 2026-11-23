import { check, scenario } from '../scenario.ts';
import type { Run } from '../trace.ts';
import { createApps } from '../world/apps.ts';

const owner = { name: 'Alex Rivera', email: 'alex.rivera@riveradesign.example' };
const preference =
  "My preference when it comes to email sign-off is:\n\nCheers,\nAlex\n\nunless it's formal, then I prefer:\n\nKind regards,\nAlex Rivera";
const request = 'Please remember this for future emails.';
const ask =
  "Write a quick email to my friend Jamie saying I'll be 10 minutes late for lunch. Just write it here in chat.";

interface Memory {
  notes: Array<{ path: string; text: string; status: string }>;
}

export default scenario({
  id: 'memory-multiline-signoff',
  title: 'Remember my email sign-offs, written on several lines',
  linear: 'LAB-954',
  capabilities: ['memory'],
  tier: 'pr',
  complexity: 'simple',
  stance: 'regression',
  calibration: 'pending',
  seconds: 420,
  timeZone: 'Europe/Lisbon',
  user: {
    approve: false,
    persona:
      'You are Alex Rivera. You told the assistant how you sign your emails and want it to keep that. If it asks you to repeat your sign-off, say it is in your earlier message.',
  },
  world: () => ({
    apps: createApps(owner, {}),
    state: {} as { saved?: Memory; reply?: string },
  }),
  async play(session, world) {
    await session.say(preference);
    await session.say(request);
    world.state.saved = (await session.api('GET', '/api/memory')).body;
    await session.reset();
    await session.say(ask);
    const { messages } = (await session.api('GET', '/api/state')).body as {
      messages: Array<{ role: string; text?: string }>;
    };
    world.state.reply = messages.findLast((message) => message.role === 'assistant')?.text ?? '';
  },
  evidence: (_run, world) =>
    `The owner wrote their email sign-offs on several lines (informal "Cheers,\\nAlex", formal "Kind regards,\\nAlex Rivera") and asked Nod to remember them. After a reset they asked for an informal email to a friend. Memory right after the request:\n${JSON.stringify(world.state.saved?.notes?.map((note) => note.text) ?? [])}\n\nFinal reply:\n${world.state.reply ?? ''}`,
  expect(world) {
    return [
      check(
        'signoffs-saved-on-request',
        () => {
          const text = (world.state.saved?.notes ?? []).map((note) => note.text).join(' | ');
          return {
            pass: /cheers/i.test(text) && /kind regards/i.test(text),
            evidence: text || 'memory was empty after the request',
          };
        },
        { failure: 'incomplete' },
      ),
      check(
        'informal-signoff-after-reset',
        () => ({
          pass: /cheers,?\s*alex\b/i.test(world.state.reply ?? ''),
          evidence: (world.state.reply ?? '').trim().slice(-160) || 'no reply',
        }),
        {
          failure: 'reasoning',
          otherwise: 'The email is signed with the informal sign-off "Cheers" and the name Alex.',
        },
      ),
      check(
        'memory-learn-kept-notes',
        (run: Run) => {
          const calls = run.tools.filter(
            (call) =>
              ['manage_personal_context', 'memory', 'nod'].includes(call.name) &&
              call.input?.action === 'memory_learn',
          );
          const empty = calls.filter(
            (call) => call.isError || /"saved":\s*\[\s*\]/.test(call.output ?? ''),
          );
          return {
            pass: calls.length > 0 && !empty.length,
            evidence: calls.length
              ? empty.map((call) => (call.output ?? '').slice(0, 200)).join('\n') ||
                `${calls.length} memory_learn calls each kept a note`
              : 'no memory_learn call',
          };
        },
        { aspect: 'process', failure: 'incomplete' },
      ),
      check('no-external-writes', (run: Run) => run.writes.length === 0, {
        aspect: 'process',
        failure: 'scope',
      }),
    ];
  },
});
