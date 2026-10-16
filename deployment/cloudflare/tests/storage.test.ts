import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import test from 'node:test';
import { storageRequest } from '../src/storage.ts';
import { fileBytes } from '../../../src/shared/files.ts';

function put(url: string, body: string, headers: Record<string, string> = {}) {
  return new Request(url, {
    method: 'PUT',
    body,
    headers: { 'content-length': String(new Blob([body]).size), ...headers },
  });
}

function fixture() {
  const objects = new Map<string, { body: Uint8Array; etag: string }>();
  let version = 0;
  const bucket = {
    async get(key: string) {
      const value = objects.get(key);
      return value ? { body: value.body, size: value.body.byteLength, httpEtag: value.etag } : null;
    },
    async put(key: string, value: ReadableStream | Uint8Array, options: { onlyIf: Headers }) {
      const body =
        value instanceof Uint8Array
          ? value
          : new Uint8Array(await new Response(value).arrayBuffer());
      const current = objects.get(key);
      if (
        (options.onlyIf.get('if-none-match') === '*' && current) ||
        (options.onlyIf.has('if-match') && options.onlyIf.get('if-match') !== current?.etag)
      )
        return null;
      const etag = `"version-${++version}"`;
      objects.set(key, { body, etag });
      return { httpEtag: etag };
    },
    async delete(key: string) {
      objects.delete(key);
    },
  } as unknown as R2Bucket;
  const identity = { ownerId: randomUUID(), environment: 'development' };
  return { objects, bucket, identity };
}

test('storage keys use trusted owner and environment and never caller-supplied headers', async () => {
  const { objects, bucket, identity } = fixture();
  const artifact = `artifacts/${randomUUID()}`;
  const url = `http://otto.storage/v1/objects/${encodeURIComponent(artifact)}`;
  const response = await storageRequest(
    put(url, 'synthetic file', { 'if-none-match': '*', 'x-owner-id': randomUUID() }),
    identity,
    bucket,
  );
  assert.equal(response.status, 204);
  assert.deepEqual([...objects.keys()], [`development/${identity.ownerId}/${artifact}`]);
  const read = await storageRequest(new Request(url), identity, bucket);
  assert.equal(await read.text(), 'synthetic file');
  assert.equal(
    (await storageRequest(new Request(url), { ...identity, ownerId: randomUUID() }, bucket)).status,
    404,
  );
  assert.equal(
    (await storageRequest(new Request(url), { ...identity, environment: 'production' }, bucket))
      .status,
    404,
  );
  await storageRequest(
    new Request(url, { method: 'DELETE' }),
    { ...identity, ownerId: randomUUID() },
    bucket,
  );
  assert.equal(objects.size, 1);
  await storageRequest(new Request(url, { method: 'DELETE' }), identity, bucket);
  assert.equal(objects.size, 0);
});

test('session checkpoints require exact etag compare-and-swap across competing writers', async () => {
  const { bucket, identity } = fixture();
  const key = `sessions/${randomUUID()}.jsonl`;
  const url = `http://otto.storage/v1/objects/${encodeURIComponent(key)}`;
  const first = await storageRequest(put(url, 'first', { 'if-none-match': '*' }), identity, bucket);
  const etag = first.headers.get('etag')!;
  const writes = await Promise.all([
    storageRequest(put(url, 'second', { 'if-match': etag }), identity, bucket),
    storageRequest(put(url, 'stale', { 'if-match': etag }), identity, bucket),
  ]);
  assert.deepEqual(
    writes.map((response) => response.status),
    [204, 412],
  );
  assert.equal(await (await storageRequest(new Request(url), identity, bucket)).text(), 'second');
  await assert.rejects(storageRequest(put(url, 'blind'), identity, bucket), { status: 428 });
});

test('private storage keeps tenants out of computer checkpoints and bounds object size', async () => {
  const { objects, bucket, identity } = fixture();
  for (const key of [
    '../secrets',
    `computers/workspace/${randomUUID()}.tar.gz`,
    `computers/browser/${randomUUID()}.tar`,
    'memory/../MEMORY.md',
    'artifacts/',
  ])
    await assert.rejects(
      storageRequest(
        new Request(`http://otto.storage/v1/objects/${encodeURIComponent(key)}`),
        identity,
        bucket,
      ),
    );
  const url = `http://otto.storage/v1/objects/${encodeURIComponent(`artifacts/${randomUUID()}`)}`;
  await assert.rejects(storageRequest(new Request(url), { ...identity, ownerId: 'other' }, bucket));
  await assert.rejects(
    storageRequest(
      new Request(url, { method: 'PUT', body: 'unsized', headers: { 'if-none-match': '*' } }),
      identity,
      bucket,
    ),
    { status: 411 },
  );
  await assert.rejects(
    storageRequest(
      new Request(url, {
        method: 'PUT',
        body: 'oversized',
        headers: { 'if-none-match': '*', 'content-length': String(fileBytes + 1) },
      }),
      identity,
      bucket,
    ),
    { status: 413 },
  );
  assert.equal(objects.size, 0);
});
