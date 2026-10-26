import { z } from 'zod';
import {
  SpeechProviderError,
  type GeneratedAudio,
  type SpeechProvider,
  type SpeechSynthesisOptions,
} from '../ports/speech.ts';
import type { ProviderUsageEvent } from '../ports/provider-usage.ts';
import { spendingLimitReached } from './ledger.ts';

export class TranscriptionLengthError extends SpeechProviderError {
  constructor() {
    super('This voice message is too long. Record a shorter message.');
  }
}
export class SpeechSetupError extends SpeechProviderError {}

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
      throw new SpeechSetupError(
        'Set up audio in Settings → General → Voice. Choose free voices or connect a voice service.',
      );
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
    async refreshVoices(signal?: AbortSignal, force = false) {
      signal?.throwIfAborted();
      await cancellable(provider.refreshVoices?.(signal, force) ?? Promise.resolve(), signal);
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
          .parse(await cancellable(provider.transcribe(audio, signal, report), signal));
        if (!text)
          throw new SpeechProviderError(
            'No speech was detected. Check your microphone and record again.',
          );
        if (text.length > 100_000) throw new TranscriptionLengthError();
        signal?.throwIfAborted();
        return text;
      } catch (error) {
        signal?.throwIfAborted();
        if (
          error instanceof TranscriptionLengthError ||
          error instanceof SpeechProviderError ||
          (error instanceof Error && error.message === spendingLimitReached)
        )
          throw error;
        throw new SpeechProviderError(
          'The recording could not be transcribed. Try again or send a text message.',
        );
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
        if (
          error instanceof SpeechProviderError ||
          (error instanceof Error && error.message === spendingLimitReached)
        )
          throw error;
        throw new SpeechProviderError(
          'Audio could not be generated. Try again or choose another voice.',
        );
      }
    },
  };
}
export type SpeechService = ReturnType<typeof createSpeech>;
