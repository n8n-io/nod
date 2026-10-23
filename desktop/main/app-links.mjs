export function appOpenPath(value, pages) {
  if (typeof value !== 'string') return null;
  const path = value.slice('nod://open'.length);
  return value === `nod://open${path}` && Object.hasOwn(pages, path) ? path : null;
}
