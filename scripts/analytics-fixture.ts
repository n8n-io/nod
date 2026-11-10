import { createServer } from 'node:http';
import { gunzipSync } from 'node:zlib';
import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { createHash, randomUUID } from 'node:crypto';
import { createServer as createViteServer } from 'vite';

const port = Number(process.env.NOD_ANALYTICS_FIXTURE_PORT ?? '0');
if (!Number.isInteger(port) || port < 0 || port > 65535) throw new Error('Invalid fixture port.');
let origin = 'http://127.0.0.1';
const output = resolve(
  process.env.NOD_ANALYTICS_FIXTURE_OUTPUT ?? join(tmpdir(), `nod-analytics-${randomUUID()}.json`),
);
const events: unknown[] = [];
let captureRequests = 0;
let captureErrors = 0;
let recordingRequests = 0;
let remoteConfigurationRequests = 0;
const surveyFlagRequests: { query: string; body: unknown }[] = [];
let surveyDefinitionRequests = 0;
let surveysEnabled = false;
let profileSubmissions = 0;
let modelSetupChecks = 0;
let updatesEmailSubmissions = 0;
const survey = {
  id: '0190c1a2-0000-7000-8000-000000000001',
  name: 'Synthetic Nod survey',
  type: 'api',
  start_date: '2026-01-01T00:00:00Z',
  end_date: null,
  current_iteration: null,
  internal_targeting_flag_key: 'synthetic-survey-target',
  enable_partial_responses: true,
  questions: [
    {
      id: '0190c1a2-0000-7000-8000-000000000002',
      type: 'rating',
      scale: 10,
      question: 'How likely are you to recommend Nod to a friend or colleague?',
      lowerBoundLabel: 'Not at all likely',
      upperBoundLabel: 'Extremely likely',
    },
    {
      id: '0190c1a2-0000-7000-8000-000000000003',
      type: 'open',
      question: "What's the main reason for your score?",
      optional: true,
    },
  ],
};
const privateText = 'SYNTHETIC_PRIVATE_CANARY_89271';
function decode(value: unknown): unknown {
  if (typeof value === 'string' && value.charCodeAt(0) === 31 && value.charCodeAt(1) === 139)
    return decode(JSON.parse(gunzipSync(Buffer.from(value, 'latin1')).toString()));
  if (Array.isArray(value)) return value.map(decode);
  if (value && typeof value === 'object')
    return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, decode(item)]));
  return value;
}
function hasGeneratedNode(value: unknown): boolean {
  if (Array.isArray(value)) return value.some(hasGeneratedNode);
  if (!value || typeof value !== 'object') return false;
  const entry = value as Record<string, unknown>;
  const attributes = entry.attributes;
  if (attributes && typeof attributes === 'object' && 'class' in attributes) {
    const classes = String(attributes.class).split(/\s+/);
    if (classes.some((name) => ['chart-bars-plot', 'diagram-node'].includes(name))) return true;
  }
  return Object.values(entry).some(hasGeneratedNode);
}
let completed = false;
let usageData = false;
let traces = false;
let user = 'fixture-owner-one';
const configuration = {
  provider: 'fixture',
  model: 'Fixture model',
  llmReady: true,
  modelReconnect: false,
  integrationsReady: false,
  conversationResetEnabled: false,
};
const messages: unknown[] = [];
const file = {
  id: '00000000-0000-4000-8000-000000000701',
  name: `${privateText}.txt`,
  mimeType: 'text/plain',
  size: privateText.length,
  url: '/api/artifacts/00000000-0000-4000-8000-000000000701',
};
const visuals = [
  {
    type: 'chart',
    chart: 'bar',
    series: [
      { id: 'private-series', label: privateText, points: [{ label: privateText, value: 89271 }] },
    ],
  },
  {
    type: 'diagram',
    nodes: [{ id: 'private-node', label: privateText, detail: privateText }],
    edges: [],
  },
];
const session = () => ({
  user: { id: user, name: privateText, email: `${privateText}@example.test`, avatarUrl: null },
  settings: {
    theme: 'system',
    onboardingCompleted: completed,
    usageData,
    traces,
  },
  capabilities: { developer: true, traces: true, updatesEmail: true },
  analytics: {
    enabled: usageData,
    distinctId: usageData ? `local:${user}` : null,
    environment: 'development',
    surveys: surveysEnabled,
  },
});
const preferences = {
  notificationRule: privateText,
  timeZone: 'Europe/Lisbon',
  locale: 'en-GB',
  hourCycle: 'h23',
  quietHoursEnabled: false,
  quietStart: '22:00',
  quietEnd: '08:00',
};
const models = {
  connections: [
    {
      id: 'fixture-model',
      provider: 'openai',
      method: 'api_key',
      label: privateText,
      status: 'connected',
      managed: false,
      models: [
        {
          id: 'fixture-model',
          name: 'Fixture model',
          efforts: ['high'],
          images: true,
          contextWindow: 10000,
        },
      ],
    },
  ],
  selection: { connectionId: 'fixture-model', modelId: 'fixture-model', effort: 'high' },
  local: false,
};
await mkdir(dirname(output), { recursive: true });
await writeFile(output, '[]\n');
const vite = await createViteServer({
  server: { middlewareMode: true, hmr: false, ws: false },
  plugins: [
    {
      name: 'synthetic-analytics-destination',
      enforce: 'pre',
      transform(code, id) {
        if (id.endsWith('/src/web/lib/analytics.ts')) {
          const target = '      api_host: posthogConfig.host,\n';
          if (code.split(target).length !== 2)
            throw new Error('The synthetic browser capture override could not be verified.');
          return code.replace(target, `${target}      opt_out_useragent_filter: true,\n`);
        }
        if (!id.endsWith('/src/shared/posthog-host.json')) return;
        const config = JSON.parse(code);
        if (
          config.host !== 'https://eu.i.posthog.com' ||
          typeof config.key !== 'string' ||
          createHash('sha256').update(config.key).digest('hex') !==
            '2e3bc72156d3973a771353bf9e39fcda57fcc9641b2d59ca579d3718b14dc6e0' ||
          config.schemaVersion !== 'v4' ||
          Object.keys(config).length !== 3
        )
          throw new Error('The synthetic analytics destination could not be verified.');
        return JSON.stringify({
          host: origin,
          key: 'phc_synthetic_fixture',
          schemaVersion: config.schemaVersion,
        });
      },
    },
  ],
});
const server = createServer(async (request, response) => {
  response.setHeader('content-security-policy', "connect-src 'self'");
  const url = new URL(request.url ?? '/', origin);
  const json = (value: unknown) => {
    response.setHeader('content-type', 'application/json');
    response.end(JSON.stringify(value));
  };
  if (
    url.pathname === '/flags/' &&
    url.searchParams.get('only_evaluate_survey_feature_flags') === 'true'
  ) {
    const chunks: Buffer[] = [];
    for await (const chunk of request) chunks.push(Buffer.from(chunk));
    let body = Buffer.concat(chunks);
    let decoded: unknown = null;
    try {
      if (
        (body[0] === 0x1f && body[1] === 0x8b) ||
        url.searchParams.get('compression') === 'gzip' ||
        request.headers['content-encoding'] === 'gzip'
      )
        body = gunzipSync(body);
      const data = new URLSearchParams(body.toString()).get('data');
      decoded = JSON.parse(data ? Buffer.from(data, 'base64').toString() : body.toString());
    } catch {
      captureErrors++;
    }
    surveyFlagRequests.push({ query: url.search, body: decoded });
    json({
      featureFlags: { 'synthetic-survey-target': true },
      featureFlagPayloads: {},
      surveys: surveysEnabled,
    });
    return;
  }
  if (url.pathname === '/api/surveys/') {
    surveyDefinitionRequests++;
    json({ surveys: surveysEnabled ? [survey] : [] });
    return;
  }
  if (
    url.pathname.startsWith('/array/') ||
    url.pathname === '/flags/' ||
    url.pathname === '/decide/'
  ) {
    remoteConfigurationRequests++;
    json({
      supportedCompression: ['gzip'],
      featureFlags: {},
      featureFlagPayloads: {},
      sessionRecording: { endpoint: '/s/', sampleRate: 1, minimumDurationMilliseconds: 0 },
      capturePerformance: false,
      surveys: surveysEnabled,
    });
    return;
  }
  if (['/i/v0/e/', '/e/', '/s/', '/batch/'].includes(url.pathname)) {
    captureRequests++;
    if (url.pathname === '/s/') recordingRequests++;
    const chunks: Buffer[] = [];
    for await (const chunk of request) chunks.push(Buffer.from(chunk));
    let body = Buffer.concat(chunks);
    try {
      if (
        (body[0] === 0x1f && body[1] === 0x8b) ||
        url.searchParams.get('compression') === 'gzip' ||
        request.headers['content-encoding'] === 'gzip'
      )
        body = gunzipSync(body);
      const data = new URLSearchParams(body.toString()).get('data');
      const payload =
        url.searchParams.get('compression') === 'base64' && data
          ? Buffer.from(data, 'base64').toString()
          : body.toString();
      let decoded = JSON.parse(payload);
      if (!Array.isArray(decoded)) decoded = decoded.batch ?? [decoded];
      events.push(...decoded);
      await writeFile(output, JSON.stringify(events, null, 2));
    } catch {
      captureErrors++;
      response.statusCode = 400;
      response.end();
      return;
    }
    json({ status: 1 });
    return;
  }
  if (url.pathname === '/__fixture__/summary') {
    const decoded = decode(events);
    const serialized = JSON.stringify(decoded);
    json({
      enabled: usageData,
      count: events.length,
      captureRequests,
      captureErrors,
      recordingEvents: events.filter(
        (event) =>
          event && typeof event === 'object' && 'event' in event && event.event === '$snapshot',
      ).length,
      recordingRequests,
      remoteConfigurationRequests,
      surveyFlagRequests,
      surveyDefinitionRequests,
      profileSubmissions,
      modelSetupChecks,
      updatesEmailSubmissions,
      privateDataLeaked: serialized.includes(privateText),
      generatedContentLeaked: hasGeneratedNode(decoded),
      ...(url.searchParams.get('compact') === '1' ? {} : { events: decoded }),
    });
    return;
  }
  if (url.pathname === '/__fixture__/switch') {
    user = 'fixture-owner-two';
    usageData = false;
    traces = false;
    json({ ok: true });
    return;
  }
  if (url.pathname === '/__fixture__/prepare') {
    completed = true;
    usageData = url.searchParams.get('sharing') === 'on';
    surveysEnabled = url.searchParams.get('surveys') === 'on';
    messages.splice(
      0,
      messages.length,
      ...visuals.map((visual, index) => ({
        id: `00000000-0000-4000-8000-00000000070${index + 2}`,
        role: 'assistant',
        text: `Synthetic result ${privateText}`,
        createdAt: new Date().toISOString(),
        attachments: [],
        reactions: [],
        presentation: { version: 1, title: privateText, sources: [], ...visual },
      })),
      {
        id: '00000000-0000-4000-8000-000000000704',
        role: 'assistant',
        text: `Synthetic file ${privateText}`,
        createdAt: new Date().toISOString(),
        attachments: [file],
        reactions: [],
      },
    );
    json({ ok: true });
    return;
  }
  if (!url.pathname.startsWith('/api/')) {
    vite.middlewares(request, response);
    return;
  }
  if (url.pathname === '/api/events') {
    response.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' });
    response.write(': connected\n\n');
    request.on('close', () => response.end());
    return;
  }
  const chunks: Buffer[] = [];
  for await (const chunk of request) chunks.push(Buffer.from(chunk));
  const body = chunks.length ? JSON.parse(Buffer.concat(chunks).toString()) : {};
  if (url.pathname === '/api/session') json(session());
  else if (url.pathname === file.url) {
    response.setHeader('content-type', file.mimeType);
    response.end(privateText);
  } else if (url.pathname === '/api/account') {
    completed = body.onboardingCompleted ?? completed;
    if (typeof body.usageData === 'boolean') usageData = body.usageData;
    if (typeof body.traces === 'boolean') traces = body.traces;
    json(session());
  } else if (url.pathname === '/api/account/prepare') json({ ok: true });
  else if (url.pathname === '/api/account/model-setup' && request.method === 'POST') {
    modelSetupChecks++;
    json({ ok: true });
  } else if (url.pathname === '/api/onboarding/profile' && request.method === 'POST') {
    profileSubmissions++;
    json({ ok: true, shared: false });
  } else if (url.pathname === '/api/onboarding/updates-email' && request.method === 'POST') {
    if (!usageData) {
      response.statusCode = 403;
      json({ error: 'Turn on Share usage data before signing up for updates.' });
    } else {
      updatesEmailSubmissions++;
      json({ ok: true });
    }
  } else if (url.pathname === '/api/account/welcome') json({ ok: true });
  else if (url.pathname === '/api/onboarding/suggestions' && request.method === 'POST') {
    response.statusCode = 202;
    json({ ok: true });
  } else if (url.pathname === '/api/configuration') json(configuration);
  else if (url.pathname === '/api/models') json(models);
  else if (url.pathname === '/api/preferences') json(preferences);
  else if (url.pathname === '/api/state')
    json({ threadId: 'fixture-thread', threadStatus: 'idle', messages, turns: [], configuration });
  else if (url.pathname === '/api/messages' && request.method === 'POST') {
    messages.push({
      id: body.clientMessageId,
      role: 'user',
      text: body.text,
      turnId: 'fixture-turn',
      createdAt: new Date().toISOString(),
      attachments: [],
      reactions: [],
    });
    json({ messageId: body.clientMessageId, turnId: 'fixture-turn' });
  } else if (url.pathname === '/api/channel-settings') json({ ready: false, channels: [] });
  else if (url.pathname === '/api/prepared/00000000-0000-4000-8000-000000000705')
    json({
      id: '00000000-0000-4000-8000-000000000705',
      url: '/prepared/00000000-0000-4000-8000-000000000705',
      title: `Supplier reply ${privateText}`,
      updatedAt: '2026-10-27T08:30:00.000Z',
      draft: `Subject: Confirm the unused credit\n\nHello, please confirm whether the EUR 280 credit can be used on the next invoice. ${privateText}`,
      unknowns: [`The expiry date is not supplied. ${privateText}`],
      sources: [
        {
          sourceId: 'synthetic-statements',
          id: 'synthetic-statement',
          label: `Supplier statement ${privateText}`,
          url: 'https://example.test/statement',
        },
      ],
    });
  else if (url.pathname === '/api/channels') json({ channels: [], error: null });
  else if (url.pathname === '/api/browser' && request.method === 'GET')
    json({ currentBrowser: null });
  else if (url.pathname === '/api/schedule-runs' && request.method === 'GET')
    json({ runs: [], nextCursor: null });
  else if (url.pathname === '/api/vault/activity' && request.method === 'GET')
    json({ week: { signIns: 0, payments: 0, held: 0 }, entries: [] });
  else if (url.pathname === '/api/privacy')
    json({ content: 'Synthetic analytics validation. All requests stay on localhost.' });
  else if (url.pathname === '/api/memory' && request.method === 'GET')
    json({ saving: false, sensitive: false, notes: [], archive: [], skills: [] });
  else if (url.pathname === '/api/trust' && request.method === 'GET')
    json({
      entries: [],
      next: null,
      week: { things: 0, actions: 0, spentUsd: 0 },
      month: {
        start: '2026-01-01T00:00:00.000Z',
        days: 31,
        elapsedDays: 1,
        spentUsd: 0,
        forecastUsd: 0,
        daily: [0],
        unpriced: false,
      },
      limit: null,
      taskUsd: 5,
    });
  else if (
    request.method === 'GET' &&
    [
      '/api/apps',
      '/api/apps/catalog',
      '/api/vault',
      '/api/vault/sessions',
      '/api/tasks',
      '/api/schedules',
    ].includes(url.pathname)
  )
    json([]);
  else {
    response.statusCode = 404;
    json({ error: 'Synthetic fixture route unavailable.' });
  }
});
await new Promise<void>((ready) => server.listen(port, '127.0.0.1', ready));
const address = server.address();
if (!address || typeof address === 'string') throw new Error('Fixture listener unavailable.');
origin = `http://127.0.0.1:${address.port}`;
console.log(`Synthetic analytics fixture: ${origin}\nCaptured events: ${output}`);
for (const signal of ['SIGTERM', 'SIGINT'] as const)
  process.on(signal, () => {
    server.closeAllConnections();
    server.close();
    void vite.close();
  });
