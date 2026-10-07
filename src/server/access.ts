import { timingSafeEqual } from 'node:crypto';
import type { FastifyInstance } from 'fastify';

export function registerLocalAccess(
  app: FastifyInstance,
  port: number,
  desktop?: { token: string },
) {
  const hosts = new Set(
    desktop ? [`127.0.0.1:${port}`] : [`localhost:${port}`, `127.0.0.1:${port}`, `[::1]:${port}`],
  );
  const desktopToken = desktop && Buffer.from(desktop.token);
  const pages = new Set([
    '/',
    '/tasks',
    '/memory',
    '/apps',
    '/onboarding',
    '/connected.html',
    '/channels',
    '/vault',
    '/you',
    '/dev',
    '/browser',
    '/privacy',
    '/privacy/',
  ]);
  app.addHook('onRequest', async (request, reply) => {
    reply
      .header('X-Content-Type-Options', 'nosniff')
      .header('Referrer-Policy', 'no-referrer')
      .header('Cache-Control', 'no-store')
      .header('Content-Security-Policy', "frame-ancestors 'none'");
    const path = request.url.split('?')[0];
    if (
      !desktop &&
      request.method === 'POST' &&
      ['/api/webhooks/composio', '/api/webhooks/telegram', '/api/webhooks/whatsapp'].includes(path)
    )
      return;
    if (!desktop && request.method === 'GET' && path === '/api/webhooks/whatsapp') return;
    if (!hosts.has(request.headers.host || ''))
      return reply.code(403).send({ error: 'Otto is only available on localhost.' });
    if (request.headers.origin) {
      let origin: URL;
      try {
        origin = new URL(request.headers.origin);
      } catch {
        return reply.code(403).send({ error: 'Invalid origin.' });
      }
      if (
        origin.protocol !== 'http:' ||
        !hosts.has(origin.host) ||
        (desktop && request.headers.origin !== `http://127.0.0.1:${port}`)
      )
        return reply.code(403).send({ error: 'This origin is not permitted.' });
    }
    const pageNavigation =
      request.method === 'GET' &&
      (pages.has(path) ||
        /^\/(vault|credentials|browser-connect)\/[A-Za-z0-9_-]+\/?$/.test(path)) &&
      request.headers['sec-fetch-mode'] === 'navigate' &&
      request.headers['sec-fetch-dest'] === 'document';
    const state = new URLSearchParams(request.url.split('?')[1]).getAll('state');
    const appCallback =
      request.method === 'GET' &&
      ['/api/apps/callback', '/api/models/oauth/callback'].includes(path) &&
      (!desktop || (state.length === 1 && /^[A-Za-z0-9_-]{43}$/.test(state[0])));
    if (
      desktopToken &&
      !appCallback &&
      (path === '/api' || path.startsWith('/api/') || request.routeOptions.url?.startsWith('/api/'))
    ) {
      const token = request.headers['x-otto-desktop-token'];
      const actual = typeof token === 'string' ? Buffer.from(token) : undefined;
      if (
        !actual ||
        actual.length !== desktopToken.length ||
        !timingSafeEqual(actual, desktopToken)
      )
        return reply.code(401).send({ error: 'Open Otto in the desktop app.' });
    }
    if (request.headers['sec-fetch-site'] === 'cross-site' && !appCallback && !pageNavigation)
      return reply.code(403).send({ error: 'Cross-site requests are not permitted.' });
  });
}
