import type { Composio } from '@composio/core';
import { z } from 'zod';
import type { InboxSnippet, InboxThread, SentEmail } from '../../ports/integrations.ts';
import { mailbox, messageSchema, messageText } from './verification-email.ts';

type Client = Pick<Composio['tools'], 'proxyExecute'>;
const messageList = (max: number) =>
  z.object({
    messages: z
      .array(z.object({ id: z.string().regex(/^[a-zA-Z0-9_-]{1,200}$/) }))
      .max(max)
      .default([]),
  });

const threadList = z.object({
  threads: z
    .array(z.object({ id: z.string().regex(/^[a-zA-Z0-9_-]{1,200}$/) }))
    .max(40)
    .default([]),
});
const threadSchema = z.object({ messages: z.array(messageSchema).min(1).max(100) });
type Message = z.infer<typeof messageSchema>;
const values = (message: Message, name: string) =>
  message.payload.headers
    .filter((header) => header.name.toLowerCase() === name)
    .map((header) => header.value);
const automated = (message: Message) =>
  values(message, 'auto-submitted').some((value) => !/^\s*no\b/i.test(value)) ||
  values(message, 'precedence').some((value) => /bulk|list|junk/i.test(value)) ||
  values(message, 'list-unsubscribe').length > 0;
const displayName = (value: string) =>
  /^\s*"?([^"<]*?)"?\s*<[^<>]+>\s*$/.exec(value)?.[1]?.trim() ?? '';
const sent = (message: Message) => message.labelIds?.includes('SENT') ?? false;

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

export async function readInboxThreads(
  client: Client,
  accountId: string,
  signal: AbortSignal,
): Promise<InboxThread[]> {
  const get = gmail(client, accountId, signal);
  const list = threadList.parse(
    await get('threads', [
      ['q', 'in:inbox newer_than:30d -category:promotions -category:social -category:forums'],
      ['maxResults', 40],
      ['fields', 'threads/id'],
    ]),
  );
  const threads: InboxThread[] = [];
  for (let start = 0; start < list.threads.length; start += 8) {
    const batch = await Promise.all(
      list.threads.slice(start, start + 8).map(async ({ id }): Promise<InboxThread[]> => {
        const thread = threadSchema.safeParse(
          await get(`threads/${id}`, [['format', 'full']]).catch(() => signal.throwIfAborted()),
        );
        if (!thread.success) return [];
        const messages = thread.data.messages.filter(
          (message) => !message.labelIds?.includes('DRAFT'),
        );
        const latest = messages.at(-1);
        if (!latest) return [];
        const theirs = messages.findLast((message) => !sent(message));
        if (!theirs) return [];
        const labels = new Set(messages.flatMap((message) => message.labelIds ?? []));
        return [
          {
            subject: values(messages[0], 'subject')[0] ?? '',
            from: displayName(values(theirs, 'from')[0] ?? ''),
            received: new Date(Number(latest.internalDate)).toISOString(),
            messages: messages.length,
            waitingOnYou: !sent(latest),
            flagged: labels.has('STARRED') || labels.has('IMPORTANT'),
            automated: automated(theirs),
            text: messageText(theirs.payload) ?? '',
          },
        ];
      }),
    );
    threads.push(...batch.flat());
  }
  return threads;
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
    const text = messageText(message.data.payload);
    if (!text) continue;
    emails.push({
      from: mailbox(values(message.data, 'from')[0] ?? '') ?? '',
      to: [...values(message.data, 'to'), ...values(message.data, 'cc')]
        .flatMap((value) => value.split(','))
        .flatMap((value) => mailbox(value) ?? []),
      automated: automated(message.data),
      text,
    });
  }
  return emails;
}
