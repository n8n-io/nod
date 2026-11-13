export type TrustSource = 'chat' | 'task' | 'started' | 'schedule' | 'event' | 'check' | 'resume';

export interface TrustOutside {
  kind: 'email' | 'memory' | 'style' | 'ideas' | 'other';
  costUsd: number;
}

export type TrustBecause =
  { kind: 'message' | 'schedule' | 'standing' | 'rule'; text: string } | { kind: 'approved' };

export interface TrustAction {
  label: string;
  target?: string;
  because?: TrustBecause;
}

export function actionText(action: Pick<TrustAction, 'label' | 'target'>) {
  return action.target ? `${action.label} · ${action.target}` : action.label;
}

export function becauseText(reason: TrustBecause) {
  if (reason.kind === 'approved') return 'You approved it';
  const quote = `“${reason.text}”`;
  if (reason.kind === 'message') return `You said ${quote}`;
  if (reason.kind === 'schedule') return `Your schedule says ${quote}`;
  if (reason.kind === 'standing') return `Your standing instruction says ${quote}`;
  return `Your rule says ${quote}`;
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
