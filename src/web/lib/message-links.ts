type LinkKind = 'artifact' | 'credential' | 'external' | 'navigation';
interface SafeLink {
  href: string;
  kind: LinkKind;
}
export type MessagePart =
  { type: 'text'; text: string } | ({ type: 'link'; text: string } & SafeLink);

const navigationPaths = new Set(['/', '/apps', '/goals', '/schedule', '/channels', '/vault']);
const connectionPath =
  /^\/apps\?connect=[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i;
const localPath = /^\/(api\/artifacts|vault|credentials)\/[A-Za-z0-9_-]+\/?$/;
const credentialLabels = [
  'Vault',
  'Open Vault',
  'Sign in',
  'Add login',
  'Enter login details',
  'Continue sign-in',
  'Enter verification code',
  'Choose a sign-in method',
];

export function credentialLinkLabel(value: string): string {
  const label = value.trim().toLowerCase();
  return credentialLabels.find((candidate) => candidate.toLowerCase() === label) ?? 'Vault';
}

export function safeMessageLink(value: string, origin: string): SafeLink | null {
  if (!value || /[\u0000-\u0020\u007f<>"'\\]/.test(value)) return null;
  const absolute = /^https?:\/\//i.test(value);
  if (
    !absolute &&
    !localPath.test(value.split(/[?#]/, 1)[0]) &&
    !navigationPaths.has(value) &&
    !connectionPath.test(value)
  )
    return null;
  try {
    const base = new URL(origin);
    const url = new URL(value, base);
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) return null;
    if (!absolute || url.origin === base.origin) {
      if (
        url.origin === base.origin &&
        !url.hash &&
        connectionPath.test(`${url.pathname}${url.search}`)
      )
        return { href: `${url.pathname}${url.search}`, kind: 'navigation' };
      const path = absolute
        ? value.replace(/^https?:\/\/[^/]+/i, '').split(/[?#]/, 1)[0]
        : value.split(/[?#]/, 1)[0];
      if (
        url.origin === base.origin &&
        navigationPaths.has(path) &&
        navigationPaths.has(url.pathname)
      )
        return { href: url.pathname, kind: 'navigation' };
      if (url.origin !== base.origin || !localPath.test(path) || !localPath.test(url.pathname))
        return null;
      return {
        href: url.pathname,
        kind:
          url.pathname.startsWith('/credentials/') || url.pathname.startsWith('/vault/')
            ? 'credential'
            : 'artifact',
      };
    }
    return { href: url.href, kind: 'external' };
  } catch {
    return null;
  }
}

export function parseMessageText(text: string, origin: string): MessagePart[] {
  const parts: MessagePart[] = [];
  const pattern =
    /\[([^\]\n]+)\]\(([^()\s]+)\)|(?<![\w:/])(?:https?:\/\/|\/(?:api\/artifacts|vault|credentials)\/)[^\s<>"'\[\]()]+/gi;
  let cursor = 0;
  for (const match of text.matchAll(pattern)) {
    if (match.index > cursor) parts.push({ type: 'text', text: text.slice(cursor, match.index) });
    const markdown = match[1] !== undefined;
    const destination = markdown ? match[2] : match[0].replace(/[.,;:!?]+$/, '');
    const link = safeMessageLink(destination, origin);
    if (!link) parts.push({ type: 'text', text: match[0] });
    else {
      const label =
        link.kind === 'credential'
          ? credentialLinkLabel(markdown ? match[1] : '')
          : markdown
            ? match[1]
            : link.kind === 'artifact'
              ? 'Open file'
              : destination;
      parts.push({ type: 'link', text: label, ...link });
      if (!markdown && destination.length < match[0].length)
        parts.push({ type: 'text', text: match[0].slice(destination.length) });
    }
    cursor = match.index + match[0].length;
  }
  if (cursor < text.length) parts.push({ type: 'text', text: text.slice(cursor) });
  return parts;
}
