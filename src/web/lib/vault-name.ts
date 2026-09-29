export function suggestLoginName(origin: string, existingNames: readonly string[] = []) {
  let base = 'Website login';
  try {
    const url = new URL(origin);
    if (['http:', 'https:'].includes(url.protocol) && !url.username && !url.password) {
      const host = url.host.replace(/^www\./, '');
      base = (host.charAt(0).toUpperCase() + host.slice(1)).slice(0, 100);
    }
  } catch {}
  const names = new Set(existingNames.map((name) => name.trim().toLowerCase()));
  if (!names.has(base.toLowerCase())) return base;
  for (let index = 2; index <= names.size + 2; index++) {
    const suffix = ` ${index}`;
    const candidate = `${base.slice(0, 100 - suffix.length)}${suffix}`;
    if (!names.has(candidate.toLowerCase())) return candidate;
  }
  return base;
}

export function originLabel(origin: string) {
  try {
    return new URL(origin).host;
  } catch {
    return 'Website';
  }
}
