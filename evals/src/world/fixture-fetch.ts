import dns from 'node:dns';
import http from 'node:http';
import https from 'node:https';
import { syncBuiltinESMExports } from 'node:module';

const publicAddress = '93.184.216.34';

export function routeFixtureHosts(hosts: string[], origin: string) {
  const fixture = new Set(hosts.map((host) => host.toLowerCase()));
  const lookup = dns.promises.lookup;
  const realFetch = globalThis.fetch;
  const realRequest = https.request;
  https.request = ((...args: Parameters<typeof https.request>) => {
    const [first, second, third] = args as [unknown, unknown, unknown];
    const target = typeof first === 'string' || first instanceof URL ? new URL(first) : undefined;
    if (!target || !fixture.has(target.hostname.toLowerCase()))
      return (realRequest as (...input: unknown[]) => ReturnType<typeof https.request>)(...args);
    const options = (typeof second === 'object' && second ? second : {}) as https.RequestOptions;
    const callback = (typeof second === 'function' ? second : third) as
      ((response: http.IncomingMessage) => void) | undefined;
    const { lookup: _lookup, agent: _agent, ...rest } = options;
    const local = new URL(`${target.pathname}${target.search}`, origin);
    return http.request(
      local,
      {
        ...rest,
        headers: { ...(rest.headers as Record<string, string>), 'x-fixture-host': target.host },
      },
      callback,
    );
  }) as typeof https.request;
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
    const { dispatcher: _dispatcher, ...options } = (init ?? {}) as RequestInit & {
      dispatcher?: unknown;
    };
    const target = new URL(`${url.pathname}${url.search}`, origin);
    if (request) {
      const routed = new Request(target, new Request(request, options));
      routed.headers.set('x-fixture-host', url.host);
      return realFetch(routed);
    }
    const headers = new Headers(options.headers);
    headers.set('x-fixture-host', url.host);
    return realFetch(target, { ...options, headers });
  }) as typeof fetch;
  return () => {
    dns.promises.lookup = lookup;
    globalThis.fetch = realFetch;
    https.request = realRequest;
    syncBuiltinESMExports();
  };
}
