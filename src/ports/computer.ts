import { browserErrorMessage, type BrowserErrorCode } from '../shared/browser-errors.ts';
import type { BrowserHandoffInput } from '../shared/browser-handoff.ts';

export class BrowserActionError extends Error {
  constructor(
    readonly code: BrowserErrorCode,
    readonly detail?: string,
  ) {
    super(
      detail
        ? `${browserErrorMessage(code)} The browser said: ${detail}`
        : browserErrorMessage(code),
    );
    this.name = 'BrowserActionError';
  }
}

export interface BrowserAction {
  action:
    | 'open'
    | 'snapshot'
    | 'click'
    | 'fill'
    | 'type'
    | 'press'
    | 'scroll'
    | 'select'
    | 'check'
    | 'uncheck'
    | 'hover'
    | 'drag'
    | 'back'
    | 'forward'
    | 'reload'
    | 'tab_list'
    | 'tab_switch'
    | 'evaluate'
    | 'wait'
    | 'accept_dialog'
    | 'dismiss_dialog';
  url?: string;
  script?: string;
  tabId?: string;
  selector?: string;
  targetSelector?: string;
  x?: number;
  y?: number;
  points?: Array<{ x: number; y: number }>;
  durationMs?: number;
  text?: string;
  key?: string;
  load?: 'load' | 'domcontentloaded' | 'networkidle';
  direction?: 'up' | 'down';
  amount?: number;
  waitMs?: number;
  offset?: number;
  timeZone?: string;
  locale?: string;
  expectOrigin?: string;
  expectUrl?: string;
  expectTarget?: string;
  readOnly?: boolean;
}
export interface BrowserControl {
  role: string;
  name: string;
}
export interface BrowserObservation {
  text: string;
  url: string;
}
export const browserRequestBytes = 16 * 1024 * 1024;
export interface BrowserDownloadInput {
  selector?: string;
  url?: string;
  name?: string;
  expectOrigin?: string;
  expectUrl?: string;
  expectTarget?: string;
}
export interface BrowserDownload {
  bytes: Buffer;
  name: string;
  mimeType: string;
}
export interface BrowserUploadInput {
  selector: string;
  name: string;
  bytes: Uint8Array;
  expectOrigin?: string;
  expectUrl?: string;
  expectTarget?: string;
}
export type CredentialKind = 'identifier' | 'password' | 'otp';
export interface BrowserPage {
  origin: string;
  url: string;
  target?: string;
  controls?: BrowserControl[];
  submits?: { method: string; to: string } | 'unknown';
  dropTarget?: BrowserControl[];
  dialog?: string;
}
export interface CredentialInput {
  threadId: string;
  origin: string;
  kind?: CredentialKind;
  username?: string;
  password?: string;
  code?: string;
  usernameSelector?: string;
  passwordSelector?: string | string[];
  submitSelector?: string;
}
export type CardExpiryField = string | { selector: string; format: string; locale?: string };
export interface CardFields {
  number: string;
  expiry?: CardExpiryField;
  expiryMonth?: CardExpiryField;
  expiryYear?: CardExpiryField;
  securityCode?: string;
  name?: string;
}
export interface CardEntry {
  threadId: string;
  fields: CardFields;
  document: string;
  destinations: Partial<Record<keyof CardFields, string>>;
  submitSelector?: string;
  card: {
    cardNumber: string;
    expiryMonth: number;
    expiryYear: number;
    cardholder: string;
    securityCode?: string;
  };
}
export interface CredentialSubmission {
  status: 'submitted';
}
export interface Computer {
  bindProfile(threadId: string, profileId: string): Promise<void>;
  deleteProfile(profileId: string): Promise<void>;
  act(threadId: string, input: BrowserAction, signal?: AbortSignal): Promise<BrowserObservation>;
  download(
    threadId: string,
    input: BrowserDownloadInput,
    signal?: AbortSignal,
  ): Promise<BrowserDownload>;
  upload(
    threadId: string,
    input: BrowserUploadInput,
    signal?: AbortSignal,
  ): Promise<BrowserObservation>;
  screenshot(threadId: string, signal?: AbortSignal): Promise<Buffer | null>;
  control(
    threadId: string,
    input: BrowserHandoffInput,
    signal?: AbortSignal,
  ): Promise<string | void>;
  view(threadId: string, signal: AbortSignal): AsyncIterable<Buffer>;
  screenStatus(threadId: string): {
    state: 'live' | 'last_known' | 'unavailable';
    capturedAt?: string;
  };
  injectCredentials(input: CredentialInput): Promise<CredentialSubmission | void>;
  fillCard(input: CardEntry): Promise<void>;
  cardDestinations(
    threadId: string,
    fields: CardFields,
  ): Promise<{ document: string; destinations: Partial<Record<keyof CardFields, string>> }>;
  checkoutImage(threadId: string): Promise<Uint8Array>;
  currentPage(threadId: string, step?: BrowserAction): Promise<BrowserPage>;
  signInMethods?(
    threadId: string,
    origin: string,
    methods: { label: string; selector: string }[],
    signal?: AbortSignal,
  ): Promise<{ document: string; methods: { id: string; label: string; page: BrowserPage }[] }>;
  selectSignInMethod?(
    threadId: string,
    input: { origin: string; document: string; methodId: string },
    signal?: AbortSignal,
  ): Promise<void>;
  hold(threadId: string, held: boolean): Promise<void>;
  close(threadId: string): Promise<void>;
  clear(threadId: string): Promise<void>;
  discard(threadId: string): Promise<void>;
  dispose(): Promise<void>;
}
export interface WorkspaceExecOptions {
  input?: string;
  signal?: AbortSignal;
  timeoutMs?: number;
  onData?(chunk: Buffer): void;
  notices?: boolean;
}
export type CliSource = { npm: string } | { pypi: string } | { url: string; sha256?: string };
export interface ConnectedCli {
  id: string;
  command: string;
  source: CliSource;
}
export interface WorkspaceSession {
  path: string;
  instructions: string;
  exec(command: string, options?: WorkspaceExecOptions): Promise<{ exitCode: number }>;
  runConnectedCli?(
    cli: ConnectedCli,
    args: string[],
    environment: Record<string, string>,
    timeoutSeconds?: number,
  ): Promise<{ exitCode: number; output: string }>;
}
export interface Workspace {
  connectedCliAvailable?: boolean;
  writeArtifact(
    threadId: string,
    path: string,
    bytes: Uint8Array,
    signal?: AbortSignal,
  ): Promise<void>;
  readArtifact(
    threadId: string,
    path: string,
    maxBytes: number,
    purpose?: 'attachment' | 'publication',
  ): Promise<Uint8Array>;
  open(input: { threadId: string; workspacePath: string; signal: AbortSignal }): WorkspaceSession;
  dispose(): void | Promise<void>;
}
