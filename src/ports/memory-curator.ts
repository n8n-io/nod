import type { ProviderUsageEvent } from './provider-usage.ts';
import type { AgentImage } from './agent.ts';

export interface MemoryCurator {
  id: string;
  configured: boolean;
  curate(
    request: {
      task:
        | 'reflect'
        | 'remember'
        | 'recall'
        | 'review'
        | 'access'
        | 'style'
        | 'skill'
        | 'plan'
        | 'brief'
        | 'vision'
        | 'classify'
        | 'activity'
        | 'attention'
        | 'check';
      instructions: string;
      input: object;
      responseSchema?: Record<string, unknown>;
      images?: AgentImage[];
      automatic?: boolean;
    },
    signal?: AbortSignal,
    report?: (
      usage: Partial<ProviderUsageEvent> & { id: string; model: string; costUsd: number | null },
    ) => void,
  ): Promise<unknown>;
}
