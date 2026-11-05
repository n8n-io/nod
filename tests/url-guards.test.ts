import {
  flightJourneySummary,
  presentationImages,
  presentationInputSchema,
  presentationSchema,
  presentationText,
  type Presentation,
} from '../src/shared/presentation.ts';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { createServer, request } from 'node:http';
import { once } from 'node:events';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { createBrowserProxy } from '../src/providers/agent-browser/network.ts';
import {
  createPublicLinkPreviewProvider,
  requestPublicPreview,
} from '../src/providers/public-web/link-preview.ts';
import { previewableUrl, publicMediaUrl } from '../src/shared/link-preview.ts';
import { MessageQuote, MessageText } from '../src/web/components/message.tsx';
import { connectionUrl } from '../src/web/lib/connection-url.ts';
import { messageSetupLinks } from '../src/web/lib/message-links.ts';
import { ownerAddress } from '../src/providers/discovered/remote.ts';
import {
  escapeForwarder,
  SandboxedFrame,
  sandboxedDocument,
} from '../src/web/components/attachment-frame.tsx';
import { runProcess } from '../src/providers/process.ts';

const render = (text: string) => renderToStaticMarkup(createElement(MessageText, { text }));

test(
  'HTML previews run local scripts but block navigation before any request leaves the frame',
  { skip: !process.env.NOD_TEST_BROWSER_EXECUTABLE, timeout: 30_000 },
  async () => {
    const received: string[] = [];
    const collector = createServer((request, response) => {
      received.push(request.url ?? '');
      response.end('Synthetic collector');
    });
    collector.listen(0, '127.0.0.1');
    await once(collector, 'listening');
    const address = collector.address();
    assert.ok(address && typeof address !== 'string');
    const destination = `http://127.0.0.1:${address.port}/collect?data=synthetic-marker`;
    const target = JSON.stringify(destination);
    const navigations = [
      `location.href=${target}`,
      `location.replace(${target})`,
      `location.assign(${target})`,
      `window.open(${target},'_self')`,
      `const a=document.createElement('a');a.href=${target};a.target='_self';a.click()`,
      `const meta=document.createElement('meta');meta.httpEquiv='refresh';meta.content='0;url='+${target};document.head.append(meta)`,
      `document.querySelectorAll('meta').forEach(node=>node.remove());location.replace(${target})`,
      `document.open();document.write('<meta http-equiv="refresh" content="0;url='+${target}+'">');document.close()`,
    ];
    const attempts = [
      ...navigations,
      `parent.location=${target}`,
      `top.location=${target}`,
      `window.open(${target},'_blank')`,
      `fetch(${target}).catch(()=>{});navigator.sendBeacon(${target},'synthetic');new Image().src=${target}`,
      `const form=document.createElement('form');form.action=${target};form.method='POST';document.body.append(form);form.submit()`,
    ];
    const frame = (content: string, scripts = true) =>
      renderToStaticMarkup(
        createElement(SandboxedFrame, {
          html: sandboxedDocument(content, escapeForwarder),
          title: 'Synthetic HTML preview',
          scripts,
          onLeave() {},
        }),
      );
    const previews = attempts.map((script, index) =>
      frame(
        `<p>synthetic-marker</p><script>top.postMessage('ran-${index}','*');try{${script}}catch{}</script>`,
      ),
    );
    previews.push(
      frame(
        `<p>Safe &amp; interactive</p><button onclick="this.textContent='Done'">Run</button><script>document.querySelector('button').click();top.postMessage(document.querySelector('button').textContent==='Done'?'interactive':'failed','*');dispatchEvent(new KeyboardEvent('keydown',{key:'Escape'}))</script>`,
      ),
      frame(
        `<meta http-equiv="refresh" content="0;url=${destination}"><script>top.postMessage('thumbnail-script','*')</script>`,
        false,
      ),
      frame(
        `&quot;><iframe src="${destination}"></iframe><script>top.postMessage('quoted-content','*')</script>`,
      ),
    );
    const host = createServer((_request, response) => {
      response.setHeader('content-type', 'text/html');
      response.end(
        `<body><script>const messages=[],blocked=new Set();addEventListener('message',event=>{if(typeof event.data!=='string')return;messages.push(event.data);document.body.dataset.messages=JSON.stringify(messages);const index=[...document.querySelectorAll('iframe')].findIndex(frame=>frame.contentWindow===event.source);if(index<0)return;if(event.data==='nod:leave'){blocked.add(index);document.body.dataset.navigationBlocked=JSON.stringify([...blocked].sort((a,b)=>a-b))}if(event.data==='nod:close')document.body.dataset.closed='yes'});addEventListener('load',()=>{document.querySelectorAll('iframe')[${attempts.length + 1}].contentWindow[0].location=${target}})</script>${previews.join('')}</body>`,
      );
    });
    const profile = await mkdtemp(join(tmpdir(), 'nod-preview-browser-'));
    try {
      await fetch(destination);
      assert.equal(received.length, 1);
      received.length = 0;
      host.listen(0, '127.0.0.1');
      await once(host, 'listening');
      const address = host.address();
      assert.ok(address && typeof address !== 'string');
      const result = await runProcess(
        process.env.NOD_TEST_BROWSER_EXECUTABLE!,
        [
          '--headless',
          '--no-sandbox',
          '--disable-gpu',
          '--disable-background-networking',
          '--no-first-run',
          `--user-data-dir=${profile}`,
          '--dump-dom',
          '--virtual-time-budget=1500',
          `http://127.0.0.1:${address.port}`,
        ],
        { signal: AbortSignal.timeout(20_000) },
      );
      assert.equal(result.exitCode, 0, result.stderr);
      for (let index = 0; index < attempts.length; index++)
        assert.match(result.stdout, new RegExp(`ran-${index}(?:&quot;|\")`));
      assert.deepEqual(received, []);
      assert.match(result.stdout, /data-closed="yes"/);
      const blocked = /data-navigation-blocked="([^"]+)"/.exec(result.stdout);
      assert.ok(blocked);
      assert.deepEqual(JSON.parse(blocked[1]), [...navigations.keys(), attempts.length + 1]);
      assert.match(result.stdout, /&quot;interactive&quot;/);
      assert.match(result.stdout, /&quot;quoted-content&quot;/);
      assert.doesNotMatch(result.stdout, /&quot;thumbnail-script&quot;/);
    } finally {
      await Promise.all([
        new Promise<void>((resolve) => host.close(() => resolve())),
        new Promise<void>((resolve) => collector.close(() => resolve())),
      ]);
      await rm(profile, { recursive: true, force: true });
    }
  },
);

