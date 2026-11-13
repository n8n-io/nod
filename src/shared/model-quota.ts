export function modelQuotaFailure(text: string) {
  const normalized = text.replace(/["']/g, '').replace(/\\n/g, ' ');
  if (/\bprepayment credits are depleted\b/i.test(normalized))
    return { kind: 'credits_depleted' as const };
  if (!/\b(?:429|quota|quotaValue|RESOURCE_EXHAUSTED)\b/i.test(normalized)) return;
  const kind = /\b(?:quotaValue|limit):\s*0(?!\d|\.\d)/i.test(normalized)
    ? ('zero_quota' as const)
    : /\b(?:GenerateRequestsPerDay\w*|requests?\s*(?:\/|per\s+)day|daily (?:request )?(?:quota|limit))\b/i.test(
          normalized,
        )
      ? ('daily_quota' as const)
      : undefined;
  if (!kind) return;
  const retry = /\bretryDelay:\s*(\d+(?:\.\d+)?)s\b/i.exec(normalized);
  const delay = retry ? Number(retry[1]) * 1000 : 0;
  return {
    kind,
    retryAfterMs: delay > 0 && delay <= 7 * 86400_000 ? Math.ceil(delay) : undefined,
  };
}
