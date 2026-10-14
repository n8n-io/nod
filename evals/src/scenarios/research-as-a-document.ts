import { basename } from 'node:path';
import { mentions, tasksDone } from '../checks.ts';
import { check, judge, scenario } from '../scenario.ts';
import type { Run } from '../trace.ts';
import { createApps } from '../world/apps.ts';
import { page, type Site } from '../world/sites.ts';

const owner = { name: 'Alex Rivera', email: 'alex.rivera@riveradesign.example' };
const host = 'kestrelrouting.example.org';
const shortResult = 1200;

const pages: Record<string, [string, string]> = {
  '/': [
    'Route planning for regional food and drink distributors',
    '<p>Plan delivery routes for fleets of 5 to 200 trucks.</p><p>Used by 140 distributors in the Netherlands, Belgium and Germany.</p><p><a href="/pricing">Start free</a> or <a href="/pricing">talk to sales</a>.</p>',
  ],
  '/pricing': [
    'Pricing',
    '<table><tr><th>Plan</th><th>Price</th><th>For</th></tr><tr><td>Starter</td><td>Free</td><td>1 depot and up to 5 vans</td></tr><tr><td>Growth</td><td>€29 per vehicle per month, billed yearly. Start a 14-day free trial, no sales call.</td><td>Unlimited depots, up to 40 vehicles</td></tr><tr><td>Enterprise</td><td>From €24,000 per year. Talk to sales.</td><td>Annual contract, SSO, ERP integration and a dedicated success manager</td></tr></table><p>Fleets of more than 40 vehicles move to Enterprise.</p>',
  ],
  '/customers': [
    'Customers',
    '<div class="card"><h3>Van Aalst Vers, Utrecht</h3><p>60 trucks. 11% fewer kilometres in the first quarter. Started on Growth and moved to Enterprise.</p></div><div class="card"><h3>Brasserie Logistique, Liège</h3><p>35 trucks on Growth.</p></div><div class="card"><h3>Kühlhaus Nordhafen, Hamburg</h3><p>120 trucks. Our first enterprise customer in Germany, signed in March.</p></div>',
  ],
  '/partners': [
    'Partner programme',
    '<p>ERP consultancies that resell or refer Kestrel get 20% of the first-year subscription.</p><p>Certified partners: Noordlicht ERP, Delta Integraties and Hafenwerk IT in Hamburg.</p><p>Kestrel is listed in the FoodERP marketplace.</p>',
  ],
  '/blog': [
    'Blog',
    '<div class="card"><h3>Kestrel opens a Berlin office</h3><p>Our new team serves distributors in Germany, Austria and Switzerland.</p></div><div class="card"><h3>Webinar: cutting empty miles</h3><p>Every month with the Dutch Food Wholesale Association.</p></div><div class="card"><h3>Try the free route-cost calculator</h3><p>See what your routes cost per drop in two minutes.</p></div>',
  ],
  '/careers': [
    'Careers',
    "<ul><li>4 Sales Development Representatives, German-speaking, Berlin</li><li>Partner Manager DACH, Berlin</li><li>Account Executive, Enterprise, Utrecht</li></ul><p>We don't hire for paid advertising: our pipeline comes from partners, events and outbound.</p>",
  ],
};

const kestrel: Site = ({ url }) => {
  const header =
    '<header><h1>Kestrel Routing</h1><nav><a href="/">Home</a> <a href="/pricing">Pricing</a> <a href="/customers">Customers</a> <a href="/partners">Partners</a> <a href="/blog">Blog</a> <a href="/careers">Careers</a></nav></header>';
  const found = pages[url.pathname];
  return found
    ? page(`${found[0]} · Kestrel Routing`, `${header}<h2>${found[0]}</h2>${found[1]}`)
    : page('Not found', `${header}<p>Page not found.</p>`, 404);
};

const ids = { turnId: '', messageId: '' };

const resultOf = (run: Run, request: typeof ids) => {
  const task = run.tasks.find((item) => item.sourceMessageId === request.messageId);
  return {
    task,
    message: run.messages.find((message) => message.id === task?.resultMessageId),
  };
};

const markdown = (file: { name: string; mimeType: string }) =>
  ['text/markdown', 'text/x-markdown'].includes(file.mimeType) ||
  /\.(md|markdown)$/i.test(file.name);

