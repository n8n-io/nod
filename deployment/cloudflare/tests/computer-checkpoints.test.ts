import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import test from 'node:test';
import { createComputerCheckpoints } from '../src/computer-checkpoints.ts';

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

function bucketFixture() {
  const objects = new Map<string, { bytes: Uint8Array; etag: string }>();
  const uploads: {
    key: string;
    sizes: number[];
    aborted: boolean;
    completed: boolean;
  }[] = [];
  let failPart = false;
  let failComplete = false;
  const bucket = {
    async createMultipartUpload(key: string) {
      const parts = new Map<number, Uint8Array>();
      const state = { key, sizes: [] as number[], aborted: false, completed: false };
      uploads.push(state);
      return {
        key,
        uploadId: randomUUID(),
        async uploadPart(number: number, value: Uint8Array) {
          if (failPart) throw new Error('Synthetic private provider failure');
          assert.equal(number, parts.size + 1);
          state.sizes.push(value.byteLength);
          parts.set(number, value.slice());
          return { partNumber: number, etag: `part-${number}` };
        },
        async complete(completed: R2UploadedPart[]) {
          if (failComplete) throw new Error('Synthetic private complete failure');
          assert.equal(completed.length, parts.size);
          const bytes = new Uint8Array(state.sizes.reduce((sum, size) => sum + size, 0));
          let offset = 0;
          for (const value of parts.values()) {
            bytes.set(value, offset);
            offset += value.byteLength;
          }
          const etag = randomUUID();
          objects.set(key, { bytes, etag });
          state.completed = true;
          return { key, etag, size: bytes.byteLength };
        },
        async abort() {
          state.aborted = true;
        },
      };
    },
    async get(key: string, options: { onlyIf: { etagMatches: string } }) {
      const value = objects.get(key);
      if (!value) return null;
      const metadata = { key, etag: value.etag, size: value.bytes.byteLength };
      if (options.onlyIf.etagMatches !== value.etag) return metadata;
      return { ...metadata, body: byteStream(value.bytes) };
    },
    async delete(key: string) {
      objects.delete(key);
    },
  } as unknown as Pick<R2Bucket, 'createMultipartUpload' | 'get' | 'delete'>;
  return {
    bucket,
    objects,
    uploads,
    failPart() {
      failPart = true;
    },
    failComplete() {
      failComplete = true;
    },
  };
}

function byteStream(bytes: Uint8Array, chunkSize = 32768) {
  let offset = 0;
  return new ReadableStream<Uint8Array>({
    pull(controller) {
      if (offset === bytes.byteLength) return controller.close();
      const next = bytes.slice(offset, offset + chunkSize);
      offset += next.byteLength;
      controller.enqueue(next);
    },
  });
}

function setup(extra: { maxBytes?: number; timeoutMs?: number } = {}) {
  const fixture = bucketFixture();
  const ownerId = randomUUID();
  let active = true;
  let checks = 0;
  const background: Promise<unknown>[] = [];
  const options = {
    bucket: fixture.bucket,
    ownerId,
    environment: 'development',
    role: 'workspace' as const,
    async assertCurrent() {
      checks++;
      if (!active) throw new Error('Synthetic private expired generation');
    },
    waitUntil(promise: Promise<unknown>) {
      background.push(promise);
    },
    ...extra,
  };
  return {
    ...fixture,
    options,
    store: createComputerCheckpoints(options),
    revoke() {
      active = false;
    },
    checks: () => checks,
    background,
  };
}

