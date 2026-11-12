import { z } from 'zod';

const text = (max: number) => z.string().trim().min(1).max(max);
const resource = text(1024).refine((value) => !/[\u0000-\u001f]/.test(value));
const sourceId = text(200);
const instant = z.iso.datetime({ offset: true });

function sourceReadError(issue: { input?: unknown }) {
  if (issue.input && typeof issue.input === 'object') {
    const input = issue.input as Record<string, unknown>;
    if ([input.ids, input.query, input.tool].filter((value) => value !== undefined).length > 1)
      return 'Use ids, query or tool, not more than one.';
    if (input.args !== undefined && input.tool === undefined) return 'args belong to a tool read.';
  }
  return 'Use {sourceId}, {sourceId,ids}, {sourceId,query}, or {sourceId,tool,args?}.';
}

export const sourceReadSchema = z.union(
  [
    z.strictObject(
      { sourceId, ids: z.array(resource).min(1).max(10).optional() },
      { error: sourceReadError },
    ),
    z.strictObject({ sourceId, query: text(1000) }, { error: sourceReadError }),
    z.strictObject(
      { sourceId, tool: text(300), args: z.record(z.string(), z.unknown()).optional() },
      { error: sourceReadError },
    ),
  ],
  { error: sourceReadError },
);

export const proactiveSourcesSchema = z
  .array(z.object({ sourceId, id: resource, version: text(1000) }).strict())
  .min(1)
  .max(6)
  .transform((refs) => [...new Map(refs.map((ref) => [JSON.stringify(ref), ref])).values()]);

export const proactiveProposalSchema = z
  .object({
    action: z.literal('save'),
    matterKey: text(200),
    primary: z.object({ sourceId, id: resource }).strict(),
    category: text(60),
    title: text(120),
    summary: text(600),
    benefit: text(600),
    delayCost: text(600),
    draft: text(20000).describe('Reusable result only. Put owner-only review notes in unknowns.'),
    unknowns: z.array(text(500)).max(8),
    sources: proactiveSourcesSchema,
    impact: z.enum(['low', 'medium', 'high']),
    delivery: z.enum(['private', 'offer']).default('offer'),
    evidence: z.enum(['strong', 'uncertain']),
    deadline: instant.nullable(),
    nextCheck: instant.nullable(),
    materialChange: z.enum(['none', 'deadline_advanced', 'condition_changed', 'new_option']),
  })
  .strict();
const list = z.object({ action: z.literal('list') }).strict();
const read = z.object({ action: z.literal('read'), id: z.uuid() }).strict();
const resolve = z
  .object({ action: z.literal('resolve'), id: z.uuid(), sources: proactiveSourcesSchema })
  .strict();

export const proactiveUpdateSchema = z.discriminatedUnion('action', [
  proactiveProposalSchema,
  list,
  read,
  resolve,
]);

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
