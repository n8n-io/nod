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

function addsNewContent(text: string, start: string) {
  const finalWords = words(text);
  const startWords = words(start);
  const removed = [...startWords].filter((word) => !finalWords.has(word));
  return [...finalWords]
    .filter((word) => !startWords.has(word))
    .some(
      (word) =>
        !removed.some((old) => {
          const stem = Math.min(word.length, old.length) - 2;
          return stem >= 3 && word.slice(0, stem) === old.slice(0, stem);
        }),
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
  const status =
    /^(?:(?:sure|ok(?:ay)?)[,.!\s]+)?(?:on it\b|i(?:['’]ll| will)\b|i(?:['’]m| am)\s+(?:going|working|starting)\b|i(?:['’]ve| have)\s+started\b|started\b|working\b)/iu.test(
      text.trim(),
    );
  return (
    !/[\p{N}€$£\n]|https?:\/\//iu.test(text) &&
    !conflictingPolarity(text, start) &&
    (status ? overlap(text, start, 0.45, 0.4, 3) : handoff && nearDuplicate(text, start))
  );
}

export function repeatsTaskStart(text: string, start: string) {
  const details = text.match(/https?:\/\/\S+|[€$£]\s*\d[\d.,]*|\b\d[\d.,]*\b/gu) ?? [];
  const startDetails = new Map<string, number>();
  for (const detail of start.match(/https?:\/\/\S+|[€$£]\s*\d[\d.,]*|\b\d[\d.,]*\b/gu) ?? [])
    startDetails.set(detail, (startDetails.get(detail) ?? 0) + 1);
  return (
    !text.includes('\n') &&
    details.every((detail) => {
      const count = startDetails.get(detail) ?? 0;
      if (!count) return false;
      startDetails.set(detail, count - 1);
      return true;
    }) &&
    polarity(text) === polarity(start) &&
    !addsNewContent(text, start) &&
    (overlap(text, start, 0.8, 0.85, 5) || nearDuplicate(text, start))
  );
}