const addresses = async () => [{ address: '93.184.216.34', family: 4 }];
const html = (text = '<title>Fixture page</title>') => ({
  status: 200,
  headers: { 'content-type': 'text/html; charset=utf-8' },
  body: Buffer.from(`<html><head>${text}</head><body>Fixture</body></html>`),
});

test('preview eligibility blocks local, credential, consent and token URLs before any request', () => {
  for (const value of [
    'file:///etc/passwd',
    'javascript:alert(1)',
    'http://localhost:4310',
    'http://2130706433',
    'http://127.1',
    'http://10.0.0.1',
    'https://192.168.0.3',
    'http://169.254.169.254/latest/meta-data',
    'https://[::1]',
    'https://user:secret@example.com',
    'https://example.com:9222',
    'https://example.com/vault/opaque',
    'https://example.com/%63redentials/opaque',
    'https://example.com/payments/opaque',
    'https://example.com/api/payment-requests/opaque',
    'https://example.com/approvals/opaque',
    'https://example.com/approval/token',
    'https://example.com/consent/token',
    'https://example.com/reset/token',
    'https://example.com/api/artifacts/opaque',
    'https://example.com/login',
    'https://example.com/unsubscribe/opaque',
    'https://example.com/confirm/opaque',
    'https://connect.composio.dev/link/opaque',
    'https://app.composio.dev/link/opaque',
    'https://connect.composio.dev./link/opaque',
    'https://app.composio.dev./link/opaque',
    'https://accounts.google.com/o/oauth2',
    'https://auth.example.com/continue',
    'https://example.com/?access_token=private',
    'https://example.com/?api_key=private',
    'https://example.com/?code=private',
    'https://example.com/?state=private',
    'https://example.com/?nonce=private',
    'https://example.com/?X-Amz-Signature=private',
    'https://example.com/?v=' + 'a'.repeat(64),
    'https://example.com/#access_token=private',
    'https://example.com/?t=eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxIn0.c2lnbmF0dXJl',
  ])
    assert.equal(previewableUrl(value), null, value);
  assert.equal(
    previewableUrl('https://example.com/article#heading'),
    'https://example.com/article',
  );
  const image = 'https://i.vimeocdn.com/video/1-' + 'a'.repeat(64) + '?sig=public';
  assert.equal(previewableUrl(image), null);
  assert.equal(publicMediaUrl(image), image);
  for (const value of [
    'http://127.0.0.1/a.png',
    'https://localhost/a.png',
    'https://localhost./a.png',
    'https://files.internal./a.png',
    'https://files.local./a.png',
    'https://a:b@example.org/a.png',
    'https://100.64.0.1/a.png',
    'https://100.127.255.255/a.png',
    'https://192.0.0.1/a.png',
    'https://192.0.2.1/a.png',
    'https://192.88.99.1/a.png',
    'https://198.18.0.1/a.png',
    'https://198.19.255.255/a.png',
    'https://198.51.100.1/a.png',
    'https://203.0.113.1/a.png',
    'https://224.0.0.1/a.png',
    'https://255.255.255.255/a.png',
  ])
    assert.equal(publicMediaUrl(value), null, value);
  for (const address of ['100.63.255.255', '100.128.0.1', '192.0.77.1', '93.184.216.34']) {
    const url = `https://${address}/a.png`;
    assert.equal(publicMediaUrl(url), url);
  }
  assert.equal(
    previewableUrl('https://upload.wikimedia.org/a.jpg?utm_source=en.wikipedia.org'),
    'https://upload.wikimedia.org/a.jpg?utm_source=en.wikipedia.org',
  );
  assert.equal(
    previewableUrl('https://www.youtube.com/watch?v=abc123'),
    'https://www.youtube.com/watch?v=abc123',
  );
});

test('every redirect checks DNS again and requests use the verified address', async () => {
  let lookups = 0;
  const calls: string[] = [];
  const provider = createPublicLinkPreviewProvider({
    resolver: async () =>
      ++lookups === 1 ? await addresses() : [{ address: '127.0.0.1', family: 4 }],
    request: async ({ url, address }) => {
      assert.equal(address, '93.184.216.34');
      calls.push(url.href);
      return { status: 302, headers: { location: '/second' }, body: new Uint8Array() };
    },
  });
  assert.equal(await provider.icon('https://example.com'), null);
  assert.equal(lookups, 3);
  assert.deepEqual(calls, ['https://example.com/favicon.ico']);
  let requested = false;
  const mixed = createPublicLinkPreviewProvider({
    resolver: async () => [...(await addresses()), { address: '10.0.0.2', family: 4 }],
    request: async () => {
      requested = true;
      return html();
    },
  });
  assert.equal(await mixed.icon('https://example.com'), null);
  assert.equal(requested, false);
  for (const location of ['http://169.254.169.254/latest', 'https://169.254.169.254/latest']) {
    let requests = 0;
    const redirected = createPublicLinkPreviewProvider({
      resolver: addresses,
      request: async () => {
        requests++;
        return { status: 302, headers: { location }, body: new Uint8Array() };
      },
    });
    assert.equal(await redirected.icon('https://example.com'), null);
    assert.equal(requests, 2);
  }
});

