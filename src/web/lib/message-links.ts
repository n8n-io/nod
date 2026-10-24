import type { Root, RootContent } from 'hast';
import { unified } from 'unified';
import remarkParse from 'remark-parse';
import remarkGfm from 'remark-gfm';
import remarkRehype from 'remark-rehype';
import rehypeRaw from 'rehype-raw';
import rehypeSanitize from 'rehype-sanitize';
import { SKIP, visit } from 'unist-util-visit';
import { rehypeLocalLinks, remarkLinkDestinations } from './markdown';
import { isConnectionBridge } from './connection-url';
import { appPagePath } from '../../shared/app-links';

export type SetupKind = 'vault' | 'website' | 'app';
type SafeLink =
  | { href: string; kind: 'artifact' | 'external' | 'navigation' }
  | { href: string; kind: 'setup'; setup: SetupKind };

const renamedPaths = new Map([
  ['/trust', '/usage'],
  ['/trust?add=login', '/vault?add=login'],
  ['/trust?add=card', '/vault?add=card'],
]);
const connectionPath =
  /^\/apps\?connect=[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i;
const e2eConsentPath =
  /^\/e2e\/connect\/[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i;
const localPath =
  /^\/(?:api\/artifacts|vault|credentials|payments)\/[A-Za-z0-9_-]+\/?$|^\/browser-connect\/[A-Za-z0-9_-]{43}\/?$/;
const defaultLabels = { vault: 'Open Vault', website: 'Connect website' };
const appLabel = /^Connect [\p{L}\p{N}][\p{L}\p{N} .&()+-]{0,79}$/u;

export function setupLink(
  link: SafeLink,
  text: string,
): { href: string; setup: SetupKind; label: string } | null {
  const label = text.trim().replace(/\s+/g, ' ');
  const app = {
    href: link.href,
    setup: 'app',
    label: appLabel.test(label) ? label : 'Connect app',
  } as const;
  if (link.kind === 'external') {
    const url = new URL(link.href);
    return isConnectionBridge(url) ? app : null;
  }
  if (link.kind !== 'setup') return null;
  if (link.setup === 'app') return app;
  return {
    href: link.href,
    setup: link.setup,
    label: label && !label.includes(link.href) ? label : defaultLabels[link.setup],
  };
}

export function safeMessageLink(link: string, origin: string): SafeLink | null {
  const path = link.startsWith(`${origin}/`) ? link.slice(origin.length) : link;
  const value = renamedPaths.get(path) ?? link;
  if (!value || /[\u0000-\u0020\u007f<>"'\\]/.test(value)) return null;
  const absolute = /^https?:\/\//i.test(value);
  if (
    !absolute &&
    !localPath.test(value.split(/[?#]/, 1)[0]) &&
    !appPagePath(value) &&
    value !== '/vault?add=login' &&
    value !== '/vault?add=card' &&
    !connectionPath.test(value) &&
    !e2eConsentPath.test(value)
  )
    return null;
  try {
    const base = new URL(origin);
    const url = new URL(value, base);
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) return null;
    if (
      base.protocol === 'http:' &&
      base.hostname === 'localhost' &&
      base.port === '4320' &&
      url.origin === base.origin &&
      e2eConsentPath.test(url.pathname) &&
      !url.search &&
      !url.hash
    )
      return { href: url.pathname, kind: 'navigation' };
    if (!absolute || url.origin === base.origin) {
      if (url.pathname === '/vault' && (url.search || url.hash))
        return ['?add=login', '?add=card'].includes(url.search) && !url.hash
          ? { href: `/vault${url.search}`, kind: 'setup', setup: 'vault' }
          : null;
      if (
        url.origin === base.origin &&
        !url.hash &&
        connectionPath.test(`${url.pathname}${url.search}`)
      )
        return { href: `${url.pathname}${url.search}`, kind: 'setup', setup: 'app' };
      const path = absolute
        ? value.replace(/^https?:\/\/[^/]+/i, '').split(/[?#]/, 1)[0]
        : value.split(/[?#]/, 1)[0];
      if (
        url.origin === base.origin &&
        !url.search &&
        !url.hash &&
        appPagePath(path) &&
        appPagePath(path) === appPagePath(url.pathname)
      )
        return { href: appPagePath(path)!, kind: 'navigation' };
      if (url.origin !== base.origin || !localPath.test(path) || !localPath.test(url.pathname))
        return null;
      if (url.pathname.startsWith('/api/artifacts/'))
        return { href: url.pathname, kind: 'artifact' };
      return {
        href: url.pathname,
        kind: 'setup',
        setup: url.pathname.startsWith('/browser-connect/') ? 'website' : 'vault',
      };
    }
    return { href: url.href, kind: 'external' };
  } catch {
    return null;
  }
}

const setupParser = unified()
  .use(remarkParse)
  .use(remarkGfm)
  .use(remarkLinkDestinations)
  .use(remarkRehype, { allowDangerousHtml: true })
  .use(rehypeRaw)
  .use(rehypeLocalLinks)
  .use(rehypeSanitize);

export function messageLinkText(children: RootContent[]): string {
  return children
    .map((child) =>
      child.type === 'text'
        ? child.value
        : 'children' in child
          ? messageLinkText(child.children)
          : '',
    )
    .join('');
}

export function messageSetupLinks(text: string, origin: string) {
  const actions = new Map<string, { href: string; setup: SetupKind; label: string }>();
  const tree = setupParser.runSync(setupParser.parse(text)) as Root;
  visit(tree, 'element', (node) => {
    if (node.tagName === 'code' || node.tagName === 'pre') return SKIP;
    if (node.tagName !== 'a' || typeof node.properties.href !== 'string') return;
    const link = safeMessageLink(node.properties.href, origin);
    const setup = link && setupLink(link, messageLinkText(node.children));
    if (setup && !actions.has(setup.href)) actions.set(setup.href, setup);
  });
  return [...actions.values()];
}
