import { AsyncLocalStorage } from 'node:async_hooks';
import dns from 'node:dns';
import http from 'node:http';
import https from 'node:https';
import { syncBuiltinESMExports } from 'node:module';

const publicAddress = '93.184.216.34';
const webRequest = new AsyncLocalStorage<boolean>();

export function withFixtureWebRequest<T>(run: () => T): T {
  return webRequest.run(true, run);
}

function requestUrl(input: unknown, protocol: string) {
  if (typeof input === 'string' || input instanceof URL) return new URL(input);
  if (!input || typeof input !== 'object') return undefined;
  const options = input as https.RequestOptions;
  const host = options.hostname ?? options.host;
  if (!host) return undefined;
  try {
    return new URL(
      `${options.protocol ?? protocol}//${host}${options.port ? `:${options.port}` : ''}${options.path ?? '/'}`,
    );
  } catch {
    return undefined;
  }
}

export function routeFixtureHosts(hosts: string[], origin: string, hermetic = false) {
  const fixture = new Set(hosts.map((host) => host.toLowerCase()));
  const upstream = new URL(origin);
  const restricted = () => hermetic && webRequest.getStore();
  const outside = () => new Error('External websites are unavailable in this controlled run.');
  const allow = (url: URL) => {
    if (restricted() && !fixture.has(url.hostname.toLowerCase())) throw outside();
  };
  const lookup = dns.promises.lookup;
  const realFetch = globalThis.fetch;
  const realHttpRequest = http.request;
  const realHttpsRequest = https.request;
  const realHttpGet = http.get;
  const realHttpsGet = https.get;
  const route =
    (send: typeof https.request, protocol: string) =>
    (...args: Parameters<typeof https.request>) => {
      const [first, second, third] = args as [unknown, unknown, unknown];
      const target = requestUrl(first, protocol);
      if (target) allow(target);
      else if (restricted()) throw outside();
      if (!target || !fixture.has(target.hostname.toLowerCase())) return send(...args);
      const options = (
        typeof first === 'object' && first && !(first instanceof URL)
          ? first
          : typeof second === 'object' && second
            ? second
            : {}
      ) as https.RequestOptions;
      const callback = (typeof second === 'function' ? second : third) as
        ((response: http.IncomingMessage) => void) | undefined;
      const {
        lookup: _lookup,
        agent: _agent,
        hostname: _hostname,
        host: _host,
        port: _port,
        path: _path,
        protocol: _protocol,
        ...rest
      } = options;
      const local = new URL(`${target.pathname}${target.search}`, origin);
      return realHttpRequest(
        local,
        {
          ...rest,
          headers: { ...(rest.headers as Record<string, string>), 'x-fixture-host': target.host },
        },
        callback,
      );
    };
  http.request = route(realHttpRequest, 'http:') as typeof http.request;
  https.request = route(realHttpsRequest, 'https:') as typeof https.request;
  http.get = ((...args: Parameters<typeof http.get>) => {
    const request = http.request(...args);
    request.end();
    return request;
  }) as typeof http.get;
  https.get = ((...args: Parameters<typeof https.get>) => {
    const request = https.request(...args);
    request.end();
    return request;
  }) as typeof https.get;
  dns.promises.lookup = ((hostname: string, options?: dns.LookupOptions) => {
    if (restricted() && !fixture.has(hostname.toLowerCase()) && hostname !== upstream.hostname)
      return Promise.reject(outside());
    return fixture.has(hostname.toLowerCase())
      ? Promise.resolve(
          options?.all
            ? [{ address: publicAddress, family: 4 }]
            : { address: publicAddress, family: 4 },
        )
      : lookup(hostname, options ?? {});
  }) as typeof dns.promises.lookup;
  syncBuiltinESMExports();
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const request = input instanceof Request ? input : undefined;
    const url = new URL(request?.url ?? String(input));
    allow(url);
    if (!fixture.has(url.hostname.toLowerCase())) return realFetch(input, init);
    const { dispatcher: _dispatcher, ...options } = (init ?? {}) as RequestInit & {
      dispatcher?: unknown;
    };
    let current = new Request(input, options);
    for (let redirects = 0; ; redirects++) {
      const address = new URL(current.url);
      allow(address);
      const target = new URL(`${address.pathname}${address.search}`, origin);
      const routed = new Request(target, current.clone());
      routed.headers.set('x-fixture-host', address.host);
      const response = await realFetch(routed, {
        redirect: restricted() ? 'manual' : current.redirect,
      });
      if (!restricted()) return response;
      Object.defineProperty(response, 'url', { value: address.href });
      Object.defineProperty(response, 'redirected', { value: redirects > 0 });
      if (![301, 302, 303, 307, 308].includes(response.status) || current.redirect === 'manual')
        return response;
      if (current.redirect === 'error') throw new Error('The fixture returned a redirect.');
      const location = response.headers.get('location');
      if (!location) return response;
      if (redirects >= 20) throw new Error('The fixture returned too many redirects.');
      const next = new URL(location, address);
      allow(next);
      const changeMethod =
        (response.status === 303 && !['GET', 'HEAD'].includes(current.method)) ||
        ([301, 302].includes(response.status) && current.method === 'POST');
      const following = changeMethod
        ? new Request(next, { method: 'GET', headers: current.headers, signal: current.signal })
        : new Request(next, current.clone());
      if (changeMethod)
        for (const name of [
          'content-encoding',
          'content-language',
          'content-location',
          'content-type',
          'content-length',
        ])
          following.headers.delete(name);
      if (next.origin !== address.origin)
        for (const name of ['authorization', 'cookie', 'proxy-authorization'])
          following.headers.delete(name);
      await response.body?.cancel();
      current = following;
    }
  }) as typeof fetch;
  return () => {
    dns.promises.lookup = lookup;
    globalThis.fetch = realFetch;
    http.request = realHttpRequest;
    https.request = realHttpsRequest;
    http.get = realHttpGet;
    https.get = realHttpsGet;
    syncBuiltinESMExports();
  };
}
