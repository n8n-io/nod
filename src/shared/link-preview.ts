import { isPublicIpv4Address } from './public-address.ts';

export function publicMediaUrl(value: string): string | null {
  if (value.length > 2048) return null;
  try {
    const url = new URL(value);
    if (
      !['http:', 'https:'].includes(url.protocol) ||
      url.username ||
      url.password ||
      (url.port && !['80', '443'].includes(url.port))
    )
      return null;
    const host = url.hostname.toLowerCase().replace(/\.$/, '');
    if (
      !host.includes('.') ||
      /(?:^|\.)(?:localhost|local|internal|test|invalid|example)$/.test(host) ||
      (/^\d+\.\d+\.\d+\.\d+$/.test(host) && !isPublicIpv4Address(host)) ||
      host.includes(':')
    )
      return null;
    url.hash = '';
    return url.href;
  } catch {
    return null;
  }
}

export function previewableUrl(value: string): string | null {
  if (!publicMediaUrl(value)) return null;
  try {
    const url = new URL(value);
    const host = url.hostname.toLowerCase().replace(/\.$/, '');
    if (
      /^(?:auth|login|accounts)\./i.test(host) ||
      ['connect.composio.dev', 'app.composio.dev'].includes(host)
    )
      return null;
    const decoded = decodeURIComponent(url.pathname + url.hash);
    if (
      /(?:^|\/)(?:vault|credentials|credential-requests|payments|payment-requests|approvals?|consent|reset|auth|oauth|authorize|login|signin|reset-password|password-reset|invite|invitation|unsubscribe|logout|signout|confirm|verify|activate)(?:\/|$|[?#])/i.test(
        decoded,
      ) ||
      /\/api\/artifacts(?:\/|$)/i.test(decoded)
    )
      return null;
    if (
      /(?:access[_-]?token|refresh[_-]?token|password|secret|session|authorization|api[_-]?key)=/i.test(
        decoded,
      )
    )
      return null;
    const sensitive =
      /(?:token|secret|password|passcode|credential|signature|session|authorization|(?:^|[_-])(?:key|code|auth|sig|jwt|state|nonce|grant|ticket|challenge)(?:$|[_-]))/i;
    for (const [key, value] of url.searchParams) {
      if (
        sensitive.test(key) ||
        /^[A-Za-z\d_-]{40,}$/.test(value) ||
        /^eyJ[A-Za-z\d_-]*\.[A-Za-z\d_-]+\.[A-Za-z\d_-]*$/.test(value)
      )
        return null;
    }
    if (url.pathname.split('/').some((part) => /^[A-Za-z\d_-]{64,}$/.test(part))) return null;
    url.hash = '';
    return url.href;
  } catch {
    return null;
  }
}
