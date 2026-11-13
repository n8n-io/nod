// The full number below 10,000, then "10k", "10.4k". Rounded down so the page never shows more stars than the repo has.
export function formatStars(count) {
  if (count < 10000) return count.toLocaleString('en-US');
  return `${Math.floor(count / 100) / 10}k`;
}
