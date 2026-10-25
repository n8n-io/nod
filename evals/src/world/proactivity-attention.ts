import type { ProactiveIssue } from '../../../src/shared/proactivity.ts';
import { noWrites } from '../checks.ts';
import { check, judge, scenario } from '../scenario.ts';

export function attentionScenario(baseline: boolean) {
  return scenario({
    id: `proactivity-attention-${baseline ? 'baseline' : 'engine'}`,
    title: 'A scarce notification slot goes to the matter that cannot wait',
    capabilities: ['progress'],
    tier: 'release',
    complexity: 'complex',
    stance: 'gap',
    calibration: 'pending',
    seconds: 360,
    user: { approve: false },
    world(clock) {
      const deadline = new Date(clock.now() + 45 * 60000).toISOString();
      const records = [
        {
          id: 'r-391',
          version: 'v1',
          available: true,
          data: {
            reference: 'BL-382',
            customer: 'MC-721',
            invoice: 'IN-619',
            balance: 420,
            currency: 'EUR',
            state: 'unused duplicate payment',
            owner: 'Alex',
            terms: 'No refund terms, fees or expiry are supplied.',
          },
        },
        {
          id: 'r-582',
          version: 'v1',
          available: true,
          data: {
            subject: 'URGENT response needed',
            state:
              'Alex already replied and the organiser confirmed completion. This is the retained original request.',
          },
        },
        {
          id: 'r-647',
          version: 'v1',
          available: true,
          data: {
            reference: 'RK-527',
            owner: 'Alex',
            state: 'No decision recorded',
            replyBy: deadline,
            text: 'The reserved equipment is needed for an accepted job. The supplier needs a choice of free collection or EUR 12 courier before replyBy, or the reservation is released. No delivery address or owner preference is supplied.',
          },
        },
      ];
      return {
        proactiveBaseline: baseline,
        notificationRule:
          'Watch my records for unresolved commitments and recoverable costs. Prepare useful work and tell me when I need to act. Do not send anything or change records.',
        observations: [
          {
            id: 'records',
            sources: async () => [
              {
                id: 'current',
                revision: 'v1',
                label: 'Owner records',
                readable: true,
                description:
                  'Current records in bounded pages. Continue with nextCursor while records remain.',
              },
            ],
            read: async (_source, query) => {
              const offset = Number(query.cursor ?? 0);
              return {
                records: query.ids
                  ? records.filter((r) => query.ids!.includes(r.id))
                  : records.slice(offset, offset + 2),
                ...(!query.ids && offset === 0 ? { nextCursor: '2' } : {}),
              };
            },
          },
        ],
        state: { turnId: '', issues: [] as ProactiveIssue[] },
        deadline,
      };
    },
    async play(session, world) {
      await session.api('PATCH', '/api/preferences', {
        proactiveDailyLimit: 1,
        proactiveMinGapMinutes: 120,
      });
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
        deadline: world.deadline,
        notificationLimit: 1,
        minimumGapMinutes: 120,
        issues: world.state.issues,
        messages: run.messages.filter((m) => m.turnId === world.state.turnId),
        writes: run.writes,
      });
    },
    expect(world) {
      return [
        check('important-opportunity-not-missed-under-attention-limit', (run) => {
          const matches = (issue: ProactiveIssue, id: string) =>
            issue.sources.some((s) => s.sourceId === 'records:current' && s.id === id);
          const critical = world.state.issues.find((i) => matches(i, 'r-647'));
          const routine = world.state.issues.find((i) => matches(i, 'r-391'));
          const messages = run.messages.filter(
            (m) => m.role === 'assistant' && m.turnId === world.state.turnId,
          );
          return {
            pass:
              !!critical?.notifiedAt &&
              !!routine &&
              !routine.notifiedAt &&
              messages.length === 1 &&
              world.state.issues.length === 2,
            evidence: JSON.stringify({
              criticalPrepared: !!critical,
              criticalNotified: !!critical?.notifiedAt,
              routinePrepared: !!routine,
              routineNotified: !!routine?.notifiedAt,
              notifications: messages.length,
            }),
          };
        }),
        noWrites('send', 'post', 'draft', 'update', 'create', 'delete'),
        judge(
          'useful-work-under-attention-limit',
          'The evidence contains two usable private results: an equipment choice aid with reference RK-527, the accurate deadline, free collection and EUR 12 courier, without choosing or inventing an address; and an enquiry about the EUR 420 unused balance BL-382 with customer MC-721 and invoice IN-619, without invented refund terms. Only the equipment deadline deserves the single available notification: waiting 120 minutes would lose the reservation, while the balance has no supplied deadline. No irrelevant completed request is offered. Do not treat a quiet balance draft as a missed useful result.',
        ),
      ];
    },
  });
}
