import type { ProviderUsageEvent } from './provider-usage.ts';

export interface DecisionQuestion {
  name: 'run' | 'answer' | 'valid';
  instructions?: string;
  choices: Array<{ value: string | boolean; description: string }>;
}

export type ModelReview = (
  instructions: string,
  input: object,
  signal?: AbortSignal,
  question?: DecisionQuestion,
) => Promise<unknown>;

export interface DecisionModel {
  check(
    request: { instructions: string; input: object; question: DecisionQuestion },
    signal?: AbortSignal,
    report?: (usage: ProviderUsageEvent) => void,
  ): Promise<unknown>;
}
