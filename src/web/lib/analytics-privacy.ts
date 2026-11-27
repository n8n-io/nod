import { preparedWorkId } from '../../shared/app-links.ts';

export const analyticsHost = 'app.example';

const routes = new Set([
  '/',
  '/onboarding',
  '/apps',
  '/channels',
  '/tasks',
  '/prepared',
  '/usage',
  '/vault',
  '/settings',
  '/browser',
  '/payments',
]);

export function analyticsRoute(value: string) {
  try {
    const path = new URL(value, `https://${analyticsHost}`).pathname.replace(/\/$/, '') || '/';
    if (/^\/payments\/[^/]+$/.test(path)) return '/payments';
    if (preparedWorkId(path)) return '/prepared';
    if (/^\/bot\/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(path))
      return '/';
    if (
      [
        '/settings/models',
        '/settings/memory',
        '/settings/computer-use',
        '/settings/notifications',
        '/settings/voice',
        '/settings/privacy',
      ].includes(path)
    )
      return '/settings';
    return routes.has(path) ? path : '/not-found';
  } catch {
    return '/not-found';
  }
}

export function sanitizedAnalyticsUrl(value: string) {
  return `https://${analyticsHost}${analyticsRoute(value)}`;
}
