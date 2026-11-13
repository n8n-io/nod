import appPages from './app-pages.json' with { type: 'json' };

export { appPages };

const uuid = '[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}';
const preparedPath = new RegExp(`^/prepared/(${uuid})$`, 'i');
const taskPagePath = new RegExp(`^/tasks/(${uuid})$`, 'i');

export function preparedWorkId(path: string) {
  return preparedPath.exec(path)?.[1] ?? null;
}

export function taskPageId(path: string) {
  return taskPagePath.exec(path)?.[1]?.toLowerCase() ?? null;
}

export function taskPath(id: string) {
  return `/tasks/${id}` as const;
}

export function appPagePath(path: string) {
  if (path === '/trust') return '/usage';
  if (path === '/memory') return '/settings/memory';
  if (preparedWorkId(path)) return path as `/prepared/${string}`;
  const task = taskPageId(path);
  if (task) return taskPath(task);
  return Object.hasOwn(appPages, path) ? (path as keyof typeof appPages) : null;
}

export function appPageLabel(path: NonNullable<ReturnType<typeof appPagePath>>) {
  if (preparedWorkId(path)) return 'Prepared work';
  if (taskPageId(path)) return 'Task';
  return appPages[path as keyof typeof appPages];
}

export const appPageLinks = Object.entries(appPages)
  .map(([path, label]) => `[${label}](${path})`)
  .join(', ');

export function appPageUrl(path: NonNullable<ReturnType<typeof appPagePath>>) {
  return `https://nod.n8n.io/docs/open/#${path}`;
}
