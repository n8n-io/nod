import { randomUUID } from 'node:crypto';
import type { SpeechProvider } from '../../ports/speech.ts';
import type { ProviderUsageEvent } from '../../ports/provider-usage.ts';

async function readResponse(response: Response, limit: number) {
  if (!response.ok || !response.body) throw new Error('Speech request failed.');
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
  }
}

export function createOpenAISpeechProvider(options: {
  apiKey?: string;
  speechModel?: string;
  transcriptionModel?: string;
  voice?: string;
  fetch?: typeof fetch;
}): SpeechProvider {
  const request = options.fetch ?? fetch;
  function headers() {
    if (!options.apiKey) throw new Error('Speech is not configured.');
    return { Authorization: `Bearer ${options.apiKey}` };
  }
  async function measured<T>(
    model: string,
    operation: string,
    signal: AbortSignal | undefined,
    report: ((usage: ProviderUsageEvent) => void) | undefined,
    run: (usage: ProviderUsageEvent) => Promise<T>,
  ) {
    const started = Date.now();
    const usage: ProviderUsageEvent = {
      id: randomUUID(),
      provider: 'openai',
      category: 'agent',
      operation,
      model,
      status: 'failed',
      durationMs: 0,
      costUsd: null,
      pricing: 'unavailable',
    };
    try {
      const result = await run(usage);
      usage.status = 'succeeded';
      return result;
    } finally {
      if (signal?.aborted) usage.status = 'cancelled';
      usage.durationMs = Date.now() - started;
      report?.(usage);
    }
  }
  return {
    id: 'openai',
    configured: Boolean(options.apiKey),
    async transcribe(audio, signal, report) {
      signal?.throwIfAborted();
      const model = options.transcriptionModel || 'gpt-transcribe';
      return measured(model, 'transcribe', signal, report, async (usage) => {
        const body = new FormData();
        body.set('model', model);
        body.set('response_format', 'json');
        if (model === 'gpt-transcribe' || model === 'gpt-4o-transcribe-diarize')
          body.set('chunking_strategy', 'auto');
        body.set(
          'file',
          new Blob([Uint8Array.from(audio.bytes)], { type: audio.mimeType }),
          audio.name,
        );
        const response = await request('https://api.openai.com/v1/audio/transcriptions', {
          method: 'POST',
          headers: headers(),
          body,
          signal: AbortSignal.any([AbortSignal.timeout(120_000), ...(signal ? [signal] : [])]),
        });
        const result = JSON.parse((await readResponse(response, 1024 * 1024)).toString()) as {
          text?: unknown;
          usage?: {
            type?: string;
            seconds?: number;
            input_tokens?: number;
            output_tokens?: number;
            input_token_details?: { audio_tokens?: number; text_tokens?: number };
          };
        };
        const counts = result.usage;
        const finite = (value: number | undefined) =>
          typeof value === 'number' && Number.isFinite(value) && value >= 0;
        if (
          counts?.type === 'duration' &&
          finite(counts.seconds) &&
          (model === 'gpt-transcribe' || model === 'whisper-1')
        ) {
          usage.costUsd = (counts.seconds! / 60) * (model === 'gpt-transcribe' ? 0.0045 : 0.006);
          usage.pricing = 'sdk_estimate';
        } else if (
          counts?.type === 'tokens' &&
          finite(counts.input_tokens) &&
          finite(counts.output_tokens)
        ) {
          usage.inputTokens = counts.input_tokens;
          usage.outputTokens = counts.output_tokens;
          const audio = counts.input_token_details?.audio_tokens;
          const text = counts.input_token_details?.text_tokens;
          const mini = /^gpt-4o-mini-transcribe(?:-\d{4}-\d{2}-\d{2})?$/.test(model);
          if (
            finite(audio) &&
            finite(text) &&
            (mini || model === 'gpt-4o-transcribe' || model === 'gpt-4o-transcribe-diarize')
          ) {
            usage.costUsd =
              (audio! * (mini ? 3 : 6) +
                text! * (mini ? 1.25 : 2.5) +
                counts.output_tokens! * (mini ? 5 : 10)) /
              1e6;
            usage.pricing = 'sdk_estimate';
          }
        }
        if (typeof result.text !== 'string') throw new Error('Voice transcription failed.');
        return result.text;
      });
    },
    async synthesize(text, signal, report) {
      signal?.throwIfAborted();
      const model = options.speechModel || 'gpt-4o-mini-tts';
      return measured(model, 'synthesize', signal, report, async (usage) => {
        const response = await request('https://api.openai.com/v1/audio/speech', {
          method: 'POST',
          signal: AbortSignal.any([AbortSignal.timeout(600_000), ...(signal ? [signal] : [])]),
          headers: { ...headers(), 'Content-Type': 'application/json' },
          body: JSON.stringify({
            model,
            input: text,
            voice: options.voice || 'coral',
            response_format: 'opus',
          }),
        });
        const bytes = await readResponse(response, 50 * 1024 * 1024);
        if (model === 'tts-1' || model === 'tts-1-hd') {
          usage.costUsd = (Array.from(text).length * (model === 'tts-1' ? 15 : 30)) / 1e6;
          usage.pricing = 'sdk_estimate';
        }
        signal?.throwIfAborted();
        return { bytes, mimeType: 'audio/ogg', fileName: 'reply.ogg' };
      });
    },
  };
}
