import { urlsGrounded } from '../checks.ts';
import { check, judge, scenario } from '../scenario.ts';
import { createApps } from '../world/apps.ts';

const owner = { name: 'Alex Rivera', email: 'alex.rivera@riveradesign.example' };

export default scenario({
  id: 'youtube-topics',
  title: 'Recent YouTube videos on a theme, grouped into topics',
  linear: 'LAB-383',
  capabilities: ['research', 'progress', 'files'],
  tier: 'live',
  complexity: 'complex',
  stance: 'regression',
  seconds: 1500,
  calibration: 'pending',
  user: {
    approve: true,
    persona:
      'You are Alex Rivera. A grouped list with links and a one-line takeaway per topic is plenty.',
  },
  world: () => ({ apps: createApps(owner, {}) }),
  async play(session) {
    await session.say(
      'Find the YouTube videos about n8n from the last 30 days, group them into topics, and tell me what is trending.',
    );
  },
  evidence(run) {
    const { cited, invented } = urlsGrounded(run);
    return `The final answer cites ${cited} links; ${invented.length} of them do not appear in any tool result${invented.length ? `: ${invented.slice(0, 5).join(', ')}` : ''}. Tool calls used: ${[...new Set(run.tools.map((call) => call.name))].join(', ')}.`;
  },
  expect() {
    return [
      check(
        'cites-at-least-five-youtube-links',
        (run) => {
          const links = new Set(
            [
              ...run.said.matchAll(
                /https?:\/\/(?:www\.)?(?:youtube\.com\/watch\?v=|youtu\.be\/)[\w-]+/g,
              ),
            ].map((match) => match[0]),
          );
          return { pass: links.size >= 5, evidence: `${links.size} distinct video links` };
        },
        { failure: 'incomplete' },
      ),
      check(
        'every-link-came-from-a-tool-result',
        (run) => {
          const { invented } = urlsGrounded(run);
          return {
            pass: invented.length === 0,
            evidence: invented.length
              ? `not found in any tool result: ${invented.slice(0, 3).join(', ')}`
              : undefined,
          };
        },
        { failure: 'hallucination' },
      ),
      judge(
        'videos-are-grouped-into-real-topics',
        'The answer groups the videos into sensible topics (any number and layout), each topic names the videos that belong to it, the grouping makes sense from the video titles, and there is a short statement of what is trending. It does not list videos without grouping them.',
        { failure: 'reasoning' },
      ),
      judge(
        'claims-are-supported-and-recent',
        'Video titles, channels and dates stated in the answer are supported by what the tools returned (the ground truth lists any link that was not). It respects the last-30-days window, or says plainly where it could not confirm dates.',
        { failure: 'hallucination' },
      ),
    ];
  },
});
