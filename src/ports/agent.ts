import type { ProviderUsageEvent } from './provider-usage.ts';
import type { ExecutionEvent, ExecutionScope } from '../shared/execution.ts';
import type { ConnectedApp } from './integrations.ts';
import type { DiscoveredTool } from './discovered.ts';
import type { BrowserAction, BrowserPage, CredentialKind, WorkspaceSession } from './computer.ts';
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
  estimateUsd?: number | null;
  costSource: 'sdk_estimate' | 'unavailable';
  createdAt: string;
}
export type RuntimeObservation = (
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
) & { execution?: ExecutionScope };

export type BrowserConnectionRequest =
  | {
      action: 'connect';
      url: string;
      connectionId?: string;
      label?: string;
    }
  | { action: 'use'; url: string; connectionId: string }
  | { action: 'save'; url: string; connectionId: string; signedIn: true };

export interface BrowserStep {
  step: BrowserAction | { action: 'upload'; selector: string; path: string };
  page: BrowserPage;
  typed: string[];
  subagent: boolean;
}

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

export interface ConnectedMcpServer {
  connectionId: string;
  pathId: string;
  service: string;
  name: string;
  accountName: string;
  instructions?: string;
  tools: DiscoveredTool[];
}

export interface RuntimeContext {
  threadId: string;
  turnId: string;
  sessionId: string;
  resumed?: boolean;
  prompt: string;
  background?: boolean;
  channel?: string;
  timeZone?: string;
  locale?: string;
  hourCycle?: 'auto' | 'h12' | 'h23';
  notificationRule?: string;
  rules?: string;
  quietHours?: boolean;
  account?: RuntimeAccount;
  connectedApps?: ConnectedApp[];
  mcpServers?: ConnectedMcpServer[];
  currentMessageId?: string;
  replyTo?: { id: string; role: string; text: string; attachments?: MessageAttachment[] };
  history: Array<{
    role: string;
    text: string;
    createdAt?: string | Date;
    reaction?: string | null;
    attachments?: MessageAttachment[];
    unseen?: boolean;
    turnId?: string | null;
  }>;
  relatedConversation?: Array<{
    id?: string;
    role: string;
    text: string;
    shortened?: boolean;
    createdAt?: string | Date;
  }>;
  memory?: string;
  learnedSkills?: Array<{ name: string; description: string }>;
  checkIn?: { budgetUsd: number; spentUsd: number };
  previousFailure?: string;
  taskContext?: {
    id: string;
    title: string;
    brief: string;
    doneWhen: string;
    revision: number;
    messageId?: string | null;
  };
  tasks?: import('../shared/contracts.ts').Task[];
  workspacePath: string;
  signal: AbortSignal;
  attachments: Array<{
    path: string;
    mimeType: string;
    workspaceFile?: string;
    source?: Artifact['source'];
  }>;
  emit(type: string, summary: string, event?: ExecutionEvent): Promise<void>;
  reply(text: string, streamId?: string, replyToMessageId?: string): Promise<void>;
  reactToMessage?(
    messageId: string,
    reaction: MessageReaction | null,
  ): Promise<AgentReactionResult>;
  connections?(
    action: 'list' | 'discover' | 'connect' | 'propose',
    service?: string,
    proposal?: unknown,
    newAccount?: boolean,
    query?: string,
    connectionId?: string,
  ): Promise<unknown>;
  browserConnection?(request: BrowserConnectionRequest): Promise<unknown>;
  browserStep?(
    request: BrowserStep,
  ): Promise<'run' | 'refused' | { [appConfirmation]: string } | { result: unknown }>;
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
    input: {
      origin: string;
      label: string;
    } & (
      | {
          kind: CredentialKind;
          savedLoginId?: string;
          usernameSelector?: string;
          passwordSelector?: string | string[];
          submitSelector?: string;
          emailCode?: boolean;
          emailRecipient?: string;
        }
      | {
          kind: 'method';
          methods: { label: string; selector: string }[];
        }
    ),
  ): Promise<{ url: string } | { filled: true } | { [appConfirmation]: string }>;
  requestPayment?(input: unknown): Promise<{ question: string; url?: string }>;
  integration(
    action: string,
    args: Record<string, unknown>,
    signal?: AbortSignal,
    admit?: (asks: boolean) => Promise<void>,
  ): Promise<unknown>;

  manage(
    action: string,
    args: Record<string, unknown>,
    admit?: (asks: boolean) => Promise<void>,
  ): Promise<unknown>;
  task?(input: unknown): Promise<unknown>;
  takeMessages?(): Promise<
    Array<{
      id: string;
      text: string;
      replyTo?: RuntimeContext['replyTo'];
      attachments: RuntimeContext['attachments'];
    }>
  >;
}
export interface RuntimeResult {
  status: 'succeeded' | 'waiting_credentials' | 'waiting_user';
  waitingFor?: 'question' | 'approval' | 'credentials';
  message?: string;
  handoffBrowserId?: string;
  result?: string;
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
  deferred?: { namespace: string; description: string };
}
export interface AgentTool extends AgentToolMetadata {
  parallel?: boolean;
  execute(args: Record<string, unknown>, options?: { nested?: boolean }): Promise<AgentToolResult>;
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
  | { type: 'error'; message: string };
export interface AgentSessionOptions extends ExecutionScope {
  ephemeral?: boolean;
  systemPrompt: string;
  ownerContext?: string;
  tools: AgentTool[];
  workspace: WorkspaceSession;
  timeZone?: string;
  runTool(
    name: string,
    params: unknown,
    run: () => Promise<AgentToolResult>,
    options?: { nested?: boolean },
  ): Promise<AgentToolResult>;
  onEvent(event: AgentEvent): void;
  shouldStop(): boolean;
  nextMessages?(): Promise<Array<{ text: string; images: AgentImage[] }>>;
}
export interface AgentSession {
  resumed: boolean;
  readsImages?: boolean;
  prompt(text: string, images: AgentImage[]): Promise<void>;
  abort(): void | Promise<void>;
  dispose(): void | Promise<void>;
}
export interface Agent {
  open(options: AgentSessionOptions): Promise<AgentSession>;
  dispose(): void | Promise<void>;
}
export class ModelRequestError extends Error {}
