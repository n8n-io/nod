import type { Composio } from '@composio/core';
import { parseFragment } from 'parse5';
import { z } from 'zod';
import { parse } from 'tldts';
import type { VerificationEmail, VerificationEmailQuery } from '../../ports/integrations.ts';

function withoutComments(value: string) {
  let plain = '';
  let depth = 0;
  for (let index = 0; index < value.length; index++) {
    const char = value[index];
    if (char === '\\' && depth > 0) {
      index++;
      continue;
    }
    if (char === '(') {
      depth++;
      continue;
    }
    if (char === ')') {
      depth = Math.max(0, depth - 1);
      continue;
    }
    if (depth === 0) plain += char;
  }
  return plain;
}

export const mailbox = (value: string) => {
  if (/[,;\r\n]/.test(value)) return;
  const plain = withoutComments(value);
  const bracketed = [...plain.matchAll(/<([^<>\s]+@[^<>\s]+)>/g)];
  const address = (bracketed.at(-1)?.[1] ?? plain).trim().toLowerCase();
  return z.email().max(320).safeParse(address).success ? address : undefined;
};
const headerSchema = z.object({ name: z.string().max(100), value: z.string().max(8192) });
export const messageSchema = z.object({
  id: z.string().regex(/^[a-zA-Z0-9_-]{1,200}$/),
  internalDate: z.string().regex(/^\d{1,16}$/),
  labelIds: z.array(z.string()).max(100).optional(),
  payload: z.object({ headers: z.array(headerSchema).max(200) }).passthrough(),
});

export function messageText(payload: unknown) {
  const queue: Array<{ value: unknown; depth: number }> = [{ value: payload, depth: 0 }];
  const plain: string[] = [];
  const html: string[] = [];
  let size = 0;
  let visited = 0;
  while (queue.length) {
    if (++visited > 50) return;
    const { value, depth } = queue.shift()!;
    if (!value || typeof value !== 'object' || depth > 8) return;
    const part = value as Record<string, unknown>;
    const headers = z
      .array(headerSchema)
      .max(200)
      .safeParse(part.headers ?? []);
    if (!headers.success) return;
    if (
      (typeof part.filename === 'string' && part.filename) ||
      part.mimeType === 'message/rfc822' ||
      headers.data.some(
        (header) =>
          header.name.toLowerCase() === 'content-disposition' &&
          /^\s*attachment\b/i.test(header.value),
      )
    )
      continue;
    if (Array.isArray(part.parts)) {
      if (part.parts.length > 50) return;
      queue.push(...part.parts.map((value) => ({ value, depth: depth + 1 })));
    }
    if (!['text/plain', 'text/html'].includes(String(part.mimeType))) continue;
    const data = (part.body as { data?: unknown } | undefined)?.data;
    if (typeof data !== 'string') continue;
    if (data.length > 100_000 || !/^[a-zA-Z0-9_=-]*$/.test(data)) return;
    const text = Buffer.from(data, 'base64url').toString('utf8');
    size += text.length;
    if (size > 64_000) return;
    (part.mimeType === 'text/plain' ? plain : html).push(
      part.mimeType === 'text/plain' ? text.replace(/^\s*>.*$/gm, '') : text,
    );
  }
  if (plain.length) return plain.join('\n');
  if (!html.length) return;
  const document = parseFragment(html.join('\n'));
  const nodes: unknown[] = [document];
  const output: string[] = [];
  let count = 0;
  type EmailNode = {
    nodeName?: string;
    value?: string;
    attrs?: Array<{ name: string; value: string }>;
    childNodes?: EmailNode[];
  };
  const quoted = (node: EmailNode) =>
    ['script', 'style', 'noscript', 'template', 'blockquote'].includes(node.nodeName ?? '') ||
    node.attrs?.some((attribute) =>
      attribute.name === 'type'
        ? attribute.value === 'cite'
        : attribute.name === 'class' &&
          /(?:^|\s)(?:gmail_quote|yahoo_quoted|protonmail_quote)(?:\s|$)/.test(attribute.value),
    );
  while (nodes.length) {
    if (++count > 3000) return;
    const node = nodes.shift() as EmailNode;
    if (quoted(node)) continue;
    if (node.nodeName === '#text') output.push(node.value ?? '');
    if (node.childNodes) nodes.unshift(...node.childNodes);
  }
  return output.join(' ');
}

