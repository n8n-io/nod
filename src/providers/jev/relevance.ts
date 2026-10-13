import { z } from 'zod';
import type { RelevanceClassifier } from '../../ports/relevance.ts';

export function createJevRelevanceClassifier(options: {
  apiKey?: string;
  model?: string;
  fetch?: typeof fetch;
}): RelevanceClassifier {
  const request = options.fetch ?? fetch;
  return {
    id: 'jev',
    configured: Boolean(options.apiKey),
    async classify(context, policy, signal) {
      signal?.throwIfAborted();
      if (!options.apiKey) throw new Error('Relevance check is not configured.');
      const response = await request('https://api.typesafe.ai/v1/systemone', {
        method: 'POST',
        signal: AbortSignal.any([AbortSignal.timeout(30_000), ...(signal ? [signal] : [])]),
        headers: { Authorization: `Bearer ${options.apiKey}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          model: options.model || 'jev-latest',
          state: JSON.stringify(context),
          questions: {
            action: {
              type: 'choice',
              instructions: policy.instructions,
              criteria: policy.criteria,
            },
          },
        }),
      });
      if (!response.ok) throw new Error('Relevance check unavailable.');
      const result = z
        .object({
          answers: z.object({
            action: z.object({
              choice: z.enum(['ignore', 'digest', 'wake']),
              confidence: z.number().min(0).max(1),
            }),
          }),
        })
        .parse(await response.json());
      const answer = result.answers.action;
      return answer.choice === 'wake' && answer.confidence < policy.minWakeConfidence
        ? 'digest'
        : answer.choice;
    },
  };
}
