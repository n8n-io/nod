import { SpeechProviderError } from '../ports/speech.ts';

export async function readSpeechResponse(
  response: Response,
  limit: number,
  provider = 'The voice service',
) {
  if (!response.ok || !response.body) {
    await response.body?.cancel().catch(() => {});
    throw new SpeechProviderError(
      response.status === 401
        ? `${provider} needs to be reconnected. Open Settings → General → Voice.`
        : response.status === 403
          ? `${provider} did not allow this audio request. Check the connection’s speech permissions.`
          : response.status === 402 || response.status === 429
            ? `${provider} reached an account limit. Check its credits or try free voices in Settings → General → Voice.`
            : response.status >= 500
              ? `${provider} is temporarily unavailable. Try again in a moment.`
              : `${provider} could not process this audio request. Try again or choose another voice in Settings → General → Voice.`,
    );
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
