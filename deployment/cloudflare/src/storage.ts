import { boundedBody, ownerIdentity, environmentName, RuntimeControlError } from './protocol.ts';

const objectLimit = 16 * 1024 * 1024;

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
  if (key === 'memory/MEMORY.md') return key;
  const match = /^(artifacts|sessions)\/([0-9a-f-]{36})(?:\/([0-9a-f-]{36}))?(\.jsonl)?$/.exec(key);
  if (
    !match ||
    (match[1] === 'sessions') !== (match[4] === '.jsonl') ||
    (match[3] !== undefined && match[1] !== 'sessions')
  )
    throw new RuntimeControlError();
  ownerIdentity(match[2]);
  if (match[3] !== undefined) ownerIdentity(match[3]);
  return key;
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
    if (object.size > objectLimit) throw new RuntimeControlError(413);
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
    const object = await bucket.put(key, await boundedBody(request, objectLimit), {
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
