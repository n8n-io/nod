function plain(value: string) {
  return value
    .replace(/[[\]()<>`*_~#|\\]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

export function vaultInvitation(
  origin: string,
  url: string | undefined,
  message: string,
  action: string,
) {
  const site = new URL(origin);
  if (!['https:', 'http:'].includes(site.protocol) || site.username || site.password)
    throw new Error('The sign-in site is unavailable.');
  if (!url || !/^\/(?:vault|credentials)\/[A-Za-z0-9_-]{1,256}$/.test(url))
    throw new Error('The Vault link is unavailable.');
  const text = plain(message);
  const label = plain(action);
  if (!text || !label) throw new Error('Describe the secure step and its button.');
  return `${text} [${label}](${url})`;
}
