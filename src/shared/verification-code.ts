type VerificationReply =
  { kind: 'code'; code: string; keep: boolean } | { kind: 'invalid' } | { kind: 'ordinary' };

export function classifyVerificationReply(text: string): VerificationReply {
  const value = text.trim();
  const prefix =
    /^(?:(?:(?:the|my)\s+)?(?:(?:verification|security|authentication|one[- ]time|2fa|sms|email)\s+)?code|otp|(?:(?:o|meu|o meu)\s+)?c[oó]digo(?:\s+de\s+(?:verifica[cç][aã]o|seguran[cç]a|autentica[cç][aã]o))?)(?:\s+(?:is|[eé]))?(?:\s*[:=]\s*|\s+(?=\d))/i.exec(
      value,
    );
  const rest = (prefix ? value.slice(prefix[0].length) : value).replace(/[.!]$/, '');
  const keep = /[\s,]+(?:and\s+)?(?:keep|remember)(?:\s+it)?$/i.exec(rest);
  const candidate = keep ? rest.slice(0, keep.index) : rest;
  if (candidate.length <= 160 && /^[\d\p{Zs}\t]+$/u.test(candidate)) {
    const code = candidate.replace(/[\p{Zs}\t]/gu, '');
    if (/^\d{3,8}$/.test(code)) return { kind: 'code', code, keep: Boolean(keep) };
  }
  return { kind: prefix ? 'invalid' : 'ordinary' };
}
