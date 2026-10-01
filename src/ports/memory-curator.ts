export interface MemoryCurator {
  id: string;
  configured: boolean;
  curate(
    request: { task: 'reflect' | 'consolidate' | 'search'; instructions: string; input: object },
    signal?: AbortSignal,
  ): Promise<unknown>;
}
