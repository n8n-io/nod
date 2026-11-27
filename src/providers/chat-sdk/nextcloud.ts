import type { Pool } from 'pg';
import { z } from 'zod';
import { nextcloudServer, nextcloudUserId } from '../../ports/channel-settings.ts';
import { logRepeatedFailure } from '../../ports/failure-log.ts';
import type {
  InboundMessage,
  MessagingChannel,
  MessagingTransport,
} from '../../ports/messaging.ts';
import { MessagingConnectionError } from '../../ports/messaging.ts';
import { errorCode } from '../../shared/error-code.ts';
import { modelErrorText } from '../model-error.ts';
import { hasLiteralBlock } from './format.ts';

type Environment = Record<string, string | undefined>;

export const nextcloudTextLimit = 32_000;
const roomToken = /^[A-Za-z0-9]{4,64}$/;
const mentionTypes = new Set(['user', 'guest', 'call', 'user-group', 'group', 'email', 'circle']);
const offsetLifetime = "interval '24 hours'";

const ocsMeta = z.object({
  ocs: z.object({
    meta: z.object({
      statuscode: z.number().int().optional(),
      message: z.string().max(2000).nullish(),
    }),
  }),
});
const ocsData = <T extends z.ZodType>(data: T) => z.object({ ocs: z.object({ data }) });
const talkRoom = z
  .object({
    token: z.string().regex(roomToken),
    type: z.number().int(),
    displayName: z.string().max(200).optional(),
    lastMessage: z
      .union([z.object({ id: z.number().int().nonnegative() }).passthrough(), z.array(z.never())])
      .optional(),
  })
  .passthrough();
const talkParameter = z
  .object({ type: z.string().max(64), name: z.string().max(500).optional() })
  .passthrough();
export const talkMessage = z
  .object({
    id: z.number().int().positive(),
    actorType: z.string().max(64),
    actorId: z.string().max(255),
    timestamp: z.number().int().nonnegative(),
    message: z.string().max(100_000),
    messageType: z.string().max(64),
    systemMessage: z.string().max(128).default(''),
    messageParameters: z
      .union([z.record(z.string(), talkParameter), z.array(z.never())])
      .optional(),
    parent: z.object({ id: z.number().int().positive() }).passthrough().optional(),
  })
  .passthrough();

export function nextcloudAuthorization(user: string, appPassword: string) {
  return `Basic ${Buffer.from(`${user}:${appPassword}`).toString('base64')}`;
}

export async function nextcloudFailure(
  response: Response,
  action: string,
  secrets: string[],
): Promise<MessagingConnectionError> {
  const body = ocsMeta.safeParse(await response.json().catch(() => undefined));
  const code = body.success ? body.data.ocs.meta.statuscode : undefined;
  const reason = body.success ? body.data.ocs.meta.message?.trim() : undefined;
  return new MessagingConnectionError(
    modelErrorText(
      `Nextcloud Talk ${action} failed (HTTP ${response.status}${code && code !== response.status ? `, OCS ${code}` : ''})${reason ? `: ${reason}` : '.'}`,
      secrets,
    ),
  );
}

export function talkText(message: z.infer<typeof talkMessage>) {
  const parameters = Array.isArray(message.messageParameters)
    ? {}
    : (message.messageParameters ?? {});
  if (Object.values(parameters).some((parameter) => parameter.type === 'file')) return undefined;
  return message.message
    .replace(/\{([A-Za-z0-9_-]{1,64})\}/g, (match, key: string) => {
      const parameter = parameters[key];
      if (!parameter?.name) return match;
      return mentionTypes.has(parameter.type) ? `@${parameter.name}` : parameter.name;
    })
    .trim();
}

export function talkChunks(text: string, limit = nextcloudTextLimit) {
  const parts: string[] = [];
  let rest = text.trim();
  const graphemes = new Intl.Segmenter(undefined, { granularity: 'grapheme' });
  while (rest.length > limit) {
    const slice = rest.slice(0, limit);
    let cut = slice.lastIndexOf('\n\n');
    if (cut < limit / 2) cut = slice.lastIndexOf('\n');
    if (cut < limit / 2) cut = limit;
    let boundary = 0;
    for (const { index, segment } of graphemes.segment(rest)) {
      if (index + segment.length > cut) break;
      boundary = index + segment.length;
    }
    cut = boundary || cut;
    parts.push(rest.slice(0, cut).trimEnd());
    rest = rest.slice(cut).trimStart();
  }
  return rest ? [...parts, rest] : parts;
}

