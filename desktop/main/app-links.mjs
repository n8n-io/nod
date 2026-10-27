export function appOpenPath(value, pages) {
  if (typeof value !== 'string') return null;
  const path = value.slice('nod://open'.length);
  return value === `nod://open${path}` &&
    (Object.hasOwn(pages, path) ||
      /^\/prepared\/[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i.test(path))
    ? path
    : null;
}
