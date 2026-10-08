import { randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import { chmod, link, lstat, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { FastifyInstance, FastifyRequest } from 'fastify';

const token = /^[A-Za-z0-9_-]{43}$/;

export async function accessKey(dataRoot: string) {
  const path = join(dataRoot, 'access-key');
  if (!token.test(await readFile(path, 'utf8').catch(() => ''))) {
    await mkdir(dataRoot, { recursive: true, mode: 0o700 });
    const draft = `${path}.${randomUUID()}`;
    await writeFile(draft, randomBytes(32).toString('base64url'), { flag: 'wx', mode: 0o600 });
    await link(draft, path)
      .catch((error: NodeJS.ErrnoException) => {
        if (error.code !== 'EEXIST') throw error;
      })
      .finally(() => rm(draft, { force: true }));
  }
  const info = await lstat(path);
  const key = info.isFile() ? await readFile(path, 'utf8') : '';
  if (!token.test(key)) throw new Error(`Delete ${path} and restart Otto.`);
  if (info.mode & 0o077) await chmod(path, 0o600);
  return key;
}

export const accessCookie = (port: number) => `otto-access-${port}`;

export function registerLocalAccess(
  app: FastifyInstance,
  port: number,
  access: { key: string; desktop?: boolean },
) {
  const desktop = access.desktop === true;
  const hosts = new Set(
    desktop ? [`127.0.0.1:${port}`] : [`localhost:${port}`, `127.0.0.1:${port}`, `[::1]:${port}`],
  );
  const expected = Buffer.from(access.key);
  const cookie = accessCookie(port);
  const matches = (value: unknown) => {
    const actual = typeof value === 'string' ? Buffer.from(value) : undefined;
    return !!actual && actual.length === expected.length && timingSafeEqual(actual, expected);
  };
  const presented = (request: FastifyRequest) =>
    desktop
      ? request.headers['x-otto-desktop-token']
      : request.headers.cookie
          ?.split(';')
          .map((part) => part.trim())
          .find((part) => part.startsWith(`${cookie}=`))
          ?.slice(cookie.length + 1);
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
      state.length === 1 &&
      token.test(state[0]);
    const open =
      appCallback ||
      (!desktop &&
        ((request.method === 'POST' && path === '/api/access') ||
          (request.method === 'GET' && path === '/api/privacy')));
    if (
      !open &&
      (path === '/api' ||
        path.startsWith('/api/') ||
        request.routeOptions.url?.startsWith('/api/')) &&
      !matches(presented(request))
    )
      return reply.code(401).send({
        error: desktop
          ? 'Open Otto in the desktop app.'
          : 'Open Otto from the link in your terminal.',
      });
    if (request.headers['sec-fetch-site'] === 'cross-site' && !appCallback && !pageNavigation)
      return reply.code(403).send({ error: 'Cross-site requests are not permitted.' });
  });
  if (!desktop)
    app.post('/api/access', async (request, reply) => {
      if (!matches((request.body as { key?: unknown } | undefined)?.key))
        return reply.code(401).send({ error: 'This link is no longer valid.' });
      return reply
        .header(
          'Set-Cookie',
          `${cookie}=${access.key}; Path=/; HttpOnly; SameSite=Strict; Max-Age=34560000`,
        )
        .code(204)
        .send();
    });
}
