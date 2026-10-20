import * as dns from 'node:dns';
import { lookup } from 'node:dns/promises';
import { createServer, request, type OutgoingHttpHeaders } from 'node:http';
import { connect, isIP, type LookupFunction, type Socket } from 'node:net';
import { isPublicIpv4Address } from '../../shared/public-address.ts';

export type AddressResolver = (host: string) => Promise<Array<{ address: string; family: number }>>;

export function isPublicAddress(address: string): boolean {
  if (isIP(address) === 4) return isPublicIpv4Address(address);
  if (isIP(address) !== 6) return false;
  let normal: string;
  try {
    normal = new URL(`http://[${address}]`).hostname.slice(1, -1);
  } catch {
    return false;
  }
  const nat64 = /^64:ff9b::([0-9a-f]{1,4}):([0-9a-f]{1,4})$/.exec(normal);
  if (nat64) {
    const [high, low] = [parseInt(nat64[1], 16), parseInt(nat64[2], 16)];
    return isPublicAddress([high >> 8, high & 255, low >> 8, low & 255].join('.'));
  }
  return (
    /^[23][0-9a-f]{3}:/.test(normal) &&
    !/^2002:/.test(normal) &&
    !/^2001:(?::|0:|db8:|2:|10:|20:)/.test(normal) &&
    !/^3fff:[0-9a-f]{0,3}:/.test(normal)
  );
}

const systemResolver: AddressResolver = (host) => lookup(host, { all: true, verbatim: true });

async function publicAddress(hostname: string, resolver: AddressResolver) {
  const host = hostname.replace(/^\[|\]$/g, '');
  const addresses = isIP(host) ? [{ address: host, family: isIP(host) }] : await resolver(host);
  if (!addresses.length || addresses.some((item) => !isPublicAddress(item.address)))
    throw new Error('Private network destinations are blocked.');
  return addresses[0].address;
}

const connectResolver: AddressResolver = (host) =>
  new Promise((resolve, reject) =>
    dns.lookup(host, { all: true, verbatim: true }, (error, addresses) =>
      error ? reject(error) : resolve(addresses),
    ),
  );

export function publicLookup(resolver: AddressResolver = connectResolver): LookupFunction {
  return (hostname, options, callback) => {
    resolver(hostname).then(
      (answers) => {
        const addresses = answers.filter(
          (item) => !options.family || item.family === options.family,
        );
        if (!addresses.length || answers.some((item) => !isPublicAddress(item.address)))
          return callback(new Error('Private network destinations are blocked.'), '');
        if (options.all) callback(null, addresses);
        else callback(null, addresses[0].address, addresses[0].family);
      },
      (error) => callback(error, ''),
    );
  };
}

export async function publicUrl(
  value: string,
  resolver: AddressResolver = systemResolver,
): Promise<{ url: URL; address: string }> {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error('A valid public HTTP or HTTPS URL is required.');
  }
  if (
    !['http:', 'https:'].includes(url.protocol) ||
    url.username ||
    url.password ||
    (url.port && !['80', '443'].includes(url.port))
  )
    throw new Error('Only public HTTP and HTTPS destinations on ports 80 or 443 are permitted.');
  return { url, address: await publicAddress(url.hostname, resolver) };
}

export function browserUrl(value: string): URL {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error('A valid HTTP or HTTPS URL is required.');
  }
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password)
    throw new Error('Website addresses must use HTTP or HTTPS without embedded credentials.');
  return url;
}

