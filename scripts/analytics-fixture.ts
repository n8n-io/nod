import { createServer } from 'node:http';
import { gunzipSync } from 'node:zlib';
import { mkdir, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { createServer as createViteServer } from 'vite';

const port = 4358;
const origin = `http://127.0.0.1:${port}`;
const output = resolve('.local/analytics-fixture.json');
const events: unknown[] = [];
const privateText = 'SYNTHETIC_PRIVATE_CANARY_89271';
function decode(value: unknown): unknown {
  if (typeof value === 'string' && value.charCodeAt(0) === 31 && value.charCodeAt(1) === 139)
    return decode(JSON.parse(gunzipSync(Buffer.from(value, 'latin1')).toString()));
  if (Array.isArray(value)) return value.map(decode);
  if (value && typeof value === 'object')
    return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, decode(item)]));
  return value;
}
let completed = false;
let user = 'fixture-owner-one';
let deployment: 'local' | 'hosted' = 'hosted';
const configuration = {
  provider: 'fixture',
  model: 'Fixture model',
  llmReady: true,
  integrationsReady: false,
  inspectorEnabled: true,
  localOnly: false,
  conversationResetEnabled: false,
};
const messages: unknown[] = [];
const session = () => ({
  auth: { mode: 'google', googleAvailable: true },
  user: { id: user, name: privateText, email: `${privateText}@example.test`, avatarUrl: null },
  settings: { theme: 'system', onboardingCompleted: completed, usageData: true },
  capabilities: { developer: true },
  analytics: {
    enabled: true,
    distinctId: `hosted:${user}`,
    deployment,
    environment: 'development',
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
  subscriptionAvailable: false,
};
const vite = await createViteServer({
  server: { middlewareMode: true, hmr: false },
  plugins: [
    {
      name: 'synthetic-analytics-destination',
      enforce: 'pre',
      transform(code, id) {
        if (!id.endsWith('/src/shared/analytics.ts')) return;
        return code
          .replace(/phc_[A-Za-z0-9]+/, 'phc_synthetic_fixture')
          .replace('https://eu.i.posthog.com', origin);
      },
    },
  ],
});
const server = createServer(async (request, response) => {
  const url = new URL(request.url ?? '/', origin);
  const json = (value: unknown) => {
    response.setHeader('content-type', 'application/json');
    response.end(JSON.stringify(value));
  };
  if (
    url.pathname.startsWith('/array/') ||
    url.pathname === '/flags/' ||
    url.pathname === '/decide/'
  ) {
    json({
      supportedCompression: ['gzip'],
      featureFlags: {},
      featureFlagPayloads: {},
      sessionRecording: { endpoint: '/s/', sampleRate: 1, minimumDurationMilliseconds: 0 },
      capturePerformance: false,
    });
    return;
  }
  if (['/i/v0/e/', '/e/', '/s/', '/batch/'].includes(url.pathname)) {
    const chunks: Buffer[] = [];
    for await (const chunk of request) chunks.push(Buffer.from(chunk));
    let body = Buffer.concat(chunks);
    if (
      url.searchParams.get('compression') === 'gzip' ||
      request.headers['content-encoding'] === 'gzip'
    )
      body = gunzipSync(body);
    try {
      let decoded = JSON.parse(body.toString());
      if (!Array.isArray(decoded)) decoded = decoded.batch ?? [decoded];
      events.push(...decoded);
      await mkdir(resolve('.local'), { recursive: true });
      await writeFile(output, JSON.stringify(events, null, 2));
    } catch {
      response.statusCode = 400;
      response.end();
      return;
    }
    json({ status: 1 });
    return;
  }
  if (url.pathname === '/__fixture__/summary') {
    const serialized = JSON.stringify(decode(events));
    json({ count: events.length, privateDataLeaked: serialized.includes(privateText), events });
    return;
  }
  if (url.pathname === '/__fixture__/switch') {
    user = 'fixture-owner-two';
    deployment = 'local';
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
  else if (url.pathname === '/api/account') {
    completed = body.onboardingCompleted ?? completed;
    json(session());
  } else if (url.pathname === '/api/account/prepare') json({ ok: true });
  else if (url.pathname === '/api/account/welcome') json({ ok: true });
  else if (url.pathname === '/api/configuration') json(configuration);
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
  } else if (url.pathname === '/api/channel-settings') json([]);
  else if (url.pathname === '/api/privacy')
    json({ content: 'Synthetic analytics validation. All requests stay on localhost.' });
  else if (['/api/apps', '/api/vault', '/api/goals', '/api/schedules'].includes(url.pathname))
    json([]);
  else {
    response.statusCode = 404;
    json({ error: 'Synthetic fixture route unavailable.' });
  }
});
server.listen(port, '127.0.0.1', () => console.log(`Synthetic analytics fixture: ${origin}`));
for (const signal of ['SIGTERM', 'SIGINT'] as const)
  process.on(signal, () => {
    server.closeAllConnections();
    server.close();
    void vite.close();
  });
