export type StartupReason =
  | 'status_regular'
  | 'status_changed'
  | 'status_large'
  | 'status_json'
  | 'status_fields'
  | 'status_read'
  | 'status_check'
  | 'preserve_large'
  | 'disabled'
  | 'previous_status'
  | 'report_large'
  | 'review_required'
  | 'previous_send'
  | 'rollback_failed'
  | 'original_required'
  | 'partial_required'
  | 'bytes_unavailable'
  | 'helper_initialized'
  | 'action_unavailable'
  | 'collector_https'
  | 'collector_prefix'
  | 'collector_config'
  | 'collector_required';
export type StartupPhase =
  | 'idle'
  | 'preparing'
  | 'starting'
  | 'ready'
  | 'error'
  | 'updating'
  | 'stopping'
  | 'downloading'
  | 'verifying'
  | 'install'
  | 'installing'
  | 'unknown';
export type StartupStage =
  | 'computer'
  | 'runtime'
  | 'engine'
  | 'storage'
  | 'download'
  | 'extract'
  | 'install'
  | 'update'
  | 'connect'
  | 'health'
  | 'ready'
  | 'unknown';
export type StartupEvent =
  | 'runtime_prepare'
  | 'runtime_ready'
  | 'runtime_failed'
  | 'engine_start'
  | 'engine_exit'
  | 'health_timeout'
  | 'startup_failed'
  | 'update'
  | 'diagnostic_text_omitted';
export type StartupSyscall =
  | 'open'
  | 'read'
  | 'write'
  | 'rename'
  | 'unlink'
  | 'mkdir'
  | 'rmdir'
  | 'stat'
  | 'lstat'
  | 'fsync'
  | 'close'
  | 'connect'
  | 'getaddrinfo'
  | 'spawn'
  | 'kill';
export type StartupSignal =
  | 'SIGINT'
  | 'SIGTERM'
  | 'SIGKILL'
  | 'SIGABRT'
  | 'SIGSEGV'
  | 'SIGBUS'
  | 'SIGILL'
  | 'SIGFPE'
  | 'SIGHUP'
  | 'SIGQUIT'
  | 'SIGPIPE';
export type StartupStep =
  | 'wsl'
  | 'profile'
  | 'assets'
  | 'download'
  | 'extract'
  | 'import'
  | 'update'
  | 'start'
  | 'storage'
  | 'workspace'
  | 'browser'
  | 'ready'
  | 'loading'
  | 'loaded'
  | 'database'
  | 'threads'
  | 'memory'
  | 'apps'
  | 'listening'
  | 'check'
  | 'create';
export function startupWslCode(value: unknown): string | undefined;
export type StartupErrorFacts = {
  detailsOmitted: true;
  class?: string;
  errno?: string;
  syscall?: StartupSyscall;
  httpStatus?: number;
  exitCode?: number;
  signal?: StartupSignal;
  code?: string;
  step?: StartupStep;
  wslCode?: string;
};
export type StartupEventFacts = {
  event: StartupEvent;
  textOmitted: true;
  error?: StartupErrorFacts;
  phase?: StartupPhase;
  stage?: StartupStage;
  step?: StartupStep;
  durationMs?: number;
  count?: number;
  exitCode?: number;
  signal?: StartupSignal;
  httpStatus?: number;
};
export type StartupStatusFacts = {
  phase: StartupPhase;
  stage: StartupStage;
  runtimePhase: StartupPhase;
  errorPresent: boolean;
  detailsOmitted: true;
  failure?: StartupErrorFacts;
};
export function startupErrorFacts(value: unknown): StartupErrorFacts;
export function startupStatusFacts(value: unknown): StartupStatusFacts;
export function startupEventFacts(event?: unknown, details?: unknown): StartupEventFacts;
export function startupLogFacts(value: unknown): {
  status: 'unavailable' | 'collected';
  truncated?: boolean;
  entries: Array<StartupEventFacts & { ageMs: number }>;
};
export class StartupFeedbackError extends Error {
  startupReason?: StartupReason;
  detailsOmitted: true;
  class?: string;
  errno?: string;
  syscall?: StartupSyscall;
  httpStatus?: number;
  exitCode?: number;
  signal?: StartupSignal;
  code?: string;
  step?: StartupStep;
  wslCode?: string;
  errors?: StartupErrorFacts[];
  constructor(reason: string, cause?: unknown);
}
export function startupFailureMessage(error: unknown): string;
export function startupReceiptFacts(
  value: unknown,
  submissionId: string,
): import('./feedback.ts').FeedbackReceipt;
