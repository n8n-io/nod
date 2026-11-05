import { z } from 'zod';
import type { DecisionModel, DecisionQuestion } from '../ports/decisions.ts';

export type DecisionConnection = {
  provider: 'openai' | 'openrouter' | 'typesafe';
  key: string;
  model?: string;
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
  input_tokens_details: z
    .object({
      cached_tokens: z.number().int().nonnegative().default(0),
      cache_write_tokens: z.number().int().nonnegative().default(0),
    })
    .optional(),
});
const choiceSchema = z.object({
  type: z.literal('choice'),
  choice: z.union([z.string(), z.boolean()]),
  probabilities: z.unknown().optional(),
});
const answerSchema = z.union([
  choiceSchema,
  z.object({ type: z.literal('noul'), noul: z.number().min(0).max(1) }),
  z.object({ type: z.literal('predicate'), probability: z.number().min(0).max(1) }),
  z.object({ type: z.literal('refusal') }),
]);

export function createOpenRouterDecisionCatalog() {
  let cached: { key: string; until: number; models: Set<string> } | undefined;
  return async (key: string, signal?: AbortSignal) => {
    signal?.throwIfAborted();
    if (cached?.key === key && cached.until > Date.now()) return cached.models;
    const response = await fetch(
      'https://openrouter.ai/api/v1/models/user?output_modalities=decisions',
      {
        redirect: 'error',
        headers: { authorization: `Bearer ${key}` },
        signal: AbortSignal.any([AbortSignal.timeout(10_000), ...(signal ? [signal] : [])]),
      },
    );
    if (!response.ok) throw new Error('The decision model list is unavailable.');
    const { data } = z
      .object({
        data: z.array(
          z.object({
            id: z.string(),
            architecture: z.object({
              input_modalities: z.array(z.string()),
              output_modalities: z.array(z.string()),
            }),
            endpoints: z.array(z.string()),
          }),
        ),
      })
      .parse(await response.json());
    signal?.throwIfAborted();
    const models = new Set(
      data
        .filter(
          ({ architecture, endpoints }) =>
            architecture.input_modalities.includes('text') &&
            architecture.output_modalities.includes('decisions') &&
            endpoints.includes('/api/alpha/decisions'),
        )
        .map(({ id }) => id),
    );
    cached = { key, until: Date.now() + 300_000, models };
    return models;
  };
}

function select(
  question: DecisionQuestion,
  answer: z.infer<typeof answerSchema>,
  provider: DecisionConnection['provider'],
) {
  if (answer.type === 'refusal') return { refused: true };
  if (question.format === 'predicate') {
    if (!(
      (provider === 'openai' && answer.type === 'predicate') ||
      (provider !== 'openai' && answer.type === 'noul')
    ))
      throw new Error();
    const value = answer.type === 'predicate' ? answer.probability : answer.noul;
    const choice = value >= 0.5;
    const probability = choice ? value : 1 - value;
    return {
      [question.name]:
        probability < (question.minProbability ?? 0) ? question.uncertainValue : choice,
      choice,
      probability,
    };
  }
  if (answer.type !== 'choice') throw new Error();
  const selected = question.choices.find(({ value }) =>
    provider === 'openai' ? value === answer.choice : String(value) === answer.choice,
  );
  if (!selected) throw new Error();
  if (question.minProbability === undefined) return { [question.name]: selected.value };
  const probability = z.number().min(0).max(1);
  const entries =
    provider === 'openai'
      ? z
          .array(z.object({ value: z.union([z.string(), z.boolean()]), probability }))
          .parse(answer.probabilities)
          .map(({ value, probability }) => [String(value), probability] as const)
      : Object.entries(z.record(z.string(), probability).parse(answer.probabilities));
  const values = question.choices.map(({ value }) => String(value));
  if (
    entries.length !== values.length ||
    new Set(entries.map(([value]) => value)).size !== values.length ||
    entries.some(([value]) => !values.includes(value)) ||
    Math.abs(entries.reduce((sum, [, value]) => sum + value, 0) - 1) > 0.001
  )
    throw new Error();
  const chosen = entries.find(([value]) => value === String(selected.value))?.[1];
  if (chosen === undefined || entries.some(([, value]) => value > chosen)) throw new Error();
  return {
    [question.name]: chosen < question.minProbability ? question.uncertainValue : selected.value,
    choice: selected.value,
    probability: chosen,
    probabilities: Object.fromEntries(entries),
  };
}

