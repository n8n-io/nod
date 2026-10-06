export type ActionEffect = 'read' | 'change' | 'outbound' | 'destructive' | 'unknown';

const verbs = new Map<string, Exclude<ActionEffect, 'unknown'>>();
for (const [effect, words] of [
  [
    'read',
    'GET LIST FETCH SEARCH FIND READ QUERY RETRIEVE LOOKUP VIEW SHOW DESCRIBE COUNT CHECK DOWNLOAD EXPORT BROWSE PREVIEW TEST WHO WHOAMI',
  ],
  [
    'change',
    'CREATE UPDATE EDIT MODIFY APPEND INSERT ADD SET MOVE RENAME COPY UPLOAD MARK PATCH PUT REPLACE ARCHIVE UNARCHIVE STAR UNSTAR PIN UNPIN SAVE WRITE MERGE DUPLICATE IMPORT ASSIGN CLOSE REOPEN OPEN RESTORE',
  ],
  [
    'outbound',
    'SEND REPLY FORWARD POST PUBLISH SHARE INVITE NOTIFY PAY TRANSFER BROADCAST TWEET COMMENT RSVP RESPOND',
  ],
  [
    'destructive',
    'DELETE REMOVE TRASH PURGE DESTROY ERASE EMPTY CLEAR CANCEL REVOKE UNSUBSCRIBE TERMINATE WIPE BAN KICK',
  ],
] as const)
  for (const word of words.split(' ')) verbs.set(word, effect);
const sharing = new Set(['SHARING', 'PERMISSION', 'PERMISSIONS', 'COLLABORATOR', 'COLLABORATORS']);
const rank: ActionEffect[] = ['read', 'change', 'destructive', 'outbound'];
const connectors = new Set(['AND', 'THEN', 'OR', 'PLUS']);
const recipientKey =
  /^(?:to|cc|bcc|recipients?|recipient_?emails?|extra_?recipients|attendees?|invitees?|guests?|email_?address(?:es)?|share_?with)$/i;
export const emailAddress = /[A-Z0-9._%+-]+@[A-Z0-9-]+(?:\.[A-Z0-9-]+)*\.[A-Z]{2,}/gi;

function tokens(text: string) {
  return text
    .replace(/([a-z0-9])([A-Z])/g, '$1_$2')
    .toUpperCase()
    .split(/[^A-Z0-9]+/)
    .filter(Boolean);
}

function verb(token: string) {
  for (const form of [
    token,
    token.replace(/IES$/, 'Y'),
    token.replace(/ES$/, ''),
    token.replace(/S$/, ''),
  ])
    if (verbs.has(form)) return verbs.get(form);
  return undefined;
}

function effectOf(words: string[]): ActionEffect {
  const effects = words.map(verb);
  const first = effects.find(Boolean);
  if (!first) return 'unknown';
  if (first === 'change' && words.some((word) => sharing.has(word))) return 'outbound';
  return (
    first === 'change'
      ? effects
      : effects.filter((_, index) => connectors.has(words[index - 1] ?? ''))
  ).reduce<ActionEffect>(
    (strongest, effect) =>
      effect && rank.indexOf(effect) > rank.indexOf(strongest) ? effect : strongest,
    first,
  );
}

export function actionRecipients(value: unknown, inside = false, found = new Set<string>()) {
  if (typeof value === 'string') {
    if (inside) for (const match of value.matchAll(emailAddress)) found.add(match[0].toLowerCase());
  } else if (Array.isArray(value)) {
    for (const item of value) actionRecipients(item, inside, found);
  } else if (value && typeof value === 'object') {
    for (const [key, item] of Object.entries(value))
      actionRecipients(item, inside || recipientKey.test(key), found);
  }
  return found;
}

export function actionEffect(action: string, args: Record<string, unknown>): ActionEffect {
  if (action === 'SEARCH_TOOLS') return 'read';
  let words: string[];
  if (action === 'CONNECTED_HTTP') {
    const method = String(args.method ?? 'GET').toUpperCase();
    if (['GET', 'HEAD', 'OPTIONS'].includes(method)) return 'read';
    if (method === 'DELETE') return 'destructive';
    words = [...(method === 'POST' ? [] : ['UPDATE']), ...tokens(String(args.path ?? ''))];
  } else if (action === 'CONNECTED_MCP_CALL') words = tokens(String(args.tool ?? ''));
  else if (action === 'CONNECTED_CLI')
    words = (Array.isArray(args.argv) ? args.argv : [])
      .filter((item): item is string => typeof item === 'string' && !item.startsWith('-'))
      .slice(0, 3)
      .flatMap(tokens);
  else words = tokens(action).slice(1);
  const effect = effectOf(words);
  return effect === 'change' &&
    !words.some((word) => /^DRAFTS?$/.test(word)) &&
    actionRecipients(args).size
    ? 'outbound'
    : effect;
}
