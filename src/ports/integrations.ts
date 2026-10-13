import type { IntegrationService, IntegrationServiceInfo } from '../shared/integrations.ts';
import type { Connection } from '../shared/contracts.ts';
export type { IntegrationService, IntegrationServiceInfo } from '../shared/integrations.ts';
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
  upload?(
    action: string,
    file: IntegrationFile,
    signal?: AbortSignal,
  ): Promise<Record<string, unknown>>;
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
export class IntegrationCatalogAccessDenied extends Error {
  constructor() {
    super('App discovery requires Toolkit read access on the Composio project key.');
  }
}
export class IntegrationAuthConfigurationError extends Error {
  constructor(reason: 'permission' | 'ambiguous' | 'unavailable') {
    super(
      reason === 'permission'
        ? 'Connecting Google apps requires Auth configs read access on the Composio project key. Ask your Otto administrator to update the key.'
        : reason === 'ambiguous'
          ? 'This app has multiple custom sign-in configurations. Ask your Otto administrator to select one.'
          : "This app's custom sign-in configuration is unavailable. Ask your Otto administrator to enable it for sessions.",
    );
  }
}
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
export interface SentEmail {
  from: string;
  to: string[];
  automated: boolean;
  text: string;
}
export interface InboxSnippet {
  subject: string;
  snippet: string;
}
export interface IntegrationProvider {
  id: string;
  configured: boolean;
  setApiKey?(apiKey?: string): void;
  verifyApiKey?(apiKey: string): Promise<boolean>;
  supportedServices?: readonly IntegrationService[];
  listServices?(): Promise<IntegrationServiceInfo[]>;
  webhooksConfigured: boolean;
  supportsSubscriptions: readonly IntegrationService[];
  createSession(
    ownerId: string,
    accounts: Partial<Record<IntegrationService, string | string[]>>,
    signal?: AbortSignal,
  ): Promise<IntegrationSession>;
  deleteSession(id: string): Promise<void>;
  reconnectAccount?(
    ownerId: string,
    service: IntegrationService,
    accountId: string,
    callbackUrl: string,
  ): Promise<{ accountId: string; url: string; authConfigId: string }>;
  inspectAccount(
    id: string,
    ownerId: string,
    options?: { verifyOwner?: boolean },
  ): Promise<{
    active: boolean;
    service: string;
    accountName?: string;
    accountEmail?: string;
    authConfigId?: string;
  }>;
  deleteAccount(id: string, ownerId?: string): Promise<void>;
  verificationEmails?(
    accountId: string,
    query: VerificationEmailQuery,
    signal: AbortSignal,
  ): Promise<VerificationEmail[] | undefined>;
  sentEmails?(accountId: string, signal: AbortSignal): Promise<SentEmail[]>;
  inboxSnippets?(accountId: string, signal: AbortSignal): Promise<InboxSnippet[]>;
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
