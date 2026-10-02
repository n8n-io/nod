import type { ProviderCategory } from '../shared/provider-usage.ts';

export interface ProviderUsageEvent {
  id?: string;
  provider: string;
  category: ProviderCategory;
  operation: string;
  model?: string;
  turnId?: string;
  toolCallId?: string;
  toolName?: string;
  status: 'succeeded' | 'failed' | 'cancelled';
  durationMs: number;
  inputTokens?: number;
  outputTokens?: number;
  cacheReadTokens?: number;
  cacheWriteTokens?: number;
  audioSeconds?: number;
  characters?: number;
  messages?: number;
  bytes?: number;
  costUsd?: number | null;
  pricing?: 'reported' | 'sdk_estimate' | 'unavailable';
}