export function nextcloudConfiguration(env: Environment) {
  const enabled = env.NEXTCLOUD_ENABLED === 'true';
  const missing = [
    'NEXTCLOUD_URL',
    'NEXTCLOUD_USER',
    'NEXTCLOUD_APP_PASSWORD',
    'NEXTCLOUD_ALLOWED_USER',
  ].filter((key) => !env[key]);
  if (env.NEXTCLOUD_URL && !nextcloudServer(env.NEXTCLOUD_URL)) missing.push('NEXTCLOUD_URL');
  for (const key of ['NEXTCLOUD_USER', 'NEXTCLOUD_ALLOWED_USER'])
    if (env[key] && !nextcloudUserId.test(env[key])) missing.push(key);
  if (env.NEXTCLOUD_USER && env.NEXTCLOUD_USER === env.NEXTCLOUD_ALLOWED_USER)
    missing.push('NEXTCLOUD_ALLOWED_USER');
  return {
    status: (!enabled
      ? 'disabled'
      : missing.length
        ? 'setup_required'
        : 'configured') as MessagingChannel['status'],
    missing: enabled ? [...new Set(missing)] : [],
  };
}

export function createNextcloudTalkTransport(
  pool: Pick<Pool, 'query'>,
  env: Environment,
  options: { fetch?: typeof fetch; pollTimeoutSeconds?: number } = {},
): MessagingTransport {
  const request = options.fetch ?? fetch;
  const pollTimeout = options.pollTimeoutSeconds ?? 30;
  const configuration = nextcloudConfiguration(env);
  const server = nextcloudServer(env.NEXTCLOUD_URL);
  const user = env.NEXTCLOUD_USER ?? '';
  const owner = env.NEXTCLOUD_ALLOWED_USER ?? '';
  const appPassword = env.NEXTCLOUD_APP_PASSWORD ?? '';
  const authorization = nextcloudAuthorization(user, appPassword);
  const secrets = [appPassword, authorization, authorization.slice(6)];
  const configured = configuration.status === 'configured' && Boolean(server);
  const accountId = configured ? `${user}@${new URL(server!).host}` : undefined;
  const channel: MessagingChannel = {
    id: 'nextcloud',
    status: configuration.status,
    missing: configuration.missing,
    ...(accountId ? { accountId } : {}),
    allowedSenderIds: configured ? [owner] : [],
    supportsAttachments: false,
    ...(configured ? { available: false } : {}),
  };
  const lifetime = new AbortController();
  let closed = false;
  let polling = false;
  let token: string | undefined;
  let fetching: Promise<void> | undefined;
  let fetched: Array<{ id: number; message?: InboundMessage }> = [];
  let fetchFailure: MessagingConnectionError | undefined;
  let processed: (() => void) | undefined;
  let inputListener: (() => void) | undefined;
  let offsetsReady: Promise<unknown> | undefined;

  function ocs(
    path: string,
    init: {
      method?: string;
      body?: object;
      query?: Record<string, string>;
      timeoutMs?: number;
    } = {},
  ) {
    const url = new URL(`${server}/ocs/v2.php${path}`);
    for (const [name, value] of Object.entries(init.query ?? {})) url.searchParams.set(name, value);
    return request(url, {
      method: init.method ?? 'GET',
      headers: {
        Authorization: authorization,
        'OCS-APIRequest': 'true',
        Accept: 'application/json',
        ...(init.body ? { 'Content-Type': 'application/json' } : {}),
      },
      ...(init.body ? { body: JSON.stringify(init.body) } : {}),
      signal: AbortSignal.any([lifetime.signal, AbortSignal.timeout(init.timeoutMs ?? 15_000)]),
      redirect: 'error',
    });
  }

  async function savedOffset() {
    offsetsReady ??= pool
      .query(
        `CREATE TABLE IF NOT EXISTS channel_poll_offsets(provider text NOT NULL,account_id text NOT NULL,next_offset bigint NOT NULL,PRIMARY KEY(provider,account_id));
         ALTER TABLE channel_poll_offsets ADD COLUMN IF NOT EXISTS updated_at timestamptz`,
      )
      .catch((error) => {
        offsetsReady = undefined;
        throw error;
      });
    await offsetsReady;
    const saved = await pool.query<{ next_offset: string }>(
      `SELECT next_offset FROM channel_poll_offsets WHERE provider='nextcloud' AND account_id=$1 AND updated_at > now() - ${offsetLifetime}`,
      [accountId],
    );
    return saved.rows[0] ? Number(saved.rows[0].next_offset) : undefined;
  }

  async function saveOffset(id: number) {
    await pool.query(
      `INSERT INTO channel_poll_offsets(provider,account_id,next_offset,updated_at) VALUES('nextcloud',$1,$2,now())
       ON CONFLICT(provider,account_id) DO UPDATE SET next_offset=CASE WHEN channel_poll_offsets.updated_at > now() - ${offsetLifetime} THEN GREATEST(channel_poll_offsets.next_offset,EXCLUDED.next_offset) ELSE EXCLUDED.next_offset END,updated_at=now()`,
      [accountId, id],
    );
  }

  async function conversation() {
    const response = await ocs('/apps/spreed/api/v4/room', {
      method: 'POST',
      body: { roomType: 1, invite: owner },
    });
    if (!response.ok) throw await nextcloudFailure(response, 'conversation lookup', secrets);
    const room = ocsData(talkRoom).parse(await response.json()).ocs.data;
    if (room.type !== 1)
      throw new MessagingConnectionError(
        'Nextcloud Talk did not return a one-to-one conversation.',
      );
    return room;
  }

  const dropped = (reason: string) =>
    logRepeatedFailure('channel_inbound_dropped', `nextcloud:${reason}`, undefined, {
      provider: 'nextcloud',
      reason,
    });

  function inbound(raw: unknown, room: string): { id: number; message?: InboundMessage } | null {
    const parsed = talkMessage.safeParse(raw);
    if (!parsed.success) {
      dropped('unsupported_message');
      const id = z.object({ id: z.number().int().positive() }).safeParse(raw);
      return id.success ? { id: id.data.id } : null;
    }
    const message = parsed.data;
    const skip = { id: message.id };
    if (message.actorType === 'users' && message.actorId === user) return skip;
    if (message.systemMessage || message.messageType !== 'comment') return skip;
    if (message.actorType !== 'users' || message.actorId !== owner) {
      dropped('unknown_sender');
      return skip;
    }
    const text = talkText(message);
    if (!text) {
      dropped('unsupported_type');
      return skip;
    }
    return {
      id: message.id,
      message: {
        channelId: 'nextcloud',
        accountId: accountId!,
        senderId: message.actorId,
        messageId: String(message.id),
        threadId: room,
        text,
        ...(message.parent ? { replyToMessageId: String(message.parent.id) } : {}),
        sentAt: new Date(message.timestamp * 1000),
      },
    };
  }

  async function fetchMessages() {
    let failures = 0;
    let lastKnown: number | undefined;
    while (!closed) {
      if (fetched.length) {
        await new Promise<void>((resolve) => {
          processed = resolve;
        });
        continue;
      }
      let requesting = false;
      try {
        if (!token) {
          requesting = true;
          const room = await conversation();
          token = room.token;
          requesting = false;
          lastKnown =
            (await savedOffset()) ??
            (Array.isArray(room.lastMessage) ? 0 : (room.lastMessage?.id ?? 0));
        }
        lastKnown ??= (await savedOffset()) ?? 0;
        requesting = true;
        const response = await ocs(`/apps/spreed/api/v1/chat/${token}`, {
          query: {
            lookIntoFuture: '1',
            timeout: String(pollTimeout),
            limit: '100',
            lastKnownMessageId: String(lastKnown),
            setReadMarker: '1',
            includeLastKnown: '0',
          },
          timeoutMs: (pollTimeout + 15) * 1000,
        });
        if (response.status === 404) token = undefined;
        if (response.status !== 304 && !response.ok)
          throw await nextcloudFailure(response, 'message polling', secrets);
        failures = 0;
        fetchFailure = undefined;
        channel.available = true;
        channel.error = undefined;
        if (response.status === 304) continue;
        const messages = ocsData(z.array(z.unknown()).max(200)).parse(await response.json()).ocs
          .data;
        const room = token!;
        const next = messages
          .map((raw) => inbound(raw, room))
          .filter((item): item is NonNullable<typeof item> => item !== null)
          .sort((left, right) => left.id - right.id);
        if (!next.length && messages.length)
          throw new MessagingConnectionError('Nextcloud Talk returned messages without IDs.');
        if (next.length) {
          lastKnown = Math.max(lastKnown, ...next.map((item) => item.id));
          fetched = next;
          inputListener?.();
        }
      } catch (cause) {
        if (closed) return;
        const code = errorCode(cause);
        const detail = code ? ` (${code})` : '';
        fetchFailure =
          cause instanceof MessagingConnectionError
            ? cause
            : new MessagingConnectionError(
                requesting
                  ? `Nextcloud Talk could not receive messages${detail}. Select Reconnect.`
                  : `Nextcloud Talk message processing failed${detail}.`,
              );
        if (requesting) {
          channel.available = false;
          channel.error = fetchFailure.message;
        }
        inputListener?.();
        await new Promise<void>((resolve) => {
          const done = () => {
            clearTimeout(timer);
            lifetime.signal.removeEventListener('abort', done);
            resolve();
          };
          const timer = setTimeout(done, Math.min(30_000, 1000 * 2 ** failures++));
          lifetime.signal.addEventListener('abort', done, { once: true });
        });
      }
    }
  }

  function target(input: { channelId: string; accountId: string; threadId: string }) {
    if (
      !configured ||
      input.channelId !== 'nextcloud' ||
      input.accountId !== accountId ||
      !roomToken.test(input.threadId) ||
      (token && input.threadId !== token)
    )
      throw new Error('Channel is not configured.');
  }

  async function send(threadId: string, message: string, replyTo?: string) {
    const response = await ocs(`/apps/spreed/api/v1/chat/${threadId}`, {
      method: 'POST',
      body: {
        message,
        ...(replyTo && /^\d{1,18}$/.test(replyTo) ? { replyTo: Number(replyTo) } : {}),
      },
      timeoutMs: 30_000,
    });
    if (!response.ok) throw await nextcloudFailure(response, 'message delivery', secrets);
    const sent = ocsData(z.object({ id: z.number().int().positive() }).passthrough()).parse(
      await response.json(),
    );
    return String(sent.ocs.data.id);
  }

  return {
    get channels() {
      return [channel];
    },
    canDeliverLiteral({ channelId, text, literal }) {
      return (
        channelId === 'nextcloud' && talkChunks(text).length === 1 && hasLiteralBlock(text, literal)
      );
    },
    onInput(listener) {
      inputListener = listener;
    },
    async poll(accept) {
      if (closed || polling || !configured) return;
      fetching ??= fetchMessages();
      polling = true;
      try {
        if (fetchFailure) {
          const failure = fetchFailure;
          fetchFailure = undefined;
          throw failure;
        }
        while (fetched.length && !closed) {
          const item = fetched[0]!;
          if (item.message) await accept(item.message);
          await saveOffset(item.id);
          fetched.shift();
        }
        if (!fetched.length) {
          processed?.();
          processed = undefined;
        }
      } catch (cause) {
        if (cause instanceof MessagingConnectionError) throw cause;
        const code = errorCode(cause);
        throw new MessagingConnectionError(
          `Nextcloud Talk message processing failed${code ? ` (${code})` : ''}.`,
        );
      } finally {
        polling = false;
      }
    },
    async receive() {
      return { status: 404, body: { error: 'Nextcloud Talk does not use a webhook.' } };
    },
    async post(input) {
      target(input);
      const ids: string[] = [];
      for (const part of talkChunks(input.text))
        ids.push(await send(input.threadId, part, ids.length ? undefined : input.replyToMessageId));
      if (input.attachments?.length) {
        const notice = await input
          .attachmentFailure?.(input.attachments.map((file) => ({ name: file.name })))
          .catch(() => undefined);
        for (const part of talkChunks(notice ?? ''))
          ids.push(await send(input.threadId, part).catch(() => ''));
      }
      const delivered = ids.filter(Boolean);
      if (!delivered.length) throw new Error('Channel delivery was not confirmed.');
      return { id: delivered[0]!, ids: delivered };
    },
    async react(input) {
      target(input);
      input.signal?.throwIfAborted();
      if (!input.reaction || !/^\d{1,18}$/.test(input.messageId)) return 'unsupported';
      const response = await ocs(
        `/apps/spreed/api/v1/reaction/${input.threadId}/${input.messageId}`,
        { method: 'POST', body: { reaction: input.reaction } },
      );
      if (!response.ok) throw await nextcloudFailure(response, 'reaction', secrets);
      return 'sent';
    },
    async close() {
      if (closed) return;
      closed = true;
      lifetime.abort();
      processed?.();
      await fetching;
    },
  };
}
