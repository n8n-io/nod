import { ownerIdentity, environmentName, RuntimeControlError } from './protocol.ts';
import { fileBytes } from '../../../src/shared/files.ts';

function objectKey(request: Request) {
  const url = new URL(request.url);
  if (!url.pathname.startsWith('/v1/objects/') || url.search || url.hash)
    throw new RuntimeControlError(404);
  let key: string;
  try {
    key = decodeURIComponent(url.pathname.slice('/v1/objects/'.length));
  } catch {
    throw new RuntimeControlError();
  }
  if (key !== 'memory/MEMORY.md' && !/^(?:artifacts|sessions)\/./.test(key))
    throw new RuntimeControlError();
  return key;
}

export async function removeOwnerStorage(
  bucket: Pick<R2Bucket, 'list' | 'delete'>,
  environment: string,
  owner: string,
  dryRun: boolean,
) {
  const prefix = `${environmentName(environment)}/${ownerIdentity(owner)}/`;
  let objects = 0;
  let cursor: string | undefined;
  do {
    const page = await bucket.list({ prefix, limit: 1000, ...(cursor ? { cursor } : {}) });
    const keys = page.objects.map((object) => object.key);
    if (keys.some((key) => !key.startsWith(prefix))) throw new RuntimeControlError();
    objects += keys.length;
    if (!dryRun && keys.length) await bucket.delete(keys);
    cursor = page.truncated ? page.cursor : undefined;
  } while (cursor);
  return objects;
}

export async function storageRequest(
  request: Request,
  identity: { ownerId: string; environment: string },
  bucket: R2Bucket,
) {
  const key = `${environmentName(identity.environment)}/${ownerIdentity(identity.ownerId)}/${objectKey(request)}`;
  const headers = { 'cache-control': 'no-store', 'content-type': 'application/octet-stream' };
  if (request.method === 'GET') {
    const object = await bucket.get(key);
    if (!object) return new Response(null, { status: 404, headers });
    if (object.size > fileBytes) throw new RuntimeControlError(413);
    return new Response(object.body, {
      headers: { ...headers, etag: object.httpEtag, 'content-length': String(object.size) },
    });
  }
  if (request.method === 'PUT') {
    const match = request.headers.get('if-match');
    const absent = request.headers.get('if-none-match');
    if ((!match && absent !== '*') || (match && absent)) throw new RuntimeControlError(428);
    if (match && !/^"[^"\u0000-\u0020]{1,200}"$/.test(match)) throw new RuntimeControlError();
    const conditions = new Headers(match ? { 'if-match': match } : { 'if-none-match': '*' });
    const declared = request.headers.get('content-length') ?? '';
    const length = /^\d{1,16}$/.test(declared) ? Number(declared) : NaN;
    if (!Number.isSafeInteger(length) || (length && !request.body))
      throw new RuntimeControlError(411);
    if (length > fileBytes) throw new RuntimeControlError(413);
    const object = await bucket.put(key, length ? request.body! : new Uint8Array(), {
      onlyIf: conditions,
      httpMetadata: { contentType: 'application/octet-stream', cacheControl: 'no-store' },
    });
    if (!object) return new Response(null, { status: 412, headers });
    return new Response(null, { status: 204, headers: { ...headers, etag: object.httpEtag } });
  }
  if (request.method === 'DELETE') {
    if (request.headers.has('if-match') || request.headers.has('if-none-match'))
      throw new RuntimeControlError(501);
    await bucket.delete(key);
    return new Response(null, { status: 204, headers });
  }
  return new Response(null, { status: 405, headers: { ...headers, allow: 'GET, PUT, DELETE' } });
}
