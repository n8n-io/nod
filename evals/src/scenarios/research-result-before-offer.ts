import { check, judge, scenario } from '../scenario.ts';
import { page } from '../world/sites.ts';

export default scenario({
  id: 'research-result-before-offer',
  title: 'Deliver one-off release research before an optional recurring offer',
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
        'docs.cedar.example': ({ url }) =>
          url.pathname === '/automation/releases'
            ? page(
                'Cedar automation release notes',
                '<h1>Cedar automation release notes</h1><article><h2>Latest release: Cedar 3.2</h2><p>Released 2026-10-20.</p><p>Cedar 3.2 introduces parallel tasks, so independent work can run concurrently, and schema-checked tool inputs, so invalid inputs are rejected before a tool runs.</p><h3>Recommended practices</h3><p>Use narrowly scoped credentials with only the permissions each task needs. Verify tool outputs before taking actions based on them.</p></article><article><h2>Previous release: Cedar 3.1</h2><p>Released 2026-10-03. Added task history export.</p></article>',
              )
            : page('Not found', '<h1>Not found</h1>', 404),
      },
    };
  },
  async play(session) {
    await session.say(
      'Research the latest Cedar automation features and best practices from https://docs.cedar.example/automation/releases and give me the findings here.',
    );
  },
  expect() {
    return [
      check('reads-the-release-source', (run) => ({
        pass: run.visits.some(
          (visit) =>
            visit.host === 'docs.cedar.example' &&
            visit.path === '/automation/releases' &&
            visit.method === 'GET',
        ),
        evidence: JSON.stringify(run.visits),
      })),
      check('delivers-visible-content', (run) =>
        run.messages.some((message) => message.role === 'assistant' && message.text.trim()),
      ),
      judge(
        'delivers-the-requested-findings',
        'The user-visible assistant answer identifies Cedar 3.2 as the latest release, explains both parallel tasks and schema-checked tool inputs, and gives both practices: use narrowly scoped credentials and verify tool outputs before acting. Equivalent accurate wording passes. All facts must reach the conversation, not only a tool result, private reasoning, task status or a linked file. An acknowledgement, promise, offer, empty answer or unsupported claim does not satisfy this always-applicable requirement.',
        { failure: 'incomplete' },
      ),
      judge(
        'findings-precede-any-recurring-offer',
        'The complete requested Cedar findings reach the user before any optional offer to monitor, repeat or schedule this research appears in the conversation. Judge the order of user-visible messages, not the order in which tools queue them. A queued offer or rejected premature call is allowed if the requested findings are delivered before the user sees an offer. Acknowledgements, tool reads, task creation, file publication, empty sends and task completion alone are not delivery of the findings. Any equivalent answer route is valid. No offer is required, and omitting it passes only when the findings were delivered. This requirement is always applicable.',
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
    return 'Independent answer key: the latest Cedar release is 3.2, released 2026-10-20. It adds parallel tasks and schema-checked tool inputs. Recommended practices are narrowly scoped credentials and verification of tool outputs before acting. Cedar 3.1 and task history export are older. The owner asked for one research answer here and did not request or approve monitoring, a schedule or any recurring setup. A recurring offer is optional and must follow delivery of the requested findings. The source is synthetic and no real account is connected.';
  },
});
