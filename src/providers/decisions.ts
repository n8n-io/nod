import { z } from 'zod';
import type { DecisionModel } from '../ports/decisions.ts';

export type DecisionConnection = {
  provider: 'openai' | 'openrouter' | 'typesafe';
  key: string;
};

const services = {
  openai: { url: 'https://api.openai.com/v1/decisions', model: 'gpt-6-luna', rate: 0.1 },
  openrouter: {
    url: 'https://openrouter.ai/api/alpha/decisions',
    model: 'typesafe/jev-1.13',
    rate: 0.042,
  },
  typesafe: {
    url: 'https://api.typesafe.ai/v1/systemone',
    model: 'jev-1.13.0',
    rate: 0.042,
  },
};
const usageSchema = z.object({
  input_tokens: z.number().int().nonnegative(),
  output_tokens: z.number().int().nonnegative().default(0),
  cost: z.number().nonnegative().optional(),
});
const choiceSchema = z.object({
  type: z.literal('choice'),
  choice: z.union([z.string(), z.boolean()]),
});

export function createDecisionModel(options: {
  resolve(): Promise<DecisionConnection | undefined>;
  fetch?: typeof fetch;
}): DecisionModel {
  const request = options.fetch ?? fetch;
  return {
    async check({ instructions, input, question }, signal, report) {
      signal?.throwIfAborted();
      const connection = await options.resolve();
      if (!connection) return undefined;
      if (question.instructions) instructions = `${question.instructions}\n${instructions}`;
      const service = services[connection.provider];
      const id = crypto.randomUUID();
      const started = performance.now();
      let usage: z.infer<typeof usageSchema> | undefined;
      let status: 'succeeded' | 'failed' | 'cancelled' = 'failed';
      try {
        const response = await request(service.url, {
          method: 'POST',
          redirect: 'error',
          headers: {
            authorization: `Bearer ${connection.key}`,
            'content-type': 'application/json',
          },
          signal: AbortSignal.any([AbortSignal.timeout(45_000), ...(signal ? [signal] : [])]),
          body: JSON.stringify({
            model: service.model,
            ...(connection.provider === 'openai'
              ? {
                  input: JSON.stringify(input),
                  questions: [
                    {
                      type: 'choice',
                      name: question.name,
                      instructions,
                      choices: question.choices,
                    },
                  ],
                }
              : {
                  state: input,
                  questions: {
                    [question.name]: {
                      type: 'choice',
                      instructions,
                      criteria: Object.fromEntries(
                        question.choices.map(({ value, description }) => [
                          String(value),
                          description,
                        ]),
                      ),
                    },
                  },
                }),
          }),
        });
        if (!response.ok) throw new Error();
        const body = z
          .object({ answers: z.unknown(), usage: usageSchema })
          .parse(await response.json());
        usage = body.usage;
        const answer =
          connection.provider === 'openai'
            ? z
                .array(choiceSchema.extend({ name: z.literal(question.name) }))
                .length(1)
                .parse(body.answers)[0]!
            : z
                .object({ [question.name]: choiceSchema })
                .strict()
                .parse(body.answers)[question.name];
        const selected = question.choices.find(({ value }) =>
          connection.provider === 'openai'
            ? value === answer?.choice
            : String(value) === answer?.choice,
        );
        if (!selected) throw new Error();
        signal?.throwIfAborted();
        status = 'succeeded';
        return { [question.name]: selected.value };
      } catch {
        status = signal?.aborted ? 'cancelled' : 'failed';
        throw new Error('The decision service could not complete the check.');
      } finally {
        report?.({
          id,
          provider: connection.provider,
          model: service.model,
          category: 'review',
          operation: { run: 'action_check', answer: 'approval_reply', valid: 'confirmation_check' }[
            question.name
          ],
          status,
          durationMs: Math.round(performance.now() - started),
          inputTokens: usage?.input_tokens,
          outputTokens: usage?.output_tokens,
          costUsd: usage ? (usage.cost ?? (usage.input_tokens * service.rate) / 1_000_000) : null,
          pricing: usage ? (usage.cost === undefined ? 'sdk_estimate' : 'reported') : 'unavailable',
        });
      }
    },
  };
}
