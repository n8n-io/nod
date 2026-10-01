export interface Embedder {
  id: string;
  model: string;
  configured: boolean;
  embed(texts: string[], signal?: AbortSignal): Promise<number[][]>;
}
