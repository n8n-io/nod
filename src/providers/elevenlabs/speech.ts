import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { SpeechProviderError, type SpeechProvider } from '../../ports/speech.ts';
import type { ProviderUsageEvent } from '../../ports/provider-usage.ts';
import type { SpeechVoice } from '../../shared/speech.ts';
import { readSpeechResponse } from '../speech.ts';

export class ElevenLabsConnectionError extends SpeechProviderError {}

const voiceSchema = z.object({
  voice_id: z.string().regex(/^[A-Za-z0-9_-]{1,64}$/),
  name: z.string().trim().min(1).max(120),
  description: z.string().max(4000).nullish(),
  labels: z.record(z.string(), z.string().max(500)).nullish(),
});

export async function readElevenLabsVoices(
  key: string,
  request: typeof fetch = fetch,
  signal?: AbortSignal,
): Promise<SpeechVoice[]> {
  const deadline = AbortSignal.any([AbortSignal.timeout(15_000), ...(signal ? [signal] : [])]);
  const voices = new Map<string, SpeechVoice>();
  const tokens = new Set<string>();
  let next: string | undefined;
  try {
    for (let page = 0; page < 10; page++) {
      deadline.throwIfAborted();
      const url = new URL('https://api.elevenlabs.io/v2/voices');
      url.searchParams.set('page_size', '100');
      url.searchParams.set('include_total_count', 'false');
      if (next) url.searchParams.set('next_page_token', next);
      const response = await request(url, {
        headers: { 'xi-api-key': key },
        redirect: 'error',
        signal: deadline,
      });
      if (response.status === 401 || response.status === 403) {
        await response.body?.cancel().catch(() => {});
        throw new ElevenLabsConnectionError(
          response.status === 401
            ? 'ElevenLabs didn’t accept this API key. Check it and try again.'
            : 'Give this ElevenLabs API key Voices read access, then try again.',
        );
      }
      const body = z
        .object({
          voices: z.array(z.unknown()).max(page === 0 ? 500 : 100),
          has_more: z.boolean(),
          next_page_token: z.string().min(1).max(2048).nullish(),
        })
        .parse(JSON.parse((await readSpeechResponse(response, 2 * 1024 * 1024)).toString()));
      for (const value of body.voices) {
        const parsed = voiceSchema.safeParse(value);
        if (!parsed.success) continue;
        const voice = parsed.data;
        const id = `elevenlabs-direct:${voice.voice_id}`;
        voices.set(id, {
          id,
          name: voice.name,
          description:
            voice.description?.trim().slice(0, 240) ||
            [voice.labels?.descriptive, voice.labels?.accent]
              .filter(Boolean)
              .join(' · ')
              .slice(0, 240) ||
            'Multilingual',
          engine: 'ElevenLabs',
          source: 'elevenlabs',
        });
      }
      if (!body.has_more) {
        if (!voices.size)
          throw new ElevenLabsConnectionError('Add a voice in ElevenLabs, then try again.');
        return [...voices.values()];
      }
      if (!body.next_page_token || tokens.has(body.next_page_token)) break;
      next = body.next_page_token;
      tokens.add(next);
    }
    throw new Error('Invalid voice pagination.');
  } catch (error) {
    signal?.throwIfAborted();
    if (error instanceof ElevenLabsConnectionError) throw error;
    throw new ElevenLabsConnectionError('ElevenLabs voices could not be loaded. Try again.');
  }
}