export function createDecisionModel(options: {
  configured?: () => boolean;
  resolve(signal?: AbortSignal): Promise<DecisionConnection | undefined>;
  fetch?: typeof fetch;
}): DecisionModel {
  const request = options.fetch ?? fetch;
  return {
    get configured() {
      return options.configured?.();
    },
    async select(signal) {
      signal?.throwIfAborted();
      if (options.configured?.() === false) return undefined;
      const connection = await options.resolve(signal);
      signal?.throwIfAborted();
      if (options.configured?.() === false)
        throw new Error('The decision model connection changed.');
      return connection
        ? createDecisionModel({ ...options, resolve: async () => connection })
        : undefined;
    },
    async check(plan, signal, report) {
      signal?.throwIfAborted();
      if (options.configured?.() === false) return undefined;
      const connection = await options.resolve(signal);
      signal?.throwIfAborted();
      if (!connection || options.configured?.() === false) return undefined;
      const service = services[connection.provider];
      const model = connection.model ?? service.model;
      const {
        instructions,
        input,
        question,
        additionalQuestions = [],
        includeModel,
      } = plan.forModel?.({ provider: connection.provider, model }) ?? plan;
      signal?.throwIfAborted();
      const questions = [question, ...additionalQuestions];
      if (new Set(questions.map(({ name }) => name)).size !== questions.length)
        throw new Error('Decision question names must be unique.');
      if (
        questions.some(
          (item) =>
            !item.name ||
            (item.format === 'predicate' &&
              (item.choices.length !== 2 ||
                !item.choices.some(({ value }) => value === true) ||
                !item.choices.some(({ value }) => value === false))),
        )
      )
        throw new Error('Decision predicates must have both boolean choices.');
      const describe = (item: DecisionQuestion, index: number) =>
        index === 0 && item.instructions
          ? `${item.instructions}\n${instructions}`
          : (item.instructions ?? instructions);
      const priced =
        model === service.model ||
        (connection.provider === 'typesafe' && model === 'jev-1.14.0') ||
        (connection.provider === 'openrouter' && model === 'typesafe/jev-1.14');
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
            model,
            ...(connection.provider === 'openrouter'
              ? { provider: { allow_fallbacks: false } }
              : {}),
            ...(connection.provider === 'openai'
              ? {
                  input: JSON.stringify(input),
                  questions: questions.map((item, index) => ({
                    type: item.format === 'predicate' ? 'predicate' : 'choice',
                    name: item.name,
                    instructions: describe(item, index),
                    ...(item.format === 'predicate' ? {} : { choices: item.choices }),
                  })),
                }
              : {
                  state: input,
                  questions: Object.fromEntries(
                    questions.map((item, index) => [
                      item.name,
                      {
                        type: item.format === 'predicate' ? 'noul' : 'choice',
                        instructions: describe(item, index),
                        ...(item.format === 'predicate'
                          ? {}
                          : {
                              criteria: Object.fromEntries(
                                item.choices.map(({ value, description }) => [
                                  String(value),
                                  description,
                                ]),
                              ),
                            }),
                      },
                    ]),
                  ),
                }),
          }),
        });
        if (!response.ok) throw new Error();
        const body = z
          .object({
            answers: z.unknown(),
            usage: usageSchema,
            model: z.unknown().optional(),
          })
          .parse(await response.json());
        usage = body.usage;
        const answers =
          connection.provider === 'openai'
            ? z
                .array(z.intersection(answerSchema, z.object({ name: z.string() })))
                .length(questions.length)
                .parse(body.answers)
            : Object.entries(
                z
                  .object(Object.fromEntries(questions.map(({ name }) => [name, answerSchema])))
                  .strict()
                  .parse(body.answers),
              ).map(([name, answer]) => ({ ...answer, name }));
        if (
          new Set(answers.map(({ name }) => name)).size !== questions.length ||
          answers.some(({ name }) => !questions.some((item) => item.name === name))
        )
          throw new Error();
        const selected = questions.map((item) =>
          select(
            item,
            answers.find(({ name }) => name === item.name)!,
            connection.provider,
          ),
        );
        if (
          connection.provider === 'openai' &&
          (usage.input_tokens_details?.cached_tokens ?? 0) +
            (usage.input_tokens_details?.cache_write_tokens ?? 0) >
            usage.input_tokens
        )
          throw new Error();
        signal?.throwIfAborted();
        status = 'succeeded';
        return {
          ...selected[0],
          ...(selected.some((item) => item.refused) ? { refused: true } : {}),
          ...(includeModel
            ? {
                model: {
                  provider: connection.provider,
                  requested: model,
                  served: z.string().max(200).optional().parse(body.model),
                },
              }
            : {}),
          ...(additionalQuestions.length
            ? {
                additional: Object.fromEntries(
                  additionalQuestions.map((item, index) => [item.name, selected[index + 1]]),
                ),
              }
            : {}),
        };
      } catch {
        status = signal?.aborted ? 'cancelled' : 'failed';
        throw new Error('The decision service could not complete the check.');
      } finally {
        const cacheRead =
          connection.provider === 'openai' ? (usage?.input_tokens_details?.cached_tokens ?? 0) : 0;
        const cacheWrite =
          connection.provider === 'openai'
            ? (usage?.input_tokens_details?.cache_write_tokens ?? 0)
            : 0;
        const validCache = !usage || cacheRead + cacheWrite <= usage.input_tokens;
        const uncached =
          usage && validCache ? usage.input_tokens - cacheRead - cacheWrite : usage?.input_tokens;
        report?.({
          id,
          provider: connection.provider,
          model,
          category: 'review',
          operation:
            {
              answer: 'approval_reply',
              access: 'access',
              trust: 'trust',
              readOnly: 'read_only',
            }[question.name] ?? 'trust',
          status,
          durationMs: Math.round(performance.now() - started),
          inputTokens: uncached,
          ...(validCache && connection.provider === 'openai' && usage?.input_tokens_details
            ? { cacheReadTokens: cacheRead, cacheWriteTokens: cacheWrite }
            : {}),
          outputTokens: usage?.output_tokens,
          costUsd: usage
            ? (usage.cost ??
              (priced && validCache
                ? ((uncached ?? 0) * service.rate + cacheRead * 0.01 + cacheWrite * 0.125) /
                  1_000_000
                : null))
            : null,
          pricing:
            usage?.cost !== undefined
              ? 'reported'
              : usage && priced && validCache
                ? 'sdk_estimate'
                : 'unavailable',
        });
      }
    },
  };
}
