import { z } from 'zod';
import type { DecisionBatchRequest, DecisionModel } from '../ports/decisions.ts';
import type { ProviderUsageEvent } from '../ports/provider-usage.ts';

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
  configured?: () => boolean;
  canBatch?: () => boolean;
  resolve(): Promise<DecisionConnection | undefined>;
  fetch?: typeof fetch;
}): DecisionModel {
  const request = options.fetch ?? fetch;
  async function execute(
    { instructions, input, questions, operation }: DecisionBatchRequest,
    batch: boolean,
    signal?: AbortSignal,
    report?: (usage: ProviderUsageEvent) => void,
  ) {
    signal?.throwIfAborted();
    if (batch && options.canBatch?.() !== true)
      throw new Error('The decision service changed before the batch check.');
    if (options.configured?.() === false) {
      if (batch) throw new Error('The decision service changed before the batch check.');
      return undefined;
    }
    const connection = await options.resolve();
    signal?.throwIfAborted();
    if (
      batch &&
      (options.canBatch?.() !== true ||
        options.configured?.() === false ||
        connection?.provider !== 'openai')
    )
      throw new Error('The decision service changed before the batch check.');
    if (!connection) return undefined;
    if (!questions.length || new Set(questions.map(({ name }) => name)).size !== questions.length)
      throw new Error('The decision questions must have unique names.');
    const service = services[connection.provider];
    const id = crypto.randomUUID();
    const started = performance.now();
    let usage: z.infer<typeof usageSchema> | undefined;
    let status: 'succeeded' | 'failed' | 'cancelled' = 'failed';
    const question = questions[0]!;
    const scoped = (item: (typeof questions)[number]) =>
      item.instructions ? `${item.instructions}\n${instructions}` : instructions;
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
                questions: questions.map((item) => ({
                  type: 'choice',
                  name: item.name,
                  instructions: scoped(item),
                  choices: item.choices,
                })),
              }
            : {
                state: input,
                questions: {
                  [question.name]: {
                    type: 'choice',
                    instructions: scoped(question),
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
      const answers =
        connection.provider === 'openai'
          ? z
              .array(choiceSchema.extend({ name: z.string() }))
              .length(questions.length)
              .parse(body.answers)
          : Object.entries(
              z
                .object({ [question.name]: choiceSchema })
                .strict()
                .parse(body.answers),
            ).map(([name, answer]) => ({ name, ...answer }));
      const expected = new Map(questions.map((item) => [item.name, item]));
      const selected = new Map<string, string | boolean>();
      for (const answer of answers) {
        const item = expected.get(answer.name);
        const choice = item?.choices.find(({ value }) =>
          connection.provider === 'openai'
            ? value === answer.choice
            : String(value) === answer.choice,
        );
        if (!choice || selected.has(answer.name)) throw new Error();
        selected.set(answer.name, choice.value);
      }
      if (selected.size !== expected.size) throw new Error();
      signal?.throwIfAborted();
      status = 'succeeded';
      return Object.fromEntries(selected);
    } catch {
      status = signal?.aborted ? 'cancelled' : 'failed';
      throw new Error('The decision service could not complete the check.');
    } finally {
      report?.({
        id,
        provider: connection.provider,
        model: service.model,
        category: 'review',
        operation: { answer: 'approval_reply', access: 'access' }[operation],
        status,
        durationMs: Math.round(performance.now() - started),
        inputTokens: usage?.input_tokens,
        outputTokens: usage?.output_tokens,
        costUsd: usage ? (usage.cost ?? (usage.input_tokens * service.rate) / 1_000_000) : null,
        pricing: usage ? (usage.cost === undefined ? 'sdk_estimate' : 'reported') : 'unavailable',
      });
    }
  }
  return {
    get configured() {
      return options.configured?.() ?? true;
    },
    get checkBatch(): DecisionModel['checkBatch'] {
      return options.canBatch?.() === true
        ? (request, signal, report) => execute(request, true, signal, report)
        : undefined;
    },
    check({ instructions, input, question }, signal, report) {
      return execute(
        { instructions, input, operation: question.name, questions: [question] },
        false,
        signal,
        report,
      );
    },
  };
}
