import type { Capability, FailureClass } from './scenario.ts';
import type { UsageDetails } from '../../src/shared/execution.ts';

export interface CheckResult {
  id: string;
  kind: 'check' | 'judge';
  group: 'task' | 'product';
  criterion?: string;
  na?: boolean;
  aspect: 'process' | 'outcome';
  failure: FailureClass;
  required: boolean;
  pass: boolean;
  evidence?: string;
}

export type Blame = 'agent' | 'mock' | 'harness' | 'infra';

export interface Diagnosis {
  rootCause: string;
  category: FailureClass;
  blame: 'agent' | 'scenario' | 'mock' | 'harness';
  turningPoint: string;
  fix: string;
  confidence: number;
}

export interface AttemptResult {
  scenario: string;
  title: string;
  capabilities: Capability[];
  tier: 'pr' | 'full' | 'release' | 'live' | 'canary';
  complexity: 'simple' | 'medium' | 'complex';
  stance: 'regression' | 'gap';
  fingerprint: string;
  attempt: number;
  task: string;
  status: 'pass' | 'fail' | 'incomplete';
  blame?: Blame;
  error?: string;
  checks: CheckResult[];
  seconds: number;
  toolCalls: number;
  modelCalls: number;
  tokens: number;
  costUsd: number | null;
  toolErrors: number;
  firstReplySeconds: number | null;
  judgeCostUsd: number | null;
  judgeTokens?: number;
  metrics?: {
    modelUsage: UsageDetails[];
    interactions: Record<string, number>;
    browserHandoffs: number;
    calls?: Array<{
      name: string;
      action?: string;
      query?: string;
      turnId?: string;
      nested?: boolean;
      error: boolean;
      at: number;
      finishedAt?: number;
    }>;
    compactions?: number;
    turns: Array<{
      source: string;
      background?: boolean;
      status?: string;
      error?: string | null;
      startedAt?: number;
      finishedAt?: number;
    }>;
  };
  final: string;
  transcript: string;
  groundTruth: string;
  diagnosis?: Diagnosis;
}

export interface RunManifest {
  label: string;
  startedAt: string;
  commit: string;
  dirty: boolean;
  ref?: string;
  model: string;
  effort?: import('../../src/shared/models.ts').ModelEffort;
  judge: string;
  repeat: number;
  scenarioIds?: string[];
  k: number;
  provenance: Record<string, string>;
}

export interface ScenarioSummary {
  scenario: string;
  title: string;
  capabilities: Capability[];
  stance: 'regression' | 'gap';
  fingerprint: string;
  attempts: number;
  passed: number;
  incomplete: number;
  unitPass: number | null;
  passAt1: number | null;
  passAtK: number | null;
  passPowK: number | null;
  seconds: number;
  medianSeconds: number | null;
  costUsd: number | null;
}

export interface Rates {
  passed: number;
  total: number;
  incomplete: number;
  percent: number | null;
  interval: { low: number; high: number } | null;
  unitPass: number | null;
  passAt1: number | null;
  passAtK: number | null;
  passPowK: number | null;
}

export interface Efficiency {
  seconds: { p50: number | null; p90: number | null };
  firstReplySeconds: { p50: number | null; p90: number | null };
  costPerAttempt: number | null;
  costPerPass: number | null;
  tokensPerAttempt: number | null;
  toolCallsPerAttempt: number | null;
  toolErrorRate: number | null;
  judgeCostUsd: number | null;
}

export interface TrustLine {
  id: string;
  rate: number | null;
  applicable: number;
}

export interface Trust {
  lines: TrustLine[];
  trustedRate: number | null;
  safetyIncidents: number;
  scopeIncidents: number;
}

export interface Review {
  verdict: 'trust' | 'distrust';
  wrongChecks: string[];
  note: string;
  reviewer: string;
  at: string;
}

export type Reviews = Record<string, Review>;

export interface WentWrong {
  groups: Array<{
    scenario: string;
    category: FailureClass;
    blame: Diagnosis['blame'];
    count: number;
    rootCause: string;
    fix: string;
  }>;
  suspectEval: Array<{
    scenario: string;
    attempt: number;
    blame: Diagnosis['blame'];
    rootCause: string;
  }>;
  undiagnosed: number;
}

export interface RunSummary {
  manifest: RunManifest;
  coverage: {
    expected: number | null;
    completed: number;
    incomplete: number;
    missing: string[];
  };
  regression: Rates;
  combined: Rates;
  gap: Rates;
  contaminated: boolean;
  efficiency: Efficiency;
  trust: Trust;
  wentWrong: WentWrong;
  scenarios: ScenarioSummary[];
  capabilities: Array<{ capability: Capability; passAt1: number | null; scenarios: number }>;
  failures: Array<{ failure: FailureClass; count: number }>;
  seconds: number;
  costUsd: number | null;
}
