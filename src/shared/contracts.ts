import type { TaskSuggestions } from './onboarding';
import type { TrustBecause } from './trust';
export type TurnStatus = 'queued' | 'running' | 'succeeded' | 'waiting' | 'failed' | 'cancelled';
export interface Artifact {
  id: string;
  name: string;
  mimeType: string;
  size: number;
  url: string;
  source?: 'browser_screenshot' | 'sticker' | 'sticker-preview' | 'location' | 'contact';
}
export type MessageReaction = string;
export type AgentReactionResult =
  | { status: 'updated' | 'unchanged' }
  | {
      status: 'skipped';
      reason: 'cooldown' | 'already_reacted' | 'unavailable' | 'unsupported' | 'delivery_failed';
    };
export interface Message {
  id: string;
  role: 'user' | 'assistant';
  text: string;
  turnId: string | null;
  createdAt: string;
  attachments: Artifact[];
  receipt?: MessageReceipt;
  streamId?: string | null;
  reaction?: MessageReaction | null;
  reactions?: Array<{ actor: 'user' | 'assistant'; reaction: MessageReaction }>;
  replyToMessageId?: string | null;
  replyTo?: { id: string; role: 'user' | 'assistant'; text: string } | null;
  suggestions?: TaskSuggestions | null;
}
export interface MessageReceipt {
  sessionId: string;
  actions: Array<{ label: string; count: number }>;
  costUsd: number | null;
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
  kind: 'otp' | 'payment';
}
export interface Turn {
  id: string;
  handoffMessageId?: string | null;
  status: TurnStatus;
  source: 'user' | 'schedule' | 'event' | 'resume' | 'task';
  createdAt: string;
  finishedAt?: string | null;
  error?: string | null;
}
export interface Activity {
  turnId: string;
  taskId: string | null;
  title: string | null;
  step: string | null;
  site: string | null;
  since: string;
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
export type VaultListEntry =
  (VaultLoginEntry & { username: string; unreadable?: true }) | VaultCardEntry;
export interface VaultLoginDetails extends VaultLoginEntry {
  username: string;
  hasPassword: boolean;
  hasAuthenticator: boolean;
}
interface VaultCardDetails extends VaultCardEntry {
  cardholder: string;
}
export type VaultEntryDetails = VaultLoginDetails | VaultCardDetails;
export interface VaultEntryPassword {
  password: string;
}
export interface VaultCardNumber {
  cardNumber: string;
}
export type VaultActivityReason =
  | 'asked'
  | 'schedule'
  | 'always'
  | 'allowed'
  | 'revoked'
  | 'entered'
  | 'picked'
  | 'mailbox'
  | 'readonly'
  | 'background'
  | 'injection'
  | 'unrequested'
  | 'rule'
  | 'payment'
  | 'code_typed'
  | 'said_yes'
  | 'owner';
export interface VaultActivityEntry {
  id: string;
  at: string;
  action:
    | 'sign_in'
    | 'session'
    | 'code'
    | 'held'
    | 'asked'
    | 'card'
    | 'uncertain'
    | 'permission'
    | 'reveal';
  origin: string;
  itemId?: string;
  itemKind?: 'login' | 'session' | 'card';
  amount?: { minor: number; currency: string };
  task: string;
  reason: VaultActivityReason;
  because?: TrustBecause;
}
export interface VaultActivity {
  week: { signIns: number; payments: number; held: number };
  entries: VaultActivityEntry[];
  next?: { at: string; id: string };
}
export interface VaultPaymentCard {
  id: string;
  version: string;
  label: string;
  brand: string;
  last4: string;
}
export interface VaultImportResult {
  imported: number;
  existing: number;
  skipped: number;
  authenticatorKeys: number;
}

export interface VaultSession {
  kind: 'session';
  id: string;
  label: string;
  origin: string;
  url: string;
  state: 'pending' | 'saved' | 'needs_sign_in' | 'disconnecting';
  checkedAt?: string;
}
export interface CredentialRequest {
  id: string;
  turnId: string;
  origin: string;
  label: string;
  kind: 'identifier' | 'password' | 'otp' | 'method';
  methods?: { id: string; label: string }[];
  fields?: { kind: 'identifier' | 'password' | 'otp'; selector: string; label: string }[];
  status: 'pending' | 'entering' | 'uncertain' | 'filled' | 'expired';
  savedEntries?: (VaultLoginEntry & { username: string })[];
  selectedEntryId?: string;
  username?: string;
  passwordManager?: { name: string; account?: string };
}
export interface PasswordManagerLogin {
  id: string;
  title: string;
  username: string;
  website: string;
}
export interface Connection {
  canReconnect?: boolean;
  reconnectRequired?: boolean;
  disconnectPending?: boolean;
  slug: string;
  name: string;
  logoUrl?: string;
  categories?: string[];
  status: 'not_configured' | 'disconnected' | 'connected';
  accountId?: string;
  connectionId?: string;
  direct?: boolean;
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
  apps: Array<{
    hash: string;
    slug: string;
    name: string;
    logoUrl?: string;
    pairingConfirmed?: boolean;
  }>;
}
export interface Configuration {
  provider: string;
  model: string;
  llmReady: boolean;
  integrationsReady: boolean;
  conversationResetEnabled: boolean;
}
export interface AppState {
  tasks?: Task[];
  threadId: string;
  hasEarlierMessages?: boolean;
  verificationRequests?: VerificationRequest[];
  planningTasks?: boolean;
  messages: Message[];
  turns: Turn[];
  activity?: Activity[];
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
  | 'queued'
  | 'working'
  | 'needs_you'
  | 'waiting'
  | 'scheduled'
  | 'stalled'
  | 'failed'
  | 'done'
  | 'cancelled';
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
  questionMessageId?: string | null;
  waitingFor: TaskWait[];
  nextCheck: string | null;
  createdAt: string;
  updatedAt: string;
  closedAt: string | null;
  messageId?: string | null;
  steps?: string[];
  stepIndex?: number;
  revision?: number;
  appliedRevision?: number;
}
export interface TaskDetail {
  task: Task;
  events: Array<{
    id: string;
    type: string;
    summary: string;
    site: string | null;
    runId: string | null;
    parentRunId: string | null;
    createdAt: string;
  }>;
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
  monthlyUsd: number | null;
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
  rules: string;
  timeZone: string | null;
  locale: string | null;
  hourCycle: HourCycle;
  quietHoursEnabled: boolean;
  quietStart: string;
  quietEnd: string;
}
export type ChannelProvider = 'telegram' | 'whatsapp';
export interface ChannelLinkStatus {
  pairingId?: string;
  state:
    | 'connecting'
    | 'awaiting_scan'
    | 'connected'
    | 'disconnected'
    | 'logged_out'
    | 'expired'
    | 'failed';
  qr?: string;
  expiresAt?: string;
  accountHandle?: string;
  accountName?: string;
}
export interface ChannelSetupSummary {
  provider: ChannelProvider;
  enabled: boolean;
  accountName?: string;
  accountHandle?: string;
  mode?: 'polling' | 'webhook' | 'linked';
  linkMode?: 'bot' | 'self-chat';
  connectionState?: ChannelLinkStatus['state'];
  webhookStatus?: 'registered' | 'manual_setup' | 'registration_pending';
  webhookUrl?: string;
  pairedUser?: string;
  pairedUsername?: string;
  allowedUserId?: string;
  pairingCandidate?: { id: string; name: string; username?: string };
  pairingExpiresAt?: string;
}
export interface PaymentRequest {
  origin: string;
  amount: string;
  card: string;
  destinations: string[];
}
