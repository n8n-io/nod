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

function draft(word: string) {
  return /^DRAFTS?$/.test(word);
}

function effectOf(words: string[]): ActionEffect {
  const effects = words.map(verb);
  const index = effects.findIndex(Boolean);
  if (index < 0) return 'unknown';
  const first = effects[index]!;
  if (first === 'change' && words.some((word) => sharing.has(word))) return 'outbound';
  return (
    first === 'change'
      ? effects
      : effects.filter((_, position) => connectors.has(words[position - 1] ?? ''))
  ).reduce<ActionEffect>(
    (strongest, effect) =>
      effect && rank.indexOf(effect) > rank.indexOf(strongest) ? effect : strongest,
    first,
  );
}

function sentUrl(path: string) {
  return new URL(`./${path.replace(/^\/+/, '')}`, 'http://request.invalid/');
}

export function sentPath(path: string) {
  const url = sentUrl(path);
  return `${url.pathname}${url.search}`;
}

function pathWords(path: string) {
  const { pathname } = sentUrl(path);
  try {
    return tokens(decodeURIComponent(pathname));
  } catch {
    return tokens(pathname);
  }
}

function graphqlQuery(document: unknown) {
  return (
    typeof document === 'string' &&
    /^\s*(?:[{#]|query\b|fragment\b)/.test(document) &&
    !/\b(?:mutation|subscription)\b/i.test(document)
  );
}

function graphql(words: string[], documents: unknown[]) {
  return words.includes('GRAPHQL') && documents.length && documents.every(graphqlQuery)
    ? ['QUERY']
    : words;
}

function requestWords(method: string, path: string[], documents: unknown[]) {
  const verb = method.toUpperCase();
  if (['GET', 'HEAD', 'OPTIONS'].includes(verb)) return ['GET'];
  if (verb === 'DELETE') return ['DELETE'];
  return verb === 'POST' ? graphql(path, documents) : ['UPDATE', ...path];
}

function commandWords(argv: string[]) {
  const option = (item: string | undefined) =>
    item !== undefined && item !== '--' && /^-[^=]+$/.test(item);
  const commands = argv
    .filter(
      (item, index) => !item.startsWith('-') && !/^[\w.-]+=/.test(item) && !option(argv[index - 1]),
    )
    .slice(0, 3)
    .flatMap(pathWords);
  const method = argv
    .flatMap((item, index) =>
      /^(?:-X|--method|--request)$/.test(item)
        ? [argv[index + 1] ?? '']
        : (/^(?:-X|--method=|--request=)(.+)$/.exec(item)?.slice(1) ?? []),
    )
    .at(-1);
  const documents = argv.filter((item) => item.startsWith('query=')).map((item) => item.slice(6));
  return method === undefined
    ? graphql(commands, documents)
    : requestWords(method, commands, documents);
}

function actionWords(action: string, args: Record<string, unknown>) {
  if (action === 'CONNECTED_HTTP')
    return requestWords(String(args.method ?? 'GET'), pathWords(String(args.path ?? '')), [
      args.body && typeof args.body === 'object' && (args.body as { query?: unknown }).query,
    ]);
  if (action === 'CONNECTED_MCP_CALL') return tokens(String(args.tool ?? ''));
  if (action === 'CONNECTED_CLI')
    return commandWords(
      (Array.isArray(args.argv) ? args.argv : []).filter(
        (item): item is string => typeof item === 'string',
      ),
    );
  return tokens(action).slice(1);
}

export function actionPayload(action: string, args: Record<string, unknown>) {
  if (action === 'CONNECTED_HTTP')
    return String(args.method ?? 'GET').toUpperCase() === 'GET' ? undefined : args.body;
  if (action === 'CONNECTED_MCP_CALL') return args.input;
  if (action === 'CONNECTED_CLI') return undefined;
  return args;
}

function collect(value: unknown, inside: boolean, found: Set<string>) {
  if (typeof value === 'string') {
    if (inside) for (const match of value.matchAll(emailAddress)) found.add(match[0].toLowerCase());
  } else if (Array.isArray(value)) {
    for (const item of value) collect(item, inside, found);
  } else if (value && typeof value === 'object') {
    for (const [key, item] of Object.entries(value))
      collect(item, inside || recipientKey.test(key), found);
  }
  return found;
}

function actionRecipients(action: string, args: Record<string, unknown>) {
  const found = collect(actionPayload(action, args), false, new Set());
  if (action === 'CONNECTED_HTTP')
    for (const [key, value] of sentUrl(String(args.path ?? '')).searchParams)
      collect({ [key]: value }, false, found);
  return found;
}

export function actionEffect(action: string, args: Record<string, unknown>): ActionEffect {
  if (action === 'SEARCH_TOOLS') return 'read';
  const words = actionWords(action, args);
  const effect = effectOf(words);
  return effect === 'change' && !words.some(draft) && actionRecipients(action, args).size
    ? 'outbound'
    : effect;
}
