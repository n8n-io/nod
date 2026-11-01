type VerificationReply =
  { kind: 'code'; code: string } | { kind: 'invalid' } | { kind: 'ordinary' };

export function classifyVerificationReply(text: string): VerificationReply {
  const value = text.trim().replace(/[.!]$/, '').trimEnd();
  const numbers = [...value.matchAll(/\+?\d+(?:[\p{Zs}\t]+\d+)*/gu)].filter(
    (match) =>
      (match[0].startsWith('+') || match[0].replace(/\D/g, '').length >= 3) &&
      (match.index + match[0].length === value.length ||
        !/[\p{L}\p{N}]/u.test(Array.from(value.slice(0, match.index)).at(-1) ?? '')),
  );
  if (!numbers.length) return { kind: 'ordinary' };
  const [only] = numbers;
  const code = only[0].replace(/[\p{Zs}\t]/gu, '');
  return numbers.length === 1 &&
    only.index + only[0].length === value.length &&
    /^\d{4,8}$/.test(code)
    ? { kind: 'code', code }
    : { kind: 'invalid' };
}

export function securityCodeIn(text: string) {
  const bare = /^\s*(\d{3,4})\s*[.!]?\s*$/.exec(text)?.[1];
  const labeled = [
    ...text.matchAll(/\b(?:security\s+code|cvv|cvc)(?:\s+is)?(?:\s*[:=]\s*|\s+)(\d{3,4})(?!\d)/gi),
  ].map((match) => match[1]);
  return bare ?? (labeled.length === 1 ? labeled[0] : undefined);
}
