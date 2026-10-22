import { z } from 'zod';
import type { ChannelPairingRequest } from '../../ports/messaging.ts';

export const telegramMessage = z.object({
  message_id: z.number().int().nonnegative(),
  reply_to_message: z
    .object({ message_id: z.number().int().nonnegative() })
    .passthrough()
    .optional(),
  date: z.number().int().positive(),
  text: z.string().trim().min(1),
  from: z.object({
    id: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
    is_bot: z.literal(false),
    first_name: z.string(),
    last_name: z.string().optional(),
    username: z.string().optional(),
  }),
  chat: z.object({
    id: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
    type: z.literal('private'),
  }),
});

export function telegramPairing(
  raw: unknown,
  accountId: string,
  parseMessage: (message: z.infer<typeof telegramMessage>) => {
    id: string;
    threadId: string;
    metadata: { dateSent: Date };
  },
): ChannelPairingRequest | undefined {
  const parsed = telegramMessage.safeParse(raw);
  if (!parsed.success || parsed.data.from.id !== parsed.data.chat.id) return undefined;
  const code = /^\/start\s+([A-Za-z0-9_-]{16,64})$/.exec(parsed.data.text)?.[1];
  if (!code) return undefined;
  const { username, first_name, last_name } = parsed.data.from;
  const message = parseMessage(parsed.data);
  return {
    channelId: 'telegram',
    accountId,
    senderId: String(parsed.data.from.id),
    senderName:
      [first_name, last_name].filter(Boolean).join(' ').trim().slice(0, 200) ||
      'your Telegram account',
    ...(username && /^[A-Za-z0-9_]{1,64}$/.test(username) ? { senderUsername: username } : {}),
    messageId: message.id,
    threadId: message.threadId,
    code,
    sentAt: message.metadata.dateSent,
  };
}
