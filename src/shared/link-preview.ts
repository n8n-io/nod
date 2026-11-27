import { isPublicIpv4Address } from './public-address.ts';

function isPublicAddress(url: URL): boolean {
  if (
    !['http:', 'https:'].includes(url.protocol) ||
    url.username ||
    url.password ||
    (url.port && !['80', '443'].includes(url.port))
  )
    return false;
  const host = url.hostname.toLowerCase().replace(/\.$/, '');
  if (
    !host.includes('.') ||
    /(?:^|\.)(?:localhost|local|internal|test|invalid|example)$/.test(host) ||
    (/^\d+\.\d+\.\d+\.\d+$/.test(host) && !isPublicIpv4Address(host)) ||
    host.includes(':')
  )
    return false;
  return true;
}

export function publicMediaUrl(value: string): string | null {
  if (value.length > 2048) return null;
  try {
    const url = new URL(value);
    if (!isPublicAddress(url)) return null;
    url.hash = '';
    return url.href;
  } catch {
    return null;
  }
}

function hasSensitiveParams(params: URLSearchParams, sensitive: RegExp): boolean {
  for (const [key, param] of params) {
    if (
      sensitive.test(key) ||
      /^[A-Za-z\d_-]{40,}$/.test(param) ||
      /^eyJ[A-Za-z\d_-]*\.[A-Za-z\d_-]+\.[A-Za-z\d_-]*$/.test(param)
    )
      return true;
  }
  return false;
}

export function publicActionUrl(value: string): string | null {
  if (value.length > 2048) return null;
  try {
    const url = new URL(value);
    if (url.protocol !== 'https:' || !isPublicAddress(url)) return null;
    const host = url.hostname.toLowerCase().replace(/\.$/, '');
    if (
      /^(?:auth|login|accounts)\./i.test(host) ||
      ['connect.composio.dev', 'app.composio.dev'].includes(host)
    )
      return null;
    const decoded = decodeURIComponent(url.pathname + url.hash);
    if (
      /(?:^|[/#])(?:vault|credentials|credential-requests|payments|payment-requests|approvals?|consent|reset|auth|oauth|authorize|login|signin|reset-password|password-reset|invite|invitation|unsubscribe|logout|signout)(?:\/|$|[?#])/i.test(
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
      /(?:token|secret|password|passcode|credential|signature|session|authorization|(?:^|[_-])(?:key|auth|sig|jwt|state|nonce|grant|challenge)(?:$|[_-]))/i;
    if (hasSensitiveParams(url.searchParams, sensitive)) return null;
    if (url.pathname.split('/').some((part) => /^[A-Za-z\d_-]{64,}$/.test(part))) return null;
    const hash = url.hash.startsWith('#') ? url.hash.slice(1) : '';
    if (hash) {
      const decodedHash = decodeURIComponent(hash);
      if (
        decodedHash
          .split(/[/?&#=]/)
          .some(
            (part) =>
              /^[A-Za-z\d_-]{64,}$/.test(part) ||
              /^eyJ[A-Za-z\d_-]*\.[A-Za-z\d_-]+\.[A-Za-z\d_-]*$/.test(part),
          )
      )
        return null;
      const queryIndex = hash.indexOf('?');
      if (
        queryIndex >= 0 &&
        hasSensitiveParams(new URLSearchParams(hash.slice(queryIndex + 1)), sensitive)
      )
        return null;
      if (hash.includes('=') && hasSensitiveParams(new URLSearchParams(hash), sensitive))
        return null;
    }
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
