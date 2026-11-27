import { randomUUID } from 'node:crypto';
import { SpeechProviderError, type SpeechProvider } from '../../ports/speech.ts';
import type { ProviderUsageEvent } from '../../ports/provider-usage.ts';
import { nodFetch } from '../attribution.ts';
import { readSpeechResponse } from '../speech.ts';

type TranscriptionServer = { url: string; key?: string; model?: string };

export function createCompatibleTranscriptionProvider(options: {
  connection: () => Promise<TranscriptionServer | undefined>;
  configured: () => boolean;
  fetch?: typeof fetch;
}) {
  const request = options.fetch ?? nodFetch;
  const transcribe: NonNullable<SpeechProvider['transcribe']> = async (audio, signal, report) => {
    signal?.throwIfAborted();
    const server = await options.connection();
    if (!server) throw new Error('Voice transcription is not configured.');
    signal?.throwIfAborted();
    const started = Date.now();
    const model = server.model || 'whisper-1';
    const usage: ProviderUsageEvent = {
      id: randomUUID(),
      provider: 'compatible-speech',
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
      const response = await request(`${server.url}/audio/transcriptions`, {
        method: 'POST',
        redirect: 'error',
        headers: server.key ? { Authorization: `Bearer ${server.key}` } : {},
        body,
        signal,
      }).catch((error: unknown) => {
        if (signal?.aborted) throw error;
        throw new SpeechProviderError(
          'Your transcription server did not answer. Check that it is running.',
        );
      });
      const result = JSON.parse(
        (
          await readSpeechResponse(response, 1024 * 1024, 'Your transcription server', [
            server.url,
            server.key ?? '',
          ])
        ).toString(),
      ) as { text?: unknown };
      if (typeof result.text !== 'string') throw new Error('Voice transcription failed.');
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
