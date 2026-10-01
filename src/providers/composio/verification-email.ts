import type { Composio } from '@composio/core';
import { parseFragment } from 'parse5';
import { z } from 'zod';
import { parse } from 'tldts';
import type { VerificationEmail, VerificationEmailQuery } from '../../ports/integrations.ts';

const mailbox = (value: string) => {
  if (/[,;\r\n]/.test(value)) return;
  const address = (/<([^<>\s]+@[^<>\s]+)>/.exec(value)?.[1] ?? value).trim().toLowerCase();
  return z.email().max(320).safeParse(address).success ? address : undefined;
};
const headerSchema = z.object({ name: z.string().max(100), value: z.string().max(8192) });
const messageSchema = z.object({
  id: z.string().regex(/^[a-zA-Z0-9_-]{1,200}$/),
  internalDate: z.string().regex(/^\d{1,16}$/),
  labelIds: z.array(z.string()).max(100).optional(),
  payload: z.object({ headers: z.array(headerSchema).max(200) }).passthrough(),
});

function messageContent(payload: unknown) {
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
  if (!plain.length && !html.length) return;
  const verificationOrigins = new Set<string>();
  const addOrigin = (value: string, label: string) => {
    if (
      value.length > 2048 ||
      !/^\s*(?:verify|confirm|activate|sign[ -]?in|log[ -]?in|verificar|confirmar|ativar|iniciar sess[aã]o)\b/i.test(
        label,
      )
    )
      return;
    try {
      const url = new URL(value);
      if (
        url.protocol !== 'https:' ||
        url.username ||
        url.password ||
        [...url.searchParams.values()].some((value) => /https?:\/\//i.test(value))
      )
        return;
      if (
        [...url.searchParams].some(([name, value]) => {
          const parameter = name.toLowerCase().replaceAll(/[-_]/g, '');
          if (
            ['token', 'emailtoken', 'verificationtoken', 'logintoken', 'signintoken'].includes(
              parameter,
            )
          )
            return /^[a-z0-9._~+-]{16,2048}$/i.test(value);
          return (
            ['code', 'emailcode', 'verificationcode'].includes(parameter) &&
            /^(?:\d{4,8}|[a-z0-9_-]{8,256})$/i.test(value)
          );
        })
      )
        verificationOrigins.add(url.origin);
    } catch {}
  };
  for (const text of plain)
    for (const match of text.matchAll(/(?:^|[\s(<])(https?:\/\/[^\s<>"']+)/giu)) {
      const before = text.slice(Math.max(0, match.index - 200), match.index);
      const label =
        before
          .replace(/[\s([]+$/u, '')
          .split(/[.!?\r\n]/u)
          .at(-1) ?? '';
      addOrigin(match[1].replace(/[),.;!?]+$/u, ''), label);
    }
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
    if (node.nodeName === 'a') {
      const href = node.attrs?.find((attribute) => attribute.name === 'href')?.value;
      if (href) {
        const content = [...(node.childNodes ?? [])];
        let label = '';
        let visited = 0;
        while (content.length && ++visited < 100 && label.length < 300) {
          const child = content.shift()!;
          if (quoted(child)) continue;
          if (child.nodeName === '#text') label += child.value ?? '';
          if (child.childNodes) content.unshift(...child.childNodes);
        }
        addOrigin(href, label);
      }
    }
    if (node.childNodes) nodes.unshift(...node.childNodes);
  }
  if (verificationOrigins.size > 100) return;
  return {
    text: plain.length ? plain.join('\n') : output.join(' '),
    verificationOrigins: [...verificationOrigins],
  };
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
          value: `to:${query.recipient} after:${Math.floor(query.after / 1000)} before:${Math.ceil(query.before / 1000)}`,
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
        ? firstAuthentication
        : undefined;
    const authenticatedDomain =
      authentication &&
      /(?:^|;)\s*dmarc=pass\b[^;]*\bheader\.from=([a-z0-9.-]+)(?:\s|;|$)/i
        .exec(authentication)?.[1]
        ?.toLowerCase();
    if (!authenticatedDomain) continue;
    const authenticatedSite = parse(authenticatedDomain, { allowPrivateDomains: true });
    const senderSite = parse(address.split('@')[1], { allowPrivateDomains: true });
    if (
      !authenticatedSite.domain ||
      (!authenticatedSite.isIcann && !authenticatedSite.isPrivate) ||
      authenticatedSite.domain !== senderSite.domain
    )
      continue;
    const body = messageContent(value.payload);
    if (!body?.text) continue;
    results.push({
      id,
      receivedAt,
      sender: address,
      recipients,
      authenticatedDomain,
      verificationOrigins: body.verificationOrigins,
      text: [headers('subject').join(' '), body.text].join('\n'),
    });
  }
  return results;
}
