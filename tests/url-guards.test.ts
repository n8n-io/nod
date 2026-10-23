import assert from 'node:assert/strict';
import { createServer, request } from 'node:http';
import { once } from 'node:events';
import test from 'node:test';
import { crc32 } from 'node:zlib';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { JSDOM } from 'jsdom';
import { createBrowserProxy, publicLookup } from '../src/providers/agent-browser/network.ts';
import {
  createPublicLinkPreviewProvider,
  decodeHtml,
  parseLinkMetadata,
  requestPublicPreview,
} from '../src/providers/public-web/link-preview.ts';
import { previewableUrl, publicMediaUrl } from '../src/shared/link-preview.ts';
import { artifactImage, artifactPreview } from '../src/web/components/attachment-images.tsx';
import { sandboxedDocument } from '../src/web/components/attachment-frame.tsx';
import { localPreviewable } from '../src/web/lib/attachment-kind.ts';
import { MessageText } from '../src/web/components/message.tsx';
import type { Artifact } from '../src/shared/contracts.ts';
import { connectionUrl } from '../src/web/lib/connection-url.ts';
import { ownerAddress } from '../src/providers/discovered/remote.ts';
import { messageSetupLinks, safeMessageLink, setupLink } from '../src/web/lib/message-links.ts';

const origin = 'http://localhost:4310';
const render = (text: string) => renderToStaticMarkup(createElement(MessageText, { text }));

const addresses = async () => [{ address: '93.184.216.34', family: 4 }];
const html = (text = '<title>Fixture page</title>') => ({
  status: 200,
  headers: { 'content-type': 'text/html; charset=utf-8' },
  body: Buffer.from(`<html><head>${text}</head><body>Fixture</body></html>`),
});
const png = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAQAAAAECAIAAAAmkwkpAAAACXBIWXMAAAABAAAAAQBPJcTWAAAAEElEQVR4nGP8w4AALAxEcQAz1AEKG5dMywAAAABJRU5ErkJggg==',
  'base64',
);
const jpeg = Buffer.from(
  '/9j/4AAQSkZJRgABAQAASABIAAD/2wBDAAICAgICAgMCAgMFAwMDBQYFBQUFBggGBgYGBggKCAgICAgICgoKCgoKCgoMDAwMDAwODg4ODg8PDw8PDw8PDw//2wBDAQICAgQEBAcEBAcQCwkLEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBD/wAARCAABAAEDASIAAhEBAxEB/8QAFQABAQAAAAAAAAAAAAAAAAAAAAn/xAAUEAEAAAAAAAAAAAAAAAAAAAAA/8QAFQEBAQAAAAAAAAAAAAAAAAAAAAP/xAAUEQEAAAAAAAAAAAAAAAAAAAAA/9oADAMBAAIRAxEAPwCrAAo//9k=',
  'base64',
);

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

test('preview media comes only from public addresses and players only over HTTPS', () => {
  const page = (head: string) =>
    parseLinkMetadata(
      `<html><head><title>Page</title>${head}</head></html>`,
      'https://news.example.org/a',
    );
  assert.equal(
    page('<meta property="og:image" content="http://127.0.0.1/a.png">')?.image,
    undefined,
  );
  assert.equal(
    page('<script type="application/ld+json">{"image":["https://cdn.example.org/a.jpg"]}</script>')
      ?.image,
    'https://cdn.example.org/a.jpg',
  );
  assert.equal(
    page('<meta name="twitter:player" content="http://video.example.org/embed/1">')?.player,
    undefined,
  );
  assert.equal(
    page('<meta name="twitter:player" content="https://10.0.0.1/embed/1">')?.player,
    undefined,
  );
  for (const address of ['100.64.0.1', '192.0.0.1', '198.18.0.1', '224.0.0.1']) {
    assert.equal(
      page(`<meta name="twitter:player" content="https://${address}/embed/1">`)?.player,
      undefined,
    );
    assert.equal(
      page(`<meta property="og:image" content="https://${address}/image.png">`)?.image,
      undefined,
    );
  }
  assert.equal(
    page('<meta property="og:video:url" content="https://video.example.org/1.mp4">')?.player,
    undefined,
  );
  assert.equal(
    page('<meta name="twitter:player" content="https://video.example.org/embed/1">')?.player,
    'https://video.example.org/embed/1',
  );
});

