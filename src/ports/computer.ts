import { browserErrorMessage, type BrowserErrorCode } from '../shared/browser-errors.ts';
import type { BrowserHandoffInput } from '../shared/browser-handoff.ts';

export class BrowserActionError extends Error {
  constructor(readonly code: BrowserErrorCode) {
    super(browserErrorMessage(code));
    this.name = 'BrowserActionError';
  }
}

export interface BrowserAction {
  action:
    | 'open'
    | 'snapshot'
    | 'click'
    | 'fill'
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
    | 'evaluate';
  url?: string;
  script?: string;
  tabId?: string;
  selector?: string;
  targetSelector?: string;
  text?: string;
  key?: 'Enter' | 'Escape' | 'Tab' | 'ArrowDown' | 'ArrowUp' | 'PageDown' | 'PageUp';
  direction?: 'up' | 'down';
  waitMs?: number;
  offset?: number;
}
export interface BrowserCandidate {
  id: string;
  label: string;
}
export interface BrowserObservation {
  text: string;
  url: string;
  candidates: BrowserCandidate[];
}
export const browserDownloadBytes = 12 * 1024 * 1024;
export const browserUploadBytes = 12 * 1024 * 1024;
export interface BrowserDownloadInput {
  selector?: string;
  url?: string;
  name?: string;
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
}
export type CredentialKind = 'identifier' | 'password' | 'otp';
export interface BrowserPage {
  origin: string;
  url: string;
}
export interface CredentialInput {
  threadId: string;
  origin: string;
  kind?: CredentialKind;
  username?: string;
  password?: string;
  code?: string;
  usernameSelector?: string;
  passwordSelector?: string;
}
export interface CredentialSubmission {
  status: 'submitted' | 'rejected';
}
export interface Computer {
  currentSession?(): { threadId: string; lastActivityAt: string } | undefined;
  bindProfile?(threadId: string, profileId: string): Promise<void>;
  deleteProfile?(profileId: string): Promise<void>;
  act(threadId: string, input: BrowserAction, signal?: AbortSignal): Promise<BrowserObservation>;
  download?(
    threadId: string,
    input: BrowserDownloadInput,
    signal?: AbortSignal,
  ): Promise<BrowserDownload>;
  upload?(
    threadId: string,
    input: BrowserUploadInput,
    signal?: AbortSignal,
  ): Promise<BrowserObservation>;
  screenshot(threadId: string, signal?: AbortSignal): Promise<Buffer | null>;
  control?(threadId: string, input: BrowserHandoffInput, signal?: AbortSignal): Promise<void>;
  screenStatus?(threadId: string): {
    state: 'live' | 'last_known' | 'unavailable';
    capturedAt?: string;
  };
  injectCredentials(input: CredentialInput): Promise<CredentialSubmission | void>;
  currentPage(threadId: string): Promise<BrowserPage>;
  hold(threadId: string, until: number | null): Promise<void>;
  close(threadId: string): Promise<void>;
  dispose(): Promise<void>;
  status(): string;
}
export interface WorkspaceExecOptions {
  input?: string;
  signal?: AbortSignal;
  timeoutMs?: number;
  onData?(chunk: Buffer): void;
}
export interface WorkspaceSession {
  path: string;
  instructions: string;
  exec(command: string, options?: WorkspaceExecOptions): Promise<{ exitCode: number }>;
  executeProgram?(
    program: string,
    args: string[],
    environment: Record<string, string>,
    timeoutSeconds?: number,
  ): Promise<{ exitCode: number; output: string }>;
}
export interface Workspace {
  connectedCliAvailable?: boolean;
  writeArtifact?(
    threadId: string,
    path: string,
    bytes: Uint8Array,
    signal?: AbortSignal,
  ): Promise<void>;
  readArtifact?(
    threadId: string,
    path: string,
    maxBytes: number,
    purpose?: 'attachment' | 'publication',
  ): Promise<Uint8Array>;
  open(input: { threadId: string; workspacePath: string; signal: AbortSignal }): WorkspaceSession;
  status(): string;
  dispose(): void | Promise<void>;
}
