import type { IntegrationService } from '../shared/integrations.ts';
import type { Connection } from '../shared/contracts.ts';
export type { IntegrationService, IntegrationDownloadAction } from '../shared/integrations.ts';
export type ConnectedApp = Pick<
  Connection,
  | 'slug'
  | 'name'
  | 'status'
  | 'connectionId'
  | 'accountName'
  | 'accountEmail'
  | 'supportsTriggers'
  | 'triggersEnabled'
  | 'triggerStatus'
  | 'browserState'
  | 'checkedAt'
> & { access: Array<'api' | 'http' | 'mcp' | 'browser' | 'cli'> };
export interface IntegrationFile {
  name: string;
  mimeType: string;
  bytes: Uint8Array;
}
export interface IntegrationSearch {
  tools: unknown;
  suggestions: Array<{ useCase: string; primaryToolSlugs: string[] }>;
}
export interface IntegrationSession {
  id: string;
  authorize(
    service: IntegrationService,
    callbackUrl: string,
  ): Promise<{ accountId: string; url: string }>;
  search(query: string, signal?: AbortSignal): Promise<IntegrationSearch>;
  execute(
    action: string,
    args: Record<string, unknown>,
    accountId?: string,
    signal?: AbortSignal,
  ): Promise<unknown>;
  download?(
    action: string,
    args: Record<string, unknown>,
    accountId: string,
    signal?: AbortSignal,
  ): Promise<IntegrationFile>;
}
export interface IntegrationEvent {
  id: string;
  ownerId: string;
  service: string;
  accountId: string;
  subscriptionId: string;
  trigger: string;
  data: Record<string, unknown>;
}
export interface IntegrationInboxPoll {
  cursor: string;
  hasMore: boolean;
  messages: Array<{
    id: string;
    threadId: string;
    subject: string;
    sender: string;
    receivedAt: string;
  }>;
}
export class IntegrationInboxCursorExpired extends Error {}
export interface VerificationEmailQuery {
  recipient: string;
  senderDomain: string;
  after: number;
  before: number;
}
export interface VerificationEmail {
  id: string;
  receivedAt: number;
  sender: string;
  recipients: string[];
  authenticatedDomain: string;
  text: string;
}
export interface IntegrationProvider {
  id: string;
  configured: boolean;
  supportedServices?: readonly IntegrationService[];
  webhooksConfigured: boolean;
  supportsSubscriptions: readonly IntegrationService[];
  createSession(
    ownerId: string,
    accounts: Partial<Record<IntegrationService, string | string[]>>,
    signal?: AbortSignal,
  ): Promise<IntegrationSession>;
  restoreSession(id: string, signal?: AbortSignal): Promise<IntegrationSession>;
  deleteSession(id: string): Promise<void>;
  readOnly(action: string, signal?: AbortSignal): Promise<boolean>;
  inspectAccount(
    id: string,
    ownerId: string,
  ): Promise<{
    active: boolean;
    service: string;
    accountName?: string;
    accountEmail?: string;
  }>;
  deleteAccount(id: string): Promise<void>;
  verificationEmails?(
    accountId: string,
    query: VerificationEmailQuery,
    signal: AbortSignal,
  ): Promise<VerificationEmail[] | undefined>;
  pollInbox?(
    accountId: string,
    cursor: string | null,
    signal: AbortSignal,
  ): Promise<IntegrationInboxPoll>;
  parseCallback(query: unknown):
    | Promise<{ state: string; accountId: string; success: boolean }>
    | {
        state: string;
        accountId: string;
        success: boolean;
      };
  subscribe(
    ownerId: string,
    service: IntegrationService,
    accountId: string,
  ): Promise<{ id: string }>;
  unsubscribe(id: string): Promise<void>;
  verifyWebhook(
    body: unknown,
    headers: Record<string, string | string[] | undefined>,
  ): Promise<IntegrationEvent>;
  matchesSubscription(service: IntegrationService, trigger: string): boolean;
}
