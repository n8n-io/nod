export interface ProviderUsageEvent {
  id?: string;
  provider: string;
  category: 'agent' | 'memory' | 'review' | 'tasks';
  operation: string;
  model?: string;
  turnId?: string;
  status: 'succeeded' | 'failed' | 'cancelled';
  durationMs: number;
  inputTokens?: number;
  outputTokens?: number;
  cacheReadTokens?: number;
  cacheWriteTokens?: number;
  costUsd?: number | null;
  pricing?: 'reported' | 'sdk_estimate' | 'unavailable';
}
