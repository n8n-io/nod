export interface MemoryCurator {
  id: string;
  configured: boolean;
  curate(
    request: {
      task: 'reflect' | 'consolidate' | 'search' | 'review' | 'interview' | 'style' | 'plan';
      instructions: string;
      input: object;
    },
    signal?: AbortSignal,
    report?: (usage: { model: string; costUsd: number | null }) => void,
  ): Promise<unknown>;
}
