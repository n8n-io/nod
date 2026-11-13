function plain(value: string) {
  return value
    .replace(/[[\]()<>`*_~#|\\]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

export function actionLink(url: unknown, message: unknown) {
  if (typeof url !== 'string' || typeof message !== 'string' || !plain(message))
    throw new Error('The action invitation is unavailable.');
  const destination = new URL(url, 'https://nod.invalid');
  if (
    !['http:', 'https:'].includes(destination.protocol) ||
    destination.username ||
    destination.password ||
    /[\s<>\\]/.test(url) ||
    url.startsWith('//')
  )
    throw new Error('The action link is unavailable.');
  return `[${plain(message)}](<${url}>)`;
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

export function paymentExplanation(message: string) {
  const text = message.trim();
  if (!text) throw new Error('Describe the payment step.');
  const linkLike =
    /(?:[a-z][a-z\d+.-]*:\/\/|www\.|[\p{L}\p{N}._%+-]+@[\p{L}\p{N}.-]+\.[\p{L}]{2,}|\/(?:api\/artifacts|vault|credentials|payments)\/)/iu;
  const inert = (value: string) =>
    (value.match(/\s+|\S+/gu) ?? [])
      .map((part) => {
        if (/^\s+$/u.test(part)) return part;
        if (linkLike.test(part.replaceAll('\\', ''))) {
          const fence = '`'.repeat(
            Math.max(0, ...(part.match(/`+/g) ?? []).map((run) => run.length)) + 1,
          );
          return `${fence} ${part} ${fence}`;
        }
        return part.replace(/[\\`*_{}\[\]()#+\-.!|>~<&=]/g, '\\$&');
      })
      .join('');
  return text
    .split('\n')
    .map((line) => {
      const marker = /^([ \t]{0,3}(?:[-*+]|\d{1,9}[.)])[ \t]+)(?=\S)/.exec(line)?.[0];
      return marker ? `${marker}${inert(line.slice(marker.length))}` : inert(line);
    })
    .join('\n');
}

export function paymentInvitation(url: string | undefined, message: string, action: string) {
  if (
    !url ||
    !/^\/payments\/[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i.test(url)
  )
    throw new Error('The payment link is unavailable.');
  return `${paymentExplanation(message)}\n\n${actionLink(url, action)}`;
}
