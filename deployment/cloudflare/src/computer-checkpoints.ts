import { createHash, randomUUID } from 'node:crypto';
import { environmentName, ownerIdentity, RuntimeControlError } from './protocol.ts';

export type ComputerCheckpoint = {
  format: 'otto-computer-tar-v1' | 'otto-computer-tar-gzip-v1';
  id: string;
  ownerId: string;
  environment: string;
  role: 'browser' | 'workspace';
  bytes: number;
  sha256: string;
  etag: string;
};

const archiveBytes = 1024 * 1024 * 1024;
const maximumBytes = archiveBytes + Math.floor(archiveBytes / 1000) + 65536;
const minimumBytes = 20;
const partBytes = 8 * 1024 * 1024;
const unavailable = () => new RuntimeControlError(503);

export class CheckpointTooLarge extends Error {}

function amount(bytes: number) {
  return bytes >= 2 ** 30
    ? `${(bytes / 2 ** 30).toFixed(1)} GiB`
    : `${Math.max(1, Math.round(bytes / 2 ** 20))} MiB`;
}

export function checkpointTooLarge(output: Uint8Array, display: (path: string) => string) {
  let report;
  try {
    report = JSON.parse(new TextDecoder('utf-8', { fatal: true, ignoreBOM: false }).decode(output));
  } catch {
    return undefined;
  }
  const counts = ['bytes', 'max_bytes', 'entries', 'max_entries'];
  if (
    !report ||
    typeof report !== 'object' ||
    Object.keys(report).length !== counts.length + 2 ||
    counts.some((key) => !Number.isSafeInteger(report[key]) || report[key] < 0) ||
    typeof report.complete !== 'boolean' ||
    !Array.isArray(report.largest) ||
    report.largest.length > 5 ||
    report.largest.some(
      (item: unknown) =>
        !Array.isArray(item) ||
        item.length !== 2 ||
        typeof item[0] !== 'string' ||
        !item[0] ||
        item[0].length > 4096 ||
        !Number.isSafeInteger(item[1]) ||
        item[1] < 0,
    )
  )
    return undefined;
  const largest: [string, number][] = report.largest.map(([path, bytes]: [string, number]) => {
    const shown = display(path);
    return [shown.length > 200 ? `…${shown.slice(-200)}` : shown, bytes];
  });
  const over = report.complete ? '' : 'at least ';
  const reasons = [
    ...(report.bytes > report.max_bytes
      ? [
          `it needs ${over}${amount(report.bytes)}, ${over}${amount(report.bytes - report.max_bytes)} over the ${amount(report.max_bytes)} limit`,
        ]
      : []),
    ...(report.entries + 1 > report.max_entries
      ? [
          `it holds ${over}${report.entries} files, folders and links, over the ${report.max_entries} limit`,
        ]
      : []),
  ];
  if (!reasons.length) return undefined;
  return new CheckpointTooLarge(
    `The workspace is too large to save: ${reasons.join('; ')}.${
      largest.length
        ? ` Largest files: ${largest.map(([path, bytes]) => `${path} (${amount(bytes)})`).join(', ')}.`
        : ''
    } Changes since the last save stay only while the workspace is active and are discarded when it goes idle. Delete or compress large files or folders, such as downloads, caches or build output, then run the command again.`,
  );
}

