import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { getEventListeners, once } from 'node:events';
import test from 'node:test';
import Fastify from 'fastify';
import {
  createPublicLinkPreviewProvider,
  parseLinkMetadata,
  requestPublicPreview,
} from '../src/providers/public-web/link-preview.ts';
import { createLinkPreviews } from '../src/server/link-previews.ts';
import { registerLocalAccess } from '../src/server/access.ts';
import { previewableUrl } from '../src/shared/link-preview.ts';

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

test('metadata parses OG and fallback tags as bounded plain text without following metadata URLs', () => {
  const result = parseLinkMetadata(
    `<html><head><title>Fallback title</title><meta property="og:title" content="A &amp; B &lt;script&gt;"><meta property="og:description" content="${'word '.repeat(120)}"><meta property="og:site_name" content="Example"><meta property="og:url" content="http://127.0.0.1/private"><base href="http://127.0.0.1"><meta property="og:image" content="/cover.png"><script>throw new Error('Do not execute')</script></head><body><meta property="og:title" content="Wrong body title"></body></html>`,
    'https://example.com/article',
  );
  assert.equal(result!.title, 'A & B <script>');
  assert.equal(result!.url, 'https://example.com/article');
  assert.equal(result!.description!.length, 400);
  assert.equal(result!.siteName, 'Example');
  assert.equal(result!.image, 'https://example.com/cover.png');
  assert.equal(
    parseLinkMetadata(
      '<title>Fallback &amp; title</title><meta name="description" content="Summary">',
      'https://example.com',
    )!.description,
    'Summary',
  );
  assert.equal(
    parseLinkMetadata(
      '<title>Safe</title><meta property="og:image" content="https://example.com/image?token=private">',
      'https://example.com',
    )!.image,
    undefined,
  );
  assert.equal(
    parseLinkMetadata('<script>document.title="Dynamic"</script>', 'https://example.com'),
    null,
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

test('preview endpoints cache metadata and opaque images while preserving local access and expiry', async () => {
  let now = 0,
    metadataCalls = 0,
    imageCalls = 0;
  const service = createLinkPreviews(
    {
      async metadata(url) {
        metadataCalls++;
        return { url, title: 'Fixture title', image: 'https://example.com/cover.png' };
      },
      async image() {
        imageCalls++;
        return { bytes: png, mimeType: 'image/png' };
      },
    },
    { now: () => now },
  );
  const app = Fastify();
  registerLocalAccess(app, 4310);
  service.registerRoutes(app);
  const headers = { host: 'localhost:4310', origin: 'http://localhost:4310' };
  try {
    const post = () =>
      app.inject({
        method: 'POST',
        url: '/api/link-preview',
        headers,
        payload: { url: 'https://example.com/article' },
      });
    const first = await post();
    const preview = first.json().preview;
    assert.equal(metadataCalls, 1);
    assert.match(preview.imageUrl, /^\/api\/link-preview\/image\/[a-f\d-]{36}$/);
    assert.doesNotMatch(first.body, /cover.png/);
    assert.equal((await post()).json().preview.imageUrl, preview.imageUrl);
    assert.equal(metadataCalls, 1);
    const image = await app.inject({ url: preview.imageUrl, headers });
    assert.equal(image.statusCode, 200);
    assert.equal(image.headers['content-type'], 'image/png');
    assert.equal(image.headers['x-content-type-options'], 'nosniff');
    assert.deepEqual(image.rawPayload, png);
    await app.inject({ url: preview.imageUrl, headers });
    assert.equal(imageCalls, 1);
    assert.equal(
      (
        await app.inject({
          url: preview.imageUrl,
          headers: { ...headers, origin: 'https://foreign.example' },
        })
      ).statusCode,
      403,
    );
    assert.equal(
      (await app.inject({ url: '/api/link-preview/image/not-a-cache-id', headers })).statusCode,
      404,
    );
    const blocked = await app.inject({
      method: 'POST',
      url: '/api/link-preview',
      headers,
      payload: { url: 'http://localhost:4310/vault/private' },
    });
    assert.deepEqual(blocked.json(), { preview: null });
    assert.equal(metadataCalls, 1);
    now = 600001;
    assert.equal((await app.inject({ url: preview.imageUrl, headers })).statusCode, 404);
  } finally {
    await app.close();
  }
});

test('preview bursts deduplicate identical URLs and cap active external fetches', async () => {
  const releases: Array<() => void> = [];
  let active = 0,
    maximum = 0,
    started = 0;
  const service = createLinkPreviews({
    async metadata(url) {
      active++;
      started++;
      maximum = Math.max(active, maximum);
      await new Promise<void>((resolve) => releases.push(resolve));
      active--;
      return { url, title: 'Fixture' };
    },
    async image() {
      return null;
    },
  });
  const work = Array.from({ length: 12 }, (_, index) =>
    service.preview(`https://example.com/page/${index}`),
  );
  work.push(service.preview('https://example.com/page/0'));
  assert.equal(started, 4);
  while (started < 12 || active) {
    for (const release of releases.splice(0)) release();
    await new Promise<void>((resolve) => setImmediate(resolve));
  }
  const results = await Promise.all(work);
  assert.equal(started, 12);
  assert.equal(maximum, 4);
  assert.ok(results.every(Boolean));
  assert.equal(results[0], results.at(-1));
});

test('a stalled DNS lookup reaches the overall preview deadline without an HTTP request', async () => {
  const keepAlive = setTimeout(() => {}, 1000);
  try {
    let requested = false;
    const provider = createPublicLinkPreviewProvider({
      timeoutMs: 15,
      resolver: () => new Promise(() => {}),
      request: async () => {
        requested = true;
        return html();
      },
    });
    assert.equal(await provider.metadata('https://example.com'), null);
    assert.equal(requested, false);
  } finally {
    clearTimeout(keepAlive);
  }
});

test('an expired icon request does not start fallback DNS or retain completed lookup listeners', async () => {
  let lookups = 0;
  let requests = 0;
  let lookupListeners = -1;
  const provider = createPublicLinkPreviewProvider({
    timeoutMs: 15,
    resolver: async () => {
      lookups++;
      return lookups === 1 ? addresses() : new Promise(() => {});
    },
    request: async ({ signal }) => {
      requests++;
      lookupListeners = getEventListeners(signal, 'abort').length;
      return new Promise((_, reject) => {
        signal.addEventListener('abort', () => reject(signal.reason), { once: true });
      });
    },
  });
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const result = await Promise.race([
      provider.icon!('https://example.com'),
      new Promise<string>((resolve) => {
        timer = setTimeout(() => resolve('deadline exceeded'), 500);
      }),
    ]);
    assert.equal(result, null);
    assert.equal(lookups, 1);
    assert.equal(requests, 1);
    assert.equal(lookupListeners, 0);
  } finally {
    clearTimeout(timer);
  }
});

test('image capacity eviction refreshes its paired preview instead of returning a broken cached image', async () => {
  let calls = 0;
  const previews = createLinkPreviews({
    metadata: async (url) => {
      calls++;
      return { url, title: 'Fixture', image: 'https://example.com/cover.png' };
    },
    image: async () => ({ mimeType: 'image/png', bytes: png }),
  });
  const first = await previews.preview('https://example.com/article-0');
  for (let i = 1; i < 33; i++) await previews.preview(`https://example.com/article-${i}`);
  const refreshed = await previews.preview('https://example.com/article-0');
  assert.notEqual(refreshed?.imageUrl, first?.imageUrl);
  assert.equal(calls, 34);
  assert.ok(await previews.image(refreshed!.imageUrl!.split('/').at(-1)!));
});

test('image previews reject PNG animation chunks and truncated chunk lengths', async () => {
  for (const kind of ['acTL', 'fcTL', 'fdAT']) {
    const chunk = Buffer.alloc(20);
    chunk.writeUInt32BE(8, 0);
    chunk.write(kind, 4, 'ascii');
    const body = Buffer.concat([png.subarray(0, 33), chunk, png.subarray(33)]);
    const provider = createPublicLinkPreviewProvider({
      resolver: addresses,
      request: async () => ({ status: 200, headers: { 'content-type': 'image/png' }, body }),
    });
    assert.equal(await provider.image('https://example.com/image'), null, kind);
  }
  for (const body of [
    png.subarray(0, 24),
    png.subarray(0, png.length - 1),
    Buffer.concat([png, Buffer.from('trailing')]),
  ]) {
    const provider = createPublicLinkPreviewProvider({
      resolver: addresses,
      request: async () => ({ status: 200, headers: { 'content-type': 'image/png' }, body }),
    });
    assert.equal(await provider.image('https://example.com/image'), null);
  }
});

test('saved website icons use the pinned public fetcher and accept only ICO or raster bytes', async () => {
  const entry = Buffer.alloc(16);
  entry.set([16, 16, 0, 0, 1, 0, 32, 0]);
  entry.writeUInt32LE(png.length, 8);
  entry.writeUInt32LE(22, 12);
  const ico = Buffer.concat([Buffer.from([0, 0, 1, 0, 1, 0]), entry, png]);
  const emptyIco = Buffer.concat([Buffer.from([0, 0, 1, 0, 1, 0]), Buffer.alloc(16), png]);
  const svg = Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"></svg>');
  const fetchWith = (routes: Record<string, { status: number; type?: string; body: Buffer }>) => {
    const calls: string[] = [];
    const provider = createPublicLinkPreviewProvider({
      resolver: addresses,
      request: async ({ url, address, purpose }) => {
        assert.equal(address, '93.184.216.34');
        assert.equal(purpose, url.pathname === '/' ? undefined : 'icon');
        calls.push(url.href);
        const route = routes[url.href] ?? { status: 404, body: Buffer.alloc(0) };
        return {
          status: route.status,
          headers: { 'content-type': route.type },
          body: route.body,
        };
      },
    });
    return { provider, calls };
  };

  const empty = fetchWith({
    'https://example.com/favicon.ico': { status: 200, type: 'image/x-icon', body: emptyIco },
  });
  assert.equal(await empty.provider.icon!('https://example.com'), null);

  const direct = fetchWith({
    'https://login.example.com/favicon.ico': { status: 200, type: 'text/plain', body: ico },
  });
  const icon = await direct.provider.icon!('https://login.example.com');
  assert.equal(icon?.mimeType, 'image/x-icon');
  assert.deepEqual(direct.calls, ['https://login.example.com/favicon.ico']);

  const linked = fetchWith({
    'https://example.com/': {
      status: 200,
      type: 'text/html',
      body: Buffer.from(
        '<html><head><link rel="icon" type="image/svg+xml" href="/icon.svg"><link rel="shortcut icon" href="/static/icon.png"></head></html>',
      ),
    },
    'https://example.com/static/icon.png': { status: 200, type: 'image/png', body: png },
  });
  assert.equal((await linked.provider.icon!('https://example.com'))?.mimeType, 'image/png');
  assert.deepEqual(linked.calls, [
    'https://example.com/favicon.ico',
    'https://example.com/',
    'https://example.com/static/icon.png',
  ]);

  const alternatives = fetchWith({
    'https://example.com/': {
      status: 200,
      type: 'text/html',
      body: Buffer.from(
        '<html><head><link rel="icon" href="/invalid.png"><link rel="icon" href="/missing.png"><link rel="apple-touch-icon-precomposed" href="/valid.png"></head></html>',
      ),
    },
    'https://example.com/invalid.png': {
      status: 200,
      type: 'image/png',
      body: Buffer.from('invalid image'),
    },
    'https://example.com/valid.png': { status: 200, type: 'image/png', body: png },
  });
  assert.equal((await alternatives.provider.icon!('https://example.com'))?.mimeType, 'image/png');
  assert.deepEqual(alternatives.calls, [
    'https://example.com/favicon.ico',
    'https://example.com/',
    'https://example.com/invalid.png',
    'https://example.com/missing.png',
    'https://example.com/valid.png',
  ]);

  const vector = fetchWith({
    'https://example.com/favicon.ico': { status: 200, type: 'image/x-icon', body: svg },
    'https://example.com/': {
      status: 200,
      type: 'text/html',
      body: Buffer.from('<html><head><link rel="icon" href="/icon.svg"></head></html>'),
    },
  });
  assert.equal(await vector.provider.icon!('https://example.com'), null);
  assert.deepEqual(vector.calls, ['https://example.com/favicon.ico', 'https://example.com/']);

  const large = fetchWith({
    'https://example.com/favicon.ico': {
      status: 200,
      type: 'image/x-icon',
      body: Buffer.alloc(128 * 1024 + 1),
    },
  });
  assert.equal(await large.provider.icon!('https://example.com'), null);

  let requested = false;
  const privateSite = createPublicLinkPreviewProvider({
    resolver: async () => [{ address: '10.0.0.2', family: 4 }],
    request: async () => {
      requested = true;
      return { status: 200, headers: {}, body: ico };
    },
  });
  assert.equal(await privateSite.icon!('https://intranet.example.com'), null);
  assert.equal(await privateSite.icon!('http://localhost:3000'), null);
  assert.equal(requested, false);
});

test('saved website icons try at most eight unique eligible fallback links', async () => {
  for (const validCandidate of [8, 9]) {
    const resolved: string[] = [];
    const requested: string[] = [];
    const links = Array.from({ length: 20 }, (_, index) =>
      `<link rel="icon" href="/icon-${index + 1}.png">`.repeat(2),
    ).join('');
    const provider = createPublicLinkPreviewProvider({
      resolver: async (host) => {
        resolved.push(host);
        return addresses();
      },
      request: async ({ url, address }) => {
        assert.equal(address, '93.184.216.34');
        requested.push(url.pathname);
        if (url.pathname === '/') return html(`<link rel="icon" href="/icon.svg">${links}`);
        if (url.pathname === `/icon-${validCandidate}.png`)
          return { status: 200, headers: { 'content-type': 'image/png' }, body: png };
        return { status: 404, headers: {}, body: Buffer.alloc(0) };
      },
    });

    const icon = await provider.icon!('https://example.com');
    assert.equal(icon?.mimeType ?? null, validCandidate === 8 ? 'image/png' : null);
    assert.deepEqual(requested, [
      '/favicon.ico',
      '/',
      ...Array.from({ length: 8 }, (_, index) => `/icon-${index + 1}.png`),
    ]);
    assert.deepEqual(
      resolved,
      Array.from({ length: 10 }, () => 'example.com'),
    );
  }
});
