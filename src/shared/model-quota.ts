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

function readFailure(text: string) {
  const start = text.indexOf('{');
  const reasons: string[] = [];
  const read = (value: unknown, depth = 0): void => {
    if (depth > 8) return;
    if (typeof value === 'string') {
      if (!value.trim()) return;
      try {
        read(JSON.parse(value), depth + 1);
      } catch {
        reasons.push(value);
      }
    } else if (Array.isArray(value)) {
      for (const item of value.slice(0, 20)) read(item, depth + 1);
    } else if (value && typeof value === 'object') {
      const data = value as Record<string, unknown>;
      for (const key of [
        'code',
        'type',
        'status',
        'quotaMetric',
        'quotaId',
        'quotaValue',
        'retryDelay',
      ]) {
        const field = data[key];
        if (typeof field !== 'string' && typeof field !== 'number') continue;
        reasons.push(
          key === 'code' && /^[45]\d{2}$/.test(String(field))
            ? `HTTP ${field}`
            : `${key}: ${field}`,
        );
      }
      read(data.message, depth + 1);
      read(data.error, depth + 1);
      read(data.details, depth + 1);
      read(data.violations, depth + 1);
      const metadata = data.metadata as Record<string, unknown> | undefined;
      if (metadata && typeof metadata === 'object') {
        for (const key of [
          'provider_name',
          'error_type',
          'provider_code',
          'limit_source',
          'reason',
          'remedy_hint',
        ])
          if (typeof metadata[key] === 'string') reasons.push(`${key}: ${metadata[key]}`);
        read(metadata.raw, depth + 1);
      }
    }
  };
  let end = start === -1 ? -1 : text.lastIndexOf('}');
  for (let tries = 0; end > start && tries < 50; tries++) {
    try {
      read(JSON.parse(text.slice(start, end + 1)));
      break;
    } catch {
      end = text.lastIndexOf('}', end - 1);
    }
  }
  return { start, end, reasons };
}

export function modelFailureReason(text: string): string {
  const { start, end, reasons } = readFailure(text);
  if (start === -1 || end <= start) return text;
  const rest = reasons.reduce(
    (value, reason) => value.replace(` (${reason})`, ''),
    text.slice(end + 1),
  );
  const head = reasons.length
    ? `${text.slice(0, start)}${[...new Set(reasons)].join('; ')}`
    : text.slice(0, end + 1);
  return `${head}${modelFailureReason(rest)}`;
}
