import { z } from 'zod';
import type { GeneratedAudio, SpeechProvider } from '../ports/speech.ts';

export function createSpeech(provider: SpeechProvider) {
  function available(signal?: AbortSignal) {
    signal?.throwIfAborted();
    if (!provider.configured)
      throw Object.assign(new Error('Speech is not configured.'), { statusCode: 503 });
  }
  return {
    async transcribe(
      audio: { bytes: Uint8Array; mimeType: string; name: string },
      signal?: AbortSignal,
    ) {
      available(signal);
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
          .max(100_000)
          .parse(await provider.transcribe(audio, signal));
        signal?.throwIfAborted();
        return text;
      } catch {
        signal?.throwIfAborted();
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
      } catch {
        signal?.throwIfAborted();
        throw new Error('Speech generation failed.');
      }
    },
  };
}
export type SpeechService = ReturnType<typeof createSpeech>;