test('computer checkpoints stream multipart bytes with scoped identity and integrity metadata', async () => {
  const fixture = setup();
  const bytes = new Uint8Array(10 * 1024 * 1024 + 19).fill(173);
  const saved = await fixture.store.save({
    stream: byteStream(bytes),
    exitCode: Promise.resolve(0),
  });
  assert.equal(saved.bytes, bytes.byteLength);
  assert.equal(saved.sha256, createHash('sha256').update(bytes).digest('hex'));
  assert.equal(saved.ownerId, fixture.options.ownerId);
  assert.equal(saved.environment, 'development');
  assert.equal(saved.role, 'workspace');
  assert.equal(fixture.uploads.length, 1);
  assert.equal(
    fixture.uploads[0].key,
    `development/${fixture.options.ownerId}/computers/workspace/${saved.id}.tar.gz`,
  );
  assert.deepEqual(fixture.uploads[0].sizes, [8 * 1024 * 1024, 2 * 1024 * 1024 + 19]);
  assert.ok(fixture.checks() >= 4);
  const restored = new Uint8Array(
    await new Response(await fixture.store.open(saved)).arrayBuffer(),
  );
  assert.deepEqual(restored, bytes);
  const legacy = { ...saved, format: 'otto-computer-tar-v1' as const };
  fixture.objects.set(
    `development/${fixture.options.ownerId}/computers/workspace/${saved.id}.tar`,
    fixture.objects.get(fixture.uploads[0].key)!,
  );
  assert.deepEqual(
    new Uint8Array(await new Response(await fixture.store.open(legacy)).arrayBuffer()),
    bytes,
  );
  await fixture.store.remove(legacy);
  await fixture.store.remove(saved);
  assert.equal(fixture.objects.size, 0);
});

test('archive completion waits for the producer exit acknowledgement', async () => {
  const fixture = setup();
  let finish!: (code: number) => void;
  const exitCode = new Promise<number>((resolve) => {
    finish = resolve;
  });
  const saving = fixture.store.save({ stream: byteStream(new Uint8Array(2048)), exitCode });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(fixture.uploads.length, 1);
  assert.equal(fixture.uploads[0].completed, false);
  assert.equal(fixture.objects.size, 0);
  finish(0);
  await saving;
  assert.equal(fixture.objects.size, 1);
});

test('failed producer, corrupt stream and quota overflow abort unpublished checkpoints', async () => {
  for (const kind of ['producer', 'stream', 'quota', 'empty', 'part', 'complete'] as const) {
    const fixture = setup({ maxBytes: 2048 });
    if (kind === 'part') fixture.failPart();
    if (kind === 'complete') fixture.failComplete();
    const stream =
      kind === 'stream'
        ? new ReadableStream<Uint8Array>({
            start(controller) {
              controller.error(new Error('Synthetic private stream content'));
            },
          })
        : byteStream(new Uint8Array(kind === 'quota' ? 2049 : kind === 'empty' ? 0 : 2048));
    await assert.rejects(
      fixture.store.save({ stream, exitCode: Promise.resolve(kind === 'producer' ? 1 : 0) }),
      {
        name: 'RuntimeControlError',
        status: 503,
        message: 'The runtime request could not be completed.',
      },
    );
    assert.equal(fixture.objects.size, 0, kind);
    assert.equal(fixture.uploads[0].aborted, true, kind);
  }
});

test('expired authorization cannot publish a checkpoint after the producer finishes', async () => {
  const fixture = setup();
  let finish!: (code: number) => void;
  const saving = fixture.store.save({
    stream: byteStream(new Uint8Array(2048)),
    exitCode: new Promise((resolve) => {
      finish = resolve;
    }),
  });
  await new Promise((resolve) => setImmediate(resolve));
  fixture.revoke();
  finish(0);
  await assert.rejects(saving, { status: 503 });
  assert.equal(fixture.objects.size, 0);
  assert.equal(fixture.uploads[0].aborted, true);
});

test('checkpoint reads and removal reject foreign handles and replaced object versions', async () => {
  const fixture = setup();
  const saved = await fixture.store.save({
    stream: byteStream(new Uint8Array(2048)),
    exitCode: Promise.resolve(0),
  });
  for (const changes of [
    { ownerId: randomUUID() },
    { environment: 'production' },
    { role: 'browser' as const },
    { id: '../another-owner' },
    { bytes: 0 },
    { sha256: 'not-a-digest' },
    { etag: 'bad\nvalue' },
  ]) {
    await assert.rejects(fixture.store.open({ ...saved, ...changes }), { status: 503 });
    await assert.rejects(fixture.store.remove({ ...saved, ...changes }), { status: 503 });
    assert.equal(fixture.objects.size, 1);
  }
  fixture.objects.get(fixture.uploads[0].key)!.etag = 'replacement';
  await assert.rejects(fixture.store.open(saved), { status: 503 });
  await assert.rejects(fixture.store.remove(saved), { status: 503 });
  assert.equal(fixture.objects.size, 1);
  fixture.revoke();
  await assert.rejects(fixture.store.remove(saved), { status: 503 });
  assert.equal(fixture.objects.size, 1);
});

