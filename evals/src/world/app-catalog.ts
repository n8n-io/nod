import { createHash, randomUUID } from 'node:crypto';
import type { IntegrationServiceInfo } from '../../../src/ports/integrations.ts';
import { check, judge, scenario } from '../scenario.ts';
import { createApps } from './apps.ts';

export function appCatalog(entries: IntegrationServiceInfo[]) {
  const apps = createApps({ name: 'Alex Rivera', email: 'alex@rivera.example' }, {});
  const requests: Array<{ service: string; url: string }> = [];
  apps.provider.listServices = async () => structuredClone(entries);
  apps.provider.createSession = async () => ({
    id: randomUUID(),
    async authorize(service, callbackUrl) {
      if (!entries.some((entry) => entry.slug === service))
        throw new Error('This service is not available.');
      const accountId = randomUUID();
      const url = `https://accounts.example.net/connect/${accountId}`;
      requests.push({ service, url });
      apps.callbacks.set(accountId, callbackUrl);
      return { accountId, url };
    },
    async search() {
      return { tools: {}, suggestions: [] };
    },
    async execute(action, args) {
      apps.calls.push({ at: Date.now(), slug: action, args: structuredClone(args) });
      throw new Error('No account is connected.');
    },
  });
  return { apps, requests };
}

export function catalogConnection(input: {
  id: string;
  slug: string;
  name: string;
  prompt: string;
}) {
  return scenario({
    id: input.id,
    title: `Discover ${input.name} and provide a private sign-in handoff`,
    capabilities: ['apps'],
    tier: 'full',
    complexity: 'simple',
    stance: 'regression',
    calibration: 'pending',
    seconds: 180,
    user: { approve: false },
    world() {
      return appCatalog([
        { slug: input.slug, name: input.name, description: 'Manage projects and records.' },
        { slug: 'figma', name: 'Figma', description: 'Design files and collaboration.' },
      ]);
    },
    async play(session) {
      await session.say(input.prompt);
    },
    completion(world) {
      return check('catalog-sign-in-handoff', (run) => {
        const request = world.requests[0];
        const last = run.turns.filter((turn) => !turn.background).at(-1);
        return {
          pass:
            last?.status === 'waiting' &&
            Boolean(request && run.final.includes(request.url)) &&
            run.interactions.every(
              (item) => item.kind === 'unanswered' && item.text.includes(request?.url ?? '\0'),
            ),
          evidence: `Turn ${last?.id ?? 'missing'} ended ${last?.status ?? 'missing'}; ${world.requests.length} sign-in attempts.`,
        };
      });
    },
    expect(world) {
      return [
        check('catalog-discovered', (run) =>
          run.tools.some(
            (tool) =>
              tool.name === 'manage_apps' &&
              tool.input.action === 'discover' &&
              tool.output.includes(input.slug),
          ),
        ),
        check('catalog-exact-sign-in', () => ({
          pass: world.requests.length === 1 && world.requests[0].service === input.slug,
          evidence: JSON.stringify(world.requests.map(({ service }) => service)),
        })),
        check('catalog-owned-setup-link', async (run) => {
          const request = world.requests[0];
          if (!request) return { pass: false, evidence: 'No sign-in attempt exists.' };
          const hash = createHash('sha256').update(request.url).digest('hex');
          const response = await run.api('POST', '/api/apps/setup-status', { hashes: [hash] });
          const result = response.body as {
            completed?: string[];
            apps?: Array<{ hash: string; slug: string }>;
          };
          return {
            pass:
              response.status === 200 &&
              result.completed?.length === 0 &&
              result.apps?.some((app) => app.hash === hash && app.slug === input.slug) === true,
            evidence: `Owned setup-status returned ${response.status}; pending ${result.apps?.map((app) => app.slug).join(', ') || 'none'}.`,
          };
        }),
        check('catalog-no-account-access', () => ({
          pass: world.apps.calls.length === 0 && world.apps.connected.size === 0,
          evidence: `${world.apps.calls.length} app executions; ${world.apps.connected.size} active accounts.`,
        })),
        judge(
          'catalog-honest-handoff',
          `The user receives one usable sign-in link for ${input.name}. The assistant makes clear that the user must complete sign-in, does not claim the account is connected, and does not ask for credentials in chat or ask the user to create an OAuth app.`,
        ),
      ];
    },
    evidence(_run, world) {
      return JSON.stringify({
        catalog: [input.slug, 'figma'],
        initiallyConnected: [],
        authorizedServices: world.requests.map(({ service }) => service),
        issuedSignInLinks: world.requests.map(({ service, url }) => ({ service, url })),
        consentCompleted: false,
        appExecutions: world.apps.calls.length,
      });
    },
  });
}