export async function readVerificationEmails(
  client: Pick<Composio['tools'], 'proxyExecute'>,
  accountId: string,
  query: VerificationEmailQuery,
  signal: AbortSignal,
): Promise<VerificationEmail[] | undefined> {
  signal.throwIfAborted();
  const response = await client.proxyExecute(
    {
      connectedAccountId: accountId,
      endpoint: 'https://gmail.googleapis.com/gmail/v1/users/me/messages',
      method: 'GET',
      parameters: [
        {
          in: 'query',
          name: 'q',
          value: `to:${query.recipient} from:${query.senderDomain} after:${Math.floor(query.after / 1000)} before:${Math.ceil(query.before / 1000)}`,
        },
        { in: 'query', name: 'maxResults', value: 5 },
        { in: 'query', name: 'includeSpamTrash', value: 'false' },
        { in: 'query', name: 'fields', value: 'messages/id,nextPageToken' },
      ],
    },
    { signal },
  );
  signal.throwIfAborted();
  if (response.status !== 200) return;
  const list = z
    .object({
      messages: z
        .array(z.object({ id: z.string().regex(/^[a-zA-Z0-9_-]{1,200}$/) }))
        .max(5)
        .optional(),
      nextPageToken: z.string().optional(),
    })
    .safeParse(response.data);
  if (!list.success || list.data.nextPageToken) return;
  const results: VerificationEmail[] = [];
  for (const { id } of list.data.messages ?? []) {
    signal.throwIfAborted();
    const response = await client.proxyExecute(
      {
        connectedAccountId: accountId,
        endpoint: `https://gmail.googleapis.com/gmail/v1/users/me/messages/${id}`,
        method: 'GET',
        parameters: [{ in: 'query', name: 'format', value: 'full' }],
      },
      { signal },
    );
    signal.throwIfAborted();
    if (response.status !== 200 || JSON.stringify(response.data).length > 1_000_000) return;
    const parsed = messageSchema.safeParse(response.data);
    if (!parsed.success || parsed.data.id !== id) return;
    const value = parsed.data;
    if (value.labelIds?.some((label) => ['SPAM', 'TRASH', 'SENT', 'DRAFT'].includes(label)))
      continue;
    const headers = (name: string) =>
      value.payload.headers
        .filter((header) => header.name.toLowerCase() === name)
        .map((header) => header.value);
    const sender = headers('from');
    const recipients = headers('to')
      .flatMap((value) => value.split(','))
      .map(mailbox)
      .filter((value): value is string => Boolean(value));
    const address = sender.length === 1 ? mailbox(sender[0]) : undefined;
    const receivedAt = Number(value.internalDate);
    if (
      !address ||
      !recipients.includes(query.recipient) ||
      receivedAt < query.after ||
      receivedAt > query.before
    )
      continue;
    const firstAuthentication = headers('authentication-results')[0];
    const authentication =
      firstAuthentication && /^\s*mx\.google\.com\s*;/i.test(firstAuthentication)
        ? firstAuthentication.replace(/"(?:\\.|[^"\\])*"/g, '""')
        : undefined;
    const authenticatedDomain =
      authentication &&
      /(?:^|;)\s*dmarc=pass\b[^;]*\bheader\.from=([a-z0-9.-]+)(?:\s|;|$)/i
        .exec(authentication)?.[1]
        ?.toLowerCase();
    if (!authenticatedDomain) continue;
    const authenticatedSite = parse(authenticatedDomain, { allowPrivateDomains: true });
    const senderSite = parse(address.split('@')[1], { allowPrivateDomains: true });
    const expectedSite = parse(query.senderDomain, { allowPrivateDomains: true });
    if (
      !authenticatedSite.domain ||
      (!authenticatedSite.isIcann && !authenticatedSite.isPrivate) ||
      authenticatedSite.domain !== senderSite.domain ||
      senderSite.domain !== expectedSite.domain
    )
      continue;
    const body = messageText(value.payload);
    if (!body) continue;
    results.push({
      id,
      receivedAt,
      sender: address,
      recipients,
      authenticatedDomain,
      text: [headers('subject').join(' '), body].join('\n'),
    });
  }
  return results;
}
