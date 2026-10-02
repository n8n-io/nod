import type { SpeechProvider } from '../../ports/speech.ts';

export function createOpenAISpeechProvider(options: {
  apiKey?: string;
  speechModel?: string;
  voice?: string;
  fetch?: typeof fetch;
}): SpeechProvider {
  const request = options.fetch ?? fetch;
  function headers() {
    if (!options.apiKey) throw new Error('Speech is not configured.');
    return { Authorization: `Bearer ${options.apiKey}` };
  }
  function timeout(signal?: AbortSignal) {
    return AbortSignal.any([AbortSignal.timeout(60_000), ...(signal ? [signal] : [])]);
  }
  return {
    id: 'openai',
    configured: Boolean(options.apiKey),
    async synthesize(text, signal) {
      signal?.throwIfAborted();
      const response = await request('https://api.openai.com/v1/audio/speech', {
        method: 'POST',
        signal: timeout(signal),
        headers: { ...headers(), 'Content-Type': 'application/json' },
        body: JSON.stringify({
          model: options.speechModel || 'gpt-4o-mini-tts',
          input: text,
          voice: options.voice || 'coral',
          response_format: 'mp3',
        }),
      });
      if (!response.ok || !response.body) throw new Error('Speech generation failed.');
      const reader = response.body.getReader();
      const chunks: Uint8Array[] = [];
      let size = 0;
      try {
        while (true) {
          signal?.throwIfAborted();
          const { value, done } = await reader.read();
          if (done) break;
          size += value.byteLength;
          if (size > 15 * 1024 * 1024) throw new Error('Generated audio is too large.');
          chunks.push(value);
        }
      } finally {
        await reader.cancel().catch(() => {});
        reader.releaseLock();
      }
      return { bytes: Buffer.concat(chunks, size), mimeType: 'audio/mpeg', fileName: 'reply.mp3' };
    },
  };
}
