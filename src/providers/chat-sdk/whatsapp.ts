import makeWASocket, {
  BufferJSON,
  DisconnectReason,
  downloadMediaMessage,
  generateMessageIDV2,
  initAuthCreds,
  jidNormalizedUser,
  normalizeMessageContent,
  proto,
  type AuthenticationState,
  type SocketConfig,
  type WASocket,
  type WAMessage,
} from '@whiskeysockets/baileys';
import { randomUUID } from 'node:crypto';
import { parseMarkdown, type Root } from 'chat';
import { splitMessage } from '@chat-adapter/whatsapp';
import type { ChannelSession, ChannelSessionStore } from '../../ports/channel-session.ts';
import { MessagingAttachmentError } from '../../ports/messaging.ts';
import type {
  InboundMessage,
  InboundReaction,
  MessagingAttachment,
  MessagingChannel,
  MessagingTransport,
} from '../../ports/messaging.ts';
import type { ChannelLinkStatus } from '../../shared/contracts.ts';
import { contactAttachment, locationAttachment } from './content.ts';
import { contactCards, sharedLocation } from '../../shared/channel-content.ts';

const silent: SocketConfig['logger'] = {
  level: 'silent',
  child() {
    return this;
  },
  trace() {},
  debug() {},
  info() {},
  warn() {},
  error() {},
};
const numberOf = (jid: string | null | undefined) => {
  const normalized = jid ? jidNormalizedUser(jid) : '';
  return /^\d{7,15}@s\.whatsapp\.net$/.test(normalized) ? normalized.split('@')[0] : undefined;
};
const qrLifetimeMs = 60_000;

export function whatsappText(text: string) {
  type Node = Root | Root['children'][number];
  function render(node: Node): string {
    const children =
      'children' in node ? node.children.map((child) => render(child as Node)).join('') : '';
    const value = 'value' in node ? String(node.value) : '';
    switch (node.type) {
      case 'root':
        return children.trim();
      case 'paragraph':
        return `${children}\n\n`;
      case 'strong':
      case 'heading':
        return `*${children.trim()}*${node.type === 'heading' ? '\n\n' : ''}`;
      case 'emphasis':
        return `_${children}_`;
      case 'delete':
        return `~${children}~`;
      case 'code':
        return `\`\`\`\n${value}\n\`\`\`\n\n`;
      case 'inlineCode':
        return `\`\`\`${value}\`\`\``;
      case 'link':
        return `${children} (${node.url})`;
      case 'image':
        return `${node.alt || 'Image'} (${node.url})`;
      case 'listItem':
        return `- ${children.trim()}\n`;
      case 'list':
        return `${children}\n`;
      case 'blockquote':
        return `${children
          .trim()
          .split('\n')
          .map((line) => `> ${line}`)
          .join('\n')}\n\n`;
      case 'break':
        return '\n';
      case 'tableCell':
        return `${children.trim()} | `;
      case 'tableRow':
        return `${children.trim()}\n`;
      case 'table':
        return `${children}\n`;
      default:
        return value || children;
    }
  }
  return render(parseMarkdown(text));
}

type Socket = Pick<
  WASocket,
  'ev' | 'sendMessage' | 'sendPresenceUpdate' | 'logout' | 'end' | 'user' | 'signalRepository'
>;

