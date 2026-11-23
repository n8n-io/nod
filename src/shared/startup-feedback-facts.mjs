const phases = new Set([
  'idle',
  'preparing',
  'starting',
  'ready',
  'error',
  'updating',
  'stopping',
  'downloading',
  'verifying',
  'install',
  'installing',
]);
const stages = new Set([
  'computer',
  'runtime',
  'engine',
  'storage',
  'download',
  'extract',
  'install',
  'update',
  'connect',
  'health',
  'ready',
]);
const events = new Set([
  'runtime_prepare',
  'runtime_ready',
  'runtime_failed',
  'engine_start',
  'engine_exit',
  'health_timeout',
  'startup_failed',
  'update',
]);
const classes = new Set([
  'Error',
  'TypeError',
  'RangeError',
  'SyntaxError',
  'ReferenceError',
  'AggregateError',
  'AbortError',
  'TimeoutError',
  'ZodError',
]);
const errnos = new Set([
  'EACCES',
  'EPERM',
  'EIO',
  'ENOENT',
  'ENOSPC',
  'EDQUOT',
  'EROFS',
  'EEXIST',
  'ENOTDIR',
  'EISDIR',
  'EINVAL',
  'EMFILE',
  'ENFILE',
  'ELOOP',
  'EBUSY',
  'ENOTEMPTY',
  'ENOSYS',
  'ENOTSUP',
  'EPIPE',
  'ECONNREFUSED',
  'ECONNRESET',
  'ECONNABORTED',
  'ETIMEDOUT',
  'ENETUNREACH',
  'EHOSTUNREACH',
  'ENOTFOUND',
  'EAI_AGAIN',
  'EADDRINUSE',
  'EADDRNOTAVAIL',
  'ERR_CANCELED',
]);
const syscalls = new Set([
  'open',
  'read',
  'write',
  'rename',
  'unlink',
  'mkdir',
  'rmdir',
  'stat',
  'lstat',
  'fsync',
  'close',
  'connect',
  'getaddrinfo',
  'spawn',
  'kill',
]);
const signals = new Set([
  'SIGINT',
  'SIGTERM',
  'SIGKILL',
  'SIGABRT',
  'SIGSEGV',
  'SIGBUS',
  'SIGILL',
  'SIGFPE',
  'SIGHUP',
  'SIGQUIT',
  'SIGPIPE',
]);
const steps = new Set([
  'wsl',
  'profile',
  'assets',
  'download',
  'extract',
  'import',
  'update',
  'start',
  'storage',
  'workspace',
  'browser',
  'ready',
  'loading',
  'loaded',
  'database',
  'threads',
  'memory',
  'apps',
  'listening',
]);
const codes = new Set([
  'NOD_WSL_REQUIRED',
  'RUNTIME_ARCHIVE_REQUIRED',
  'NOD_RUNTIME_STOP_FAILED',
  'NOD_CONTAINER_STOPPED',
  'NOD_DATABASE_CONNECTION_FAILED',
  'NOD_DATABASE_OUT_OF_MEMORY',
  'NOD_DATABASE_STOPPED',
  'NOD_DATABASE_NOT_READY',
  'NOD_COMPUTER_PROTECTION_FAILED',
  'NOD_COMPUTER_STORAGE_FULL',
  'NOD_COMPUTER_CONFIGURATION_INVALID',
  'NOD_COMPUTER_CONFIGURATION_MISSING',
  'NOD_COMPUTER_NOT_READY',
  'NOD_COMPUTER_REGISTRATION_MISSING',
  'NOD_KVM_UNAVAILABLE',
]);
const wslCodes = new Set([
  'HCS_E_SERVICE_NOT_AVAILABLE',
  'HCS_E_HYPERV_NOT_INSTALLED',
  'WSL_E_WSL_OPTIONAL_COMPONENT_REQUIRED',
  'ERROR_SERVICE_DISABLED',
  'ERROR_SERVICE_DOES_NOT_EXIST',
  'ERROR_FILE_EXISTS',
  'ERROR_ALREADY_EXISTS',
  'E_ILLEGAL_STATE_CHANGE',
  'E_ACCESSDENIED',
  'ERROR_ACCESS_DENIED',
  'ERROR_DISK_FULL',
  'WSL_E_IMPORT_FAILED',
  '0x80072747',
  '0x800705b4',
]);
const reasons = {
  status_regular: 'The saved report status is not one regular file.',
  status_changed: 'The saved report status changed. Check it again.',
  status_large: 'The saved report status is larger than 1024 bytes.',
  status_json: 'The saved report status has invalid JSON.',
  status_fields: 'The saved report status has invalid fields.',
  status_read: 'The saved report status could not be read.',
  status_check: 'Check the saved report status again before starting a new report.',
  preserve_large: 'The saved report status is too large to preserve automatically.',
  disabled: 'Bug reports are turned off.',
  previous_status: 'Check the previous report status before starting another report.',
  report_large: 'The startup report is too large. Continue without the report.',
  review_required: 'Review the report again before sending it.',
  previous_send: 'Check the previous report status before sending another report.',
  rollback_failed:
    'The report was not sent. The previous saved report status could not be restored.',
  original_required: 'Check the original report before sending its attachment again.',
  partial_required: 'Check the report status before sending its attachment again.',
  bytes_unavailable:
    'The original report bytes are no longer available. Start a new report to review new bytes.',
  helper_initialized: 'The report helper is already open.',
  action_unavailable: 'This report action is unavailable.',
  collector_https: 'Feedback URLs must use HTTPS without credentials, queries or fragments.',
  collector_prefix: 'The feedback receipt prefix must name an issue collection ending in /.',
  collector_config: 'The feedback collector settings are invalid.',
  collector_required: 'Set NOD_FEEDBACK_RECEIPT_URL_PREFIX when using a custom feedback intake.',
};

