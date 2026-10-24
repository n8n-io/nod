import { z } from 'zod';
import type { GeneratedAudio, SpeechProvider } from '../ports/speech.ts';
import type { ProviderUsageEvent } from '../ports/provider-usage.ts';
import { spendingLimitReached } from './ledger.ts';

export class TranscriptionLengthError extends Error {}
export class SpeechSetupError extends Error {}

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
          .parse(await provider.transcribe(audio, signal, report));
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
    async synthesize(input: string, signal?: AbortSignal): Promise<GeneratedAudio> {
      available(signal);
      const text = z.string().trim().min(1).max(4096).parse(input);
      try {
        const result = await provider.synthesize(text, signal);
        signal?.throwIfAborted();
        if (
          !Buffer.isBuffer(result.bytes) ||
          !result.bytes.length ||
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
