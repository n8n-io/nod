import type { Composio } from '@composio/core';
import { parseFragment } from 'parse5';
import { z } from 'zod';

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
