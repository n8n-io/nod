export function formatStars(count) {
  if (count < 10000) return count.toLocaleString('en-US');
  return `${Math.floor(count / 100) / 10}k`;
}
