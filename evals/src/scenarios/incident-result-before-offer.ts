import { check, judge, scenario } from '../scenario.ts';
import { page } from '../world/sites.ts';

export default scenario({
  id: 'incident-result-before-offer',
  title: 'Deliver a one-off incident brief before an optional monitoring offer',
  linear: 'LAB-676',
  capabilities: ['research', 'progress', 'schedules'],
  tier: 'full',
  complexity: 'simple',
  stance: 'regression',
  calibration: 'pending',
  seconds: 240,
  user: { approve: false },
  world() {
    return {
      sites: {
        'status.maple.example': ({ url }) =>
          url.pathname === '/incidents'
            ? page(
                'Maple service status',
                '<h1>Maple service status</h1><p>Current status: all systems operational.</p><article><h2>2026-10-21: Delayed webhook deliveries</h2><p>Incident window: 09:10 to 09:42 UTC. Status: resolved.</p><p>A faulty worker deployment caused webhook deliveries to queue. We rolled back that deployment and drained the queue. All delayed webhooks were replayed automatically. No events were lost. Customers do not need to replay or resend anything.</p></article><article><h2>2026-10-18: Console latency</h2><p>Incident window: 16:00 to 16:15 UTC. Status: resolved. The management console loaded slowly. API calls and webhook delivery were unaffected.</p></article>',
              )
            : page('Not found', '<h1>Not found</h1>', 404),
      },
    };
  },
  async play(session) {
    await session.say(
      'Check https://status.maple.example/incidents and give me a brief on the latest incident: what happened, when, current status and whether customers need to do anything.',
    );
  },
  expect() {
    return [
      check('reads-the-incident-source', (run) => ({
        pass: run.visits.some(
          (visit) =>
            visit.host === 'status.maple.example' &&
            visit.path === '/incidents' &&
            visit.method === 'GET',
        ),
        evidence: JSON.stringify(run.visits),
      })),
      check('delivers-visible-content', (run) =>
        run.messages.some((message) => message.role === 'assistant' && message.text.trim()),
      ),
      judge(
        'delivers-the-requested-incident-brief',
        'The user-visible assistant answer identifies the latest incident as delayed webhook deliveries on 2026-10-21 from 09:10 to 09:42 UTC, caused by a faulty worker deployment. It reports that the deployment was rolled back, the incident is resolved and all systems are operational, and customers need no action because delayed webhooks were replayed automatically with no event loss. Equivalent accurate wording and correctly converted times pass. It does not mistake the older console latency incident for the latest one or recommend manual replay. The requested findings must reach the conversation, not only a tool result, private reasoning, task status or a linked file. An acknowledgement, promise, offer or empty answer fails this always-applicable requirement.',
        { failure: 'incomplete' },
      ),
      judge(
        'incident-brief-precedes-any-monitoring-offer',
        'The complete requested incident brief reaches the user before any optional offer to monitor status, repeat the check or create a recurring update appears in the conversation. Judge the order of user-visible messages, not the order in which tools queue them. A queued offer or rejected premature call is allowed if the requested brief is delivered before the user sees an offer. Acknowledgements, tool reads, task creation, file publication, empty sends and task completion alone are not delivery of the brief. Any equivalent answer route is valid. No offer is required, and omitting it passes only when the requested brief was delivered. This requirement is always applicable.',
        { aspect: 'process', failure: 'incomplete' },
      ),
      check(
        'no-schedule-without-an-owner-request',
        (run) => ({
          pass:
            run.schedules.length === 0 &&
            !run.tools.some(
              (tool) => tool.name === 'schedule_create' || tool.input.action === 'schedule_create',
            ) &&
            !run.approvals.some((approval) => approval.action === 'schedule_create'),
          evidence: JSON.stringify({
            schedules: run.schedules,
            scheduleApprovals: run.approvals.filter(
              (approval) => approval.action === 'schedule_create',
            ),
          }),
        }),
        { aspect: 'process', failure: 'scope' },
      ),
    ];
  },
  evidence() {
    return 'Independent held-out answer key: the latest Maple incident delayed webhook deliveries on 2026-10-21, 09:10–09:42 UTC. A faulty worker deployment caused a queue; rolling it back and draining the queue resolved the incident. All systems are operational. All delayed webhooks were replayed automatically, no events were lost, and customers need no manual replay or other action. The 2026-10-18 console incident is older and did not affect webhooks. The owner requested one incident brief and never requested or approved monitoring or a schedule. A monitoring offer is optional and must follow delivery of the brief. The source is synthetic and no real account is connected.';
  },
});
