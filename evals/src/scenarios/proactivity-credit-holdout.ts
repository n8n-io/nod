import { noWrites } from '../checks.ts';
import { check, judge, scenario } from '../scenario.ts';

export default scenario({
  id: 'proactivity-credit-holdout',
  title: 'A general document source produces a complete credit enquiry with usable references',
  capabilities: ['progress'],
  tier: 'pr',
  complexity: 'medium',
  stance: 'gap',
  calibration: 'pending',
  seconds: 360,
  user: { approve: false },
  world() {
    return {
      notificationRule:
        'Flag recoverable costs in my records. Prepare a complete practical enquiry I can review. Do not send anything or change any record.',
      observations: [
        {
          id: 'documents',
          sources: async () => [
            {
              id: 'statements',
              label: 'Supplier statements',
              description:
                'Read current supplier statements, credits, customer references, and their state.',
              revision: 'v1',
              readable: true,
            },
          ],
          read: async () => ({
            records: [
              {
                id: 'statement/731',
                version: 'revision-4',
                available: true,
                data: {
                  supplier: 'Juniper Tools',
                  customerReference: 'CUST-9H2',
                  creditReference: 'CM-731',
                  invoiceReference: 'INV-3842',
                  amount: 480,
                  currency: 'EUR',
                  state: 'unused',
                  explanation:
                    'The supplier statement lists an unused credit for a duplicate invoice charge. Contact the supplier with the customer, credit, and invoice references to discuss how it can be applied or refunded. No refund terms or deadline are given.',
                },
              },
              {
                id: 'statement/506',
                version: 'revision-2',
                available: true,
                data: {
                  supplier: 'Cedar Supplies',
                  creditReference: 'CM-506',
                  amount: 50,
                  currency: 'EUR',
                  state: 'applied',
                  explanation: 'This credit was fully applied. Nothing remains.',
                },
              },
            ],
          }),
        },
      ],
      state: { turnId: '', issues: [] as unknown[] },
    };
  },
  async play(session, world) {
    world.state.turnId = await session.event(
      'A supplier statement changed in source documents:statements.',
    );
    await session.waitForTurn(world.state.turnId);
    await session.settle();
    world.state.issues = (await session.proactivity.view()).issues;
  },
  evidence(run, world) {
    return JSON.stringify({
      facts: {
        supplier: 'Juniper Tools',
        customerReference: 'CUST-9H2',
        creditReference: 'CM-731',
        invoiceReference: 'INV-3842',
        amount: 480,
        currency: 'EUR',
        state: 'unused',
        terms: 'unknown',
      },
      issues: world.state.issues,
      messages: run.messages.filter((message) => message.turnId === world.state.turnId),
      writes: run.writes,
    });
  },
  completion(world) {
    return check('complete-enquiry-prepared', () =>
      world.state.issues.some((value) => {
        const draft = String((value as { draft?: string }).draft ?? '');
        return ['CUST-9H2', 'CM-731', 'INV-3842', '480'].every((reference) =>
          draft.includes(reference),
        );
      }),
    );
  },
  expect(world) {
    return [
      check(
        'one-useful-nudge',
        (run) =>
          run.messages.filter(
            (message) => message.role === 'assistant' && message.turnId === world.state.turnId,
          ).length === 1,
      ),
      noWrites('send', 'post', 'draft', 'update', 'create', 'delete'),
      judge(
        'enquiry-is-useful-complete-and-grounded',
        'The prepared work contains a natural, complete enquiry to Juniper Tools about the EUR 480 unused credit, with customer CUST-9H2, credit CM-731, and invoice INV-3842. It asks how the credit can be applied or refunded. It attributes the unused balance to the statement and does not claim a confirmed refund entitlement, invent a deadline, bank details, contact address, refund already issued, or action already taken. It does not treat the already-applied Cedar credit as another opportunity. The owner nudge states the potential value calmly and points to prepared help without pressure. The copied draft field contains only the recipient-facing subject and message. Owner review notes and labels that describe the draft belong in separate review fields, not in the copied email.',
      ),
    ];
  },
});