export function createComputerCheckpoints(options: {
  bucket: Pick<R2Bucket, 'createMultipartUpload' | 'get' | 'delete'>;
  ownerId: string;
  environment: string;
  role: 'browser' | 'workspace';
  assertCurrent(): Promise<void>;
  waitUntil?(promise: Promise<unknown>): void;
  maxBytes?: number;
  timeoutMs?: number;
}) {
  const ownerId = ownerIdentity(options.ownerId);
  const environment = environmentName(options.environment);
  const role = options.role;
  const limit = options.maxBytes ?? maximumBytes;
  const timeoutMs = options.timeoutMs ?? 120_000;
  if (
    !['browser', 'workspace'].includes(role) ||
    !Number.isSafeInteger(limit) ||
    limit < 1024 ||
    limit > maximumBytes ||
    !Number.isSafeInteger(timeoutMs) ||
    timeoutMs < 1 ||
    timeoutMs > 120_000
  )
    throw unavailable();

  const key = (id: string, format: ComputerCheckpoint['format']) =>
    `${environment}/${ownerId}/computers/${role}/${ownerIdentity(id)}.${format === 'otto-computer-tar-v1' ? 'tar' : 'tar.gz'}`;

  function background(promise: Promise<unknown>) {
    const pending = promise.catch(() => {});
    try {
      options.waitUntil?.(pending);
    } catch {}
  }

  function deadline(external?: AbortSignal) {
    const controller = new AbortController();
    const cancel = () => controller.abort();
    const timer = setTimeout(cancel, timeoutMs);
    external?.addEventListener('abort', cancel, { once: true });
    if (external?.aborted) cancel();
    const signal = controller.signal;
    return {
      signal,
      close() {
        clearTimeout(timer);
        external?.removeEventListener('abort', cancel);
      },
      async run<T>(operation: () => Promise<T>): Promise<T> {
        if (signal.aborted) throw unavailable();
        let rejectAbort!: () => void;
        const cancelled = new Promise<never>((_resolve, reject) => {
          rejectAbort = () => reject(unavailable());
          signal.addEventListener('abort', rejectAbort, { once: true });
        });
        try {
          const result = await Promise.race([
            Promise.resolve().then(() => {
              if (signal.aborted) throw unavailable();
              return operation();
            }),
            cancelled,
          ]);
          if (signal.aborted) throw unavailable();
          return result;
        } finally {
          signal.removeEventListener('abort', rejectAbort);
        }
      },
    };
  }

  function validate(checkpoint: ComputerCheckpoint) {
    if (
      !['otto-computer-tar-v1', 'otto-computer-tar-gzip-v1'].includes(checkpoint.format) ||
      checkpoint.ownerId !== ownerId ||
      checkpoint.environment !== environment ||
      checkpoint.role !== role ||
      !Number.isSafeInteger(checkpoint.bytes) ||
      checkpoint.bytes < minimumBytes ||
      checkpoint.bytes > limit ||
      !/^[a-f0-9]{64}$/.test(checkpoint.sha256) ||
      !/^[^"\u0000-\u0020]{1,200}$/.test(checkpoint.etag)
    )
      throw unavailable();
    return key(checkpoint.id, checkpoint.format);
  }

  function matches(
    object: R2Object | R2ObjectBody | null,
    checkpoint: ComputerCheckpoint,
    objectKey: string,
  ): object is R2ObjectBody {
    return (
      !!object &&
      'body' in object &&
      object.key === objectKey &&
      object.size === checkpoint.bytes &&
      object.etag === checkpoint.etag
    );
  }

  async function cancelBody(object: R2Object | R2ObjectBody | null) {
    if (object && 'body' in object) await object.body.cancel();
  }

  async function save(input: {
    stream: ReadableStream<Uint8Array>;
    exitCode: Promise<number>;
    signal?: AbortSignal;
  }): Promise<ComputerCheckpoint> {
    const bound = deadline(input.signal);
    const id = randomUUID();
    const objectKey = key(id, 'otto-computer-tar-gzip-v1');
    let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
    let creation: Promise<R2MultipartUpload> | undefined;
    let completion: Promise<R2Object> | undefined;
    let completed = false;
    const exit = input.exitCode.then(
      (code) => code,
      () => null,
    );
    try {
      reader = input.stream.getReader();
      await bound.run(options.assertCurrent);
      const upload = await bound.run(() => {
        creation = options.bucket.createMultipartUpload(objectKey, {
          httpMetadata: { contentType: 'application/gzip', cacheControl: 'no-store' },
        });
        return creation;
      });
      const parts: R2UploadedPart[] = [];
      const hash = createHash('sha256');
      let pending = new Uint8Array(partBytes);
      let used = 0;
      let size = 0;
      const flush = async () => {
        if (!used) return;
        await bound.run(options.assertCurrent);
        parts.push(
          await bound.run(() => upload.uploadPart(parts.length + 1, pending.subarray(0, used))),
        );
        pending = new Uint8Array(partBytes);
        used = 0;
      };
      while (true) {
        const next = await bound.run(() => reader!.read());
        if (next.done) break;
        const chunk = next.value;
        if (!(chunk instanceof Uint8Array) || chunk.byteLength > 16 * 1024 * 1024)
          throw unavailable();
        size += chunk.byteLength;
        if (size > limit) throw unavailable();
        hash.update(chunk);
        for (let offset = 0; offset < chunk.byteLength;) {
          const length = Math.min(partBytes - used, chunk.byteLength - offset);
          pending.set(chunk.subarray(offset, offset + length), used);
          used += length;
          offset += length;
          if (used === partBytes) await flush();
        }
      }
      if (size < minimumBytes || (await bound.run(() => exit)) !== 0) throw unavailable();
      await flush();
      await bound.run(options.assertCurrent);
      const object = await bound.run(() => {
        completion = upload.complete(parts);
        return completion;
      });
      if (object.size !== size || object.key !== objectKey) throw unavailable();
      await bound.run(options.assertCurrent);
      const checkpoint: ComputerCheckpoint = {
        format: 'otto-computer-tar-gzip-v1',
        id,
        ownerId,
        environment,
        role,
        bytes: size,
        sha256: hash.digest('hex'),
        etag: object.etag,
      };
      validate(checkpoint);
      completed = true;
      return checkpoint;
    } catch {
      throw unavailable();
    } finally {
      bound.close();
      if (!completed) {
        if (reader) background(reader.cancel());
        if (creation) background(creation.then((upload) => upload.abort()));
        if (completion)
          background(completion.catch(() => {}).then(() => options.bucket.delete(objectKey)));
      }
      reader?.releaseLock();
    }
  }

  async function open(checkpoint: ComputerCheckpoint) {
    const bound = deadline();
    let lookup: Promise<R2Object | R2ObjectBody | null> | undefined;
    let handedOff = false;
    try {
      const objectKey = validate(checkpoint);
      await bound.run(options.assertCurrent);
      const object = await bound.run(() => {
        lookup = options.bucket.get(objectKey, { onlyIf: { etagMatches: checkpoint.etag } });
        return lookup;
      });
      if (!matches(object, checkpoint, objectKey)) throw unavailable();
      await bound.run(options.assertCurrent);
      const reader = object.body.getReader();
      const hash = createHash('sha256');
      let size = 0;
      let finished = false;
      let cancel: () => void;
      function finish(abort: boolean) {
        if (finished) return;
        finished = true;
        bound.close();
        bound.signal.removeEventListener('abort', cancel);
        if (abort) background(reader.cancel());
        reader.releaseLock();
      }
      const stream = new ReadableStream<Uint8Array>(
        {
          start(controller) {
            cancel = () => {
              controller.error(unavailable());
              finish(true);
            };
            bound.signal.addEventListener('abort', cancel, { once: true });
            if (bound.signal.aborted) cancel();
          },
          async pull(controller) {
            try {
              const next = await bound.run(() => reader.read());
              if (finished) return;
              if (next.done) {
                if (size !== checkpoint.bytes || hash.digest('hex') !== checkpoint.sha256)
                  throw unavailable();
                await bound.run(options.assertCurrent);
                if (finished) return;
                controller.close();
                finish(false);
                return;
              }
              if (
                !(next.value instanceof Uint8Array) ||
                size + next.value.byteLength > checkpoint.bytes
              )
                throw unavailable();
              size += next.value.byteLength;
              hash.update(next.value);
              controller.enqueue(next.value);
            } catch {
              if (!finished) {
                controller.error(unavailable());
                finish(true);
              }
            }
          },
          cancel() {
            finish(true);
          },
        },
        { highWaterMark: 0 },
      );
      handedOff = true;
      return stream;
    } catch {
      throw unavailable();
    } finally {
      if (!handedOff) {
        bound.close();
        if (lookup) background(lookup.then(cancelBody));
      }
    }
  }

  async function remove(checkpoint: ComputerCheckpoint) {
    const bound = deadline();
    let lookup: Promise<R2Object | R2ObjectBody | null> | undefined;
    let removal: Promise<void> | undefined;
    try {
      const objectKey = validate(checkpoint);
      await bound.run(options.assertCurrent);
      const object = await bound.run(() => {
        lookup = options.bucket.get(objectKey, { onlyIf: { etagMatches: checkpoint.etag } });
        return lookup;
      });
      if (!object) return;
      if (!matches(object, checkpoint, objectKey)) throw unavailable();
      await bound.run(options.assertCurrent);
      await bound.run(() => {
        removal = options.bucket.delete(objectKey);
        return removal;
      });
      await bound.run(options.assertCurrent);
    } catch {
      throw unavailable();
    } finally {
      bound.close();
      if (lookup) background(lookup.then(cancelBody));
      if (removal) background(removal);
    }
  }

  return { save, open, remove };
}