export function createBrowserProxy(
  options: { privateNetwork?: boolean; resolver?: AddressResolver } = {},
) {
  const destination = (url: URL) =>
    options.privateNetwork
      ? Promise.resolve(url.hostname.replace(/^\[|\]$/g, ''))
      : publicAddress(url.hostname, options.resolver ?? systemResolver);
  let server: ReturnType<typeof createServer> | undefined;
  let pending: Promise<string> | undefined;
  let disposed = false;
  const sockets = new Set<Socket>();
  const track = (socket: Socket) => {
    if (sockets.has(socket)) return;
    sockets.add(socket);
    socket.once('close', () => sockets.delete(socket));
    socket.on('error', () => socket.destroy());
  };
  function url(): Promise<string> {
    if (disposed) return Promise.reject(new Error('The browser proxy has stopped.'));
    pending ??= new Promise((resolve, reject) => {
      server = createServer(async (incoming, outgoing) => {
        try {
          const url = browserUrl(incoming.url ?? '');
          if (url.protocol !== 'http:') throw new Error('Invalid proxy request.');
          const headers: OutgoingHttpHeaders = { ...incoming.headers, host: url.host };
          delete headers['proxy-authorization'];
          delete headers['proxy-connection'];
          const upstream = request(
            {
              host: await destination(url),
              port: url.port || 80,
              method: incoming.method,
              path: url.pathname + url.search,
              headers,
            },
            (response) => {
              outgoing.writeHead(response.statusCode ?? 502, response.headers);
              response.pipe(outgoing);
            },
          );
          upstream.on('socket', track);
          upstream.on('error', () => {
            if (!outgoing.headersSent) outgoing.writeHead(502);
            outgoing.end();
          });
          incoming.pipe(upstream);
        } catch {
          outgoing.writeHead(400);
          outgoing.end('Invalid browser request.');
        }
      });
      server.on('connect', async (incoming, socket, head) => {
        try {
          const url = browserUrl(`https://${incoming.url}`);
          if (url.pathname !== '/' || url.search || url.hash) throw new Error();
          const upstream = connect({
            host: await destination(url),
            port: Number(url.port || 443),
          });
          track(upstream);
          upstream.on('close', () => {
            if (!upstream.readableEnded) socket.destroy();
          });
          upstream.on('connect', () => {
            socket.write('HTTP/1.1 200 Connection Established\r\n\r\n');
            if (head.length) upstream.write(head);
            upstream.pipe(socket);
            socket.pipe(upstream);
          });
          upstream.on('error', () => socket.destroy());
          socket.on('error', () => upstream.destroy());
          socket.on('close', () => upstream.destroy());
        } catch {
          socket.end('HTTP/1.1 400 Bad Request\r\nConnection: close\r\n\r\n');
        }
      });
      server.on('connection', track);
      server.on('upgrade', async (incoming, socket, head) => {
        try {
          const url = browserUrl(incoming.url ?? '');
          if (url.protocol !== 'http:') throw new Error();
          const headers: OutgoingHttpHeaders = { ...incoming.headers, host: url.host };
          delete headers['proxy-authorization'];
          delete headers['proxy-connection'];
          const upstream = request({
            host: await destination(url),
            port: url.port || 80,
            method: incoming.method,
            path: url.pathname + url.search,
            headers,
          });
          upstream.on('socket', track);
          upstream.on('error', () => socket.destroy());
          upstream.on('response', (response) => {
            socket.end(
              `HTTP/1.1 ${response.statusCode ?? 502} ${response.statusMessage ?? 'Bad Gateway'}\r\nConnection: close\r\n\r\n`,
            );
            response.resume();
          });
          upstream.on('upgrade', (response, remote, remoteHead) => {
            const headers = response.rawHeaders
              .flatMap((value, index, values) =>
                index % 2 === 0 ? [`${value}: ${values[index + 1]}\r\n`] : [],
              )
              .join('');
            socket.write(
              `HTTP/1.1 ${response.statusCode ?? 101} ${response.statusMessage ?? 'Switching Protocols'}\r\n${headers}\r\n`,
            );
            if (remoteHead.length) socket.write(remoteHead);
            if (head.length) remote.write(head);
            remote.on('error', () => socket.destroy());
            socket.on('error', () => remote.destroy());
            socket.on('close', () => remote.destroy());
            remote.pipe(socket).pipe(remote);
          });
          upstream.end();
        } catch {
          socket.end('HTTP/1.1 400 Bad Request\r\nConnection: close\r\n\r\n');
        }
      });
      server.once('error', reject);
      server.listen(0, '127.0.0.1', () => {
        const address = server!.address();
        if (!address || typeof address === 'string')
          return reject(new Error('Browser proxy could not start.'));
        server!.unref();
        resolve(`http://127.0.0.1:${address.port}`);
      });
    });
    return pending;
  }
  return {
    url,
    async dispose() {
      disposed = true;
      await pending?.catch(() => {});
      for (const socket of sockets) socket.destroy();
      if (server?.listening)
        await new Promise<void>((resolve, reject) =>
          server!.close((error) => (error ? reject(error) : resolve())),
        );
    },
  };
}
