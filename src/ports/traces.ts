export interface ModelTrace {
  id: string;
  name: string;
  provider: string;
  startedAt: string;
  endedAt: string;
  messages: unknown[];
  tools: string[];
  output: unknown;
  usage: {
    inputTokens: number;
    outputTokens: number;
    totalTokens: number;
    cacheReadTokens: number;
    cacheWriteTokens: number;
    costUsd: number | null;
  };
  error?: string;
  metadata: Record<string, string>;
}

export interface ModelTraces {
  active(): boolean;
  record(trace: ModelTrace): void;
}

export type ModelTraceDelivery = (trace: ModelTrace, signal: AbortSignal) => Promise<void>;
