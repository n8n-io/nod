import type { SpeechVoice } from '../shared/speech.ts';

export class SpeechProviderError extends Error {
  readonly statusCode = 400;
}

export interface SpeechSynthesisOptions {
  voice?: string;
}

export interface GeneratedAudio {
  bytes: Buffer;
  mimeType: string;
  fileName: string;
}
export interface SpeechProvider {
  id: string;
  configured: boolean;
  transcriptionConfigured?: boolean;
  voices?: readonly SpeechVoice[];
  defaultVoice?: string;
  refreshVoices?(signal?: AbortSignal, force?: boolean): Promise<void>;
  synthesize(
    text: string,
    signal?: AbortSignal,
    report?: (usage: ProviderUsageEvent) => void,
    options?: SpeechSynthesisOptions,
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

export interface LocalSpeechControls {
  prepare(signal?: AbortSignal): Promise<void>;
  prepareTranscription(signal?: AbortSignal): Promise<void>;
  status(): { state: 'not_downloaded' | 'downloading' | 'ready' | 'failed'; progress?: number };
  transcriptionStatus(): {
    state: 'not_downloaded' | 'downloading' | 'ready' | 'failed';
    progress?: number;
  };
  close(): Promise<void>;
}
