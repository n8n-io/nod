import { fileBytes } from '../shared/files.ts';

export function objectKey(key: string) {
  if (
    !/^(?:artifacts\/[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}|sessions\/[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}(?:\/[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12})?\.jsonl|memory\/MEMORY\.md)$/.test(
      key,
    )
  )
    throw new Error('The private file identifier is invalid.');
  return key;
}

export function objectLimit(limit: number) {
  if (!Number.isInteger(limit) || limit < 1 || limit > fileBytes)
    throw new Error('The private file size limit is invalid.');
  return limit;
}

export function objectVersion(version: string) {
  if (!/^[A-Za-z0-9"._=-]{1,200}$/.test(version))
    throw new Error('The private file version is invalid.');
  return version;
}

export function objectFailure() {
  return new Error('Private file storage is temporarily unavailable.');
}

export async function readObjectBody(
  body: ReadableStream<Uint8Array> | null,
  maxBytes: number,
  timeoutMs = 15_000,
) {
  if (!body) throw objectFailure();
  const reader = body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const expired = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => reject(objectFailure()), timeoutMs);
  });
  try {
    while (true) {
      const item = await Promise.race([reader.read(), expired]);
      if (item.done) break;
      size += item.value.byteLength;
      if (size > maxBytes) throw objectFailure();
      chunks.push(item.value);
    }
    return Buffer.concat(chunks, size);
  } finally {
    clearTimeout(timer);
    void reader.cancel().catch(() => {});
    reader.releaseLock();
  }
}
