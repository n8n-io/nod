import type { Approval } from '../shared/contracts.ts';
import { createInspectorRedactor } from './inspector-redaction.ts';

const labels: Record<string, string> = {
  GMAIL_SEND_EMAIL: 'Send this email',
  GMAIL_CREATE_EMAIL_DRAFT: 'Save this email draft',
  GMAIL_DELETE_MESSAGE: 'Delete this email',
  GMAIL_DELETE_EMAIL: 'Delete this email',
  SLACK_SEND_MESSAGE: 'Send this Slack message',
  SLACK_POST_MESSAGE: 'Send this Slack message',
  SLACK_DELETE_MESSAGE: 'Delete this Slack message',
  GOOGLECALENDAR_DELETE_EVENT: 'Delete this calendar event',
  GOOGLEDRIVE_DELETE_FILE: 'Delete this file',
  NOTION_DELETE_BLOCK: 'Delete this Notion block',
  OTTO_goal_create: 'Add this goal',
  OTTO_goal_update: 'Update this goal',
  OTTO_schedule_create: 'Add this schedule',
  OTTO_schedule_update: 'Update this schedule',
  OTTO_schedule_cancel: 'Pause this schedule',
  OTTO_profile_update: 'Save these preferences',
  OTTO_notification_preferences_update: 'Save these notification preferences',
  OTTO_memory_save: 'Remember this',
  CONNECTED_HTTP: 'Call this connected API',
  CONNECTED_MCP_CALL: 'Use this connected tool',
  CONNECTED_CLI: 'Run this connected command',
};

function plain(value: string) {
  const escape = (text: string) => text.replace(/[\\`*_{}\[\]<>()#!|]/g, '\\$&');
  return value
    .replace(/[\u0000-\u0008\u000b-\u001f\u007f]/g, '')
    .split(/(https?:\/\/[^\s<>"'\\`]+)/gi)
    .map((part, index) => {
      if (index % 2) {
        try {
          const parsed = new URL(part);
          if (!parsed.username && !parsed.password) return `<${part}>`;
        } catch {}
      }
      return escape(part);
    })
    .join('');
}

function text(value: unknown) {
  return typeof value === 'string' && value.trim() ? plain(value.trim()) : undefined;
}

function fieldLabel(key: string) {
  const words = key.replace(/([a-z])([A-Z])/g, '$1 $2').replace(/_/g, ' ');
  return plain(words.charAt(0).toUpperCase() + words.slice(1));
}

function calendarValue(value: unknown): string {
  if (value === null) return 'None';
  if (Array.isArray(value))
    return value.length
      ? value.map((item, index) => `${index + 1}. ${calendarValue(item)}`).join('\n')
      : 'Empty list';
  if (typeof value === 'object' && value) {
    const entries = Object.entries(value);
    return entries.length
      ? entries.map(([key, item]) => `${fieldLabel(key)}: ${calendarValue(item)}`).join('\n')
      : 'No fields';
  }
  return typeof value === 'string' ? plain(value) || 'Empty text' : String(value);
}

function recipients(value: unknown) {
  const values = Array.isArray(value) ? value : [value];
  if (
    !values.length ||
    values.some((entry) => typeof entry !== 'string' || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(entry))
  )
    return undefined;
  return values.map((entry) => plain(entry as string)).join(', ');
}

const redactConnected = createInspectorRedactor([], { string: 2000, payload: 2400 });

function connectedText(value: unknown) {
  const safe = redactConnected(value);
  const serialized = typeof safe === 'string' ? safe : JSON.stringify(safe);
  return plain(serialized.length > 1800 ? `${serialized.slice(0, 1800)} [truncated]` : serialized);
}

function cliArguments(value: unknown) {
  if (!Array.isArray(value)) return connectedText(value);
  const masked = value.map((part, index) => {
    if (typeof part !== 'string') return part;
    const previous = value[index - 1];
    if (
      typeof previous === 'string' &&
      /^(?:--?)(?:api[-_]?key|auth|authorization|password|secret|token)$/i.test(previous)
    )
      return '[redacted]';
    return part.replace(
      /^(--?(?:api[-_]?key|auth|authorization|password|secret|token)=).+$/i,
      '$1[redacted]',
    );
  });
  return connectedText(masked);
}

