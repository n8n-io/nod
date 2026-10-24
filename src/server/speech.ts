import { z } from 'zod';
import type { GeneratedAudio, SpeechProvider, SpeechSynthesisOptions } from '../ports/speech.ts';
import type { ProviderUsageEvent } from '../ports/provider-usage.ts';
import { spendingLimitReached } from './ledger.ts';

export class TranscriptionLengthError extends Error {}
export class SpeechSetupError extends Error {}

function cancellable<T>(work: Promise<T>, signal?: AbortSignal): Promise<T> {
  if (!signal) return work;
  return new Promise((resolve, reject) => {
    const stop = () => reject(signal.reason ?? new DOMException('Speech stopped.', 'AbortError'));
    signal.addEventListener('abort', stop, { once: true });
    if (signal.aborted) stop();
    work.then(resolve, reject).finally(() => signal.removeEventListener('abort', stop));
  });
}

export function createSpeech(provider: SpeechProvider) {
  function available(signal?: AbortSignal, transcribing = false) {
    signal?.throwIfAborted();
    if (
      !(transcribing
        ? (provider.transcriptionConfigured ?? provider.configured)
        : provider.configured)
    )
      throw Object.assign(new SpeechSetupError('Speech is not configured.'), { statusCode: 503 });
  }
  return {
    get configured() {
      return provider.configured;
    },
    get transcriptionConfigured() {
      return (
        (provider.transcriptionConfigured ?? provider.configured) && Boolean(provider.transcribe)
      );
    },
    get voices() {
      return provider.voices ?? [];
    },
    get defaultVoice() {
      return provider.defaultVoice;
    },
    async transcribe(
      audio: { bytes: Uint8Array; mimeType: string; name: string },
      signal?: AbortSignal,
      report?: (usage: ProviderUsageEvent) => void,
    ) {
      available(signal, true);
      if (!provider.transcribe) throw new Error('Voice transcription is not configured.');
      if (
        !audio.bytes.length ||
        audio.bytes.length > 25 * 1024 * 1024 ||
        !audio.mimeType.startsWith('audio/')
      )
        throw new Error('The voice message cannot be transcribed.');
      try {
        const text = z
          .string()
          .trim()
          .min(1)
          .parse(await cancellable(provider.transcribe(audio, signal, report), signal));
        if (text.length > 100_000) throw new TranscriptionLengthError();
        signal?.throwIfAborted();
        return text;
      } catch (error) {
        signal?.throwIfAborted();
        if (
          error instanceof TranscriptionLengthError ||
          (error instanceof Error && error.message === spendingLimitReached)
        )
          throw error;
        throw new Error('Voice transcription failed.');
      }
    },
    async synthesize(
      input: string,
      signal?: AbortSignal,
      options?: SpeechSynthesisOptions,
    ): Promise<GeneratedAudio> {
      available(signal);
      const text = z.string().trim().min(1).max(4096).parse(input);
      try {
        const result = await cancellable(
          provider.synthesize(text, signal, undefined, options),
          signal,
        );
        signal?.throwIfAborted();
        if (
          !Buffer.isBuffer(result.bytes) ||
          !result.bytes.length ||
          result.bytes.length > 50 * 1024 * 1024 ||
          !/^audio\/(mpeg|wav|webm|ogg|mp4)$/.test(result.mimeType) ||
          !/^[\w.-]{1,100}$/.test(result.fileName)
        ) {
          throw new Error('Invalid audio response.');
        }
        return result;
      } catch (error) {
        signal?.throwIfAborted();
        if (error instanceof Error && error.message === spendingLimitReached) throw error;
        throw new Error('Speech generation failed.');
      }
    },
  };
}
export type SpeechService = ReturnType<typeof createSpeech>;