test('preview pages decode with their declared charset', () => {
  const latin = Buffer.from(
    '<html><head><meta charset="iso-8859-1"><title>Pastéis</title></head></html>',
    'latin1',
  );
  assert.equal(parseLinkMetadata(decodeHtml(latin), 'https://shop.example.org/')?.title, 'Pastéis');
  assert.equal(
    parseLinkMetadata(
      decodeHtml(latin, 'text/html; charset=ISO-8859-1'),
      'https://shop.example.org/',
    )?.title,
    'Pastéis',
  );
});

test('a player whose host resolves to a private address is dropped', async () => {
  const page = (player: string) =>
    createPublicLinkPreviewProvider({
      resolver: async (host) => [
        { address: host === 'player.example.org' ? '10.0.0.7' : '93.184.216.34', family: 4 },
      ],
      request: async () =>
        html(`<title>Video</title><meta name="twitter:player" content="${player}">`),
    }).metadata('https://video.example.org/watch');
  assert.equal((await page('https://player.example.org/embed/1'))?.player, undefined);
  assert.equal(
    (await page('https://cdn.example.org/embed/1'))?.player,
    'https://cdn.example.org/embed/1',
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
  assert.equal(await provider.metadata('https://example.com/first'), null);
  assert.equal(lookups, 2);
  assert.deepEqual(calls, ['https://example.com/first']);
  let requested = false;
  const mixed = createPublicLinkPreviewProvider({
    resolver: async () => [...(await addresses()), { address: '10.0.0.2', family: 4 }],
    request: async () => {
      requested = true;
      return html();
    },
  });
  assert.equal(await mixed.metadata('https://example.com'), null);
  assert.equal(requested, false);
  for (const location of [
    'http://169.254.169.254/latest',
    'https://example.com/oauth/approve',
    'https://example.com/?token=secret',
  ]) {
    let requests = 0;
    const redirected = createPublicLinkPreviewProvider({
      resolver: addresses,
      request: async () => {
        requests++;
        return { status: 302, headers: { location }, body: new Uint8Array() };
      },
    });
    assert.equal(await redirected.metadata('https://example.com/article'), null);
    assert.equal(requests, 1);
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

test('image proxy provider accepts bounded raster data and rejects SVG, spoofed types and oversized dimensions', async () => {
  const oversized = Buffer.from(png);
  oversized.writeUInt32BE(100000, 16);
  oversized.writeUInt32BE(crc32(oversized.subarray(12, 29)), 29);
  for (const [body, mime, expected] of [
    [png, 'image/png', true],
    [png, 'image/jpeg', false],
    [jpeg, 'image/jpg', true],
    [Buffer.from('<svg/>'), 'image/svg+xml', false],
    [oversized, 'image/png', false],
    [Buffer.alloc(5 * 1024 * 1024 + 1), 'image/png', false],
  ] as const) {
    const provider = createPublicLinkPreviewProvider({
      resolver: addresses,
      request: async () => ({ status: 200, headers: { 'content-type': mime }, body }),
    });
    const result = await provider.image('https://example.com/image');
    assert.equal(Boolean(result), expected);
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

test('setup links omit tokens and fragments and approval paths never become links', () => {
  const link = safeMessageLink(
    '/credentials/request-id?token=private-token#private-fragment',
    origin,
  )!;
  assert.deepEqual(link, { href: '/credentials/request-id', kind: 'setup', setup: 'vault' });
  assert.equal(safeMessageLink('/approvals/action-id', origin), null);
  assert.equal(safeMessageLink(`${origin}/approvals/action-id`, origin), null);
  const result = render(
    `[Add login](/credentials/request-id?token=private-token#private-fragment) [Add login](${origin}/vault/another-id) [Add login](https://outside.example/credentials/request-id) [Connect Calendar](https://outside.example/connect)`,
  );
  for (const href of ['/credentials/request-id', '/vault/another-id']) {
    const anchor = result.match(new RegExp(`<a\\b[^>]*href="${href}"[^>]*>`))?.[0];
    assert.ok(anchor);
    assert.match(anchor, /\brel="opener"/);
    assert.match(anchor, /\breferrerPolicy="no-referrer"/);
  }
  const external = result.match(
    /<a\b[^>]*href="https:\/\/outside\.example\/credentials\/request-id"[^>]*>/,
  )?.[0];
  assert.ok(external);
  assert.match(external, /\brel="noopener noreferrer"/);
  assert.match(external, /\breferrerPolicy="no-referrer"/);
  const ordinary = JSDOM.fragment(result).querySelector(
    'a[href="https://outside.example/connect"]',
  );
  assert.equal(ordinary?.getAttribute('target'), '_blank');
  assert.equal(ordinary?.getAttribute('rel'), 'noopener noreferrer');
  assert.equal(ordinary?.getAttribute('referrerPolicy'), 'no-referrer');
  assert.equal(JSDOM.fragment(result).querySelector('button[data-setup="app"]'), null);
  for (const href of [
    `http://127.0.0.1:54321/${'a'.repeat(43)}`,
    `http://127.0.0.1:61530/${'B'.repeat(43)}`,
  ]) {
    const document = JSDOM.fragment(render(`[Connect Calendar](${href})`));
    assert.ok(document.querySelector('button[data-setup="app"]'));
    assert.equal(document.querySelector('a'), null);
    const sentence = JSDOM.fragment(
      render(`[Connect your calendar, then I'll continue.](${href})`),
    );
    assert.ok(sentence.querySelector('button[data-setup="app"]'));
    assert.equal(
      sentence.querySelector('.setup-phrase')?.textContent,
      "Connect your calendar, then I'll continue.",
    );
    assert.equal(sentence.querySelector('a'), null);
  }
  const discovered = JSDOM.fragment(
    render(
      '[Connect your calendar, then I will continue.](/apps?connect=00000000-0000-4000-8000-000000000000)',
    ),
  );
  assert.equal(
    discovered.querySelector('.setup-phrase')?.textContent,
    'Connect your calendar, then I will continue.',
  );
  for (const href of [
    'https://connect.composio.dev.example.test/link/synthetic',
    'https://connect.composio.dev:8443/link/synthetic',
    'http://connect.composio.dev/link/synthetic',
    `https://127.0.0.1:54321/${'a'.repeat(43)}`,
    `http://localhost:54321/${'a'.repeat(43)}`,
    `http://127.0.0.1:54321/${'a'.repeat(43)}?`,
    `http://127.0.0.1:54321/${'a'.repeat(43)}#`,
    `http://127.0.0.1:54321/${'a'.repeat(43)}?#`,
    `http://127.0.0.1:54321/${'a'.repeat(43)}?unexpected=yes`,
    `http://127.0.0.1:54321/${'a'.repeat(42)}`,
  ]) {
    for (const text of ['Connect Calendar', "Connect your calendar, then I'll continue."]) {
      const document = JSDOM.fragment(render(`[${text}](${href})`));
      assert.equal(document.querySelector('button[data-setup="app"]'), null);
      assert.equal(document.querySelector('a')?.getAttribute('href'), href);
    }
  }
  assert.doesNotMatch(result, /private-token|private-fragment/);
});

test('Save links open only an empty local form without accepting secret query data', () => {
  for (const kind of ['login', 'card']) {
    const path = `/vault?add=${kind}`;
    const expected = { href: path, kind: 'setup', setup: 'vault' };
    assert.deepEqual(safeMessageLink(path, origin), expected);
    assert.deepEqual(safeMessageLink(`${origin}${path}`, origin), expected);
    assert.deepEqual(safeMessageLink(`/trust?add=${kind}`, origin), expected);
    assert.deepEqual(safeMessageLink(`${origin}/trust?add=${kind}`, origin), expected);
  }
  for (const link of ['/trust', `${origin}/trust`])
    assert.deepEqual(safeMessageLink(link, origin), { href: '/usage', kind: 'navigation' });
  for (const query of [
    '?add=card&cardNumber=4242424242424242',
    '?add=login&origin=https%3A%2F%2Fexample.test',
    '?add=login&username=synthetic',
    '?add=login&password=synthetic',
    '?add=login&add=login',
    '?add=login#synthetic',
  ]) {
    for (const page of ['/vault', '/trust']) {
      assert.equal(safeMessageLink(`${page}${query}`, origin), null);
      assert.equal(safeMessageLink(`${origin}${page}${query}`, origin), null);
    }
  }
  const external = safeMessageLink('https://outside.example/vault?add=login', origin)!;
  assert.equal(external.kind, 'external');
  assert.equal(setupLink(external, 'Save login in Vault'), null);
  assert.equal(safeMessageLink('//outside.example/vault?add=login', origin), null);
  const result = render('[Save login in Vault](/vault?add=login)');
  const link = JSDOM.fragment(result).querySelector('a[data-setup="vault"]');
  assert.equal(link?.getAttribute('href'), '/vault?add=login');
  assert.equal(link?.getAttribute('rel'), 'noopener noreferrer');
});

test('only intended app paths and credential-free HTTP URLs become links', () => {
  for (const path of [
    '/',
    '/tasks',
    '/apps',
    '/channels',
    '/usage',
    '/vault',
    '/settings',
    '/settings/models',
    '/settings/memory',
  ]) {
    for (const value of [path, `${origin}${path}`]) {
      assert.deepEqual(safeMessageLink(value, origin), { href: path, kind: 'navigation' });
      const anchor = JSDOM.fragment(render(`[Open](${value})`)).querySelector('a');
      assert.equal(anchor?.getAttribute('href'), path);
      assert.equal(anchor?.getAttribute('target'), null);
    }
  }
  assert.deepEqual(safeMessageLink('/memory', origin), {
    href: '/settings/memory',
    kind: 'navigation',
  });
  for (const value of [
    '/settings/unknown',
    '/settings/models/../../api/vault',
    '/settings/models?access=synthetic',
    '/settings/models#access=synthetic',
    `${origin}/settings/models?access=synthetic`,
    `${origin}/settings/models#access=synthetic`,
    'javascript:alert(1)',
    'JaVaScRiPt:alert',
    'data:text/html,test',
    'file:///etc/passwd',
    'mailto:hello@example.com',
    '//evil.example/api/artifacts/id',
    '/api/vault',
    '/api/artifacts/',
    '/api/artifacts/id/extra',
    '/api/artifacts/id/../../credentials/request',
    '/api/artifacts/%2e%2e/credentials/request',
    '/api/artifacts/id%2f..%2fvault',
    'http://localhost:4310/api/vault',
    'http://localhost:4310/api/artifacts/id/../../credentials/request',
    'https://user:password@example.com/',
    'https://example.com/\njavascript:alert',
    'https:\\evil.example',
    'https://example.com/"onclick="alert',
  ])
    assert.equal(safeMessageLink(value, origin), null, value);
  assert.deepEqual(safeMessageLink('https://example.com/docs?q=nod#usage', origin), {
    href: 'https://example.com/docs?q=nod#usage',
    kind: 'external',
  });
  assert.deepEqual(safeMessageLink('/api/artifacts/file-id', origin), {
    href: '/api/artifacts/file-id',
    kind: 'artifact',
  });
  const result = render(
    '//evil.example/api/artifacts/id file:///credentials/id javascript:/approvals/id',
  );
  assert.doesNotMatch(result, /<a /);
});

test('plain browser connection paths hide their token behind one fixed action', () => {
  const path = `/browser-connect/${'x'.repeat(43)}`;
  const text = `Continue at ${path}?token=hidden#fragment. Again ${path}.`;
  assert.deepEqual(messageSetupLinks(text, origin), [
    { href: path, setup: 'website', label: 'Connect website' },
  ]);
  const [body] = render(text).split('<div class="setup-group">');
  assert.doesNotMatch(body, /xxxx|token=hidden|fragment/);
  for (const token of ['x'.repeat(42), 'x'.repeat(44)])
    assert.deepEqual(messageSetupLinks(`/browser-connect/${token}`, origin), []);
});

test('file previews accept only owned artifact URLs and keep active content out of the app origin', () => {
  const picture: Artifact = {
    id: '00000000-0000-4000-8000-000000000000',
    name: 'Picture.png',
    mimeType: 'image/png',
    size: 2048,
    url: '/api/artifacts/00000000-0000-4000-8000-000000000000',
  };
  for (const mimeType of [
    'application/pdf',
    'audio/mp4',
    'video/webm',
    'image/svg+xml',
    'text/plain',
    'application/json',
    'text/html',
  ]) {
    assert.ok(artifactPreview({ ...picture, mimeType }));
    for (const url of [
      'https://example.com/file',
      '//example.com/file',
      'data:application/pdf,test',
      '/api/artifacts/abc?token=private',
    ])
      assert.equal(artifactPreview({ ...picture, mimeType, url }), null);
  }
  for (const name of [
    'notes.txt',
    'report.md',
    'data.csv',
    'report.pdf',
    'table.xlsx',
    'brief.docx',
    'deck.pptx',
    'page.html',
    'sticker.tgs',
  ]) {
    const file = { ...picture, name, mimeType: 'application/octet-stream' };
    assert.ok(artifactPreview(file));
    assert.equal(artifactImage(file), null);
    assert.equal(artifactPreview({ ...file, url: 'https://example.com/file' }), null);
  }
  assert.ok(artifactImage(picture));
  for (const url of [
    'https://example.com/image.png',
    'javascript:alert(1)',
    '/credentials/private',
    '/api/artifacts/abc?token=private',
  ])
    assert.equal(artifactImage({ ...picture, url }), null);
  for (const [mimeType, name] of [
    ['text/html', 'page.png'],
    ['application/xhtml+xml', 'page'],
    ['image/svg+xml', 'logo'],
    ['application/xml', 'feed'],
    ['application/rss+xml', 'feed'],
    ['text/plain', 'page.html'],
    ['', 'logo.svg'],
    ['application/octet-stream', 'feed.xml'],
    ['application/x-tgsticker', 'sticker'],
    ['application/octet-stream', 'sticker.tgs'],
  ])
    assert.equal(localPreviewable(mimeType, name), false, `${mimeType} ${name}`);
  for (const [mimeType, name] of [
    ['image/png', 'photo.png'],
    ['text/csv', 'data.csv'],
    ['application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', 'table.xlsx'],
    ['application/pdf', 'report.pdf'],
  ])
    assert.equal(localPreviewable(mimeType, name), true, `${mimeType} ${name}`);
  const { document } = new JSDOM(
    sandboxedDocument(
      '<!doctype html><head><meta http-equiv="Content-Security-Policy" content="default-src *"><base target="_self"></head><script>fetch("https://example.com")</script>',
    ),
  ).window;
  const [policy, ...rest] = Array.from(document.head.children);
  assert.equal(policy.getAttribute('http-equiv'), 'Content-Security-Policy');
  assert.match(policy.getAttribute('content') ?? '', /^default-src 'none';/);
  assert.doesNotMatch(policy.getAttribute('content') ?? '', /https?:|\*|connect-src/);
  assert.equal(document.querySelector('base')?.getAttribute('target'), '_blank');
  assert.ok(rest.length >= 3);
});

test('web tool connections use a DNS answer only when every address in it is public', async () => {
  const connect = (answers: Array<{ address: string; family: number }>) =>
    new Promise((resolve) =>
      publicLookup(async () => answers)('fixture.example', { all: true }, (error, found) =>
        resolve(error ? 'blocked' : found),
      ),
    );
  const public4 = { address: '93.184.216.34', family: 4 };
  assert.deepEqual(await connect([public4]), [public4]);
  assert.equal(await connect([public4, { address: '127.0.0.1', family: 4 }]), 'blocked');
  assert.equal(await connect([{ address: '::ffff:169.254.169.254', family: 6 }]), 'blocked');
  for (const address of ['2001:0002::1', '2001:0DB8:0:0::1', '2001:0000:4136::1'])
    assert.equal(await connect([{ address, family: 6 }]), 'blocked');
  const public6 = { address: '2606:4700:0000::1111', family: 6 };
  assert.deepEqual(await connect([public6]), [public6]);
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
