import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { createServer, request } from 'node:http';
import { once } from 'node:events';
import test from 'node:test';
import { crc32 } from 'node:zlib';
import { act, createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { JSDOM } from 'jsdom';
import { actionConfirmation } from '../src/server/action-presentation.ts';
import { createBrowserProxy } from '../src/providers/agent-browser/network.ts';
import {
  createPublicLinkPreviewProvider,
  requestPublicPreview,
} from '../src/providers/public-web/link-preview.ts';
import { previewableUrl } from '../src/shared/link-preview.ts';
import { artifactImage, artifactPreview } from '../src/web/components/attachment-images.tsx';
import { MessageText } from '../src/web/components/message.tsx';
import type { Artifact, Connection } from '../src/shared/contracts.ts';
import { connectionUrl } from '../src/web/lib/connection-url.ts';
import { messageSetupLinks, safeMessageLink, setupLink } from '../src/web/lib/message-links.ts';
import { connectionGroups, connectionIssue } from '../src/web/lib/secondary-pages.ts';

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
  ])
    assert.equal(previewableUrl(value), null, value);
  assert.equal(
    previewableUrl('https://example.com/article#heading'),
    'https://example.com/article',
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
});

test('private and credential redirects, loops, non-HTML and oversized fixture bodies stay unavailable', async () => {
  for (const location of [
    'http://169.254.169.254/latest',
    'https://example.com/oauth/approve',
    'https://example.com/?token=secret',
  ]) {
    let requests = 0;
    const provider = createPublicLinkPreviewProvider({
      resolver: addresses,
      request: async () => {
        requests++;
        return { status: 302, headers: { location }, body: new Uint8Array() };
      },
    });
    assert.equal(await provider.metadata('https://example.com/article'), null);
    assert.equal(requests, 1);
  }
  let redirects = 0;
  const loop = createPublicLinkPreviewProvider({
    resolver: addresses,
    request: async () => {
      redirects++;
      return { status: 302, headers: { location: '/loop' }, body: new Uint8Array() };
    },
  });
  assert.equal(await loop.metadata('https://example.com'), null);
  assert.equal(redirects, 4);
  for (const result of [
    { ...html(), headers: { 'content-type': 'application/json' } },
    { ...html(), headers: { 'content-type': 'text/html', 'content-encoding': 'gzip' } },
    { ...html(), body: Buffer.alloc(256 * 1024 + 1) },
  ])
    assert.equal(
      await createPublicLinkPreviewProvider({
        resolver: addresses,
        request: async () => result,
      }).metadata('https://example.com'),
      null,
    );
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
    [Buffer.from('<svg/>'), 'image/svg+xml', false],
    [oversized, 'image/png', false],
    [Buffer.alloc(1024 * 1024 + 1), 'image/png', false],
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
  for (const value of [
    'http://elsewhere.example/consent',
    'http://localhost:4310/consent',
    'javascript:alert(1)',
    'data:text/html,login',
    'https://user:password@example.com/consent',
    'http://localhost:4320@elsewhere.example/consent',
  ])
    assert.throws(() => connectionUrl(value, origin));
});