test('cancelled and stalled checkpoint streams have bounded failure and are not completed', async () => {
  for (const early of [true, false]) {
    const fixture = setup({ timeoutMs: 30 });
    const controller = new AbortController();
    if (early) controller.abort();
    let cancelled = false;
    await assert.rejects(
      fixture.store.save({
        stream: new ReadableStream<Uint8Array>({
          cancel() {
            cancelled = true;
          },
        }),
        exitCode: new Promise<number>(() => {}),
        signal: controller.signal,
      }),
      { status: 503 },
    );
    assert.equal(cancelled, true);
    assert.equal(fixture.objects.size, 0);
    assert.equal(fixture.uploads.length, early ? 0 : 1);
    if (!early) assert.equal(fixture.uploads[0].aborted, true);
  }
});

test('late multipart creation is aborted after timeout without waiting for its response', async () => {
  const f = setup({ timeoutMs: 15 });
  const create = f.bucket.createMultipartUpload.bind(f.bucket);
  const entered = deferred<void>();
  const release = deferred<void>();
  f.bucket.createMultipartUpload = async (key, options) => {
    entered.resolve();
    await release.promise;
    return create(key, options);
  };
  let cancelled = false;
  const stream = new ReadableStream<Uint8Array>({
    cancel() {
      cancelled = true;
    },
  });
  const saving = assert.rejects(f.store.save({ stream, exitCode: Promise.resolve(0) }), {
    message: 'The runtime request could not be completed.',
    status: 503,
  });
  await entered.promise;
  await saving;
  assert.equal(cancelled, true);
  assert.equal(stream.locked, false);
  assert.equal(f.uploads.length, 0);
  assert.ok(f.background.length >= 1);
  release.resolve();
  await Promise.all(f.background);
  assert.equal(f.uploads.length, 1);
  assert.equal(f.uploads[0].aborted, true);
  assert.equal(f.objects.size, 0);
});

test('late or unknown multipart completion cannot publish a manifest or delete a prior object', async () => {
  for (const reject of [false, true]) {
    const f = setup({ timeoutMs: 20 });
    const previous = await f.store.save({
      stream: byteStream(new Uint8Array(2048).fill(1)),
      exitCode: Promise.resolve(0),
    });
    const priorKey = f.uploads[0].key;
    const priorObject = structuredClone(f.objects.get(priorKey));
    const create = f.bucket.createMultipartUpload.bind(f.bucket);
    const entered = deferred<void>();
    const release = deferred<void>();
    f.bucket.createMultipartUpload = async (key, options) => {
      const upload = await create(key, options);
      const complete = upload.complete.bind(upload);
      upload.complete = async (parts) => {
        entered.resolve();
        await release.promise;
        const object = await complete(parts);
        if (reject)
          throw new Error('Synthetic private completed-but-unacknowledged provider response');
        return object;
      };
      return upload;
    };
    const saving = assert.rejects(
      f.store.save({
        stream: byteStream(new Uint8Array(2048).fill(2)),
        exitCode: Promise.resolve(0),
      }),
      {
        message: 'The runtime request could not be completed.',
        status: 503,
      },
    );
    await entered.promise;
    await saving;
    assert.equal(f.objects.size, 1);
    assert.equal(f.uploads[1].aborted, true);
    release.resolve();
    await Promise.all(f.background);
    assert.deepEqual(f.objects.get(priorKey), priorObject);
    assert.equal(f.objects.size, 1);
    assert.equal(f.objects.has(f.uploads[1].key), false);
    assert.equal(previous.etag, priorObject?.etag);
  }
});

