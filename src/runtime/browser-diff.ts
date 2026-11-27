const diffBudgetRatio = 0.65;
const maxLcsProduct = 200_000;

export interface PageSnapshotState {
  url: string;
  lines: string[];
}

function sameDocument(a: string, b: string): boolean {
  if (a === b) return true;
  try {
    const ua = new URL(a);
    const ub = new URL(b);
    return ua.origin === ub.origin && ua.pathname === ub.pathname && ua.search === ub.search;
  } catch {
    return false;
  }
}

function lcsDiff(
  oldMid: string[],
  newMid: string[],
): { removed: string[]; added: string[] } | null {
  const m = oldMid.length;
  const n = newMid.length;
  if (m * n > maxLcsProduct) return null;

  const width = n + 1;
  const dp = new Uint32Array((m + 1) * width);
  for (let i = m - 1; i >= 0; i--) {
    const row = i * width;
    const nextRow = (i + 1) * width;
    for (let j = n - 1; j >= 0; j--) {
      if (oldMid[i] === newMid[j]) {
        dp[row + j] = dp[nextRow + j + 1]! + 1;
      } else {
        const down = dp[nextRow + j]!;
        const right = dp[row + j + 1]!;
        dp[row + j] = down >= right ? down : right;
      }
    }
  }

  const removed: string[] = [];
  const added: string[] = [];
  let i = 0;
  let j = 0;
  while (i < m && j < n) {
    if (oldMid[i] === newMid[j]) {
      i++;
      j++;
    } else if (dp[(i + 1) * width + j]! >= dp[i * width + (j + 1)]!) {
      removed.push(oldMid[i]!);
      i++;
    } else {
      added.push(newMid[j]!);
      j++;
    }
  }
  while (i < m) removed.push(oldMid[i++]!);
  while (j < n) added.push(newMid[j++]!);
  return { removed, added };
}

function computeLineDiff(prev: string[], next: string[]): string | null {
  let prefix = 0;
  const minLen = Math.min(prev.length, next.length);
  while (prefix < minLen && prev[prefix] === next[prefix]) prefix++;

  if (prefix === prev.length && prefix === next.length) return '';

  let suffix = 0;
  while (
    suffix < minLen - prefix &&
    prev[prev.length - 1 - suffix] === next[next.length - 1 - suffix]
  ) {
    suffix++;
  }

  const oldMid = prev.slice(prefix, prev.length - suffix);
  const newMid = next.slice(prefix, next.length - suffix);

  const lcs = lcsDiff(oldMid, newMid);
  if (!lcs) return null;

  const { removed, added } = lcs;
  if (removed.length === 0 && added.length === 0) return '';

  const diffSize = removed.length + added.length;
  if (next.length > 0 && diffSize > next.length * diffBudgetRatio) return null;

  const parts: string[] = [];
  if (removed.length > 0) {
    parts.push(`Removed (${removed.length} lines):`);
    for (const line of removed) parts.push(`- ${line}`);
  }
  if (added.length > 0) {
    parts.push(`Added (${added.length} lines):`);
    for (const line of added) parts.push(`+ ${line}`);
  }
  const output = parts.join('\n');
  const nextChars = next.reduce((total, line) => total + line.length + 1, 0);
  if (nextChars > 0 && output.length > nextChars) return null;
  return output;
}

export function createPageDiffer() {
  let last: PageSnapshotState | undefined;

  return {
    reset() {
      last = undefined;
    },
    format(url: string, text: string, options?: { full?: boolean }): string {
      const lines = text.split('\n');
      const prev = last;
      last = { url, lines };

      if (!options?.full && prev && sameDocument(prev.url, url)) {
        const diff = computeLineDiff(prev.lines, lines);
        if (diff === '') return `URL: ${url}\n(page unchanged)`;
        if (diff !== null) {
          return `URL: ${url}\n(changes since previous view; call snapshot for full page)\n${diff}`;
        }
      }
      return `URL: ${url}\n${text}`;
    },
  };
}
