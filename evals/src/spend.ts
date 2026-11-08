export type AttemptCost = {
  costUsd: number | null;
  judgeCostUsd?: number | null;
  modelCalls?: number;
  tokens?: number;
  judgeTokens?: number;
};

const valid = (cost: number | null | undefined): cost is number =>
  typeof cost === 'number' && Number.isFinite(cost) && cost >= 0;

export function createSpend() {
  let knownCostUsd = 0;
  let unpriced = false;
  return {
    add(attempt: AttemptCost) {
      if (valid(attempt.costUsd)) knownCostUsd += attempt.costUsd;
      else if ((attempt.modelCalls ?? 0) > 0 || attempt.costUsd != null) unpriced = true;
      if (valid(attempt.judgeCostUsd)) knownCostUsd += attempt.judgeCostUsd;
      else if ((attempt.judgeTokens ?? 0) > 0 || attempt.judgeCostUsd != null) unpriced = true;
    },
    blocked(budget?: number) {
      return budget !== undefined && (unpriced || knownCostUsd >= budget);
    },
    knownCostUsd: () => knownCostUsd,
    unpriced: () => unpriced,
  };
}

export function mergeAttemptCosts<T extends AttemptCost>(attempts: T[]) {
  const last = attempts.at(-1)!;
  const known = (key: 'costUsd' | 'judgeCostUsd') =>
    attempts.every((attempt) => valid(attempt[key]))
      ? attempts.reduce((sum, attempt) => sum + attempt[key]!, 0)
      : null;
  return {
    ...last,
    costUsd: known('costUsd'),
    judgeCostUsd: known('judgeCostUsd'),
    modelCalls: attempts.reduce((sum, attempt) => sum + (attempt.modelCalls ?? 0), 0),
    tokens: attempts.reduce((sum, attempt) => sum + (attempt.tokens ?? 0), 0),
    judgeTokens: attempts.reduce((sum, attempt) => sum + (attempt.judgeTokens ?? 0), 0),
  };
}
