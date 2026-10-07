export async function browserFrames(
  body: ReadableStream<Uint8Array>,
  onFrame: (bytes: Uint8Array<ArrayBuffer>) => void | Promise<void>,
) {
  const reader = body.getReader();
  let bytes = new Uint8Array(4);
  let offset = 0;
  let header = true;
  try {
    while (true) {
      const next = await reader.read();
      if (next.done) throw new Error('The browser view ended.');
      let consumed = 0;
      while (consumed < next.value.length) {
        const length = Math.min(bytes.length - offset, next.value.length - consumed);
        bytes.set(next.value.subarray(consumed, consumed + length), offset);
        offset += length;
        consumed += length;
        if (offset < bytes.length) continue;
        if (header) {
          const size = new DataView(bytes.buffer).getUint32(0);
          if (!size || size > 4 * 1024 * 1024) throw new Error('Invalid browser frame.');
          bytes = new Uint8Array(size);
        } else {
          await onFrame(bytes);
          bytes = new Uint8Array(4);
        }
        offset = 0;
        header = !header;
      }
    }
  } finally {
    await reader.cancel().catch(() => {});
    reader.releaseLock();
  }
}
