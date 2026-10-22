import type {
  IntegrationService,
  IntegrationServiceInfo,
  IntegrationAccessAttempt,
  IntegrationAccessProgress,
  IntegrationManagedAccess,
} from '../shared/integrations.ts';
import type { Connection } from '../shared/contracts.ts';
export type { IntegrationService, IntegrationServiceInfo } from '../shared/integrations.ts';
export interface IntegrationAccessProvider {
  origin: string;
  accessStatus(): Promise<IntegrationManagedAccess>;
  startAccess(
    browserKey: unknown,
    origin: string,
    challenge: string,
    signal?: AbortSignal,
    native?: { returnPath: string },
  ): Promise<IntegrationAccessAttempt>;
  pollAccess(id: string, signal?: AbortSignal): Promise<IntegrationAccessProgress>;
  completeAccess(
    id: string,
    challenge: string,
    signal?: AbortSignal,
  ): Promise<IntegrationManagedAccess>;
  cancelAccess(id: string): Promise<{ cancelled: true }>;
  revokeAccess(): Promise<IntegrationManagedAccess>;
}
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
export class IntegrationDownload {
  constructor(readonly start: () => Promise<unknown>) {}
}
export interface IntegrationSearch {
  tools: unknown;
  suggestions: Array<{ useCase: string; primaryToolSlugs: string[] }>;
}
export interface IntegrationAuthorization {
  accountId: string;
  url: string;
  verificationSecret?: string;
}
export interface IntegrationSession {
  id: string;
  authorize(service: IntegrationService, callbackUrl: string): Promise<IntegrationAuthorization>;
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
    accountId?: string,
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
export class IntegrationConnectionError extends Error {
  readonly statusCode: number;
  constructor(
    readonly reason:
      'authorization' | 'permission' | 'rate_limit' | 'timeout' | 'unavailable' | 'invalid_request',
    readonly phase: 'session' | 'auth_config' | 'link',
    readonly status?: number,
  ) {
    const access =
      phase === 'auth_config'
        ? 'Auth configs read access'
        : 'Session management read and write access';
    super(
      reason === 'authorization'
        ? `Composio rejected this key or its permissions. Create a key in the same Composio project with ${access}, then replace it in nod and try again.`
        : reason === 'permission'
          ? `Connecting apps requires ${access} on the Composio project key. Create a key with that permission, then replace it in nod and try again.`
          : reason === 'rate_limit'
            ? 'Composio is receiving too many requests. Wait a moment, then try connecting again.'
            : reason === 'timeout'
              ? 'Composio took too long to respond. Try connecting again.'
              : reason === 'invalid_request'
                ? `Composio rejected this request (HTTP ${status}). Try connecting again, and if it keeps failing, check this app's setup in your Composio project.`
                : 'Composio could not complete the connection. Try connecting again shortly.',
    );
    this.statusCode =
      reason === 'authorization' || reason === 'permission'
        ? 503
        : reason === 'rate_limit'
          ? 429
          : reason === 'timeout'
            ? 504
            : 502;
  }
}
export class IntegrationAuthConfigurationError extends Error {
  constructor(reason: 'ambiguous' | 'unavailable') {
    super(
      reason === 'ambiguous'
        ? 'This app has multiple custom sign-in configurations. Ask your nod administrator to select one.'
        : "This app's custom sign-in configuration is unavailable. Ask your nod administrator to enable it for sessions.",
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
export interface InboxThread {
  subject: string;
  from: string;
  received: string;
  messages: number;
  waitingOnYou: boolean;
  flagged: boolean;
  automated: boolean;
  text: string;
}
export interface IntegrationProvider {
  id: string;
  configured: boolean;
  configurationId?: string;
  setApiKey?(apiKey?: string, authConfigs?: Partial<Record<IntegrationService, string>>): void;
  verifyApiKey?(apiKey: string): Promise<boolean>;
  supportedServices?: readonly IntegrationService[];
  listServices?(): Promise<IntegrationServiceInfo[]>;
  webhooksConfigured: boolean;
  supportsSubscriptions: readonly IntegrationService[];
  authorize?(
    ownerId: string,
    service: IntegrationService,
    callbackUrl: string,
  ): Promise<IntegrationAuthorization>;
  connectionStatus?(
    ownerId: string,
    url: string,
    signal?: AbortSignal,
  ): Promise<{ pairingConfirmed: boolean; signInRequired?: boolean }>;
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
  ): Promise<IntegrationAuthorization & { authConfigId: string }>;
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
  inboxThreads?(accountId: string, signal: AbortSignal): Promise<InboxThread[]>;
  pollInbox?(
    accountId: string,
    cursor: string | null,
    signal: AbortSignal,
  ): Promise<IntegrationInboxPoll>;
  parseCallback(
    query: unknown,
    pending?: { accountId: string; verificationSecret?: string | null; service: string },
  ):
    | Promise<{ state: string; accountId: string; pendingAccountId?: string; success: boolean }>
    | {
        state: string;
        accountId: string;
        pendingAccountId?: string;
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
