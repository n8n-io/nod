import type { ObservationRecord } from '../../../src/ports/proactivity.ts';
import { noWrites } from '../checks.ts';
import { check, judge, scenario } from '../scenario.ts';

export default scenario({
  id: 'proactivity-chat-review',
  title: 'Show the draft behind a nudge in chat',
  capabilities: ['progress'],
  tier: 'pr',
  complexity: 'medium',
  stance: 'gap',
  calibration: 'pending',
  seconds: 360,
  user: { approve: false },
  world() {
    const record: ObservationRecord = {
      id: 'record-29',
      version: 'v1',
      available: true,
      data: {
        owner: 'Alex',
        supplier: 'Cedar Tools',
        account: 'AC-572',
        credit: 'CM-392',
        invoice: 'INV-793',
        amount: 280,
        currency: 'EUR',
        status: 'unused',
        text: 'The owner statement lists this unused credit. Contact support to confirm the balance and ask about use or refund. No expiry, refund terms, or support address is supplied.',
      },
    };
    return {
      notificationRule:
        'Tell me about unused supplier credits and prepare complete enquiries for me to review. Do not send anything.',
      observations: [
        {
          id: 'records',
          sources: async () => [
            {
              id: 'statements',
              label: 'Supplier statements',
              description: 'Current statement records for Alex.',
              revision: 'owner-one',
              readable: true,
            },
          ],
          read: async (_sourceId, input) => ({
            records: !input.ids || input.ids.includes(record.id) ? [record] : [],
          }),
        },
      ],
      state: { initial: '', reply: '', prepared: 0 },
    };
  },
  async play(session, world) {
    world.state.initial = await session.event('A current supplier statement record changed.');
    await session.waitForTurn(world.state.initial);
    await session.settle();
    world.state.prepared = (await session.proactivity.view()).issues.length;
    await session.say(
      'Show me the Cedar Tools draft here, including the subject and full message, so I can copy it.',
    );
    await session.settle();
    world.state.reply = await session.lastReply();
  },
  evidence(run, world) {
    return JSON.stringify({ reply: world.state.reply, tools: run.tools, messages: run.messages });
  },
  expect(world) {
    return [
      check('work-was-prepared-first', () => world.state.prepared > 0),
      check('full-work-reaches-chat', () =>
        ['CM-392', 'AC-572', 'INV-793', '280'].every((value) => world.state.reply.includes(value)),
      ),
      check('chat-reads-the-prepared-result', (run) =>
        run.tools.some(
          (call) =>
            call.name === 'manage_personal_context' &&
            call.input.action === 'prepared_list' &&
            Boolean(
              call.input.id || call.input.query || call.input.args?.id || call.input.args?.query,
            ) &&
            !call.isError,
        ),
      ),
      noWrites('send', 'post', 'draft', 'update', 'create', 'delete'),
      judge(
        'copyable-work-without-a-desktop',
        'The owner can copy a complete, factual enquiry to Cedar Tools directly from the last chat reply. It asks about the EUR 280 credit CM-392 on account AC-572 and invoice INV-793. It invents no refund right, address, deadline, or completed send. It shows the draft itself instead of pointing somewhere else.',
      ),
    ];
  },
});
