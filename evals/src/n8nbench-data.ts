import { createHash } from 'node:crypto';
import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';

export interface N8nTurn {
  role: 'user' | 'assistant';
  text: string;
  attach?: Record<string, string>;
}

export interface N8nScenario {
  name: string;
  description?: string;
  dataSetup?: string;
  successCriteria?: string;
}

export interface N8nCase {
  conversation: N8nTurn[];
  executionScenarios: N8nScenario[];
  outcomeExpectations?: string[];
  processExpectations?: string[];
  credentials?: Array<{ type: string; name?: string; valid?: boolean }>;
  seed?: unknown;
  datasets?: string[];
  messageBudget?: number;
  complexity?: string;
  triggerType?: string;
  tags?: string[];
  requiresMemoryCompaction?: boolean;
}

export interface BenchCase {
  slug: string;
  definition: N8nCase;
  setKind?: string;
  split: 'dev' | 'holdout';
}

export interface ToolCall {
  name: string;
  tool?: string;
  input: unknown;
  output?: string;
  error?: string;
  status: string;
  at: number;
  ms?: number;
}

export interface BenchRun {
  slug: string;
  iteration: number;
  workflowId?: string;
  workflowIds: string[];
  messages: Array<{ role: 'user' | 'assistant'; text: string; at: number }>;
  tools: ToolCall[];
  transcript: unknown[];
  costUsd: number;
  tokens: number;
  seconds: number;
  turns: number;
  failedTurns: string[];
  userId?: string;
  projectId?: string;
  agents?: Array<{ id: string; name?: string }>;
  error?: string;
  unavailable?: string;
  n8nUrl?: string;
}

export interface UnitResult {
  kind: 'scenario' | 'outcome' | 'process';
  name: string;
  pass: boolean;
  reason?: string;
  incomplete?: boolean;
}

export interface CaseIteration {
  slug: string;
  iteration: number;
  built: boolean;
  units: UnitResult[];
  costUsd: number;
  seconds: number;
}

const devShare = 0.3;

export function splitOf(slug: string): 'dev' | 'holdout' {
  const digest = createHash('sha256').update(`otto-n8n-bench:${slug}`).digest();
  return digest.readUInt32BE(0) / 0x1_0000_0000 < devShare ? 'dev' : 'holdout';
}

export async function loadCases(directory: string): Promise<BenchCase[]> {
  const inventory = JSON.parse(
    await readFile(join(directory, 'case-inventory.json'), 'utf8').catch(() => '[]'),
  ) as Array<{ name: string; setKind?: string }>;
  const kinds = new Map(inventory.map((item) => [item.name, item.setKind]));
  const files = (await readdir(join(directory, 'cases'))).filter((name) => name.endsWith('.json'));
  const cases: BenchCase[] = [];
  for (const file of files.sort()) {
    const slug = file.slice(0, -'.json'.length);
    const definition = JSON.parse(
      await readFile(join(directory, 'cases', file), 'utf8'),
    ) as N8nCase;
    cases.push({ slug, definition, setKind: kinds.get(slug), split: splitOf(slug) });
  }
  return cases;
}

export function supported(item: BenchCase) {
  const { definition } = item;
  if (definition.requiresMemoryCompaction) return 'memory compaction';
  if (definition.conversation[0]?.role !== 'user') return 'starts with the assistant';
  if (definition.conversation.slice(1).some((turn) => turn.attach)) return 'later attachment';
  return undefined;
}

export function selectCases(
  cases: BenchCase[],
  options: { tier?: string; split?: 'dev' | 'holdout' | 'all'; only?: string[]; sample?: number },
) {
  let selected = cases.filter((item) => !supported(item));
  if (options.only?.length) {
    const wanted = new Set(options.only);
    selected = selected.filter((item) => wanted.has(item.slug));
  }
  if (options.tier && options.tier !== 'full')
    selected = selected.filter((item) => item.definition.datasets?.includes(options.tier!));
  if (options.split && options.split !== 'all')
    selected = selected.filter((item) => item.split === options.split);
  if (options.sample && options.sample < selected.length)
    selected = [...selected]
      .sort((a, b) =>
        createHash('sha256')
          .update(a.slug)
          .digest('hex')
          .localeCompare(createHash('sha256').update(b.slug).digest('hex')),
      )
      .slice(0, options.sample);
  return selected;
}

export function mainWorkflow(
  workflows: Array<{ id: string; createdAt?: string; nodes?: unknown[]; settings?: unknown }>,
) {
  if (!workflows.length) return undefined;
  const ordered = [...workflows].sort((a, b) =>
    String(a.createdAt ?? '').localeCompare(String(b.createdAt ?? '')),
  );
  const called = new Set<string>();
  for (const workflow of ordered) {
    const body = JSON.stringify([workflow.nodes ?? [], workflow.settings ?? {}]);
    for (const other of ordered)
      if (other.id !== workflow.id && body.includes(other.id)) called.add(other.id);
  }
  return (ordered.find((workflow) => !called.has(workflow.id)) ?? ordered[0]).id;
}
