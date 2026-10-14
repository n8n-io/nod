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

export function verificationMail(text: string) {
  return (
    /\b\d{4,8}\b/.test(text) &&
    (/\b(?:(?:verification|security|authentication|login|sign[ -]?in|one[ -]?time)\s+(?:code|passcode|password)|(?:verify|confirm)\s+(?:(?:your|the)\s+)?(?:email|account|identity)|otp|c[oó]digo\s+de\s+(?:verifica[çc][aã]o|seguran[çc]a|autentica[çc][aã]o))\b/i.test(
      text,
    ) ||
      /(?:\b(?:your|the)\s+(?:code|passcode)|\b(?:o\s+)?seu\s+c[oó]digo|(?:^|[\n.!?])\s*(?:code|passcode|c[oó]digo))\s*(?:(?:is|[eé])\s*)?[:=]?\s*\d{4,8}\b|\b\d{4,8}\s+(?:is\s+(?:your|the)\s+(?:code|passcode)|[eé]\s+(?:o\s+)?seu\s+c[oó]digo)\b/i.test(
        text,
      ))
  );
}

export function privateEmailResult(value: unknown): unknown {
  if (typeof value === 'string' && /^[\s]*[\[{]/.test(value)) {
    try {
      return JSON.stringify(privateEmailResult(JSON.parse(value)));
    } catch {
      return value;
    }
  }
  if (Array.isArray(value)) return value.map(privateEmailResult);
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
        /[^\s<>@]+@[^\s<>@]+\.[^\s<>@]+/.test(String(entry)),
    ) ||
    headers.some(
      (entry) =>
        ['from', 'to'].includes(entry.name.toLowerCase()) &&
        /[^\s<>@]+@[^\s<>@]+\.[^\s<>@]+/.test(entry.value),
    );
  const text = isMail ? emailText(record).replace(/<[^>]*>/g, ' ') : '';
  if (verificationMail(text)) {
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
      message:
        'Verification email content is private. Use sign_in with emailCode:true to retrieve and enter its code.',
    };
  }
  return Object.fromEntries(
    Object.entries(record).map(([key, entry]) => [key, privateEmailResult(entry)]),
  );
}

export async function inlineAppResult(result: unknown, save: (text: string) => Promise<string>) {
  result = privateEmailResult(result);
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
