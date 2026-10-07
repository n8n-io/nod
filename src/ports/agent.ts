import type { ProviderUsageEvent } from './provider-usage.ts';
import type { ConnectedApp } from './integrations.ts';
import type { CredentialKind, WorkspaceSession } from './computer.ts';
import type { AgentReactionResult, Artifact, MessageReaction } from '../shared/contracts.ts';

export interface ModelUsageObservation {
  type: 'model_usage';
  status?: 'succeeded' | 'failed' | 'cancelled';
  id: string;
  provider: string;
  model: string;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  totalTokens: number;
  costUsd: number | null;
  costSource: 'sdk_estimate' | 'unavailable';
  createdAt: string;
}
export type RuntimeObservation =
  | { type: 'tool_start'; id: string; name: string; input: unknown; startedAt: string }
  | {
      type: 'tool_end';
      id: string;
      name: string;
      status: 'succeeded' | 'failed' | 'cancelled';
      output?: unknown;
      error?: string;
      finishedAt: string;
      durationMs: number;
    }
  | ModelUsageObservation;

export type BrowserConnectionRequest =
  | { action: 'connect'; url: string; connectionId?: string; label?: string }
  | { action: 'use'; url: string; connectionId: string }
  | { action: 'save'; url: string; connectionId: string; signedIn: true };

interface MessageAttachment {
  name: string;
  mimeType: string;
  workspaceFile?: string;
}

export interface RuntimeAccount {
  preferredName: string | null;
  fullName: string | null;
  email: string | null;
}

export type ActivityCheckResult =
  | {
      status: 'verified';
      value: string;
      summary: string;
      finding?: { id: string; version?: string; url?: string; summary: string };
    }
  | { status: 'unavailable'; summary: string };

export interface RuntimeContext {
  threadId: string;
  turnId: string;
  prompt: string;
  background?: boolean;
  readOnly?: boolean;
  limits?: { maxToolCalls: number; timeoutMs: number };
  activityCheck?: {
    connectionId: string;
    previous?: { checkedAt: string; value: string; summary: string };
    record(result: ActivityCheckResult, signal?: AbortSignal): Promise<void>;
  };
  channel?: string;
  timeZone?: string;
  locale?: string;
  hourCycle?: 'auto' | 'h12' | 'h23';
  notificationRule?: string;
  account?: RuntimeAccount;
  connectedApps?: ConnectedApp[];
  currentMessageId?: string;
  replyTo?: { id: string; role: string; text: string; attachments?: MessageAttachment[] };
  history: Array<{
    role: string;
    text: string;
    createdAt?: string | Date;
    reaction?: string | null;
    attachments?: MessageAttachment[];
    unseen?: boolean;
  }>;
  personalContext?: {
    profile: { name: string; location: string; phone: string; preferences: string };
  };
  memory?: string;
  workspacePath: string;
  signal: AbortSignal;
  attachments: Array<{ path: string; mimeType: string }>;
  emit(type: string, summary: string): Promise<void>;
  markUntrustedContext?(): Promise<void>;
  flagInjection?(findings: string[]): Promise<void>;
  observe?(event: RuntimeObservation): Promise<void>;
  inspectPrompt?(snapshot: PromptSnapshot): Promise<void>;
  reply(text: string, streamId?: string, replyToMessageId?: string): Promise<void>;
  reactToMessage?(
    messageId: string,
    reaction: MessageReaction | null,
  ): Promise<AgentReactionResult>;
  connections?(
    action: 'list' | 'connect' | 'propose',
    service?: string,
    proposal?: unknown,
    newAccount?: boolean,
  ): Promise<unknown>;
  browserConnection?(request: BrowserConnectionRequest): Promise<unknown>;
  waitForUser?(question: string): Promise<void>;
  delta(text: string, streamId?: string, done?: boolean): void;
  publish(path: string, name?: string): Promise<Artifact>;
  readWorkspaceFile?(path: string, maxBytes: number): Promise<Uint8Array>;
  publishScreenshot?(bytes: Uint8Array, name?: string): Promise<Artifact>;
  publishBrowserFile?(file: {
    bytes: Uint8Array;
    name: string;
    mimeType: string;
  }): Promise<Artifact & { workspaceFile: string }>;
  createAudio?(text: string): Promise<Artifact>;
  requestCredential(
    input:
      | { id: string; origin: string }
      | {
          id?: never;
          origin: string;
          label: string;
          kind: CredentialKind;
          usernameSelector?: string;
          passwordSelector?: string;
          emailCode?: boolean;
          emailRecipient?: string;
          savedLoginId?: string;
        },
  ): Promise<{
    url?: string;
    filled?: boolean;
    credential?: { username: string; password: string };
  }>;
  integration(
    action: string,
    args: Record<string, unknown>,
    signal?: AbortSignal,
  ): Promise<unknown>;

  manage(action: string, args: Record<string, unknown>): Promise<unknown>;
  task?(input: unknown): Promise<unknown>;
  takeMessages?(): Promise<Array<{ id: string; text: string }>>;
}
export interface PromptSnapshot {
  id: string;
  system: string;
  instruction: string;
  resumed: boolean;
  imageCount: number;
  reason: 'user' | 'secure_resume' | 'steer';
  createdAt: string;
}
export interface RuntimeResult {
  status: 'succeeded' | 'waiting_credentials' | 'waiting_user';
  waitingFor?: 'question' | 'approval' | 'credentials';
  question?: string;
}
export interface AgentImage {
  type: 'image';
  data: string;
  mimeType: string;
}
export const appConfirmation = Symbol('appConfirmation');
export interface AgentToolResult {
  content: Array<{ type: 'text'; text: string } | AgentImage>;
  details?: unknown;
}
export interface AgentToolMetadata {
  name: string;
  description: string;
  parameters: Record<string, unknown>;
}
export interface AgentTool extends AgentToolMetadata {
  parallel?: boolean;
  execute(args: Record<string, unknown>): Promise<AgentToolResult>;
}
export interface SkillLibrary {
  catalog: Array<{ name: string; description: string }>;
  read(name: string, file?: string): { name: string; file: string; content: string };
}
export type AgentEvent =
  | { type: 'provider_usage'; usage: ProviderUsageEvent }
  | { type: 'turn_start' }
  | { type: 'message_start' }
  | { type: 'message_end'; status?: 'succeeded' | 'failed' | 'cancelled' | 'incomplete' }
  | { type: 'text_delta'; text: string }
  | { type: 'final'; text: string }
  | ModelUsageObservation
  | { type: 'error' };
export interface AgentSessionOptions {
  threadId: string;
  turnId: string;
  systemPrompt: string;
  systemContext?: string;
  tools: AgentTool[];
  workspace: WorkspaceSession;
  timeZone?: string;
  background?: boolean;
  runTool(
    name: string,
    params: unknown,
    run: () => Promise<AgentToolResult>,
    options?: { nested?: boolean },
  ): Promise<AgentToolResult>;
  onEvent(event: AgentEvent): void;
  shouldStop(): boolean;
  nextMessages?(): Promise<string[]>;
}
export interface AgentSession {
  resumed: boolean;
  prompt(text: string, images: AgentImage[]): Promise<void>;
  abort(): void | Promise<void>;
  dispose(): void | Promise<void>;
}
export interface Agent {
  nativeTools?: AgentToolMetadata[];
  open(options: AgentSessionOptions): Promise<AgentSession>;
  dispose(): void | Promise<void>;
}
