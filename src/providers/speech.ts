export async function readSpeechResponse(response: Response, limit: number) {
  if (!response.ok || !response.body) {
    await response.body?.cancel().catch(() => {});
    throw new Error('Speech request failed.');
  }
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    while (true) {
      const part = await reader.read();
      if (part.done) return Buffer.concat(chunks);
      size += part.value.length;
      if (size > limit) throw new Error('The speech response is too large.');
      chunks.push(part.value);
    }
  } finally {
    await reader.cancel().catch(() => {});
    reader.releaseLock();
  }
}
