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
}

export interface UsageDetails {
  provider: string;
  category: 'agent' | 'memory' | 'review' | 'tasks';
  operation: string;
  model?: string;
  status: 'succeeded' | 'failed' | 'cancelled';
  durationMs: number;
  inputTokens?: number;
  outputTokens?: number;
  cacheReadTokens?: number;
  cacheWriteTokens?: number;
  costUsd?: number | null;
  pricing?: 'reported' | 'sdk_estimate' | 'unavailable';
}

export interface ExecutionReport {
  turnId: string;
  events: Array<{
    id: string;
    runId: string | null;
    parentRunId: string | null;
    sessionId: string | null;
    browserId: string | null;
    callId: string | null;
    type: string;
    summary: string;
    createdAt: string;
  }>;
  usage: Array<
    UsageDetails & {
      id: string;
      runId: string | null;
      parentRunId: string | null;
      sessionId: string | null;
      browserId: string | null;
      costUsd: number | null;
      createdAt: string;
    }
  >;
}
