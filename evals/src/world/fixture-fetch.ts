import dns from 'node:dns';
import { syncBuiltinESMExports } from 'node:module';

const publicAddress = '93.184.216.34';

export function routeFixtureHosts(hosts: string[], origin: string) {
  const fixture = new Set(hosts.map((host) => host.toLowerCase()));
  const lookup = dns.promises.lookup;
  const realFetch = globalThis.fetch;
  dns.promises.lookup = ((hostname: string, options?: dns.LookupOptions) =>
    fixture.has(hostname.toLowerCase())
      ? Promise.resolve(
          options?.all
            ? [{ address: publicAddress, family: 4 }]
            : { address: publicAddress, family: 4 },
        )
      : lookup(hostname, options ?? {})) as typeof dns.promises.lookup;
  syncBuiltinESMExports();
  globalThis.fetch = ((input: RequestInfo | URL, init?: RequestInit) => {
    const request = input instanceof Request ? input : undefined;
    const url = new URL(request?.url ?? String(input));
    if (!fixture.has(url.hostname.toLowerCase())) return realFetch(input, init);
    const target = new URL(`${url.pathname}${url.search}`, origin);
    if (request) {
      const routed = new Request(target, request);
      routed.headers.set('x-fixture-host', url.host);
      return realFetch(routed, init);
    }
    const headers = new Headers(init?.headers);
    headers.set('x-fixture-host', url.host);
    return realFetch(target, { ...init, headers });
  }) as typeof fetch;
  return () => {
    dns.promises.lookup = lookup;
    globalThis.fetch = realFetch;
    syncBuiltinESMExports();
  };
}
