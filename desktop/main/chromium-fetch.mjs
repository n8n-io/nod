import { net } from 'electron';
import { Readable } from 'node:stream';

const coded = (error) => {
  const code = /^net::(ERR_[A-Z0-9_]+)$/.exec(error?.message)?.[1];
  return code && error.code === undefined ? Object.assign(error, { code }) : error;
};

export function chromiumFetch(url, init = {}) {
  if (init.redirect !== 'manual')
    return net.fetch(url, init).catch((error) => {
      throw coded(error);
    });
  const { signal } = init;
  return new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(signal.reason);
    const request = net.request({
      url: String(url),
      method: init.method ?? 'GET',
      redirect: 'manual',
    });
    for (const [name, value] of new Headers(init.headers)) request.setHeader(name, value);
    const abort = () => {
      request.abort();
      reject(signal.reason);
    };
    const settle = () => signal?.removeEventListener('abort', abort);
    signal?.addEventListener('abort', abort, { once: true });
    request.on('redirect', (status, method, location) => {
      settle();
      request.abort();
      resolve(new Response(null, { status, headers: { location } }));
    });
    request.on('response', (response) => {
      response.once('close', () => {
        settle();
        request.abort();
      });
      try {
        const headers = new Headers();
        for (const [name, value] of Object.entries(response.headers))
          for (const item of [value].flat()) headers.append(name, item);
        const empty = [204, 205, 304].includes(response.statusCode);
        if (empty) response.resume();
        resolve(
          new Response(empty ? null : Readable.toWeb(response), {
            status: response.statusCode,
            headers,
          }),
        );
      } catch (error) {
        request.abort();
        reject(error);
      }
    });
    request.on('error', (error) => {
      settle();
      reject(coded(error));
    });
    request.end();
  });
}
