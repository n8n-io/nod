import { z } from 'zod';
import type { ChannelPairingRequest, MessagingAttachment } from '../../ports/messaging.ts';

const telegramFile = z.object({
  file_id: z.string().min(1).max(512),
  file_size: z.number().int().nonnegative().optional(),
  file_name: z.string().min(1).max(255).optional(),
  mime_type: z.string().min(1).max(200).optional(),
});

export const telegramMessage = z.object({
  message_id: z.number().int().nonnegative(),
  reply_to_message: z
    .object({ message_id: z.number().int().nonnegative() })
    .passthrough()
    .optional(),
  date: z.number().int().positive(),
  text: z.string().trim().max(100_000).default(''),
  caption: z.string().max(100_000).optional(),
  photo: z.array(telegramFile).max(32).optional(),
  document: telegramFile.optional(),
  video: telegramFile.optional(),
  audio: telegramFile.optional(),
  voice: telegramFile.optional(),
  animation: telegramFile.optional(),
  video_note: telegramFile.optional(),
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

export function telegramAttachments(
  message: z.infer<typeof telegramMessage>,
  token: string,
  request: typeof fetch,
): MessagingAttachment[] {
  const file =
    message.photo?.at(-1) ??
    message.document ??
    message.video ??
    message.audio ??
    message.voice ??
    message.animation ??
    message.video_note;
  if (!file) return [];
  const image = Boolean(message.photo?.length);
  const video = Boolean(message.video || message.video_note || message.animation);
  const voice = Boolean(message.voice);
  const mimeType = image
    ? 'image/jpeg'
    : (file.mime_type ?? (voice ? 'audio/ogg' : video ? 'video/mp4' : 'application/octet-stream'));
  return [
    {
      name:
        file.file_name ??
        (image ? 'photo.jpg' : voice ? 'voice.ogg' : video ? 'video.mp4' : 'file'),
      mimeType,
      size: file.file_size ?? 0,
      ...(voice ? { voice: true } : {}),
      async read(signal) {
        const operation = AbortSignal.any([
          AbortSignal.timeout(60_000),
          ...(signal ? [signal] : []),
        ]);
        if ((file.file_size ?? 0) > 20 * 1024 * 1024)
          throw new Error('The Telegram file is too large.');
        const info = await request(`https://api.telegram.org/bot${token}/getFile`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ file_id: file.file_id }),
          signal: operation,
          redirect: 'error',
        });
        if (!info.ok) throw new Error('The Telegram file is unavailable.');
        const parsed = z
          .object({
            ok: z.literal(true),
            result: z.object({
              file_path: z.string().max(2048),
              file_size: z.number().int().nonnegative().optional(),
            }),
          })
          .parse(await info.json());
        const segments = parsed.result.file_path.split('/');
        if (
          segments.some(
            (segment) => !/^[A-Za-z0-9_.-]+$/.test(segment) || segment === '.' || segment === '..',
          ) ||
          (parsed.result.file_size ?? 0) > 20 * 1024 * 1024
        )
          throw new Error('The Telegram file is unavailable.');
        const response = await request(
          `https://api.telegram.org/file/bot${token}/${segments.map(encodeURIComponent).join('/')}`,
          { signal: operation, redirect: 'error' },
        );
        if (
          !response.ok ||
          !response.body ||
          Number(response.headers.get('content-length') ?? 0) > 20 * 1024 * 1024
        )
          throw new Error('The Telegram file is unavailable.');
        const reader = response.body.getReader();
        const chunks: Uint8Array[] = [];
        let size = 0;
        try {
          for (;;) {
            operation.throwIfAborted();
            const next = await reader.read();
            if (next.done) break;
            size += next.value.length;
            if (size > 20 * 1024 * 1024) throw new Error('The Telegram file is too large.');
            chunks.push(next.value);
          }
        } finally {
          await reader.cancel().catch(() => {});
          reader.releaseLock();
        }
        return Buffer.concat(chunks, size);
      },
    },
  ];
}

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
