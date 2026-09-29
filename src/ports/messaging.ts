export interface MessagingChannel {
  id: string;
  status: 'disabled' | 'setup_required' | 'configured';
  missing: string[];
  accountId?: string;
  allowedSenderIds: string[];
  replyWindowMs?: number;
  supportsAttachments?: boolean;
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
}

export interface ChannelPairingRequest {
  channelId: string;
  accountId: string;
  senderId: string;
  senderName: string;
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
  pairing?: ChannelPairingRequest;
}

export interface MessagingTransport {
  channels: MessagingChannel[];
  pollingEnabled?: boolean;
  poll?(
    accept: (message: InboundMessage) => Promise<void>,
    pair?: (request: ChannelPairingRequest) => Promise<void>,
  ): Promise<void>;
  receive(request: MessagingWebhook): Promise<MessagingWebhookResult>;
  post(input: {
    channelId: string;
    accountId: string;
    threadId: string;
    text: string;
    attachments?: MessagingAttachment[];
  }): Promise<{ id: string }>;
  close(): Promise<void>;
}
