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
  return {
    id: 'openai',
    configured: Boolean(options.apiKey),
    async synthesize(text, signal) {
      signal?.throwIfAborted();
      const response = await request('https://api.openai.com/v1/audio/speech', {
        method: 'POST',
        signal: AbortSignal.any([AbortSignal.timeout(600_000), ...(signal ? [signal] : [])]),
        headers: { ...headers(), 'Content-Type': 'application/json' },
        body: JSON.stringify({
          model: options.speechModel || 'gpt-4o-mini-tts',
          input: text,
          voice: options.voice || 'coral',
          response_format: 'mp3',
        }),
      });
      if (!response.ok || !response.body) throw new Error('Speech generation failed.');
      const bytes = Buffer.from(await response.arrayBuffer());
      signal?.throwIfAborted();
      return { bytes, mimeType: 'audio/mpeg', fileName: 'reply.mp3' };
    },
  };
}
