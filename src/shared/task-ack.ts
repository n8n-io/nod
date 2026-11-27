function words(value: string) {
  return new Set(value.toLocaleLowerCase().match(/[\p{L}\p{N}]{3,}/gu) ?? []);
}

function overlap(text: string, start: string, shorter: number, longer: number, minimum: number) {
  const answer = text.toLocaleLowerCase().replace(/\s+/gu, ' ').trim();
  const acknowledgement = start.toLocaleLowerCase().replace(/\s+/gu, ' ').trim();
  if (!answer || !acknowledgement) return false;
  if (answer === acknowledgement) return true;
  const first = words(answer);
  const second = words(acknowledgement);
  const shortest = Math.min(first.size, second.size);
  const shared = [...first].filter((word) => second.has(word)).length;
  return (
    shortest >= 3 &&
    shared >= Math.min(minimum, shortest) &&
    shared / shortest >= shorter &&
    shared / Math.max(first.size, second.size) >= longer
  );
}

function nearDuplicate(text: string, start: string) {
  const normalize = (value: string) =>
    value
      .toLocaleLowerCase()
      .replace(/[^\p{L}\p{N}]+/gu, ' ')
      .trim();
  const count = (value: string) => {
    const pairs = new Map<string, number>();
    for (let index = 0; index < value.length - 1; index++) {
      const pair = value.slice(index, index + 2);
      pairs.set(pair, (pairs.get(pair) ?? 0) + 1);
    }
    return pairs;
  };
  const first = count(normalize(text));
  const second = count(normalize(start));
  const total =
    [...first.values()].reduce((sum, value) => sum + value, 0) +
    [...second.values()].reduce((sum, value) => sum + value, 0);
  if (!total) return false;
  const shared = [...first].reduce(
    (sum, [pair, value]) => sum + Math.min(value, second.get(pair) ?? 0),
    0,
  );
  return (2 * shared) / total >= 0.84 && overlap(text, start, 0.6, 0.55, 4);
}

function polarity(text: string) {
  const negations = new Set([
    'no',
    'not',
    'never',
    'nothing',
    'without',
    'cannot',
    'cant',
    'wont',
    'dont',
    'doesnt',
    'didnt',
    'isnt',
    'arent',
    'wasnt',
    'werent',
    'shouldnt',
    'wouldnt',
    'couldnt',
    'mustnt',
    'não',
    'nunca',
    'sem',
    'jamais',
    'non',
    'pas',
    'sans',
    'sin',
    'nicht',
    'kein',
    'ohne',
    'senza',
    'mai',
    'niet',
    'geen',
    'zonder',
  ]);
  return (
    text
      .toLocaleLowerCase()
      .replace(/[’']/gu, '')
      .match(/[\p{L}]+/gu) ?? []
  )
    .filter((word) => negations.has(word))
    .sort()
    .join('|');
}

function conflictingPolarity(text: string, start: string) {
  const clauses = (value: string) => value.split(/[.!?\n]+/u).filter((clause) => clause.trim());
  const candidates = clauses(start).map((clause) => ({ clause, terms: words(clause) }));
  return clauses(text).some((answer) => {
    const terms = words(answer);
    let best: { clause: string; score: number } | undefined;
    for (const candidate of candidates) {
      const shared = [...terms].filter((word) => candidate.terms.has(word)).length;
      const score = shared / Math.max(terms.size, candidate.terms.size);
      if (
        (shared >= 2 || (shared === 1 && terms.size === 1 && candidate.terms.size === 1)) &&
        score >= 0.5 &&
        (!best || score > best.score)
      )
        best = { clause: candidate.clause, score };
    }
    return best ? polarity(answer) !== polarity(best.clause) : false;
  });
}

export function resemblesTaskAcknowledgement(text: string, start: string, handoff = false) {
  const trimmed = text.trim();
  const status =
    /^(?:(?:sure|ok(?:ay)?|got it|alright|right)[,.!\s]+)?(?:on it\b|i(?:['’]ll| will)\b|i(?:['’]m| am)\s+(?:going|working|starting|looking|checking|on|pulling|gathering|digging|searching|drafting|setting)\b|i(?:['’]ve| have)\s+started\b|let me\s+(?!know\b|hear\b)|looking\b|checking\b|starting\b|working\b|pulling\b|gathering\b|searching\b)/iu.test(
      trimmed,
    );
  const shortLine = trimmed.length <= 160 && !/[?\n]|https?:\/\//iu.test(trimmed);
  const hasMoney = /[€$£]/u.test(trimmed);
  const asks =
    /\b(?:let me know|tell me|send me|share|please|could you|can you|need (?:you|your))\b/iu.test(
      trimmed,
    );
  const startNumbers = new Set(start.match(/\p{N}+/gu) ?? []);
  const newNumbers = (trimmed.match(/\p{N}+/gu) ?? []).some((number) => !startNumbers.has(number));
  return (
    !hasMoney &&
    !asks &&
    !newNumbers &&
    !/\n|https?:\/\//iu.test(trimmed) &&
    !conflictingPolarity(trimmed, start) &&
    (status
      ? overlap(trimmed, start, 0.45, 0.4, 3) || (shortLine && overlap(trimmed, start, 0.3, 0.2, 2))
      : handoff
        ? nearDuplicate(trimmed, start) || (shortLine && overlap(trimmed, start, 0.4, 0.3, 2))
        : false)
  );
}
