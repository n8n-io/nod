import { asksAtMost } from '../checks.ts';
import { check, judge, scenario } from '../scenario.ts';
import { createApps } from '../world/apps.ts';
import { host, portal, type PortalState } from '../world/portal.ts';

const owner = { name: 'Alex Rivera', email: 'alex.rivera@riveradesign.example' };
const account = {
  nif: '234567890',
  password: 'Portal-Fisc-55!',
  name: 'Alex Rivera',
  refund: 'Reembolso processado: 418,22 € creditado em 14 dias',
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
    return `Portal pages opened in order: ${world.state.views.join(' -> ')}. Successful sign-ins: ${world.state.logins.length}. Failed sign-ins: ${world.state.failures}. The refund shown after signing in was "418,22 € creditado em 14 dias".`;
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
      check(
        'reports-the-refund-amount',
        (run) => ({
          pass: /418[.,]22/.test(run.said),
          evidence: 'the refund of 418,22 € must be reported',
        }),
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
        'The answer gives the refund status plainly: processed, 418.22 euros, credited within 14 days. It does not repeat the password or tax number.',
        { failure: 'hallucination' },
      ),
    ];
  },
});
