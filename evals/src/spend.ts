export type AttemptCost = {
  costUsd: number | null;
  judgeCostUsd?: number | null;
  modelCalls?: number;
  tokens?: number;
  judgeTokens?: number;
};

const scale = 1_000_000;
const valid = (cost: number | null | undefined): cost is number =>
  typeof cost === 'number' && Number.isFinite(cost) && cost >= 0;
const units = (cost: number) => Math.ceil(cost * scale);

export function createSpend() {
  let knownUnits = 0;
  let unpriced = false;
  return {
    add(attempt: AttemptCost) {
      if (valid(attempt.costUsd)) knownUnits += units(attempt.costUsd);
      else if ((attempt.modelCalls ?? 0) > 0 || attempt.costUsd != null) unpriced = true;
      if (valid(attempt.judgeCostUsd)) knownUnits += units(attempt.judgeCostUsd);
      else if ((attempt.judgeTokens ?? 0) > 0 || attempt.judgeCostUsd != null) unpriced = true;
    },
    blocked(budget?: number) {
      return budget !== undefined && (unpriced || knownUnits >= units(budget));
    },
    knownCostUsd: () => knownUnits / scale,
    unpriced: () => unpriced,
  };
}

export function mergeAttemptCosts<T extends AttemptCost>(attempts: T[]) {
  const last = attempts.at(-1)!;
  const known = (key: 'costUsd' | 'judgeCostUsd') => {
    const priced = (attempt: T) =>
      valid(attempt[key]) ||
      (key === 'costUsd' ? attempt.modelCalls === 0 : attempt.judgeTokens === 0);
    return attempts.every(priced)
      ? attempts.reduce(
          (sum, attempt) => sum + (valid(attempt[key]) ? units(attempt[key]!) : 0),
          0,
        ) / scale
      : null;
  };
  return {
    ...last,
    costUsd: known('costUsd'),
    judgeCostUsd: known('judgeCostUsd'),
    modelCalls: attempts.reduce((sum, attempt) => sum + (attempt.modelCalls ?? 0), 0),
    tokens: attempts.reduce((sum, attempt) => sum + (attempt.tokens ?? 0), 0),
    judgeTokens: attempts.reduce((sum, attempt) => sum + (attempt.judgeTokens ?? 0), 0),
  };
}
