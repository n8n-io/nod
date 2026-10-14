import type { Composio } from '@composio/core';
import { z } from 'zod';
import type { InboxSnippet, SentEmail } from '../../ports/integrations.ts';
import { mailbox, messageSchema, messageText } from './verification-email.ts';

type Client = Pick<Composio['tools'], 'proxyExecute'>;
const messageList = (max: number) =>
  z.object({
    messages: z
      .array(z.object({ id: z.string().regex(/^[a-zA-Z0-9_-]{1,200}$/) }))
      .max(max)
      .default([]),
  });

function gmail(client: Client, accountId: string, signal: AbortSignal) {
  return async (path: string, parameters: Array<[string, string | number]>) => {
    signal.throwIfAborted();
    const response = await client.proxyExecute(
      {
        connectedAccountId: accountId,
        endpoint: `https://gmail.googleapis.com/gmail/v1/users/me/${path}`,
        method: 'GET',
        parameters: parameters.map(([name, value]) => ({ in: 'query', name, value })),
      },
      { signal },
    );
    signal.throwIfAborted();
    if (response.status !== 200) throw new Error('Gmail did not answer.');
    return JSON.stringify(response.data).length > 1_000_000 ? undefined : response.data;
  };
}

export async function readInboxSnippets(
  client: Client,
  accountId: string,
  signal: AbortSignal,
): Promise<InboxSnippet[]> {
  const get = gmail(client, accountId, signal);
  const list = messageList(15).parse(
    await get('messages', [
      ['q', 'in:inbox newer_than:14d -category:promotions -category:social -category:forums'],
      ['maxResults', 15],
      ['fields', 'messages/id'],
    ]),
  );
  const messages = await Promise.all(
    list.messages.map(async ({ id }) =>
      z
        .object({
          snippet: z.string().max(2000).default(''),
          payload: z
            .object({
              headers: z.array(z.object({ name: z.string(), value: z.string().max(2000) })).max(50),
            })
            .optional(),
        })
        .safeParse(
          await get(`messages/${id}`, [
            ['format', 'metadata'],
            ['metadataHeaders', 'Subject'],
            ['fields', 'snippet,payload/headers'],
          ]),
        ),
    ),
  );
  return messages.flatMap((message) =>
    message.success
      ? [
          {
            subject:
              message.data.payload?.headers.find(
                (header) => header.name.toLowerCase() === 'subject',
              )?.value ?? '',
            snippet: message.data.snippet,
          },
        ]
      : [],
  );
}

export async function readSentEmails(
  client: Client,
  accountId: string,
  signal: AbortSignal,
): Promise<SentEmail[]> {
  const get = gmail(client, accountId, signal);
  const list = messageList(30).parse(
    await get('messages', [
      ['q', 'in:sent'],
      ['maxResults', 30],
      ['fields', 'messages/id'],
    ]),
  );
  const emails: SentEmail[] = [];
  for (const { id } of list.messages) {
    const message = messageSchema.safeParse(await get(`messages/${id}`, [['format', 'full']]));
    if (!message.success || message.data.labelIds?.includes('DRAFT')) continue;
    const headers = (name: string) =>
      message.data.payload.headers
        .filter((header) => header.name.toLowerCase() === name)
        .map((header) => header.value);
    const text = messageText(message.data.payload);
    if (!text) continue;
    emails.push({
      from: mailbox(headers('from')[0] ?? '') ?? '',
      to: [...headers('to'), ...headers('cc')]
        .flatMap((value) => value.split(','))
        .flatMap((value) => mailbox(value) ?? []),
      automated:
        headers('auto-submitted').some((value) => !/^\s*no\b/i.test(value)) ||
        headers('precedence').some((value) => /bulk|list|junk/i.test(value)) ||
        headers('list-unsubscribe').length > 0,
      text,
    });
  }
  return emails;
}
