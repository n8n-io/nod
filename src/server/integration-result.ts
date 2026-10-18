export const appResultInlineChars = 40_000;

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

export type MailCheck = (
  email: { from: string; subject: string; text: string },
  signal?: AbortSignal,
) => Promise<boolean>;

export const mailCheckChars = 8000;

export function mailCheckText(text: string) {
  const clean = text
    .replace(/<(style|script)\b[^>]*>[\s\S]*?<\/\1\s*>/gi, ' ')
    .replace(/<[^>]*>/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
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

export async function privateEmailResult(
  value: unknown,
  check: MailCheck,
  signal?: AbortSignal,
): Promise<unknown> {
  if (typeof value === 'string' && /^[\s]*[\[{]/.test(value)) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(value);
    } catch {
      return value;
    }
    return JSON.stringify(await privateEmailResult(parsed, check, signal));
  }
  if (Array.isArray(value))
    return Promise.all(value.map((entry) => privateEmailResult(entry, check, signal)));
  if (!value || typeof value !== 'object') return value;
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) return value;
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
  const hidden =
    isMail &&
    (await check(
      {
        from: (fieldValue(record, ['sender', 'from']) || headerValue(headers, 'from')).slice(
          0,
          300,
        ),
        subject: (fieldValue(record, ['subject']) || headerValue(headers, 'subject')).slice(0, 300),
        text: mailCheckText(emailText(record)),
      },
      signal,
    ).then(
      (verification) =>
        verification
          ? 'Verification email content is private. Use sign_in with emailCode:true to retrieve and enter its code.'
          : undefined,
      () => 'Otto could not check whether this email is for signing in, so its content is private.',
    ));
  if (hidden) {
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
      message: hidden,
    };
  }
  return Object.fromEntries(
    await Promise.all(
      Object.entries(record).map(async ([key, entry]) => [
        key,
        await privateEmailResult(entry, check, signal),
      ]),
    ),
  );
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
