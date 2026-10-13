export const orgKinds = ['chief', 'person', 'upward', 'helper'] as const;
export type OrgKind = (typeof orgKinds)[number];
export const orgEntryKinds = ['evidence', 'draft', 'note'] as const;
export type OrgEntryKind = (typeof orgEntryKinds)[number];

export interface OrgEntry {
  id: string;
  kind: OrgEntryKind;
  title: string;
  body: string;
  link: string | null;
  createdAt: string;
}

export interface OrgCounts {
  evidence: number;
  draft: number;
  note: number;
}

export interface OrgAgentSummary {
  id: string;
  name: string;
  kind: OrgKind;
  brief: string;
  monthlyUsd: number | null;
  spentUsd: number;
  unpriced: number;
  reportsTo: string[];
  reporteeIds: string[];
  counts: OrgCounts;
  firstEntryAt: string | null;
  lastEntryAt: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface OrgDossier extends OrgAgentSummary {
  entries: OrgEntry[];
}

export interface OrgView {
  agents: OrgAgentSummary[];
}

export interface OrgExport {
  exportedAt: string;
  agents: OrgDossier[];
}

export function reportingCycle(
  agentId: string,
  reportsTo: readonly string[],
  links: ReadonlyArray<{ agentId: string; reportsTo: readonly string[] }>,
) {
  const managers = new Map(links.map((link) => [link.agentId, [...link.reportsTo]]));
  managers.set(agentId, [...reportsTo]);
  const seen = new Set<string>();
  const pending = [...reportsTo];
  while (pending.length) {
    const id = pending.pop();
    if (!id || seen.has(id)) continue;
    if (id === agentId) return true;
    seen.add(id);
    pending.push(...(managers.get(id) ?? []));
  }
  return false;
}
