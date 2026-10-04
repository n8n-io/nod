import { createHash, X509Certificate } from 'node:crypto';
import { mkdir, readFile } from 'node:fs/promises';
import { createServer, request as httpRequest, type RequestListener } from 'node:http';
import { createServer as createHttpsServer } from 'node:https';
import type { AddressInfo, Socket } from 'node:net';
import { join } from 'node:path';
import { runProcess } from '../../../src/providers/process.ts';

export async function createFixtureProxy(
  directory: string,
  hosts: string[],
  handler: RequestListener,
  hermetic = false,
) {
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const key = join(directory, 'fixture.key');
  const cert = join(directory, 'fixture.crt');
  const generated = await runProcess('openssl', [
    'req',
    '-x509',
    '-newkey',
    'rsa:2048',
    '-nodes',
    '-keyout',
    key,
    '-out',
    cert,
    '-days',
    '1',
    '-subj',
    `/CN=${hosts[0]}`,
    '-addext',
    `subjectAltName=${hosts.map((host) => `DNS:${host}`).join(',')}`,
  ]);
  if (generated.exitCode) throw new Error('Could not create the fixture certificate.');
  const certificate = await readFile(cert);
  const fingerprint = createHash('sha256')
    .update(new X509Certificate(certificate).publicKey.export({ format: 'der', type: 'spki' }))
    .digest('base64');
  const https = createHttpsServer({ key: await readFile(key), cert: certificate }, handler);
  const sockets = new Set<Socket>();
  const track = (socket: Socket) => {
    sockets.add(socket);
    socket.once('close', () => sockets.delete(socket));
  };
  let upstream: URL | undefined;
  const proxy = createServer((request, response) => {
    if (!upstream || hermetic) return void response.writeHead(hermetic ? 403 : 503).end();
    const forward = httpRequest(
      upstream,
      { method: request.method, path: request.url, headers: request.headers },
      (result) => {
        response.writeHead(result.statusCode || 502, result.headers);
        result.pipe(response);
      },
    );
    forward.on('error', () => response.destroy());
    request.pipe(forward);
  });
  proxy.on('connection', track);
  proxy.on('connect', (request, socket, head) => {
    if (hosts.some((host) => request.url === `${host}:443`)) {
      socket.write('HTTP/1.1 200 Connection Established\r\n\r\n');
      if (head.length) socket.unshift(head);
      https.emit('connection', socket);
      return;
    }
    if (!upstream || hermetic) return socket.destroy();
    const forward = httpRequest(upstream, {
      method: 'CONNECT',
      path: request.url,
      headers: { host: request.url || '' },
    });
    forward.on('socket', track);
    socket.on('close', () => forward.destroy());
    socket.on('error', () => forward.destroy());
    forward.on('connect', (response, remote, remoteHead) => {
      socket.write(
        `HTTP/1.1 ${response.statusCode || 502} ${response.statusMessage || ''}\r\n\r\n`,
      );
      if (response.statusCode !== 200) {
        remote.destroy();
        socket.destroy();
        return;
      }
      if (remoteHead.length) socket.write(remoteHead);
      if (head.length) remote.write(head);
      remote.on('error', () => socket.destroy());
      remote.on('close', () => {
        if (!remote.readableEnded) socket.destroy();
      });
      socket.on('error', () => remote.destroy());
      socket.on('close', () => remote.destroy());
      remote.pipe(socket).pipe(remote);
    });
    forward.on('error', () => socket.destroy());
    forward.end();
  });
  await new Promise<void>((resolve, reject) => {
    proxy.once('error', reject);
    proxy.listen(0, '127.0.0.1', resolve);
  });
  const proxyUrl = `http://127.0.0.1:${(proxy.address() as AddressInfo).port}`;
  function upstreamProxy(value: string) {
    const target = new URL(value);
    if (target.protocol !== 'http:' || target.hostname !== '127.0.0.1')
      throw new Error('The fixture proxy requires the production loopback guard.');
    if (upstream && upstream.href !== target.href)
      throw new Error('The browser guard changed unexpectedly.');
    upstream = target;
    return proxyUrl;
  }
  return {
    run: (async (command, args, options) => {
      const values = [...args];
      const proxyIndex = values.indexOf('--proxy');
      if (proxyIndex >= 0) {
        values[proxyIndex + 1] = upstreamProxy(values[proxyIndex + 1]);
        const flags = values.indexOf('--args');
        if (flags < 0) throw new Error('Browser arguments were missing.');
        values[flags + 1] += `,--ignore-certificate-errors-spki-list=${fingerprint}`;
      }
      return runProcess(command, values, options);
    }) satisfies typeof runProcess,
    close: async () => {
      for (const socket of sockets) socket.destroy();
      await new Promise<void>((resolve) => proxy.close(() => resolve()));
      https.close();
    },
  };
}
