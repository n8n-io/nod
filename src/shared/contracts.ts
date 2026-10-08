import type { TaskSuggestions } from './onboarding';
export type TurnStatus = 'queued' | 'running' | 'succeeded' | 'waiting' | 'failed' | 'cancelled';
export interface Artifact {
  id: string;
  name: string;
  mimeType: string;
  size: number;
  url: string;
  source?: 'browser_screenshot';
}
export type MessageReaction = string;
export type AgentReactionResult =
  | { status: 'updated' | 'unchanged' }
  | { status: 'skipped'; reason: 'cooldown' | 'already_reacted' | 'unavailable' };
export interface Message {
  id: string;
  role: 'user' | 'assistant';
  text: string;
  turnId: string | null;
  createdAt: string;
  attachments: Artifact[];
  streamId?: string | null;
  reaction?: MessageReaction | null;
  reactions?: Array<{ actor: 'user' | 'assistant'; reaction: MessageReaction }>;
  replyToMessageId?: string | null;
  replyTo?: { id: string; role: 'user' | 'assistant'; text: string } | null;
  suggestions?: TaskSuggestions | null;
}
export interface SubmitMessageResponse {
  threadId: string;
  turnId: string;
  messageId: string;
  messageText?: string;
  verificationStatus?: 'pending' | 'submitted' | 'unavailable';
}
export interface VerificationRequest {
  id: string;
  turnId: string;
  expiresAt: string;
}
export interface Turn {
  id: string;
  status: TurnStatus;
  source: 'user' | 'schedule' | 'event' | 'resume';
  createdAt: string;
  finishedAt?: string | null;
  error?: string | null;
  showTyping?: boolean;
}
export interface TurnEvent {
  id: string;
  turnId: string;
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
  hasPassword: boolean;
}
interface VaultCardDetails extends VaultCardEntry {
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
export interface CredentialRequest {
  id: string;
  turnId: string;
  origin: string;
  label: string;
  kind: 'identifier' | 'password' | 'otp';
  fields?: { kind: 'identifier' | 'password' | 'otp'; selector: string; label: string }[];
  status: 'pending' | 'filled' | 'expired';
  expiresAt: string;
  savedEntries?: VaultLoginEntry[];
  selectedEntryId?: string;
}
export interface Connection {
  canReconnect?: boolean;
  reconnectRequired?: boolean;
  slug: string;
  name: string;
  logoUrl?: string;
  categories?: string[];
  status: 'not_configured' | 'disconnected' | 'connected';
  accountId?: string;
  connectionId?: string;
  accountName?: string;
  accountEmail?: string;
  savedLogin?: boolean;
  triggersActive?: boolean;
  triggerStatus?: 'active' | 'pending' | 'unavailable' | 'disabled';
  triggersEnabled: boolean;
  description?: string;
  supportsTriggers?: boolean;
  accessPaths?: Array<{ id: string; kind: 'http' | 'mcp' | 'browser' | 'cli'; endpoint: string }>;
  browserState?: 'pending' | 'saved' | 'needs_sign_in' | 'disconnecting';
  checkedAt?: string;
  browserUrl?: string;
}
export interface AppSetupStatus {
  completed: string[];
  apps: Array<{ hash: string; slug: string; name: string; logoUrl?: string }>;
}
export interface Configuration {
  provider: string;
  model: string;
  llmReady: boolean;
  integrationsReady: boolean;
  localOnly: boolean;
  conversationResetEnabled: boolean;
}
export interface AppState {
  threadId: string;
  hasEarlierMessages?: boolean;
  verificationRequests?: VerificationRequest[];
  planningTasks?: boolean;
  messages: Message[];
  turns: Turn[];
  configuration: Configuration;
}
export interface MessageHistoryPage {
  messages: Message[];
  hasMore: boolean;
}
export interface CurrentBrowser {
  threadId: string;
  title: string;
  status: string;
  lastActivityAt: string;
}
export type TaskStatus =
  'working' | 'needs_you' | 'waiting' | 'scheduled' | 'stalled' | 'done' | 'cancelled';
export interface TaskWait {
  who: string;
  via: string;
}
export interface Task {
  id: string;
  title: string;
  doneWhen: string;
  now: string;
  result: string;
  status: TaskStatus;
  question: string | null;
  waitingFor: TaskWait[];
  nextCheck: string | null;
  createdAt: string;
  updatedAt: string;
  closedAt: string | null;
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
  baselineObservation: ScheduleObservation | null;
}
export type ScheduleObservation = {
  sourceUrl: string;
  summary: string;
  checkedAt: string;
} & ({ status: 'verified'; value: string } | { status: 'unavailable'; value: null });
export interface ScheduleRun {
  id: string;
  scheduleId: string;
  title: string;
  turnId: string;
  scheduledFor: string;
  timeZone: string;
  createdAt: string;
  status: TurnStatus;
  error: string | null;
  observation: ScheduleObservation | null;
  messageId: string | null;
  messagePreview: string | null;
  messageText: string | null;
}
export interface ScheduleHistory {
  runs: ScheduleRun[];
  nextCursor: string | null;
}
export type HourCycle = 'auto' | 'h12' | 'h23';
export interface Preferences {
  notificationRule: string;
  timeZone: string | null;
  locale: string | null;
  hourCycle: HourCycle;
  quietHoursEnabled: boolean;
  quietStart: string;
  quietEnd: string;
}
export type ChannelProvider = 'telegram' | 'whatsapp';
export interface ChannelSetupSummary {
  provider: ChannelProvider;
  enabled: boolean;
  accountName?: string;
  accountHandle?: string;
  mode?: 'polling' | 'webhook';
  webhookStatus?: 'registered' | 'manual_setup' | 'registration_pending';
  webhookUrl?: string;
  pairedUser?: string;
  pairedUsername?: string;
  allowedUserId?: string;
  pairingCandidate?: { id: string; name: string; username?: string };
  pairingExpiresAt?: string;
}
