import { parseFragment, type DefaultTreeAdapterTypes } from 'parse5';

const appResultInlineChars = 40_000;

const emailContentFields = new Set([
  'subject',
  'preview',
  'snippet',
  'messagetext',
  'body',
  'bodytext',
  'bodyhtml',
  'html',
  'text',
  'content',
  'payload',
  'parts',
  'data',
  'headers',
]);
const emailMetadataFields = new Set([
  'id',
  'messageid',
  'threadid',
  'sender',
  'from',
  'to',
  'recipient',
  'recipients',
  'date',
  'timestamp',
  'messagetimestamp',
  'receivedat',
  'internaldate',
  'labelids',
]);
const emailMetadataHeaders = new Set(['from', 'to', 'delivered-to', 'date', 'message-id']);
const fieldName = (name: string) => name.replaceAll('_', '').toLowerCase();

function emailText(value: unknown, field = ''): string {
  if (typeof value === 'string')
    return field === 'data' && /^[A-Za-z0-9+/_=-]+$/.test(value)
      ? Buffer.from(value, 'base64url').toString('utf8')
      : value;
  if (Array.isArray(value)) return value.map((entry) => emailText(entry, field)).join('\n');
  if (!value || typeof value !== 'object') return '';
  const record = value as Record<string, unknown>;
  if (typeof record.name === 'string' && typeof record.value === 'string')
    return record.name.toLowerCase() === 'subject' ? record.value : '';
  return Object.entries(record)
    .filter(([key]) => emailContentFields.has(fieldName(key)))
    .map(([key, entry]) => emailText(entry, fieldName(key)))
    .join('\n');
}

export type Mail = { from: string; subject: string; text: string };

export type MailCheck = (
  emails: Mail[],
  signal?: AbortSignal,
) => Promise<Array<boolean | undefined>>;

const mailCheckChars = 8000;

export function mailCheckText(text: string) {
  const parts: string[] = [];
  const nodes: DefaultTreeAdapterTypes.Node[] = [parseFragment(text, { scriptingEnabled: false })];
  while (nodes.length) {
    const node = nodes.pop()!;
    if (node.nodeName === 'style' || node.nodeName === 'script') continue;
    if ('value' in node) parts.push(node.value);
    if ('attrs' in node)
      for (const attribute of node.attrs)
        if (attribute.name === 'href') parts.push(attribute.value);
    const children =
      'content' in node ? node.content.childNodes : 'childNodes' in node ? node.childNodes : [];
    for (let index = children.length - 1; index >= 0; index--) nodes.push(children[index]!);
  }
  const clean = parts.join(' ').replace(/\s+/g, ' ').trim();
  if (clean.length <= mailCheckChars) return clean;
  const tail = mailCheckChars / 4;
  return `${clean.slice(0, mailCheckChars - tail)} … ${clean.slice(-tail)}`;
}

export const noMailCheck: MailCheck = async () => {
  throw new Error('Mail checks are unavailable.');
};

function headerValue(headers: Array<{ name: string; value: string }>, name: string) {
  return headers.find((entry) => entry.name.toLowerCase() === name)?.value ?? '';
}

function fieldValue(record: Record<string, unknown>, names: string[]) {
  const entry = Object.entries(record).find(([key]) => names.includes(fieldName(key)))?.[1];
  return typeof entry === 'string' ? entry : entry === undefined ? '' : JSON.stringify(entry);
}

const verificationHidden =
  'Verification email content is private. Use sign_in with emailCode:true to retrieve and enter its code.';
const uncheckedHidden =
  'Nod could not check whether this email is for signing in, so its content is private.';

export function hiddenEmail(value: unknown) {
  const message = (value as { message?: unknown } | null)?.message;
  return (
    typeof value === 'object' && (message === verificationHidden || message === uncheckedHidden)
  );
}

