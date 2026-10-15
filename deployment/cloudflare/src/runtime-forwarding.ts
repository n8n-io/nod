import {
  boundedBody,
  generation,
  ownerIdentity,
  RuntimeControlError,
  type TenantIdentity,
} from './protocol.ts';

export function runtimeRoutingGeneration(
  request: Request,
  identity: TenantIdentity,
  now: () => number = Date.now,
) {
  try {
    const header = request.headers.get('x-otto-runtime');
    if (!header) throw new Error();
    const parts = header.split('.');
    if (
      parts.length !== 2 ||
      !/^[A-Za-z0-9_-]+$/.test(parts[0]) ||
      !/^[A-Za-z0-9_-]{43}$/.test(parts[1])
    )
      throw new Error();
    const encoded = parts[0].replace(/-/g, '+').replace(/_/g, '/');
    const bytes = Uint8Array.from(atob(encoded), (character) => character.charCodeAt(0));
    const claims = JSON.parse(
      new TextDecoder('utf-8', { fatal: true, ignoreBOM: false }).decode(bytes),
    );
    const url = new URL(request.url);
    const time = now();
    if (
      !claims ||
      typeof claims !== 'object' ||
      claims.version !== 1 ||
      claims.ownerId !== identity.ownerId ||
      claims.environment !== identity.environment ||
      claims.method !== request.method ||
      claims.target !== url.pathname + url.search ||
      !Number.isSafeInteger(claims.expiresAt) ||
      claims.expiresAt <= time ||
      claims.expiresAt > time + 35_000 ||
      typeof claims.developer !== 'boolean' ||
      !['user', 'webhook', 'wake', 'deployment'].includes(claims.kind) ||
      typeof claims.bodyHash !== 'string' ||
      !/^[a-f0-9]{64}$/.test(claims.bodyHash)
    )
      throw new Error();
    ownerIdentity(claims.nonce);
    const value = generation(claims.generation);
    if (value !== identity.generation) throw new RuntimeControlError(409);
    if (
      url.pathname === '/api/runtime/lease' &&
      (request.method !== 'POST' || url.search || claims.kind !== 'wake')
    )
      throw new Error();
    if (
      (claims.kind === 'deployment' &&
        (request.method !== 'POST' ||
          url.search ||
          !['/api/runtime/drain', '/api/runtime/resume'].includes(url.pathname))) ||
      (['/api/runtime/drain', '/api/runtime/resume'].includes(url.pathname) &&
        (request.method !== 'POST' || url.search || claims.kind !== 'deployment'))
    )
      throw new Error();
    return value;
  } catch (error) {
    if (error instanceof RuntimeControlError && error.status === 409) throw error;
    throw new RuntimeControlError(401);
  }
}

export async function runtimeLeaseBody(request: Request) {
  const bytes = await boundedBody(request, 1024);
  try {
    const input = JSON.parse(
      new TextDecoder('utf-8', { fatal: true, ignoreBOM: false }).decode(bytes),
    );
    if (!input || Object.keys(input).length !== 1 || typeof input.expiresAt !== 'string')
      throw new Error();
    return { bytes, expiresAt: input.expiresAt as string };
  } catch {
    throw new RuntimeControlError();
  }
}

export async function runtimeLeaseAcknowledgement(response: Response) {
  if (response.status !== 200 || !response.body) {
    await response.body?.cancel().catch(() => {});
    throw new RuntimeControlError(503);
  }
  const reader = response.body.getReader();
  let size = 0;
  const chunks: Uint8Array[] = [];
  try {
    while (true) {
      const next = await reader.read();
      if (next.done) break;
      size += next.value.byteLength;
      if (size > 1024) throw new Error();
      chunks.push(next.value);
    }
    const bytes = new Uint8Array(size);
    let offset = 0;
    for (const chunk of chunks) {
      bytes.set(chunk, offset);
      offset += chunk.length;
    }
    const result = JSON.parse(
      new TextDecoder('utf-8', { fatal: true, ignoreBOM: false }).decode(bytes),
    );
    if (!result || Object.keys(result).length !== 1 || result.ok !== true) throw new Error();
    return new Response(bytes, { status: 200, headers: response.headers });
  } catch {
    throw new RuntimeControlError(503);
  } finally {
    await reader.cancel().catch(() => {});
    reader.releaseLock();
  }
}
