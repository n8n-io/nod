function normalize(value: string) {
  return value
    .normalize('NFKD')
    .replace(/\p{M}/gu, '')
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .trim();
}

function oneEditAway(query: string, word: string) {
  if (Math.abs(query.length - word.length) > 1) return false;
  let index = 0;
  while (index < Math.min(query.length, word.length) && query[index] === word[index]) index++;
  if (query.length !== word.length) {
    return query.length > word.length
      ? query.slice(index + 1) === word.slice(index)
      : query.slice(index) === word.slice(index + 1);
  }
  return (
    query.slice(index + 1) === word.slice(index + 1) ||
    (query[index] === word[index + 1] &&
      query[index + 1] === word[index] &&
      query.slice(index + 2) === word.slice(index + 2))
  );
}

function isAbbreviation(query: string, words: string[]) {
  if (query.length < 4 || words.length < 2) return false;
  const initials = words
    .slice(0, -1)
    .map((word) => word[0])
    .join('');
  if (!query.startsWith(initials)) return false;
  const tail = query.slice(initials.length);
  const lastWord = words[words.length - 1]!;
  if (tail.length < 3 || tail[0] !== lastWord[0]) return false;
  let position = 0;
  for (const letter of tail) {
    const next = lastWord.indexOf(letter, position);
    if (next < 0 || next - position > 1) return false;
    position = next + 1;
  }
  return true;
}

export function searchApps<
  T extends { name: string; description: string; category: string; slug?: string },
>(apps: T[], query: string): T[] {
  const normalized = normalize(query);
  if (!normalized) return apps;
  const terms = normalized.split(' ');

  return apps
    .map((app, index) => {
      const name = normalize(app.name);
      const slug = normalize(app.slug ?? '');
      const words = name.split(' ');
      const supportingText = normalize(`${app.description} ${app.category}`);
      const ranks = terms.map((term) => {
        if (words.includes(term)) return 0;
        if (words.some((word) => word.startsWith(term))) return 1;
        if (name.includes(term) || slug.includes(term)) return 2;
        if (term.length >= 4 && words.some((word) => oneEditAway(term, word))) return 3;
        if (isAbbreviation(term, words)) return 4;
        if (term.length >= 3 && supportingText.includes(term)) return 5;
        return Infinity;
      });
      const rank =
        name === normalized
          ? -2
          : name.startsWith(normalized)
            ? -1
            : Math.max(...ranks) * 100 + ranks.reduce((total, value) => total + value, 0);
      return { app, index, rank };
    })
    .filter(({ rank }) => Number.isFinite(rank))
    .sort((left, right) => left.rank - right.rank || left.index - right.index)
    .map(({ app }) => app);
}
