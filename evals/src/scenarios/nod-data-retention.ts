import { judge, scenario } from '../scenario.ts';
import { createApps } from '../world/apps.ts';

export default scenario({
  id: 'nod-data-retention',
  title: 'Explain Nod’s confirmed retention policy and the app-connection tradeoff',
  linear: 'LAB-1085',
  capabilities: ['apps', 'progress'],
  tier: 'pr',
  complexity: 'simple',
  stance: 'regression',
  calibration: 'pending',
  seconds: 180,
  user: { approve: false },
  world: () => ({
    apps: createApps({ name: 'Alex Rivera', email: 'alex@studio.example' }, {}),
  }),
  async play(session) {
    await session.say(
      'I am reviewing privacy before connecting my email to Nod. What data-retention agreement does Nod have with Customer.io? How does that relate to Composio receiving data when I connect apps? Explain what is confirmed for Nod rather than just generic vendor defaults. Just answer here; do not connect an app or change anything.',
    );
  },
  evidence() {
    return 'LAB-1085 confirms that Nod has a zero data retention policy with Customer.io. The same human decision acknowledges that passing app data through Composio is the tradeoff for simple app connections. It does not establish a zero data retention agreement with Composio or any other service. These facts are judge-only ground truth, not information supplied by the owner or a fake tool.';
  },
  expect() {
    return [
      judge(
        'knows-customer-io-zero-data-retention-policy',
        'The delivered answer states that Nod has a zero data retention policy with Customer.io as a confirmed Nod-specific fact. Saying only that a vendor offers zero retention, that Nod’s agreement is unknown or unverified, or that the owner must first check with the Nod team fails. Assess the meaning, not exact wording.',
        { failure: 'incomplete' },
      ),
      judge(
        'distinguishes-composio-data-processing-from-customer-io-retention',
        'The answer explains that app data passes through Composio to make app connections simple. It keeps that processing tradeoff distinct from the confirmed Customer.io retention policy, without claiming that the Customer.io agreement also proves zero retention for Composio, connected apps, model providers or all Nod data. Assess the meaning, not exact wording.',
        { failure: 'hallucination' },
      ),
    ];
  },
});