export function createElevenLabsSpeechProvider(options: {
  apiKey: () => Promise<string | undefined>;
  configured: () => boolean;
  fetch?: typeof fetch;
}): SpeechProvider {
  const request = options.fetch ?? fetch;
  let voices: SpeechVoice[] = [];
  let catalogKey: string | undefined;
  let loadedAt = 0;
  let loadGeneration = 0;
  let catalogGeneration = 0;
  async function checkResponse(response: Response, operation: 'synthesize' | 'transcribe') {
    if (![401, 403, 429].includes(response.status)) return;
    await response.body?.cancel().catch(() => {});
    throw new SpeechProviderError(
      response.status === 401
        ? 'ElevenLabs did not accept this API key. Reconnect ElevenLabs in Settings → General → Voice.'
        : response.status === 403
          ? `Give this ElevenLabs API key ${operation === 'synthesize' ? 'Text to speech' : 'Speech to text'} permission, then try again.`
          : 'ElevenLabs reached a limit. Check your ElevenLabs account before trying again.',
    );
  }
  async function key(signal?: AbortSignal) {
    signal?.throwIfAborted();
    const value = await options.apiKey();
    signal?.throwIfAborted();
    if (!value) {
      voices = [];
      catalogKey = undefined;
      throw new Error('ElevenLabs is not connected.');
    }
    return value;
  }
  async function refresh(signal?: AbortSignal, force = false) {
    const value = await key(signal);
    if (force || catalogKey !== value || Date.now() - loadedAt > 300_000) {
      const generation = ++loadGeneration;
      if (catalogKey !== value) {
        voices = [];
        catalogKey = undefined;
      }
      const loaded = await readElevenLabsVoices(value, request, signal);
      if ((await key(signal)) !== value) throw new Error('The ElevenLabs connection changed.');
      if (catalogKey !== value || generation > catalogGeneration) {
        voices = loaded;
        catalogKey = value;
        catalogGeneration = generation;
        loadedAt = Date.now();
      }
    }
    return value;
  }
  async function measured<T>(
    operation: 'synthesize' | 'transcribe',
    signal: AbortSignal | undefined,
    report: ((usage: ProviderUsageEvent) => void) | undefined,
    run: () => Promise<T>,
  ) {
    const started = Date.now();
    const usage: ProviderUsageEvent = {
      id: randomUUID(),
      provider: 'elevenlabs',
      category: 'agent',
      operation,
      model: operation === 'synthesize' ? 'eleven_v4' : 'scribe_v2',
      status: 'failed',
      durationMs: 0,
      costUsd: null,
      pricing: 'unavailable',
    };
    try {
      const result = await run();
      signal?.throwIfAborted();
      usage.status = 'succeeded';
      return result;
    } catch (error) {
      signal?.throwIfAborted();
      if (error instanceof SpeechProviderError) throw error;
      throw new Error(
        operation === 'synthesize' ? 'Speech generation failed.' : 'Voice transcription failed.',
      );
    } finally {
      if (signal?.aborted) usage.status = 'cancelled';
      usage.durationMs = Date.now() - started;
      report?.(usage);
    }
  }
  return {
    id: 'elevenlabs',
    get configured() {
      return options.configured();
    },
    get voices() {
      return options.configured() ? voices : [];
    },
    get defaultVoice() {
      return options.configured() ? voices[0]?.id : undefined;
    },
    async refreshVoices(signal, force) {
      if (options.configured()) await refresh(signal, force);
      else {
        voices = [];
        catalogKey = undefined;
      }
    },
    async synthesize(text, signal, report, synthesis) {
      const authorization = await refresh(signal);
      const selected = synthesis?.voice ?? voices[0]?.id;
      if (!voices.some((voice) => voice.id === selected))
        throw new Error('That voice is unavailable.');
      const id = selected!.slice('elevenlabs-direct:'.length);
      if ((await key(signal)) !== authorization)
        throw new Error('The ElevenLabs connection changed.');
      return measured('synthesize', signal, report, async () => {
        const response = await request(
          `https://api.elevenlabs.io/v1/text-to-speech/${id}?output_format=mp3_44100_128`,
          {
            method: 'POST',
            redirect: 'error',
            headers: { 'xi-api-key': authorization, 'Content-Type': 'application/json' },
            body: JSON.stringify({ text, model_id: 'eleven_v4' }),
            signal: AbortSignal.any([AbortSignal.timeout(120_000), ...(signal ? [signal] : [])]),
          },
        );
        await checkResponse(response, 'synthesize');
        if (
          response.ok &&
          response.headers.get('content-type')?.split(';')[0].trim() !== 'audio/mpeg'
        ) {
          await response.body?.cancel().catch(() => {});
          throw new Error('Invalid audio response.');
        }
        const bytes = await readSpeechResponse(response, 50 * 1024 * 1024, 'ElevenLabs');
        if (!bytes.length) throw new Error('Invalid audio response.');
        return { bytes, mimeType: 'audio/mpeg', fileName: 'reply.mp3' };
      });
    },
    async transcribe(audio, signal, report) {
      const authorization = await key(signal);
      return measured('transcribe', signal, report, async () => {
        const body = new FormData();
        body.set('model_id', 'scribe_v2');
        body.set('tag_audio_events', 'false');
        body.set('diarize', 'false');
        body.set('timestamps_granularity', 'none');
        body.set(
          'file',
          new Blob([Uint8Array.from(audio.bytes)], { type: audio.mimeType }),
          audio.name,
        );
        const response = await request('https://api.elevenlabs.io/v1/speech-to-text', {
          method: 'POST',
          redirect: 'error',
          headers: { 'xi-api-key': authorization },
          body,
          signal: AbortSignal.any([AbortSignal.timeout(120_000), ...(signal ? [signal] : [])]),
        });
        await checkResponse(response, 'transcribe');
        const result = z
          .object({ text: z.string().max(100_000) })
          .parse(
            JSON.parse((await readSpeechResponse(response, 1024 * 1024, 'ElevenLabs')).toString()),
          );
        return result.text;
      });
    },
  };
}
