import type { IntegrationService, IntegrationServiceInfo } from '../shared/integrations.ts';
import type { Connection } from '../shared/contracts.ts';
import type { ObservationBatch, ObservationQuery } from './proactivity.ts';
export type { IntegrationService, IntegrationServiceInfo } from '../shared/integrations.ts';
export interface IntegrationConnectionBrowser {
  open(
    id: string,
    brokerOrigin: string,
    start: (
      browserKey: unknown,
      origin: string,
      native?: { returnPath: string },
    ) => Promise<string>,
  ): Promise<string>;
  owns(url: string): boolean;
  remote(url: string): string | undefined;
  finish(id: string): void;
  close(): Promise<void>;
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
  retryAfterMs?: number;
  messages: Array<{
    id: string;
    threadId: string;
    subject: string;
    sender: string;
    receivedAt: string;
  }>;
}
export class IntegrationInboxCursorExpired extends Error {}
export class IntegrationInboxTransientError extends Error {
  readonly retryAfterMs: number;

  constructor(
    readonly status?: number,
    readonly code?:
      | 'installation_busy'
      | 'public_budget_exceeded'
      | 'service_unavailable'
      | 'security_service_unavailable',
  ) {
    super(
      `The inbox check temporarily failed${status ? ` (HTTP ${status})` : ''}${code ? `: ${code}` : ''}.`,
    );
    this.retryAfterMs = code === 'public_budget_exceeded' ? 300_000 : 60_000;
  }
}
export class IntegrationPermissionError extends Error {}
export type IntegrationCatalogAccessCode =
  'installation_enrollment_required' | 'installation_revoked' | 'browser_pairing_required';
export class IntegrationCatalogAccessDenied extends Error {
  constructor(readonly code?: IntegrationCatalogAccessCode) {
    super(
      code === 'installation_enrollment_required'
        ? 'This Nod installation needs enrollment for app access. Contact support if it remains blocked.'
        : code === 'installation_revoked'
          ? 'App access for this Nod installation was revoked. Contact support to restore it.'
          : code === 'browser_pairing_required'
            ? 'App access needs browser pairing. Complete the app connection in your browser, then try again.'
            : 'The app catalog could not authorize this request. Contact support if it persists.',
    );
    if (code) this.message += ` Proxy code: ${code}. HTTP 403.`;
  }
}
export type IntegrationCatalogProxyErrorCode =
  | 'rate_limited'
  | 'installation_busy'
  | 'public_budget_exceeded'
  | 'provider_rate_limited'
  | 'service_unavailable'
  | 'security_service_unavailable'
  | 'public_access_unavailable'
  | 'provider_unavailable'
  | 'provider_request_failed'
  | 'catalog_unavailable'
  | 'operation_timeout'
  | 'invalid_limit_configuration'
  | 'invalid_provider_response'
  | 'unsafe_provider_response';
export class IntegrationCatalogFailure extends Error {
  readonly statusCode: number;
  constructor(
    readonly reason: IntegrationConnectionError['reason'],
    readonly status?: number,
    readonly code?: IntegrationCatalogProxyErrorCode,
  ) {
    super(
      code === 'public_budget_exceeded'
        ? 'The app request limit has been reached. Wait for it to reset before trying again.'
        : code === 'provider_rate_limited'
          ? 'The app provider is limiting requests. Wait for its limit to reset before trying again.'
          : reason === 'rate_limit'
            ? 'The app catalog is receiving too many requests. Wait a moment, then try again.'
            : reason === 'timeout'
              ? 'The app catalog took too long to respond. Try again shortly.'
              : reason === 'authorization' || reason === 'permission'
                ? 'The app catalog could not authorize this request. Try again later.'
                : reason === 'invalid_request'
                  ? 'The app catalog request was rejected. Try again later.'
                  : 'The app catalog is unavailable. Try again later.',
    );
    if (code) this.message += ` Proxy code: ${code}.`;
    if (status !== undefined) this.message += ` HTTP ${status}.`;
    this.statusCode =
      status === 502
        ? 502
        : reason === 'rate_limit'
          ? 429
          : reason === 'timeout'
            ? 504
            : reason === 'invalid_request'
              ? 502
              : 503;
  }
}
export class IntegrationConnectionError extends Error {
  readonly statusCode: number;
  constructor(
    readonly reason:
      'authorization' | 'permission' | 'rate_limit' | 'timeout' | 'unavailable' | 'invalid_request',
    readonly phase: 'session' | 'link',
    readonly status?: number,
    readonly code?:
      | 'installation_busy'
      | 'public_budget_exceeded'
      | 'service_unavailable'
      | 'security_service_unavailable',
  ) {
    super(
      code
        ? `The connection service refused this request: ${code}.`
        : reason === 'authorization' || reason === 'permission'
          ? 'The connection service could not authorize this request. Try connecting again, and contact support if it keeps failing.'
          : reason === 'rate_limit'
            ? 'The connection service is receiving too many requests. Wait a moment, then try connecting again.'
            : reason === 'timeout'
              ? 'The connection service took too long to respond. Try connecting again.'
              : reason === 'invalid_request'
                ? 'The connection service rejected this request. Try connecting again, and contact support if it keeps failing.'
                : 'The connection service could not complete the connection. Try connecting again shortly.',
    );
    if (status !== undefined) this.message += ` HTTP ${status}.`;
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
export interface ActivityReader {
  read(
    accountId: string,
    input: Omit<ObservationQuery, 'revision'>,
    signal: AbortSignal,
  ): Promise<ObservationBatch>;
  changeToken?(accountId: string, signal: AbortSignal): Promise<string>;
  identity?(accountId: string, email: string | null): string;
}
export interface IntegrationProvider {
  id: string;
  configured: boolean;
  configurationId?: string;
  ownsConnectionUrl?(url: string): boolean;
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
  ): Promise<{ pairingConfirmed: boolean }>;
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
  activity?: Readonly<Record<string, ActivityReader>>;
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
