export interface GeneratedAudio {
  bytes: Buffer;
  mimeType: string;
  fileName: string;
}
export interface SpeechProvider {
  id: string;
  configured: boolean;
  transcriptionConfigured?: boolean;
  synthesize(
    text: string,
    signal?: AbortSignal,
    report?: (usage: ProviderUsageEvent) => void,
  ): Promise<GeneratedAudio>;
  transcribe?(
    audio: {
      bytes: Uint8Array;
      mimeType: string;
      name: string;
    },
    signal?: AbortSignal,
    report?: (usage: ProviderUsageEvent) => void,
  ): Promise<string>;
}
import type { ProviderUsageEvent } from './provider-usage.ts';