test('pinned HTTP transport sends no cookies or authorization and stops after bounded metadata', async () => {
  let seenHost = '';
  const server = createServer((request, reply) => {
    seenHost = request.headers.host!;
    assert.equal(request.headers.cookie, undefined);
    assert.equal(request.headers.authorization, undefined);
    assert.equal(request.headers.referer, undefined);
    assert.equal(request.headers['accept-encoding'], 'identity');
    assert.ok(!request.headers.accept?.includes('image/gif'));
    const body = `<head><title>Bounded metadata</title></head>${'x'.repeat(400000)}`;
    reply.writeHead(200, {
      'content-type': 'text/html',
      'content-length': Buffer.byteLength(body),
    });
    reply.end(body);
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  try {
    const port = (server.address() as { port: number }).port;
    const result = await requestPublicPreview({
      url: new URL(`http://unresolvable.example:${port}/fixture`),
      address: '127.0.0.1',
      signal: AbortSignal.timeout(2000),
      maxBytes: 256 * 1024,
      metadata: true,
    });
    assert.equal(seenHost, `unresolvable.example:${port}`);
    assert.ok(result.body.byteLength <= 256 * 1024);
    assert.match(Buffer.from(result.body).toString(), /Bounded metadata/);
  } finally {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});

test('connection navigation permits secure providers and same-origin app consent only', () => {
  const origin = 'http://localhost:4320';
  assert.equal(
    connectionUrl('https://accounts.example.com/consent', origin),
    'https://accounts.example.com/consent',
  );
  assert.equal(connectionUrl('/e2e/connect/example', origin), origin + '/e2e/connect/example');
  const bridge = `http://127.0.0.1:54321/${'a'.repeat(43)}`;
  assert.equal(connectionUrl(bridge, origin), bridge);
  for (const hosted of [
    `https://nod.example.test/api/apps/connect/${'b'.repeat(43)}`,
    `${origin}/api/apps/connect/${'b'.repeat(43)}`,
  ]) {
    assert.equal(connectionUrl(hosted, origin), hosted);
    assert.deepEqual(messageSetupLinks(`[Connect Gmail](${hosted})`, origin), [
      { href: hosted, setup: 'app', label: 'Connect Gmail' },
    ]);
  }
  for (const suffix of ['?', '#', '?#', '?unexpected=yes', '#unexpected'])
    assert.throws(() => connectionUrl(bridge + suffix, origin));
  for (const value of [
    `http://localhost:54321/${'a'.repeat(43)}`,
    `http://[::1]:54321/${'a'.repeat(43)}`,
    `http://127.0.0.2:54321/${'a'.repeat(43)}`,
    `http://127.0.0.1.example.test:54321/${'a'.repeat(43)}`,
    `http://127.0.0.1/${'a'.repeat(43)}`,
    `http://127.0.0.1:54321/${'a'.repeat(42)}`,
    `http://127.0.0.1:54321/${'a'.repeat(44)}`,
    `http://127.0.0.1:54321/${'a'.repeat(42)}%2f`,
    `http://127.0.0.1:54321/${'a'.repeat(43)}/extra`,
    'http://elsewhere.example/consent',
    'http://localhost:4310/consent',
    'javascript:alert(1)',
    'data:text/html,login',
    'https://user:password@example.com/consent',
    'http://localhost:4320@elsewhere.example/consent',
  ])
    assert.throws(() => connectionUrl(value, origin));
});

test('an owner-entered address binds every request and consent page to that instance', async () => {
  const check = ownerAddress('http://127.0.0.1:5678');
  assert.equal(
    (await check('http://127.0.0.1:5678/mcp-server/http')).url.href,
    'http://127.0.0.1:5678/mcp-server/http',
  );
  assert.equal((await check('http://localhost:5678/mcp-oauth/token')).address, '127.0.0.1');
  for (const value of [
    'http://127.0.0.1:5679/mcp-server/http',
    'http://192.168.1.1:5678/admin',
    'https://127.0.0.1:5678/mcp-server/http',
    'http://user:secret@127.0.0.1:5678/mcp-server/http',
  ])
    await assert.rejects(check(value));
  await assert.rejects(
    ownerAddress('http://93.184.216.34')('http://93.184.216.34/mcp-server/http'),
  );
  const origin = 'http://localhost:4320';
  assert.equal(
    connectionUrl('http://localhost:5678/mcp-oauth/authorize', origin, 'http://127.0.0.1:5678'),
    'http://localhost:5678/mcp-oauth/authorize',
  );
  assert.throws(() =>
    connectionUrl('http://localhost:5679/mcp-oauth/authorize', origin, 'http://127.0.0.1:5678'),
  );
});

test('chat HTML cannot run scripts, submit forms, load trackers or link to local internals', () => {
  const result = render(
    '<u onclick="alert(1)" style="color:red">x</u><script>alert(1)</script><style>body{display:none}</style><iframe src="https://evil.example"></iframe><form action="/api/messages"><input name="text" value="bad"></form><img src="https://evil.example/track" onerror="alert(1)"><a href="javascript:alert(1)">bad</a><a href="/api/state">internal</a>\n\n![picture](https://evil.example/pixel)',
  );
  for (const expression of [
    /<script/i,
    /<style/i,
    /<iframe/i,
    /<form/i,
    /onerror=/i,
    /onclick=/i,
    /style=/i,
    /src="https:\/\/evil/,
    /href="javascript:/i,
    /href="\/api\/state"/,
  ])
    assert.doesNotMatch(result, expression);
  assert.match(result, /<input(?=[^>]*type="checkbox")(?=[^>]*disabled="")[^>]*>/);
});

test('reply excerpts cannot load media or expose nested actions', () => {
  const result = renderToStaticMarkup(
    createElement(MessageQuote, {
      message: {
        id: 'quoted-message',
        role: 'assistant',
        text: '<u onclick="alert(1)">text</u><script>alert(1)</script><iframe src="https://evil.example"></iframe><form action="/api/messages"><input name="text"></form><a href="javascript:alert(1)">unsafe</a>\n\n[Connect](/apps?connect=slack)\n\n![owned](/api/artifacts/aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa)\n\n![remote](https://evil.example/pixel)',
      },
    }),
  );
  assert.equal((result.match(/<button\b/g) ?? []).length, 1);
  assert.doesNotMatch(result, /<(?:a|img|input|form|script|iframe)\b|onclick=|onerror=/i);
  assert.match(result, /<u>text<\/u>/);
  assert.match(result, /owned/);
  const selected = renderToStaticMarkup(
    createElement(MessageQuote, {
      message: {
        id: 'quoted-message',
        role: 'assistant',
        text: '<button data-x="1"> *literal*',
        isQuote: true,
      },
    }),
  );
  assert.match(selected, /&lt;button data-x=&quot;1&quot;&gt; \*literal\*/);
  assert.equal((selected.match(/<button\b/g) ?? []).length, 1);
});

test('the browser proxy refuses private network destinations, including names that resolve to them', async () => {
  let reached = 0;
  const server = createServer((_request, reply) => {
    reached++;
    reply.end('local');
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const port = (server.address() as { port: number }).port;
  const guarded = createBrowserProxy({
    resolver: async () => [{ address: '192.168.1.10', family: 4 }],
  });
  const open = createBrowserProxy({ privateNetwork: true });
  const status = async (proxy: ReturnType<typeof createBrowserProxy>, target: string) => {
    const { hostname, port: proxyPort } = new URL(await proxy.url());
    const connect = !target.startsWith('http');
    const sent = request({
      host: hostname,
      port: proxyPort,
      method: connect ? 'CONNECT' : 'GET',
      path: target,
      headers: { host: connect ? target : new URL(target).host },
    });
    const response = once(sent, connect ? 'connect' : 'response');
    sent.end();
    const [reply, socket] = (await response) as [
      import('node:http').IncomingMessage,
      import('node:net').Socket?,
    ];
    socket?.destroy();
    reply.resume();
    return reply.statusCode;
  };
  try {
    for (const target of [
      `http://127.0.0.1:${port}/`,
      `http://localhost:${port}/`,
      `http://[::1]:${port}/`,
      'http://10.0.0.5/',
      'http://host.docker.internal/',
      'http://rebind.example/',
      '169.254.169.254:443',
      `127.0.0.1:${port}`,
    ])
      assert.equal(await status(guarded, target), 400, target);
    assert.equal(reached, 0);
    assert.equal(await status(open, `http://127.0.0.1:${port}/`), 200);
    assert.equal(reached, 1);
  } finally {
    await guarded.dispose();
    await open.dispose();
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});

test('chat presentations reject unsafe URLs, executable shapes and inconsistent references', () => {
  const common = { version: 1, title: 'Synthetic visual', sources: [] };
  const diagram = {
    ...common,
    type: 'diagram',
    nodes: [
      { id: 'request', label: 'Request' },
      { id: 'answer', label: 'Answer' },
    ],
    edges: [{ from: 'request', to: 'answer' }],
  };
  const seats = {
    ...common,
    type: 'seats',
    aircraft: 'Synthetic A350',
    flight: 'ND123 LIS–BKK 2026-12-01',
    sections: [
      {
        id: 'main',
        name: 'Economy',
        deck: 'Main deck',
        rows: [
          {
            label: '1',
            groups: [
              [{ label: '1A', status: 'unknown' }, null],
              [{ label: '1B', status: 'unavailable' }],
            ],
          },
        ],
      },
    ],
    recommended: { sectionId: 'main', seatLabel: '1A' },
  };
  const seatSections = Array.from({ length: 9 }, (_, index) => ({
    ...seats.sections[0],
    id: index === 0 ? 'main' : String(index),
  }));
  assert.ok(presentationSchema.safeParse(diagram).success);
  assert.ok(presentationSchema.safeParse(seats).success);
  const apps = { ...common, type: 'apps', services: ['slack', 'google_drive'] };
  assert.ok(presentationSchema.safeParse(apps).success);
  assert.ok(presentationSchema.safeParse({ ...apps, services: [`a${'b'.repeat(79)}`] }).success);
  for (const services of [
    ['../apps'],
    ['slack/connect'],
    ['Slack'],
    ['1slack'],
    [`a${'b'.repeat(80)}`],
    ['slack', 'slack'],
    ['a', 'b', 'c', 'd'],
    [],
  ])
    assert.equal(presentationSchema.safeParse({ ...apps, services }).success, false);
  const booking = {
    ...common,
    type: 'booking',
    name: 'Synthetic venue',
    status: 'option',
    facts: [{ label: 'Total', value: 'EUR 120' }],
    photos: [{ artifactId: '00000000-0000-4000-8000-000000000001', alt: 'A sourced courtyard' }],
    notes: ['Step-free entry reported by the venue'],
    rating: {
      value: 4.2,
      scale: 5,
      count: 93,
      sourceLabel: 'Fixture reviews',
      url: 'https://example.com/reviews',
      summary: 'Visitors report a quiet courtyard.',
    },
  };
  const alternative = {
    name: 'Other venue',
    status: 'option',
    facts: booking.facts,
    photos: booking.photos,
    rating: booking.rating,
  };
  const comparison = presentationSchema.parse({ ...booking, alternatives: [alternative] });
  assert.deepEqual(presentationImages(comparison), [...booking.photos, ...booking.photos]);
  assert.ok(presentationText(comparison).includes('Other venue'));
  assert.ok(
    presentationSchema.safeParse({
      ...booking,
      alternatives: Array.from({ length: 3 }, () => alternative),
    }).success,
  );
  const venue = presentationSchema.parse(booking);
  assert.deepEqual(presentationImages(venue), booking.photos);
  const venueText = presentationText(venue);
  for (const detail of [
    '4.2/5',
    '93 reviews',
    'https://example.com/reviews',
    'Visitors report a quiet courtyard.',
    'Step-free entry',
    'A sourced courtyard',
  ])
    assert.ok(venueText.includes(detail), detail);
  assert.ok(
    presentationSchema.safeParse({ ...booking, rating: { ...booking.rating, count: undefined } })
      .success,
  );
  for (const value of [
    { ...booking, rating: { ...booking.rating, value: 5.1 } },
    { ...booking, rating: { ...booking.rating, scale: 0 } },
    { ...booking, rating: { ...booking.rating, count: 0 } },
    { ...booking, rating: { ...booking.rating, count: 1.5 } },
    { ...booking, rating: { ...booking.rating, url: 'https://127.0.0.1/reviews' } },
    { ...booking, photos: [{ artifactId: 'https://example.com/photo.png', alt: 'Remote image' }] },
    { ...booking, photos: Array.from({ length: 5 }, () => booking.photos[0]) },
    { ...booking, notes: Array.from({ length: 7 }, () => 'Note') },
    { ...booking, alternatives: Array.from({ length: 4 }, () => alternative) },
    { ...booking, alternatives: [{ ...alternative, rating: { ...booking.rating, value: 6 } }] },
    { ...booking, alternatives: [{ ...alternative, url: 'https://127.0.0.1/venue' }] },
  ])
    assert.equal(presentationSchema.safeParse(value).success, false);
  assert.ok(presentationSchema.safeParse({ ...seats, sections: seatSections.slice(0, 8) }).success);
  for (const url of [
    'javascript:alert(1)',
    'data:text/html,hello',
    'http://example.com',
    'HTTP://example.com',
    'https://127.0.0.1',
    'HTTPS://127.0.0.1',
    'https://169.254.169.254/latest',
    'https://[::1]',
    'https://localhost',
    'https://private.internal',
    'https://user:pass@example.com',
    'HTTPS://user:pass@example.com',
    'https://example.com:8443',
    'https://example.com/?access_token=private',
    'https://example.com/api/artifacts/private',
    '/api/artifacts/private',
  ]) {
    assert.equal(
      presentationSchema.safeParse({ ...diagram, sources: [{ label: 'Source', url }] }).success,
      false,
      url,
    );
    assert.equal(
      presentationSchema.safeParse({
        ...common,
        type: 'booking',
        name: 'Hotel',
        status: 'option',
        facts: [{ label: 'Night', value: 'Synthetic date' }],
        url,
      }).success,
      false,
      url,
    );
  }
  for (const scheme of ['HTTPS', 'hTtPs']) {
    const normalized = presentationSchema.parse({
      ...diagram,
      sources: [{ label: 'Source', url: `${scheme}://EXAMPLE.COM/Route` }],
    });
    assert.equal(normalized.sources[0]?.url, 'https://example.com/Route');
  }
  for (const fragment of [
    'token=synthetic-secret',
    'id_token=synthetic-secret',
    'code=synthetic-secret',
  ]) {
    const normalized = presentationSchema.parse({
      ...diagram,
      sources: [{ label: 'Source', url: `https://example.com/#${fragment}` }],
    });
    assert.equal(normalized.sources[0]?.url, 'https://example.com/');
    assert.doesNotMatch(presentationText(normalized), /synthetic-secret/);
  }
  const seatText = presentationText(
    presentationSchema.parse({
      ...seats,
      coverage: { scope: 'cabin', description: 'All source-supplied business cabin rows' },
      sections: [
        ...seats.sections,
        {
          id: 'upper',
          name: 'Business',
          deck: 'Upper deck',
          rows: [
            {
              label: '1',
              groups: [
                [{ label: '1A', status: 'available', note: 'Left window', price: 'EUR 40' }],
                [null, { label: '1F', status: 'unknown' }],
              ],
            },
          ],
        },
      ],
      recommended: { sectionId: 'upper', seatLabel: '1A' },
    }),
  );
  for (const detail of [
    'Synthetic A350',
    'ND123 LIS–BKK 2026-12-01',
    'Main deck',
    'Upper deck',
    'Economy',
    'Business',
    'All source-supplied business cabin rows',
    'Row 1',
    '1A',
    'Empty position',
    'aisle',
    'Left window',
    'EUR 40',
    'unknown',
    'unavailable',
    'available',
    'Recommended',
  ])
    assert.ok(seatText.includes(detail), detail);
  assert.equal(seatText.match(/Recommended/g)?.length, 1);
  const diagramText = presentationText(
    presentationSchema.parse({
      ...diagram,
      nodes: [
        { id: 'request', label: 'Service', detail: 'Receives the request' },
        { id: 'answer', label: 'Service', detail: 'Returns the answer' },
      ],
    }),
  );
  for (const detail of [
    'Service (request): Receives the request',
    'Service (answer): Returns the answer',
    'Service (request) → Service (answer)',
  ])
    assert.ok(diagramText.includes(detail), detail);
  const collisionText = presentationText(
    presentationSchema.parse({
      ...diagram,
      nodes: [
        { id: 'request', label: 'Service' },
        { id: 'answer', label: 'Service' },
        { id: 'literal', label: 'Service (request)' },
      ],
      edges: [...diagram.edges, { from: 'answer', to: 'literal' }],
    }),
  );
  assert.ok(collisionText.includes('[request] Service → [answer] Service'));
  assert.ok(collisionText.includes('[answer] Service → [literal] Service (request)'));
  for (const value of [
    { ...diagram, version: 2 },
    { ...diagram, type: 'html', html: '<script>alert(1)</script>' },
    { ...diagram, script: 'fetch("https://example.com")' },
    { ...diagram, nodes: [diagram.nodes[0], diagram.nodes[0]] },
    { ...diagram, edges: [{ from: 'missing', to: 'answer' }] },
    { ...seats, sections: [] },
    { ...seats, coverage: { scope: 'complete', description: 'Unverified scope' } },
    { ...seats, coverage: { scope: 'selection', description: 'x'.repeat(241) } },
    { ...seats, sections: [{ ...seats.sections[0], html: '<img src=x onerror=alert(1)>' }] },
    { ...seats, sections: [seats.sections[0], seats.sections[0]] },
    { ...seats, recommended: { sectionId: 'missing', seatLabel: '1A' } },
    { ...seats, recommended: { sectionId: 'main', seatLabel: '9F' } },
    {
      ...seats,
      sections: [
        { ...seats.sections[0], rows: [seats.sections[0].rows[0], seats.sections[0].rows[0]] },
      ],
    },
    {
      ...seats,
      sections: [
        {
          ...seats.sections[0],
          rows: [
            {
              label: '1',
              groups: [
                [{ label: '1A', status: 'unknown' }],
                [{ label: '1A', status: 'available' }],
              ],
            },
          ],
        },
      ],
    },
    {
      ...seats,
      sections: [{ ...seats.sections[0], rows: [{ label: '1', groups: [[null], [null]] }] }],
    },
    {
      ...seats,
      sections: [
        {
          ...seats.sections[0],
          rows: [{ label: '1', groups: [[], [{ label: '1A', status: 'unknown' }]] }],
        },
      ],
    },
    {
      ...seats,
      sections: [
        {
          ...seats.sections[0],
          rows: [
            {
              label: '1',
              groups: [
                Array.from({ length: 6 }, (_, index) => ({
                  label: `L${index}`,
                  status: 'unknown',
                })),
                Array.from({ length: 6 }, (_, index) => ({
                  label: `R${index}`,
                  status: 'unknown',
                })),
              ],
            },
          ],
        },
      ],
    },
    {
      ...seats,
      sections: [
        {
          ...seats.sections[0],
          rows: [
            {
              label: '1',
              groups: Array.from({ length: 5 }, (_, index) => [
                { label: String(index), status: 'unknown' },
              ]),
            },
          ],
        },
      ],
    },
    {
      ...seats,
      sections: seatSections,
    },
    { ...common, type: 'image', artifactId: 'https://example.com/picture.png', alt: 'A picture' },
    { ...common, type: 'map', places: [{ id: 'one', name: 'Place', latitude: 91, longitude: 0 }] },
    {
      ...common,
      type: 'map',
      places: [{ id: 'one', name: 'Place', latitude: 0, longitude: Infinity }],
    },
    { ...diagram, title: ' '.repeat(120) },
  ])
    assert.equal(presentationSchema.safeParse(value).success, false, JSON.stringify(value));
  assert.equal(
    presentationSchema.safeParse({
      ...seats,
      recommended: undefined,
      sections: [
        {
          ...seats.sections[0],
          rows: Array.from({ length: 60 }, (_, index) => ({
            label: String(index),
            groups: [[{ label: `${index}A`, status: 'unknown', note: '界'.repeat(240) }]],
          })),
        },
      ],
    }).success,
    false,
  );
  assert.equal(
    presentationSchema.safeParse({
      ...seats,
      sections: ['main', 'upper'].map((id) => ({
        ...seats.sections[0],
        id,
        rows: Array.from({ length: 31 }, (_, index) => ({
          label: String(index),
          groups: [[{ label: `${index}A`, status: 'unknown' }]],
        })),
      })),
    }).success,
    false,
  );
});

test('flight journeys preserve every leg and distinguish connections from technical stops', () => {
  const endpoint = (
    airport: string,
    date: string,
    time: string,
    timeZone: string,
    terminal: string,
  ) => ({ airport, date, time, timeZone, terminal });
  const flight = {
    version: 1,
    type: 'flights',
    title: 'Synthetic return itinerary',
    sources: [{ label: 'Fare source', url: 'https://example.com/fares' }],
    options: [
      {
        id: 'one',
        label: 'Separate-ticket option',
        price: 'EUR 740 return for one adult',
        baggage: 'One cabin bag',
        url: 'https://example.com/option',
        recommended: true,
        journeys: [
          {
            id: 'outbound',
            label: 'Outbound',
            duration: '34h 45m',
            segments: [
              {
                airline: 'Marketing Air',
                flightNumber: 'ND123',
                operatedBy: 'Operating Air',
                aircraft: 'A350',
                cabin: 'Economy',
                duration: '2h 40m',
                departure: endpoint('LIS', '2026-12-01', '20:15', 'Europe/Lisbon', '1'),
                arrival: endpoint('LHR', '2026-12-01', '22:55', 'Europe/London', '2'),
                technicalStops: [],
                connectionAfter: {
                  duration: '11h 50m',
                  airportChange: 'yes',
                  selfTransfer: 'yes',
                  details: 'Collect bags; travel independently to LGW',
                },
              },
              {
                airline: 'Second Air',
                flightNumber: 'SA12',
                departure: endpoint('LGW', '2026-12-02', '10:45', 'Europe/London', 'South'),
                arrival: endpoint('DXB', '2026-12-02', '20:00', 'Asia/Dubai', '3'),
                technicalStops: [
                  { airport: 'DOH', duration: '45m', details: 'Remain on the aircraft' },
                ],
                connectionAfter: { duration: '3h', airportChange: 'no', selfTransfer: 'unknown' },
              },
              {
                airline: 'Third Air',
                departure: endpoint('DXB', '2026-12-02', '23:00', 'Asia/Dubai', '3'),
                arrival: endpoint('BKK', '2026-12-03', '08:00', 'Asia/Bangkok', 'Main'),
                technicalStops: [],
              },
            ],
          },
          {
            id: 'return',
            label: 'Return',
            segments: [
              {
                airline: 'Marketing Air',
                departure: { airport: 'BKK', time: '12:00' },
                arrival: { airport: 'LIS', time: '20:00' },
              },
            ],
          },
        ],
      },
    ],
  };
  const parsed = presentationSchema.parse(flight);
  assert.equal(parsed.type, 'flights');
  if (parsed.type !== 'flights') throw new Error('Expected a flight presentation.');
  const journey = parsed.options[0].journeys[0];
  assert.equal(flightJourneySummary(journey), '2 connections · 1 technical stop');
  assert.equal(
    flightJourneySummary({
      ...journey,
      segments: journey.segments.map((segment, index) =>
        index === 0 ? { ...segment, technicalStops: undefined } : segment,
      ),
    }),
    '2 connections · 1 reported technical stop · Technical stop details not provided',
  );
  assert.equal(
    flightJourneySummary(parsed.options[0].journeys[1]),
    'No connections · Technical stop details not provided',
  );
  const direct = { ...journey, segments: [{ ...journey.segments[2], technicalStops: [] }] };
  assert.equal(flightJourneySummary(direct), 'Nonstop');
  assert.equal(
    flightJourneySummary({
      ...direct,
      segments: [{ ...direct.segments[0], technicalStops: [{ airport: 'DOH' }] }],
    }),
    'No connections · 1 technical stop',
  );
  const summary = presentationText(parsed);
  for (const detail of [
    'Separate-ticket option',
    'EUR 740 return for one adult',
    'One cabin bag',
    'Recommended',
    'Outbound',
    'Return',
    '34h 45m',
    'Marketing Air',
    'Operating Air',
    'ND123',
    'A350',
    'Economy',
    '2h 40m',
    'LIS',
    'LHR',
    'LGW',
    'DXB',
    'BKK',
    '2026-12-01',
    '2026-12-02',
    '2026-12-03',
    '20:15',
    '22:55',
    '10:45',
    '23:00',
    '08:00',
    'Europe/Lisbon',
    'Europe/London',
    'Asia/Dubai',
    'Asia/Bangkok',
    'Terminal South',
    'Airport change: yes',
    'Self-transfer: yes',
    'Self-transfer: unknown',
    'Collect bags',
    'DOH',
    '45m',
    'Remain on the aircraft',
    'https://example.com/fares',
    'https://example.com/option',
    'Date not provided',
    'Time zone not provided',
  ])
    assert.ok(summary.includes(detail), detail);
  const option = parsed.options[0];
  assert.equal(option.status, undefined);
  assert.equal(presentationInputSchema.safeParse(parsed).success, false);
  for (const status of ['booked', 'option', 'unknown'] as const) {
    const classified: Presentation = { ...parsed, options: [{ ...option, status }] };
    assert.deepEqual(presentationInputSchema.parse(classified), classified);
  }
  const booked = presentationSchema.parse({
    ...parsed,
    options: [{ ...option, status: 'booked', bookingReference: 'SYNTH42', price: undefined }],
  });
  const bookedText = presentationText(booked);
  assert.match(bookedText, /Booked/);
  assert.match(bookedText, /Booking reference: SYNTH42/);
  assert.doesNotMatch(bookedText, /Option \d|undefined|EUR 740|Recommended/);
  const unconfirmed = presentationSchema.parse({
    ...parsed,
    options: [{ ...option, status: 'unknown' }],
  });
  assert.match(presentationText(unconfirmed), /Booking status unknown/);
  assert.doesNotMatch(presentationText(unconfirmed), /Recommended/);
  assert.match(summary, /Recommended/);
  assert.doesNotMatch(summary, /Booking status unknown/);
  assert.doesNotMatch(bookedText, /Booking status unknown/);
  assert.equal(
    presentationSchema.safeParse({ ...parsed, options: [{ ...option, status: 'unverified' }] })
      .success,
    false,
  );
  const outbound = option.journeys[0];
  const invalidJourneys = [
    [],
    [outbound, outbound],
    [{ ...outbound, segments: [] }],
    [
      {
        ...outbound,
        segments: [
          { ...outbound.segments[0], connectionAfter: undefined },
          ...outbound.segments.slice(1),
        ],
      },
    ],
    [
      {
        ...outbound,
        segments: [
          ...outbound.segments.slice(0, 2),
          { ...outbound.segments[2], connectionAfter: { airportChange: 'no', selfTransfer: 'no' } },
        ],
      },
    ],
    [
      {
        ...outbound,
        segments: [
          { ...outbound.segments[0], connectionAfter: { airportChange: 'no' } },
          ...outbound.segments.slice(1),
        ],
      },
    ],
    [
      {
        ...outbound,
        segments: [
          {
            ...outbound.segments[0],
            departure: { ...outbound.segments[0].departure, url: 'https://127.0.0.1/' },
          },
          ...outbound.segments.slice(1),
        ],
      },
    ],
    [
      {
        ...outbound,
        segments: [
          {
            ...outbound.segments[0],
            technicalStops: Array.from({ length: 5 }, () => ({ airport: 'DOH' })),
          },
          ...outbound.segments.slice(1),
        ],
      },
    ],
    [
      {
        ...outbound,
        segments: Array.from({ length: 9 }, (_, index) => ({
          ...outbound.segments[0],
          connectionAfter: index === 8 ? undefined : outbound.segments[0].connectionAfter,
        })),
      },
    ],
    Array.from({ length: 7 }, (_, index) => ({ ...outbound, id: String(index) })),
  ];
  for (const journeys of invalidJourneys) {
    const invalid = { ...flight, options: [{ ...option, status: 'unknown', journeys }] };
    assert.equal(presentationSchema.safeParse(invalid).success, false);
    assert.equal(presentationInputSchema.safeParse(invalid).success, false);
  }
  assert.equal(
    presentationSchema.safeParse({
      ...flight,
      options: [{ ...option, url: 'https://example.com/?access_token=secret' }],
    }).success,
    false,
  );
  assert.equal(
    presentationSchema.safeParse({
      ...flight,
      options: Array.from({ length: 8 }, (_, index) => ({
        ...option,
        id: String(index),
        journeys: option.journeys.map((journey) => ({
          ...journey,
          segments: journey.segments.map((segment) => ({
            ...segment,
            aircraft: '界'.repeat(120),
            cabin: '界'.repeat(80),
          })),
        })),
      })),
    }).success,
    false,
  );
});

test('charts accept signed finite data and reject ambiguous series or excessive values', () => {
  const chart = {
    version: 1,
    type: 'chart',
    title: 'Synthetic change',
    sources: [],
    chart: 'line',
    unit: 'EUR',
    series: [
      {
        id: 'net',
        label: 'Net',
        points: [
          { label: 'January', value: -12.5 },
          { label: 'February', value: 0 },
        ],
      },
    ],
  };
  assert.ok(presentationSchema.safeParse(chart).success);
  assert.ok(presentationSchema.safeParse({ ...chart, chart: 'bar' }).success);
  for (const kind of ['bar', 'line', 'pie', 'donut']) {
    assert.equal(
      presentationSchema.safeParse({ ...chart, chart: kind, series: [] }).success,
      false,
    );
    assert.equal(
      presentationSchema.safeParse({
        ...chart,
        chart: kind,
        series: [{ ...chart.series[0], points: [] }],
      }).success,
      false,
    );
  }
  for (const kind of ['pie', 'donut']) {
    const radial = {
      ...chart,
      chart: kind,
      series: [
        {
          id: 'spend',
          label: 'Spend',
          points: [
            { label: 'Travel', value: 80 },
            { label: 'Food', value: 20 },
            { label: 'Other', value: 0 },
          ],
        },
      ],
    };
    assert.ok(presentationSchema.safeParse(radial).success);
    assert.match(
      presentationText(presentationSchema.parse(radial)),
      /Travel: 80 EUR; Food: 20 EUR; Other: 0 EUR/,
    );
    for (const series of [
      [...radial.series, { ...radial.series[0], id: 'second' }],
      [{ ...radial.series[0], points: [{ label: 'Invalid', value: -1 }] }],
      [{ ...radial.series[0], points: [{ label: 'Empty', value: 0 }] }],
      [
        {
          ...radial.series[0],
          points: Array.from({ length: 13 }, (_, index) => ({
            label: String(index),
            value: index + 1,
          })),
        },
      ],
    ])
      assert.equal(presentationSchema.safeParse({ ...radial, series }).success, false);
  }
  for (const value of [
    { ...chart, series: [...chart.series, chart.series[0]] },
    {
      ...chart,
      series: [
        ...chart.series,
        { id: 'other', label: 'Other', points: [...chart.series[0].points].reverse() },
      ],
    },
    {
      ...chart,
      series: [
        { ...chart.series[0], points: [chart.series[0].points[0], chart.series[0].points[0]] },
      ],
    },
    ...[Infinity, NaN, 1e13, -1e13].map((value) => ({
      ...chart,
      series: [{ id: 'bad', label: 'Bad', points: [{ label: 'January', value }] }],
    })),
    {
      ...chart,
      series: [
        {
          ...chart.series[0],
          points: Array.from({ length: 25 }, (_, index) => ({
            label: String(index),
            value: index,
          })),
        },
      ],
    },
    { ...chart, formula: 'fetch("https://example.com")' },
  ])
    assert.equal(presentationSchema.safeParse(value).success, false);
});
