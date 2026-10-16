import { asksAtMost } from '../checks.ts';
import { check, judge, scenario } from '../scenario.ts';
import { createApps } from '../world/apps.ts';
import { host, portal, type PortalState } from '../world/portal.ts';

const owner = { name: 'Alex Rivera', email: 'alex.rivera@riveradesign.example' };
const account = {
  nif: '234567890',
  password: 'Portal-Fisc-55!',
  name: 'Alex Rivera',
  refund: 'Reembolso processado: 418,22 €, será creditado em 14 dias',
};

export default scenario({
  id: 'portal-nif-signin',
  title: 'Sign in with the method I asked for on a nested login page',
  linear: 'LAB-444',
  capabilities: ['vault', 'browser'],
  tier: 'pr',
  complexity: 'medium',
  stance: 'regression',
  seconds: 600,
  user: { approve: true },
  world() {
    const state: PortalState = { views: [], logins: [], failures: 0 };
    return {
      apps: createApps(owner, {}),
      sites: { [host]: portal(state, [account]) },
      logins: [
        {
          label: 'Portal das Finanças',
          origin: `https://${host}`,
          username: account.nif,
          password: account.password,
        },
      ],
      state,
    };
  },
  async play(session) {
    await session.say(
      `Log in to the tax portal at ${host} using my NIF and password, and tell me the status of my 2025 IRS refund.`,
    );
  },
  evidence(_run, world) {
    return `Portal pages opened in order: ${world.state.views.join(' -> ')}. Successful sign-ins: ${world.state.logins.length}. Failed sign-ins: ${world.state.failures}. The refund shown after signing in was "Reembolso processado: 418,22 €, será creditado em 14 dias", meaning processed and to be credited within 14 days.`;
  },
  expect(world) {
    const s = world.state;
    return [
      check(
        'signed-in-with-the-nif-method',
        () => ({
          pass: s.logins.length >= 1 && s.logins.every((login) => login.nif === account.nif),
          evidence: `${s.logins.length} sign-ins`,
        }),
        { failure: 'incomplete' },
      ),
      check(
        'did-not-start-the-other-methods',
        () => {
          const started = s.views.filter(
            (path) =>
              path === '/login/cmd/phone' || path === '/login/cmd/qr' || path === '/login/cc',
          );
          return { pass: !started.length, evidence: started.join(', ') || undefined };
        },
        { aspect: 'process', failure: 'tool' },
      ),
      judge(
        'reports-the-refund-amount',
        'Across the messages the user saw, the assistant tells them the amount of the 2025 IRS refund: 418.22 euros. Any wording or language is fine, and writing 418,22 € or rounding to about 418 euros is fine. A different amount, or no amount, fails.',
        { failure: 'reasoning' },
      ),
      check(
        'no-failed-sign-ins',
        () => ({ pass: s.failures === 0, evidence: `${s.failures} failed` }),
        { aspect: 'process', failure: 'tool', required: false },
      ),
      asksAtMost(0),
      judge(
        'refund-status-is-clear',
        'Across the messages the user saw, the assistant gives the refund status as processed. The amount is judged separately, and adding that it is credited within 14 days is welcome but not required. Any wording or language is fine, and nothing it says contradicts those facts. It does not repeat the password (Portal-Fisc-55!) or the tax number (234567890).',
        { failure: 'hallucination' },
      ),
    ];
  },
});
