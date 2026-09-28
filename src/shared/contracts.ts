export type TaskStatus =
  | 'queued'
  | 'running'
  | 'waiting_credentials'
  | 'waiting_user'
  | 'succeeded'
  | 'failed'
  | 'cancelled';
export interface Artifact {
  id: string;
  name: string;
  mimeType: string;
  size: number;
  url: string;
}
export type MessageReaction = string;
export type AgentReactionResult =
  | { status: 'updated' | 'unchanged' }
  | { status: 'skipped'; reason: 'cooldown' | 'already_reacted' | 'unavailable' };
export interface Message {
  id: string;
  role: 'user' | 'assistant';
  text: string;
  taskId: string | null;
  createdAt: string;
  attachments: Artifact[];
  streamId?: string | null;
  reaction?: MessageReaction | null;
  reactions?: Array<{ actor: 'user' | 'assistant'; reaction: MessageReaction }>;
  replyToMessageId?: string | null;
  replyTo?: { id: string; role: 'user' | 'assistant'; text: string } | null;
}
export interface SubmitMessageResponse {
  taskId: string;
  continued: boolean;
  messageId: string;
  messageText?: string;
  verificationStatus?: 'pending' | 'submitted' | 'rejected' | 'unavailable';
}
export interface VerificationRequest {
  id: string;
  taskId: string;
  expiresAt: string;
}
export interface Task {
  id: string;
  title: string;
  status: TaskStatus;
  createdAt: string;
  updatedAt: string;
  error?: string | null;
  showTyping?: boolean;
}
export interface TaskEvent {
  id: string;
  taskId: string;
  type: string;
  summary: string;
  createdAt: string;
}
export interface VaultLoginEntry {
  kind: 'login';
  id: string;
  label: string;
  origin: string;
  usernameHint: string;
  identifierLabel?: string;
  updatedAt: string;
}
export interface VaultCardEntry {
  kind: 'card';
  id: string;
  label: string;
  brand: string;
  last4: string;
  expiryMonth: number;
  expiryYear: number;
  updatedAt: string;
}
export type VaultEntry = VaultLoginEntry | VaultCardEntry;
export type VaultListEntry = (VaultLoginEntry & { username: string }) | VaultCardEntry;
export interface VaultLoginDetails extends VaultLoginEntry {
  username: string;
}
export interface VaultCardDetails extends VaultCardEntry {
  cardholder: string;
  hasSecurityCode: boolean;
}
export type VaultEntryDetails = VaultLoginDetails | VaultCardDetails;
export interface VaultEntryPassword {
  password: string;
}
export interface VaultCardNumber {
  cardNumber: string;
}
export interface VaultCardSecurityCode {
  securityCode: string;
}
export interface VaultEntryUpdate {
  kind?: 'login';
  label: string;
  username: string;
  password?: string;
}
export interface VaultCardUpdate {
  kind: 'card';
  label: string;
  cardholder: string;
  cardNumber?: string;
  securityCode?: string | null;
  expiryMonth: number;
  expiryYear: number;
}
export interface CredentialRequest {
  id: string;
  taskId: string;
  origin: string;
  label: string;
  kind: 'identifier' | 'password' | 'otp';
  fields?: { kind: 'identifier' | 'password' | 'otp'; selector: string; label: string }[];
  methods?: {
    id: string;
    label: string;
    kind: 'credentials' | 'oauth' | 'passkey' | 'manual';
    supported: boolean;
    reason?: string;
  }[];
  status: 'pending' | 'filled' | 'expired';
  expiresAt: string;
  savedEntries?: VaultLoginEntry[];
  selectedEntryId?: string;
}
export interface Connection {
  slug: string;
  name: string;
  status: 'not_configured' | 'disconnected' | 'connected';
  accountId?: string;
  connectionId?: string;
  accountName?: string;
  accountEmail?: string;
  triggersActive?: boolean;
  triggerStatus?: 'active' | 'pending' | 'unavailable' | 'disabled';
  triggersEnabled: boolean;
  description?: string;
  supportsTriggers?: boolean;
  accessPaths?: Array<{ id: string; kind: 'http' | 'mcp' | 'browser'; endpoint: string }>;
}
export interface Configuration {
  provider: string;
  model: string;
  llmReady: boolean;
  speechReady: boolean;
  integrationsReady: boolean;
  browserAssistReady: boolean;
  inspectorEnabled: boolean;
  localOnly: boolean;
}
export interface AppState {
  conversationRevision?: number;
  verificationRequests?: VerificationRequest[];
  messages: Message[];
  tasks: Task[];
  configuration: Configuration;
}
export interface InspectorState {
  tasks: Task[];
  events: TaskEvent[];
  runtime: { browser: string; workspace: string; database: string };
  currentBrowser?: { taskId: string; title: string; status: string; lastActivityAt: string };
}
export interface MemoryFact {
  id: string;
  text: string;
  sourceMessageId: string | null;
  createdAt: string;
}
export interface Profile {
  name: string;
  location: string;
  phone: string;
  preferences: string;
}
export interface Goal {
  id: string;
  title: string;
  description: string;
  progress: number;
  status: 'active' | 'paused' | 'completed';
  nextAction: string;
  targetDate: string | null;
  updatedAt: string;
}
export interface Schedule {
  id: string;
  title: string;
  prompt: string;
  kind: 'once' | 'recurring';
  cron: string | null;
  runAt: string | null;
  timeZone: string;
  enabled: boolean;
  revision: number;
  nextRun: string | null;
  lastRun: ScheduleRun | null;
}
export interface ScheduleRun {
  id: string;
  scheduleId: string;
  title: string;
  taskId: string;
  scheduledFor: string;
  timeZone: string;
  createdAt: string;
  status: TaskStatus;
  error: string | null;
}
export interface ScheduleHistory {
  runs: ScheduleRun[];
  nextCursor: string | null;
}
export interface Approval {
  id: string;
  action: string;
  args: Record<string, unknown>;
  connection?: Pick<Connection, 'name' | 'accountName' | 'accountEmail'>;
  status: 'pending' | 'executing' | 'completed' | 'declined' | 'uncertain' | 'expired';
}
export interface Preferences {
  notificationRule: string;
  timeZone: string;
  quietHoursEnabled: boolean;
  quietStart: string;
  quietEnd: string;
}
