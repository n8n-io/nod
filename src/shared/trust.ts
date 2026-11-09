export type TrustSource = 'chat' | 'task' | 'started' | 'schedule' | 'event' | 'check' | 'resume';

export interface TrustOutside {
  kind: 'email' | 'memory' | 'style' | 'ideas' | 'other';
  costUsd: number;
}

export type TrustBecause =
  { kind: 'message' | 'schedule' | 'standing' | 'rule'; text: string } | { kind: 'approved' };

export interface TrustAction {
  label: string;
  because?: TrustBecause;
}

export interface TrustModel {
  provider: string | null;
  model: string | null;
  billing: 'api' | 'plan';
}

export interface TrustEntry {
  id: string;
  messageId: string | null;
  at: string;
  title: string;
  source: TrustSource;
  channel: string;
  error: string | null;
  costUsd: number | null;
  models: TrustModel[];
  pricing?: 'plan' | 'unpriced';
  actions: TrustAction[];
}

export interface TrustPage {
  entries: TrustEntry[];
  next: { at: string; id: string } | null;
}

export interface TrustView extends TrustPage {
  week: { things: number; actions: number; spentUsd: number; planUsd: number };
  month: {
    start: string;
    days: number;
    elapsedDays: number;
    spentUsd: number;
    forecastUsd: number;
    planUsd: number;
    daily: number[];
    unpriced: boolean;
    planUsage: boolean;
    backgroundUsd: number;
    outside: TrustOutside[];
  };
  limit: { monthlyUsd: number; reached: boolean } | null;
  taskUsd: number | null;
}
