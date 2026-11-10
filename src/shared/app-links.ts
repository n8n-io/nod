import appPages from './app-pages.json' with { type: 'json' };

export { appPages };

export function preparedWorkId(path: string) {
  return (
    /^\/prepared\/([a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12})$/i.exec(
      path,
    )?.[1] ?? null
  );
}

export function appPagePath(path: string) {
  if (path === '/trust') return '/usage';
  if (path === '/memory') return '/settings/memory';
  if (preparedWorkId(path)) return path as `/prepared/${string}`;
  return Object.hasOwn(appPages, path) ? (path as keyof typeof appPages) : null;
}

export const appPageLinks = Object.entries(appPages)
  .map(([path, label]) => `[${label}](${path})`)
  .join(', ');

export function appPageUrl(path: NonNullable<ReturnType<typeof appPagePath>>) {
  return `https://nod.n8n.io/docs/open/#${path}`;
}
