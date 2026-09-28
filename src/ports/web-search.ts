export interface WebSearch {
  (
    query: string,
    signal: AbortSignal,
  ): Promise<{
    source: string;
    answer?: string;
    results: Array<{ title: string; url: string; snippet: string }>;
  }>;
}
