import { getDomain } from 'tldts';

export interface OnePasswordWebsite {
  url: string;
  autofillBehavior: string;
}

function address(url: string) {
  try {
    const parsed = new URL(/^[a-z][a-z\d+.-]*:\/\//i.test(url) ? url : `https://${url}`);
    return ['http:', 'https:'].includes(parsed.protocol) && !parsed.username && !parsed.password
      ? parsed
      : undefined;
  } catch {
    return undefined;
  }
}

function site(hostname: string) {
  return getDomain(hostname, { allowPrivateDomains: true }) ?? hostname;
}

export function matchingWebsite(websites: OnePasswordWebsite[], origin: string) {
  const page = new URL(origin);
  return websites.find((website) => {
    const item = address(website.url);
    if (!item || website.autofillBehavior === 'Never') return false;
    if (website.autofillBehavior === 'ExactDomain') return item.host === page.host;
    return item.hostname === page.hostname || site(item.hostname) === site(page.hostname);
  })?.url;
}