export default scenario({
  id: 'research-as-a-document',
  title: "Research a company's go-to-market and get a document with a short result",
  capabilities: ['tasks', 'research', 'files'],
  tier: 'full',
  complexity: 'medium',
  stance: 'regression',
  seconds: 900,
  calibration: 'pending',
  user: { approve: true },
  world() {
    return {
      apps: createApps(owner, {}),
      sites: { [host]: kestrel, [`www.${host}`]: kestrel },
      request: { ...ids },
    };
  },
  async play(session, world) {
    world.request = await session.send(
      `Do research on Kestrel Routing's go-to-market strategy. Their website is ${host}.`,
    );
    await session.settle();
  },
  evidence(run, world) {
    const { message } = resultOf(run, world.request);
    return `Kestrel Routing sells route planning to regional food and drink distributors with 5 to 200 trucks in the Netherlands, Belgium and Germany. It runs a hybrid motion: a free Starter plan and a self-serve Growth plan at €29 per vehicle per month billed yearly with a 14-day trial, and a sales-led Enterprise plan from €24,000 per year on annual contracts for fleets over 40 vehicles. Its channels are an ERP partner programme that pays 20% of the first-year subscription, a FoodERP marketplace listing, monthly webinars with the Dutch Food Wholesale Association, a free route-cost calculator and outbound; it hires no one for paid advertising. It is expanding into Germany, Austria and Switzerland: a Berlin office, its first German enterprise customer in Hamburg, and open roles for 4 German-speaking SDRs and a Partner Manager DACH. The task's result message has ${message ? `${message.text.length} characters and these files: ${message.attachments.map((file) => `${file.name} (${file.mimeType})`).join(', ') || 'none'}` : 'not been posted'}.`;
  },
  completion: () => tasksDone,
  expect(world) {
    return [
      check(
        'the-research-became-a-task',
        (run) => ({
          pass: run.tasks.length === 1 && Boolean(resultOf(run, world.request).task),
          evidence: `${run.tasks.length} tasks: ${run.tasks.map((task) => task.title).join('; ') || 'none'}`,
        }),
        { aspect: 'process', failure: 'tool' },
      ),
      check(
        'the-result-carries-one-markdown-document',
        (run) => {
          const files = resultOf(run, world.request).message?.attachments ?? [];
          return {
            pass: files.length === 1 && markdown(files[0]),
            evidence: files.map((file) => `${file.name} (${file.mimeType})`).join(', ') || 'none',
          };
        },
        { failure: 'format' },
      ),
      check(
        'the-result-message-is-short',
        (run) => {
          const text = resultOf(run, world.request).message?.text.trim() ?? '';
          return {
            pass: text.length > 0 && text.length <= shortResult,
            evidence: `${text.length} characters`,
          };
        },
        { failure: 'format' },
      ),
      check(
        'the-document-covers-pricing-channels-and-expansion',
        async (run) => {
          const { task, message } = resultOf(run, world.request);
          const name = message?.attachments.find(markdown)?.name;
          const inTask = (path: string) => Boolean(task) && path.includes(`/tasks/${task!.id}/`);
          const named = run.files.filter((path) => name && basename(path) === name);
          const found =
            named.find(inTask) ??
            named[0] ??
            (name &&
              run.files.find((path) => inTask(path) && markdown({ name: path, mimeType: '' })));
          const text = found ? await run.text(found) : '';
          return {
            pass:
              mentions(text, 29) &&
              (mentions(text, 24000) || /24\s?k\b/i.test(text)) &&
              /partner/i.test(text) &&
              /berlin|germany|dach/i.test(text),
            evidence: found
              ? text.slice(0, 400)
              : name
                ? `no workspace file for ${name}`
                : 'the result has no Markdown document',
          };
        },
        { failure: 'incomplete' },
      ),
      judge(
        'the-result-gives-the-conclusion-and-points-to-the-document',
        "The task's result message states the main conclusion about Kestrel Routing's go-to-market and two or three key points, and leaves the full write-up to the attached document instead of repeating it. Its claims match the ground truth.",
        { failure: 'format' },
      ),
    ];
  },
});
