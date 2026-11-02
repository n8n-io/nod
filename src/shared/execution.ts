export interface ExecutionScope {
  threadId: string;
  sessionId: string;
  turnId: string;
  runId: string;
  parentRunId?: string;
  browserId: string;
}

export interface ExecutionEvent {
  execution: ExecutionScope;
  callId?: string;
  site?: string;
}

export interface UsageDetails {
  provider: string;
  category: 'agent' | 'memory' | 'review' | 'tasks' | 'task_classification';
  operation: string;
  model?: string;
  status: 'succeeded' | 'failed' | 'cancelled';
  durationMs: number;
  inputTokens?: number;
  outputTokens?: number;
  cacheReadTokens?: number;
  cacheWriteTokens?: number;
  costUsd?: number | null;
  estimateUsd?: number | null;
  pricing?: 'reported' | 'sdk_estimate' | 'unavailable';
}
