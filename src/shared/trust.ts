export type TrustSource = 'chat' | 'task' | 'schedule' | 'event' | 'check' | 'resume';

export type TrustBecause =
  { kind: 'message' | 'schedule' | 'standing' | 'rule'; text: string } | { kind: 'approved' };

export interface TrustAction {
  label: string;
  because?: TrustBecause;
}

export interface TrustEntry {
  id: string;
  at: string;
  title: string;
  source: TrustSource;
  channel: string;
  error: string | null;
  costUsd: number | null;
  actions: TrustAction[];
}

export interface TrustPage {
  entries: TrustEntry[];
  next: { at: string; id: string } | null;
}

export interface TrustView extends TrustPage {
  week: { things: number; actions: number; spentUsd: number };
  month: {
    start: string;
    days: number;
    elapsedDays: number;
    spentUsd: number;
    forecastUsd: number;
    daily: number[];
    unpriced: boolean;
  };
  limit: { monthlyUsd: number; reached: boolean } | null;
  taskUsd: number | null;
}