test('chat HTML cannot run scripts, submit forms, load trackers or link to local internals', () => {
  const result = render(
    '<script>alert(1)</script><style>body{display:none}</style><iframe src="https://evil.example"></iframe><form action="/api/messages"><input name="text" value="bad"></form><img src="https://evil.example/track" onerror="alert(1)"><a href="javascript:alert(1)">bad</a><a href="/api/state">internal</a>\n\n![picture](https://evil.example/pixel)',
  );
  for (const expression of [
    /<script/i,
    /<style/i,
    /<iframe/i,
    /<form/i,
    /onerror=/i,
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
  assert.equal(setupLink(link, 'Add authenticator code')!.label, 'Add authenticator code');
  assert.equal(setupLink(link, `${origin}/credentials/request-id`)!.label, 'Open Vault');
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
  const action = JSDOM.fragment(result).querySelector('button[data-setup="app"]');
  assert.equal(action?.textContent, 'Connect Calendar');
  assert.doesNotMatch(result, /href="https:\/\/outside\.example\/connect"/);
  assert.doesNotMatch(result, /private-token|private-fragment/);
});

test('Vault save links open only an empty local form without accepting secret query data', () => {
  for (const kind of ['login', 'card']) {
    const path = `/vault?add=${kind}`;
    const expected = { href: path, kind: 'setup', setup: 'vault' };
    assert.deepEqual(safeMessageLink(path, origin), expected);
    assert.deepEqual(safeMessageLink(`${origin}${path}`, origin), expected);
  }
  for (const query of [
    '?add=card&cardNumber=4242424242424242',
    '?add=login&origin=https%3A%2F%2Fexample.test',
    '?add=login&username=synthetic',
    '?add=login&password=synthetic',
    '?add=login&add=login',
    '?add=login#synthetic',
  ]) {
    assert.equal(safeMessageLink(`/vault${query}`, origin), null);
    assert.equal(safeMessageLink(`${origin}/vault${query}`, origin), null);
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

test('an owned payment link remains an action in the desktop conversation', () => {
  const path = '/payments/9a7fc76a-9f96-4890-8865-1157048f47bc';
  const result = render(`[Approve payment](${path})`);
  const link = JSDOM.fragment(result).querySelector('a[data-setup="vault"]');
  assert.equal(link?.getAttribute('href'), path);
  assert.equal(previewableUrl(`https://example.com${path}`), null);
});

test('an existing native account does not hide authorization for another account', () => {
  const text = '[Connect Gmail](https://connect.composio.dev/link/synthetic-personal-account)';
  const before = render(text);
  assert.equal(JSDOM.fragment(before).querySelectorAll('button[data-setup="app"]').length, 1);
  const after = renderToStaticMarkup(
    createElement(MessageText, { text, connectedAppIds: new Set(['gmail']) }),
  );
  const actions = JSDOM.fragment(after).querySelectorAll('button[data-setup="app"]');
  assert.equal(actions.length, 1);
  assert.equal(actions[0].hasAttribute('disabled'), false);
  assert.doesNotMatch(after, /connect\.composio\.dev/);
});

test('an app setup action hides only after its exact connection is connected', () => {
  const id = '00000000-0000-4000-8000-000000000001';
  const text = `[Connect Gmail](/apps?connect=${id})`;
  const unrelated = renderToStaticMarkup(
    createElement(MessageText, {
      text,
      connectedAppIds: new Set(['gmail', '00000000-0000-4000-8000-000000000002']),
    }),
  );
  assert.equal(JSDOM.fragment(unrelated).querySelectorAll('button[data-setup="app"]').length, 1);
  const connected = renderToStaticMarkup(
    createElement(MessageText, { text, connectedAppIds: new Set([id]) }),
  );
  assert.equal(JSDOM.fragment(connected).querySelectorAll('button[data-setup="app"]').length, 0);
});

test('setup actions match canonical owned links and retain other account requests across refreshes', async () => {
  const dom = new JSDOM('<!doctype html><div id="root"></div>', {
    url: origin,
    pretendToBeVisual: true,
  });
  const discoveryId = 'abcdef01-abcd-4000-8000-abcdef000003';
  const links = [
    'https://connect.composio.dev/link/synthetic-work',
    'https://connect.composio.dev/link/synthetic-personal',
    `/apps?connect=${discoveryId.toUpperCase()}`,
  ];
  const hashes = [links[0], links[1], `/apps?connect=${discoveryId}`].map((href) =>
    createHash('sha256').update(href).digest('hex'),
  );
  const requests: string[][] = [];
  let completed: string[] = [];
  let failing = false;
  const globals = {
    window: dom.window,
    document: dom.window.document,
    HTMLElement: dom.window.HTMLElement,
    Element: dom.window.Element,
    Node: dom.window.Node,
    IS_REACT_ACT_ENVIRONMENT: true,
    fetch: async (path: unknown, init: RequestInit) => {
      assert.equal(path, '/api/apps/setup-status');
      assert.equal(init.method, 'POST');
      const body = JSON.parse(String(init.body));
      assert.deepEqual(Object.keys(body), ['hashes', 'connectionIds']);
      assert.deepEqual(body.hashes, hashes);
      assert.deepEqual(body.connectionIds, [discoveryId]);
      requests.push(body.hashes);
      return Response.json(
        failing
          ? { error: 'Unavailable' }
          : {
              completed,
              apps: [
                { hash: hashes[0], slug: 'gmail', name: 'Gmail' },
                { hash: hashes[2], slug: 'notion_mcp', name: 'Notion' },
                { hash: '0'.repeat(64), slug: 'slack', name: 'Slack' },
              ],
            },
        { status: failing ? 503 : 200 },
      );
    },
  };
  const originals = new Map(
    Object.keys(globals).map((key) => [key, Object.getOwnPropertyDescriptor(globalThis, key)]),
  );
  for (const [key, value] of Object.entries(globals))
    Object.defineProperty(globalThis, key, { configurable: true, writable: true, value });
  const { createRoot } = await import('react-dom/client');
  const root = createRoot(dom.window.document.getElementById('root')!);
  const buttons = () => [...dom.window.document.querySelectorAll('button[data-setup="app"]')];
  const waitFor = async (ready: () => boolean) => {
    for (let attempt = 0; attempt < 50 && !ready(); attempt++)
      await act(async () => new Promise((resolve) => setTimeout(resolve, 10)));
    assert.ok(ready());
  };
  const render = (key: string) =>
    act(async () =>
      root.render(
        createElement(MessageText, {
          key,
          text: `[Connect work Gmail](${links[0]}) and [Connect personal Gmail](${links[1]}) and [Connect custom app](${links[2]})`,
          connectedAppIds: new Set(['gmail']),
        }),
      ),
    );
  try {
    await render('initial');
    await waitFor(() => requests.length === 1);
    await waitFor(() => Boolean(buttons()[0]?.querySelector('img')));
    assert.equal(buttons().length, 3);
    assert.equal(buttons()[0].querySelector('img')?.getAttribute('src'), '/logos/gmail.svg');
    assert.equal(buttons()[1].querySelector('img'), null);
    assert.equal(buttons()[2].querySelector('img')?.getAttribute('src'), '/logos/notion.svg');
    completed = [hashes[0]];
    await act(async () => dom.window.dispatchEvent(new dom.window.Event('focus')));
    await waitFor(() => buttons().length === 2);
    assert.ok(buttons()[0].textContent?.includes('personal'));
    failing = true;
    await act(async () => dom.window.dispatchEvent(new dom.window.Event('focus')));
    await waitFor(() => requests.length === 3);
    assert.equal(buttons().length, 2);
    failing = false;
    await render('reload');
    await waitFor(() => requests.length === 4 && buttons().length === 2);
    assert.ok(buttons()[0].textContent?.includes('personal'));
    completed = [hashes[0], hashes[2]];
    await act(async () => dom.window.dispatchEvent(new dom.window.Event('focus')));
    await waitFor(() => buttons().length === 1);
    assert.ok(buttons()[0].textContent?.includes('personal'));
    assert.doesNotMatch(dom.window.document.body.innerHTML, /synthetic-work|synthetic-personal/);
  } finally {
    await act(async () => root.unmount());
    dom.window.close();
    for (const [key, value] of originals)
      if (value) Object.defineProperty(globalThis, key, value);
      else Reflect.deleteProperty(globalThis, key);
  }
});

test('app groups separate catalog metadata from saved account state and keep available routing', () => {
  const account: Connection = {
    slug: 'gmail',
    name: 'Gmail',
    status: 'connected',
    connectionId: 'owned-gmail',
    accountId: 'provider-account',
    accountEmail: 'synthetic@example.test',
    description: 'Account authorization expired',
    reconnectRequired: true,
    triggersEnabled: true,
  };
  const catalog: Connection[] = [
    {
      slug: 'gmail',
      name: 'Gmail',
      status: 'disconnected',
      description: 'Mail integration',
      categories: ['Communication'],
      triggersEnabled: false,
    },
    {
      slug: 'gmail_mcp',
      name: 'Gmail MCP',
      status: 'disconnected',
      categories: ['Productivity'],
      triggersEnabled: false,
    },
  ];
  const [group] = connectionGroups([account], catalog);
  assert.equal(group.service.description, catalog[0].description);
  assert.deepEqual(group.service.categories, ['Communication', 'Productivity']);
  assert.equal(group.service.slug, account.slug);
  assert.equal(group.accounts[0], account);
  assert.ok(connectionIssue(group.accounts[0]));
  assert.equal(connectionGroups([account])[0].service.description, undefined);
  const [available] = connectionGroups(
    [{ ...catalog[0], status: 'not_configured' }],
    catalog.map((service) =>
      service.slug === 'gmail' ? { ...service, status: 'not_configured' } : service,
    ),
  );
  assert.equal(available.service.slug, 'gmail_mcp');
  assert.equal(available.service.status, 'disconnected');
  assert.deepEqual(available.accounts, []);
  assert.equal(
    connectionGroups([{ ...catalog[0], status: 'not_configured' }], catalog)[0].service.status,
    'disconnected',
  );
});

test('underlined messages preserve nested formatting without admitting unsafe markup', () => {
  const result = render(
    '<u onclick="alert(1)" style="color:red">**bold** [safe](https://example.com)</u> ' +
      '<u><a href="javascript:alert(1)">unsafe</a><script>alert(2)</script></u>',
  );
  const document = new JSDOM(result).window.document;
  assert.equal(document.querySelector('u strong')?.textContent, 'bold');
  assert.equal(document.querySelector('u a')?.getAttribute('href'), 'https://example.com/');
  assert.equal(document.querySelectorAll('a').length, 1);
  assert.doesNotMatch(result, /onclick|style=|javascript|script|alert/);
});

test('only intended app paths and credential-free HTTP URLs become links', () => {
  for (const value of [
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
  assert.deepEqual(safeMessageLink('https://example.com/docs?q=otto#usage', origin), {
    href: 'https://example.com/docs?q=otto#usage',
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

test('approval messages preserve source URLs and render supplied markup as text', () => {
  const links = [
    'https://workspace.slack.com/archives/C_TEST/p123456?thread_ts=123_456&cid=C_TEST#part_one',
    'https://example.test/path_(review)?values=one&next=two#note_1',
    'https://example.test/path_(review)',
    ...['!', '.', ',', ';', ':', '?', ')'].flatMap((suffix) => [
      `https://example.test/source${suffix}`,
      `https://example.test/source?key=value${suffix}`,
      `https://example.test/source#section${suffix}`,
    ]),
  ];
  const unsafe = [
    '<script>alert(1)</script>',
    '<img src="javascript:alert(1)" onerror="alert(1)">',
    '[approve](javascript:alert(1))',
    '[internal](/api/state)',
    'https://user:password@example.test/private',
    '**keep this literal**',
  ];
  const body = `See <${links[0]}>.\n${links.slice(1).join('\n')}\n${unsafe.join('\n')}`;
  const args = { prompt: body };
  const document = new JSDOM(render(actionConfirmation('OTTO_schedule_create', args))).window
    .document;
  assert.deepEqual(
    [...document.querySelectorAll('a')].map((anchor) => anchor.getAttribute('href')),
    links,
  );
  assert.ok(document.body.textContent?.includes(body));
  assert.equal(document.querySelector('script,img,iframe,form,strong,em'), null);
  assert.equal(args.prompt, body);
});

test('plain browser connection paths hide their token behind one fixed action', () => {
  const path = `/browser-connect/${'x'.repeat(43)}`;
  const text = `Continue at ${path}?token=hidden#fragment. Again ${path}.`;
  assert.deepEqual(messageSetupLinks(text, origin), [
    { href: path, setup: 'website', label: 'Connect website' },
  ]);
  const [body, actions] = render(text).split('<div class="setup-group">');
  assert.doesNotMatch(body, /xxxx|token=hidden|fragment/);
  assert.equal((body.match(/Connect website/g) ?? []).length, 2);
  assert.equal((actions.match(/data-setup="website"/g) ?? []).length, 1);
  for (const token of ['x'.repeat(42), 'x'.repeat(44)])
    assert.deepEqual(messageSetupLinks(`/browser-connect/${token}`, origin), []);
});

test('attachment previews and gallery sources accept only owned artifact URLs and inert types', () => {
  const picture: Artifact = {
    id: '00000000-0000-4000-8000-000000000000',
    name: 'Picture.png',
    mimeType: 'image/png',
    size: 2048,
    url: '/api/artifacts/00000000-0000-4000-8000-000000000000',
  };
  for (const mimeType of ['text/html', 'application/xhtml+xml', 'video/not-real'])
    assert.equal(artifactPreview({ ...picture, mimeType }), null);
  for (const mimeType of [
    'application/pdf',
    'audio/mp4',
    'video/webm',
    'image/svg+xml',
    'text/plain',
    'application/json',
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
  for (const name of ['notes.txt', 'report.md', 'data.csv', 'report.pdf', 'table.xlsx']) {
    const file = { ...picture, name, mimeType: 'application/octet-stream' };
    assert.ok(artifactPreview(file));
    assert.equal(artifactImage(file), null);
    assert.equal(artifactPreview({ ...file, url: 'https://example.com/file' }), null);
    assert.equal(artifactPreview({ ...file, mimeType: 'text/html' }), null);
  }
  assert.ok(artifactImage(picture));
  for (const url of [
    'https://example.com/image.png',
    'javascript:alert(1)',
    '/credentials/private',
    '/api/artifacts/abc?token=private',
  ])
    assert.equal(artifactImage({ ...picture, url }), null);
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
