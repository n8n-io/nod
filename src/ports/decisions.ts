import type { ProviderUsageEvent } from './provider-usage.ts';

export interface DecisionQuestion {
  name: string;
  format?: 'predicate';
  instructions?: string;
  minProbability?: number;
  uncertainValue?: string | boolean;
  choices: Array<{ value: string | boolean; description: string }>;
}

export type ModelReview = (
  instructions: string,
  input: object,
  signal?: AbortSignal,
  question?: DecisionQuestion,
) => Promise<unknown>;

export interface DecisionRequest {
  instructions: string;
  input: object;
  question: DecisionQuestion;
  additionalQuestions?: DecisionQuestion[];
  includeModel?: boolean;
}

export interface DecisionSelection {
  provider: string;
  model: string;
}

export interface DecisionModel {
  configured?: boolean;
  select?(signal?: AbortSignal): Promise<DecisionModel | undefined>;
  check(
    request: DecisionRequest & { forModel?: (selection: DecisionSelection) => DecisionRequest },
    signal?: AbortSignal,
    report?: (usage: ProviderUsageEvent) => void,
  ): Promise<unknown>;
}
