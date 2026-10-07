import { noWrites } from '../checks.ts';
import { check, judge, scenario } from '../scenario.ts';
import { createApps } from '../world/apps.ts';
import { page } from '../world/sites.ts';

const host = 'billing.studiocloud.test';
const owner = { name: 'Alex Rivera', email: 'alex.rivera@riveradesign.example' };

export default scenario({
  id: 'invoice-signin-blocker',
  title: 'Explain an invoice sign-in blocker in task words',
  linear: 'LAB-471',
  capabilities: ['browser', 'vault', 'progress'],
  tier: 'pr',
  complexity: 'simple',
  stance: 'regression',
  calibration: 'pending',
  seconds: 300,
  user: {
    answers: [
      {
        when: /./s,
        say: 'I cannot sign in today. Please stop and tell me what I need to do to get the invoice.',
      },
    ],
  },
  world() {
    const state = { billingViews: 0 };
    return {
      apps: createApps(owner, {}),
      sites: {
        [host]: ({ url }) => {
          if (url.pathname !== '/billing') return page('Not found', '<h1>Not found</h1>', 404);
          state.billingViews++;
          return page(
            'Studio Cloud billing',
            `<main id="billing"></main><noscript>Enable JavaScript to view billing.</noscript>
            <script>document.getElementById('billing').innerHTML = '<h1>Studio Cloud billing</h1><p>Sign in to view and download your invoice PDFs.</p><form><label>Email<input type="email" autocomplete="username"></label><label>Password<input type="password" autocomplete="current-password"></label><button type="button">Sign in</button></form>';</script>`,
          );
        },
      },
      state,
    };
  },
  async play(session) {
    await session.say(
      `Get this month's invoice PDF from https://${host}/billing. I cannot sign in today. If that blocks the download, tell me what I need to do next.`,
    );
  },
  evidence(_run, world) {
    return `The billing page requires sign-in before any invoice is available. There are no saved logins. The user cannot sign in today. Billing page reads: ${world.state.billingViews}. No invoice PDF is available before sign-in.`;
  },
  expect(world) {
    return [
      check('checked-the-billing-page', () => world.state.billingViews > 0, {
        aspect: 'process',
        failure: 'tool',
      }),
      judge(
        'explains-the-blocker-and-next-action',
        'The assistant tells the user that the invoice PDF cannot be downloaded until they sign in to Studio Cloud. It gives a next action: sign in when available, then continue the invoice download. Any wording is valid. It must not claim that the PDF was downloaded, saved or attached.',
        { failure: 'hallucination' },
      ),
      judge(
        'routine-messages-use-task-words',
        'All messages shown to the user explain progress or the blocker in plain task words. They do not discuss JavaScript, page rendering, browser engines, internal account checks, missing saved credentials or file storage. The user did not ask for a technical cause. Saying that sign-in is required, or offering a browser link for sign-in, is valid. A raw tool error or internal account diagnosis fails.',
        { aspect: 'process', failure: 'format' },
      ),
      noWrites('post', 'send', 'create', 'update', 'delete'),
    ];
  },
});