export async function privateEmailResult(
  value: unknown,
  check: MailCheck,
  signal?: AbortSignal,
): Promise<unknown> {
  const emails: Mail[] = [];
  type Render = (checks: Array<boolean | undefined>) => unknown;
  function prepare(value: unknown): Render {
    if (typeof value === 'string' && /^[\s]*[\[{]/.test(value)) {
      let parsed: unknown;
      try {
        parsed = JSON.parse(value);
      } catch {
        return () => value;
      }
      const render = prepare(parsed);
      return (checks) => JSON.stringify(render(checks));
    }
    if (Array.isArray(value)) {
      const children = value.map((entry) => prepare(entry));
      return (checks) => children.map((render) => render(checks));
    }
    if (!value || typeof value !== 'object') return () => value;
    const prototype = Object.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null) return () => value;
    const record = value as Record<string, unknown>;
    const payload = record.payload as Record<string, unknown> | undefined;
    const headers = [record.headers, payload?.headers].flatMap((entries) =>
      Array.isArray(entries)
        ? entries.filter(
            (entry): entry is { name: string; value: string } =>
              entry && typeof entry.name === 'string' && typeof entry.value === 'string',
          )
        : [],
    );
    const isMail =
      Object.entries(record).some(
        ([key, entry]) =>
          ['sender', 'from', 'to', 'recipient', 'recipients'].includes(fieldName(key)) &&
          /[^\s<>@]+@[^\s<>@]+\.[^\s<>@]+/.test(
            typeof entry === 'string' ? entry : (JSON.stringify(entry) ?? ''),
          ),
      ) ||
      headers.some(
        (entry) =>
          ['from', 'to'].includes(entry.name.toLowerCase()) &&
          /[^\s<>@]+@[^\s<>@]+\.[^\s<>@]+/.test(entry.value),
      );
    let index: number | undefined;
    if (isMail) {
      const email = {
        from: (fieldValue(record, ['sender', 'from']) || headerValue(headers, 'from')).slice(
          0,
          300,
        ),
        subject: (fieldValue(record, ['subject']) || headerValue(headers, 'subject')).slice(0, 300),
        text: mailCheckText(emailText(record)),
      };
      index = emails.length;
      emails.push(email);
    }
    const children = Object.entries(record).map(([key, entry]) => [key, prepare(entry)] as const);
    return (checks) => {
      if (index !== undefined && checks[index] !== false) {
        const safe = Object.fromEntries(
          Object.entries(record).filter(
            ([key, entry]) =>
              emailMetadataFields.has(fieldName(key)) &&
              (typeof entry === 'string' ||
                typeof entry === 'number' ||
                (Array.isArray(entry) && entry.every((item) => typeof item === 'string'))),
          ),
        );
        const metadata = headers
          .filter((entry) => emailMetadataHeaders.has(entry.name.toLowerCase()))
          .map(({ name, value }) => ({ name, value }));
        return {
          ...safe,
          ...(metadata.length && { headers: metadata }),
          message: checks[index] === true ? verificationHidden : uncheckedHidden,
        };
      }
      return Object.fromEntries(children.map(([key, render]) => [key, render(checks)]));
    };
  }
  const render = prepare(value);
  const checks = emails.length ? await check(emails, signal).catch(() => []) : [];
  return render(checks);
}

export async function inlineAppResult(
  result: unknown,
  save: (text: string) => Promise<string>,
  check: MailCheck,
  signal?: AbortSignal,
) {
  result = await privateEmailResult(result, check, signal);
  const text = JSON.stringify(result ?? null);
  if (text.length <= appResultInlineChars) return result;
  const bytes = Buffer.byteLength(text);
  const preview = text.slice(0, 2000);
  try {
    return {
      workspaceFile: await save(text),
      bytes,
      preview,
      message:
        'The full app result is saved in this workspace file. Inspect it with read or bash, for example jq, instead of repeating the request.',
    };
  } catch (error) {
    return {
      bytes,
      preview,
      message: `The full app result could not be saved to the workspace (${error instanceof Error ? error.message : String(error)}). Only this preview is available. Do not repeat a completed write to recover it.`,
    };
  }
}