test('authorization loss after multipart completion cleans only the unpublished object', async () => {
  const f = setup();
  const prior = await f.store.save({
    stream: byteStream(new Uint8Array(2048)),
    exitCode: Promise.resolve(0),
  });
  const previousKey = f.uploads[0].key;
  const create = f.bucket.createMultipartUpload.bind(f.bucket);
  f.bucket.createMultipartUpload = async (key, options) => {
    const upload = await create(key, options);
    const complete = upload.complete.bind(upload);
    upload.complete = async (parts) => {
      const result = await complete(parts);
      f.revoke();
      return result;
    };
    return upload;
  };
  await assert.rejects(
    f.store.save({ stream: byteStream(new Uint8Array(2048)), exitCode: Promise.resolve(0) }),
    { status: 503 },
  );
  await Promise.all(f.background);
  assert.equal(f.objects.size, 1);
  assert.equal(f.objects.get(previousKey)?.etag, prior.etag);
});

test('a late checkpoint read is cancelled after its retrieval deadline', async () => {
  const f = setup({ timeoutMs: 15 });
  const saved = await f.store.save({
    stream: byteStream(new Uint8Array(2048)),
    exitCode: Promise.resolve(0),
  });
  const entered = deferred<void>();
  const release = deferred<void>();
  let cancelled = false;
  const body = new ReadableStream<Uint8Array>({
    cancel() {
      cancelled = true;
    },
  });
  f.bucket.get = (async () => {
    entered.resolve();
    await release.promise;
    return { key: f.uploads[0].key, etag: saved.etag, size: saved.bytes, body };
  }) as unknown as typeof f.bucket.get;
  const opening = assert.rejects(f.store.open(saved), { status: 503 });
  await entered.promise;
  await opening;
  assert.equal(cancelled, false);
  release.resolve();
  await Promise.all(f.background);
  assert.equal(cancelled, true);
  assert.equal(body.locked, false);
  assert.equal(f.objects.size, 1);
});

test('post-read authorization or metadata failure cancels the acquired object body', async () => {
  for (const kind of ['authorization', 'size', 'key', 'etag'] as const) {
    const f = setup();
    const saved = await f.store.save({
      stream: byteStream(new Uint8Array(2048)),
      exitCode: Promise.resolve(0),
    });
    let cancelled = false;
    const body = new ReadableStream<Uint8Array>({
      cancel() {
        cancelled = true;
      },
    });
    f.bucket.get = (async () => {
      if (kind === 'authorization') f.revoke();
      return {
        key: kind === 'key' ? '/synthetic/private/key' : f.uploads[0].key,
        etag: kind === 'etag' ? 'unexpected' : saved.etag,
        size: kind === 'size' ? 1024 : saved.bytes,
        body,
      };
    }) as unknown as typeof f.bucket.get;
    await assert.rejects(f.store.open(saved), {
      message: 'The runtime request could not be completed.',
      status: 503,
    });
    await Promise.all(f.background);
    assert.equal(cancelled, true, kind);
    assert.equal(body.locked, false, kind);
  }
});

test('checkpoint streaming rejects changed, truncated, oversized and stalled contents with fixed errors', async () => {
  for (const kind of ['changed', 'truncated', 'oversized', 'stalled'] as const) {
    const f = setup({ timeoutMs: 20 });
    const saved = await f.store.save({
      stream: byteStream(new Uint8Array(2048)),
      exitCode: Promise.resolve(0),
    });
    let cancelled = false;
    let emitted = false;
    const body = new ReadableStream<Uint8Array>(
      {
        pull(controller) {
          if (emitted) {
            if (kind !== 'stalled') controller.close();
            return;
          }
          emitted = true;
          const size = kind === 'truncated' ? 1024 : kind === 'oversized' ? 2049 : 2048;
          controller.enqueue(new Uint8Array(size).fill(kind === 'changed' ? 1 : 0));
        },
        cancel() {
          cancelled = true;
        },
      },
      { highWaterMark: 0 },
    );
    f.bucket.get = (async () => ({
      key: f.uploads[0].key,
      etag: saved.etag,
      size: saved.bytes,
      body,
    })) as unknown as typeof f.bucket.get;
    const stream = await f.store.open(saved);
    await assert.rejects(new Response(stream).arrayBuffer(), {
      message: 'The runtime request could not be completed.',
      status: 503,
    });
    await Promise.all(f.background);
    assert.equal(body.locked, false, kind);
    if (kind === 'oversized' || kind === 'stalled') assert.equal(cancelled, true, kind);
    assert.equal(f.objects.size, 1);
  }
});

