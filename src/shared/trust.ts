export type TrustSource = 'chat' | 'schedule' | 'event' | 'check' | 'resume';

export interface TrustEntry {
  id: string;
  at: string;
  title: string;
  source: TrustSource;
  channel: string;
  error: string | null;
  costUsd: number | null;
  unpriced: boolean;
  actions: string[];
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
}
