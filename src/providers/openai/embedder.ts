import { z } from 'zod';
import type { Embedder } from '../../ports/embedder.ts';
import { embeddingModel } from '../../shared/model-defaults.ts';

const dimensions = 256;
const response = z.object({
  data: z.array(z.object({ index: z.number(), embedding: z.array(z.number()) })),
});

export function createOpenAIEmbedder(options: {
  apiKey?: string;
  model?: string;
  fetch?: typeof fetch;
}): Embedder {
  const request = options.fetch ?? fetch;
  const model = options.model || embeddingModel;
  return {
    id: 'openai',
    model,
    configured: Boolean(options.apiKey),
    async embed(texts, signal) {
      signal?.throwIfAborted();
      if (!options.apiKey) throw new Error('Embeddings are not configured.');
      const reply = await request('https://api.openai.com/v1/embeddings', {
        method: 'POST',
        signal: AbortSignal.any([AbortSignal.timeout(15000), ...(signal ? [signal] : [])]),
        headers: { Authorization: `Bearer ${options.apiKey}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          model,
          input: texts,
          ...(model.startsWith('text-embedding-3') ? { dimensions } : {}),
        }),
      });
      if (!reply.ok) throw new Error('Embeddings are unavailable.');
      const vectors = response
        .parse(await reply.json())
        .data.toSorted((a, b) => a.index - b.index)
        .map((item) => item.embedding);
      if (vectors.length !== texts.length) throw new Error('Embeddings are unavailable.');
      return vectors;
    },
  };
}
