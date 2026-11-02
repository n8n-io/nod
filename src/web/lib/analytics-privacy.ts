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
  '/credentials',
  '/payments',
]);

export function analyticsRoute(value: string) {
  try {
    const path = new URL(value, `https://${analyticsHost}`).pathname.replace(/\/$/, '') || '/';
    if (/^\/(?:vault|credentials)\/[^/]+$/.test(path)) return '/credentials';
    if (/^\/payments\/[^/]+$/.test(path)) return '/payments';
    if (preparedWorkId(path)) return '/prepared';
    if (
      [
        '/settings/models',
        '/settings/memory',
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
