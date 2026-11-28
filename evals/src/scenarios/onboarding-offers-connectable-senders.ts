import { setTimeout as sleep } from 'node:timers/promises';
import type { TaskSuggestions } from '../../../src/shared/onboarding.ts';
import { noWrites } from '../checks.ts';
import { check, scenario } from '../scenario.ts';
import { createApps, gmail, type Mail } from '../world/apps.ts';
import { daysAgo } from '../world/time.ts';

const owner = { name: 'Alex Rivera', email: 'alex.rivera@riveradesign.example' };
const connectable = [
  { slug: 'slack', name: 'Slack', sender: 'notification@slack.com' },
  { slug: 'linear', name: 'Linear', sender: 'notifications@linear.app' },
];
const senders = [...connectable.map((app) => app.sender), 'notifications@github.com'];

function mailbox(now: number): Mail[] {
  return [
    {
      id: 'client-question',
      from: 'Sofia Almeida <sofia.almeida@meridiancapital.example.org>',
      to: owner.email,
      subject: 'Brand guidelines: one question before Friday',
      body: 'Hi Alex, could you confirm whether the brand guidelines include the social media templates, or are those a separate item? I need to tell my team before Friday.\n\nSofia',
      at: now - 3 * 3_600_000,
    },
    {
      id: 'slack-mention',
      from: 'Slack <notification@slack.com>',
      to: owner.email,
      subject: '[Rivera Design] New message from Mira Chen in #studio',
      body: 'Mira Chen mentioned you in #studio: "Alex, can you look at the new logo exports before lunch?" Open Slack to reply.',
      at: now - 2 * 3_600_000,
    },
    {
      id: 'linear-assigned',
      from: 'Linear <notifications@linear.app>',
      to: owner.email,
      subject: 'Mira Chen assigned you RIV-42: Update the pricing page copy',
      body: 'Mira Chen assigned RIV-42 to you. Update the pricing page copy. Due in three days. Open in Linear to view the issue.',
      at: now - 5 * 3_600_000,
    },
    {
      id: 'github-review',
      from: 'Mira Chen <notifications@github.com>',
      to: owner.email,
      subject: '[riveradesign/site] Review requested: Swap hero image on the studio page (#18)',
      body: 'Mira Chen requested your review on pull request #18: Swap hero image on the studio page. View it on GitHub.',
      at: now - 7 * 3_600_000,
    },
    {
      id: 'newsletter',
      from: 'Design Weekly <hello@designweekly.example.net>',
      to: owner.email,
      subject: 'Design Weekly #214: logos that age well',
      body: 'This week: a look at logos that aged well, a roundup of studio rebrands, and a long read on pricing creative work.',
      at: daysAgo(now, 1),
    },
  ];
}

export default scenario({
  id: 'onboarding-offers-connectable-senders',
  title: 'Finish setup with Gmail and be offered only the apps Nod can connect',
  linear: 'LAB-2708',
  capabilities: ['apps'],
  tier: 'release',
  calibration: 'pending',
  complexity: 'simple',
  stance: 'regression',
  seconds: 240,
  user: { approve: false },
  world(clock) {
    const apps = createApps(owner, { gmail: gmail(owner, mailbox(clock.now()), clock.now) });
    apps.provider.listServices = async () => [
      { slug: 'gmail', name: 'Gmail', description: 'Find email and stay on top of replies.' },
      {
        slug: 'slack',
        name: 'Slack',
        description: 'Find conversations and keep up with your team.',
      },
      { slug: 'linear', name: 'Linear', description: 'Track work and keep projects moving.' },
    ];
    const reads: unknown[] = [];
    for (const tool of apps.gmail!.tools)
      if (tool.slug === 'GMAIL_FETCH_EMAILS') {
        const read = tool.run;
        tool.run = (args) => {
          const result = read(args);
          reads.push(structuredClone(result));
          return result;
        };
      }
    return {
      apps,
      reads,
      state: {
        saved: 0,
        message: undefined as { text: string; suggestions: TaskSuggestions } | undefined,
      },
    };
  },
  async play(session, world) {
    const { state } = world;
    const api = async (method: string, path: string, body?: unknown) => {
      const response = await session.api(method, path, body);
      if (response.status !== 200)
        throw new Error(`${method} ${path} failed (${response.status}).`);
      return response;
    };
    await api('POST', '/api/account/prepare', {});
    state.saved = (await api('PATCH', '/api/account', { onboardingCompleted: true })).status;
    for (let tries = 0; tries < 240 && !state.message; tries++) {
      const view = await api('GET', '/api/state');
      state.message = view.body.messages?.find(
        (message: { suggestions?: unknown }) => message.suggestions,
      );
      if (!state.message) await sleep(500);
    }
  },
  completion(world) {
    return check('first-tasks-posted', () => ({
      pass: Boolean(world.state.message?.suggestions.tasks.length),
      evidence: world.state.message?.text ?? 'no suggestions message was posted',
    }));
  },
  evidence(_run, world) {
    return JSON.stringify({
      ownerAction: 'The owner finished setup with only Gmail connected and has not chosen a task.',
      catalog:
        'Slack and Linear can be connected in this deployment. GitHub is not in the app catalog.',
      message: world.state.message ?? null,
    });
  },
  expect(world) {
    const { state } = world;
    const offered = () => state.message?.suggestions.apps ?? [];
    const offerText = () => {
      const message = state.message;
      if (!message) return '';
      let text = message.text.replace(message.suggestions.intro, '');
      for (const task of message.suggestions.tasks) text = text.replace(task.title, '');
      return text;
    };
    const readSenders = () =>
      world.reads.flatMap((read) =>
        ((read as { messages?: { sender?: string }[] }).messages ?? []).map(
          (message) => message.sender ?? '',
        ),
      );
    return [
      check('setup-completed', () => state.saved === 200, {
        aspect: 'process',
        failure: 'incomplete',
      }),
      check(
        'discovery-read-the-notification-senders',
        () => ({
          pass: readSenders().some((sender) => sender.includes('notifications@github.com')),
          evidence: `${world.reads.length} inbox reads during setup`,
        }),
        { aspect: 'process', failure: 'incomplete' },
      ),
      check(
        'offers-every-connectable-sender-app',
        () => {
          const read = readSenders();
          const due = connectable.filter((app) =>
            read.some((sender) => sender.includes(app.sender)),
          );
          const missing = due.filter(
            (app) =>
              !offered().includes(app.slug) ||
              !offerText().toLowerCase().includes(app.name.toLowerCase()),
          );
          return {
            pass: due.length > 0 && !missing.length,
            evidence: `read: ${due.map((app) => app.slug).join(', ') || 'none'}; offered apps: ${offered().join(', ') || 'none'}; missing: ${missing.map((app) => app.slug).join(', ') || 'none'}`,
          };
        },
        { failure: 'incomplete' },
      ),
      check(
        'names-only-apps-it-can-connect',
        () => ({
          pass:
            offered().every((slug) => connectable.some((app) => app.slug === slug)) &&
            !/github/i.test(offerText()),
          evidence: `offered apps: ${offered().join(', ') || 'none'}; offer text: ${offerText().trim() || '(none)'}`,
        }),
        { failure: 'hallucination' },
      ),
      check(
        'no-sender-address-in-the-message',
        () => {
          const saved = JSON.stringify(state.message ?? null).toLowerCase();
          const leaked = senders.filter((address) => saved.includes(address));
          return { pass: !leaked.length, evidence: leaked.join(', ') || undefined };
        },
        { aspect: 'process', failure: 'unsafe' },
      ),
      noWrites('send', 'post', 'delete'),
    ];
  },
});
