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

function dimensionResult(answer: unknown, input: object, gate: ReturnType<typeof trustDecision>) {
  if (!answer || typeof answer !== 'object') return;
  const details = answer as {
    trust?: unknown;
    model?: { provider?: string; requested?: string; served?: string };
    additional?: Record<string, unknown>;
  };
  const model = details.model;
  if (
    model?.provider !== 'openrouter' ||
    !['perplexity/pplx-decider-v1.2', 'perplexity/pplx-decider-v1.2-20261016'].includes(
      model.requested ?? '',
    )
  )
    return;
  if (model.served !== 'perplexity/pplx-decider-v1.2-20261016')
    return { run: false, decision: answer };
  const positive = (name: string) => {
    const result = details.additional?.[name];
    const certainty = probability(result);
    const choice =
      result && typeof result === 'object' ? (result as { choice?: unknown }).choice : undefined;
    return certainty === undefined || typeof choice !== 'boolean'
      ? NaN
      : choice
        ? certainty
        : 1 - certainty;
  };
  const scores = {
    permission: positive('permission'),
    preparation: positive('preparation'),
    scope: positive('scope'),
    bans: positive('bans'),
    time: positive('time'),
    numbers: positive('numbers'),
    conditions: positive('conditions'),
    constraints: positive('constraints'),
    targets: positive('targets'),
    costs: positive('costs'),
  };
  const evidence = probability(answer);
  if (Object.values(scores).some((x) => !Number.isFinite(x)) || evidence === undefined)
    return { run: false, decision: answer };
  const {
    permission,
    preparation,
    scope,
    bans,
    time,
    numbers,
    conditions,
    constraints,
    targets,
    costs,
  } = scores;
  const source = gate.result({ trust: details.trust }) as
    { run?: boolean; because?: string; rule?: boolean } | undefined;
  const action = (
    input as {
      action?: { name?: string; arguments?: { step?: string; command?: { action?: string } } };
    }
  ).action;
  const ownSettings = [
    'NOD_schedule_create',
    'NOD_schedule_update',
    'NOD_schedule_cancel',
    'NOD_limits_update',
    'NOD_notification_preferences_update',
    'NOD_memory_forget',
    'NOD_memory_control',
    'NOD_model_select',
  ].includes(action?.name ?? '');
  const neverRead =
    ownSettings ||
    ['NOD_sign_in', 'NOD_browser_session', 'NOD_vault_allow'].includes(action?.name ?? '') ||
    (action?.name === 'NOD_browser' &&
      (action.arguments?.step === 'upload' || action.arguments?.command?.action === 'upload'));
  const denied =
    (source?.rule && evidence >= 0.99) || 1 - permission >= 0.99 || bans >= 0.95 || costs >= 0.5;
  const prepared = !neverRead && preparation >= 0.8;
  const dimension = Math.max(time, numbers, conditions);
  const quoted =
    source?.run &&
    source.because !== 'read' &&
    !(ownSettings && ['standing', 'rules'].includes(String(details.trust)));
  const allowed =
    quoted &&
    1 - scope < 0.99 &&
    Math.max(dimension, constraints, targets) < 0.95 &&
    (permission >= 0.95 ||
      (permission >= 0.85 && scope >= 0.99 && 1 - dimension >= 0.9 && 1 - bans >= 0.95));
  if (denied || (!prepared && !allowed))
    return { run: false, ...(source?.rule ? { rule: true } : {}), decision: answer };
  return prepared
    ? { run: true, because: 'read', decision: answer }
    : { ...source, decision: answer };
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
    if (!options.decisions) return options.review(instructions, input, signal, llmQuestion);
    if (options.decisions.configured === false) return undefined;
    const gate = question ? undefined : trustDecision(input as TrustWords);
    const policy = instructions.replace(/^Reply with only JSON\..*\n/m, '');
    let jev: DecisionSelection | undefined;
    const request: DecisionRequest = {
      instructions: gate ? '' : instructions,
      input: gate ? trustFacts(input as Parameters<typeof trustFacts>[0]) : input,
      question: gate?.question ?? question!,
      ...(gate ? { includeModel: true, additionalQuestions: trustDimensions(policy) } : {}),
    };
    const answer = await options.decisions.check(
      {
        ...request,
        forModel: (selection: DecisionSelection) => {
          if (!isJev(selection)) return request;
          jev = selection;
          return gate
            ? jevRequest(input as Parameters<typeof jevRequest>[0])
            : { ...request, includeModel: true };
        },
      },
      signal,
    );
    signal?.throwIfAborted();
    if (answer && typeof answer === 'object' && (answer as { refused?: unknown }).refused === true)
      return undefined;
    if (gate && jev)
      return checkJevTrust(
        options.decisions,
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
          if (positive < 0.8) return { readOnly: false };
          const effects = await checkJevEffects(
            options.decisions,
            (input as { action: object }).action,
            jev,
            signal,
            true,
          );
          if (effects === undefined) return undefined;
          return { readOnly: effects > 0.5 };
        }
      }
      const certainty = probability(answer);
      if (certainty === undefined) return undefined;
      return answer;
    }
    const result = dimensionResult(answer, input, gate);
    if (result) return result;
    const details =
      answer && typeof answer === 'object'
        ? (answer as {
            trust?: unknown;
            additional?: {
              permission?: { permission?: unknown; choice?: unknown };
              preparation?: { preparation?: unknown };
            };
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
    const conflict =
      (prepared && permission.choice === false) ||
      (source?.rule === true && evidenceCertainty >= 0.99 && (prepared || permission.permission));
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