export function actionConfirmation(
  action: string,
  args: Record<string, unknown>,
  connection?: Approval['connection'],
  targetTitle?: string,
) {
  const fallback = /^[A-Z][A-Z0-9]*(?:_[A-Z]+)+$/.test(action)
    ? action
        .split('_')
        .slice(1)
        .join(' ')
        .toLowerCase()
        .replace(/^./, (letter) => letter.toUpperCase())
    : 'Make this change';
  const label = labels[action] ?? fallback;
  const account = text(connection?.accountEmail) || text(connection?.accountName);
  const service = text(connection?.name);
  const using = service ? ` using ${service}${account ? ` (${account})` : ''}` : '';
  const details: string[] = [];
  const seen = new Set<string>();
  const add = (label: string, value: string | undefined) => {
    if (!value || seen.has(label)) return;
    seen.add(label);
    details.push(`${label}: ${value}`);
  };
  add(action === 'GMAIL_REPLY_TO_THREAD' ? 'Thread subject' : 'For', text(targetTitle));
  if (action.startsWith('GOOGLECALENDAR_')) {
    for (const [key, value] of Object.entries(args)) {
      if (key === 'connectionId') continue;
      const label = fieldLabel(key);
      seen.add(label);
      details.push(`${label}: ${calendarValue(value)}`);
    }
  }
  if (action === 'CONNECTED_HTTP') {
    add('Method', connectedText(args.method));
    add('Path', connectedText(args.path));
    if (args.body !== undefined) add('Request', connectedText(args.body));
  }
  if (action === 'CONNECTED_MCP_CALL') {
    add('Tool', connectedText(args.tool));
    if (args.input !== undefined) add('Input', connectedText(args.input));
  }
  if (action === 'CONNECTED_CLI') {
    add('Program', text(connection?.command));
    add('Arguments', cliArguments(args.argv));
  }
  for (const [key, label] of [
    ['title', 'Title'],
    ['subject', 'Subject'],
    ['recipient_name', 'Recipient'],
    ['channel_name', 'Channel'],
    ['name', 'Name'],
    ['file_name', 'File'],
    ['filename', 'File'],
    ['nextAction', 'Next step'],
    ['description', 'Description'],
    ['preferences', 'Preferences'],
    ['location', 'Location'],
    ['phone', 'Phone'],
    ['notificationRule', 'Notify me'],
    ['quietStart', 'Quiet hours start'],
    ['quietEnd', 'Quiet hours end'],
    ['timeZone', 'Time zone'],
    ['locale', 'Region'],
  ])
    add(label!, text(args[key!]));
  for (const key of ['to', 'recipients', 'recipient_email', 'to_email'])
    add('To', recipients(args[key]));
  for (const key of ['cc', 'bcc']) add(key.toUpperCase(), recipients(args[key]));
  if (typeof args.progress === 'number' && Number.isFinite(args.progress))
    add('Progress', `${args.progress}%`);
  if (['active', 'paused', 'completed'].includes(String(args.status)))
    add('Status', String(args.status));
  const clock = ({ auto: 'Automatic', h12: '12-hour', h23: '24-hour' } as Record<string, string>)[
    String(args.hourCycle)
  ];
  if (clock) add('Clock', clock);
  if (typeof args.enabled === 'boolean') add('Schedule', args.enabled ? 'Active' : 'Paused');
  if (typeof args.targetDate === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(args.targetDate))
    add('Target date', args.targetDate);
  else if (args.targetDate === null) add('Target date', 'None');
  if (typeof args.runAt === 'string' && Number.isFinite(Date.parse(args.runAt))) {
    try {
      add(
        'When',
        new Intl.DateTimeFormat('en-GB', {
          dateStyle: 'long',
          timeStyle: 'short',
          timeZone: typeof args.timeZone === 'string' ? args.timeZone : 'UTC',
        }).format(new Date(args.runAt)),
      );
    } catch {}
  }
  if (typeof args.cron === 'string') {
    const everyMinute = /^\*\/([1-9]\d*) \* \* \* \*$/.exec(args.cron);
    const daily = /^(\d{1,2}) (\d{1,2}) \* \* \*$/.exec(args.cron);
    add(
      'Repeats',
      args.cron === '* * * * *'
        ? 'Every minute'
        : everyMinute
          ? `Every ${everyMinute[1]} minutes`
          : daily
            ? `Daily at ${daily[2]!.padStart(2, '0')}:${daily[1]!.padStart(2, '0')}`
            : `Custom timing (${plain(args.cron)})`,
    );
  }
  for (const key of ['body', 'message_body', 'text', 'content', 'prompt'])
    add(action === 'OTTO_memory_save' ? 'Note' : 'Message', text(args[key]));
  return `${label}${using}?${details.length ? `\n\n${details.join('\n\n')}` : ''}\n\nReply yes to confirm, no to leave it unchanged, or tell me what to change.`;
}