test('unconsumed and consumer-cancelled checkpoint bodies release their upstream readers', async () => {
  for (const consume of [true, false]) {
    const f = setup({ timeoutMs: 15 });
    const saved = await f.store.save({
      stream: byteStream(new Uint8Array(2048)),
      exitCode: Promise.resolve(0),
    });
    let cancelled = false;
    const body = new ReadableStream<Uint8Array>({
      cancel() {
        cancelled = true;
      },
    });
    f.bucket.get = (async () => ({
      key: f.uploads[0].key,
      etag: saved.etag,
      size: saved.bytes,
      body,
    })) as unknown as typeof f.bucket.get;
    const stream = await f.store.open(saved);
    if (consume) await stream.cancel();
    else {
      await delay(25);
      await assert.rejects(stream.getReader().read(), { status: 503 });
    }
    await Promise.all(f.background);
    assert.equal(cancelled, true);
    assert.equal(body.locked, false);
  }
});

test('cleanup attempts stay bounded even when delete and cancellation providers never acknowledge', async () => {
  const f = setup({ timeoutMs: 15 });
  const saved = await f.store.save({
    stream: byteStream(new Uint8Array(2048)),
    exitCode: Promise.resolve(0),
  });
  const remove = f.bucket.delete.bind(f.bucket);
  const entered = deferred<void>();
  const release = deferred<void>();
  f.bucket.delete = async (key) => {
    entered.resolve();
    await release.promise;
    return remove(key);
  };
  const removing = assert.rejects(f.store.remove(saved), { status: 503 });
  await entered.promise;
  await removing;
  assert.equal(f.objects.size, 1);
  release.resolve();
  await Promise.all(f.background);
  assert.equal(f.objects.size, 0);

  const stalled = setup({ timeoutMs: 10 });
  let cancelled = false;
  const stream = new ReadableStream<Uint8Array>({
    cancel() {
      cancelled = true;
      return new Promise<void>(() => {});
    },
  });
  await assert.rejects(stalled.store.save({ stream, exitCode: new Promise<number>(() => {}) }), {
    status: 503,
  });
  assert.equal(cancelled, true);
  assert.equal(stream.locked, false);
});

test('failed abort and orphan cleanup never leak provider errors or remove a committed predecessor', async () => {
  const f = setup();
  const saved = await f.store.save({
    stream: byteStream(new Uint8Array(2048)),
    exitCode: Promise.resolve(0),
  });
  const priorKey = f.uploads[0].key;
  const create = f.bucket.createMultipartUpload.bind(f.bucket);
  const deletions: string[] = [];
  f.bucket.delete = async (key) => {
    assert.equal(typeof key, 'string');
    deletions.push(key as string);
    throw new Error('Synthetic private provider cleanup secret');
  };
  f.bucket.createMultipartUpload = async (key, options) => {
    const upload = await create(key, options);
    const complete = upload.complete.bind(upload);
    upload.abort = async () => {
      throw new Error('Synthetic private provider abort secret');
    };
    upload.complete = async (parts) => {
      const result = await complete(parts);
      return Object.assign(result, { key: priorKey });
    };
    return upload;
  };
  await assert.rejects(
    f.store.save({ stream: byteStream(new Uint8Array(2048)), exitCode: Promise.resolve(0) }),
    {
      message: 'The runtime request could not be completed.',
      status: 503,
    },
  );
  await Promise.all(f.background);
  assert.deepEqual(deletions, [f.uploads[1].key]);
  assert.equal(f.objects.get(priorKey)?.etag, saved.etag);
  assert.equal(f.objects.size, 2);
});

test('authorization loss while restoring withholds EOF and cancels the upstream body', async () => {
  const f = setup();
  const saved = await f.store.save({
    stream: byteStream(new Uint8Array(2048)),
    exitCode: Promise.resolve(0),
  });
  const opened = await f.store.open(saved);
  const reader = opened.getReader();
  const first = await reader.read();
  assert.equal(first.value?.byteLength, 2048);
  f.revoke();
  await assert.rejects(reader.read(), {
    message: 'The runtime request could not be completed.',
    status: 503,
  });
  await Promise.all(f.background);
  reader.releaseLock();
  assert.equal(f.objects.size, 1);
});
