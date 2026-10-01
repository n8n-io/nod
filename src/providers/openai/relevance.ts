import { z } from 'zod';
import { openaiProvider } from '@earendil-works/pi-ai/providers/openai';
import type { RelevanceClassifier } from '../../ports/relevance.ts';
import { relevanceModel } from '../../shared/model-defaults.ts';

export function createOpenAIRelevanceClassifier(options: {
  apiKey?: string;
  model?: string;
  fetch?: typeof fetch;
}): RelevanceClassifier {
  const request = options.fetch ?? fetch;
  const model = options.model || relevanceModel;
  const capabilities = openaiProvider()
    .getModels()
    .find((entry) => entry.id === model);
  const reasoningOff = capabilities?.reasoning && capabilities.thinkingLevelMap?.off === 'none';
  const parameters = reasoningOff
    ? { reasoning_effort: 'none', temperature: 0 }
    : capabilities?.reasoning === false
      ? { temperature: 0 }
      : {};
  return {
    id: 'openai',
    configured: Boolean(options.apiKey),
    async classify(context, policy, signal) {
      signal?.throwIfAborted();
      if (!options.apiKey) throw new Error('Relevance check is not configured.');
      const response = await request('https://api.openai.com/v1/chat/completions', {
        method: 'POST',
        signal: AbortSignal.any([AbortSignal.timeout(10000), ...(signal ? [signal] : [])]),
        headers: { Authorization: `Bearer ${options.apiKey}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          model,
          ...parameters,
          max_completion_tokens: 256,
          response_format: { type: 'json_object' },
          messages: [
            {
              role: 'system',
              content: `Return JSON {"decision":"ignore"|"digest"|"wake","confidence":0.0}. ${policy.instructions} Decision criteria: ${JSON.stringify(policy.criteria)}`,
            },
            { role: 'user', content: JSON.stringify(context) },
          ],
        }),
      });
      if (!response.ok) throw new Error('Relevance check unavailable.');
      const data = (await response.json()) as {
        choices?: Array<{ message?: { content?: string } }>;
      };
      const answer = z
        .object({
          decision: z.enum(['ignore', 'digest', 'wake']),
          confidence: z.number().min(0).max(1),
        })
        .parse(JSON.parse(data.choices?.[0]?.message?.content || '{}'));
      return answer.decision === 'wake' && answer.confidence < policy.minWakeConfidence
        ? 'digest'
        : answer.decision;
    },
  };
}
