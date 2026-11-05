import type {
  DecisionModel,
  DecisionRequest,
  DecisionSelection,
  ModelReview,
} from '../ports/decisions.ts';
import { trustDecision, type TrustWords } from './trust-basis.ts';
import { trustDimensions } from './trust-dimensions.ts';
import { trustFacts } from './trust-facts.ts';
import { checkJevEffects, checkJevModel, checkJevTrust, isJev, jevRequest } from './trust-jev.ts';

function probability(answer: unknown) {
  const value =
    answer && typeof answer === 'object'
      ? (answer as { probability?: unknown }).probability
      : undefined;
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 && value <= 1
    ? value
    : undefined;
}

export function createTrustReview(options: {
  review: ModelReview;
  decisions?: DecisionModel;
}): ModelReview {
  return async (instructions, input, signal, question) => {
    signal?.throwIfAborted();
    const llmQuestion =
      question && question.name !== 'readOnly'
        ? {
            name: question.name,
            choices: question.choices,
            ...(question.instructions ? { instructions: question.instructions } : {}),
          }
        : undefined;
    const decisions = options.decisions?.select
      ? await options.decisions.select(signal)
      : options.decisions;
    signal?.throwIfAborted();
    if (!decisions) return options.review(instructions, input, signal, llmQuestion);
    if (decisions.configured === false) return undefined;
    const gate = question ? undefined : trustDecision(input as TrustWords);
    const policy = instructions.replace(/^Reply with only JSON\..*\n/m, '');
    let jev: DecisionSelection | undefined;
    const request: DecisionRequest = {
      instructions: gate ? '' : instructions,
      input: gate ? trustFacts(input as Parameters<typeof trustFacts>[0]) : input,
      question:
        gate?.question ??
        (question?.name === 'readOnly'
          ? { ...question, minProbability: question.minProbability ?? 0.99 }
          : question!),
      ...(gate ? { includeModel: true, additionalQuestions: trustDimensions(policy) } : {}),
    };
    const answer = await decisions.check(
      {
        ...request,
        forModel: (selection: DecisionSelection) => {
          if (!isJev(selection)) return request;
          jev = selection;
          return gate
            ? jevRequest(input as Parameters<typeof jevRequest>[0])
            : {
                ...request,
                includeModel: true,
                question:
                  question?.name === 'readOnly'
                    ? { ...request.question, minProbability: question.minProbability ?? 0.8 }
                    : request.question,
              };
        },
      },
      signal,
    );
    signal?.throwIfAborted();
    if (answer && typeof answer === 'object' && (answer as { refused?: unknown }).refused === true)
      return undefined;
    if (gate && jev)
      return checkJevTrust(
        decisions,
        input as Parameters<typeof jevRequest>[0],
        answer,
        jev,
        signal,
      );
    if (!gate) {
      if (jev) {
        const checked = checkJevModel(answer, jev);
        if (question?.name === 'readOnly') {
          if (typeof checked.choice !== 'boolean')
            throw new Error('The trust read check is incomplete.');
          const positive = checked.choice ? checked.probability : 1 - checked.probability;
          if (positive < (question.minProbability ?? 0.8)) return { readOnly: false };
          const effects = await checkJevEffects(
            decisions,
            (input as { action: object }).action,
            jev,
            signal,
            true,
          );
          if (effects === undefined) return undefined;
          return { readOnly: effects >= (question.minProbability ?? 0.8) };
        }
      }
      const certainty = probability(answer);
      if (certainty === undefined) return undefined;
      return answer;
    }
    const details =
      answer && typeof answer === 'object'
        ? (answer as {
            trust?: unknown;
            choice?: unknown;
            model?: { requested?: string; served?: string };
            additional?: {
              permission?: { permission?: unknown; choice?: unknown };
              preparation?: { preparation?: unknown };
            } & Record<string, unknown>;
          })
        : undefined;
    const permission = details?.additional?.permission;
    const preparation = details?.additional?.preparation;
    const certainty = probability(permission);
    const evidenceCertainty = probability(answer);
    const preparationCertainty = probability(preparation);
    if (
      certainty === undefined ||
      evidenceCertainty === undefined ||
      preparationCertainty === undefined ||
      typeof permission?.permission !== 'boolean' ||
      typeof permission.choice !== 'boolean' ||
      typeof preparation?.preparation !== 'boolean'
    )
      return undefined;
    const prepared = preparation.preparation === true && preparationCertainty >= 0.99;
    const source = gate.result({ trust: details?.trust }) as
      { run?: boolean; because?: string; rule?: boolean } | undefined;
    if (source?.rule || (details?.choice === 'rule' && (input as TrustWords).userRules))
      return { run: false, rule: true, decision: answer };
    if (!prepared) {
      const scope = details?.additional?.scope as { choice?: unknown } | undefined;
      if (probability(scope) === undefined || scope?.choice !== true)
        return { run: false, decision: answer };
    }
    if (
      details?.model?.requested === 'perplexity/pplx-decider-v1.2' &&
      details.model.served !== 'perplexity/pplx-decider-v1.2-20261016'
    )
      return { run: false, decision: answer };
    for (const name of [
      'constraints',
      'time',
      'numbers',
      'conditions',
      'targets',
      'bans',
      'costs',
    ]) {
      const value = details?.additional?.[name] as { choice?: unknown } | undefined;
      const certainty = probability(value);
      if (certainty === undefined || typeof value?.choice !== 'boolean') return undefined;
      if ((value.choice ? certainty : 1 - certainty) >= 0.5)
        return { run: false, decision: answer };
    }
    const conflict = prepared && permission.choice === false;
    const uncertain =
      conflict ||
      (!prepared &&
        (certainty < 0.99 ||
          (permission.permission &&
            (preparationCertainty < 0.99 ||
              !source?.run ||
              source.because === 'read' ||
              evidenceCertainty < 0.5))));
    if (uncertain) return { run: false, decision: answer };
    if (prepared) return { run: true, because: 'read', decision: answer };
    if (!permission.permission)
      return { run: false, ...(source?.rule ? { rule: true } : {}), decision: answer };
    return { ...source, decision: answer };
  };
}
