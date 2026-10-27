export type ProactiveCategory = string;
export interface ProactiveEvidence {
  sourceId: string;
  id: string;
  version: string;
}
export function sourceVersions(sources: ProactiveEvidence[]) {
  return sources
    .map(({ sourceId, id, version }) => [sourceId, id, version])
    .sort((left, right) => {
      const a = JSON.stringify(left);
      const b = JSON.stringify(right);
      return a < b ? -1 : a > b ? 1 : 0;
    });
}
export interface ProactiveIssue {
  id: string;
  url: string;
  matterKey: string;
  primary: Pick<ProactiveEvidence, 'sourceId' | 'id'>;
  category: ProactiveCategory;
  title: string;
  summary: string;
  benefit: string;
  delayCost: string;
  draft: string;
  unknowns: string[];
  sources: Array<ProactiveEvidence & { label: string; url?: string; checkedAt: string }>;
  state: 'open' | 'offered' | 'resolved' | 'dismissed';
  impact: 'low' | 'medium' | 'high';
  deadline: string | null;
  nextCheck: string | null;
  snoozedUntil: string | null;
  notifiedAt: string | null;
  feedback: 'useful' | 'not_useful' | null;
  updatedAt: string;
}
export interface ProactivityView {
  issues: ProactiveIssue[];
  coverage: Array<{
    sourceId: string;
    label: string;
    readable: boolean;
    mode?: 'prepare' | 'classic';
    status: 'pending' | 'ready' | 'partial' | 'unavailable' | 'blocked' | 'paused';
  }>;
}
