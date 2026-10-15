import { ObjectStoreConflict, type PrivateObjectStore } from '../../ports/object-storage.ts';
import {
  objectFailure,
  objectKey,
  objectLimit,
  objectVersion,
  readObjectBody,
} from '../../ports/object-storage-validation.ts';
import { fileBytes } from '../../shared/files.ts';

export function createHttpObjectStore(
  options: {
    endpoint?: string;
    fetch?: typeof fetch;
    timeoutMs?: number;
    generation?: string;
  } = {},
): PrivateObjectStore {
  const endpoint = new URL(options.endpoint ?? 'http://otto.storage/v1/objects/');
  if (
    endpoint.username ||
    endpoint.password ||
    endpoint.search ||
    endpoint.hash ||
    !['http:', 'https:'].includes(endpoint.protocol)
  )
    throw new Error('The private storage endpoint is invalid.');
  const base = endpoint.href.replace(/\/?$/, '/');
  const request = options.fetch ?? fetch;
  const generation = options.generation;
  if (generation !== undefined && !/^[1-9]\d{0,18}$/.test(generation))
    throw new Error('The private storage generation is invalid.');
  async function send(key: string, init: RequestInit) {
    try {
      const headers = new Headers(init.headers);
      if (generation !== undefined) headers.set('x-otto-generation', generation);
      const response = await request(base + encodeURIComponent(objectKey(key)), {
        ...init,
        headers,
        redirect: 'manual',
        signal: AbortSignal.timeout(options.timeoutMs ?? 15_000),
      });
      if (response.status === 412) {
        await response.body?.cancel();
        throw new ObjectStoreConflict();
      }
      return response;
    } catch (error) {
      if (error instanceof ObjectStoreConflict) throw error;
      throw objectFailure();
    }
  }
  return {
    async read(key, maxBytes) {
      objectLimit(maxBytes);
      const response = await send(key, { method: 'GET' });
      if (response.status === 404) {
        await response.body?.cancel();
        return undefined;
      }
      const version = response.headers.get('etag');
      const size = response.headers.get('content-length');
      if (!response.ok || !version || (size && (!/^\d+$/.test(size) || Number(size) > maxBytes))) {
        await response.body?.cancel();
        throw objectFailure();
      }
      try {
        return {
          bytes: await readObjectBody(response.body, maxBytes, options.timeoutMs),
          version: objectVersion(version),
        };
      } catch {
        throw objectFailure();
      }
    },
    async write(key, bytes, { expectedVersion }) {
      if (bytes.byteLength > fileBytes) throw objectFailure();
      const response = await send(key, {
        method: 'PUT',
        headers: {
          'Content-Type': 'application/octet-stream',
          ...(expectedVersion === null
            ? { 'If-None-Match': '*' }
            : { 'If-Match': objectVersion(expectedVersion) }),
        },
        body: Buffer.from(bytes),
      });
      await response.body?.cancel();
      const version = response.headers.get('etag');
      if (!response.ok || !version) throw objectFailure();
      return objectVersion(version);
    },
    async remove(key, options) {
      const response = await send(key, {
        method: 'DELETE',
        headers:
          options?.expectedVersion !== undefined
            ? { 'If-Match': objectVersion(options.expectedVersion) }
            : {},
      });
      await response.body?.cancel();
      if (!response.ok && response.status !== 404) throw objectFailure();
    },
  };
}
