import appPages from './app-pages.json' with { type: 'json' };

export { appPages };

export function appPagePath(path: string) {
  if (path === '/trust') return '/usage';
  if (path === '/memory') return '/settings/memory';
  return Object.hasOwn(appPages, path) ? (path as keyof typeof appPages) : null;
}

export const appPageLinks = Object.entries(appPages)
  .map(([path, label]) => `[${label}](${path})`)
  .join(', ');

export function appPageUrl(path: keyof typeof appPages) {
  return `https://nod-docs.pages.dev/open/#${path}`;
}
