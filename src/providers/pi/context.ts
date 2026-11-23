export function modelContext<
  T extends { provider: string; id: string; contextWindow: number; maxTokens: number },
>(model: T, companion?: Pick<T, 'contextWindow' | 'maxTokens'>) {
  const routed =
    model.provider === 'openrouter' && ['openrouter/free', 'openrouter/auto'].includes(model.id);
  const window = Math.min(
    model.contextWindow,
    companion?.contextWindow ?? Infinity,
    routed ? 8192 : Infinity,
  );
  const compact = window < 65_536;
  return {
    model: {
      ...model,
      contextWindow: window,
      maxTokens: Math.min(
        model.maxTokens,
        companion?.maxTokens ?? Infinity,
        model.provider === 'openrouter' || model.provider === 'hostinger' ? 32_768 : Infinity,
        Math.floor(window / (compact ? 4 : 2)),
      ),
    },
    compact,
    margin: Math.min(2048, Math.max(128, Math.floor(window / 16))),
    compaction: {
      enabled: true,
      reserveTokens: compact ? Math.floor(window / 2) : Math.max(16_384, window - 256_000),
      keepRecentTokens: compact
        ? Math.floor(window / 8)
        : Math.max(0, Math.round(Math.min(256_000, window - 16_384) / 3)),
    },
    toolOutput: {
      maxBytes: Math.floor(window / 2),
      maxTokens: Math.floor(window / 8),
      previewCharacters: 1000,
    },
  };
}
