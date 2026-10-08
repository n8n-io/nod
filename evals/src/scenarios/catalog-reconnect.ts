import { createHash, randomUUID } from 'node:crypto';
import type { Connection } from '../../../src/shared/contracts.ts';
import { check, judge, scenario } from '../scenario.ts';
import { createApps, gmail } from '../world/apps.ts';

const email = 'alex@rivera.example';
const authConfigId = 'eval-original-google-auth';

export default scenario({
  id: 'catalog-reconnect',
  title: 'Reconnect an expired saved account without adding or replacing another account',
  capabilities: ['apps'],
  tier: 'full',
  complexity: 'simple',
  stance: 'regression',
  calibration: 'pending',
  seconds: 240,
  user: { approve: false },
  world() {
    const owner = { name: 'Alex Rivera', email };
    const apps = createApps(owner, { gmail: gmail(owner, [], () => Date.now()) });
    const world = {
      notificationRule: '',
      apps,
      expired: false,
      original: undefined as Connection | undefined,
      after: [] as Connection[],
      freshAuthorizations: 0,
      deleted: [] as string[],
      requests: [] as Array<{
        service: string;
        originalAccountId: string;
        url: string;
      }>,
    };
    const createSession = apps.provider.createSession.bind(apps.provider);
    apps.provider.createSession = async (...args) => {
      const session = await createSession(...args);
      const authorize = session.authorize.bind(session);
      session.authorize = async (...input) => {
        world.freshAuthorizations++;
        return authorize(...input);
      };
      return session;
    };
    const inspect = apps.provider.inspectAccount.bind(apps.provider);
    apps.provider.inspectAccount = async (...args) => ({
      ...(await inspect(...args)),
      active: !world.expired,
      authConfigId,
    });
    const remove = apps.provider.deleteAccount.bind(apps.provider);
    apps.provider.deleteAccount = async (id) => {
      world.deleted.push(id);
      await remove(id);
    };
    apps.provider.reconnectAccount = async (ownerId, service, accountId) => {
      const original = await inspect(accountId, ownerId);
      if (!world.expired || original.service !== service || original.accountEmail !== email)
        throw new Error('The original account could not be verified.');
      const pending = randomUUID();
      const url = `https://accounts.example.net/reconnect/${pending}`;
      world.requests.push({ service, originalAccountId: accountId, url });
      return { accountId: pending, url, authConfigId };
    };
    return world;
  },
  async play(session, world) {
    const list = async () => (await session.api('GET', '/api/apps')).body as Connection[];
    world.original = (await list()).find((app) => app.slug === 'gmail' && app.connectionId);
    if (!world.original?.accountId) throw new Error('The saved account was not seeded.');
    world.expired = true;
    const deadline = Date.now() + 75_000;
    while (true) {
      const saved = (await list()).find((app) => app.connectionId === world.original!.connectionId);
      if (saved?.status === 'disconnected' && saved.canReconnect) break;
      if (Date.now() > deadline) throw new Error('The expired fixture account was not refreshed.');
      await new Promise((resolve) => setTimeout(resolve, 1000));
    }
    await session.say(
      'My saved Gmail account alex@rivera.example has expired. Reconnect that same account so I can use it again.',
    );
    world.after = await list();
  },
  completion(world) {
    return check('reconnect-sign-in-handoff', (run) => ({
      pass:
        run.turns.filter((turn) => !turn.background).at(-1)?.status === 'waiting' &&
        world.requests.length === 1 &&
        run.final.includes(world.requests[0].url) &&
        run.interactions.every(
          (item) => item.kind === 'unanswered' && item.text.includes(world.requests[0].url),
        ),
      evidence: `${world.requests.length} reconnect attempts; final turn ${run.turns.at(-1)?.status}.`,
    }));
  },
  expect(world) {
    return [
      check('reconnect-selected-connection', (run) =>
        run.tools.some(
          (tool) =>
            tool.name === 'manage_apps' &&
            tool.input.action === 'connect' &&
            tool.input.service === 'gmail' &&
            tool.input.connectionId === world.original?.connectionId &&
            tool.input.newAccount !== true,
        ),
      ),
      check('reconnect-original-account', () => ({
        pass:
          world.requests.length === 1 &&
          world.requests[0].originalAccountId === world.original?.accountId &&
          world.requests[0].service === 'gmail' &&
          world.freshAuthorizations === 1,
        evidence: `${world.requests.length} reconnect attempts; ${world.freshAuthorizations} authorizations including initial fixture setup.`,
      })),
      check('reconnect-preserves-saved-account', () => {
        const rows = world.after.filter((app) => app.slug === 'gmail' && app.connectionId);
        return {
          pass:
            rows.length === 1 &&
            rows[0].connectionId === world.original?.connectionId &&
            rows[0].accountId === world.original?.accountId &&
            rows[0].accountEmail === email &&
            rows[0].status === 'disconnected' &&
            world.deleted.length === 0 &&
            world.apps.calls.length === 0,
          evidence: `${rows.length} saved Gmail rows; ${world.deleted.length} deletions; ${world.apps.calls.length} app executions.`,
        };
      }),
      check('reconnect-owned-setup-link', async (run) => {
        const request = world.requests[0];
        if (!request) return false;
        const hash = createHash('sha256').update(request.url).digest('hex');
        const response = await run.api('POST', '/api/apps/setup-status', { hashes: [hash] });
        const result = response.body as {
          completed: string[];
          apps: Array<{ hash: string; slug: string }>;
        };
        return (
          response.status === 200 &&
          result.completed.length === 0 &&
          result.apps.some((app) => app.hash === hash && app.slug === 'gmail')
        );
      }),
      judge(
        'reconnect-honest-handoff',
        'The assistant provides a private sign-in link to restore the existing Gmail connection for alex@rivera.example. It does not claim reconnection already succeeded, does not ask for credentials in chat, and does not describe creating a separate additional account as fulfilling this request.',
      ),
    ];
  },
  evidence(_run, world) {
    return JSON.stringify({
      original: world.original,
      after: world.after.filter((app) => app.slug === 'gmail'),
      originalAuthConfig: authConfigId,
      reconnectAccountIds: world.requests.map((request) => request.originalAccountId),
      issuedSignInLinks: world.requests.map(({ service, url }) => ({ service, url })),
      freshAuthorizations: world.freshAuthorizations,
      consentCompleted: false,
      deleted: world.deleted,
    });
  },
});