function data(value, key) {
  try {
    for (let depth = 0; value && typeof value === 'object' && depth < 5; depth++) {
      const descriptor = Object.getOwnPropertyDescriptor(value, key);
      if (descriptor) return 'value' in descriptor ? descriptor.value : undefined;
      value = Object.getPrototypeOf(value);
    }
  } catch {}
}

const choice = (set, value) => (typeof value === 'string' && set.has(value) ? value : undefined);
const integer = (value, min, max) =>
  Number.isSafeInteger(value) && value >= min && value <= max ? value : undefined;

export const startupWslCode = (value) => choice(wslCodes, value);

export function startupErrorFacts(value) {
  const result = { detailsOmitted: true };
  for (const [key, selected] of [
    ['class', choice(classes, data(value, 'class')) ?? choice(classes, data(value, 'name'))],
    ['errno', choice(errnos, data(value, 'errno')) ?? choice(errnos, data(value, 'code'))],
    ['syscall', choice(syscalls, data(value, 'syscall'))],
    [
      'httpStatus',
      integer(data(value, 'httpStatus'), 100, 599) ??
        integer(data(value, 'statusCode'), 100, 599) ??
        integer(data(value, 'status'), 100, 599),
    ],
    ['exitCode', integer(data(value, 'exitCode'), -2147483648, 4294967295)],
    ['signal', choice(signals, data(value, 'signal'))],
    ['code', choice(codes, data(value, 'code'))],
    ['step', choice(steps, data(value, 'step'))],
    ['wslCode', startupWslCode(data(value, 'wslCode'))],
  ])
    if (selected !== undefined) result[key] = selected;
  return result;
}

export function startupStatusFacts(value) {
  const runtime = data(value, 'runtime');
  const failure = data(value, 'failure');
  return {
    phase: choice(phases, data(value, 'phase')) ?? 'unknown',
    stage: choice(stages, data(value, 'stage')) ?? 'unknown',
    runtimePhase:
      choice(phases, data(runtime, 'phase') ?? data(value, 'runtimePhase')) ?? 'unknown',
    errorPresent:
      data(value, 'errorPresent') === true || Boolean(data(value, 'error')) || Boolean(failure),
    detailsOmitted: true,
    ...(failure && { failure: startupErrorFacts(failure) }),
  };
}

export function startupEventFacts(event, details) {
  const error = data(details, 'error');
  const result = {
    event: choice(events, event ?? data(details, 'event')) ?? 'diagnostic_text_omitted',
    textOmitted: true,
    ...(error && { error: startupErrorFacts(error) }),
  };
  for (const [key, selected] of [
    ['phase', choice(phases, data(details, 'phase'))],
    ['stage', choice(stages, data(details, 'stage'))],
    ['step', choice(steps, data(details, 'step'))],
    ['durationMs', integer(data(details, 'durationMs'), 0, 86400000)],
    ['count', integer(data(details, 'count'), 0, 1000000)],
    ['exitCode', integer(data(details, 'exitCode'), -2147483648, 4294967295)],
    ['signal', choice(signals, data(details, 'signal'))],
    ['httpStatus', integer(data(details, 'httpStatus'), 100, 599)],
  ])
    if (selected !== undefined) result[key] = selected;
  return result;
}

