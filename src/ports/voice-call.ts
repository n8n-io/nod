import type { ProviderUsageEvent } from './provider-usage.ts';

export type VoiceCallEvent =
  | { type: 'heard'; text: string; startMs: number; endMs: number }
  | { type: 'handoff'; id: string; atMs: number }
  | { type: 'error'; error: Error }
  | { type: 'closed'; reason: string };

export interface VoiceCall {
  id: string;
  sdp: string;
  events: AsyncIterable<VoiceCallEvent>;
  say(text: string, handoffId?: string): void;
  close(): Promise<void>;
}

export interface VoiceCallProvider {
  configured: boolean;
  start(
    input: {
      sdp: string;
      instructions: string;
      greeting?: string;
      voice?: string;
      signal?: AbortSignal;
    },
    report?: (usage: ProviderUsageEvent) => void,
  ): Promise<VoiceCall>;
}
