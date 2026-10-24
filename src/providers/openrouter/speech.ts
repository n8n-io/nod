import { randomUUID } from 'node:crypto';
import type { SpeechProvider } from '../../ports/speech.ts';
import type { ProviderUsageEvent } from '../../ports/provider-usage.ts';
import { readSpeechResponse } from '../speech.ts';

export function createOpenRouterTranscriptionProvider(options: {
  apiKey: () => Promise<string | undefined>;
  configured: () => boolean;
  model?: string;
  fetch?: typeof fetch;
}) {
  const request = options.fetch ?? fetch;
  const transcribe: NonNullable<SpeechProvider['transcribe']> = async (audio, signal, report) => {
    signal?.throwIfAborted();
    const key = await options.apiKey();
    if (!key) throw new Error('Voice transcription is not configured.');
    signal?.throwIfAborted();
    const started = Date.now();
    const model = options.model || 'openai/gpt-transcribe';
    const usage: ProviderUsageEvent = {
      id: randomUUID(),
      provider: 'openrouter',
      category: 'agent',
      operation: 'transcribe',
      model,
      status: 'failed',
      durationMs: 0,
      costUsd: null,
      pricing: 'unavailable',
    };
    try {
      const body = new FormData();
      body.set('model', model);
      body.set('response_format', 'json');
      body.set(
        'file',
        new Blob([Uint8Array.from(audio.bytes)], { type: audio.mimeType }),
        audio.name,
      );
      const response = await request('https://openrouter.ai/api/v1/audio/transcriptions', {
        method: 'POST',
        redirect: 'error',
        headers: { Authorization: `Bearer ${key}` },
        body,
        signal: AbortSignal.any([AbortSignal.timeout(120_000), ...(signal ? [signal] : [])]),
      });
      const result = JSON.parse((await readSpeechResponse(response, 1024 * 1024)).toString()) as {
        text?: unknown;
        usage?: { cost?: number; input_tokens?: number; output_tokens?: number };
      };
      if (typeof result.text !== 'string') throw new Error('Voice transcription failed.');
      const counts = result.usage;
      if (typeof counts?.cost === 'number' && Number.isFinite(counts.cost) && counts.cost >= 0) {
        usage.costUsd = counts.cost;
        usage.pricing = 'reported';
      }
      if (Number.isSafeInteger(counts?.input_tokens) && counts!.input_tokens! >= 0)
        usage.inputTokens = counts!.input_tokens;
      if (Number.isSafeInteger(counts?.output_tokens) && counts!.output_tokens! >= 0)
        usage.outputTokens = counts!.output_tokens;
      signal?.throwIfAborted();
      usage.status = 'succeeded';
      return result.text;
    } finally {
      if (signal?.aborted) usage.status = 'cancelled';
      usage.durationMs = Date.now() - started;
      report?.(usage);
    }
  };
  return {
    get configured() {
      return options.configured();
    },
    transcribe,
  };
}
