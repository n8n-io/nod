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
        | 'review'
        | 'access'
        | 'interview'
        | 'style'
        | 'skill'
        | 'plan'
        | 'brief'
        | 'analytics'
        | 'vision';
      instructions: string;
      input: object;
      images?: AgentImage[];
    },
    signal?: AbortSignal,
    report?: (
      usage: Partial<ProviderUsageEvent> & { id: string; model: string; costUsd: number | null },
    ) => void,
  ): Promise<unknown>;
}
