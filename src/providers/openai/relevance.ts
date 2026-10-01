import { z } from 'zod';
import type { RelevanceClassifier } from '../../ports/relevance.ts';
import { createJsonCompletion } from './json-completion.ts';

export function createOpenAIRelevanceClassifier(options: {
  apiKey?: string;
  model?: string;
  fetch?: typeof fetch;
}): RelevanceClassifier {
  const complete = createJsonCompletion(options);
  return {
    id: 'openai',
    configured: Boolean(options.apiKey),
    async classify(context, policy, signal) {
      const answer = z
        .object({
          decision: z.enum(['ignore', 'digest', 'wake']),
          confidence: z.number().min(0).max(1),
        })
        .parse(
          await complete({
            instructions: `Return JSON {"decision":"ignore"|"digest"|"wake","confidence":0.0}. ${policy.instructions} Decision criteria: ${JSON.stringify(policy.criteria)}`,
            input: context,
            maxTokens: 256,
            timeoutMs: 10000,
            signal,
          }),
        );
      return answer.decision === 'wake' && answer.confidence < policy.minWakeConfidence
        ? 'digest'
        : answer.decision;
    },
  };
}
