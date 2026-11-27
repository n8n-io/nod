import type { ChannelLinkStatus } from '../shared/contracts.ts';

export class MessagingConnectionError extends Error {}

export class MessagingAttachmentError extends Error {
  constructor(readonly maxBytes: number) {
    super('The channel file is too large.');
  }
}

export interface MessagingChannel {
  id: string;
  status: 'disabled' | 'setup_required' | 'configured';
  missing: string[];
  accountId?: string;
  allowedSenderIds: string[];
  replyWindowMs?: number;
  supportsAttachments?: boolean;
  available?: boolean;
  error?: string;
  presenceMs?: number;
}

export interface MessagingAttachment {
  name: string;
  mimeType: string;
  size: number;
  voice?: boolean;
  source?: 'sticker' | 'sticker-preview' | 'location' | 'contact';
  read(signal?: AbortSignal): Promise<Uint8Array>;
}

export interface InboundMessage {
  channelId: string;
  accountId: string;
  senderId: string;
  messageId: string;
  threadId: string;
  text: string;
  attachments?: MessagingAttachment[];
  replyToMessageId?: string;
  sentAt: Date;
}

export interface InboundReaction {
  channelId: string;
  accountId: string;
  senderId: string;
  messageId: string;
  reaction: string | null;
}

export interface InboundApproval {
  channelId: string;
  accountId: string;
  senderId: string;
  threadId: string;
  messageId: string;
  approved: boolean;
  acknowledge(result: 'recorded' | 'unavailable' | 'retry'): Promise<void>;
}

export interface InboundInteraction {
  channelId: string;
  accountId: string;
  senderId: string;
  threadId: string;
  messageId: string;
  interactionId: string;
  optionIndex: number;
  acknowledge(result: 'recorded' | 'unavailable' | 'retry'): Promise<void>;
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
  reactions?: InboundReaction[];
  approvals?: InboundApproval[];
  interactions?: InboundInteraction[];
  pairing?: ChannelPairingRequest;
}

export interface MessagingTransport {
  channels: MessagingChannel[];
  canDeliverLiteral?(input: { channelId: string; text: string; literal: string }): boolean;
  onInput?(listener: () => void): void;
  link?(request: ChannelPairingRequest): void;
  pairing?(): Promise<ChannelLinkStatus>;
  cancelPairing?(pairingId: string, restart?: boolean): Promise<boolean>;
  unlink?(): Promise<void>;
  poll?(
    accept: (message: InboundMessage) => Promise<void>,
    pair?: (request: ChannelPairingRequest) => Promise<void>,
    react?: (reaction: InboundReaction) => Promise<void>,
    approve?: (approval: InboundApproval) => Promise<void>,
    interact?: (interaction: InboundInteraction) => Promise<void>,
  ): Promise<void>;
  receive(request: MessagingWebhook): Promise<MessagingWebhookResult>;
  post(input: {
    channelId: string;
    accountId: string;
    threadId: string;
    text: string;
    approval?: { approve: string; decline: string };
    interaction?: { id: string; options: Array<{ label: string }> };
    attachments?: MessagingAttachment[];
    replyToMessageId?: string;
    replyToText?: string;
    attachmentFailure?: (files: { name: string; reason?: string }[]) => Promise<string | undefined>;
  }): Promise<{ id: string; ids?: string[]; approvalButtons?: true }>;
  react?(input: {
    channelId: string;
    accountId: string;
    threadId: string;
    messageId: string;
    reaction: string | null;
    signal?: AbortSignal;
  }): Promise<'sent' | 'unsupported'>;
  presence?(input: {
    channelId: string;
    accountId: string;
    threadId: string;
    messageId: string;
    status?: string;
    signal?: AbortSignal;
  }): Promise<void>;
  progress?(input: {
    channelId: string;
    accountId: string;
    threadId: string;
    messageId: string;
    text: string;
    status: string | null;
    signal: AbortSignal;
  }): Promise<void>;
  close(): Promise<void>;
}
