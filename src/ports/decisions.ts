import type { ProviderUsageEvent } from './provider-usage.ts';

export interface DecisionQuestion {
  name: 'answer' | 'access';
  instructions?: string;
  choices: Array<{ value: string | boolean; description: string }>;
}

export interface DecisionBatchRequest {
  instructions: string;
  input: object;
  operation: DecisionQuestion['name'];
  questions: Array<Omit<DecisionQuestion, 'name'> & { name: string }>;
}

export type ModelReview = (
  instructions: string,
  input: object,
  signal?: AbortSignal,
  question?: DecisionQuestion,
) => Promise<unknown>;

export interface DecisionModel {
  configured?: boolean;
  checkBatch?(
    request: DecisionBatchRequest,
    signal?: AbortSignal,
    report?: (usage: ProviderUsageEvent) => void,
  ): Promise<unknown>;
  check(
    request: { instructions: string; input: object; question: DecisionQuestion },
    signal?: AbortSignal,
    report?: (usage: ProviderUsageEvent) => void,
  ): Promise<unknown>;
}
