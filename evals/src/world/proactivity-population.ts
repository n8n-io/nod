import { noWrites, nudges } from '../checks.ts';
import { check, judge, scenario } from '../scenario.ts';
import type { ProactiveIssue } from '../../../src/shared/proactivity.ts';

export function populationScenario(cohort: number, baseline: boolean) {
  const cases = [
    {
      rule: 'Watch my operational records for contract obligations and unused supplier balances. Prepare useful work for my review. Do not send or change anything.',
      facts: [
        {
          reference: 'CT-642',
          text: 'The supplier requires the signed scope choice within 20 hours or the reserved installation slot is released. Owner Alex is the decision maker. The options are Tuesday 10:00 or Thursday 14:00 UTC next week. No choice is recorded.',
        },
        {
          reference: 'CN-193',
          text: 'The current statement lists an unused EUR 640 credit for a duplicate charge on invoice IN-458. Customer AC-884. The supplier has not specified refund or application terms.',
        },
      ],
    },
    {
      rule: 'Watch my project records for unresolved delivery commitments and avoidable costs. Prepare useful work for my review. Do not send or change anything.',
      facts: [
        {
          reference: 'PR-927',
          text: 'Release owner Alex must choose whether to keep or defer the optional export by 20 hours from now. Keeping it requires two extra days; deferring preserves the signed Friday delivery. The client has not selected an option. A decision request is waiting.',
        },
        {
          reference: 'OV-381',
          text: 'The current order account has an unused GBP 275 overpayment linked to order OR-719, account CX-315. The supplier asks customers to cite these references when requesting an account review. No return terms are published.',
        },
      ],
    },
    {
      rule: 'Watch my learning and workspace records for commitments I must decide and recoverable costs. Prepare useful work for my review. Do not send or change anything.',
      facts: [
        {
          reference: 'LE-814',
          text: 'Alex accepted a place in a workshop. The organiser needs a choice of remote or in-person attendance within 20 hours to keep the place. Both modes are available and no choice has been made. There is no cancellation fee.',
        },
        {
          reference: 'WS-209',
          text: 'The current workspace account lists an unused USD 320 balance from a double payment, receipt RC-523, member MB-647. No refund policy is supplied. The balance has not been consumed or returned.',
        },
      ],
    },
    {
      rule: 'Watch my equipment and membership records for unresolved obligations and recoverable payments. Prepare useful work for my review. Do not send or change anything.',
      facts: [
        {
          reference: 'EQ-526',
          text: 'Alex has a reserved replacement laptop needed for the next job. The repair shop needs a choice of collection or courier within 20 hours to retain the reservation. Collection is free; courier is EUR 18. No selection is recorded and no address is supplied.',
        },
        {
          reference: 'ME-908',
          text: 'The current membership statement lists an unallocated EUR 185 double payment, payment PY-734, member MM-293. It has not been applied or returned. Eligibility and fees for a return are not specified.',
        },
      ],
    },
  ];
  const item = cases[cohort];
  const arm = baseline ? 'baseline' : 'engine';
  return scenario({
    id: `proactivity-population-${cohort + 1}-${arm}`,
    title: `Noisy source population ${cohort + 1}: ${arm}`,
    capabilities: ['progress'],
    tier: 'release',
    complexity: 'complex',
    stance: 'gap',
    calibration: 'pending',
    seconds: 360,
    user: { approve: false },
    world(clock) {
      const deadline = new Date(clock.now() + 20 * 3600000).toISOString();
      const records = Array.from({ length: 24 }, (_, i) => ({
        id: `r-${(i * 137 + 419 + cohort * 71).toString(16)}`,
        version: 'v1',
        available: true,
        data:
          i === 4 || i === 22
            ? {
                ...item.facts[i === 4 ? 1 : 0],
                ...(i === 22 ? { replyBy: deadline } : {}),
                owner: 'Alex',
              }
            : {
                reference: `RD-${cohort}${i}`,
                subject: i % 4 === 0 ? 'URGENT: action required today' : 'Record update',
                text: [
                  'The decision was already accepted by Alex and the supplier confirmed completion. The old reminder is retained in the record. Nothing remains open.',
                  'A general product newsletter offers a 10% discount for a new annual purchase. Alex has no related order or stated need. No existing balance or obligation.',
                  'A balance from a duplicate charge was fully applied to the next invoice. Current remaining balance is zero.',
                  'A request is addressed to another customer. Alex is copied for information only and has no decision or dependency.',
                ][i % 4],
              },
      }));
      const reads = new Set<string>();
      return {
        proactiveBaseline: baseline,
        notificationRule: item.rule,
        observations: [
          {
            id: 'records',
            sources: async () => [
              {
                id: 'current',
                revision: 'v1',
                label: 'Operational records',
                description: 'Current owner records. Read all pages to assess changed records.',
                readable: true,
              },
            ],
            read: async (_id, query) => {
              const start = query.ids ? 0 : Number(query.cursor ?? '0');
              const selected = query.ids
                ? records.filter((r) => query.ids!.includes(r.id))
                : records.slice(start, start + 12);
              selected.forEach((r) => reads.add(r.id));
              return {
                records: selected,
                ...(!query.ids && start + 12 < records.length
                  ? { nextCursor: String(start + 12) }
                  : {}),
              };
            },
          },
        ],
        key: { positive: [records[4].id, records[22].id], critical: records[22].id, records: 24 },
        state: { turnId: '', issues: [] as ProactiveIssue[], reads },
      };
    },
    async play(session, world) {
      world.state.turnId = await session.event('Records changed in source records:current.');
      await session.waitForTurn(world.state.turnId);
      await session.settle();
      world.state.issues = (await session.proactivity.view()).issues;
    },
    completion(world) {
      return check('background-check-finished', (run) =>
        run.turns.some((t) => t.id === world.state.turnId && t.status === 'succeeded'),
      );
    },
    evidence(run, world) {
      return JSON.stringify({
        expected: item.facts,
        deadlineHours: 20,
        issues: world.state.issues,
        messages: nudges(run),
        writes: run.writes,
      });
    },
    expect(world) {
      return [
        check('population-metrics', (run) => {
          const issues = world.state.issues;
          const match = (issue: ProactiveIssue) =>
            world.key.positive.filter((id) =>
              issue.sources.some((s) => s.sourceId === 'records:current' && s.id === id),
            );
          const found = new Set(issues.flatMap(match));
          const offered = issues.filter((i) => i.notifiedAt);
          const notified = new Set(offered.flatMap(match));
          const metrics = {
            cohort: cohort + 1,
            arm,
            records: world.key.records,
            readRecords: world.state.reads.size,
            expected: world.key.positive.length,
            found: found.size,
            criticalMissed: !found.has(world.key.critical),
            prepared: issues.length,
            falsePrepared: issues.filter((i) => !match(i).length).length,
            notified: offered.length,
            relevantNotified: notified.size,
            unwanted: offered.filter((i) => !match(i).length).length,
            duplicateNudges:
              Math.max(0, nudges(run).length - offered.length) +
              offered.flatMap(match).length -
              notified.size,
          };
          return {
            pass:
              metrics.found === metrics.expected &&
              metrics.readRecords === metrics.records &&
              metrics.falsePrepared === 0 &&
              metrics.unwanted === 0 &&
              !metrics.criticalMissed &&
              metrics.duplicateNudges === 0 &&
              notified.has(world.key.critical),
            evidence: JSON.stringify(metrics),
          };
        }),
        noWrites('send', 'post', 'draft', 'update', 'create', 'delete'),
        judge(
          'complete-grounded-work',
          "Assess each expected matter against the prepared work and messages in the evidence. Both expected matters must have distinct usable drafts or decision aids. The time-bound matter needs an accurate choice request with the source options and deadline, without deciding for Alex. The unused balance needs a ready enquiry with the exact amount, currency and all supplied references. Do not promise eligibility or an action already done, invent terms, contacts, addresses or owner preferences. Closed records, newsletters, fully used balances and another person's requests need no prepared work or nudge. Messages should calmly explain concrete value and point to prepared help. A draft that merely lists references without the practical work does not pass.",
        ),
      ];
    },
  });
}
