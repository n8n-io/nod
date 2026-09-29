import type { ProviderUsageEvent } from './provider-usage.ts';
import type { CredentialKind } from './computer.ts';
import type { AgentReactionResult, Artifact, MessageReaction } from '../shared/contracts.ts';
export interface CredentialInvitation {
  origin: string;
  kind: CredentialKind;
  methodSelection?: boolean;
  savedLoginAvailable?: boolean;
}

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
  | { action: 'use'; url: string; connectionId: string };

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

export interface RuntimeContext {
  taskId: string;
  ownerId: string;
  prompt: string;
  background?: boolean;
  readOnly?: boolean;
  channel?: string;
  timeZone?: string;
  locale?: string;
  hourCycle?: 'auto' | 'h12' | 'h23';
  account?: RuntimeAccount;
  currentMessageId?: string;
  replyTo?: { id: string; role: string; text: string; attachments?: MessageAttachment[] };
  history: Array<{
    id?: string;
    role: string;
    text: string;
    createdAt?: string | Date;
    reaction?: string | null;
    assistantReaction?: MessageReaction | null;
    attachments?: MessageAttachment[];
  }>;
  sharedHistory?: Array<{ role: string; text: string; createdAt: string | Date; channel: string }>;
  memories: string[];
  personalContext?: {
    profile: { name: string; location: string; phone: string; preferences: string };
    activeGoals: Array<{
      title: string;
      description: string;
      progress: number;
      nextAction: string;
      targetDate: string | null;
    }>;
  };
  workspacePath: string;
  signal: AbortSignal;
  attachments: Array<{ path: string; mimeType: string }>;
  emit(type: string, summary: string): Promise<void>;
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
  ): Promise<unknown>;
  browserConnection?(request: BrowserConnectionRequest): Promise<unknown>;
  waitForUser?(question: string): Promise<void>;
  startExternalAction?(): Promise<void>;
  freshSession?: boolean;
  checkOutcome?: boolean;
  reportOutcome?(outcome: 'completed' | 'not_completed', message: string): Promise<void>;
  delta(text: string, streamId?: string, done?: boolean): void;
  remember(text: string): Promise<void>;
  publish(path: string, name?: string): Promise<Artifact>;
  publishScreenshot?(bytes: Uint8Array, name?: string): Promise<Artifact>;
  publishBrowserFile?(file: {
    bytes: Uint8Array;
    name: string;
    mimeType: string;
  }): Promise<Artifact>;
  createAudio?(text: string): Promise<Artifact>;
  requestCredential(input: {
    origin: string;
    label: string;
    kind: CredentialKind;
    usernameSelector?: string;
    passwordSelector?: string;
    submitSelector?: string;
  }): Promise<{ url?: string; filled?: boolean; invitation?: CredentialInvitation }>;
  integration(action: string, args: Record<string, unknown>): Promise<unknown>;
  downloadIntegrationFile?(
    action: string,
    args: Record<string, unknown>,
  ): Promise<Artifact & { content?: string }>;
  manage(action: string, args: Record<string, unknown>): Promise<unknown>;
}
export interface PromptSnapshot {
  id: string;
  system: string;
  instruction: string;
  resumed: boolean;
  imageCount: number;
  reason: 'user' | 'secure_resume';
  createdAt: string;
}
export interface RuntimeResult {
  status: 'succeeded' | 'waiting_credentials' | 'waiting_user';
  waitingFor?: 'question' | 'approval' | 'credentials' | 'browser';
  question?: string;
}
export interface AgentImage {
  type: 'image';
  data: string;
  mimeType: string;
}
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
  execute(args: Record<string, unknown>): Promise<AgentToolResult>;
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
  taskId: string;
  systemPrompt: string;
  tools: AgentTool[];
  onEvent(event: AgentEvent): void;
  shouldStop(): boolean;
  fresh?: boolean;
}
export interface AgentSession {
  resumed: boolean;
  prompt(text: string, images: AgentImage[]): Promise<void>;
  abort(): void | Promise<void>;
  dispose(): void | Promise<void>;
}
export interface Agent {
  open(options: AgentSessionOptions): Promise<AgentSession>;
  dispose(): void | Promise<void>;
}
