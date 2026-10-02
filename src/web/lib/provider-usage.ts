import type { ProviderUsageSummary, UsagePricing } from '../../shared/provider-usage';

const providerNames: Record<string, string> = {
  openai: 'OpenAI',
  anthropic: 'Anthropic',
  composio: 'Composio',
  jev: 'Jev',
  'agent-browser': 'Agent Browser',
  'local-workspace': 'Local workspace',
  'public-web': 'Public web',
  telegram: 'Telegram',
  whatsapp: 'WhatsApp',
};

export function providerLabel(provider: string) {
  return providerNames[provider.toLowerCase()] ?? provider.replaceAll('-', ' ');
}

export function operationLabel(operation: string) {
  const labels: Record<string, string> = {
    response: 'Assistant responses',
    classify: 'Relevance checks',
    route: 'Conversation routing',
    conversation_route: 'Conversation routing',
    compaction: 'Context compaction',
    cache_warming: 'Cache warming',
    synthesize: 'Speech synthesis',
    execute: 'Execution',
  };
  const words = operation.replaceAll('_', ' ');
  return labels[operation] ?? words.charAt(0).toUpperCase() + words.slice(1);
}

export function summarizeProviderUsage(rows: ProviderUsageSummary[]) {
  let operations = 0;
  let pricedOperations = 0;
  let costUsd: number | null = null;
  const sources = new Set<UsagePricing>();
  for (const row of rows) {
    operations += row.requests;
    if (
      row.pricing === 'unavailable' ||
      !row.pricedRequests ||
      row.costUsd === null ||
      !Number.isFinite(row.costUsd) ||
      row.costUsd < 0
    )
      continue;
    pricedOperations += row.pricedRequests;
    costUsd = (costUsd ?? 0) + row.costUsd;
    sources.add(row.pricing);
  }
  const pricing: UsagePricing = !sources.size
    ? 'unavailable'
    : sources.size > 1 || sources.has('mixed')
      ? 'mixed'
      : [...sources][0];
  return { operations, pricedOperations, costUsd, pricing, partial: pricedOperations < operations };
}

export function groupProviderUsage(rows: ProviderUsageSummary[]) {
  const groups = new Map<string, ProviderUsageSummary[]>();
  for (const row of rows) {
    const key = row.provider.trim().toLowerCase();
    const entries = groups.get(key) ?? [];
    entries.push(row);
    groups.set(key, entries);
  }
  return [...groups.entries()]
    .map(([provider, entries]) => ({
      provider,
      name: providerLabel(provider),
      rows: [...entries].sort(
        (left, right) =>
          (right.costUsd ?? -1) - (left.costUsd ?? -1) ||
          right.requests - left.requests ||
          left.operation.localeCompare(right.operation) ||
          (left.model ?? '').localeCompare(right.model ?? ''),
      ),
      ...summarizeProviderUsage(entries),
      failures: entries.reduce((sum, row) => sum + row.failures, 0),
      cancelled: entries.reduce((sum, row) => sum + row.cancelled, 0),
    }))
    .sort(
      (left, right) =>
        (right.costUsd ?? -1) - (left.costUsd ?? -1) ||
        right.operations - left.operations ||
        left.name.localeCompare(right.name),
    );
}