export function startupLogFacts(input) {
  const entries = data(input, 'entries');
  const length = integer(data(entries, 'length'), 0, 100);
  if (!Array.isArray(entries) || length === undefined)
    return { status: 'unavailable', entries: [] };
  const safe = [];
  for (let index = 0; index < length; index++) {
    const row = data(entries, String(index));
    const ageMs = integer(data(row, 'ageMs'), 0, 31536000000);
    if (ageMs === undefined) return { status: 'unavailable', entries: [] };
    safe.push({ ageMs, ...startupEventFacts(data(row, 'event'), row) });
  }
  return { status: 'collected', truncated: data(input, 'truncated') === true, entries: safe };
}

export class StartupFeedbackError extends Error {
  constructor(reason, cause) {
    super(
      Object.hasOwn(reasons, reason)
        ? reasons[reason]
        : 'The report action failed. Its details are omitted.',
      { cause },
    );
    Object.assign(this, startupErrorFacts(cause));
    const causes = data(cause, 'errors');
    if (Array.isArray(causes))
      this.errors = [0, 1].map((index) => startupErrorFacts(data(causes, String(index))));
    this.startupReason = Object.hasOwn(reasons, reason) ? reason : undefined;
  }
}

export function startupFailureMessage(error) {
  const reason = data(error, 'startupReason');
  const facts = startupErrorFacts(error);
  let message =
    typeof reason === 'string' && Object.hasOwn(reasons, reason) ? reasons[reason] : undefined;
  const configReasons = {
    FEEDBACK_URL_INVALID: 'collector_https',
    FEEDBACK_RECEIPT_PREFIX_INVALID: 'collector_prefix',
    FEEDBACK_RECEIPT_PREFIX_REQUIRED: 'collector_required',
  };
  const code = data(error, 'code');
  const configReason =
    typeof code === 'string' && Object.hasOwn(configReasons, code)
      ? configReasons[code]
      : undefined;
  if (!message && configReason) message = reasons[configReason];
  if (!message && facts.class === 'ZodError')
    message = 'The report input is invalid. Review the form fields.';
  const errnoReasons = {
    EACCES: 'Permission denied.',
    EPERM: 'The operation is not permitted.',
    EIO: 'An input/output error occurred.',
    ENOENT: 'The required file or program is missing.',
    ENOSPC: 'The storage device has no free space.',
    EROFS: 'The storage device is read-only.',
    ETIMEDOUT: 'The operation timed out.',
    ECONNREFUSED: 'The connection was refused.',
  };
  if (!message && facts.errno && Object.hasOwn(errnoReasons, facts.errno))
    message = errnoReasons[facts.errno];
  message ??= 'The report action failed. Its private details are omitted.';
  const values = [
    facts.errno,
    facts.syscall,
    facts.httpStatus && `HTTP ${facts.httpStatus}`,
    facts.class,
  ];
  const causes = data(error, 'errors');
  if (Array.isArray(causes))
    for (
      let index = 0;
      index < Math.min(integer(data(causes, 'length'), 0, 1000000) ?? 0, 2);
      index++
    ) {
      const cause = startupErrorFacts(data(causes, String(index)));
      if (cause.errno) values.push(cause.errno);
    }
  const technical = [...new Set(values.filter(Boolean))];
  return message + (technical.length ? ` (${technical.join(', ')})` : '');
}

export function startupReceiptFacts(value, submissionId) {
  const status =
    choice(new Set(['submitted', 'partial', 'unknown', 'rejected']), data(value, 'status')) ??
    'unknown';
  const httpStatus = integer(data(value, 'httpStatus'), 100, 599);
  const limited = data(value, 'reason') === 'rate_limited';
  return {
    submissionId,
    status,
    ...(httpStatus !== undefined && { httpStatus }),
    ...(limited && { reason: 'rate_limited', message: 'Please try again in a minute.' }),
    ...((data(value, 'message') !== undefined || data(value, 'messageOmitted') === true) &&
      !limited && { messageOmitted: true }),
  };
}
