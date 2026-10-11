type VerificationReply =
  { kind: 'code'; code: string } | { kind: 'invalid' } | { kind: 'ordinary' };

export function classifyVerificationReply(text: string): VerificationReply {
  const value = text.trim();
  const prefix =
    /^(?:(?:(?:the|my)\s+)?(?:(?:verification|security|authentication|one[- ]time|2fa|sms|email)\s+)?code|otp|(?:(?:o|meu|o meu)\s+)?c[oó]digo(?:\s+de\s+(?:verifica[cç][aã]o|seguran[cç]a|autentica[cç][aã]o))?)(?:\s+(?:is|[eé]))?(?:\s*[:=]\s*|\s+(?=\d))/i.exec(
      value,
    );
  const candidate = (prefix ? value.slice(prefix[0].length) : value).replace(/[.!]$/, '');
  if (candidate.length <= 160 && /^[\d\p{Zs}\t]+$/u.test(candidate)) {
    const code = candidate.replace(/[\p{Zs}\t]/gu, '');
    if (/^\d{4,8}$/.test(code)) return { kind: 'code', code };
  }
  return { kind: prefix ? 'invalid' : 'ordinary' };
}

export function securityCodeIn(text: string) {
  const bare = /^\s*(\d{3,4})\s*[.!]?\s*$/.exec(text)?.[1];
  const explicit =
    /^\s*(?:(?:the|my)\s+)?(?:security\s+code|cvv|cvc)(?:\s+is)?(?:\s*[:=]\s*|\s+)(\d{3,4})[.!]?\s*$/i.exec(
      text,
    )?.[1];
  const reply = classifyVerificationReply(text);
  return (
    bare ?? explicit ?? (reply.kind === 'code' && reply.code.length === 4 ? reply.code : undefined)
  );
}

export function mayHoldSecurityCode(text: string) {
  return /(?<!\d)\d{3,4}(?!\d)/.test(text);
}
