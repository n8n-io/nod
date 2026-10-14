export interface MessagingChannel {
  id: string;
  status: 'disabled' | 'setup_required' | 'configured';
  missing: string[];
  accountId?: string;
  allowedSenderIds: string[];
  replyWindowMs?: number;
  supportsAttachments?: boolean;
  edits?: boolean;
}

export interface MessagingButton {
  id: string;
  title: string;
}

export interface MessagingAttachment {
  name: string;
  mimeType: string;
  bytes: Uint8Array;
}

export interface InboundMessage {
  channelId: string;
  accountId: string;
  senderId: string;
  messageId: string;
  threadId: string;
  text: string;
  sentAt: Date;
  replyTo?: string;
}

export interface InboundPress {
  channelId: string;
  accountId: string;
  senderId: string;
  pressId: string;
  threadId: string;
  data: string;
  sentAt: Date;
}

export interface ChannelPairingRequest {
  channelId: string;
  accountId: string;
  senderId: string;
  senderName: string;
  senderUsername?: string;
  messageId: string;
  threadId: string;
  code: string;
  sentAt: Date;
}

interface MessagingWebhook {
  channelId: string;
  method: string;
  headers: Record<string, string | string[] | undefined>;
  query: unknown;
  body: Uint8Array;
}

export interface MessagingWebhookResult {
  status: number;
  body: string | Record<string, unknown>;
  contentType?: string;
  messages?: InboundMessage[];
  presses?: InboundPress[];
  pairing?: ChannelPairingRequest;
}

export interface MessagingTransport {
  channels: MessagingChannel[];
  pollingEnabled?: boolean;
  poll?(
    accept: (message: InboundMessage) => Promise<void>,
    pair?: (request: ChannelPairingRequest) => Promise<void>,
    press?: (press: InboundPress) => Promise<void>,
  ): Promise<void>;
  receive(request: MessagingWebhook): Promise<MessagingWebhookResult>;
  post(input: {
    channelId: string;
    accountId: string;
    threadId: string;
    text: string;
    attachments?: MessagingAttachment[];
    filesReplyToText?: boolean;
    replyTo?: string;
    buttons?: MessagingButton[];
  }): Promise<{ ids: string[]; editable?: boolean }>;
  edit?(input: {
    channelId: string;
    accountId: string;
    threadId: string;
    messageId: string;
    text: string;
    buttons: MessagingButton[];
  }): Promise<void>;
  ack?(input: {
    channelId: string;
    accountId: string;
    pressId: string;
    text?: string;
  }): Promise<boolean>;
  close(): Promise<void>;
}

export class MessagingRetryLater extends Error {
  constructor(readonly retryAfterMs: number) {
    super('The channel declined the message for now.');
  }
}

export class MessagingPartialSend extends Error {
  constructor(
    readonly ids: string[],
    options?: ErrorOptions,
  ) {
    super('The channel delivered only part of the message.', options);
  }
}
