type FeedbackError = {
  at: number;
  type: 'render' | 'error' | 'rejection';
  message: string;
  stack?: string;
};

const entries: FeedbackError[] = [];
let owner: string | null = null;
let switchedOwner = false;
const bounded = (text: string) =>
  text.length <= 8192 ? text : '[error detail omitted: content limit]';

export function setFeedbackErrorOwner(id: string | null) {
  if (owner === id) return;
  if (owner !== null) switchedOwner = true;
  owner = id;
  entries.length = 0;
}

export function recordFeedbackError(type: FeedbackError['type'], error: unknown) {
  if (!owner || switchedOwner) return;
  const message =
    error instanceof Error ? error.message : typeof error === 'string' ? error : 'Unknown error';
  entries.push({
    at: Date.now(),
    type,
    message: bounded(message),
    ...(error instanceof Error && error.stack ? { stack: bounded(error.stack) } : {}),
  });
  if (entries.length > 10) entries.shift();
}

export function feedbackErrorsSnapshot() {
  const now = Date.now();
  return entries
    .filter((entry) => now - entry.at <= 1_800_000)
    .map(({ at, ...entry }) => ({ ...entry, ageMs: now - at }));
}

export function feedbackErrorsAvailable() {
  return owner !== null && !switchedOwner;
}