export function createWhatsAppLinkedTransport(options: {
  mode: 'bot' | 'self-chat';
  allowedNumber?: string;
  store: ChannelSessionStore;
  createSocket?: (configuration: Parameters<typeof makeWASocket>[0]) => Socket;
  download?: typeof downloadMediaMessage;
}): MessagingTransport {
  let socket: Socket | undefined;
  let session: ChannelSession | undefined;
  let cleared: Promise<void> | undefined;
  let logoutStarted = false;
  let auth: AuthenticationState;
  let starting: Promise<void> | undefined;
  let closed = false;
  let halted = false;
  let writes = Promise.resolve();
  let reconnect: ReturnType<typeof setTimeout> | undefined;
  let expiry: ReturnType<typeof setTimeout> | undefined;
  let attempt = 0;
  let linkedAt = 0;
  let state: ChannelLinkStatus = { state: 'connecting' };
  const lifetime = new AbortController();
  const pairingId = randomUUID();
  const sentIds = new Set<string>();
  const incoming: InboundMessage[] = [];
  const reactions: InboundReaction[] = [];
  let received = Promise.resolve();
  let queued = 0;
  const channel: MessagingChannel = {
    id: 'whatsapp',
    status: 'setup_required',
    missing: [],
    allowedSenderIds: [],
    supportsAttachments: true,
    presenceMs: 4000,
    available: false,
  };

  function stop(next: ChannelLinkStatus['state']) {
    halted = true;
    channel.available = false;
    state = { state: next, accountHandle: state.accountHandle, accountName: state.accountName };
    clearTimeout(reconnect);
    clearTimeout(expiry);
    socket?.end(undefined);
  }
  function save(values: Record<string, string | null>) {
    const pending = writes.then(async () => {
      if (closed || !session) throw new Error('The WhatsApp session is closed.');
      await session.set(values);
    });
    writes = pending.catch(() => {
      if (!closed) stop('failed');
    });
    return pending;
  }
  function clearSaved() {
    if (!cleared) {
      const pending = (async () => {
        await writes;
        session ??= await options.store.open();
        await session.clear();
      })();
      cleared = pending;
      void pending.catch(() => {
        if (cleared === pending) cleared = undefined;
      });
    }
    return cleared;
  }
  function ownNumber() {
    return numberOf(auth?.creds.me?.id ?? socket?.user?.id);
  }
  function identity() {
    const own = ownNumber();
    if (!own || (options.mode === 'bot' && own === options.allowedNumber)) return false;
    channel.accountId = `linked:${own}`;
    channel.allowedSenderIds =
      options.mode === 'self-chat' ? [own] : options.allowedNumber ? [options.allowedNumber] : [];
    channel.status = channel.allowedSenderIds.length ? 'configured' : 'setup_required';
    state.accountHandle = `+${own}`;
    state.accountName = auth.creds.me?.name?.slice(0, 200);
    return channel.status === 'configured';
  }
  async function sender(message: WAMessage, current: Socket) {
    const jid = message.key.remoteJid;
    if (!jid || message.key.participant || !/^\d+(?::\d+)?@(s\.whatsapp\.net|lid)$/.test(jid))
      return;
    let phone = numberOf(jid);
    if (!phone && jid.endsWith('@lid')) {
      phone =
        options.mode === 'self-chat'
          ? jidNormalizedUser(jid) ===
            jidNormalizedUser(auth.creds.me?.lid ?? current.user?.lid ?? '')
            ? ownNumber()
            : undefined
          : numberOf(message.key.remoteJidAlt);
      if (!phone && options.mode !== 'self-chat')
        phone = numberOf(await current.signalRepository.lidMapping.getPNForLID(jid));
    }
    if (!phone || !channel.allowedSenderIds.includes(phone)) return;
    if (options.mode === 'self-chat') {
      if (phone !== ownNumber() || !message.key.fromMe) return;
    } else if (message.key.fromMe) return;
    return { phone, jid: jidNormalizedUser(jid) };
  }
  function attachment(message: WAMessage): MessagingAttachment[] {
    const content = normalizeMessageContent(message.message);
    const location = content?.locationMessage ?? content?.liveLocationMessage;
    if (location)
      return locationAttachment({
        latitude: location.degreesLatitude,
        longitude: location.degreesLongitude,
        ...('name' in location && location.name ? { name: location.name.slice(0, 200) } : {}),
        ...('address' in location && location.address
          ? { address: location.address.slice(0, 500) }
          : {}),
      });
    const contacts = content?.contactMessage
      ? [content.contactMessage]
      : content?.contactsArrayMessage?.contacts;
    if (contacts) return contactAttachment(contacts.map((contact) => contact.vcard ?? ''));
    const media =
      content?.imageMessage ??
      content?.documentMessage ??
      content?.videoMessage ??
      content?.audioMessage ??
      content?.stickerMessage;
    if (!media) return [];
    const image = Boolean(content?.imageMessage || content?.stickerMessage);
    const sticker = Boolean(content?.stickerMessage);
    const audio = Boolean(content?.audioMessage);
    const voice = Boolean(content?.audioMessage?.ptt);
    const mimeType =
      media.mimetype ??
      (sticker
        ? 'image/webp'
        : image
          ? 'image/jpeg'
          : audio
            ? 'audio/ogg'
            : content?.videoMessage
              ? 'video/mp4'
              : 'application/octet-stream');
    const name =
      content?.documentMessage?.fileName?.slice(0, 255) ||
      (sticker
        ? 'sticker.webp'
        : image
          ? 'image.jpg'
          : audio
            ? 'voice.ogg'
            : content?.videoMessage
              ? 'video.mp4'
              : 'file');
    return [
      {
        name,
        mimeType,
        size: Number(media.fileLength ?? 0),
        voice,
        ...(sticker ? { source: 'sticker' as const } : {}),
        async read(signal) {
          const operation = AbortSignal.any([
            lifetime.signal,
            AbortSignal.timeout(60_000),
            ...(signal ? [signal] : []),
          ]);
          operation.throwIfAborted();
          if (media.url) {
            const url = new URL(media.url);
            if (
              url.protocol !== 'https:' ||
              url.username ||
              url.password ||
              url.port ||
              !/^(mmg|mmg-fna)\.whatsapp\.net$/.test(url.hostname)
            )
              throw new Error('The WhatsApp file address is invalid.');
          }
          if (
            media.directPath &&
            (!media.directPath.startsWith('/') || media.directPath.startsWith('//'))
          )
            throw new Error('The WhatsApp file address is invalid.');
          if (Number(media.fileLength ?? 0) > 50 * 1024 * 1024)
            throw new MessagingAttachmentError(50 * 1024 * 1024);
          const stream = await (options.download ?? downloadMediaMessage)(
            { ...message, message: content },
            'stream',
            { host: 'mmg.whatsapp.net', options: { signal: operation, redirect: 'error' } },
          );
          const bytes: Uint8Array[] = [];
          let size = 0;
          const abort = () => stream.destroy(new Error('The WhatsApp download stopped.'));
          operation.addEventListener('abort', abort, { once: true });
          try {
            operation.throwIfAborted();
            for await (const part of stream) {
              operation.throwIfAborted();
              size += part.length;
              if (size > 50 * 1024 * 1024) throw new MessagingAttachmentError(50 * 1024 * 1024);
              bytes.push(part);
            }
            return Buffer.concat(bytes, size);
          } finally {
            operation.removeEventListener('abort', abort);
            stream.destroy();
          }
        },
      },
    ];
  }
  async function intake(message: WAMessage, current: Socket) {
    if (closed || halted || socket !== current || !identity()) return;
    const id = message.key.id;
    const at = Number(message.messageTimestamp) * 1000;
    if (
      !id ||
      sentIds.has(id) ||
      !Number.isFinite(at) ||
      at < linkedAt ||
      at > Date.now() + 300_000
    )
      return;
    const source = await sender(message, current);
    if (!source || closed || halted || socket !== current) return;
    const content = normalizeMessageContent(message.message);
    if (!content) return;
    const reaction = content.reactionMessage;
    if (reaction?.key?.id) {
      if (reactions.length < 1000)
        reactions.push({
          channelId: 'whatsapp',
          accountId: channel.accountId!,
          senderId: source.phone,
          messageId: reaction.key.id,
          reaction: reaction.text || null,
        });
      return;
    }
    const text =
      content.conversation ??
      content.extendedTextMessage?.text ??
      content.imageMessage?.caption ??
      content.videoMessage?.caption ??
      content.documentMessage?.caption ??
      '';
    const files = attachment(message);
    if ((!text && !files.length) || incoming.length >= 1000) return;
    const context =
      content.extendedTextMessage?.contextInfo ??
      content.imageMessage?.contextInfo ??
      content.videoMessage?.contextInfo ??
      content.audioMessage?.contextInfo ??
      content.stickerMessage?.contextInfo ??
      content.locationMessage?.contextInfo ??
      content.liveLocationMessage?.contextInfo ??
      content.contactMessage?.contextInfo ??
      content.contactsArrayMessage?.contextInfo ??
      content.documentMessage?.contextInfo;
    incoming.push({
      channelId: 'whatsapp',
      accountId: channel.accountId!,
      senderId: source.phone,
      messageId: id,
      threadId: source.jid,
      text,
      sentAt: new Date(at),
      ...(context?.stanzaId ? { replyToMessageId: context.stanzaId } : {}),
      ...(files.length ? { attachments: files } : {}),
    });
  }
  function connect() {
    if (closed || halted) return;
    state = { ...state, state: 'connecting', qr: undefined, expiresAt: undefined };
    const current = (options.createSocket ?? makeWASocket)({
      auth,
      logger: silent,
      browser: ['nod', 'Chrome', '1.0'],
      syncFullHistory: false,
      shouldSyncHistoryMessage: () => false,
      markOnlineOnConnect: false,
      emitOwnEvents: false,
      maxMsgRetryCount: 0,
      enableAutoSessionRecreation: false,
      enableRecentMessageCache: false,
      getMessage: async () => undefined,
      connectTimeoutMs: 30_000,
      defaultQueryTimeoutMs: 30_000,
      qrTimeout: qrLifetimeMs,
      shouldIgnoreJid: (jid) => {
        if (jid === 'status@broadcast' || jid.endsWith('@g.us') || jid.endsWith('@newsletter'))
          return true;
        const phone = numberOf(jid);
        return Boolean(phone && !channel.allowedSenderIds.includes(phone) && phone !== ownNumber());
      },
    });
    socket = current;
    current.ev.on('creds.update', (update) => {
      if (closed || halted || socket !== current) return;
      Object.assign(auth.creds, update);
      void save({ creds: JSON.stringify(auth.creds, BufferJSON.replacer) }).catch(() => {});
    });
    current.ev.on('messages.upsert', (event) => {
      if (closed || halted || socket !== current || event.requestId) return;
      const messages = event.messages.slice(0, Math.max(0, 1000 - queued));
      queued += messages.length;
      received = received
        .then(async () => {
          for (const message of messages) await intake(message, current);
        })
        .catch(() => {
          if (!closed) stop('failed');
        })
        .finally(() => {
          queued -= messages.length;
        });
    });
    current.ev.on('connection.update', (update) => {
      if (closed || halted || socket !== current) return;
      if (update.qr)
        state = {
          ...state,
          state: 'awaiting_scan',
          qr: update.qr,
          expiresAt: new Date(Date.now() + qrLifetimeMs).toISOString(),
        };
      if (update.connection === 'open') {
        if (!identity()) {
          stop('failed');
          return;
        }
        clearTimeout(expiry);
        attempt = 0;
        state = { ...state, state: 'connected', qr: undefined, expiresAt: undefined };
        channel.available = true;
        if (!linkedAt) {
          linkedAt = Date.now() - 2000;
          void save({ 'intake-start': String(linkedAt) }).catch(() => {});
        }
      }
      if (update.connection === 'close') {
        channel.available = false;
        state = { ...state, state: 'disconnected', qr: undefined, expiresAt: undefined };
        const code = (
          update.lastDisconnect?.error as { output?: { statusCode?: number } } | undefined
        )?.output?.statusCode;
        if (code === DisconnectReason.loggedOut) {
          stop('logged_out');
          void clearSaved().catch(() => {
            state = { state: 'failed' };
          });
        } else if (
          code === DisconnectReason.connectionReplaced ||
          code === DisconnectReason.badSession ||
          code === DisconnectReason.forbidden ||
          code === DisconnectReason.multideviceMismatch
        )
          stop('failed');
        else {
          clearTimeout(reconnect);
          reconnect = setTimeout(
            () => connect(),
            Math.min(60_000, 1000 * 2 ** Math.min(attempt++, 6)),
          );
          reconnect.unref();
        }
      }
    });
  }
  async function start() {
    if (closed || halted) return;
    starting ??= (async () => {
      session = await options.store.open();
      if (closed) {
        await session.close();
        return;
      }
      const credentials = await session.get('creds');
      auth = {
        creds: credentials ? JSON.parse(credentials, BufferJSON.reviver) : initAuthCreds(),
        keys: {
          async get(type, ids) {
            const values = Object.create(null);
            for (const id of ids) {
              const saved = await session!.get(`${type}:${id}`);
              if (saved !== undefined) {
                let value = JSON.parse(saved, BufferJSON.reviver);
                if (type === 'app-state-sync-key')
                  value = proto.Message.AppStateSyncKeyData.fromObject(value);
                values[id] = value;
              }
            }
            return values;
          },
          async set(data) {
            const values: Record<string, string | null> = Object.create(null);
            for (const [type, entries] of Object.entries(data))
              for (const [id, value] of Object.entries(entries ?? {}))
                values[`${type}:${id}`] =
                  value == null ? null : JSON.stringify(value, BufferJSON.replacer);
            await save(values);
          },
        },
      };
      linkedAt = Number((await session.get('intake-start')) ?? 0);
      for (const id of JSON.parse((await session.get('sent-ids')) ?? '[]') as string[])
        sentIds.add(id);
      identity();
      if (!credentials) await save({ creds: JSON.stringify(auth.creds, BufferJSON.replacer) });
      if (!auth.creds.registered) {
        expiry = setTimeout(() => {
          stop('expired');
          void clearSaved().catch(() => {
            state = { state: 'failed' };
          });
        }, 5 * 60_000);
        expiry.unref();
      }
      connect();
    })().catch(() => {
      if (!closed) stop('failed');
    });
    await starting;
  }
  async function send(
    jid: string,
    content: Parameters<Socket['sendMessage']>[1],
    quote?: { id: string; text: string },
  ) {
    if (closed || halted || !channel.available || !socket)
      throw new Error('WhatsApp is disconnected.');
    const current = socket;
    const id = generateMessageIDV2(auth.creds.me?.id);
    sentIds.add(id);
    while (sentIds.size > 2000) sentIds.delete(sentIds.values().next().value!);
    await save({ 'sent-ids': JSON.stringify([...sentIds]) });
    if (closed || halted || socket !== current || !channel.available)
      throw new Error('WhatsApp is disconnected.');
    const result = await current.sendMessage(jid, content, {
      messageId: id,
      mediaUploadTimeoutMs: 60_000,
      ...(quote
        ? {
            quoted: {
              key: { remoteJid: jid, fromMe: true, id: quote.id },
              message: { conversation: quote.text },
            },
          }
        : {}),
    });
    if (!result?.key.id || result.key.id !== id)
      throw new Error('WhatsApp delivery was not confirmed.');
    return id;
  }
  const target = (input: { channelId: string; accountId: string; threadId: string }) => {
    if (
      input.channelId !== 'whatsapp' ||
      input.accountId !== channel.accountId ||
      !/^\d+@(s\.whatsapp\.net|lid)$/.test(input.threadId) ||
      (options.mode === 'self-chat' &&
        input.threadId !== `${ownNumber()}@s.whatsapp.net` &&
        input.threadId !== jidNormalizedUser(auth?.creds.me?.lid ?? socket?.user?.lid ?? ''))
    )
      throw new Error('The WhatsApp target is unavailable.');
  };
  return {
    get channels() {
      return [channel];
    },
    async pairing() {
      await start();
      return { ...state, pairingId };
    },
    async poll(accept, _pair, react) {
      await start();
      await received;
      while (!closed && !halted && incoming.length) {
        await accept(incoming[0]);
        incoming.shift();
      }
      while (!closed && !halted && reactions.length) {
        await react?.(reactions[0]);
        reactions.shift();
      }
    },
    async receive() {
      return { status: 404, body: { error: 'WhatsApp linked devices do not use a webhook.' } };
    },
    async post(input) {
      target(input);
      const quote = input.replyToMessageId
        ? { id: input.replyToMessageId, text: input.replyToText ?? '' }
        : undefined;
      const ids: string[] = [];
      const text = whatsappText(input.text);
      const caption =
        input.attachments?.length === 1 &&
        !input.attachments[0].mimeType.startsWith('audio/') &&
        !/^(?:text\/(?:x-)?vcard)$/.test(input.attachments[0].mimeType) &&
        input.attachments[0].name !== 'location.json' &&
        text.length <= 1024
          ? text
          : '';
      for (const part of splitMessage(caption ? '' : text))
        if (part.trim())
          ids.push(await send(input.threadId, { text: part, linkPreview: null }, quote));
      for (const file of input.attachments ?? []) {
        if (!file.size || file.size > 50 * 1024 * 1024)
          throw new Error('The WhatsApp file is too large.');
        const bytes = Buffer.from(await file.read(lifetime.signal));
        if (bytes.length !== file.size) throw new Error('The WhatsApp file has changed.');
        if (file.name === 'location.json' && bytes.length <= 4096) {
          let location;
          try {
            location = sharedLocation.safeParse(JSON.parse(bytes.toString('utf8')));
          } catch {}
          if (location?.success) {
            ids.push(
              await send(
                input.threadId,
                {
                  location: {
                    degreesLatitude: location.data.latitude,
                    degreesLongitude: location.data.longitude,
                    ...(location.data.name ? { name: location.data.name } : {}),
                    ...(location.data.address ? { address: location.data.address } : {}),
                  },
                },
                quote,
              ),
            );
            continue;
          }
        }
        const contacts = /^(?:text\/(?:x-)?vcard)$/.test(file.mimeType)
          ? contactCards(bytes.toString('utf8'))
          : [];
        if (
          contacts.length &&
          contacts.every((contact) =>
            contact.phones.some((phone) => /^\+?(?:[\s().-]*\d)+[\s().-]*$/.test(phone)),
          )
        ) {
          ids.push(
            await send(
              input.threadId,
              {
                contacts: {
                  displayName: contacts[0].name,
                  contacts: contacts.map((contact) => ({
                    displayName: contact.name,
                    vcard: contact.vcard,
                  })),
                },
              },
              quote,
            ),
          );
          continue;
        }
        const media = file.mimeType.startsWith('image/')
          ? { image: bytes, mimetype: file.mimeType }
          : file.mimeType.startsWith('video/')
            ? { video: bytes, mimetype: file.mimeType }
            : file.mimeType.startsWith('audio/')
              ? { audio: bytes, mimetype: file.mimeType, ptt: file.mimeType === 'audio/ogg' }
              : { document: bytes, mimetype: file.mimeType, fileName: file.name };
        ids.push(await send(input.threadId, { ...media, ...(caption ? { caption } : {}) }, quote));
      }
      if (!ids.length) throw new Error('WhatsApp delivery was not confirmed.');
      return { id: ids[0], ids };
    },
    async react(input) {
      target(input);
      input.signal?.throwIfAborted();
      await send(input.threadId, {
        react: {
          key: {
            remoteJid: input.threadId,
            fromMe: options.mode === 'self-chat',
            id: input.messageId,
          },
          text: input.reaction ?? '',
        },
      });
      return 'sent';
    },
    async presence(input) {
      target(input);
      if (socket && channel.available) await socket.sendPresenceUpdate('composing', input.threadId);
    },
    async unlink() {
      if (cleared) {
        await cleared;
        return;
      }
      halted = true;
      channel.available = false;
      state = { state: 'failed' };
      clearTimeout(reconnect);
      clearTimeout(expiry);
      lifetime.abort();
      incoming.length = 0;
      reactions.length = 0;
      try {
        if (socket && !logoutStarted) {
          logoutStarted = true;
          await Promise.race([
            socket.logout(),
            new Promise<never>((_, reject) => {
              const timer = setTimeout(
                () => reject(new Error('WhatsApp sign-out did not finish.')),
                5000,
              );
              timer.unref();
            }),
          ]).catch(() => {});
        }
      } finally {
        socket?.end(undefined);
        await starting;
        await clearSaved();
        channel.available = false;
        channel.status = 'setup_required';
        state = { state: 'logged_out' };
      }
    },
    async cancelPairing(expected, restart = false) {
      if (expected !== pairingId || state.state === 'connected' || (!restart && linkedAt))
        return false;
      await this.unlink!();
      return true;
    },
    async close() {
      if (closed) return;
      closed = true;
      halted = true;
      lifetime.abort();
      clearTimeout(reconnect);
      clearTimeout(expiry);
      socket?.end(undefined);
      await starting;
      await writes;
      await received;
      await session?.close();
      incoming.length = 0;
      reactions.length = 0;
    },
  };
}
