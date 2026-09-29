import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import Fastify from 'fastify';
import serveStatic from '@fastify/static';

test('browser icons and the early theme script are real static assets rather than SPA HTML', async () => {
  const app = Fastify();
  await app.register(serveStatic, {
    root: fileURLToPath(new URL('../public', import.meta.url)),
    wildcard: false,
  });
  try {
    for (const [path, contentType] of [
      ['/favicon.svg', 'image/svg+xml'],
      ['/favicon.ico', 'image/vnd.microsoft.icon'],
      ['/apple-touch-icon.png', 'image/png'],
      ['/theme-init.js', 'application/javascript'],
    ]) {
      const response = await app.inject(path!);
      assert.equal(response.statusCode, 200, path);
      assert.ok(
        response.headers['content-type']?.includes(contentType!),
        `${path}: ${response.headers['content-type']}`,
      );
      assert.doesNotMatch(response.body, /<!doctype html>/i);
      assert.ok(response.rawPayload.length > 100, path);
    }
    const ico = await app.inject('/favicon.ico');
    assert.equal(ico.rawPayload.readUInt16LE(0), 0);
    assert.equal(ico.rawPayload.readUInt16LE(2), 1);
    assert.equal(ico.rawPayload.readUInt16LE(4), 3);
    const html = await readFile(new URL('../index.html', import.meta.url), 'utf8');
    assert.match(html, /rel="icon"[^>]+href="\/favicon\.svg"/);
    assert.match(html, /rel="apple-touch-icon"[^>]+href="\/apple-touch-icon\.png"/);
    assert.ok(html.indexOf('/theme-init.js') < html.indexOf('</head>'));
    assert.ok(html.indexOf('/theme-init.js') < html.indexOf('/src/web/main.tsx'));
    const brand = await readFile(
      new URL('../src/web/components/brand.tsx', import.meta.url),
      'utf8',
    );
    const splash = html.slice(
      html.indexOf('<div id="root">'),
      html.indexOf('<script type="module"'),
    );
    assert.match(splash, /class="app-shell startup-shell"/);
    const circles = [...brand.matchAll(/<circle [^>]+\/>/g)].map(([circle]) =>
      circle.replace('strokeWidth', 'stroke-width'),
    );
    assert.equal(circles.length, 2);
    for (const circle of circles) assert.ok(splash.includes(circle), circle);
    assert.match(splash, /Opening Otto/);
    assert.doesNotMatch(splash.replace(/<[^>]+>/g, ' '), /workspace|connecting/i);
    const { navigationItems } = await import('../src/web/lib/navigation.ts');
    for (const item of navigationItems) assert.ok(splash.includes(`>${item.label}<`), item.label);
  } finally {
    await app.close();
  }
});
