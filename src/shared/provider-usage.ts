export type ProviderCategory =
  | 'agent'
  | 'relevance'
  | 'memory'
  | 'review'
  | 'tasks'
  | 'browser'
  | 'integration'
  | 'speech'
  | 'channel'
  | 'workspace';
export type UsagePricing = 'reported' | 'sdk_estimate' | 'mixed' | 'unavailable';

export interface ProviderUsageSummary {
  provider: string;
  category: ProviderCategory;
  operation: string;
  model: string | null;
  requests: number;
  failures: number;
  cancelled: number;
  durationMs: number;
  inputTokens: number | null;
  outputTokens: number | null;
  cacheReadTokens: number | null;
  cacheWriteTokens: number | null;
  audioSeconds: number | null;
  characters: number | null;
  messages: number | null;
  bytes: number | null;
  costUsd: number | null;
  pricedRequests: number;
  pricing: UsagePricing;
  lastRecordedAt: string;
}

export interface ProviderUsageResponse {
  scope: 'turn' | 'owner';
  turnId?: string;
  retentionDays: number;
  captureEnabled: boolean;
  droppedEvents: number;
  providers: ProviderUsageSummary[];
  coverage: Array<{
    provider: string;
    category: ProviderCategory;
    status: 'recorded' | 'unsupported';
    note: string;
  }>;
}
